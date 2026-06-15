const std = @import("std");
const Allocator = std.mem.Allocator;
const ArenaAllocator = std.heap.ArenaAllocator;
const Action = @import("../cli.zig").ghostty.Action;
const args = @import("args.zig");
const control_client = @import("control_client.zig");
const runner = @import("../runner/runner.zig");
const webhook = @import("../webhook/webhook.zig");

const Config = webhook.Config;
const DedupStore = runner.DedupStore;

const log = std.log.scoped(.webhook);

pub const Options = struct {
    pub fn deinit(self: Options) void {
        _ = self;
    }

    /// Enables "-h" and "--help" to work.
    pub fn help(self: Options) !void {
        _ = self;
        return Action.help_error;
    }
};

const Verb = enum {
    serve,
    validate,
};

const ParseError = error{
    MissingVerb,
    UnknownVerb,
    MissingValue,
    UnknownFlag,
    HelpRequested,
} || Allocator.Error;

fn isHelpFlag(arg: []const u8) bool {
    return std.mem.eql(u8, arg, "--help") or std.mem.eql(u8, arg, "-h");
}

const Command = struct {
    verb: Verb,
    config: ?[]const u8 = null,
    bind: ?[]const u8 = null,
    state_file: ?[]const u8 = null,
    no_dedup: bool = false,
    once: bool = false,
};

/// The largest config file we will read. A route registry is small JSON.
const max_config_bytes = 1 * 1024 * 1024;

/// Buffers for the per-connection HTTP read/write and body reader.
const head_buf_size = 32 * 1024;
const send_buf_size = 8 * 1024;
const body_buf_size = 16 * 1024;

/// The `+webhook` action ingests external webhooks and launches preconfigured
/// visible Maxx tabs through the Control API — a safe, local HTTP front door for
/// the same connector→runner pipeline `+runner` exposes for polling and scripts.
///
/// Maxx stays the runtime/control plane, never the workflow brain: a request is
/// accepted only on an explicitly configured route, validated at the transport
/// level (method, `application/json`, a size cap, and a per-route HMAC-SHA256 or
/// shared-token signature over the raw body), parsed by the route's configured
/// connector adapter, and mapped to exactly the configured launch command. Maxx
/// never interprets what a Linear/GitHub/CI event *means*; the route mapping and
/// the launched command own that. The payload is handed to the command verbatim
/// (a temp file via `MAXX_WEBHOOK_PAYLOAD_FILE`, plus the connector's own prompt
/// delivery) — never scraped or guessed from.
///
/// The listener binds loopback-only by default; put a tunnel (ngrok, Cloudflare
/// Tunnel, Tailscale Funnel) or a relay in front of it to receive provider
/// webhooks without changing the route-to-command model. An unauthenticated
/// (`auth.mode = "none"`) route is refused on any non-loopback bind so a local
/// command launcher is never exposed off-host.
///
/// Subcommands:
///
///   * `serve`: run the listener. Flags: `--config <file>` (required; the JSON
///     route registry), `--bind <host:port>` (override the config bind),
///     `--state-file <path>` (duplicate-suppression store; defaults to
///     `<control-dir>/webhook-seen.json`), `--no-dedup`, and `--once` (handle a
///     single request then exit — useful for testing).
///
///   * `validate`: load `--config <file>`, report the parsed routes as JSON
///     (paths, sources, commands, auth modes — never secrets), and exit. Does not
///     bind a socket or read any secret value.
///
/// The control API the launches target is served by the running Maxx app; set
/// `MAXX_CONTROL_DIR` to match a dev build. Secrets are read from the environment
/// named by each route's `auth.secret_env`; `serve` fails closed at startup if a
/// required secret is unset.
///
/// Available since: 1.2.0
pub fn run(alloc: Allocator) !u8 {
    var arena = ArenaAllocator.init(alloc);
    defer arena.deinit();
    const arena_alloc = arena.allocator();

    var iter = try args.argsIterator(alloc);
    defer iter.deinit();

    var buffer: [1024]u8 = undefined;
    var stderr_writer = std.fs.File.stderr().writer(&buffer);
    const stderr = &stderr_writer.interface;
    defer stderr.flush() catch {};

    const cmd = parseCommand(arena_alloc, &iter) catch |err| switch (err) {
        error.MissingVerb, error.HelpRequested => return Action.help_error,
        error.UnknownVerb => {
            try stderr.print("error: unknown subcommand. Try: serve, validate\n", .{});
            return 1;
        },
        error.MissingValue => {
            try stderr.print("error: a flag is missing its value\n", .{});
            return 1;
        },
        error.UnknownFlag => {
            try stderr.print("error: unknown flag\n", .{});
            return 1;
        },
        else => return err,
    };

    return switch (cmd.verb) {
        .serve => try runServe(arena_alloc, cmd, stderr),
        .validate => try runValidate(arena_alloc, cmd, stderr),
    };
}

