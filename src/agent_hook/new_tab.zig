//! `ghostty-agent-hook new-tab`: ask the running app to open a new tab (or
//! window) and run a command in it. This drives the app's AppleScript
//! `new tab` command, so it only works on macOS and only inside terminals
//! created by the app (which inject GHOSTTY_AGENT_SURFACE_ID).

const std = @import("std");
const builtin = @import("builtin");

const Allocator = std.mem.Allocator;

/// Bundle id used when the inherited __CFBundleIdentifier is unavailable.
const default_bundle_id = "com.scottmcpherson.mosttly-ghostty";

const usage =
    \\Usage: ghostty-agent-hook new-tab [options] [--] [command [args...]]
    \\
    \\Open a new tab in the Mosttly window that contains this terminal and run
    \\the given command in it. With no command, just opens a shell tab.
    \\
    \\Options:
    \\  --title <name>   Name for the new tab, shown in the tab bar and sidebar.
    \\  --cwd <dir>      Working directory for the new tab. Defaults to the
    \\                   current working directory.
    \\  --env KEY=VALUE  Extra environment variable for the new tab (repeatable).
    \\  --new-window     Open a new window instead of a tab.
    \\  --exec           Run the command directly instead of typing it into an
    \\                   interactive shell. The tab closes when the command
    \\                   exits unless --wait is given.
    \\  --wait           With --exec, keep the tab open after the command exits.
    \\  --help           Show this help.
    \\
    \\Prints JSON with the new tab, terminal, and window ids on success.
    \\
;

/// The AppleScript run by osascript. All untrusted values are passed as
/// argv items so nothing needs to be escaped into the script source. Only
/// the bundle id is substituted into the source, because `tell application`
/// must reference a literal for compile-time terminology resolution.
const script_template =
    \\on run argv
    \\  set surfaceId to item 1 of argv
    \\  set createWindow to item 2 of argv
    \\  set cwdPath to item 3 of argv
    \\  set commandText to item 4 of argv
    \\  set inputText to item 5 of argv
    \\  set waitFlag to item 6 of argv
    \\  set titleText to item 7 of argv
    \\  set envList to {}
    \\  if (count of argv) > 7 then set envList to items 8 thru -1 of argv
    \\  tell application id "%APP_ID%"
    \\    set cfg to {command:commandText, initial input:inputText, initial working directory:cwdPath, wait after command:(waitFlag is "1"), environment variables:envList}
    \\    if createWindow is "1" then
    \\      set newWindow to new window with configuration cfg
    \\      set newTab to selected tab of newWindow
    \\    else
    \\      set targetWindow to missing value
    \\      if surfaceId is not "" then
    \\        repeat with w in windows
    \\          if exists (terminal id surfaceId of w) then
    \\            set targetWindow to w
    \\            exit repeat
    \\          end if
    \\        end repeat
    \\      end if
    \\      if targetWindow is missing value then
    \\        set newTab to new tab with configuration cfg
    \\      else
    \\        set newTab to new tab in targetWindow with configuration cfg
    \\      end if
    \\    end if
    \\    if titleText is not "" then set name of newTab to titleText
    \\    set tabId to id of newTab
    \\    set termId to ""
    \\    try
    \\      set termId to id of (focused terminal of newTab)
    \\    end try
    \\    if termId is "" then
    \\      try
    \\        set termId to id of (terminal 1 of newTab)
    \\      end try
    \\    end if
    \\    set winId to ""
    \\    repeat with w in windows
    \\      if exists (tab id tabId of w) then
    \\        set winId to id of w
    \\        exit repeat
    \\      end if
    \\    end repeat
    \\    return tabId & linefeed & termId & linefeed & winId
    \\  end tell
    \\end run
;

pub const Options = struct {
    title: ?[]const u8 = null,
    cwd: ?[]const u8 = null,
    new_window: bool = false,
    exec: bool = false,
    wait: bool = false,
    help: bool = false,
    env: []const []const u8 = &.{},
    command: []const []const u8 = &.{},
};

pub const ParseResult = union(enum) {
    ok: Options,
    err: []const u8,
};

