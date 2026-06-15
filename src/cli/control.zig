const std = @import("std");
const Allocator = std.mem.Allocator;
const ArenaAllocator = std.heap.ArenaAllocator;
const Action = @import("../cli.zig").ghostty.Action;
const args = @import("args.zig");

/// libc bits we need directly. In this Zig version the socket syscalls are not
/// surfaced as `std.posix` wrappers, and the macOS CLI links libc, so we bind
/// the handful of C functions we use.
const c = struct {
    extern "c" fn socket(domain: c_int, sock_type: c_int, protocol: c_int) c_int;
    extern "c" fn connect(fd: c_int, addr: *const anyopaque, len: u32) c_int;
    extern "c" fn close(fd: c_int) c_int;
    extern "c" fn read(fd: c_int, buf: [*]u8, n: usize) isize;
    extern "c" fn write(fd: c_int, buf: [*]const u8, n: usize) isize;
    extern "c" fn shutdown(fd: c_int, how: c_int) c_int;
    extern "c" fn getuid() u32;
};

const AF_UNIX = 1;
const SOCK_STREAM = 1;
const SHUT_WR = 1;

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

/// The top-level command group. `sessions` is the per-session surface (MAX-1..3);
/// `stream` is the cross-resource structured event stream and `event` the agent
/// event-declaration shorthand (MAX-7); `policy` is the MAX-11 capability
/// diagnostic.
const Group = enum {
    sessions,
    stream,
    event,
    policy,
};

const Verb = enum {
    create,
    get,
    list,
    update,
    cancel,
    action,
    // MAX-2 lifecycle control + agent declaration verbs.
    wait,
    watch,
    archive,
    restart,
    events,
    @"declare-state",
    @"emit-event",
    @"set-metadata",
    // MAX-3 agent-declared workflow state verbs.
    @"set-state",
    @"set-summary",
    // MAX-5 persistent session registry verbs.
    @"set-agent-type",
    // MAX-6 parent-child tab group verbs.
    @"set-parent",
    // MAX-7 structured event stream verbs.
    @"set-group",
    emit,
    // MAX-4 agent-reported metadata verbs.
    @"remove-metadata",
    @"clear-metadata",
    // MAX-11 capability policy diagnostic (`policy check`).
    @"policy-check",
};

/// A single `list --filter` constraint: a metadata key that must be present and,
/// when `value` is non-null, must equal it (compared as a string).
const MetadataFilter = struct {
    key: []const u8,
    value: ?[]const u8,
};

/// A parsed `maxx +control <group> ...` invocation.
const Command = struct {
    /// The command group. Always set explicitly by `parseCommand`; defaulted to
    /// `.sessions` so direct `Command{ .verb = … }` literals (e.g. in tests) stay
    /// concise.
    group: Group = .sessions,
    verb: Verb,
    id: ?[]const u8 = null,
    title: ?[]const u8 = null,
    cwd: ?[]const u8 = null,
    command: ?[]const u8 = null,
    status: ?[]const u8 = null,
    location: ?[]const u8 = null,
    action: ?[]const u8 = null,
    input: ?[]const u8 = null,
    // MAX-2 fields.
    state: ?[]const u8 = null,
    event: ?[]const u8 = null,
    lifecycle: ?[]const u8 = null,
    message: ?[]const u8 = null,
    source: ?[]const u8 = null,
    payload_json: ?[]const u8 = null,
    key: ?[]const u8 = null,
    value: ?[]const u8 = null,
    // MAX-4 fields.
    value_json: ?[]const u8 = null,
    reason: ?[]const u8 = null,
    signal: ?[]const u8 = null,
    summary: ?[]const u8 = null,
    // MAX-5 persistent session registry fields.
    agent_type: ?[]const u8 = null,
    parent: ?[]const u8 = null,
    // MAX-7 structured event stream fields.
    group_name: ?[]const u8 = null,
    tab: ?[]const u8 = null,
    all: ?[]const u8 = null,
    // MAX-11 capability policy fields.
    caller: ?[]const u8 = null,
    capability: ?[]const u8 = null,
    confirm: bool = false,
    timeout_ms: ?u64 = null,
    since: ?i64 = null,
    metadata: std.ArrayList([2][]const u8) = .empty,
    // Keys to drop for `remove-metadata` (repeatable `--key`).
    keys: std.ArrayList([]const u8) = .empty,
    // `--filter key[=value]` constraints for `list`. value is null for key-only.
    filters: std.ArrayList(MetadataFilter) = .empty,
    env: std.ArrayList([]const u8) = .empty,

    fn method(self: Command) []const u8 {
        return switch (self.group) {
            .sessions => switch (self.verb) {
                .create => "sessions.create",
                .get => "sessions.get",
                .list => "sessions.list",
                .update => "sessions.update",
                .cancel, .action => "sessions.action",
                .wait => "sessions.wait",
                .watch => "sessions.watch",
                .archive => "sessions.archive",
                .restart => "sessions.restart",
                .events => "sessions.events",
                .@"declare-state" => "sessions.declare-state",
                .@"emit-event" => "sessions.emit-event",
                .@"set-metadata" => "sessions.set-metadata",
                .@"set-state" => "sessions.set-state",
                .@"set-summary" => "sessions.set-summary",
                .@"set-agent-type" => "sessions.set-agent-type",
                .@"set-parent" => "sessions.set-parent",
                .@"set-group" => "sessions.set-group",
                .@"remove-metadata" => "sessions.remove-metadata",
                .@"clear-metadata" => "sessions.clear-metadata",
                .emit, .@"policy-check" => unreachable,
            },
            // `stream watch`/`stream wait` are the cross-resource stream.
            .stream => switch (self.verb) {
                .watch => "stream.watch",
                .wait => "stream.wait",
                else => unreachable,
            },
            // `event emit` is shorthand for an agent event declaration.
            .event => "sessions.emit-event",
            // `policy check` is the capability diagnostic.
            .policy => "policy.check",
        };
    }

    /// The effective action name for `sessions.action` requests.
    fn effectiveAction(self: Command) ?[]const u8 {
        return switch (self.verb) {
            .cancel => "cancel",
            .action => self.action,
            else => null,
        };
    }
};

const ParseError = error{
    MissingGroup,
    UnknownGroup,
    MissingVerb,
    UnknownVerb,
    MissingValue,
    UnknownFlag,
    InvalidMetadata,
    InvalidFilter,
    InvalidDuration,
    InvalidSince,
} || Allocator.Error;

