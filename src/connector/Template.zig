//! Launch templates and their resolution into a concrete launch request.
//!
//! A `LaunchTemplate` is the *configuration* half of a connector: it declares
//! how to turn a `TriggerEvent` into a visible Maxx tab — the command to run, an
//! optional working directory, a tab title, environment entries, and how the
//! prompt/context should reach the command. Templates use `${field}`
//! placeholders filled *only* from explicit `TriggerEvent` fields (see
//! `Event.lookup`); nothing is inferred.
//!
//! `resolve` turns a template + an event into a `LaunchRequest`: the fully
//! substituted command/cwd/title/env plus connector provenance metadata. A
//! `LaunchRequest` is exactly the input the existing Maxx tab-launch primitive
//! (`sessions.create` on the control API) consumes — `writeControlRequest`
//! emits that request shape. Actually *sending* it to a running Maxx (the
//! runner) is intentionally out of scope here: this module only resolves.

const Template = @This();

const std = @import("std");
const Allocator = std.mem.Allocator;
const TriggerEvent = @import("Event.zig");

/// How the resolved prompt/context is delivered to the launched command.
pub const PromptDelivery = enum {
    /// Exposed as the `MAXX_CONNECTOR_PROMPT` environment variable (default).
    env,
    /// Streamed to the command's stdin by the runner.
    stdin,
    /// Written to a temp file by the runner; its path is passed via
    /// `MAXX_CONNECTOR_PROMPT_FILE`.
    file,
};

/// Environment variable name carrying the prompt for `.env` delivery.
pub const prompt_env_var = "MAXX_CONNECTOR_PROMPT";

/// A KEY/VALUE environment pair. The value may contain `${...}` placeholders.
pub const EnvEntry = struct {
    key: []const u8,
    value: []const u8,
};

/// A connector's launch configuration. Field values marked "templated" may use
/// `${field}` placeholders.
pub const LaunchTemplate = struct {
    /// Command to run in the new tab (templated). Required.
    command: []const u8,
    /// Working directory (templated). Optional — only set when explicitly
    /// configured; Maxx never guesses a directory.
    cwd: ?[]const u8 = null,
    /// Tab title (templated). Optional — defaults to the event title.
    title: ?[]const u8 = null,
    /// Extra environment entries (values templated). Optional.
    env: []const EnvEntry = &.{},
    /// Where the prompt/context is delivered. Defaults to `.env`.
    prompt_delivery: PromptDelivery = .env,
    /// Policy caller/source identity emitted as `params.caller` (e.g.
    /// `trusted-automation`), so the runner's `sessions.create` is attributed to
    /// an explicit policy source instead of silently defaulting to the trusted
    /// first-party local source. Optional — null leaves the field off.
    ///
    /// Deliberately *not* templated: a policy source is a fixed deployment
    /// decision, never derived from the (potentially untrusted) event payload, so
    /// a webhook cannot choose the identity it runs as. Group labels are opaque
    /// coordination tokens and *are* templated; the caller is a trust boundary
    /// and is not.
    caller: ?[]const u8 = null,
    /// Group label emitted as `params.group` for supervisor coordination
    /// (templated). Optional. When set, the generated `sessions.create` joins the
    /// new tab to this group, which the control server gates on *both*
    /// `tabs:spawn` and `groups:create`. Unlike `caller`, a group is just an
    /// opaque coordination token, so templating it from explicit event fields
    /// (e.g. `${issue.identifier}`) is the intended use.
    group: ?[]const u8 = null,
};

/// A KEY/VALUE pair with both sides already resolved.
pub const Pair = struct {
    key: []const u8,
    value: []const u8,
};

