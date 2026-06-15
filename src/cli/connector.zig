const std = @import("std");
const Allocator = std.mem.Allocator;
const ArenaAllocator = std.heap.ArenaAllocator;
const Action = @import("../cli.zig").ghostty.Action;
const args = @import("args.zig");
const connector = @import("../connector/connector.zig");

const Template = connector.Template;

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
    resolve,
    list,
};

const ParseError = error{
    MissingVerb,
    UnknownVerb,
    MissingValue,
    UnknownFlag,
    InvalidPromptDelivery,
    InvalidEnv,
    HelpRequested,
} || Allocator.Error;

fn isHelpFlag(arg: []const u8) bool {
    return std.mem.eql(u8, arg, "--help") or std.mem.eql(u8, arg, "-h");
}

/// A parsed `maxx +connector ...` invocation.
const Command = struct {
    verb: Verb,
    source: ?[]const u8 = null,
    payload: ?[]const u8 = null,
    command: ?[]const u8 = null,
    cwd: ?[]const u8 = null,
    title: ?[]const u8 = null,
    launched_at: ?[]const u8 = null,
    prompt_delivery: Template.PromptDelivery = .env,
    json: bool = false,
    env: std.ArrayList(Template.EnvEntry) = .empty,
};

/// The `+connector` action turns a structured external trigger payload into a
/// visible Maxx tab launch — without Maxx interpreting any workflow semantics.
///
/// A connector adapter (Linear or GitHub today) parses the payload into a
/// normalized event of *explicit* fields, then a launch template resolves the
/// command, working directory, title, environment, and provenance for a tab.
/// Maxx assigns no meaning to issue/PR/branch/worktree/test concepts: they are
/// just payload fields. Adapters never scrape terminal output or guess intent
/// from process names, branch names, paths, tab titles, or idle time.
///
/// Subcommands:
///
///   * `resolve`: parse a payload and print the resolve envelope — the
///     normalized event, the prompt and its delivery mode, and the
///     `sessions.create` control request — that a runner would consume (the
///     runner injects the capability token and, for stdin/file delivery, hands
///     the prompt to the command out of band). It does *not* launch the tab;
///     that runner step is intentionally separate. Flags:
///     `--source linear|github` (required), `--payload <file>` (a path, or `-`
///     / omitted to read stdin), `--command <cmd>` (required; supports
///     `${field}` placeholders), `--cwd <path>`, `--title <text>`, repeatable
///     `--env KEY=VALUE` (values support `${field}`), `--prompt-delivery
///     env|stdin|file`, `--launched-at <iso8601>`, and `--json`.
///
///   * `list`: list the available connector source adapters. Flags: `--json`.
///
/// `${field}` placeholders are filled only from explicit event fields:
/// `${source}`, `${id}`, `${type}`, `${title}`, `${url}`, `${prompt}`, plus
/// adapter-specific fields like `${issue.identifier}` or `${repo.full_name}`.
/// A `${name}` with no value is an error; `${name?}` is optional.
///
/// A flag value that begins with `+` (e.g. `--command +foo`) must be written as
/// `--flag=value` (`--command=+foo`): a bare `+...` token is otherwise consumed
/// by Maxx's `+action` CLI detection before this action sees it.
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
            try stderr.print("error: unknown subcommand. Try: resolve, list\n", .{});
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
        error.InvalidEnv => {
            try stderr.print("error: --env expects KEY=VALUE\n", .{});
            return 1;
        },
        error.UnknownFlag => {
            try stderr.print("error: unknown flag\n", .{});
            return 1;
        },
        else => return err,
    };

    return switch (cmd.verb) {
        .list => try runList(arena_alloc, cmd),
        .resolve => try runResolve(arena_alloc, cmd, stderr),
    };
}

fn runList(alloc: Allocator, cmd: Command) !u8 {
    var out_buf: [4096]u8 = undefined;
    var stdout_writer = std.fs.File.stdout().writer(&out_buf);
    const stdout = &stdout_writer.interface;
    defer stdout.flush() catch {};

    if (cmd.json) {
        var out: std.io.Writer.Allocating = .init(alloc);
        var json: std.json.Stringify = .{ .writer = &out.writer, .options = .{ .whitespace = .indent_2 } };
        try json.beginArray();
        for (connector.adapters) |a| {
            try json.beginObject();
            try json.objectField("name");
            try json.write(a.name);
            try json.objectField("description");
            try json.write(a.description);
            try json.endObject();
        }
        try json.endArray();
        try stdout.writeAll(out.written());
        try stdout.writeAll("\n");
        return 0;
    }

    try stdout.writeAll("Available connector sources:\n");
    for (connector.adapters) |a| {
        try stdout.print("  {s:<8}  {s}\n", .{ a.name, a.description });
    }
    return 0;
}

