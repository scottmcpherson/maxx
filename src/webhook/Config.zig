//! Webhook listener configuration: the explicit route-to-launch registry.
//!
//! A webhook config is a JSON document describing where to bind a local
//! listener and a set of routes. Each route maps an exact request path to a
//! connector source (the adapter that parses the payload) and a launch template
//! (the command/title/cwd/env/prompt-delivery for the visible Maxx tab the
//! request should start). This is the *only* place a webhook turns into a
//! command: there is no provider-specific hardcoding and nothing is inferred —
//! a route launches exactly what its operator configured, parsed by exactly the
//! adapter its operator named. See `docs/webhook-ingestion.md`.
//!
//! JSON is used (rather than the TOML sketched in the issue) to match Maxx's
//! existing JSON-based control/connector tooling and to reuse the same parser
//! the adapters use; the route-to-command model is identical either way.
//!
//! Parsing here is environment-free and fully testable: it validates structure,
//! defaults, template placeholder syntax, duplicate paths, and the bind-safety
//! invariant (an unauthenticated route is permitted only on a loopback bind).
//! Resolving the actual secret values from the environment — and failing closed
//! when they are absent — happens in the serve action, not here.

const Config = @This();

const std = @import("std");
const Allocator = std.mem.Allocator;

const auth = @import("auth.zig");
const connector = @import("../connector/connector.zig");
const Template = connector.Template;
const jh = @import("../connector/json_helpers.zig");

/// Default request-body cap (1 MiB) applied when a config sets none.
pub const default_max_body_bytes: usize = 1 * 1024 * 1024;

/// Default bind address: loopback only, so a misconfiguration cannot expose the
/// listener off-host.
pub const default_bind = "127.0.0.1:8787";

/// One configured route: an exact path mapped to a connector source and a
/// launch template, plus its request-validation rules.
pub const Route = struct {
    /// Exact request path that selects this route (e.g. `/hooks/linear-issue`).
    path: []const u8,
    /// Connector adapter name that parses this route's payloads (e.g. `linear`).
    source: []const u8,
    /// Launch command (templated with `${field}`). Required.
    command: []const u8,
    cwd: ?[]const u8 = null,
    title: ?[]const u8 = null,
    env: []const Template.EnvEntry = &.{},
    prompt_delivery: Template.PromptDelivery = .env,
    /// Policy source the launch is attributed to (not templated). Optional.
    caller: ?[]const u8 = null,
    /// Supervisor group label (templated). Optional.
    group: ?[]const u8 = null,
    /// Display name recorded as the trigger; defaults to `path`.
    trigger: []const u8,
    /// Per-route request-body cap.
    max_body_bytes: usize,
    /// Authentication scheme for this route.
    auth: auth.Config,
    /// Name of the env var holding the secret/HMAC key. Required (and resolved at
    /// serve time) for `.token`/`.hmac`; null for `.none`.
    secret_env: ?[]const u8 = null,
    /// Request header carrying a per-DELIVERY id used as the duplicate-suppression
    /// key (e.g. `X-GitHub-Delivery`, `Linear-Delivery`). When set, redeliveries
    /// of the *same* delivery are suppressed; distinct events for the same
    /// issue/PR are not. When null (the default), dedup is disabled for the route:
    /// the adapter's `event.id` is the object id, so keying on it would wrongly
    /// drop a later legitimate event for the same object.
    dedup_header: ?[]const u8 = null,

    /// Build the connector launch template this route resolves to.
    pub fn template(self: Route) Template.LaunchTemplate {
        return .{
            .command = self.command,
            .cwd = self.cwd,
            .title = self.title,
            .env = self.env,
            .prompt_delivery = self.prompt_delivery,
            .caller = self.caller,
            .group = self.group,
        };
    }
};

/// Bind address (`host:port`). Loopback by default.
bind: []const u8 = default_bind,
/// Configured routes. At least one is required.
routes: []const Route = &.{},