/// The `+control` action provides an external, local control surface for Maxx.
///
/// It talks to a running Maxx instance over a per-user Unix domain socket
/// (`/tmp/maxx-control-<uid>/control.sock`, overridable with the
/// `MAXX_CONTROL_DIR` environment variable) using a capability token written by
/// the app to `token` in the same directory. This lets trusted scripts and
/// webhook runners *outside* an existing Maxx tab create and manage tabs and
/// sessions without scraping terminal output or relying on UI heuristics.
///
/// Subcommands:
///
///   * `sessions create`: create a new visible tab/session. Flags:
///     `--title`, `--cwd`, `--command`, `--status`, `--location=tab|window`,
///     repeatable `--metadata key=value` and `--env KEY=VALUE`.
///
///   * `sessions get <session_id>`: print the explicit lifecycle state and
///     declared metadata for a session.
///
///   * `sessions list`: list the API-created sessions.
///
///   * `sessions update <session_id>`: update caller-owned fields only. Flags:
///     `--status`, repeatable `--metadata key=value`.
///
///   * `sessions cancel <session_id>`: cancel/close a session (idempotent).
///
///   * `sessions action <session_id> --action <name>`: send a constrained
///     action — `focus`, `input` (with `--input <text>`), `interrupt`
///     (optionally `--signal SIGTERM`), `cancel`, or `close`.
///
/// Lifecycle control verbs (the `maxxctl` half of the surface — Maxx runtime
/// primitives):
///
///   * `sessions wait <session_id>`: block until a condition holds. Pass exactly
///     one of `--state <name>`, `--event <name>`, or `--lifecycle <value>`, with
///     optional `--timeout <dur>` and `--since <seq>`.
///   * `sessions watch <session_id> [--json] [--since <seq>] [--timeout <dur>]`:
///     stream newline-delimited lifecycle/event messages until the session ends.
///   * `sessions archive <session_id> [--reason <text>]`: close the surface but
///     retain the record.
///   * `sessions restart <session_id> [--command <cmd>|--last-command]`: replay
///     the recorded (or supplied) command in a fresh surface.
///   * `sessions events <session_id> [--since <seq>]`: print the audit log.
///
/// Agent declaration verbs (the `maxx-agent-hook` half — agents declaring their
/// own workflow-relevant lifecycle facts):
///
///   * `sessions declare-state <session_id> --state <name> [--message <text>]
///     [--source <name>]`
///   * `sessions emit-event <session_id> --event <name> [--payload-json <json>]
///     [--source <name>]`
///
/// Agent-reported metadata verbs (MAX-4 — namespaced key → arbitrary JSON value
/// an agent attaches to a session; Maxx stores/displays/filters it verbatim and
/// never interprets it as workflow state):
///
///   * `sessions set-metadata <session_id> --key <key>
///     (--value <string> | --value-json <json>) [--source <name>]`: set/merge one
///     key. `--value-json` carries a structured (nested) value.
///   * `sessions remove-metadata <session_id> --key <key> [--key <key> ...]`:
///     drop one or more keys.
///   * `sessions clear-metadata <session_id>`: drop all metadata.
///   * `sessions list --filter <key>[=<value>] [--filter ...]`: list only
///     sessions whose metadata matches every filter (key present, or key=value).
///   * `sessions list [--parent <session_id>] [--group <name>]`: group-aware
///     query filters (MAX-6), composable with each other and `--filter`:
///     `--parent` lists a tab's children; `--group` lists a group's members.
///   * `sessions create`/`update` also accept repeatable `--metadata key=value`
///     (string values).
///
/// Agent-declared workflow state verbs (MAX-3 — a small, validated state the UI
/// displays as a badge, distinct from the free-form `declare-state`):
///
///   * `sessions set-state <session_id> --state <value> [--source <name>]` where
///     `<value>` is one of `running`, `needsInput`, `blocked`, `complete`,
///     `failed`. An unknown value is rejected.
///   * `sessions set-summary <session_id> --summary <text> [--source <name>]`
///
/// Persistent session registry (MAX-5 — declared fields the registry persists
/// across app restarts):
///
///   * `sessions set-agent-type <session_id> --agent-type <name> [--source <name>]`
///     declares the agent type (e.g. `claude-code`), stored verbatim and never
///     inferred. `sessions create` also takes `--agent-type <name>` and
///     `--parent <session_id>` (a persisted parent association).
///
/// Parent-child tab groups (MAX-6 — explicit relationship metadata; never
/// inferred from output, process/branch/path names, or idle time):
///
///   * `sessions set-parent <session_id> --parent <parent_session_id>`: set (or,
///     with an empty `--parent`, clear) the tab's parent edge after creation —
///     the update counterpart to `create --parent`. A missing parent, the tab
///     itself, or an edge that would form a cycle is rejected. Query the
///     relationships with `sessions list --parent`/`--group` and the `parent_id`
///     on the session view.
///
/// Structured event stream (MAX-7 — a cross-resource, cursor-addressed event
/// bus for supervisor agents):
///
///   * `sessions set-group <session_id> --group <name>`: join (or, with an empty
///     `--group`, leave) a coordination group. Membership changes are recorded
///     as Maxx-owned mechanical events. `sessions create` also takes `--group`.
///   * `stream watch [--session <id>] [--tab <surface_id>] [--group <name>]
///     [--since <cursor>] [--timeout <dur>]`: stream the global event bus as
///     newline-delimited JSON, filtered by resource and resumable from a cursor.
///   * `stream wait [--session <id>|--tab <id>|--group <name>] --event <type>
///     [--since <cursor>] [--timeout <dur>]`: block until a matching stream event
///     arrives.
///   * `stream wait --group <name> --all <idle|exited|declared:<state>>
///     [--timeout <dur>]`: block until every member of a group satisfies the
///     condition.
///   * `event emit --session <id> --type <name> [--json <payload>]
///     [--source <name>]`: shorthand for an agent event declaration (maps to
///     `sessions emit-event`).
///
/// Capability policy (MAX-11). Every request resolves to a caller *source* and a
/// requested *capability*; the running app's policy decides allow / deny /
/// confirm before any side effect. Global flags:
///
///   * `--as <source>`: claim a policy source (e.g. `readonly-external`).
///     Omitted, the request is the trusted first-party local source.
///   * `--confirm` (alias `--yes`): approve a confirmation-required action; the
///     first attempt without it exits 6 and prints the confirmation prompt.
///
///   * `policy check --capability <cap> [--as <source>] [<session_id>]`: a
///     read-only diagnostic that reports whether a (source, capability, target)
///     would be allowed, denied, or require confirmation — performing no action.
///
/// The create response includes a stable `session_id` to use for all later
/// operations. The raw JSON response is printed to stdout. Exit codes are
/// stable: 0 success/matched, 1 generic error, 2 `wait` timeout, 3 missing
/// target, 4 `wait` target ended before matching, 5 unsupported operation,
/// 6 confirmation required.
///
/// Note: a flag value that begins with `+` (e.g. a command literally starting
/// with a plus) must use the `--flag=value` form (`--command=+foo`); the
/// space-separated form is intercepted by Maxx's `+action` CLI detection.
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
        error.MissingGroup, error.MissingVerb => return Action.help_error,
        error.UnknownGroup => {
            try stderr.print(
                "error: expected a 'sessions', 'stream', 'event', or 'policy' subcommand group\n",
                .{},
            );
            return 1;
        },
        error.UnknownVerb => {
            try stderr.print(
                "error: unknown subcommand.\n" ++
                    "  sessions: create, get, list, update, cancel, action, wait, watch, " ++
                    "archive, restart, events, declare-state, emit-event, set-metadata, " ++
                    "remove-metadata, clear-metadata, set-state, set-summary, set-agent-type, " ++
                    "set-parent, set-group\n" ++
                    "  stream:   watch, wait\n" ++
                    "  event:    emit\n" ++
                    "  policy:   check\n",
                .{},
            );
            return 1;
        },
        error.MissingValue => {
            try stderr.print("error: a flag is missing its value\n", .{});
            return 1;
        },
        error.InvalidMetadata => {
            try stderr.print("error: --metadata expects key=value\n", .{});
            return 1;
        },
        error.InvalidFilter => {
            try stderr.print("error: --filter expects key or key=value\n", .{});
            return 1;
        },
        error.InvalidDuration => {
            try stderr.print("error: --timeout expects a duration like 30s, 500ms, 5m, or 1h\n", .{});
            return 1;
        },
        error.InvalidSince => {
            try stderr.print("error: --since expects an integer sequence number\n", .{});
            return 1;
        },
        error.UnknownFlag => {
            try stderr.print("error: unknown flag\n", .{});
            return 1;
        },
        else => return err,
    };

    // Resolve the control directory, socket, and token paths.
    const dir = controlDir(arena_alloc) catch |err| {
        try stderr.print("error: could not resolve control directory: {}\n", .{err});
        return 1;
    };
    const socket_path = try std.fmt.allocPrint(arena_alloc, "{s}/control.sock", .{dir});
    const token_path = try std.fmt.allocPrint(arena_alloc, "{s}/token", .{dir});

    const token = readToken(arena_alloc, token_path) catch {
        try stderr.print(
            "error: could not read control token at {s}\n" ++
                "Is Maxx running? The control API is served by the running app.\n",
            .{token_path},
        );
        return 1;
    };

    const request = try buildRequest(arena_alloc, cmd, token);

    // `watch` streams many newline-delimited messages until the session ends or
    // the caller disconnects; print them as they arrive.
    if (cmd.verb == .watch) {
        return streamResponse(arena_alloc, socket_path, request) catch |err| {
            try stderr.print(
                "error: could not reach Maxx control socket at {s}: {}\n",
                .{ socket_path, err },
            );
            return 1;
        };
    }

    // `wait` keeps its write side open so the server can detect a caller that
    // gives up; other single-shot requests half-close after sending the request.
    const half_close = cmd.verb != .wait;
    const response = sendRequest(arena_alloc, socket_path, request, half_close) catch |err| {
        try stderr.print(
            "error: could not reach Maxx control socket at {s}: {}\n",
            .{ socket_path, err },
        );
        return 1;
    };

    var out_buf: [4096]u8 = undefined;
    var stdout_writer = std.fs.File.stdout().writer(&out_buf);
    const stdout = &stdout_writer.interface;
    const trimmed = std.mem.trim(u8, response, &std.ascii.whitespace);
    try stdout.writeAll(trimmed);
    try stdout.writeAll("\n");
    try stdout.flush();

    return exitCode(arena_alloc, trimmed, cmd.verb);
}

/// Parse a human duration into milliseconds. Accepts a bare integer (seconds) or
/// an integer with a `ms`/`s`/`m`/`h` suffix. Returns null on anything else.
fn parseDurationMs(s: []const u8) ?u64 {
    // Cap the result well within i64 range: the server decodes `timeout_ms` as a
    // signed integer and then clamps it to its own maximum, so a saturating
    // multiply that overflowed i64 would be rejected as malformed rather than
    // clamped. 24h is far above any real wait and safely representable.
    const max_ms: u64 = 24 * 3_600_000;

    const t = std.mem.trim(u8, s, &std.ascii.whitespace);
    if (t.len == 0) return null;

    var num_end: usize = 0;
    while (num_end < t.len and std.ascii.isDigit(t[num_end])) : (num_end += 1) {}
    if (num_end == 0) return null;

    const value = std.fmt.parseInt(u64, t[0..num_end], 10) catch return null;
    const unit = t[num_end..];

    const mult: u64 = if (unit.len == 0) 1000 // bare number = seconds
        else if (std.mem.eql(u8, unit, "ms")) 1 else if (std.mem.eql(u8, unit, "s")) 1000 else if (std.mem.eql(u8, unit, "m")) 60_000 else if (std.mem.eql(u8, unit, "h")) 3_600_000 else return null;

    return @min(value *| mult, max_ms);
}

