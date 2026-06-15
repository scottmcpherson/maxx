const std = @import("std");
const Allocator = std.mem.Allocator;
const ArenaAllocator = std.heap.ArenaAllocator;
const Action = @import("../cli.zig").ghostty.Action;
const args = @import("args.zig");
const connector = @import("../connector/connector.zig");
const control_client = @import("control_client.zig");
const runner = @import("../runner/runner.zig");

const Template = connector.Template;
const DedupStore = runner.DedupStore;

const log = std.log.scoped(.runner_cli);

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
    run,
    poll,
    @"list-seen",
};

const ParseError = error{
    MissingVerb,
    UnknownVerb,
    MissingValue,
    UnknownFlag,
    InvalidPromptDelivery,
    InvalidTriggerType,
    InvalidEnv,
    InvalidFireOn,
    HelpRequested,
} || Allocator.Error;

fn isHelpFlag(arg: []const u8) bool {
    return std.mem.eql(u8, arg, "--help") or std.mem.eql(u8, arg, "-h");
}

/// A parsed `maxx +runner ...` invocation.
const Command = struct {
    verb: Verb,
    source: ?[]const u8 = null,
    command: ?[]const u8 = null,
    cwd: ?[]const u8 = null,
    title: ?[]const u8 = null,
    payload: ?[]const u8 = null,
    caller: ?[]const u8 = null,
    group: ?[]const u8 = null,
    prompt_delivery: Template.PromptDelivery = .env,
    trigger: ?[]const u8 = null,
    trigger_type: ?runner.TriggerType = null,
    received_at: ?[]const u8 = null,
    dedup_key: ?[]const u8 = null,
    state_file: ?[]const u8 = null,
    // poll-only.
    check: ?[]const u8 = null,
    check_cwd: ?[]const u8 = null,
    fire_on: std.ArrayList(u8) = .empty,
    no_dedup: bool = false,
    dry_run: bool = false,
    json: bool = false,
    env: std.ArrayList(Template.EnvEntry) = .empty,
};

/// The `+runner` action is the automation trigger runner: it receives a
/// structured trigger event, resolves the configured action, suppresses
/// duplicates, and launches a visible Maxx tab through the Control API — keeping
/// Maxx the visible runtime/control plane, never the workflow brain.
///
/// Where `+connector resolve` only *resolves* a payload into a `sessions.create`
/// request, `+runner` *executes* it: it injects the capability token, sends the
/// request to the running Maxx, delivers the prompt out of band for
/// `stdin`/`file` delivery, and records the firing for duplicate suppression and
/// visibility. The launched tab is a normal visible Maxx tab — inspect, stop, or
/// restart it with the usual tab/session controls.
///
/// Maxx assigns no workflow meaning to a trigger. The trigger type
/// (`poll`/`script`/`webhook_relay`) and the event fields are explicit data; the
/// runner never scrapes terminal output or guesses intent from process names,
/// branch names, paths, tab titles, or idle time.
///
/// Subcommands:
///
///   * `run`: dispatch one event from a payload your script or local webhook
///     relay supplies. Reads the payload from `--payload <file>` (or stdin when
///     omitted / `-`), parses it with `--source`, resolves the launch, and sends
///     it. Flags: `--source linear|github` (required), `--command <cmd>`
///     (required; `${field}` placeholders), `--cwd`, `--title`, repeatable
///     `--env KEY=VALUE`, `--prompt-delivery env|stdin|file`, `--as <source>`
///     (policy caller), `--group <label>` (templated), `--trigger <name>`
///     (display name; defaults to the source), `--trigger-type script|webhook_relay`
///     (default `script`), `--dedup-key <key>` (override the dedup key; defaults
///     to the adapter event id), `--no-dedup`, `--state-file <path>`,
///     `--received-at <iso8601>`, `--dry-run`, and `--json`.
///
///   * `poll`: run a configured check and fire only when it exits with a
///     configured code. The check's stdout is the event payload. Flags: `--check
///     <shell-command>` (required), `--fire-on <code[,code...]>` (default `0`),
///     `--check-cwd <path>`, plus all the `run` action/resolve flags. The check's
///     output is never parsed for meaning — only its exit code decides whether to
///     fire.
///
///   * `list-seen`: print the recorded duplicate-suppression entries as JSON.
///     Flags: `--state-file <path>`.
///
/// Duplicate suppression keys on the explicit adapter event id (or `--dedup-key`).
/// When a source emits stable ids/cursors, suppression is exact; when it does
/// not, the runner acts once per id (documented best-effort, never a guess).
///
/// A flag value that begins with `+` must be written as `--flag=value`: a bare
/// `+...` token is otherwise consumed by Maxx's `+action` CLI detection.
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
            try stderr.print("error: unknown subcommand. Try: run, poll, list-seen\n", .{});
            return 1;
        },
        error.MissingValue => {
            try stderr.print("error: a flag is missing its value\n", .{});
            return 1;
        },
        error.InvalidPromptDelivery => {
            try stderr.print("error: --prompt-delivery expects env, stdin, or file\n", .{});
            return 1;
        },
        error.InvalidTriggerType => {
            try stderr.print("error: --trigger-type expects script or webhook_relay\n", .{});
            return 1;
        },
        error.InvalidEnv => {
            try stderr.print("error: --env expects KEY=VALUE\n", .{});
            return 1;
        },
        error.InvalidFireOn => {
            try stderr.print("error: --fire-on expects exit codes like 0 or 0,3\n", .{});
            return 1;
        },
        error.UnknownFlag => {
            try stderr.print("error: unknown flag\n", .{});
            return 1;
        },
        else => return err,
    };

    return switch (cmd.verb) {
        .run => try runDispatch(arena_alloc, cmd, .{ .poll = false }, stderr),
        .poll => try runDispatch(arena_alloc, cmd, .{ .poll = true }, stderr),
        .@"list-seen" => try runListSeen(arena_alloc, cmd, stderr),
    };
}