/// The largest per-route body cap across all routes. The serve loop reads a
/// request body up to this bound (then the matched route's specific cap is
/// enforced post-auth), so the read limit never depends on the request path —
/// an unauthenticated caller cannot probe route existence via the size check.
pub fn maxBodyCap(self: Config) usize {
    var m: usize = 0;
    for (self.routes) |r| {
        if (r.max_body_bytes > m) m = r.max_body_bytes;
    }
    return if (m == 0) default_max_body_bytes else m;
}

pub const Error = error{InvalidConfig} || Allocator.Error;

/// Populated with a human-readable explanation when `parse` returns
/// `error.InvalidConfig`.
pub const Diagnostic = struct {
    message: []const u8 = "",
};

fn fail(diag: ?*Diagnostic, alloc: Allocator, comptime fmt: []const u8, args: anytype) Error {
    if (diag) |d| d.message = std.fmt.allocPrint(alloc, fmt, args) catch "out of memory";
    return error.InvalidConfig;
}

/// Parse and validate a webhook config from JSON `bytes`. All returned memory is
/// owned by `alloc` (in practice an arena). On `error.InvalidConfig`, `diag` (if
/// given) carries an actionable message.
pub fn parse(alloc: Allocator, bytes: []const u8, diag: ?*Diagnostic) Error!Config {
    const parsed = std.json.parseFromSliceLeaky(std.json.Value, alloc, bytes, .{}) catch
        return fail(diag, alloc, "config is not valid JSON", .{});
    if (parsed != .object) return fail(diag, alloc, "config must be a JSON object", .{});
    const root = parsed.object;

    var cfg: Config = .{};

    cfg.bind = if (jh.getString(root, "bind")) |b| blk: {
        if (b.len == 0) return fail(diag, alloc, "\"bind\" must not be empty", .{});
        break :blk try alloc.dupe(u8, b);
    } else default_bind;

    const global_max = try readMaxBody(alloc, root, default_max_body_bytes, "max_body_bytes", diag);

    const routes_val = root.get("routes") orelse
        return fail(diag, alloc, "config requires a \"routes\" array", .{});
    if (routes_val != .array) return fail(diag, alloc, "\"routes\" must be an array", .{});
    if (routes_val.array.items.len == 0)
        return fail(diag, alloc, "config requires at least one route", .{});

    const bind_loopback = bindIsLoopback(cfg.bind);

    var routes: std.ArrayList(Route) = .empty;
    for (routes_val.array.items, 0..) |rv, idx| {
        if (rv != .object) return fail(diag, alloc, "routes[{d}] must be an object", .{idx});
        const route = try parseRoute(alloc, rv.object, idx, global_max, bind_loopback, diag);

        // Reject duplicate paths so request routing is unambiguous.
        for (routes.items) |existing| {
            if (std.mem.eql(u8, existing.path, route.path))
                return fail(diag, alloc, "duplicate route path \"{s}\"", .{route.path});
        }
        try routes.append(alloc, route);
    }

    cfg.routes = try routes.toOwnedSlice(alloc);
    return cfg;
}