/// A fully resolved launch request: the concrete command/context for a visible
/// tab, plus connector provenance. Ready to hand to the tab-launch primitive.
pub const LaunchRequest = struct {
    command: []const u8,
    cwd: ?[]const u8,
    title: []const u8,
    /// Environment entries (resolved). For `.env` delivery this includes the
    /// `MAXX_CONNECTOR_PROMPT` entry.
    env: []const Pair,
    /// The resolved prompt/context, if the event carried one.
    prompt: ?[]const u8,
    prompt_delivery: PromptDelivery,
    /// Connector provenance shown on the launched tab (connector name, event id,
    /// event type, url, launch timestamp). These keys are reserved.
    metadata: []const Pair,
    /// Policy caller/source identity, emitted as `params.caller` when set. Null
    /// leaves the field off, so the control server attributes the request to the
    /// trusted first-party local source. Resolved offline — unlike the per-call
    /// capability token, it is baked into the request here, not runner-injected.
    caller: ?[]const u8,
    /// Group label, emitted as `params.group` when set. Null leaves the field
    /// off. Resolved (templated) offline so the runner needs no JSON surgery to
    /// place a connector launch into a supervisor group.
    group: ?[]const u8,

    /// Options for serializing the control request.
    pub const ControlRequestOptions = struct {
        /// The per-call capability token. A runner injects the token it read
        /// from the control directory (`MAXX_CONTROL_DIR`); offline callers such
        /// as `+connector resolve` leave it null and the field is omitted. The
        /// control server REJECTS a request with no token before dispatch, so a
        /// runner MUST supply one — this serializer does not fabricate it.
        token: ?[]const u8 = null,
    };

    /// Render the `sessions.create` control request this launch corresponds to,
    /// in the same `{ token?, method, params }` envelope the Control API expects
    /// (mirrors `cli/control.zig` `buildRequest`). Emitting it rather than
    /// sending it is what `+connector resolve` does; the runner adds only the
    /// per-call capability token. The explicit policy `caller` and the supervisor
    /// `group` are resolved offline and emitted here (`params.caller` /
    /// `params.group`), so a webhook/connector runner never has to splice them
    /// into the JSON before sending. `alloc` is used only for transient
    /// formatting buffers.
    ///
    /// Note: `params` conveys the prompt only for `.env` delivery (via the env
    /// array). For `.stdin`/`.file` delivery the prompt is NOT in the control
    /// request — the runner delivers it out of band from `LaunchRequest.prompt`
    /// and `prompt_delivery`. Consumers must consult those fields, not `params`
    /// alone, for the full launch.
    pub fn writeControlRequest(
        self: LaunchRequest,
        alloc: Allocator,
        json: *std.json.Stringify,
        opts: ControlRequestOptions,
    ) !void {
        try json.beginObject();
        if (opts.token) |token| {
            try json.objectField("token");
            try json.write(token);
        }
        try json.objectField("method");
        try json.write("sessions.create");
        try json.objectField("params");
        try json.beginObject();

        try json.objectField("title");
        try json.write(self.title);
        try json.objectField("command");
        try json.write(self.command);
        if (self.cwd) |v| {
            try json.objectField("cwd");
            try json.write(v);
        }
        try json.objectField("location");
        try json.write("tab");

        // Group joins the new tab to a supervisor group at create time; the
        // control server gates it on `groups:create` in addition to `tabs:spawn`.
        if (self.group) |g| {
            try json.objectField("group");
            try json.write(g);
        }
        // Explicit policy source so the request is attributed to it rather than
        // the default trusted-local source.
        if (self.caller) |c| {
            try json.objectField("caller");
            try json.write(c);
        }

        if (self.env.len > 0) {
            try json.objectField("env");
            try json.beginArray();
            for (self.env) |e| {
                const joined = try std.fmt.allocPrint(alloc, "{s}={s}", .{ e.key, e.value });
                defer alloc.free(joined);
                try json.write(joined);
            }
            try json.endArray();
        }

        try json.objectField("metadata");
        try json.beginObject();
        for (self.metadata) |m| {
            try json.objectField(m.key);
            try json.write(m.value);
        }
        try json.endObject();

        try json.endObject(); // params
        try json.endObject(); // root
    }
};

/// Errors from resolving a template against an event.
pub const ResolveError = error{
    /// A `${name}` placeholder referenced a field absent from the event.
    MissingField,
    /// A `${...}` placeholder was malformed (unterminated or empty).
    MalformedTemplate,
} || Allocator.Error;

/// On a `ResolveError`, the offending placeholder/field name is recorded here so
/// callers can produce an actionable message.
pub const Diagnostic = struct {
    field: []const u8 = "",
};