const Mode = struct { poll: bool };

fn runDispatch(alloc: Allocator, cmd: Command, mode: Mode, stderr: *std.io.Writer) !u8 {
    const source = cmd.source orelse {
        try stderr.print("error: requires --source (linear or github)\n", .{});
        return 1;
    };
    const command = cmd.command orelse {
        try stderr.print("error: requires --command\n", .{});
        return 1;
    };
    const adapter = connector.adapterByName(source) orelse {
        try stderr.print("error: unknown connector source '{s}'\n", .{source});
        return 1;
    };

    // Obtain the payload. For poll, run the check and use its stdout; otherwise
    // read the supplied payload (file or stdin).
    var trigger_type: runner.TriggerType = undefined;
    const payload: []const u8 = blk: {
        if (mode.poll) {
            trigger_type = .poll;
            const check = cmd.check orelse {
                try stderr.print("error: poll requires --check\n", .{});
                return 1;
            };
            const fire_on: []const u8 = if (cmd.fire_on.items.len > 0) cmd.fire_on.items else &.{0};
            const argv = runner.poll.shellArgv(check);
            const outcome = runner.poll.runCheck(
                alloc,
                &argv,
                cmd.check_cwd,
                .{ .fire_on = fire_on },
                runner.poll.default_max_output,
            ) catch |err| switch (err) {
                error.SpawnFailed => {
                    try stderr.print("error: could not run check command\n", .{});
                    return 1;
                },
                error.AbnormalExit => {
                    try stderr.print("error: check command did not exit normally\n", .{});
                    return 1;
                },
                error.OutOfMemory => return err,
            };
            switch (outcome) {
                .idle => |code| {
                    // The check did not fire: nothing to do, success.
                    try printIdle(alloc, cmd, source, code);
                    return 0;
                },
                .fired => |p| break :blk p,
            }
        } else {
            trigger_type = cmd.trigger_type orelse .script;
            break :blk readPayload(alloc, cmd.payload) catch |err| {
                const where = if (cmd.payload) |p|
                    try std.fmt.allocPrint(alloc, "file '{s}'", .{p})
                else
                    "stdin";
                try stderr.print("error: could not read payload from {s}: {}\n", .{ where, err });
                return 1;
            };
        }
    };

    const event = adapter.parse(alloc, payload) catch |err| {
        try stderr.print("error: {s} adapter could not parse payload: {s}\n", .{
            source,
            switch (err) {
                error.InvalidPayload => "payload is not a JSON object",
                error.MissingField => "a required field is missing",
                error.UnsupportedEventType => "the payload's event type is not supported",
                error.OutOfMemory => "out of memory",
            },
        });
        return 1;
    };

    const template: Template.LaunchTemplate = .{
        .command = command,
        .cwd = cmd.cwd,
        .title = cmd.title,
        .env = cmd.env.items,
        .prompt_delivery = cmd.prompt_delivery,
        .caller = cmd.caller,
        .group = cmd.group,
    };

    const received_at = cmd.received_at orelse try runner.nowIso(alloc);

    var diag: Template.Diagnostic = .{};
    const request = connector.resolve(alloc, template, event, .{
        .launched_at = received_at,
        .diag = &diag,
    }) catch |err| switch (err) {
        error.MissingField => {
            try stderr.print(
                "error: launch template references field '{s}' which the payload did not provide\n",
                .{diag.field},
            );
            return 1;
        },
        error.MalformedTemplate => {
            try stderr.print(
                "error: launch template has a malformed placeholder near '{s}'\n",
                .{diag.field},
            );
            return 1;
        },
        error.OutOfMemory => return err,
    };

    // Resolve the control directory once: it gives us the token, the socket, and
    // the default dedup state path. For --dry-run we never touch the socket or
    // the token, so a missing/unreachable app is fine.
    const dir = control_client.controlDir(alloc) catch |err| {
        try stderr.print("error: could not resolve control directory: {}\n", .{err});
        return 1;
    };

    // Open the dedup store (unless suppression is disabled).
    const state_path = cmd.state_file orelse try std.fmt.allocPrint(alloc, "{s}/runner-seen.json", .{dir});
    var store: ?DedupStore = if (cmd.no_dedup) null else try DedupStore.open(alloc, state_path);
    defer if (store) |*s| s.deinit();

    // For real runs we need the token; dry-run skips it.
    var token: []const u8 = "";
    var socket_path: []const u8 = "";
    if (!cmd.dry_run) {
        const token_path = try control_client.tokenPath(alloc, dir);
        token = control_client.readToken(alloc, token_path) catch {
            try stderr.print(
                "error: could not read control token at {s}\n" ++
                    "Is Maxx running? The control API is served by the running app.\n",
                .{token_path},
            );
            return 1;
        };
        socket_path = try control_client.socketPath(alloc, dir);
    }

    var sock = SocketSender{ .socket_path = socket_path };

    const trigger_name = cmd.trigger orelse source;
    const rec = try runner.dispatch(alloc, .{
        .trigger = trigger_name,
        .trigger_type = trigger_type,
        .event = event,
        .request = request,
        .token = token,
        .received_at = received_at,
        .dedup_key = cmd.dedup_key,
        .dedup = if (store) |*s| s else null,
        .prompt_dir = dir,
        .dry_run = cmd.dry_run,
    }, sock.sender());

    // Persist any newly-recorded dedup state and do best-effort housekeeping.
    // A dry-run never mutates on-disk state.
    if (!cmd.dry_run) {
        if (store) |*s| {
            // Time-bound retention before persisting, so the file stays bounded by
            // age as well as count. The store never reads the clock; we pass it.
            const cutoff_s = std.time.timestamp() - DedupStore.default_max_age_s;
            if (cutoff_s > 0) {
                var buf: [32]u8 = undefined;
                s.pruneOlderThan(runner.epochToIso(&buf, @intCast(cutoff_s)));
            }
            s.save() catch |err| switch (err) {
                error.ReadOnly => {}, // newer-schema file present; intentionally not overwritten
                else => log.warn("could not persist dedup state to {s}: {}", .{ state_path, err }),
            };
        }
        // Sweep prompt temp files left by previous `.file`-delivery runs.
        if (cmd.prompt_delivery == .file) {
            runner.sweepStalePromptFiles(dir, runner.default_prompt_file_ttl_s, std.time.timestamp());
        }
    }

    try printRecord(alloc, rec);

    return switch (rec.outcome) {
        .launched, .duplicate, .dry_run => 0,
        .failed => 1,
    };
}