fn parseRoute(
    alloc: Allocator,
    obj: std.json.ObjectMap,
    idx: usize,
    global_max: usize,
    bind_loopback: bool,
    diag: ?*Diagnostic,
) Error!Route {
    const path = jh.getNonEmptyString(obj, "path") orelse
        return fail(diag, alloc, "routes[{d}] requires a non-empty \"path\"", .{idx});
    if (path[0] != '/') return fail(diag, alloc, "route path \"{s}\" must start with '/'", .{path});

    const source = jh.getNonEmptyString(obj, "source") orelse
        return fail(diag, alloc, "route \"{s}\" requires a \"source\"", .{path});
    if (connector.adapterByName(source) == null)
        return fail(diag, alloc, "route \"{s}\" has unknown source \"{s}\"", .{ path, source });

    const command = jh.getNonEmptyString(obj, "command") orelse
        return fail(diag, alloc, "route \"{s}\" requires a \"command\"", .{path});
    // SECURITY: the control host runs the launch by shell-evaluating this string
    // (`<command>; exit`), so a `${...}` placeholder would splice
    // provider-controlled — and often attacker-influenceable — payload fields
    // (an issue/PR title, a body) straight into a shell command. A validly-signed
    // but hostile payload could then run arbitrary local commands. The command is
    // operator-authored and trusted; the payload is data. Forbid placeholders in
    // `command` and deliver the payload to it through templated `env` values
    // (referenced as quoted shell variables, e.g. `claude "$ISSUE"`) or via
    // `$MAXX_WEBHOOK_PAYLOAD_FILE` / the connector prompt — none of which the
    // shell re-tokenizes. `title`/`cwd`/`group`/`env` may still template: none of
    // them are shell-evaluated as a command.
    if (std.mem.indexOf(u8, command, "${") != null)
        return fail(diag, alloc, "route \"{s}\" command must not use ${{...}} placeholders " ++
            "(payload values would be shell-evaluated); pass payload via env values or " ++
            "$MAXX_WEBHOOK_PAYLOAD_FILE", .{path});

    const cwd = try dupOptTemplate(alloc, obj, "cwd", path, diag);
    const title = try dupOptTemplate(alloc, obj, "title", path, diag);
    const group = try dupOptTemplate(alloc, obj, "group", path, diag);
    const caller: ?[]const u8 = if (jh.getNonEmptyString(obj, "caller")) |c| try alloc.dupe(u8, c) else null;

    const prompt_delivery: Template.PromptDelivery = if (jh.getString(obj, "prompt_delivery")) |pd|
        std.meta.stringToEnum(Template.PromptDelivery, pd) orelse
            return fail(diag, alloc, "route \"{s}\" prompt_delivery must be env, stdin, or file", .{path})
    else
        .env;

    const env = try parseEnv(alloc, obj, path, diag);

    const trigger: []const u8 = if (jh.getNonEmptyString(obj, "trigger")) |t|
        try alloc.dupe(u8, t)
    else
        try alloc.dupe(u8, path);

    const max_body_bytes = try readMaxBody(alloc, obj, global_max, "max_body_bytes", diag);

    const dedup_header: ?[]const u8 = if (jh.getNonEmptyString(obj, "dedup_header")) |d|
        try alloc.dupe(u8, d)
    else
        null;

    const route_auth, const secret_env = try parseAuth(alloc, obj, path, bind_loopback, diag);

    return .{
        .path = try alloc.dupe(u8, path),
        .source = try alloc.dupe(u8, source),
        .command = try alloc.dupe(u8, command),
        .cwd = cwd,
        .title = title,
        .env = env,
        .prompt_delivery = prompt_delivery,
        .caller = caller,
        .group = group,
        .trigger = trigger,
        .max_body_bytes = max_body_bytes,
        .auth = route_auth,
        .secret_env = secret_env,
        .dedup_header = dedup_header,
    };
}

fn parseAuth(
    alloc: Allocator,
    obj: std.json.ObjectMap,
    path: []const u8,
    bind_loopback: bool,
    diag: ?*Diagnostic,
) Error!struct { auth.Config, ?[]const u8 } {
    const auth_obj = jh.getObject(obj, "auth") orelse
        return fail(diag, alloc, "route \"{s}\" requires an \"auth\" object", .{path});

    const mode_str = jh.getNonEmptyString(auth_obj, "mode") orelse
        return fail(diag, alloc, "route \"{s}\" auth requires a \"mode\"", .{path});
    const mode = std.meta.stringToEnum(auth.Mode, mode_str) orelse
        return fail(diag, alloc, "route \"{s}\" auth mode must be none, token, or hmac", .{path});

    if (mode == .none) {
        // An unauthenticated route must never be reachable off-host.
        if (!bind_loopback)
            return fail(diag, alloc, "route \"{s}\" uses auth mode \"none\" but the bind is not loopback; " ++
                "an unauthenticated launcher must not be exposed off-host", .{path});
        return .{ .{ .mode = .none }, null };
    }

    const secret_env = jh.getNonEmptyString(auth_obj, "secret_env") orelse
        return fail(diag, alloc, "route \"{s}\" auth mode \"{s}\" requires \"secret_env\"", .{ path, mode_str });
    const header = jh.getNonEmptyString(auth_obj, "header") orelse
        return fail(diag, alloc, "route \"{s}\" auth mode \"{s}\" requires \"header\"", .{ path, mode_str });
    const prefix = jh.getString(auth_obj, "prefix") orelse "";

    return .{
        .{
            .mode = mode,
            .header = try alloc.dupe(u8, header),
            .prefix = try alloc.dupe(u8, prefix),
        },
        try alloc.dupe(u8, secret_env),
    };
}