/// Load and parse the config named by `--config`.
fn loadConfig(alloc: Allocator, cmd: Command, stderr: *std.io.Writer) !?Config {
    const path = cmd.config orelse {
        try stderr.print("error: requires --config <file>\n", .{});
        return null;
    };
    const bytes = std.fs.cwd().readFileAlloc(alloc, path, max_config_bytes) catch |err| {
        try stderr.print("error: could not read config '{s}': {s}\n", .{ path, @errorName(err) });
        return null;
    };
    var diag: Config.Diagnostic = .{};
    var cfg = Config.parse(alloc, bytes, &diag) catch {
        try stderr.print("error: invalid webhook config: {s}\n", .{diag.message});
        return null;
    };
    if (cmd.bind) |b| cfg.bind = b;
    return cfg;
}

fn runValidate(alloc: Allocator, cmd: Command, stderr: *std.io.Writer) !u8 {
    const cfg = (try loadConfig(alloc, cmd, stderr)) orelse return 1;

    var out: std.io.Writer.Allocating = .init(alloc);
    var json: std.json.Stringify = .{ .writer = &out.writer, .options = .{ .whitespace = .indent_2 } };
    try json.beginObject();
    try json.objectField("bind");
    try json.write(cfg.bind);
    try json.objectField("routes");
    try json.beginArray();
    for (cfg.routes) |r| {
        try json.beginObject();
        try json.objectField("path");
        try json.write(r.path);
        try json.objectField("source");
        try json.write(r.source);
        try json.objectField("command");
        try json.write(r.command);
        try json.objectField("auth");
        try json.write(@tagName(r.auth.mode));
        try json.endObject();
    }
    try json.endArray();
    try json.endObject();

    var out_buf: [4096]u8 = undefined;
    var stdout_writer = std.fs.File.stdout().writer(&out_buf);
    const stdout = &stdout_writer.interface;
    try stdout.writeAll(out.written());
    try stdout.writeAll("\n");
    try stdout.flush();
    return 0;
}

/// A resolved secret table built once at startup from the environment.
const Secrets = struct {
    const Entry = struct { name: []const u8, value: []const u8 };
    entries: []const Entry,

    fn resolve(ctx: *anyopaque, name: []const u8) ?[]const u8 {
        const self: *Secrets = @ptrCast(@alignCast(ctx));
        for (self.entries) |e| {
            if (std.mem.eql(u8, e.name, name)) return e.value;
        }
        return null;
    }
};

/// Read every secret referenced by an authenticated route from the environment.
/// Fails closed: a missing or empty required secret aborts startup, so the
/// listener never runs with a route it cannot actually authenticate.
fn resolveSecrets(alloc: Allocator, cfg: Config, stderr: *std.io.Writer) !?Secrets {
    var list: std.ArrayList(Secrets.Entry) = .empty;
    for (cfg.routes) |r| {
        const name = r.secret_env orelse continue; // .none routes have no secret
        // Skip names already resolved (multiple routes may share one secret).
        var already = false;
        for (list.items) |e| {
            if (std.mem.eql(u8, e.name, name)) already = true;
        }
        if (already) continue;

        const value = std.process.getEnvVarOwned(alloc, name) catch |err| switch (err) {
            error.EnvironmentVariableNotFound => {
                try stderr.print(
                    "error: route \"{s}\" needs secret env var ${s}, which is not set\n",
                    .{ r.path, name },
                );
                return null;
            },
            else => return err,
        };
        if (value.len == 0) {
            try stderr.print(
                "error: route \"{s}\" secret env var ${s} is empty\n",
                .{ r.path, name },
            );
            return null;
        }
        try list.append(alloc, .{ .name = name, .value = value });
    }
    return .{ .entries = try list.toOwnedSlice(alloc) };
}