fn runListSeen(alloc: Allocator, cmd: Command, stderr: *std.io.Writer) !u8 {
    const dir = control_client.controlDir(alloc) catch |err| {
        try stderr.print("error: could not resolve control directory: {}\n", .{err});
        return 1;
    };
    const state_path = cmd.state_file orelse try std.fmt.allocPrint(alloc, "{s}/runner-seen.json", .{dir});
    var store = try DedupStore.open(alloc, state_path);
    defer store.deinit();

    var out: std.io.Writer.Allocating = .init(alloc);
    var json: std.json.Stringify = .{ .writer = &out.writer, .options = .{ .whitespace = .indent_2 } };
    try json.beginArray();
    for (store.entries.items) |e| {
        try json.beginObject();
        try json.objectField("trigger");
        try json.write(e.trigger);
        try json.objectField("source");
        try json.write(e.source);
        try json.objectField("key");
        try json.write(e.key);
        try json.objectField("at");
        try json.write(e.at);
        try json.endObject();
    }
    try json.endArray();

    var out_buf: [4096]u8 = undefined;
    var stdout_writer = std.fs.File.stdout().writer(&out_buf);
    const stdout = &stdout_writer.interface;
    try stdout.writeAll(out.written());
    try stdout.writeAll("\n");
    try stdout.flush();
    return 0;
}