fn parseEnv(alloc: Allocator, obj: std.json.ObjectMap, path: []const u8, diag: ?*Diagnostic) Error![]const Template.EnvEntry {
    const env_val = obj.get("env") orelse return &.{};
    if (env_val != .array) return fail(diag, alloc, "route \"{s}\" \"env\" must be an array", .{path});

    var list: std.ArrayList(Template.EnvEntry) = .empty;
    for (env_val.array.items, 0..) |ev, i| {
        if (ev != .object) return fail(diag, alloc, "route \"{s}\" env[{d}] must be an object", .{ path, i });
        const key = jh.getNonEmptyString(ev.object, "key") orelse
            return fail(diag, alloc, "route \"{s}\" env[{d}] requires a non-empty \"key\"", .{ path, i });
        const value = jh.getString(ev.object, "value") orelse "";
        try checkTemplate(alloc, value, path, "env value", diag);
        try list.append(alloc, .{
            .key = try alloc.dupe(u8, key),
            .value = try alloc.dupe(u8, value),
        });
    }
    return list.toOwnedSlice(alloc);
}

fn dupOptTemplate(alloc: Allocator, obj: std.json.ObjectMap, name: []const u8, path: []const u8, diag: ?*Diagnostic) Error!?[]const u8 {
    const s = jh.getNonEmptyString(obj, name) orelse return null;
    try checkTemplate(alloc, s, path, name, diag);
    return try alloc.dupe(u8, s);
}

/// Hard ceiling on a configured body cap: large enough for any real webhook
/// payload, small enough to keep the per-request read allocation bounded (and to
/// keep the `@intCast` below in range on every target).
pub const max_allowed_body_bytes: i64 = 256 * 1024 * 1024;

fn readMaxBody(alloc: Allocator, obj: std.json.ObjectMap, default: usize, name: []const u8, diag: ?*Diagnostic) Error!usize {
    const v = obj.get(name) orelse return default;
    switch (v) {
        .integer => |n| {
            if (n <= 0) return fail(diag, alloc, "\"{s}\" must be a positive integer", .{name});
            if (n > max_allowed_body_bytes)
                return fail(diag, alloc, "\"{s}\" must not exceed {d} bytes", .{ name, max_allowed_body_bytes });
            return @intCast(n);
        },
        // A value too large for i64 parses as `.number_string`; reject it too.
        else => return fail(diag, alloc, "\"{s}\" must be a positive integer", .{name}),
    }
}

/// Validate `${...}` placeholder *syntax* in a template string (unterminated or
/// empty placeholders), independent of any event. Field resolution is checked at
/// request time against the actual payload.
fn checkTemplate(alloc: Allocator, s: []const u8, path: []const u8, what: []const u8, diag: ?*Diagnostic) Error!void {
    var i: usize = 0;
    while (i < s.len) : (i += 1) {
        if (s[i] != '$' or i + 1 >= s.len or s[i + 1] != '{') continue;
        const end = std.mem.indexOfScalarPos(u8, s, i + 2, '}') orelse
            return fail(diag, alloc, "route \"{s}\" {s} has an unterminated ${{...}} placeholder", .{ path, what });
        var name = s[i + 2 .. end];
        if (name.len > 0 and name[name.len - 1] == '?') name = name[0 .. name.len - 1];
        if (name.len == 0)
            return fail(diag, alloc, "route \"{s}\" {s} has an empty ${{}} placeholder", .{ path, what });
        i = end;
    }
}