/// Map a response to a stable, documented exit code:
///   0 success/matched · 1 generic error · 2 wait timeout ·
///   3 missing target (not_found) · 4 wait target ended · 5 unsupported op ·
///   6 confirmation required (re-send with --confirm to approve).
fn exitCode(alloc: Allocator, response: []const u8, verb: Verb) u8 {
    const parsed = std.json.parseFromSlice(std.json.Value, alloc, response, .{}) catch return 1;
    defer parsed.deinit();
    if (parsed.value != .object) return 1;
    const obj = parsed.value.object;

    const ok = obj.get("ok") orelse return 1;
    if (ok == .bool and ok.bool) {
        if (verb == .wait) {
            if (obj.get("result")) |result| {
                if (result == .object) {
                    if (result.object.get("outcome")) |outcome| {
                        if (outcome == .string) {
                            if (std.mem.eql(u8, outcome.string, "timeout")) return 2;
                            if (std.mem.eql(u8, outcome.string, "ended")) return 4;
                        }
                    }
                }
            }
        }
        return 0;
    }

    if (obj.get("error")) |err| {
        if (err == .object) {
            if (err.object.get("code")) |code| {
                if (code == .string) {
                    if (std.mem.eql(u8, code.string, "not_found")) return 3;
                    if (std.mem.eql(u8, code.string, "unsupported")) return 5;
                    if (std.mem.eql(u8, code.string, "confirmation_required")) return 6;
                    // `unsupported_action` is an unknown/misspelled action name —
                    // a caller usage error, which is a generic (exit 1) failure.
                }
            }
        }
    }
    return 1;
}

/// Resolve the control directory: `$MAXX_CONTROL_DIR` or `/tmp/maxx-control-<uid>`.
fn controlDir(alloc: Allocator) ![]const u8 {
    if (std.process.getEnvVarOwned(alloc, "MAXX_CONTROL_DIR")) |dir| {
        if (dir.len > 0) return dir;
    } else |_| {}
    return try std.fmt.allocPrint(alloc, "/tmp/maxx-control-{d}", .{c.getuid()});
}

fn readToken(alloc: Allocator, path: []const u8) ![]const u8 {
    const file = try std.fs.openFileAbsolute(path, .{});
    defer file.close();
    const raw = try file.readToEndAlloc(alloc, 4096);
    return std.mem.trim(u8, raw, &std.ascii.whitespace);
}

/// Parse the tokens after the action selector into a `Command`.
fn parseCommand(alloc: Allocator, iter: anytype) ParseError!Command {
    var group = iter.next() orelse return error.MissingGroup;

    // Depending on how the action was dispatched, the leading action token may
    // still be present (e.g. `+control sessions ...`) or already consumed (the
    // macOS CLI strips it). Tolerate both.
    if (std.mem.eql(u8, group, "+control") or std.mem.eql(u8, group, "control")) {
        group = iter.next() orelse return error.MissingGroup;
    }

    const parsed_group = parseGroup(group) orelse return error.UnknownGroup;

    const verb_str = iter.next() orelse return error.MissingVerb;
    const verb = parseVerb(parsed_group, verb_str) orelse return error.UnknownVerb;

    var cmd: Command = .{ .group = parsed_group, .verb = verb };
    while (iter.next()) |raw_arg| {
        const arg: []const u8 = raw_arg;
        if (try flagValue(alloc, arg, iter, "--title")) |v| {
            cmd.title = v;
        } else if (try flagValue(alloc, arg, iter, "--cwd")) |v| {
            cmd.cwd = v;
        } else if (try flagValue(alloc, arg, iter, "--command")) |v| {
            cmd.command = v;
        } else if (try flagValue(alloc, arg, iter, "--status")) |v| {
            cmd.status = v;
        } else if (try flagValue(alloc, arg, iter, "--location")) |v| {
            cmd.location = v;
        } else if (try flagValue(alloc, arg, iter, "--action")) |v| {
            cmd.action = v;
        } else if (try flagValue(alloc, arg, iter, "--input")) |v| {
            cmd.input = v;
        } else if (try flagValue(alloc, arg, iter, "--id")) |v| {
            cmd.id = v;
        } else if (try flagValue(alloc, arg, iter, "--state")) |v| {
            cmd.state = v;
        } else if (try flagValue(alloc, arg, iter, "--event")) |v| {
            cmd.event = v;
        } else if (try flagValue(alloc, arg, iter, "--lifecycle")) |v| {
            cmd.lifecycle = v;
        } else if (try flagValue(alloc, arg, iter, "--message")) |v| {
            cmd.message = v;
        } else if (try flagValue(alloc, arg, iter, "--source")) |v| {
            cmd.source = v;
        } else if (try flagValue(alloc, arg, iter, "--payload-json")) |v| {
            cmd.payload_json = v;
        } else if (try flagValue(alloc, arg, iter, "--key")) |v| {
            // `--key` names the single key for `set-metadata` and, when repeated,
            // the keys to drop for `remove-metadata`; record it in both shapes so
            // either method can read it.
            cmd.key = v;
            try cmd.keys.append(alloc, v);
        } else if (try flagValue(alloc, arg, iter, "--value-json")) |v| {
            cmd.value_json = v;
        } else if (try flagValue(alloc, arg, iter, "--value")) |v| {
            cmd.value = v;
        } else if (try flagValue(alloc, arg, iter, "--reason")) |v| {
            cmd.reason = v;
        } else if (try flagValue(alloc, arg, iter, "--signal")) |v| {
            cmd.signal = v;
        } else if (try flagValue(alloc, arg, iter, "--summary")) |v| {
            cmd.summary = v;
        } else if (try flagValue(alloc, arg, iter, "--agent-type")) |v| {
            cmd.agent_type = v;
        } else if (try flagValue(alloc, arg, iter, "--parent")) |v| {
            cmd.parent = v;
        } else if (try flagValue(alloc, arg, iter, "--session")) |v| {
            // `--session <id>` is the stream/event spelling of the target id.
            cmd.id = v;
        } else if (try flagValue(alloc, arg, iter, "--tab")) |v| {
            cmd.tab = v;
        } else if (try flagValue(alloc, arg, iter, "--group")) |v| {
            cmd.group_name = v;
        } else if (try flagValue(alloc, arg, iter, "--all")) |v| {
            cmd.all = v;
        } else if (try flagValue(alloc, arg, iter, "--type")) |v| {
            // `event emit --type <name>` is the spelling of the event name.
            cmd.event = v;
        } else if (cmd.group == .event and cmd.verb == .emit and
            (std.mem.eql(u8, arg, "--json") or std.mem.startsWith(u8, arg, "--json=")))
        {
            // `event emit --json '{...}'` carries the structured payload.
            cmd.payload_json = (try flagValue(alloc, arg, iter, "--json")).?;
        } else if (try flagValue(alloc, arg, iter, "--as")) |v| {
            cmd.caller = v;
        } else if (try flagValue(alloc, arg, iter, "--capability")) |v| {
            cmd.capability = v;
        } else if (std.mem.eql(u8, arg, "--confirm") or std.mem.eql(u8, arg, "--yes")) {
            cmd.confirm = true;
        } else if (try flagValue(alloc, arg, iter, "--timeout")) |v| {
            cmd.timeout_ms = parseDurationMs(v) orelse return error.InvalidDuration;
        } else if (try flagValue(alloc, arg, iter, "--since")) |v| {
            cmd.since = std.fmt.parseInt(i64, v, 10) catch return error.InvalidSince;
        } else if (try flagValue(alloc, arg, iter, "--metadata")) |v| {
            const eq = std.mem.indexOfScalar(u8, v, '=') orelse return error.InvalidMetadata;
            try cmd.metadata.append(alloc, .{ v[0..eq], v[eq + 1 ..] });
        } else if (try flagValue(alloc, arg, iter, "--filter")) |v| {
            // `key` (presence) or `key=value` (equality). An empty key is invalid.
            if (std.mem.indexOfScalar(u8, v, '=')) |eq| {
                if (eq == 0) return error.InvalidFilter;
                try cmd.filters.append(alloc, .{ .key = v[0..eq], .value = v[eq + 1 ..] });
            } else {
                if (v.len == 0) return error.InvalidFilter;
                try cmd.filters.append(alloc, .{ .key = v, .value = null });
            }
        } else if (try flagValue(alloc, arg, iter, "--env")) |v| {
            try cmd.env.append(alloc, v);
        } else if (std.mem.eql(u8, arg, "--json")) {
            // `watch` always emits JSON; accept the documented flag as a no-op.
        } else if (std.mem.eql(u8, arg, "--last-command")) {
            // `restart` replays the recorded command by default; accept as a no-op.
        } else if (std.mem.startsWith(u8, arg, "-")) {
            return error.UnknownFlag;
        } else {
            // A bare positional is the session id. Dupe it: the argument
            // iterator may reuse its backing buffer on the next `next()`.
            cmd.id = try alloc.dupe(u8, arg);
        }
    }

    return cmd;
}

fn parseGroup(s: []const u8) ?Group {
    inline for (@typeInfo(Group).@"enum".fields) |field| {
        if (std.mem.eql(u8, s, field.name)) return @field(Group, field.name);
    }
    return null;
}