pub const ResolveOptions = struct {
    /// Launch timestamp recorded as provenance (`connector.launched_at`). The
    /// caller supplies it so resolution stays deterministic/testable.
    launched_at: ?[]const u8 = null,
    /// Optional out-param populated on error.
    diag: ?*Diagnostic = null,
};

/// Resolve `template` against `event`, substituting `${...}` placeholders and
/// attaching connector provenance. All returned memory is owned by `alloc`.
pub fn resolve(
    alloc: Allocator,
    template: LaunchTemplate,
    event: TriggerEvent,
    opts: ResolveOptions,
) ResolveError!LaunchRequest {
    const command = try substitute(alloc, template.command, event, opts);

    const cwd: ?[]const u8 = if (template.cwd) |c|
        try substitute(alloc, c, event, opts)
    else
        null;

    const title: []const u8 = if (template.title) |t|
        try substitute(alloc, t, event, opts)
    else
        try alloc.dupe(u8, event.title);

    // Group is templated from explicit event fields only. A group that
    // substitutes to empty (e.g. an optional `${field?}` with no value) is
    // omitted, matching the control server's "empty group means no group" rule.
    const group: ?[]const u8 = if (template.group) |g| blk: {
        const resolved = try substitute(alloc, g, event, opts);
        break :blk if (resolved.len == 0) null else resolved;
    } else null;

    // Caller is copied verbatim — a policy source is a fixed configuration
    // decision, never derived from the event payload.
    const caller: ?[]const u8 = if (template.caller) |c|
        try alloc.dupe(u8, c)
    else
        null;

    // Resolve configured env entries, then append the prompt entry for `.env`.
    var env: std.ArrayList(Pair) = .empty;
    errdefer env.deinit(alloc);
    for (template.env) |e| {
        try env.append(alloc, .{
            .key = try alloc.dupe(u8, e.key),
            .value = try substitute(alloc, e.value, event, opts),
        });
    }
    if (template.prompt_delivery == .env) {
        if (event.prompt) |p| {
            try env.append(alloc, .{
                .key = prompt_env_var,
                .value = try alloc.dupe(u8, p),
            });
        }
    }

    // Connector provenance — explicit, reserved keys only.
    var metadata: std.ArrayList(Pair) = .empty;
    errdefer metadata.deinit(alloc);
    try metadata.append(alloc, .{ .key = "connector", .value = try alloc.dupe(u8, event.source) });
    try metadata.append(alloc, .{ .key = "connector.event_id", .value = try alloc.dupe(u8, event.id) });
    try metadata.append(alloc, .{ .key = "connector.event_type", .value = try alloc.dupe(u8, event.type) });
    if (event.url) |u| {
        try metadata.append(alloc, .{ .key = "connector.url", .value = try alloc.dupe(u8, u) });
    }
    if (opts.launched_at) |ts| {
        try metadata.append(alloc, .{ .key = "connector.launched_at", .value = try alloc.dupe(u8, ts) });
    }

    return .{
        .command = command,
        .cwd = cwd,
        .title = title,
        .env = try env.toOwnedSlice(alloc),
        .prompt = if (event.prompt) |p| try alloc.dupe(u8, p) else null,
        .prompt_delivery = template.prompt_delivery,
        .metadata = try metadata.toOwnedSlice(alloc),
        .caller = caller,
        .group = group,
    };
}

/// Substitute `${name}` / `${name?}` placeholders in `input` using the event.
/// `${name}` is required (a missing/empty value is `error.MissingField`);
/// `${name?}` is optional (a missing value yields the empty string). A `$` not
/// immediately followed by `{` is a literal dollar sign.
pub fn substitute(
    alloc: Allocator,
    input: []const u8,
    event: TriggerEvent,
    opts: ResolveOptions,
) ResolveError![]u8 {
    var out: std.io.Writer.Allocating = .init(alloc);
    errdefer out.deinit();

    var i: usize = 0;
    while (i < input.len) {
        if (input[i] == '$' and i + 1 < input.len and input[i + 1] == '{') {
            const end = std.mem.indexOfScalarPos(u8, input, i + 2, '}') orelse {
                setDiag(opts, input[i..]);
                return error.MalformedTemplate;
            };
            var name = input[i + 2 .. end];
            var optional = false;
            if (name.len > 0 and name[name.len - 1] == '?') {
                optional = true;
                name = name[0 .. name.len - 1];
            }
            if (name.len == 0) {
                setDiag(opts, "${}");
                return error.MalformedTemplate;
            }

            const value = event.lookup(name);
            if (value == null or value.?.len == 0) {
                if (optional) {
                    i = end + 1;
                    continue;
                }
                setDiag(opts, name);
                return error.MissingField;
            }
            // The Allocating writer only fails on OOM; surface that.
            out.writer.writeAll(value.?) catch return error.OutOfMemory;
            i = end + 1;
        } else {
            out.writer.writeByte(input[i]) catch return error.OutOfMemory;
            i += 1;
        }
    }

    return out.written();
}