/// Whether `bind`'s host is a loopback address (or `localhost`). Classifies by
/// actually parsing the IP literal — not a substring heuristic — so a hostname
/// like `127.0.0.1.evil.com` is *not* treated as loopback and any IPv6 spelling
/// of `::1` (compressed or expanded) is. The serve action performs the
/// authoritative check on the real bound address via `addressIsLoopback`; this
/// string form is for config-time validation (where no socket is bound yet).
pub fn bindIsLoopback(bind: []const u8) bool {
    const host = hostOf(bind) orelse return false;
    // `parseBind` (serve) maps `localhost` to loopback without a DNS lookup, so
    // mirror that here; every other host must be a loopback IP literal.
    if (std.mem.eql(u8, host, "localhost")) return true;
    const addr = std.net.Address.parseIp(host, 0) catch return false;
    return addressIsLoopback(addr);
}

/// Whether a resolved address is an IPv4 (127.0.0.0/8) or IPv6 (`::1`) loopback.
/// This is the authoritative classifier; the serve action runs it on the exact
/// address it is about to bind, after any `--bind` override.
pub fn addressIsLoopback(addr: std.net.Address) bool {
    return switch (addr.any.family) {
        std.posix.AF.INET => @as([4]u8, @bitCast(addr.in.sa.addr))[0] == 127,
        std.posix.AF.INET6 => blk: {
            const b = addr.in6.sa.addr;
            for (b[0..15]) |x| {
                if (x != 0) break :blk false;
            }
            break :blk b[15] == 1;
        },
        else => false,
    };
}

/// The path of the first route that is unauthenticated (`auth.mode == .none`) on
/// a non-loopback bind, or null when the config is safe. An unauthenticated
/// command launcher must never be reachable off-host. Callers re-run this after
/// any `--bind` override so the override cannot smuggle the listener off-host.
pub fn offHostUnauthenticatedRoute(self: Config) ?[]const u8 {
    if (bindIsLoopback(self.bind)) return null;
    for (self.routes) |r| {
        if (r.auth.mode == .none) return r.path;
    }
    return null;
}

/// Extract the host portion of a `host:port` / `[ipv6]:port` bind string.
fn hostOf(bind: []const u8) ?[]const u8 {
    if (bind.len == 0) return null;
    if (bind[0] == '[') {
        const end = std.mem.indexOfScalar(u8, bind, ']') orelse return null;
        return bind[1..end];
    }
    const colon = std.mem.lastIndexOfScalar(u8, bind, ':') orelse return null;
    return bind[0..colon];
}

// ----- tests -----

const testing = std.testing;

fn parseOk(alloc: Allocator, bytes: []const u8) !Config {
    var diag: Diagnostic = .{};
    return parse(alloc, bytes, &diag) catch |err| {
        std.debug.print("unexpected parse failure: {s}\n", .{diag.message});
        return err;
    };
}

test "parses a minimal valid config with defaults" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const cfg = try parseOk(alloc,
        \\{
        \\  "routes": [
        \\    {
        \\      "path": "/hooks/linear",
        \\      "source": "linear",
        \\      "command": "claude",
        \\      "auth": { "mode": "hmac", "secret_env": "S", "header": "X-Sig", "prefix": "sha256=" }
        \\    }
        \\  ]
        \\}
    );

    try testing.expectEqualStrings(default_bind, cfg.bind);
    try testing.expectEqual(@as(usize, 1), cfg.routes.len);
    const r = cfg.routes[0];
    try testing.expectEqualStrings("/hooks/linear", r.path);
    try testing.expectEqualStrings("linear", r.source);
    try testing.expectEqualStrings("/hooks/linear", r.trigger); // defaults to path
    try testing.expectEqual(default_max_body_bytes, r.max_body_bytes);
    try testing.expectEqual(Template.PromptDelivery.env, r.prompt_delivery);
    try testing.expectEqual(auth.Mode.hmac, r.auth.mode);
    try testing.expectEqualStrings("X-Sig", r.auth.header.?);
    try testing.expectEqualStrings("sha256=", r.auth.prefix);
    try testing.expectEqualStrings("S", r.secret_env.?);
}