pub fn run(alloc: Allocator, args: []const [:0]u8) !void {
    if (comptime !builtin.target.os.tag.isDarwin()) {
        return fail("new-tab is only supported on macOS", .{});
    }

    var arena_state = std.heap.ArenaAllocator.init(alloc);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const plain = try arena.alloc([]const u8, args.len);
    for (args, 0..) |arg, i| plain[i] = arg;

    const opts = switch (try parseOptions(arena, plain)) {
        .ok => |opts| opts,
        .err => |message| return fail("{s}\n\n{s}", .{ message, usage }),
    };

    if (opts.help) {
        var buffer: [1024]u8 = undefined;
        var stdout = std.fs.File.stdout().writer(&buffer);
        try stdout.interface.writeAll(usage);
        try stdout.interface.flush();
        return;
    }

    const surface_id = try envOwned(arena, "GHOSTTY_AGENT_SURFACE_ID") orelse {
        return fail(
            "new-tab must be run inside a Mosttly terminal " ++
                "(GHOSTTY_AGENT_SURFACE_ID is not set)",
            .{},
        );
    };

    const app_id = try envOwned(arena, "__CFBundleIdentifier") orelse default_bundle_id;
    const cwd = opts.cwd orelse try std.process.getCwdAlloc(arena);

    var command_text: []const u8 = "";
    var input_text: []const u8 = "";
    if (opts.command.len > 0) {
        const joined = try shellJoin(arena, opts.command);
        if (opts.exec) {
            command_text = joined;
        } else {
            input_text = try std.mem.concat(arena, u8, &.{ joined, "\n" });
        }
    }

    const script = try std.mem.replaceOwned(
        u8,
        arena,
        script_template,
        "%APP_ID%",
        try escapeAppleScriptString(arena, app_id),
    );

    var argv: std.ArrayListUnmanaged([]const u8) = .empty;
    try argv.appendSlice(arena, &.{
        "/usr/bin/osascript",
        "-e",
        script,
        surface_id,
        if (opts.new_window) "1" else "0",
        cwd,
        command_text,
        input_text,
        if (opts.wait) "1" else "0",
        opts.title orelse "",
    });
    try argv.appendSlice(arena, opts.env);

    const result = std.process.Child.run(.{
        .allocator = arena,
        .argv = argv.items,
    }) catch |err| {
        return fail("failed to run osascript: {}", .{err});
    };

    switch (result.term) {
        .Exited => |code| if (code != 0) {
            const message = std.mem.trim(u8, result.stderr, &std.ascii.whitespace);
            return fail("failed to create tab: {s}", .{message});
        },
        else => return fail("osascript terminated abnormally", .{}),
    }

    var lines = std.mem.splitScalar(
        u8,
        std.mem.trim(u8, result.stdout, &std.ascii.whitespace),
        '\n',
    );
    const tab_id = std.mem.trim(u8, lines.next() orelse "", &std.ascii.whitespace);
    const terminal_id = std.mem.trim(u8, lines.next() orelse "", &std.ascii.whitespace);
    const window_id = std.mem.trim(u8, lines.next() orelse "", &std.ascii.whitespace);

    var buffer: [1024]u8 = undefined;
    var stdout = std.fs.File.stdout().writer(&buffer);
    const writer = &stdout.interface;
    var json: std.json.Stringify = .{ .writer = writer, .options = .{} };
    try json.beginObject();
    try json.objectField("tab_id");
    try json.write(tab_id);
    try json.objectField("terminal_id");
    try json.write(terminal_id);
    try json.objectField("window_id");
    try json.write(window_id);
    try json.endObject();
    try writer.writeByte('\n');
    try writer.flush();
}