/// Parse a verb, rejecting verbs that do not belong to the given group (so
/// `stream create` or `event watch` are usage errors rather than silently
/// mapped to the wrong method).
fn parseVerb(group: Group, s: []const u8) ?Verb {
    return switch (group) {
        .sessions => sessionsVerb(s),
        .stream => streamVerb(s),
        .event => eventVerb(s),
        .policy => policyVerb(s),
    };
}

fn sessionsVerb(s: []const u8) ?Verb {
    const candidates = [_]Verb{
        .create,            .get,               .list,
        .update,            .cancel,            .action,
        .wait,              .watch,             .archive,
        .restart,           .events,            .@"declare-state",
        .@"emit-event",     .@"set-metadata",   .@"set-state",
        .@"set-summary",    .@"set-group",      .@"remove-metadata",
        .@"clear-metadata", .@"set-agent-type", .@"set-parent",
    };
    inline for (candidates) |v| {
        if (std.mem.eql(u8, s, @tagName(v))) return v;
    }
    return null;
}

fn streamVerb(s: []const u8) ?Verb {
    if (std.mem.eql(u8, s, "watch")) return .watch;
    if (std.mem.eql(u8, s, "wait")) return .wait;
    return null;
}

fn eventVerb(s: []const u8) ?Verb {
    if (std.mem.eql(u8, s, "emit")) return .emit;
    return null;
}

fn policyVerb(s: []const u8) ?Verb {
    if (std.mem.eql(u8, s, "check")) return .@"policy-check";
    return null;
}

/// If `arg` matches `name` (either `--name=value` or `--name value`), return the
/// value, consuming the next token from `iter` when needed.
fn flagValue(
    alloc: Allocator,
    arg: []const u8,
    iter: anytype,
    comptime name: []const u8,
) ParseError!?[]const u8 {
    // Both branches dupe: the argument iterator may reuse its backing buffer on
    // the next `next()`, so any slice we keep must be copied out.
    if (std.mem.startsWith(u8, arg, name ++ "=")) {
        return try alloc.dupe(u8, arg[name.len + 1 ..]);
    }
    if (std.mem.eql(u8, arg, name)) {
        const value = iter.next() orelse return error.MissingValue;
        return try alloc.dupe(u8, value);
    }
    return null;
}

/// Build the newline-free JSON request body for `cmd`.
fn buildRequest(alloc: Allocator, cmd: Command, token: []const u8) ![]u8 {
    var out: std.io.Writer.Allocating = .init(alloc);
    errdefer out.deinit();
    var json: std.json.Stringify = .{ .writer = &out.writer, .options = .{} };

    try json.beginObject();
    try json.objectField("token");
    try json.write(token);
    try json.objectField("method");
    try json.write(cmd.method());
    try json.objectField("params");
    try json.beginObject();

    if (cmd.id) |v| {
        try json.objectField("id");
        try json.write(v);
    }
    if (cmd.title) |v| {
        try json.objectField("title");
        try json.write(v);
    }
    if (cmd.cwd) |v| {
        try json.objectField("cwd");
        try json.write(v);
    }
    if (cmd.command) |v| {
        try json.objectField("command");
        try json.write(v);
    }
    if (cmd.status) |v| {
        try json.objectField("status");
        try json.write(v);
    }
    if (cmd.location) |v| {
        try json.objectField("location");
        try json.write(v);
    }
    if (cmd.input) |v| {
        try json.objectField("input");
        try json.write(v);
    }
    if (cmd.effectiveAction()) |v| {
        try json.objectField("action");
        try json.write(v);
    }
    if (cmd.state) |v| {
        try json.objectField("state");
        try json.write(v);
    }
    if (cmd.event) |v| {
        try json.objectField("event");
        try json.write(v);
    }
    if (cmd.lifecycle) |v| {
        try json.objectField("lifecycle");
        try json.write(v);
    }
    if (cmd.message) |v| {
        try json.objectField("message");
        try json.write(v);
    }
    if (cmd.source) |v| {
        try json.objectField("source");
        try json.write(v);
    }
    if (cmd.payload_json) |v| {
        // The server receives the raw JSON text as a string and validates it.
        try json.objectField("payload_json");
        try json.write(v);
    }
    if (cmd.verb == .@"remove-metadata") {
        // remove-metadata carries the keys to drop as an array (repeatable
        // `--key`); it never sends a scalar `key`.
        if (cmd.keys.items.len > 0) {
            try json.objectField("keys");
            try json.beginArray();
            for (cmd.keys.items) |k| try json.write(k);
            try json.endArray();
        }
    } else if (cmd.key) |v| {
        try json.objectField("key");
        try json.write(v);
    }
    if (cmd.value) |v| {
        try json.objectField("value");
        try json.write(v);
    }
    if (cmd.value_json) |v| {
        // Raw JSON text carried as a string; the server parses and validates it.
        try json.objectField("value_json");
        try json.write(v);
    }
    if (cmd.filters.items.len > 0) {
        try json.objectField("metadata_filter");
        try json.beginArray();
        for (cmd.filters.items) |f| {
            try json.beginObject();
            try json.objectField("key");
            try json.write(f.key);
            if (f.value) |val| {
                try json.objectField("value");
                try json.write(val);
            }
            try json.endObject();
        }
        try json.endArray();
    }
    if (cmd.reason) |v| {
        try json.objectField("reason");
        try json.write(v);
    }
    if (cmd.signal) |v| {
        try json.objectField("signal");
        try json.write(v);
    }
    if (cmd.summary) |v| {
        try json.objectField("summary");
        try json.write(v);
    }
    if (cmd.agent_type) |v| {
        try json.objectField("agent_type");
        try json.write(v);
    }
    if (cmd.parent) |v| {
        try json.objectField("parent");
        try json.write(v);
    }
    if (cmd.group_name) |v| {
        try json.objectField("group");
        try json.write(v);
    }
    if (cmd.tab) |v| {
        try json.objectField("tab");
        try json.write(v);
    }
    if (cmd.all) |v| {
        try json.objectField("all");
        try json.write(v);
    }
    if (cmd.caller) |v| {
        try json.objectField("caller");
        try json.write(v);
    }
    if (cmd.capability) |v| {
        try json.objectField("capability");
        try json.write(v);
    }
    if (cmd.confirm) {
        try json.objectField("confirm");
        try json.write(true);
    }
    if (cmd.timeout_ms) |v| {
        try json.objectField("timeout_ms");
        try json.write(v);
    }
    if (cmd.since) |v| {
        try json.objectField("since");
        try json.write(v);
    }
    if (cmd.metadata.items.len > 0) {
        try json.objectField("metadata");
        try json.beginObject();
        for (cmd.metadata.items) |kv| {
            try json.objectField(kv[0]);
            try json.write(kv[1]);
        }
        try json.endObject();
    }
    if (cmd.env.items.len > 0) {
        try json.objectField("env");
        try json.beginArray();
        for (cmd.env.items) |e| try json.write(e);
        try json.endArray();
    }

    try json.endObject(); // params
    try json.endObject(); // root

    return out.written();
}

/// Send `request` (followed by a newline) to the control socket and return the
/// full response bytes. `half_close` shuts the write side after sending, which
/// is correct for single-shot requests but must be false for `wait` (the server
/// watches for an orderly client disconnect while it blocks).
fn sendRequest(
    alloc: Allocator,
    socket_path: []const u8,
    request: []const u8,
    half_close: bool,
) ![]u8 {
    if (socket_path.len >= 104) return error.PathTooLong;

    const fd = c.socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return error.SocketFailed;
    defer _ = c.close(fd);

    var addr: std.posix.sockaddr.un = .{ .family = AF_UNIX, .path = undefined };
    @memset(&addr.path, 0);
    @memcpy(addr.path[0..socket_path.len], socket_path);

    if (c.connect(fd, @ptrCast(&addr), @sizeOf(std.posix.sockaddr.un)) != 0) {
        return error.ConnectFailed;
    }

    try writeAll(fd, request);
    try writeAll(fd, "\n");
    if (half_close) _ = c.shutdown(fd, SHUT_WR);

    var response: std.ArrayList(u8) = .empty;
    errdefer response.deinit(alloc);
    var buf: [4096]u8 = undefined;
    while (true) {
        const n = c.read(fd, &buf, buf.len);
        if (n < 0) return error.ReadFailed;
        if (n == 0) break;
        try response.appendSlice(alloc, buf[0..@intCast(n)]);
        if (response.items.len > 8 * 1024 * 1024) return error.ResponseTooLarge;
    }

    return response.toOwnedSlice(alloc);
}