fn setDiag(opts: ResolveOptions, field: []const u8) void {
    if (opts.diag) |d| d.field = field;
}

test "substitute fills required and optional placeholders" {
    const testing = std.testing;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var ev: TriggerEvent = .{
        .source = "linear",
        .id = "id1",
        .type = "Issue",
        .title = "Fix bug",
    };
    try ev.putField(alloc, "issue.identifier", "MAX-10");

    const out = try substitute(alloc, "work on ${issue.identifier}: ${title}${missing?}", ev, .{});
    try testing.expectEqualStrings("work on MAX-10: Fix bug", out);
}

test "substitute treats lone dollar as literal" {
    const testing = std.testing;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const ev: TriggerEvent = .{ .source = "s", .id = "i", .type = "t", .title = "T" };
    const out = try substitute(alloc, "echo $HOME and ${title}", ev, .{});
    try testing.expectEqualStrings("echo $HOME and T", out);
}

test "substitute reports missing required field" {
    const testing = std.testing;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const ev: TriggerEvent = .{ .source = "s", .id = "i", .type = "t", .title = "T" };
    var diag: Diagnostic = .{};
    try testing.expectError(
        error.MissingField,
        substitute(alloc, "${issue.identifier}", ev, .{ .diag = &diag }),
    );
    try testing.expectEqualStrings("issue.identifier", diag.field);
}

test "substitute reports malformed placeholder" {
    const testing = std.testing;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const ev: TriggerEvent = .{ .source = "s", .id = "i", .type = "t", .title = "T" };
    try testing.expectError(
        error.MalformedTemplate,
        substitute(alloc, "broken ${title", ev, .{}),
    );
}

test "resolve produces command, env prompt, and provenance" {
    const testing = std.testing;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var ev: TriggerEvent = .{
        .source = "linear",
        .id = "evt-1",
        .type = "Issue",
        .title = "Implement adapter layer",
        .url = "https://linear.app/x/MAX-10",
        .prompt = "Work on MAX-10",
    };
    try ev.putField(alloc, "issue.identifier", "MAX-10");

    const template: LaunchTemplate = .{
        .command = "claude",
        .cwd = "/repo",
        .title = "${issue.identifier}: ${title}",
        .env = &.{.{ .key = "CONNECTOR", .value = "${source}" }},
    };

    const req = try resolve(alloc, template, ev, .{ .launched_at = "2026-06-14T12:00:00Z" });

    try testing.expectEqualStrings("claude", req.command);
    try testing.expectEqualStrings("/repo", req.cwd.?);
    try testing.expectEqualStrings("MAX-10: Implement adapter layer", req.title);

    // env: configured CONNECTOR=linear, plus the prompt entry.
    try testing.expectEqual(@as(usize, 2), req.env.len);
    try testing.expectEqualStrings("CONNECTOR", req.env[0].key);
    try testing.expectEqualStrings("linear", req.env[0].value);
    try testing.expectEqualStrings(prompt_env_var, req.env[1].key);
    try testing.expectEqualStrings("Work on MAX-10", req.env[1].value);

    // provenance metadata is explicit and reserved.
    try testing.expectEqualStrings("connector", req.metadata[0].key);
    try testing.expectEqualStrings("linear", req.metadata[0].value);
    try testing.expectEqualStrings("connector.event_id", req.metadata[1].key);
    try testing.expectEqualStrings("evt-1", req.metadata[1].value);
    try testing.expectEqualStrings("connector.url", req.metadata[3].key);
    try testing.expectEqualStrings("connector.launched_at", req.metadata[4].key);
}