test "parses all optional route fields" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const cfg = try parseOk(alloc,
        \\{
        \\  "bind": "127.0.0.1:9000",
        \\  "max_body_bytes": 2048,
        \\  "routes": [
        \\    {
        \\      "path": "/hooks/gh",
        \\      "source": "github",
        \\      "command": "codex",
        \\      "cwd": "/repo",
        \\      "title": "${title}",
        \\      "group": "${repo.full_name}",
        \\      "caller": "trusted-automation",
        \\      "prompt_delivery": "file",
        \\      "trigger": "gh-issues",
        \\      "max_body_bytes": 4096,
        \\      "dedup_header": "X-GitHub-Delivery",
        \\      "env": [{ "key": "K", "value": "${source}" }],
        \\      "auth": { "mode": "token", "secret_env": "T", "header": "Authorization", "prefix": "Bearer " }
        \\    }
        \\  ]
        \\}
    );
    const r = cfg.routes[0];
    try testing.expectEqualStrings("127.0.0.1:9000", cfg.bind);
    try testing.expectEqualStrings("/repo", r.cwd.?);
    try testing.expectEqualStrings("${title}", r.title.?);
    try testing.expectEqualStrings("${repo.full_name}", r.group.?);
    try testing.expectEqualStrings("trusted-automation", r.caller.?);
    try testing.expectEqual(Template.PromptDelivery.file, r.prompt_delivery);
    try testing.expectEqualStrings("gh-issues", r.trigger);
    try testing.expectEqual(@as(usize, 4096), r.max_body_bytes);
    try testing.expectEqual(@as(usize, 1), r.env.len);
    try testing.expectEqualStrings("K", r.env[0].key);
    try testing.expectEqual(auth.Mode.token, r.auth.mode);
    try testing.expectEqualStrings("X-GitHub-Delivery", r.dedup_header.?);
}

fn expectFail(bytes: []const u8, needle: []const u8) !void {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    var diag: Diagnostic = .{};
    try testing.expectError(error.InvalidConfig, parse(alloc, bytes, &diag));
    if (std.mem.indexOf(u8, diag.message, needle) == null) {
        std.debug.print("expected message to contain '{s}', got '{s}'\n", .{ needle, diag.message });
        return error.WrongMessage;
    }
}

test "rejects structurally invalid configs" {
    try expectFail("not json", "valid JSON");
    try expectFail("[]", "must be a JSON object");
    try expectFail("{}", "requires a \"routes\" array");
    try expectFail("{\"routes\":{}}", "must be an array");
    try expectFail("{\"routes\":[]}", "at least one route");
}

test "rejects invalid routes" {
    // Missing path.
    try expectFail(
        \\{"routes":[{"source":"linear","command":"c","auth":{"mode":"none"}}]}
    , "requires a non-empty \"path\"");
    // Path not starting with slash.
    try expectFail(
        \\{"routes":[{"path":"hooks","source":"linear","command":"c","auth":{"mode":"none"}}]}
    , "must start with '/'");
    // Unknown source.
    try expectFail(
        \\{"routes":[{"path":"/h","source":"gitlab","command":"c","auth":{"mode":"none"}}]}
    , "unknown source");
    // Missing command.
    try expectFail(
        \\{"routes":[{"path":"/h","source":"linear","auth":{"mode":"none"}}]}
    , "requires a \"command\"");
    // Bad prompt_delivery.
    try expectFail(
        \\{"routes":[{"path":"/h","source":"linear","command":"c","prompt_delivery":"smoke","auth":{"mode":"none"}}]}
    , "prompt_delivery must be");
}

test "rejects malformed template placeholders (in a templated field)" {
    // Placeholder *syntax* is validated for the templated fields (here, title).
    try expectFail(
        \\{"routes":[{"path":"/h","source":"linear","command":"c","title":"claude ${title","auth":{"mode":"none"}}]}
    , "unterminated");
    try expectFail(
        \\{"routes":[{"path":"/h","source":"linear","command":"c","title":"claude ${}","auth":{"mode":"none"}}]}
    , "empty ${}");
}

test "rejects ${...} placeholders in the command (shell-injection guard)" {
    try expectFail(
        \\{"routes":[{"path":"/h","source":"linear","command":"claude ${title}","auth":{"mode":"none"}}]}
    , "must not use ${...} placeholders");
    // A shell variable reference (no braces) is fine — it is not a Maxx placeholder.
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const cfg = try parseOk(arena.allocator(),
        \\{"routes":[{"path":"/h","source":"linear","command":"codex resume --prompt-file $MAXX_WEBHOOK_PAYLOAD_FILE","auth":{"mode":"none"}}]}
    );
    try testing.expectEqualStrings("codex resume --prompt-file $MAXX_WEBHOOK_PAYLOAD_FILE", cfg.routes[0].command);
}