/// Connect, send `request`, and stream the server's newline-delimited messages
/// straight to stdout until the connection closes. Used by `watch`; the write
/// side stays open so the server keeps the stream alive until the session ends
/// or we disconnect by closing the fd.
///
/// Returns the process exit code. A successful watch begins with a stream
/// message (`{"type":"snapshot",...}`, no `ok` field) and returns 0 once the
/// stream ends. But `watch` startup is enforced like any other request: if the
/// server rejects it (policy deny, `not_found`, `invalid_request`,
/// `confirmation_required`, …) it sends a single `{"ok":false,...}` error
/// envelope, which we detect on the first line and map to the same stable exit
/// code as single-shot requests — so automation never reads a denied/bad watch
/// as a clean start.
fn streamResponse(alloc: Allocator, socket_path: []const u8, request: []const u8) !u8 {
    if (socket_path.len >= 104) return error.PathTooLong;

    const fd = c.socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return error.SocketFailed;
    defer _ = c.close(fd);

    var addr: std.posix.sockaddr.un = .{ .family = AF_UNIX, .path = undefined };
    @memset(&addr.path, 0);
    @memcpy(addr.path[0..socket_path.len], socket_path);

    if (c.connect(fd, @ptrCast(&addr), @sizeOf(std.posix.sockaddr.un)) != 0) {
        return error.ConnectFailed;
    }

    try writeAll(fd, request);
    try writeAll(fd, "\n");

    var out_buf: [4096]u8 = undefined;
    var stdout_writer = std.fs.File.stdout().writer(&out_buf);
    const stdout = &stdout_writer.interface;

    // Buffer bytes until the first newline so we can classify the opening
    // message before forwarding the rest of the stream verbatim.
    var pending: std.ArrayList(u8) = .empty;
    defer pending.deinit(alloc);
    var checked = false;

    var buf: [4096]u8 = undefined;
    while (true) {
        const n = c.read(fd, &buf, buf.len);
        if (n < 0) return error.ReadFailed;
        if (n == 0) break;
        const chunk = buf[0..@intCast(n)];

        if (checked) {
            try stdout.writeAll(chunk);
            try stdout.flush();
            continue;
        }

        try pending.appendSlice(alloc, chunk);
        const newline = std.mem.indexOfScalar(u8, pending.items, '\n') orelse continue;

        checked = true;
        try stdout.writeAll(pending.items);
        try stdout.flush();
        if (firstLineIsError(alloc, pending.items[0..newline])) {
            return exitCode(alloc, pending.items[0..newline], .watch);
        }
        pending.clearRetainingCapacity();
    }

    // The connection closed before a full first line (defensive): flush what we
    // have and, if it is an error envelope, surface its exit code.
    if (!checked and pending.items.len > 0) {
        try stdout.writeAll(pending.items);
        try stdout.flush();
        if (firstLineIsError(alloc, pending.items)) {
            return exitCode(alloc, pending.items, .watch);
        }
    }
    return 0;
}

/// True if `line` is a control *response* envelope reporting failure
/// (`{"ok":false,...}`). A successful `watch` stream never sends an `ok`
/// envelope — it opens with a stream message (`{"type":...}`) — so this cleanly
/// distinguishes a rejected watch startup from a normal stream.
fn firstLineIsError(alloc: Allocator, line: []const u8) bool {
    const trimmed = std.mem.trim(u8, line, &std.ascii.whitespace);
    const parsed = std.json.parseFromSlice(std.json.Value, alloc, trimmed, .{}) catch return false;
    defer parsed.deinit();
    if (parsed.value != .object) return false;
    const ok = parsed.value.object.get("ok") orelse return false;
    return ok == .bool and !ok.bool;
}

fn writeAll(fd: c_int, bytes: []const u8) !void {
    var written: usize = 0;
    while (written < bytes.len) {
        const n = c.write(fd, bytes.ptr + written, bytes.len - written);
        if (n <= 0) return error.WriteFailed;
        written += @intCast(n);
    }
}

/// Returns true if the JSON response has `"ok": true`.
fn responseOk(alloc: Allocator, response: []const u8) bool {
    const parsed = std.json.parseFromSlice(std.json.Value, alloc, response, .{}) catch return false;
    defer parsed.deinit();
    if (parsed.value != .object) return false;
    const ok = parsed.value.object.get("ok") orelse return false;
    return ok == .bool and ok.bool;
}

test "parseCommand create with flags" {
    const testing = std.testing;
    var arena = ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var iter = try std.process.ArgIteratorGeneral(.{}).init(
        alloc,
        "sessions create --title Release --cwd=/tmp --command \"zig build\" --metadata workflow=release --metadata request_id=abc --env FOO=bar",
    );
    defer iter.deinit();

    const cmd = try parseCommand(alloc, &iter);
    try testing.expect(cmd.verb == .create);
    try testing.expectEqualStrings("Release", cmd.title.?);
    try testing.expectEqualStrings("/tmp", cmd.cwd.?);
    try testing.expectEqualStrings("zig build", cmd.command.?);
    try testing.expectEqual(@as(usize, 2), cmd.metadata.items.len);
    try testing.expectEqualStrings("workflow", cmd.metadata.items[0][0]);
    try testing.expectEqualStrings("release", cmd.metadata.items[0][1]);
    try testing.expectEqualStrings("request_id", cmd.metadata.items[1][0]);
    try testing.expectEqual(@as(usize, 1), cmd.env.items.len);
    try testing.expectEqualStrings("FOO=bar", cmd.env.items[0]);
}

test "parseCommand tolerates leading action token" {
    const testing = std.testing;
    var arena = ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var iter = try std.process.ArgIteratorGeneral(.{}).init(alloc, "+control sessions list");
    defer iter.deinit();

    const cmd = try parseCommand(alloc, &iter);
    try testing.expect(cmd.verb == .list);
}

test "parseCommand get with positional id" {
    const testing = std.testing;
    var arena = ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var iter = try std.process.ArgIteratorGeneral(.{}).init(alloc, "sessions get ABC-123");
    defer iter.deinit();

    const cmd = try parseCommand(alloc, &iter);
    try testing.expect(cmd.verb == .get);
    try testing.expectEqualStrings("ABC-123", cmd.id.?);
}

test "parseCommand unknown verb" {
    const testing = std.testing;
    var arena = ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var iter = try std.process.ArgIteratorGeneral(.{}).init(alloc, "sessions frobnicate");
    defer iter.deinit();

    try testing.expectError(error.UnknownVerb, parseCommand(alloc, &iter));
}

test "buildRequest create includes method, token, metadata" {
    const testing = std.testing;
    var arena = ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var cmd: Command = .{ .verb = .create, .title = "Run checks", .command = "ls" };
    try cmd.metadata.append(alloc, .{ "workflow", "release" });

    const json = try buildRequest(alloc, cmd, "secret-token");

    // Round-trip parse and assert structure.
    const parsed = try std.json.parseFromSlice(std.json.Value, alloc, json, .{});
    defer parsed.deinit();
    const root = parsed.value.object;
    try testing.expectEqualStrings("secret-token", root.get("token").?.string);
    try testing.expectEqualStrings("sessions.create", root.get("method").?.string);
    const params = root.get("params").?.object;
    try testing.expectEqualStrings("Run checks", params.get("title").?.string);
    try testing.expectEqualStrings("ls", params.get("command").?.string);
    try testing.expectEqualStrings("release", params.get("metadata").?.object.get("workflow").?.string);
}

test "buildRequest cancel maps to sessions.action with cancel" {
    const testing = std.testing;
    var arena = ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const cmd: Command = .{ .verb = .cancel, .id = "id-1" };
    const json = try buildRequest(alloc, cmd, "tok");

    const parsed = try std.json.parseFromSlice(std.json.Value, alloc, json, .{});
    defer parsed.deinit();
    const root = parsed.value.object;
    try testing.expectEqualStrings("sessions.action", root.get("method").?.string);
    const params = root.get("params").?.object;
    try testing.expectEqualStrings("id-1", params.get("id").?.string);
    try testing.expectEqualStrings("cancel", params.get("action").?.string);
}

test "responseOk parses ok flag" {
    const testing = std.testing;
    try testing.expect(responseOk(testing.allocator, "{\"ok\":true}"));
    try testing.expect(!responseOk(testing.allocator, "{\"ok\":false}"));
    try testing.expect(!responseOk(testing.allocator, "not json"));
}

test "parseCommand declare-state with flags" {
    const testing = std.testing;
    var arena = ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var iter = try std.process.ArgIteratorGeneral(.{}).init(
        alloc,
        "sessions declare-state ID-1 --state tests:passed --message \"all green\" --source agent-a",
    );
    defer iter.deinit();

    const cmd = try parseCommand(alloc, &iter);
    try testing.expect(cmd.verb == .@"declare-state");
    try testing.expectEqualStrings("ID-1", cmd.id.?);
    try testing.expectEqualStrings("tests:passed", cmd.state.?);
    try testing.expectEqualStrings("all green", cmd.message.?);
    try testing.expectEqualStrings("agent-a", cmd.source.?);
    try testing.expectEqualStrings("sessions.declare-state", cmd.method());
}

test "parseCommand set-state with flags" {
    const testing = std.testing;
    var arena = ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var iter = try std.process.ArgIteratorGeneral(.{}).init(
        alloc,
        "sessions set-state ID-1 --state needsInput --source release-agent",
    );
    defer iter.deinit();

    const cmd = try parseCommand(alloc, &iter);
    try testing.expect(cmd.verb == .@"set-state");
    try testing.expectEqualStrings("ID-1", cmd.id.?);
    try testing.expectEqualStrings("needsInput", cmd.state.?);
    try testing.expectEqualStrings("release-agent", cmd.source.?);
    try testing.expectEqualStrings("sessions.set-state", cmd.method());
}