fn runServe(alloc: Allocator, cmd: Command, stderr: *std.io.Writer) !u8 {
    const cfg = (try loadConfig(alloc, cmd, stderr)) orelse return 1;

    var secrets = (try resolveSecrets(alloc, cfg, stderr)) orelse return 1;

    const dir = control_client.controlDir(alloc) catch |err| {
        try stderr.print("error: could not resolve control directory: {}\n", .{err});
        return 1;
    };

    const state_path = cmd.state_file orelse try std.fmt.allocPrint(alloc, "{s}/webhook-seen.json", .{dir});
    var store: ?DedupStore = if (cmd.no_dedup) null else DedupStore.open(alloc, state_path) catch |err| switch (err) {
        error.OutOfMemory => return err,
        error.Unreadable => {
            try stderr.print(
                "error: could not read dedup state file at {s}\n" ++
                    "Fix its permissions, point --state-file elsewhere, or pass --no-dedup.\n",
                .{state_path},
            );
            return 1;
        },
    };
    defer if (store) |*s| s.deinit();

    const address = parseBind(cfg.bind) catch {
        try stderr.print("error: could not parse bind address '{s}' (expected host:port)\n", .{cfg.bind});
        return 1;
    };

    // Re-enforce the bind-safety invariant against the ACTUAL address about to be
    // bound. Config.parse already checked the config-file bind, but a `--bind`
    // override could move an `auth.mode = "none"` route off-host; gate on the real
    // resolved address so the override cannot expose an unauthenticated launcher.
    if (!Config.addressIsLoopback(address)) {
        for (cfg.routes) |r| {
            if (r.auth.mode == .none) {
                try stderr.print(
                    "error: route \"{s}\" uses auth mode \"none\" but the bind {s} is not loopback; " ++
                        "an unauthenticated launcher must not be exposed off-host\n",
                    .{ r.path, cfg.bind },
                );
                return 1;
            }
        }
    }

    var server = address.listen(.{ .reuse_address = true }) catch |err| {
        try stderr.print("error: could not bind {s}: {s}\n", .{ cfg.bind, @errorName(err) });
        return 1;
    };
    defer server.deinit();

    // Report the actual bound address (so a `:0` ephemeral port is discoverable
    // and a tunnel can be pointed at it). This is the only stdout the serve loop
    // emits; per-request activity goes to the scoped log.
    {
        var out_buf: [256]u8 = undefined;
        var stdout_writer = std.fs.File.stdout().writer(&out_buf);
        const stdout = &stdout_writer.interface;
        try stdout.print("maxx webhook listening on http://{f} ({d} route(s))\n", .{ server.listen_address, cfg.routes.len });
        try stdout.flush();
    }
    log.info("webhook listener bound to {f} with {d} route(s)", .{ server.listen_address, cfg.routes.len });

    while (true) {
        const conn = server.accept() catch |err| {
            // A persistent accept() failure (e.g. EMFILE under fd pressure) would
            // otherwise busy-spin the loop; back off briefly so it cannot pin a
            // core or flood the log.
            log.warn("accept failed: {s}", .{@errorName(err)});
            std.Thread.sleep(10 * std.time.ns_per_ms);
            continue;
        };

        var req_arena = ArenaAllocator.init(alloc);
        defer req_arena.deinit();

        // handleConnection owns the connection (it closes it on its own defer).
        const result = handleConnection(req_arena.allocator(), conn, cfg, dir, &secrets, if (store) |*s| s else null) catch |err| {
            log.warn("connection handling failed: {s}", .{@errorName(err)});
            if (cmd.once) return 0;
            continue;
        };

        // Dedup persistence happens inside the handler (before it acknowledges a
        // launch) via the injected persister, so a 200 is never returned with a
        // non-durable key. Here we only do best-effort temp-file housekeeping.
        if (result) |res| {
            // Sweep stale temp files whenever a launch was attempted (launched or
            // failed) — a failed `.file`-delivery launch can leave a connector
            // prompt file behind, and this is the only place a long-lived listener
            // garbage-collects them.
            if (res.record != null) {
                const now_s = std.time.timestamp();
                webhook.sweepStalePayloadFiles(dir, runner.default_prompt_file_ttl_s, now_s);
                runner.sweepStalePromptFiles(dir, runner.default_prompt_file_ttl_s, now_s);
            }
        }

        if (cmd.once) return 0;
    }
}

