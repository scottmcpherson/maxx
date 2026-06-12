//! Tab management subcommands for agent orchestration: `list-tabs`,
//! `close-tab`, `rename-tab`, and `send`. These let an agent session inspect
//! and manage the other tabs of the running app — see which agents are still
//! running where, rename tabs, prompt existing sessions, and close tabs it
//! spawned.

const std = @import("std");
const builtin = @import("builtin");

const osa = @import("osa.zig");

const Allocator = std.mem.Allocator;

/// Field separator used by the list script. Titles and paths can contain
/// almost anything; ASCII unit separator cannot appear in practice.
const list_sep: u8 = 0x1f;

const list_script_template =
    \\on run argv
    \\  set sep to character id 31
    \\  set out to ""
    \\  tell application id "%APP_ID%"
    \\    repeat with w in windows
    \\      set out to out & "W" & sep & (id of w) & sep & (name of w) & linefeed
    \\      repeat with t in tabs of w
    \\        set out to out & "T" & sep & (id of t) & sep & (selected of t) & sep & (name of t) & linefeed
    \\        repeat with trm in terminals of t
    \\          set pidVal to ""
    \\          try
    \\            set pidVal to (pid of trm) as text
    \\          end try
    \\          set ttyVal to ""
    \\          try
    \\            set ttyVal to tty of trm
    \\          end try
    \\          set cwdVal to ""
    \\          try
    \\            set cwdVal to working directory of trm
    \\          end try
    \\          set out to out & "S" & sep & (id of trm) & sep & pidVal & sep & ttyVal & sep & cwdVal & linefeed
    \\        end repeat
    \\      end repeat
    \\    end repeat
    \\  end tell
    \\  return out
    \\end run
;

const close_script_template =
    \\on run argv
    \\  set tid to item 1 of argv
    \\  tell application id "%APP_ID%"
    \\    repeat with w in windows
    \\      if exists (tab id tid of w) then
    \\        close tab (tab id tid of w)
    \\        return "ok"
    \\      end if
    \\    end repeat
    \\  end tell
    \\  error "tab not found: " & tid
    \\end run
;

const rename_script_template =
    \\on run argv
    \\  set tid to item 1 of argv
    \\  set newName to item 2 of argv
    \\  set surfaceId to item 3 of argv
    \\  tell application id "%APP_ID%"
    \\    if tid is "current" then
    \\      repeat with w in windows
    \\        repeat with t in tabs of w
    \\          if exists (terminal id surfaceId of t) then
    \\            set name of t to newName
    \\            return id of t
    \\          end if
    \\        end repeat
    \\      end repeat
    \\      error "current tab not found"
    \\    end if
    \\    repeat with w in windows
    \\      if exists (tab id tid of w) then
    \\        set name of (tab id tid of w) to newName
    \\        return tid
    \\      end if
    \\    end repeat
    \\  end tell
    \\  error "tab not found: " & tid
    \\end run
;

const send_script_template =
    \\on run argv
    \\  set tid to item 1 of argv
    \\  set theText to item 2 of argv
    \\  set pressEnter to item 3 of argv
    \\  tell application id "%APP_ID%"
    \\    if not (exists (terminal id tid)) then error "terminal not found: " & tid
    \\    input text theText to terminal id tid
    \\    if pressEnter is "1" then
    \\      send key "enter" to terminal id tid
    \\      send key "enter" action release to terminal id tid
    \\    end if
    \\  end tell
    \\  return "ok"
    \\end run
;

const send_key_script_template =
    \\on run argv
    \\  set tid to item 1 of argv
    \\  set keyName to item 2 of argv
    \\  tell application id "%APP_ID%"
    \\    if not (exists (terminal id tid)) then error "terminal not found: " & tid
    \\    send key keyName to terminal id tid
    \\    send key keyName action release to terminal id tid
    \\  end tell
    \\  return "ok"
    \\end run
;