test "buildRequest set-summary includes summary" {
    const testing = std.testing;
    var arena = ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const cmd: Command = .{
        .verb = .@"set-summary",
        .id = "id-1",
        .summary = "Waiting on user confirmation for release notes wording.",
    };
    const json = try buildRequest(alloc, cmd, "tok");

    const parsed = try std.json.parseFromSlice(std.json.Value, alloc, json, .{});
    defer parsed.deinit();
    const root = parsed.value.object;
    try testing.expectEqualStrings("sessions.set-summary", root.get("method").?.string);
    const params = root.get("params").?.object;
    try testing.expectEqualStrings(
        "Waiting on user confirmation for release notes wording.",
        params.get("summary").?.string,
    );
}

test "parseCommand set-agent-type with flags" {
    const testing = std.testing;
    var arena = ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var iter = try std.process.ArgIteratorGeneral(.{}).init(
        alloc,
        "sessions set-agent-type ID-5 --agent-type claude-code --source release-agent",
    );
    defer iter.deinit();

    const cmd = try parseCommand(alloc, &iter);
    try testing.expect(cmd.verb == .@"set-agent-type");
    try testing.expectEqualStrings("ID-5", cmd.id.?);
    try testing.expectEqualStrings("claude-code", cmd.agent_type.?);
    try testing.expectEqualStrings("release-agent", cmd.source.?);
    try testing.expectEqualStrings("sessions.set-agent-type", cmd.method());
}

test "buildRequest set-agent-type includes agent_type" {
    const testing = std.testing;
    var arena = ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const cmd: Command = .{
        .verb = .@"set-agent-type",
        .id = "id-5",
        .agent_type = "codex",
    };
    const json = try buildRequest(alloc, cmd, "tok");

    const parsed = try std.json.parseFromSlice(std.json.Value, alloc, json, .{});
    defer parsed.deinit();
    const root = parsed.value.object;
    try testing.expectEqualStrings("sessions.set-agent-type", root.get("method").?.string);
    const params = root.get("params").?.object;
    try testing.expectEqualStrings("codex", params.get("agent_type").?.string);
}

test "buildRequest create includes agent_type and parent" {
    const testing = std.testing;
    var arena = ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const cmd: Command = .{
        .verb = .create,
        .agent_type = "claude-code",
        .parent = "PARENT-1",
    };
    const json = try buildRequest(alloc, cmd, "tok");

    const parsed = try std.json.parseFromSlice(std.json.Value, alloc, json, .{});
    defer parsed.deinit();
    const root = parsed.value.object;
    try testing.expectEqualStrings("sessions.create", root.get("method").?.string);
    const params = root.get("params").?.object;
    try testing.expectEqualStrings("claude-code", params.get("agent_type").?.string);
    try testing.expectEqualStrings("PARENT-1", params.get("parent").?.string);
}

test "parseCommand wait with state, timeout, since" {
    const testing = std.testing;
    var arena = ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var iter = try std.process.ArgIteratorGeneral(.{}).init(
        alloc,
        "sessions wait ID-9 --state ready --timeout 2m --since 5",
    );
    defer iter.deinit();

    const cmd = try parseCommand(alloc, &iter);
    try testing.expect(cmd.verb == .wait);
    try testing.expectEqualStrings("ID-9", cmd.id.?);
    try testing.expectEqualStrings("ready", cmd.state.?);
    try testing.expectEqual(@as(u64, 120_000), cmd.timeout_ms.?);
    try testing.expectEqual(@as(i64, 5), cmd.since.?);
}

test "parseCommand watch and restart accept no-op flags" {
    const testing = std.testing;
    var arena = ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var w = try std.process.ArgIteratorGeneral(.{}).init(alloc, "sessions watch ID --json");
    defer w.deinit();
    const watch = try parseCommand(alloc, &w);
    try testing.expect(watch.verb == .watch);
    try testing.expectEqualStrings("ID", watch.id.?);

    var r = try std.process.ArgIteratorGeneral(.{}).init(alloc, "sessions restart ID --last-command");
    defer r.deinit();
    const restart = try parseCommand(alloc, &r);
    try testing.expect(restart.verb == .restart);
    try testing.expectEqualStrings("ID", restart.id.?);
}

test "parseDurationMs parses units" {
    const testing = std.testing;
    try testing.expectEqual(@as(?u64, 30_000), parseDurationMs("30"));
    try testing.expectEqual(@as(?u64, 500), parseDurationMs("500ms"));
    try testing.expectEqual(@as(?u64, 45_000), parseDurationMs("45s"));
    try testing.expectEqual(@as(?u64, 300_000), parseDurationMs("5m"));
    try testing.expectEqual(@as(?u64, 3_600_000), parseDurationMs("1h"));
    try testing.expectEqual(@as(?u64, null), parseDurationMs("abc"));
    try testing.expectEqual(@as(?u64, null), parseDurationMs("10x"));
    try testing.expectEqual(@as(?u64, null), parseDurationMs(""));
}

test "buildRequest emit-event includes event and payload_json" {
    const testing = std.testing;
    var arena = ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const cmd: Command = .{
        .verb = .@"emit-event",
        .id = "id-1",
        .event = "pr.opened",
        .payload_json = "{\"pr\":123}",
    };
    const json = try buildRequest(alloc, cmd, "tok");

    const parsed = try std.json.parseFromSlice(std.json.Value, alloc, json, .{});
    defer parsed.deinit();
    const root = parsed.value.object;
    try testing.expectEqualStrings("sessions.emit-event", root.get("method").?.string);
    const params = root.get("params").?.object;
    try testing.expectEqualStrings("pr.opened", params.get("event").?.string);
    // payload_json is carried as a JSON string for the server to parse.
    try testing.expectEqualStrings("{\"pr\":123}", params.get("payload_json").?.string);
}

test "buildRequest wait includes timeout_ms and lifecycle" {
    const testing = std.testing;
    var arena = ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const cmd: Command = .{
        .verb = .wait,
        .id = "id-1",
        .lifecycle = "exited",
        .timeout_ms = 1500,
        .since = 3,
    };
    const json = try buildRequest(alloc, cmd, "tok");

    const parsed = try std.json.parseFromSlice(std.json.Value, alloc, json, .{});
    defer parsed.deinit();
    const root = parsed.value.object;
    try testing.expectEqualStrings("sessions.wait", root.get("method").?.string);
    const params = root.get("params").?.object;
    try testing.expectEqualStrings("exited", params.get("lifecycle").?.string);
    try testing.expectEqual(@as(i64, 1500), params.get("timeout_ms").?.integer);
    try testing.expectEqual(@as(i64, 3), params.get("since").?.integer);
}

test "parseCommand stream watch with filters and since" {
    const testing = std.testing;
    var arena = ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var iter = try std.process.ArgIteratorGeneral(.{}).init(
        alloc,
        "stream watch --group release --tab TAB-1 --since 7 --json",
    );
    defer iter.deinit();

    const cmd = try parseCommand(alloc, &iter);
    try testing.expect(cmd.group == .stream);
    try testing.expect(cmd.verb == .watch);
    try testing.expectEqualStrings("release", cmd.group_name.?);
    try testing.expectEqualStrings("TAB-1", cmd.tab.?);
    try testing.expectEqual(@as(i64, 7), cmd.since.?);
    try testing.expectEqualStrings("stream.watch", cmd.method());
}

test "parseCommand stream watch carries policy --as caller" {
    const testing = std.testing;
    var arena = ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    // The MAX-11 policy flags coexist with the MAX-7 stream group/flags.
    var iter = try std.process.ArgIteratorGeneral(.{}).init(
        alloc,
        "stream watch --group release --as readonly-external",
    );
    defer iter.deinit();

    const cmd = try parseCommand(alloc, &iter);
    try testing.expect(cmd.group == .stream);
    try testing.expect(cmd.verb == .watch);
    try testing.expectEqualStrings("release", cmd.group_name.?);
    try testing.expectEqualStrings("readonly-external", cmd.caller.?);

    const json = try buildRequest(alloc, cmd, "tok");
    const parsed = try std.json.parseFromSlice(std.json.Value, alloc, json, .{});
    defer parsed.deinit();
    const params = parsed.value.object.get("params").?.object;
    try testing.expectEqualStrings("release", params.get("group").?.string);
    try testing.expectEqualStrings("readonly-external", params.get("caller").?.string);
}

test "parseCommand stream wait group --all" {
    const testing = std.testing;
    var arena = ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var iter = try std.process.ArgIteratorGeneral(.{}).init(
        alloc,
        "stream wait --group release --all declared:complete --timeout 5m",
    );
    defer iter.deinit();

    const cmd = try parseCommand(alloc, &iter);
    try testing.expect(cmd.group == .stream);
    try testing.expect(cmd.verb == .wait);
    try testing.expectEqualStrings("release", cmd.group_name.?);
    try testing.expectEqualStrings("declared:complete", cmd.all.?);
    try testing.expectEqual(@as(u64, 300_000), cmd.timeout_ms.?);
    try testing.expectEqualStrings("stream.wait", cmd.method());
}