pub fn parseOptions(alloc: Allocator, args: []const []const u8) Allocator.Error!ParseResult {
    var opts: Options = .{};
    var env: std.ArrayListUnmanaged([]const u8) = .empty;

    var index: usize = 0;
    while (index < args.len) : (index += 1) {
        const arg = args[index];

        if (std.mem.eql(u8, arg, "--")) {
            opts.command = args[index + 1 ..];
            break;
        }

        if (!std.mem.startsWith(u8, arg, "-")) {
            opts.command = args[index..];
            break;
        }

        if (std.mem.eql(u8, arg, "--help") or std.mem.eql(u8, arg, "-h")) {
            opts.help = true;
        } else if (std.mem.eql(u8, arg, "--new-window")) {
            opts.new_window = true;
        } else if (std.mem.eql(u8, arg, "--exec")) {
            opts.exec = true;
        } else if (std.mem.eql(u8, arg, "--wait")) {
            opts.wait = true;
        } else if (matchesOption(arg, "--title")) {
            const value = optionValue(args, &index, "--title") orelse {
                return parseErr(alloc, "--title requires a name", .{});
            };
            if (value.len == 0) return parseErr(alloc, "--title requires a name", .{});
            opts.title = value;
        } else if (matchesOption(arg, "--cwd")) {
            const value = optionValue(args, &index, "--cwd") orelse {
                return parseErr(alloc, "--cwd requires a directory", .{});
            };
            if (value.len == 0) return parseErr(alloc, "--cwd requires a directory", .{});
            opts.cwd = value;
        } else if (matchesOption(arg, "--env")) {
            const value = optionValue(args, &index, "--env") orelse {
                return parseErr(alloc, "--env requires a value", .{});
            };
            const separator = std.mem.indexOfScalar(u8, value, '=') orelse 0;
            if (separator == 0) {
                return parseErr(alloc, "--env expects KEY=VALUE, got \"{s}\"", .{value});
            }
            try env.append(alloc, value);
        } else {
            return parseErr(alloc, "unknown option \"{s}\"", .{arg});
        }
    }

    if (opts.wait and !opts.exec) {
        return parseErr(alloc, "--wait requires --exec", .{});
    }

    opts.env = try env.toOwnedSlice(alloc);
    return .{ .ok = opts };
}

fn matchesOption(arg: []const u8, comptime name: []const u8) bool {
    return std.mem.eql(u8, arg, name) or std.mem.startsWith(u8, arg, name ++ "=");
}

/// Returns the value for `name`, consuming a following argument for the
/// `--name value` form and supporting the `--name=value` form. Returns null
/// when the value is missing. Assumes `args[index.*]` matched `name`.
fn optionValue(args: []const []const u8, index: *usize, comptime name: []const u8) ?[]const u8 {
    const arg = args[index.*];
    if (std.mem.eql(u8, arg, name)) {
        if (index.* + 1 >= args.len) return null;
        index.* += 1;
        return args[index.*];
    }

    return arg[name.len + 1 ..];
}

fn parseErr(alloc: Allocator, comptime fmt: []const u8, args: anytype) Allocator.Error!ParseResult {
    return .{ .err = try std.fmt.allocPrint(alloc, fmt, args) };
}

/// Join argv items into a single shell command string, quoting each item so
/// the shell sees exactly the original arguments.
pub fn shellJoin(alloc: Allocator, parts: []const []const u8) Allocator.Error![]const u8 {
    var out: std.ArrayListUnmanaged(u8) = .empty;
    for (parts, 0..) |part, i| {
        if (i > 0) try out.append(alloc, ' ');
        if (isShellSafeWord(part)) {
            try out.appendSlice(alloc, part);
            continue;
        }

        try out.append(alloc, '\'');
        for (part) |c| {
            if (c == '\'') {
                try out.appendSlice(alloc, "'\\''");
            } else {
                try out.append(alloc, c);
            }
        }
        try out.append(alloc, '\'');
    }
    return try out.toOwnedSlice(alloc);
}

fn isShellSafeWord(word: []const u8) bool {
    if (word.len == 0) return false;
    for (word) |c| {
        switch (c) {
            'a'...'z', 'A'...'Z', '0'...'9' => {},
            '-', '_', '.', '/', ':', '@', '%', '+', ',', '=' => {},
            else => return false,
        }
    }
    return true;
}

fn escapeAppleScriptString(alloc: Allocator, value: []const u8) Allocator.Error![]const u8 {
    var out: std.ArrayListUnmanaged(u8) = .empty;
    for (value) |c| {
        switch (c) {
            '\\', '"' => {
                try out.append(alloc, '\\');
                try out.append(alloc, c);
            },
            else => try out.append(alloc, c),
        }
    }
    return try out.toOwnedSlice(alloc);
}