pub fn runListTabs(alloc: Allocator, args: []const [:0]u8) !void {
    requireDarwin();
    if (args.len > 0) osa.fail("list-tabs takes no arguments", .{});

    var arena_state = std.heap.ArenaAllocator.init(alloc);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    _ = try osa.requireSurfaceId(arena);
    const script = try osa.renderScript(arena, list_script_template, try osa.appId(arena));
    const raw = try osa.runScript(arena, script, &.{});

    const windows = try parseListOutput(arena, raw);

    // Resolve foreground process names for all terminals in one ps call.
    var pids: std.ArrayListUnmanaged([]const u8) = .empty;
    for (windows) |window| for (window.tabs) |tab| for (tab.terminals) |terminal| {
        if (terminal.pid.len > 0) try pids.append(arena, terminal.pid);
    };
    const processes = try foregroundProcesses(arena, pids.items);

    const event_dir: ?[]const u8 = if (try osa.envOwned(arena, "GHOSTTY_AGENT_EVENT_FILE")) |path|
        std.fs.path.dirname(path)
    else
        null;

    var buffer: [4096]u8 = undefined;
    var stdout = std.fs.File.stdout().writer(&buffer);
    const writer = &stdout.interface;
    var json: std.json.Stringify = .{ .writer = writer, .options = .{ .whitespace = .indent_2 } };

    try json.beginObject();
    try json.objectField("windows");
    try json.beginArray();
    for (windows) |window| {
        try json.beginObject();
        try json.objectField("window_id");
        try json.write(window.id);
        try json.objectField("title");
        try json.write(window.title);
        try json.objectField("tabs");
        try json.beginArray();
        for (window.tabs) |tab| {
            try json.beginObject();
            try json.objectField("tab_id");
            try json.write(tab.id);
            try json.objectField("title");
            try json.write(tab.title);
            try json.objectField("selected");
            try json.write(std.mem.eql(u8, tab.selected, "true"));
            try json.objectField("terminals");
            try json.beginArray();
            for (tab.terminals) |terminal| {
                try json.beginObject();
                try json.objectField("terminal_id");
                try json.write(terminal.id);
                try json.objectField("pid");
                if (std.fmt.parseInt(i64, terminal.pid, 10)) |pid| {
                    try json.write(pid);
                } else |_| {
                    try json.write(null);
                }
                try json.objectField("process");
                if (processes.get(terminal.pid)) |name| {
                    try json.write(name);
                } else {
                    try json.write(null);
                }
                try json.objectField("tty");
                try json.write(terminal.tty);
                try json.objectField("cwd");
                try json.write(terminal.cwd);
                try json.objectField("agent");
                try writeAgentState(arena, &json, event_dir, terminal.id);
                try json.endObject();
            }
            try json.endArray();
            try json.endObject();
        }
        try json.endArray();
        try json.endObject();
    }
    try json.endArray();
    try json.endObject();
    try writer.writeByte('\n');
    try writer.flush();
}

pub fn runCloseTab(alloc: Allocator, args: []const [:0]u8) !void {
    requireDarwin();
    if (args.len != 1) osa.fail("usage: ghostty-agent-hook close-tab <tab-id>", .{});

    var arena_state = std.heap.ArenaAllocator.init(alloc);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    _ = try osa.requireSurfaceId(arena);
    const script = try osa.renderScript(arena, close_script_template, try osa.appId(arena));
    _ = try osa.runScript(arena, script, &.{args[0]});
    try printOk(&.{ "tab_id", args[0] });
}

pub fn runRenameTab(alloc: Allocator, args: []const [:0]u8) !void {
    requireDarwin();
    if (args.len < 2) {
        osa.fail("usage: ghostty-agent-hook rename-tab <tab-id|current> <new name>", .{});
    }

    var arena_state = std.heap.ArenaAllocator.init(alloc);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const title = try joinArgs(arena, args[1..]);
    const surface_id = try osa.requireSurfaceId(arena);
    const script = try osa.renderScript(arena, rename_script_template, try osa.appId(arena));
    const tab_id = try osa.runScript(arena, script, &.{ args[0], title, surface_id });
    try printOk(&.{ "tab_id", tab_id, "title", title });
}