test "writeControlRequest emits a sessions.create request" {
    const testing = std.testing;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var ev: TriggerEvent = .{
        .source = "linear",
        .id = "evt-1",
        .type = "Issue",
        .title = "Implement adapter layer",
        .url = "https://linear.app/x/MAX-10",
        .prompt = "Work on MAX-10",
    };
    try ev.putField(alloc, "issue.identifier", "MAX-10");

    const req = try resolve(alloc, .{
        .command = "claude",
        .cwd = "/repo",
        .title = "${issue.identifier}",
    }, ev, .{});

    // Without a token (offline `resolve`), the field is omitted.
    {
        var out: std.io.Writer.Allocating = .init(alloc);
        var json: std.json.Stringify = .{ .writer = &out.writer, .options = .{ .whitespace = .indent_2 } };
        try req.writeControlRequest(alloc, &json, .{});
        const parsed = try std.json.parseFromSliceLeaky(std.json.Value, alloc, out.written(), .{});
        try testing.expect(parsed.object.get("token") == null);
        try testing.expectEqualStrings("sessions.create", parsed.object.get("method").?.string);
        const params = parsed.object.get("params").?.object;
        try testing.expectEqualStrings("claude", params.get("command").?.string);
        try testing.expectEqualStrings("/repo", params.get("cwd").?.string);
        try testing.expectEqualStrings("MAX-10", params.get("title").?.string);
        try testing.expectEqualStrings("tab", params.get("location").?.string);

        // The prompt rides in env for the default `.env` delivery.
        const env = params.get("env").?.array;
        try testing.expectEqualStrings("MAXX_CONNECTOR_PROMPT=Work on MAX-10", env.items[0].string);

        // Provenance metadata is present and explicit.
        const meta = params.get("metadata").?.object;
        try testing.expectEqualStrings("linear", meta.get("connector").?.string);
        try testing.expectEqualStrings("evt-1", meta.get("connector.event_id").?.string);
        try testing.expectEqualStrings("Issue", meta.get("connector.event_type").?.string);
        try testing.expectEqualStrings("https://linear.app/x/MAX-10", meta.get("connector.url").?.string);
    }

    // A runner-supplied token is emitted at the top level (the real wire shape).
    {
        var out: std.io.Writer.Allocating = .init(alloc);
        var json: std.json.Stringify = .{ .writer = &out.writer, .options = .{} };
        try req.writeControlRequest(alloc, &json, .{ .token = "cap-token-123" });
        const parsed = try std.json.parseFromSliceLeaky(std.json.Value, alloc, out.written(), .{});
        try testing.expectEqualStrings("cap-token-123", parsed.object.get("token").?.string);
        try testing.expectEqualStrings("sessions.create", parsed.object.get("method").?.string);
    }

    // With no caller/group configured, those params are omitted entirely (the
    // server then attributes the request to the trusted local source, ungrouped).
    {
        var out: std.io.Writer.Allocating = .init(alloc);
        var json: std.json.Stringify = .{ .writer = &out.writer, .options = .{} };
        try req.writeControlRequest(alloc, &json, .{});
        const parsed = try std.json.parseFromSliceLeaky(std.json.Value, alloc, out.written(), .{});
        const params = parsed.object.get("params").?.object;
        try testing.expect(params.get("caller") == null);
        try testing.expect(params.get("group") == null);
    }
}

test "resolve carries caller and templated group" {
    const testing = std.testing;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var ev: TriggerEvent = .{
        .source = "linear",
        .id = "evt-1",
        .type = "Issue",
        .title = "Implement adapter layer",
        .prompt = "Work on MAX-10",
    };
    try ev.putField(alloc, "issue.identifier", "MAX-10");

    const req = try resolve(alloc, .{
        .command = "claude",
        // The policy source is fixed config; the group is templated from an
        // explicit event field.
        .caller = "trusted-automation",
        .group = "issue-${issue.identifier}",
    }, ev, .{});

    try testing.expectEqualStrings("trusted-automation", req.caller.?);
    try testing.expectEqualStrings("issue-MAX-10", req.group.?);
}