fn envOwned(alloc: Allocator, key: []const u8) !?[]const u8 {
    return std.process.getEnvVarOwned(alloc, key) catch |err| switch (err) {
        error.EnvironmentVariableNotFound => null,
        else => return err,
    };
}

fn fail(comptime fmt: []const u8, args: anytype) noreturn {
    var buffer: [4096]u8 = undefined;
    var stderr = std.fs.File.stderr().writer(&buffer);
    stderr.interface.print("error: " ++ fmt ++ "\n", args) catch {};
    stderr.interface.flush() catch {};
    std.process.exit(1);
}

test "new-tab option parsing" {
    const testing = std.testing;
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    {
        const result = try parseOptions(arena, &.{ "--cwd", "/tmp", "--", "claude", "do xyz" });
        const opts = result.ok;
        try testing.expectEqualStrings("/tmp", opts.cwd.?);
        try testing.expectEqual(@as(usize, 2), opts.command.len);
        try testing.expectEqualStrings("claude", opts.command[0]);
        try testing.expectEqualStrings("do xyz", opts.command[1]);
        try testing.expect(!opts.new_window);
        try testing.expect(opts.title == null);
    }

    {
        const result = try parseOptions(arena, &.{ "--title", "Fix auth bug", "--", "claude", "fix it" });
        const opts = result.ok;
        try testing.expectEqualStrings("Fix auth bug", opts.title.?);
        try testing.expectEqual(@as(usize, 2), opts.command.len);
    }

    {
        // Command without "--" separator; everything after the first
        // non-option argument belongs to the command, including dashes.
        const result = try parseOptions(arena, &.{ "claude", "--model", "opus" });
        const opts = result.ok;
        try testing.expectEqual(@as(usize, 3), opts.command.len);
        try testing.expectEqualStrings("--model", opts.command[1]);
    }

    {
        const result = try parseOptions(arena, &.{ "--cwd=/srv", "--new-window", "--env", "FOO=bar", "--env", "BAZ=1" });
        const opts = result.ok;
        try testing.expectEqualStrings("/srv", opts.cwd.?);
        try testing.expect(opts.new_window);
        try testing.expectEqual(@as(usize, 2), opts.env.len);
        try testing.expectEqualStrings("FOO=bar", opts.env[0]);
        try testing.expectEqual(@as(usize, 0), opts.command.len);
    }

    {
        const result = try parseOptions(arena, &.{ "--exec", "--wait", "ls" });
        const opts = result.ok;
        try testing.expect(opts.exec);
        try testing.expect(opts.wait);
        try testing.expectEqual(@as(usize, 1), opts.command.len);
    }
}

test "new-tab option parsing errors" {
    const testing = std.testing;
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    try testing.expect((try parseOptions(arena, &.{"--bogus"})) == .err);
    try testing.expect((try parseOptions(arena, &.{"--cwd"})) == .err);
    try testing.expect((try parseOptions(arena, &.{"--title"})) == .err);
    try testing.expect((try parseOptions(arena, &.{ "--env", "NOEQUALS" })) == .err);
    try testing.expect((try parseOptions(arena, &.{ "--wait", "ls" })) == .err);
}

test "shell join quotes arguments" {
    const testing = std.testing;
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    try testing.expectEqualStrings(
        "claude 'do xyz'",
        try shellJoin(arena, &.{ "claude", "do xyz" }),
    );
    try testing.expectEqualStrings(
        "echo 'it'\\''s'",
        try shellJoin(arena, &.{ "echo", "it's" }),
    );
    try testing.expectEqualStrings(
        "claude --permission-mode auto '/goal do xyz'",
        try shellJoin(arena, &.{ "claude", "--permission-mode", "auto", "/goal do xyz" }),
    );
    try testing.expectEqualStrings("''", try shellJoin(arena, &.{""}));
}

test "applescript string escaping" {
    const testing = std.testing;
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    try testing.expectEqualStrings(
        "com.example.app",
        try escapeAppleScriptString(arena, "com.example.app"),
    );
    try testing.expectEqualStrings(
        "a\\\"b\\\\c",
        try escapeAppleScriptString(arena, "a\"b\\c"),
    );
}