/// Prunes (by age) and durably saves the dedup store. Wired into the handler as
/// `Deps.persist` so the save runs before a launch is acknowledged. A newer
/// on-disk schema (`error.ReadOnly`) is intentional fail-open, not a failure;
/// any other error propagates so the handler can surface it on the response.
const DedupPersister = struct {
    store: *DedupStore,

    fn persist(ctx: *anyopaque) anyerror!void {
        const self: *DedupPersister = @ptrCast(@alignCast(ctx));
        const cutoff_s = std.time.timestamp() - DedupStore.default_max_age_s;
        if (cutoff_s > 0) {
            var buf: [32]u8 = undefined;
            self.store.pruneOlderThan(runner.epochToIso(&buf, @intCast(cutoff_s)));
        }
        self.store.save() catch |err| switch (err) {
            error.ReadOnly => {},
            else => return err,
        };
    }
};

/// How long a single client may stall a read or write before the (single-thread)
/// serve loop gives up on it and closes the connection. Bounds a Slowloris-style
/// stall from wedging the listener.
const connection_timeout_s = 15;

/// Apply receive/send timeouts to an accepted connection. Best-effort: a failure
/// just leaves the socket blocking, which is no worse than before.
fn setSocketTimeouts(fd: std.posix.socket_t) void {
    const tv = std.posix.timeval{ .sec = connection_timeout_s, .usec = 0 };
    const bytes = std.mem.asBytes(&tv);
    std.posix.setsockopt(fd, std.posix.SOL.SOCKET, std.posix.SO.RCVTIMEO, bytes) catch {};
    std.posix.setsockopt(fd, std.posix.SOL.SOCKET, std.posix.SO.SNDTIMEO, bytes) catch {};
}

/// Handle one connection: receive the request head, read the body (bounded by
/// the matched route's cap), dispatch through the webhook handler, and write the
/// response. Returns the handler `Result` when a request reached the dispatch
/// pipeline (so the caller can persist dedup state and sweep temp files), or null
/// for transport-level rejections that never dispatched. The connection is closed
/// before returning (one request per connection).
fn handleConnection(
    alloc: Allocator,
    conn: std.net.Server.Connection,
    cfg: Config,
    dir: []const u8,
    secrets: *Secrets,
    store: ?*DedupStore,
) !?webhook.Result {
    defer conn.stream.close();

    // Bound how long a single slow client can occupy the single-threaded loop.
    setSocketTimeouts(conn.stream.handle);

    var head_buf: [head_buf_size]u8 = undefined;
    var send_buf: [send_buf_size]u8 = undefined;
    var net_reader = conn.stream.reader(&head_buf);
    var net_writer = conn.stream.writer(&send_buf);
    var http = std.http.Server.init(net_reader.interface(), &net_writer.interface);

    var request = http.receiveHead() catch |err| {
        // A malformed or closed request: nothing safe to reply to.
        if (err != error.HttpConnectionClosing) log.warn("receiveHead: {s}", .{@errorName(err)});
        return null;
    };

    // Copy everything we need out of the head buffer before the body reader
    // invalidates those string pointers.
    const method = @tagName(request.head.method);
    const target = try alloc.dupe(u8, request.head.target);
    const path = pathOf(target);
    const content_type: ?[]const u8 = if (request.head.content_type) |ct| try alloc.dupe(u8, ct) else null;
    const content_length = request.head.content_length;

    // Collect headers (duped) for the handler's auth lookup *before* reading the
    // body: `iterateHeaders` asserts the reader is still in `received_head`, and
    // initializing the body reader both advances that state and invalidates the
    // head string pointers.
    var headers: std.ArrayList(webhook.Header) = .empty;
    var it = request.iterateHeaders();
    while (it.next()) |h| {
        try headers.append(alloc, .{
            .name = try alloc.dupe(u8, h.name),
            .value = try alloc.dupe(u8, h.value),
        });
    }

    // Bound the body read by the GLOBAL cap (largest route cap), never the
    // matched route's cap — the read limit must not depend on the path, or an
    // unauthenticated caller could probe route existence via the size check. The
    // handler enforces the matched route's specific cap post-auth, and routes
    // unknown paths to a uniform 401.
    const cap = cfg.maxBodyCap();
    if (content_length) |clen| {
        if (clen > cap) {
            try respond(&request, 413, "{\"ok\":false,\"error\":\"payload_too_large\"}");
            log.info("webhook {s} {s} -> 413 payload_too_large", .{ method, path });
            return null;
        }
    }

    var body_buf: [body_buf_size]u8 = undefined;
    const body_reader = request.readerExpectContinue(&body_buf) catch |err| {
        log.warn("webhook {s} {s}: body reader: {s}", .{ method, path, @errorName(err) });
        return null;
    };
    const body = body_reader.allocRemaining(alloc, .limited(cap + 1)) catch |err| switch (err) {
        error.StreamTooLong => {
            try respond(&request, 413, "{\"ok\":false,\"error\":\"payload_too_large\"}");
            log.info("webhook {s} {s} -> 413 payload_too_large", .{ method, path });
            return null;
        },
        error.OutOfMemory => return error.OutOfMemory,
        else => {
            log.warn("webhook {s} {s}: body read: {s}", .{ method, path, @errorName(err) });
            return null;
        },
    };

    // Read a fresh capability token per request: the running app rotates it on
    // restart, so a long-lived listener must not cache it.
    const token = readToken(alloc, dir);

    var sender = SocketSender{ .socket_path = try control_client.socketPath(alloc, dir) };
    const received_at = try runner.nowIso(alloc);

    // The handler persists the dedup store (before acknowledging a launch) through
    // this persister, when a store is present.
    var persister: ?DedupPersister = if (store) |s| .{ .store = s } else null;

    const res = try webhook.handle(alloc, cfg, .{
        .method = method,
        .path = path,
        .content_type = content_type,
        .headers = headers.items,
        .body = body,
    }, .{
        .sender = sender.sender(),
        .dedup = store,
        .token = token,
        .received_at = received_at,
        .prompt_dir = dir,
        .secret = Secrets.resolve,
        .secret_ctx = secrets,
        .persist = if (persister != null) DedupPersister.persist else null,
        .persist_ctx = if (persister) |*p| p else undefined,
    });

    try respond(&request, res.response.status, res.response.body);
    logResult(method, path, res);
    return res;
}