test "buildRequest stream watch carries filters and since" {
    const testing = std.testing;
    var arena = ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const cmd: Command = .{
        .group = .stream,
        .verb = .watch,
        .group_name = "release",
        .since = 12,
    };
    const json = try buildRequest(alloc, cmd, "tok");

    const parsed = try std.json.parseFromSlice(std.json.Value, alloc, json, .{});
    defer parsed.deinit();
    const root = parsed.value.object;
    try testing.expectEqualStrings("stream.watch", root.get("method").?.string);
    const params = root.get("params").?.object;
    try testing.expectEqualStrings("release", params.get("group").?.string);
    try testing.expectEqual(@as(i64, 12), params.get("since").?.integer);
}

test "parseCommand event emit maps to sessions.emit-event" {
    const testing = std.testing;
    var arena = ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    // Use a quote-free payload: the test-only ArgIteratorGeneral strips double
    // quotes, but a real shell passes the JSON through to argv verbatim.
    var iter = try std.process.ArgIteratorGeneral(.{}).init(
        alloc,
        "event emit --session ID-1 --type declared.status --json [1,2,3]",
    );
    defer iter.deinit();

    const cmd = try parseCommand(alloc, &iter);
    try testing.expect(cmd.group == .event);
    try testing.expect(cmd.verb == .emit);
    try testing.expectEqualStrings("ID-1", cmd.id.?);
    try testing.expectEqualStrings("declared.status", cmd.event.?);
    try testing.expectEqualStrings("[1,2,3]", cmd.payload_json.?);
    try testing.expectEqualStrings("sessions.emit-event", cmd.method());
}

test "buildRequest event emit carries event and payload" {
    const testing = std.testing;
    var arena = ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const cmd: Command = .{
        .group = .event,
        .verb = .emit,
        .id = "ID-1",
        .event = "declared.status",
        .payload_json = "{\"step\":3}",
    };
    const json = try buildRequest(alloc, cmd, "tok");

    const parsed = try std.json.parseFromSlice(std.json.Value, alloc, json, .{});
    defer parsed.deinit();
    const root = parsed.value.object;
    try testing.expectEqualStrings("sessions.emit-event", root.get("method").?.string);
    const params = root.get("params").?.object;
    try testing.expectEqualStrings("declared.status", params.get("event").?.string);
    try testing.expectEqualStrings("{\"step\":3}", params.get("payload_json").?.string);
}

test "parseCommand set-group with group flag" {
    const testing = std.testing;
    var arena = ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var iter = try std.process.ArgIteratorGeneral(.{}).init(
        alloc,
        "sessions set-group ID-1 --group release",
    );
    defer iter.deinit();

    const cmd = try parseCommand(alloc, &iter);
    try testing.expect(cmd.group == .sessions);
    try testing.expect(cmd.verb == .@"set-group");
    try testing.expectEqualStrings("ID-1", cmd.id.?);
    try testing.expectEqualStrings("release", cmd.group_name.?);
    try testing.expectEqualStrings("sessions.set-group", cmd.method());
}

test "parseCommand set-parent with parent flag (MAX-6)" {
    const testing = std.testing;
    var arena = ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var iter = try std.process.ArgIteratorGeneral(.{}).init(
        alloc,
        "sessions set-parent CHILD-1 --parent PARENT-1",
    );
    defer iter.deinit();

    const cmd = try parseCommand(alloc, &iter);
    try testing.expect(cmd.group == .sessions);
    try testing.expect(cmd.verb == .@"set-parent");
    try testing.expectEqualStrings("CHILD-1", cmd.id.?);
    try testing.expectEqualStrings("PARENT-1", cmd.parent.?);
    try testing.expectEqualStrings("sessions.set-parent", cmd.method());
}

test "buildRequest set-parent emits id and parent (MAX-6)" {
    const testing = std.testing;
    var arena = ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const cmd: Command = .{
        .verb = .@"set-parent",
        .id = "CHILD-1",
        .parent = "PARENT-1",
    };
    const json = try buildRequest(alloc, cmd, "tok");

    const parsed = try std.json.parseFromSlice(std.json.Value, alloc, json, .{});
    defer parsed.deinit();
    const root = parsed.value.object;
    try testing.expectEqualStrings("sessions.set-parent", root.get("method").?.string);
    const params = root.get("params").?.object;
    try testing.expectEqualStrings("CHILD-1", params.get("id").?.string);
    try testing.expectEqualStrings("PARENT-1", params.get("parent").?.string);
}

test "buildRequest list emits parent and group query filters (MAX-6)" {
    const testing = std.testing;
    var arena = ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const cmd: Command = .{
        .verb = .list,
        .parent = "PARENT-1",
        .group_name = "release",
    };
    const json = try buildRequest(alloc, cmd, "tok");

    const parsed = try std.json.parseFromSlice(std.json.Value, alloc, json, .{});
    defer parsed.deinit();
    const root = parsed.value.object;
    try testing.expectEqualStrings("sessions.list", root.get("method").?.string);
    const params = root.get("params").?.object;
    try testing.expectEqualStrings("PARENT-1", params.get("parent").?.string);
    try testing.expectEqualStrings("release", params.get("group").?.string);
}

test "parseVerb rejects cross-group verbs" {
    const testing = std.testing;
    var arena = ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    // `stream create` is not a valid stream verb.
    var iter = try std.process.ArgIteratorGeneral(.{}).init(alloc, "stream create");
    defer iter.deinit();
    try testing.expectError(error.UnknownVerb, parseCommand(alloc, &iter));
}

test "exitCode maps wait outcomes and error codes" {
    const testing = std.testing;
    const a = testing.allocator;
    try testing.expectEqual(
        @as(u8, 0),
        exitCode(a, "{\"ok\":true,\"result\":{\"outcome\":\"matched\"}}", .wait),
    );
    try testing.expectEqual(
        @as(u8, 2),
        exitCode(a, "{\"ok\":true,\"result\":{\"outcome\":\"timeout\"}}", .wait),
    );
    try testing.expectEqual(
        @as(u8, 4),
        exitCode(a, "{\"ok\":true,\"result\":{\"outcome\":\"ended\"}}", .wait),
    );
    try testing.expectEqual(
        @as(u8, 3),
        exitCode(a, "{\"ok\":false,\"error\":{\"code\":\"not_found\"}}", .wait),
    );
    try testing.expectEqual(
        @as(u8, 5),
        exitCode(a, "{\"ok\":false,\"error\":{\"code\":\"unsupported\"}}", .restart),
    );
    // A plain successful response for a non-wait verb is exit 0.
    try testing.expectEqual(@as(u8, 0), exitCode(a, "{\"ok\":true,\"result\":{}}", .archive));
    // A generic error is exit 1.
    try testing.expectEqual(
        @as(u8, 1),
        exitCode(a, "{\"ok\":false,\"error\":{\"code\":\"invalid_request\"}}", .archive),
    );
    // An unknown action name is a usage error -> generic exit 1, not 5.
    try testing.expectEqual(
        @as(u8, 1),
        exitCode(a, "{\"ok\":false,\"error\":{\"code\":\"unsupported_action\"}}", .action),
    );
    // A confirmation-required response maps to its own exit code (6).
    try testing.expectEqual(
        @as(u8, 6),
        exitCode(a, "{\"ok\":false,\"error\":{\"code\":\"confirmation_required\"}}", .create),
    );
}

test "parseCommand action with --as caller and --confirm" {
    const testing = std.testing;
    var arena = ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var iter = try std.process.ArgIteratorGeneral(.{}).init(
        alloc,
        "sessions action ID-1 --action input --input hi --as local-prompt --confirm",
    );
    defer iter.deinit();

    const cmd = try parseCommand(alloc, &iter);
    try testing.expect(cmd.verb == .action);
    try testing.expectEqualStrings("ID-1", cmd.id.?);
    try testing.expectEqualStrings("input", cmd.action.?);
    try testing.expectEqualStrings("local-prompt", cmd.caller.?);
    try testing.expect(cmd.confirm);
}

test "buildRequest carries caller and confirm" {
    const testing = std.testing;
    var arena = ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const cmd: Command = .{
        .verb = .action,
        .id = "id-1",
        .action = "close",
        .caller = "readonly-external",
        .confirm = true,
    };
    const json = try buildRequest(alloc, cmd, "tok");

    const parsed = try std.json.parseFromSlice(std.json.Value, alloc, json, .{});
    defer parsed.deinit();
    const params = parsed.value.object.get("params").?.object;
    try testing.expectEqualStrings("readonly-external", params.get("caller").?.string);
    try testing.expectEqual(true, params.get("confirm").?.bool);
}

test "parseCommand policy check with capability and source" {
    const testing = std.testing;
    var arena = ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var iter = try std.process.ArgIteratorGeneral(.{}).init(
        alloc,
        "policy check --as readonly-external --capability tabs:close --id ID-7",
    );
    defer iter.deinit();

    const cmd = try parseCommand(alloc, &iter);
    try testing.expect(cmd.verb == .@"policy-check");
    try testing.expectEqualStrings("policy.check", cmd.method());
    try testing.expectEqualStrings("readonly-external", cmd.caller.?);
    try testing.expectEqualStrings("tabs:close", cmd.capability.?);
    try testing.expectEqualStrings("ID-7", cmd.id.?);
}