pub fn runSend(alloc: Allocator, args: []const [:0]u8) !void {
    requireDarwin();

    const usage = "usage: ghostty-agent-hook send [--no-enter] <terminal-id> <text>\n" ++
        "       ghostty-agent-hook send --key <key-name> <terminal-id>";

    var rest: []const [:0]u8 = args;
    var press_enter = true;
    var key: ?[]const u8 = null;
    while (rest.len > 0 and std.mem.startsWith(u8, rest[0], "--")) {
        if (std.mem.eql(u8, rest[0], "--no-enter")) {
            press_enter = false;
            rest = rest[1..];
        } else if (std.mem.eql(u8, rest[0], "--key")) {
            if (rest.len < 2) osa.fail("{s}", .{usage});
            key = rest[1];
            rest = rest[2..];
        } else {
            osa.fail("unknown option \"{s}\"\n\n{s}", .{ rest[0], usage });
        }
    }

    var arena_state = std.heap.ArenaAllocator.init(alloc);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    _ = try osa.requireSurfaceId(arena);

    if (key) |key_name| {
        if (rest.len != 1) osa.fail("{s}", .{usage});
        const script = try osa.renderScript(arena, send_key_script_template, try osa.appId(arena));
        _ = try osa.runScript(arena, script, &.{ rest[0], key_name });
        try printOk(&.{ "terminal_id", rest[0], "key", key_name });
        return;
    }

    if (rest.len < 2) osa.fail("{s}", .{usage});
    const text = try joinArgs(arena, rest[1..]);
    const script = try osa.renderScript(arena, send_script_template, try osa.appId(arena));
    _ = try osa.runScript(arena, script, &.{ rest[0], text, if (press_enter) "1" else "0" });
    try printOk(&.{ "terminal_id", rest[0] });
}

fn requireDarwin() void {
    if (comptime !builtin.target.os.tag.isDarwin()) {
        osa.fail("tab management is only supported on macOS", .{});
    }
}

fn joinArgs(alloc: Allocator, args: []const [:0]u8) ![]const u8 {
    var out: std.ArrayListUnmanaged(u8) = .empty;
    for (args, 0..) |arg, i| {
        if (i > 0) try out.append(alloc, ' ');
        try out.appendSlice(alloc, arg);
    }
    return try out.toOwnedSlice(alloc);
}

/// Prints a one-line JSON object of {"ok":true} plus the given key/value pairs.
fn printOk(pairs: []const []const u8) !void {
    var buffer: [1024]u8 = undefined;
    var stdout = std.fs.File.stdout().writer(&buffer);
    const writer = &stdout.interface;
    var json: std.json.Stringify = .{ .writer = writer, .options = .{} };
    try json.beginObject();
    try json.objectField("ok");
    try json.write(true);
    var index: usize = 0;
    while (index + 1 < pairs.len) : (index += 2) {
        try json.objectField(pairs[index]);
        try json.write(pairs[index + 1]);
    }
    try json.endObject();
    try writer.writeByte('\n');
    try writer.flush();
}

// MARK: list-tabs parsing

pub const Terminal = struct {
    id: []const u8 = "",
    pid: []const u8 = "",
    tty: []const u8 = "",
    cwd: []const u8 = "",
};

pub const Tab = struct {
    id: []const u8 = "",
    selected: []const u8 = "",
    title: []const u8 = "",
    terminals: []const Terminal = &.{},
};

pub const Window = struct {
    id: []const u8 = "",
    title: []const u8 = "",
    tabs: []const Tab = &.{},
};

/// Parses the separator-delimited line format produced by the list script
/// into a window/tab/terminal tree. Rows reference their parent implicitly
/// by ordering: terminals belong to the last tab, tabs to the last window.
pub fn parseListOutput(alloc: Allocator, raw: []const u8) ![]const Window {
    var windows: std.ArrayListUnmanaged(Window) = .empty;
    var tabs: std.ArrayListUnmanaged(Tab) = .empty;
    var terminals: std.ArrayListUnmanaged(Terminal) = .empty;

    var lines = std.mem.splitScalar(u8, raw, '\n');
    while (lines.next()) |line| {
        const trimmed = std.mem.trim(u8, line, "\r");
        if (trimmed.len == 0) continue;

        var fields = std.mem.splitScalar(u8, trimmed, list_sep);
        const kind = fields.next() orelse continue;

        if (std.mem.eql(u8, kind, "W")) {
            try flushTab(alloc, &tabs, &terminals);
            try flushWindow(alloc, &windows, &tabs);
            try windows.append(alloc, .{
                .id = fields.next() orelse "",
                .title = fields.rest(),
            });
        } else if (std.mem.eql(u8, kind, "T")) {
            try flushTab(alloc, &tabs, &terminals);
            try tabs.append(alloc, .{
                .id = fields.next() orelse "",
                .selected = fields.next() orelse "",
                .title = fields.rest(),
            });
        } else if (std.mem.eql(u8, kind, "S")) {
            try terminals.append(alloc, .{
                .id = fields.next() orelse "",
                .pid = fields.next() orelse "",
                .tty = fields.next() orelse "",
                .cwd = fields.rest(),
            });
        }
    }

    try flushTab(alloc, &tabs, &terminals);
    try flushWindow(alloc, &windows, &tabs);
    return try windows.toOwnedSlice(alloc);
}