/// Emit a redacted activity line. Never logs the body, secret, or signature.
fn logResult(method: []const u8, path: []const u8, res: webhook.Result) void {
    if (res.record) |rec| {
        log.info("webhook {s} {s} -> {d} outcome={s} source={s} event_id={s} session={s} err={s}", .{
            method,                    path,
            res.response.status,       @tagName(rec.outcome),
            rec.source,                rec.event_id,
            rec.session_id orelse "-", rec.error_code orelse "-",
        });
    } else {
        log.info("webhook {s} {s} -> {d}", .{ method, path, res.response.status });
    }
}

fn respond(request: *std.http.Server.Request, status: u16, body: []const u8) !void {
    request.respond(body, .{
        .status = @enumFromInt(status),
        .keep_alive = false,
        .extra_headers = &.{.{ .name = "content-type", .value = "application/json" }},
    }) catch |err| {
        log.warn("respond failed: {s}", .{@errorName(err)});
    };
}

/// The path portion of a request target (query string stripped).
fn pathOf(target: []const u8) []const u8 {
    const q = std.mem.indexOfScalar(u8, target, '?') orelse return target;
    return target[0..q];
}

/// Best-effort read of the capability token; empty string when unreadable (the
/// launch then fails with a clear server error rather than crashing the loop).
fn readToken(alloc: Allocator, dir: []const u8) []const u8 {
    const token_path = control_client.tokenPath(alloc, dir) catch return "";
    return control_client.readToken(alloc, token_path) catch "";
}

/// Parse a `host:port` / `[ipv6]:port` bind string into an address. `localhost`
/// resolves to loopback without a DNS lookup.
fn parseBind(bind: []const u8) !std.net.Address {
    var host: []const u8 = undefined;
    var port_str: []const u8 = undefined;
    if (bind.len > 0 and bind[0] == '[') {
        const end = std.mem.indexOfScalar(u8, bind, ']') orelse return error.InvalidBind;
        host = bind[1..end];
        if (end + 1 >= bind.len or bind[end + 1] != ':') return error.InvalidBind;
        port_str = bind[end + 2 ..];
    } else {
        const colon = std.mem.lastIndexOfScalar(u8, bind, ':') orelse return error.InvalidBind;
        host = bind[0..colon];
        port_str = bind[colon + 1 ..];
    }
    const port = std.fmt.parseInt(u16, port_str, 10) catch return error.InvalidBind;
    if (std.mem.eql(u8, host, "localhost")) host = "127.0.0.1";
    return std.net.Address.parseIp(host, port);
}