test "buildRequest policy check includes capability" {
    const testing = std.testing;
    var arena = ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const cmd: Command = .{
        .group = .policy,
        .verb = .@"policy-check",
        .caller = "trusted-automation",
        .capability = "output:read",
    };
    const json = try buildRequest(alloc, cmd, "tok");

    const parsed = try std.json.parseFromSlice(std.json.Value, alloc, json, .{});
    defer parsed.deinit();
    const root = parsed.value.object;
    try testing.expectEqualStrings("policy.check", root.get("method").?.string);
    const params = root.get("params").?.object;
    try testing.expectEqualStrings("trusted-automation", params.get("caller").?.string);
    try testing.expectEqualStrings("output:read", params.get("capability").?.string);
}

test "parseCommand policy with unknown verb errors" {
    const testing = std.testing;
    var arena = ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var iter = try std.process.ArgIteratorGeneral(.{}).init(alloc, "policy frobnicate");
    defer iter.deinit();
    try testing.expectError(error.UnknownVerb, parseCommand(alloc, &iter));
}

test "firstLineIsError distinguishes error envelopes from stream messages" {
    const testing = std.testing;
    const a = testing.allocator;
    // Error response envelopes (a rejected watch startup).
    try testing.expect(firstLineIsError(a, "{\"ok\":false,\"error\":{\"code\":\"unauthorized\"}}"));
    try testing.expect(firstLineIsError(a, "{\"ok\":false,\"error\":{\"code\":\"not_found\"}}"));
    try testing.expect(firstLineIsError(a, "{\"ok\":false,\"error\":{\"code\":\"confirmation_required\"}}\n"));
    // A successful watch opens with a stream message (no `ok` field).
    try testing.expect(!firstLineIsError(a, "{\"type\":\"snapshot\",\"lifecycle\":\"running\"}"));
    // A success envelope is not an error, and neither is garbage.
    try testing.expect(!firstLineIsError(a, "{\"ok\":true,\"result\":{}}"));
    try testing.expect(!firstLineIsError(a, "not json"));
}

test "exitCode maps watch startup error responses" {
    const testing = std.testing;
    const a = testing.allocator;
    // A denied/bad watch startup must map to the same stable codes as a
    // single-shot request, not exit 0.
    try testing.expectEqual(
        @as(u8, 1),
        exitCode(a, "{\"ok\":false,\"error\":{\"code\":\"unauthorized\"}}", .watch),
    );
    try testing.expectEqual(
        @as(u8, 3),
        exitCode(a, "{\"ok\":false,\"error\":{\"code\":\"not_found\"}}", .watch),
    );
    try testing.expectEqual(
        @as(u8, 6),
        exitCode(a, "{\"ok\":false,\"error\":{\"code\":\"confirmation_required\"}}", .watch),
    );
}

// MARK: - MAX-4 agent-reported metadata

test "parseCommand set-metadata with value-json" {
    const testing = std.testing;
    var arena = ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    // Note: ArgIteratorGeneral consumes shell quotes, so use a quote-free JSON
    // value here; the quoted-string case is covered by the buildRequest test.
    var iter = try std.process.ArgIteratorGeneral(.{}).init(
        alloc,
        "sessions set-metadata ID-1 --key run.attempts --value-json [1,2,3]",
    );
    defer iter.deinit();

    const cmd = try parseCommand(alloc, &iter);
    try testing.expect(cmd.verb == .@"set-metadata");
    try testing.expectEqualStrings("ID-1", cmd.id.?);
    try testing.expectEqualStrings("run.attempts", cmd.key.?);
    try testing.expectEqualStrings("[1,2,3]", cmd.value_json.?);
    try testing.expectEqualStrings("sessions.set-metadata", cmd.method());
}

test "buildRequest set-metadata emits value_json" {
    const testing = std.testing;
    var arena = ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const cmd: Command = .{
        .verb = .@"set-metadata",
        .id = "id-1",
        .key = "pr.url",
        .value_json = "\"https://example.com/pr/1\"",
    };
    const json = try buildRequest(alloc, cmd, "tok");

    const parsed = try std.json.parseFromSlice(std.json.Value, alloc, json, .{});
    defer parsed.deinit();
    const root = parsed.value.object;
    try testing.expectEqualStrings("sessions.set-metadata", root.get("method").?.string);
    const params = root.get("params").?.object;
    try testing.expectEqualStrings("pr.url", params.get("key").?.string);
    try testing.expectEqualStrings(
        "\"https://example.com/pr/1\"",
        params.get("value_json").?.string,
    );
}

test "parseCommand remove-metadata collects repeated keys" {
    const testing = std.testing;
    var arena = ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var iter = try std.process.ArgIteratorGeneral(.{}).init(
        alloc,
        "sessions remove-metadata ID-9 --key repo --key branch",
    );
    defer iter.deinit();

    const cmd = try parseCommand(alloc, &iter);
    try testing.expect(cmd.verb == .@"remove-metadata");
    try testing.expectEqualStrings("ID-9", cmd.id.?);
    try testing.expectEqual(@as(usize, 2), cmd.keys.items.len);
    try testing.expectEqualStrings("repo", cmd.keys.items[0]);
    try testing.expectEqualStrings("branch", cmd.keys.items[1]);
    try testing.expectEqualStrings("sessions.remove-metadata", cmd.method());
}

test "buildRequest remove-metadata emits keys array, not scalar key" {
    const testing = std.testing;
    var arena = ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var cmd: Command = .{ .verb = .@"remove-metadata", .id = "id-1", .key = "branch" };
    try cmd.keys.append(alloc, "repo");
    try cmd.keys.append(alloc, "branch");
    const json = try buildRequest(alloc, cmd, "tok");

    const parsed = try std.json.parseFromSlice(std.json.Value, alloc, json, .{});
    defer parsed.deinit();
    const root = parsed.value.object;
    try testing.expectEqualStrings("sessions.remove-metadata", root.get("method").?.string);
    const params = root.get("params").?.object;
    // The scalar `key` is omitted for remove-metadata; only `keys` is sent.
    try testing.expect(params.get("key") == null);
    const keys = params.get("keys").?.array;
    try testing.expectEqual(@as(usize, 2), keys.items.len);
    try testing.expectEqualStrings("repo", keys.items[0].string);
    try testing.expectEqualStrings("branch", keys.items[1].string);
}

test "parseCommand clear-metadata" {
    const testing = std.testing;
    var arena = ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var iter = try std.process.ArgIteratorGeneral(.{}).init(alloc, "sessions clear-metadata ID-2");
    defer iter.deinit();

    const cmd = try parseCommand(alloc, &iter);
    try testing.expect(cmd.verb == .@"clear-metadata");
    try testing.expectEqualStrings("ID-2", cmd.id.?);
    try testing.expectEqualStrings("sessions.clear-metadata", cmd.method());
}

test "parseCommand list with metadata filters" {
    const testing = std.testing;
    var arena = ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var iter = try std.process.ArgIteratorGeneral(.{}).init(
        alloc,
        "sessions list --filter repo=org/repo --filter linear.issue",
    );
    defer iter.deinit();

    const cmd = try parseCommand(alloc, &iter);
    try testing.expect(cmd.verb == .list);
    try testing.expectEqual(@as(usize, 2), cmd.filters.items.len);
    try testing.expectEqualStrings("repo", cmd.filters.items[0].key);
    try testing.expectEqualStrings("org/repo", cmd.filters.items[0].value.?);
    try testing.expectEqualStrings("linear.issue", cmd.filters.items[1].key);
    try testing.expect(cmd.filters.items[1].value == null);
}

test "buildRequest list emits metadata_filter array" {
    const testing = std.testing;
    var arena = ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var cmd: Command = .{ .verb = .list };
    try cmd.filters.append(alloc, .{ .key = "repo", .value = "org/repo" });
    try cmd.filters.append(alloc, .{ .key = "branch", .value = null });
    const json = try buildRequest(alloc, cmd, "tok");

    const parsed = try std.json.parseFromSlice(std.json.Value, alloc, json, .{});
    defer parsed.deinit();
    const params = parsed.value.object.get("params").?.object;
    const filters = params.get("metadata_filter").?.array;
    try testing.expectEqual(@as(usize, 2), filters.items.len);
    try testing.expectEqualStrings("repo", filters.items[0].object.get("key").?.string);
    try testing.expectEqualStrings("org/repo", filters.items[0].object.get("value").?.string);
    try testing.expectEqualStrings("branch", filters.items[1].object.get("key").?.string);
    // A key-only filter omits `value`.
    try testing.expect(filters.items[1].object.get("value") == null);
}

test "parseCommand filter rejects empty key" {
    const testing = std.testing;
    var arena = ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var iter = try std.process.ArgIteratorGeneral(.{}).init(alloc, "sessions list --filter =value");
    defer iter.deinit();

    try testing.expectError(error.InvalidFilter, parseCommand(alloc, &iter));
}