fn flushTab(
    alloc: Allocator,
    tabs: *std.ArrayListUnmanaged(Tab),
    terminals: *std.ArrayListUnmanaged(Terminal),
) !void {
    if (tabs.items.len == 0) {
        terminals.clearRetainingCapacity();
        return;
    }
    tabs.items[tabs.items.len - 1].terminals = try terminals.toOwnedSlice(alloc);
}

fn flushWindow(
    alloc: Allocator,
    windows: *std.ArrayListUnmanaged(Window),
    tabs: *std.ArrayListUnmanaged(Tab),
) !void {
    if (windows.items.len == 0) {
        tabs.clearRetainingCapacity();
        return;
    }
    windows.items[windows.items.len - 1].tabs = try tabs.toOwnedSlice(alloc);
}

// MARK: enrichment

/// Maps pid strings to foreground process names via a single ps invocation.
fn foregroundProcesses(
    alloc: Allocator,
    pids: []const []const u8,
) !std.StringHashMapUnmanaged([]const u8) {
    var map: std.StringHashMapUnmanaged([]const u8) = .empty;
    if (pids.len == 0) return map;

    var pid_list: std.ArrayListUnmanaged(u8) = .empty;
    for (pids, 0..) |pid, i| {
        if (i > 0) try pid_list.append(alloc, ',');
        try pid_list.appendSlice(alloc, pid);
    }

    const result = std.process.Child.run(.{
        .allocator = alloc,
        .argv = &.{ "/bin/ps", "-o", "pid=,comm=", "-p", pid_list.items },
    }) catch return map;
    if (result.term != .Exited) return map;

    try parsePsOutput(alloc, &map, result.stdout);
    return map;
}

pub fn parsePsOutput(
    alloc: Allocator,
    map: *std.StringHashMapUnmanaged([]const u8),
    output: []const u8,
) !void {
    var lines = std.mem.splitScalar(u8, output, '\n');
    while (lines.next()) |line| {
        const trimmed = std.mem.trim(u8, line, &std.ascii.whitespace);
        if (trimmed.len == 0) continue;
        const space = std.mem.indexOfScalar(u8, trimmed, ' ') orelse continue;
        const pid = trimmed[0..space];
        const command = std.mem.trim(u8, trimmed[space + 1 ..], &std.ascii.whitespace);
        try map.put(alloc, pid, std.fs.path.basename(command));
    }
}

/// Writes the latest agent activity state for a terminal as a JSON value:
/// {"name":..., "state":..., "timestamp":...} or null when no agent has
/// reported events for that surface.
fn writeAgentState(
    alloc: Allocator,
    json: *std.json.Stringify,
    event_dir: ?[]const u8,
    terminal_id: []const u8,
) !void {
    const state = latestAgentState(alloc, event_dir, terminal_id) orelse {
        try json.write(null);
        return;
    };

    try json.beginObject();
    try json.objectField("name");
    try json.write(state.agent);
    try json.objectField("state");
    try json.write(state.state);
    try json.objectField("timestamp");
    if (state.timestamp) |timestamp| {
        try json.write(timestamp);
    } else {
        try json.write(null);
    }
    try json.endObject();
}

const AgentState = struct {
    agent: []const u8,
    state: []const u8,
    timestamp: ?f64,
};

fn latestAgentState(alloc: Allocator, event_dir: ?[]const u8, terminal_id: []const u8) ?AgentState {
    const dir = event_dir orelse return null;

    var name_buf: [64]u8 = undefined;
    if (terminal_id.len > name_buf.len) return null;
    const lower = std.ascii.lowerString(&name_buf, terminal_id);

    const file_path = std.fmt.allocPrint(alloc, "{s}/{s}.jsonl", .{ dir, lower }) catch return null;

    const file = std.fs.openFileAbsolute(file_path, .{}) catch return null;
    defer file.close();
    const contents = file.readToEndAlloc(alloc, 4 * 1024 * 1024) catch return null;

    return parseLatestAgentState(alloc, contents);
}