/// A `runner.Sender` backed by the real control Unix socket (mirrors the
/// `+runner` action's sender).
const SocketSender = struct {
    socket_path: []const u8,

    fn sendImpl(ctx: *anyopaque, alloc: Allocator, request: []const u8) anyerror![]const u8 {
        const self: *SocketSender = @ptrCast(@alignCast(ctx));
        return control_client.sendRequest(alloc, self.socket_path, request, true);
    }

    fn sender(self: *SocketSender) runner.Sender {
        return .{ .ctx = self, .sendFn = sendImpl };
    }
};

fn parseCommand(alloc: Allocator, iter: anytype) ParseError!Command {
    var first = iter.next() orelse return error.MissingVerb;

    if (std.mem.eql(u8, first, "+webhook") or std.mem.eql(u8, first, "webhook")) {
        first = iter.next() orelse return error.MissingVerb;
    }

    if (isHelpFlag(first)) return error.HelpRequested;
    const verb = std.meta.stringToEnum(Verb, first) orelse return error.UnknownVerb;

    var cmd: Command = .{ .verb = verb };
    while (iter.next()) |raw_arg| {
        const arg: []const u8 = raw_arg;
        if (isHelpFlag(arg)) {
            return error.HelpRequested;
        } else if (try flagValue(alloc, arg, iter, "--config")) |v| {
            cmd.config = v;
        } else if (try flagValue(alloc, arg, iter, "--bind")) |v| {
            cmd.bind = v;
        } else if (try flagValue(alloc, arg, iter, "--state-file")) |v| {
            cmd.state_file = v;
        } else if (std.mem.eql(u8, arg, "--no-dedup")) {
            cmd.no_dedup = true;
        } else if (std.mem.eql(u8, arg, "--once")) {
            cmd.once = true;
        } else {
            return error.UnknownFlag;
        }
    }

    return cmd;
}

fn flagValue(
    alloc: Allocator,
    arg: []const u8,
    iter: anytype,
    comptime name: []const u8,
) ParseError!?[]const u8 {
    if (std.mem.startsWith(u8, arg, name ++ "=")) {
        return try alloc.dupe(u8, arg[name.len + 1 ..]);
    }
    if (std.mem.eql(u8, arg, name)) {
        const value = iter.next() orelse return error.MissingValue;
        return try alloc.dupe(u8, value);
    }
    return null;
}

// ----- tests -----

const testing = std.testing;

test "parseCommand serve with flags" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var iter = try std.process.ArgIteratorGeneral(.{}).init(
        alloc,
        "webhook serve --config /tmp/w.json --bind 127.0.0.1:9999 --no-dedup --once",
    );
    defer iter.deinit();

    const cmd = try parseCommand(alloc, &iter);
    try testing.expect(cmd.verb == .serve);
    try testing.expectEqualStrings("/tmp/w.json", cmd.config.?);
    try testing.expectEqualStrings("127.0.0.1:9999", cmd.bind.?);
    try testing.expect(cmd.no_dedup);
    try testing.expect(cmd.once);
}

test "parseCommand rejects unknown verb and flag" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    {
        var iter = try std.process.ArgIteratorGeneral(.{}).init(alloc, "webhook frob");
        defer iter.deinit();
        try testing.expectError(error.UnknownVerb, parseCommand(alloc, &iter));
    }
    {
        var iter = try std.process.ArgIteratorGeneral(.{}).init(alloc, "webhook serve --bogus");
        defer iter.deinit();
        try testing.expectError(error.UnknownFlag, parseCommand(alloc, &iter));
    }
}

test "parseCommand surfaces help" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    var iter = try std.process.ArgIteratorGeneral(.{}).init(alloc, "webhook --help");
    defer iter.deinit();
    try testing.expectError(error.HelpRequested, parseCommand(alloc, &iter));
}

test "pathOf strips the query string" {
    try testing.expectEqualStrings("/hooks/x", pathOf("/hooks/x"));
    try testing.expectEqualStrings("/hooks/x", pathOf("/hooks/x?a=1&b=2"));
}

test "parseBind handles ipv4, ipv6, and localhost" {
    const a = try parseBind("127.0.0.1:8787");
    try testing.expectEqual(@as(u16, 8787), a.getPort());
    const b = try parseBind("localhost:1234");
    try testing.expectEqual(@as(u16, 1234), b.getPort());
    const c = try parseBind("[::1]:4321");
    try testing.expectEqual(@as(u16, 4321), c.getPort());
    try testing.expectError(error.InvalidBind, parseBind("no-port"));
}