/// A `runner.Sender` backed by the real control Unix socket.
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

fn printRecord(alloc: Allocator, rec: runner.ActivityRecord) !void {
    var out: std.io.Writer.Allocating = .init(alloc);
    var json: std.json.Stringify = .{ .writer = &out.writer, .options = .{ .whitespace = .indent_2 } };
    try rec.writeJson(&json);

    var out_buf: [4096]u8 = undefined;
    var stdout_writer = std.fs.File.stdout().writer(&out_buf);
    const stdout = &stdout_writer.interface;
    try stdout.writeAll(out.written());
    try stdout.writeAll("\n");
    try stdout.flush();
}

/// Print a record for a poll check that did not fire (nothing launched).
fn printIdle(alloc: Allocator, cmd: Command, source: []const u8, code: u8) !void {
    var out: std.io.Writer.Allocating = .init(alloc);
    var json: std.json.Stringify = .{ .writer = &out.writer, .options = .{ .whitespace = .indent_2 } };
    try json.beginObject();
    try json.objectField("trigger");
    try json.write(cmd.trigger orelse source);
    try json.objectField("trigger_type");
    try json.write("poll");
    try json.objectField("outcome");
    try json.write("idle");
    try json.objectField("check_exit_code");
    try json.write(code);
    try json.endObject();

    var out_buf: [4096]u8 = undefined;
    var stdout_writer = std.fs.File.stdout().writer(&out_buf);
    const stdout = &stdout_writer.interface;
    try stdout.writeAll(out.written());
    try stdout.writeAll("\n");
    try stdout.flush();
}

/// Read the payload from `path` (a file, or stdin when null or "-").
fn readPayload(alloc: Allocator, path: ?[]const u8) ![]u8 {
    const max_bytes = 4 * 1024 * 1024;
    if (path == null or std.mem.eql(u8, path.?, "-")) {
        var stdin = std.fs.File.stdin();
        return try stdin.readToEndAlloc(alloc, max_bytes);
    }
    var file = try std.fs.cwd().openFile(path.?, .{});
    defer file.close();
    return try file.readToEndAlloc(alloc, max_bytes);
}

fn parseCommand(alloc: Allocator, iter: anytype) ParseError!Command {
    var first = iter.next() orelse return error.MissingVerb;

    if (std.mem.eql(u8, first, "+runner") or std.mem.eql(u8, first, "runner")) {
        first = iter.next() orelse return error.MissingVerb;
    }

    if (isHelpFlag(first)) return error.HelpRequested;
    const verb = std.meta.stringToEnum(Verb, first) orelse return error.UnknownVerb;

    var cmd: Command = .{ .verb = verb };
    while (iter.next()) |raw_arg| {
        const arg: []const u8 = raw_arg;
        if (isHelpFlag(arg)) {
            return error.HelpRequested;
        } else if (try flagValue(alloc, arg, iter, "--source")) |v| {
            cmd.source = v;
        } else if (try flagValue(alloc, arg, iter, "--command")) |v| {
            cmd.command = v;
        } else if (try flagValue(alloc, arg, iter, "--cwd")) |v| {
            cmd.cwd = v;
        } else if (try flagValue(alloc, arg, iter, "--title")) |v| {
            cmd.title = v;
        } else if (try flagValue(alloc, arg, iter, "--payload")) |v| {
            cmd.payload = v;
        } else if (try flagValue(alloc, arg, iter, "--as")) |v| {
            cmd.caller = v;
        } else if (try flagValue(alloc, arg, iter, "--group")) |v| {
            cmd.group = v;
        } else if (try flagValue(alloc, arg, iter, "--trigger")) |v| {
            cmd.trigger = v;
        } else if (try flagValue(alloc, arg, iter, "--trigger-type")) |v| {
            const t = std.meta.stringToEnum(runner.TriggerType, v) orelse return error.InvalidTriggerType;
            if (t == .poll) return error.InvalidTriggerType; // poll has its own verb
            cmd.trigger_type = t;
        } else if (try flagValue(alloc, arg, iter, "--received-at")) |v| {
            cmd.received_at = v;
        } else if (try flagValue(alloc, arg, iter, "--dedup-key")) |v| {
            cmd.dedup_key = v;
        } else if (try flagValue(alloc, arg, iter, "--state-file")) |v| {
            cmd.state_file = v;
        } else if (try flagValue(alloc, arg, iter, "--check")) |v| {
            cmd.check = v;
        } else if (try flagValue(alloc, arg, iter, "--check-cwd")) |v| {
            cmd.check_cwd = v;
        } else if (try flagValue(alloc, arg, iter, "--fire-on")) |v| {
            try parseFireOn(alloc, &cmd, v);
        } else if (try flagValue(alloc, arg, iter, "--prompt-delivery")) |v| {
            cmd.prompt_delivery = std.meta.stringToEnum(Template.PromptDelivery, v) orelse
                return error.InvalidPromptDelivery;
        } else if (try flagValue(alloc, arg, iter, "--env")) |v| {
            const eq = std.mem.indexOfScalar(u8, v, '=') orelse return error.InvalidEnv;
            if (eq == 0) return error.InvalidEnv;
            try cmd.env.append(alloc, .{ .key = v[0..eq], .value = v[eq + 1 ..] });
        } else if (std.mem.eql(u8, arg, "--no-dedup")) {
            cmd.no_dedup = true;
        } else if (std.mem.eql(u8, arg, "--dry-run")) {
            cmd.dry_run = true;
        } else if (std.mem.eql(u8, arg, "--json")) {
            cmd.json = true;
        } else {
            return error.UnknownFlag;
        }
    }

    return cmd;
}

