//! `ghostty-agent-hook new-tab`: ask the running app to open a new tab (or
//! window) and run a command in it. This drives the app's AppleScript
//! `new tab` command, so it only works on macOS and only inside terminals
//! created by the app (which inject GHOSTTY_AGENT_SURFACE_ID).

const std = @import("std");
const builtin = @import("builtin");

const osa = @import("osa.zig");

const Allocator = std.mem.Allocator;

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
        osa.fail("new-tab is only supported on macOS", .{});
    }

    var arena_state = std.heap.ArenaAllocator.init(alloc);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const plain = try arena.alloc([]const u8, args.len);
    for (args, 0..) |arg, i| plain[i] = arg;

    const opts = switch (try parseOptions(arena, plain)) {
        .ok => |opts| opts,
        .err => |message| osa.fail("{s}\n\n{s}", .{ message, usage }),
    };

    if (opts.help) {
        var buffer: [1024]u8 = undefined;
        var stdout = std.fs.File.stdout().writer(&buffer);
        try stdout.interface.writeAll(usage);
        try stdout.interface.flush();
        return;
    }

    const surface_id = try osa.requireSurfaceId(arena);
    const cwd = opts.cwd orelse try std.process.getCwdAlloc(arena);

    var command = opts.command;
    if (try configuredPermissionMode(arena, command)) |mode| {
        if (try injectPermissionMode(arena, command, mode)) |injected| {
            command = injected;
        }
    }

    var command_text: []const u8 = "";
    var input_text: []const u8 = "";
    if (command.len > 0) {
        const joined = try shellJoin(arena, command);
        if (opts.exec) {
            command_text = joined;
        } else {
            input_text = try std.mem.concat(arena, u8, &.{ joined, "\n" });
        }
    }

    const script = try osa.renderScript(arena, script_template, try osa.appId(arena));

    var script_args: std.ArrayListUnmanaged([]const u8) = .empty;
    try script_args.appendSlice(arena, &.{
        surface_id,
        if (opts.new_window) "1" else "0",
        cwd,
        command_text,
        input_text,
        if (opts.wait) "1" else "0",
        opts.title orelse "",
    });
    try script_args.appendSlice(arena, opts.env);

    const stdout_raw = try osa.runScript(arena, script, script_args.items);

    var lines = std.mem.splitScalar(u8, stdout_raw, '\n');
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

/// UserDefaults keys written by the app's Settings window for the default
/// permission mode of agent tabs. Sync with SettingsView.swift.
const claude_mode_defaults_key = "agentTabClaudePermissionMode";
const codex_mode_defaults_key = "agentTabCodexSandboxMode";

/// Existing flags that mean the caller already chose a permission setup, in
/// which case the configured default must not be injected.
const claude_permission_flags = [_][]const u8{
    "--permission-mode",
    "--dangerously-skip-permissions",
};
const codex_permission_flags = [_][]const u8{
    "--sandbox",
    "-s",
    "--ask-for-approval",
    "-a",
    "--full-auto",
    "--dangerously-bypass-approvals-and-sandbox",
    "--yolo",
};

/// Reads the configured default permission mode for the agent CLI being
/// spawned, from the app's preferences domain. Returns null when the command
/// is not a known agent CLI or no mode is configured.
fn configuredPermissionMode(alloc: Allocator, command: []const []const u8) !?[]const u8 {
    if (command.len == 0) return null;

    const program = std.fs.path.basename(command[0]);
    const key = if (std.mem.eql(u8, program, "claude"))
        claude_mode_defaults_key
    else if (std.mem.eql(u8, program, "codex"))
        codex_mode_defaults_key
    else
        return null;

    const domain = try osa.appId(alloc);
    const result = std.process.Child.run(.{
        .allocator = alloc,
        .argv = &.{ "/usr/bin/defaults", "read", domain, key },
    }) catch return null;
    switch (result.term) {
        .Exited => |code| if (code != 0) return null,
        else => return null,
    }

    const mode = std.mem.trim(u8, result.stdout, &std.ascii.whitespace);
    if (mode.len == 0 or std.mem.eql(u8, mode, "default")) return null;
    return mode;
}