pub fn parseLatestAgentState(alloc: Allocator, contents: []const u8) ?AgentState {
    var last: ?AgentState = null;
    var lines = std.mem.splitScalar(u8, contents, '\n');
    while (lines.next()) |line| {
        const trimmed = std.mem.trim(u8, line, &std.ascii.whitespace);
        if (trimmed.len == 0) continue;

        const parsed = std.json.parseFromSlice(std.json.Value, alloc, trimmed, .{}) catch continue;
        if (parsed.value != .object) continue;
        const object = parsed.value.object;

        const agent = stringField(object, "agent") orelse continue;
        const state = stringField(object, "state") orelse continue;
        const timestamp: ?f64 = switch (object.get("timestamp") orelse .null) {
            .float => |v| v,
            .integer => |v| @floatFromInt(v),
            else => null,
        };

        last = .{ .agent = agent, .state = state, .timestamp = timestamp };
    }
    return last;
}

fn stringField(object: std.json.ObjectMap, name: []const u8) ?[]const u8 {
    const value = object.get(name) orelse return null;
    return switch (value) {
        .string => |s| s,
        else => null,
    };
}

// MARK: tests

test "parse list output into windows, tabs, and terminals" {
    const testing = std.testing;
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const sep = [1]u8{list_sep};
    const raw = "W" ++ sep ++ "win-1" ++ sep ++ "Window One\n" ++
        "T" ++ sep ++ "tab-1" ++ sep ++ "true" ++ sep ++ "First tab\n" ++
        "S" ++ sep ++ "AAAA" ++ sep ++ "123" ++ sep ++ "/dev/ttys000" ++ sep ++ "/Users/x\n" ++
        "T" ++ sep ++ "tab-2" ++ sep ++ "false" ++ sep ++ "Second tab\n" ++
        "S" ++ sep ++ "BBBB" ++ sep ++ "" ++ sep ++ "" ++ sep ++ "\n" ++
        "W" ++ sep ++ "win-2" ++ sep ++ "Window Two\n";

    const windows = try parseListOutput(arena, raw);
    try testing.expectEqual(@as(usize, 2), windows.len);
    try testing.expectEqualStrings("win-1", windows[0].id);
    try testing.expectEqualStrings("Window One", windows[0].title);
    try testing.expectEqual(@as(usize, 2), windows[0].tabs.len);
    try testing.expectEqualStrings("tab-1", windows[0].tabs[0].id);
    try testing.expectEqualStrings("true", windows[0].tabs[0].selected);
    try testing.expectEqual(@as(usize, 1), windows[0].tabs[0].terminals.len);
    try testing.expectEqualStrings("AAAA", windows[0].tabs[0].terminals[0].id);
    try testing.expectEqualStrings("123", windows[0].tabs[0].terminals[0].pid);
    try testing.expectEqualStrings("/Users/x", windows[0].tabs[0].terminals[0].cwd);
    try testing.expectEqualStrings("BBBB", windows[0].tabs[1].terminals[0].id);
    try testing.expectEqual(@as(usize, 0), windows[1].tabs.len);
}

test "parse ps output maps pids to process basenames" {
    const testing = std.testing;
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var map: std.StringHashMapUnmanaged([]const u8) = .empty;
    try parsePsOutput(arena, &map,
        \\  123 /Users/x/.local/bin/claude
        \\45678 -/bin/zsh
        \\
    );
    try testing.expectEqualStrings("claude", map.get("123").?);
    try testing.expectEqualStrings("zsh", map.get("45678").?);
}

test "parse latest agent state from event lines" {
    const testing = std.testing;
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const contents =
        \\{"agent":"claude","state":"running","timestamp":100.5}
        \\not json
        \\{"agent":"claude","state":"needsInput","timestamp":101}
        \\
    ;
    const state = parseLatestAgentState(arena, contents).?;
    try testing.expectEqualStrings("claude", state.agent);
    try testing.expectEqualStrings("needsInput", state.state);
    try testing.expectEqual(@as(f64, 101), state.timestamp.?);

    try testing.expect(parseLatestAgentState(arena, "") == null);
}