fn runResolve(alloc: Allocator, cmd: Command, stderr: *std.io.Writer) !u8 {
    const source = cmd.source orelse {
        try stderr.print("error: resolve requires --source (linear or github)\n", .{});
        return 1;
    };
    const command = cmd.command orelse {
        try stderr.print("error: resolve requires --command\n", .{});
        return 1;
    };

    const adapter = connector.adapterByName(source) orelse {
        try stderr.print(
            "error: unknown connector source '{s}'. Available: ",
            .{source},
        );
        for (connector.adapters, 0..) |a, i| {
            if (i > 0) try stderr.writeAll(", ");
            try stderr.writeAll(a.name);
        }
        try stderr.writeAll("\n");
        return 1;
    };

    // Read the payload from the given file, or stdin when omitted or "-".
    const payload = readPayload(alloc, cmd.payload) catch |err| {
        const where = if (cmd.payload) |p|
            try std.fmt.allocPrint(alloc, "file '{s}'", .{p})
        else
            "stdin";
        try stderr.print("error: could not read payload from {s}: {}\n", .{ where, err });
        return 1;
    };

    const event = adapter.parse(alloc, payload) catch |err| {
        try stderr.print("error: {s} adapter could not parse payload: {s}\n", .{
            source,
            switch (err) {
                error.InvalidPayload => "payload is not a JSON object",
                error.MissingField => "a required field is missing (see warnings above)",
                error.UnsupportedEventType => "the payload's event type is not supported by this adapter",
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
    };

    var diag: Template.Diagnostic = .{};
    const request = connector.resolve(alloc, template, event, .{
        .launched_at = cmd.launched_at,
        .diag = &diag,
    }) catch |err| switch (err) {
        error.MissingField => {
            try stderr.print(
                "error: launch template references field '{s}' which the {s} payload did not provide\n",
                .{ diag.field, source },
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

    // Print the resolve envelope: the normalized event, how the prompt should
    // be delivered, the resolved prompt itself, and the `sessions.create`
    // control request. A runner consumes the whole envelope — it injects the
    // capability token into `launch` and, for stdin/file delivery, hands the
    // `prompt` to the launched command out of band. We only resolve, never send.
    var out: std.io.Writer.Allocating = .init(alloc);
    var json: std.json.Stringify = .{ .writer = &out.writer, .options = .{ .whitespace = .indent_2 } };
    try json.beginObject();
    try json.objectField("event");
    try event.writeJson(&json);
    try json.objectField("prompt_delivery");
    try json.write(@tagName(request.prompt_delivery));
    if (request.prompt) |p| {
        try json.objectField("prompt");
        try json.write(p);
    }
    try json.objectField("launch");
    try request.writeControlRequest(alloc, &json, .{});
    try json.endObject();

    var out_buf: [4096]u8 = undefined;
    var stdout_writer = std.fs.File.stdout().writer(&out_buf);
    const stdout = &stdout_writer.interface;
    try stdout.writeAll(out.written());
    try stdout.writeAll("\n");
    try stdout.flush();
    return 0;
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

    // The leading action token may still be present depending on dispatch.
    if (std.mem.eql(u8, first, "+connector") or std.mem.eql(u8, first, "connector")) {
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
        } else if (try flagValue(alloc, arg, iter, "--payload")) |v| {
            cmd.payload = v;
        } else if (try flagValue(alloc, arg, iter, "--command")) |v| {
            cmd.command = v;
        } else if (try flagValue(alloc, arg, iter, "--cwd")) |v| {
            cmd.cwd = v;
        } else if (try flagValue(alloc, arg, iter, "--title")) |v| {
            cmd.title = v;
        } else if (try flagValue(alloc, arg, iter, "--launched-at")) |v| {
            cmd.launched_at = v;
        } else if (try flagValue(alloc, arg, iter, "--prompt-delivery")) |v| {
            cmd.prompt_delivery = std.meta.stringToEnum(Template.PromptDelivery, v) orelse
                return error.InvalidPromptDelivery;
        } else if (try flagValue(alloc, arg, iter, "--env")) |v| {
            const eq = std.mem.indexOfScalar(u8, v, '=') orelse return error.InvalidEnv;
            if (eq == 0) return error.InvalidEnv;
            try cmd.env.append(alloc, .{ .key = v[0..eq], .value = v[eq + 1 ..] });
        } else if (std.mem.eql(u8, arg, "--json")) {
            cmd.json = true;
        } else if (std.mem.startsWith(u8, arg, "-")) {
            return error.UnknownFlag;
        } else {
            return error.UnknownFlag;
        }
    }

    return cmd;
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

test "parseCommand resolve with flags" {
    const testing = std.testing;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var iter = try std.process.ArgIteratorGeneral(.{}).init(
        alloc,
        "connector resolve --source linear --command claude --env A=B --prompt-delivery stdin",
    );
    defer iter.deinit();

    const cmd = try parseCommand(alloc, &iter);
    try testing.expect(cmd.verb == .resolve);
    try testing.expectEqualStrings("linear", cmd.source.?);
    try testing.expectEqualStrings("claude", cmd.command.?);
    try testing.expectEqual(@as(usize, 1), cmd.env.items.len);
    try testing.expectEqualStrings("A", cmd.env.items[0].key);
    try testing.expectEqualStrings("B", cmd.env.items[0].value);
    try testing.expect(cmd.prompt_delivery == .stdin);
}

test "parseCommand rejects unknown verb and bad prompt delivery" {
    const testing = std.testing;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    {
        var iter = try std.process.ArgIteratorGeneral(.{}).init(alloc, "connector frobnicate");
        defer iter.deinit();
        try testing.expectError(error.UnknownVerb, parseCommand(alloc, &iter));
    }
    {
        var iter = try std.process.ArgIteratorGeneral(.{}).init(
            alloc,
            "connector resolve --prompt-delivery telepathy",
        );
        defer iter.deinit();
        try testing.expectError(error.InvalidPromptDelivery, parseCommand(alloc, &iter));
    }
    {
        var iter = try std.process.ArgIteratorGeneral(.{}).init(alloc, "connector resolve --env NOEQUALS");
        defer iter.deinit();
        try testing.expectError(error.InvalidEnv, parseCommand(alloc, &iter));
    }
}

test "parseCommand surfaces help requests" {
    const testing = std.testing;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    for ([_][]const u8{ "connector --help", "connector -h", "connector resolve --help" }) |line| {
        var iter = try std.process.ArgIteratorGeneral(.{}).init(alloc, line);
        defer iter.deinit();
        try testing.expectError(error.HelpRequested, parseCommand(alloc, &iter));
    }
}