fn parseFireOn(alloc: Allocator, cmd: *Command, v: []const u8) ParseError!void {
    var it = std.mem.splitScalar(u8, v, ',');
    while (it.next()) |part| {
        const trimmed = std.mem.trim(u8, part, &std.ascii.whitespace);
        if (trimmed.len == 0) continue;
        const code = std.fmt.parseInt(u8, trimmed, 10) catch return error.InvalidFireOn;
        try cmd.fire_on.append(alloc, code);
    }
    if (cmd.fire_on.items.len == 0) return error.InvalidFireOn;
}

/// If `arg` matches `name` (`--name=value` or `--name value`), return the value,
/// consuming the next token when needed. Dupes the value out of the iterator.
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

test "parseCommand run with flags" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var iter = try std.process.ArgIteratorGeneral(.{}).init(
        alloc,
        "runner run --source linear --command claude --trigger my-trigger --trigger-type webhook_relay --env A=B",
    );
    defer iter.deinit();

    const cmd = try parseCommand(alloc, &iter);
    try testing.expect(cmd.verb == .run);
    try testing.expectEqualStrings("linear", cmd.source.?);
    try testing.expectEqualStrings("claude", cmd.command.?);
    try testing.expectEqualStrings("my-trigger", cmd.trigger.?);
    try testing.expect(cmd.trigger_type.? == .webhook_relay);
    try testing.expectEqual(@as(usize, 1), cmd.env.items.len);
}

test "parseCommand poll with fire-on list" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var iter = try std.process.ArgIteratorGeneral(.{}).init(
        alloc,
        "runner poll --source github --command codex --check ./check.sh --fire-on 0,3 --dry-run",
    );
    defer iter.deinit();

    const cmd = try parseCommand(alloc, &iter);
    try testing.expect(cmd.verb == .poll);
    try testing.expectEqualStrings("./check.sh", cmd.check.?);
    try testing.expectEqual(@as(usize, 2), cmd.fire_on.items.len);
    try testing.expectEqual(@as(u8, 0), cmd.fire_on.items[0]);
    try testing.expectEqual(@as(u8, 3), cmd.fire_on.items[1]);
    try testing.expect(cmd.dry_run);
}

test "parseCommand rejects trigger-type poll for run" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var iter = try std.process.ArgIteratorGeneral(.{}).init(
        alloc,
        "runner run --trigger-type poll",
    );
    defer iter.deinit();
    try testing.expectError(error.InvalidTriggerType, parseCommand(alloc, &iter));
}

test "parseCommand rejects bad fire-on and unknown flag" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    {
        var iter = try std.process.ArgIteratorGeneral(.{}).init(alloc, "runner poll --fire-on abc");
        defer iter.deinit();
        try testing.expectError(error.InvalidFireOn, parseCommand(alloc, &iter));
    }
    {
        var iter = try std.process.ArgIteratorGeneral(.{}).init(alloc, "runner run --bogus");
        defer iter.deinit();
        try testing.expectError(error.UnknownFlag, parseCommand(alloc, &iter));
    }
}

test "parseCommand surfaces help and unknown verbs" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    {
        var iter = try std.process.ArgIteratorGeneral(.{}).init(alloc, "runner --help");
        defer iter.deinit();
        try testing.expectError(error.HelpRequested, parseCommand(alloc, &iter));
    }
    {
        var iter = try std.process.ArgIteratorGeneral(.{}).init(alloc, "runner frobnicate");
        defer iter.deinit();
        try testing.expectError(error.UnknownVerb, parseCommand(alloc, &iter));
    }
}