/// Returns the command with the flags for `mode` inserted after the program
/// name, or null when the mode is unknown or the caller already passed
/// explicit permission flags. Pure so it can be unit tested.
pub fn injectPermissionMode(
    alloc: Allocator,
    command: []const []const u8,
    mode: []const u8,
) Allocator.Error!?[]const []const u8 {
    if (command.len == 0) return null;
    const program = std.fs.path.basename(command[0]);

    const extra: []const []const u8 = extra: {
        if (std.mem.eql(u8, program, "claude")) {
            if (commandHasAnyFlag(command, &claude_permission_flags)) return null;
            if (std.mem.eql(u8, mode, "plan")) break :extra &.{ "--permission-mode", "plan" };
            if (std.mem.eql(u8, mode, "acceptEdits")) break :extra &.{ "--permission-mode", "acceptEdits" };
            if (std.mem.eql(u8, mode, "auto")) break :extra &.{ "--permission-mode", "auto" };
            if (std.mem.eql(u8, mode, "dontAsk")) break :extra &.{ "--permission-mode", "dontAsk" };
            if (std.mem.eql(u8, mode, "bypassPermissions")) break :extra &.{ "--permission-mode", "bypassPermissions" };
            return null;
        }

        if (std.mem.eql(u8, program, "codex")) {
            if (commandHasAnyFlag(command, &codex_permission_flags)) return null;
            if (std.mem.eql(u8, mode, "read-only")) break :extra &.{ "--sandbox", "read-only" };
            if (std.mem.eql(u8, mode, "workspace-write")) break :extra &.{ "--sandbox", "workspace-write" };
            if (std.mem.eql(u8, mode, "full-auto")) break :extra &.{"--full-auto"};
            if (std.mem.eql(u8, mode, "danger-full-access")) {
                break :extra &.{ "--sandbox", "danger-full-access" };
            }
            if (std.mem.eql(u8, mode, "bypass")) {
                break :extra &.{"--dangerously-bypass-approvals-and-sandbox"};
            }
            return null;
        }

        return null;
    };

    var out = try alloc.alloc([]const u8, command.len + extra.len);
    out[0] = command[0];
    @memcpy(out[1 .. 1 + extra.len], extra);
    @memcpy(out[1 + extra.len ..], command[1..]);
    return out;
}

fn commandHasAnyFlag(command: []const []const u8, flags: []const []const u8) bool {
    for (command[1..]) |arg| {
        for (flags) |flag| {
            if (std.mem.eql(u8, arg, flag)) return true;
            if (arg.len > flag.len and
                std.mem.startsWith(u8, arg, flag) and
                arg[flag.len] == '=') return true;
        }
    }
    return false;
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

test "inject permission mode into agent commands" {
    const testing = std.testing;
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    {
        const injected = (try injectPermissionMode(arena, &.{ "claude", "do xyz" }, "acceptEdits")).?;
        try testing.expectEqual(@as(usize, 4), injected.len);
        try testing.expectEqualStrings("claude", injected[0]);
        try testing.expectEqualStrings("--permission-mode", injected[1]);
        try testing.expectEqualStrings("acceptEdits", injected[2]);
        try testing.expectEqualStrings("do xyz", injected[3]);
    }

    {
        // Program paths resolve by basename.
        const injected = (try injectPermissionMode(arena, &.{"/usr/local/bin/codex"}, "full-auto")).?;
        try testing.expectEqual(@as(usize, 2), injected.len);
        try testing.expectEqualStrings("--full-auto", injected[1]);
    }

    {
        const injected = (try injectPermissionMode(arena, &.{"claude"}, "auto")).?;
        try testing.expectEqualStrings("auto", injected[2]);
    }

    {
        const injected = (try injectPermissionMode(arena, &.{"claude"}, "dontAsk")).?;
        try testing.expectEqualStrings("dontAsk", injected[2]);
    }

    {
        const injected = (try injectPermissionMode(arena, &.{"codex"}, "workspace-write")).?;
        try testing.expectEqualStrings("--sandbox", injected[1]);
        try testing.expectEqualStrings("workspace-write", injected[2]);
    }

    {
        const injected = (try injectPermissionMode(arena, &.{ "codex", "fix it" }, "danger-full-access")).?;
        try testing.expectEqual(@as(usize, 4), injected.len);
        try testing.expectEqualStrings("--sandbox", injected[1]);
        try testing.expectEqualStrings("danger-full-access", injected[2]);
    }

    {
        const injected = (try injectPermissionMode(arena, &.{"codex"}, "bypass")).?;
        try testing.expectEqual(@as(usize, 2), injected.len);
        try testing.expectEqualStrings("--dangerously-bypass-approvals-and-sandbox", injected[1]);
    }

    // Explicit flags from the caller win over the configured default.
    try testing.expect((try injectPermissionMode(
        arena,
        &.{ "claude", "--permission-mode", "plan", "x" },
        "acceptEdits",
    )) == null);
    try testing.expect((try injectPermissionMode(
        arena,
        &.{ "claude", "--permission-mode=plan" },
        "acceptEdits",
    )) == null);
    try testing.expect((try injectPermissionMode(
        arena,
        &.{ "codex", "--full-auto" },
        "danger-full-access",
    )) == null);

    // Unknown programs and modes are left alone.
    try testing.expect((try injectPermissionMode(arena, &.{ "htop", "-d", "5" }, "acceptEdits")) == null);
    try testing.expect((try injectPermissionMode(arena, &.{"claude"}, "bogus")) == null);
    try testing.expect((try injectPermissionMode(arena, &.{}, "acceptEdits")) == null);
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