test "writeControlRequest emits caller and group in params" {
    const testing = std.testing;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var ev: TriggerEvent = .{
        .source = "github",
        .id = "n-7",
        .type = "issue",
        .title = "Triage",
    };
    try ev.putField(alloc, "repo.full_name", "org/repo");

    const req = try resolve(alloc, .{
        .command = "codex",
        .caller = "trusted-automation",
        .group = "${repo.full_name}",
    }, ev, .{});

    var out: std.io.Writer.Allocating = .init(alloc);
    var json: std.json.Stringify = .{ .writer = &out.writer, .options = .{} };
    try req.writeControlRequest(alloc, &json, .{ .token = "tok" });
    const parsed = try std.json.parseFromSliceLeaky(std.json.Value, alloc, out.written(), .{});
    const params = parsed.object.get("params").?.object;
    // A runner can send this verbatim: caller + group ride in params, no surgery.
    try testing.expectEqualStrings("trusted-automation", params.get("caller").?.string);
    try testing.expectEqualStrings("org/repo", params.get("group").?.string);
}

test "resolve omits an empty optional templated group" {
    const testing = std.testing;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const ev: TriggerEvent = .{ .source = "s", .id = "i", .type = "t", .title = "T" };
    // The optional `${missing?}` yields an empty string; an empty group is
    // omitted (matches the server's "empty group means no group" rule).
    const req = try resolve(alloc, .{ .command = "ls", .group = "${missing?}" }, ev, .{});
    try testing.expect(req.group == null);

    var out: std.io.Writer.Allocating = .init(alloc);
    var json: std.json.Stringify = .{ .writer = &out.writer, .options = .{} };
    try req.writeControlRequest(alloc, &json, .{});
    try testing.expect(std.mem.indexOf(u8, out.written(), "\"group\"") == null);
}

test "templated group requires an explicit field" {
    const testing = std.testing;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const ev: TriggerEvent = .{ .source = "s", .id = "i", .type = "t", .title = "T" };
    var diag: Diagnostic = .{};
    // A required `${...}` group field that the event does not provide is an
    // error naming the field — never silently inferred from anything else.
    try testing.expectError(
        error.MissingField,
        resolve(alloc, .{ .command = "ls", .group = "${issue.identifier}" }, ev, .{ .diag = &diag }),
    );
    try testing.expectEqualStrings("issue.identifier", diag.field);
}

test "stdin delivery keeps the prompt off the control request" {
    const testing = std.testing;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const ev: TriggerEvent = .{
        .source = "github",
        .id = "n1",
        .type = "issue",
        .title = "T",
        .prompt = "DELIVER_VIA_STDIN",
    };
    const req = try resolve(alloc, .{ .command = "codex", .prompt_delivery = .stdin }, ev, .{});

    // The prompt is carried on the LaunchRequest, not in the env-based request.
    try testing.expect(req.prompt_delivery == .stdin);
    try testing.expectEqualStrings("DELIVER_VIA_STDIN", req.prompt.?);
    try testing.expectEqual(@as(usize, 0), req.env.len);

    var out: std.io.Writer.Allocating = .init(alloc);
    var json: std.json.Stringify = .{ .writer = &out.writer, .options = .{} };
    try req.writeControlRequest(alloc, &json, .{});
    // The control request must NOT carry the stdin/file prompt; consumers read
    // it from req.prompt / prompt_delivery instead.
    try testing.expect(std.mem.indexOf(u8, out.written(), "DELIVER_VIA_STDIN") == null);
    try testing.expect(std.mem.indexOf(u8, out.written(), "MAXX_CONNECTOR_PROMPT") == null);
}

test "resolve defaults title to event title" {
    const testing = std.testing;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const ev: TriggerEvent = .{ .source = "s", .id = "i", .type = "t", .title = "Default Title" };
    const req = try resolve(alloc, .{ .command = "ls" }, ev, .{});
    try testing.expectEqualStrings("Default Title", req.title);
    try testing.expect(req.cwd == null);
    try testing.expectEqual(@as(usize, 0), req.env.len); // no prompt, no configured env
}