test "rejects duplicate paths" {
    try expectFail(
        \\{"routes":[
        \\  {"path":"/h","source":"linear","command":"c","auth":{"mode":"none"}},
        \\  {"path":"/h","source":"github","command":"d","auth":{"mode":"none"}}
        \\]}
    , "duplicate route path");
}

test "rejects auth misconfiguration" {
    // Missing auth object.
    try expectFail(
        \\{"routes":[{"path":"/h","source":"linear","command":"c"}]}
    , "requires an \"auth\" object");
    // Bad mode.
    try expectFail(
        \\{"routes":[{"path":"/h","source":"linear","command":"c","auth":{"mode":"basic"}}]}
    , "must be none, token, or hmac");
    // hmac/token without secret_env.
    try expectFail(
        \\{"routes":[{"path":"/h","source":"linear","command":"c","auth":{"mode":"hmac","header":"X"}}]}
    , "requires \"secret_env\"");
    // hmac/token without header.
    try expectFail(
        \\{"routes":[{"path":"/h","source":"linear","command":"c","auth":{"mode":"token","secret_env":"S"}}]}
    , "requires \"header\"");
}

test "auth none requires a loopback bind" {
    // Loopback default is fine.
    {
        var arena = std.heap.ArenaAllocator.init(testing.allocator);
        defer arena.deinit();
        const cfg = try parseOk(arena.allocator(),
            \\{"routes":[{"path":"/h","source":"linear","command":"c","auth":{"mode":"none"}}]}
        );
        try testing.expectEqual(auth.Mode.none, cfg.routes[0].auth.mode);
    }
    // Off-host bind with an unauthenticated route is rejected.
    try expectFail(
        \\{"bind":"0.0.0.0:8080","routes":[{"path":"/h","source":"linear","command":"c","auth":{"mode":"none"}}]}
    , "must not be exposed off-host");
}

test "bindIsLoopback classifies hosts by parsing the IP literal" {
    try testing.expect(bindIsLoopback("127.0.0.1:8787"));
    try testing.expect(bindIsLoopback("127.5.5.5:1"));
    try testing.expect(bindIsLoopback("localhost:8787"));
    try testing.expect(bindIsLoopback("[::1]:8787"));
    // Any IPv6 spelling of ::1 (here fully expanded) is loopback.
    try testing.expect(bindIsLoopback("[0:0:0:0:0:0:0:1]:8787"));
    try testing.expect(!bindIsLoopback("0.0.0.0:8787"));
    try testing.expect(!bindIsLoopback("[::]:8787"));
    try testing.expect(!bindIsLoopback("192.168.1.10:8787"));
    try testing.expect(!bindIsLoopback("[2001:db8::1]:80"));
    // A hostname that merely starts with "127." must NOT count as loopback.
    try testing.expect(!bindIsLoopback("127.0.0.1.evil.com:8080"));
    try testing.expect(!bindIsLoopback("example.com:80"));
}

test "offHostUnauthenticatedRoute flags an auth:none route on a non-loopback bind" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    // Same config is safe on loopback, unsafe once the bind moves off-host — this
    // models the `--bind` override re-check the serve action performs.
    const cfg = try parseOk(alloc,
        \\{"routes":[{"path":"/h","source":"linear","command":"c","auth":{"mode":"none"}}]}
    );
    try testing.expect(cfg.offHostUnauthenticatedRoute() == null);

    var moved = cfg;
    moved.bind = "0.0.0.0:8787";
    try testing.expectEqualStrings("/h", moved.offHostUnauthenticatedRoute().?);
}

test "rejects an absurdly large max_body_bytes" {
    try expectFail(
        \\{"max_body_bytes":999999999999,"routes":[{"path":"/h","source":"linear","command":"c","auth":{"mode":"none"}}]}
    , "must not exceed");
}
