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

const Verb = enum { create, get, list, update, cancel, action };

/// A parsed `maxx +control sessions ...` invocation.
const Command = struct {
    verb: Verb,
    id: ?[]const u8 = null,
    title: ?[]const u8 = null,
    cwd: ?[]const u8 = null,
    command: ?[]const u8 = null,
    status: ?[]const u8 = null,
    location: ?[]const u8 = null,
    action: ?[]const u8 = null,
    input: ?[]const u8 = null,
    metadata: std.ArrayList([2][]const u8) = .empty,
    env: std.ArrayList([]const u8) = .empty,

    fn method(self: Command) []const u8 {
        return switch (self.verb) {
            .create => "sessions.create",
            .get => "sessions.get",
            .list => "sessions.list",
            .update => "sessions.update",
            .cancel, .action => "sessions.action",
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
///     action — `focus`, `input` (with `--input <text>`), `interrupt`,
///     `cancel`, or `close`.
///
/// The create response includes a stable `session_id` to use for all later
/// operations. The raw JSON response is printed to stdout; the exit code is 0
/// on success and 1 on any error.
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
            try stderr.print("error: expected 'sessions' subcommand group\n", .{});
            return 1;
        },
        error.UnknownVerb => {
            try stderr.print("error: unknown subcommand. Try: create, get, list, update, cancel, action\n", .{});
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

    const response = sendRequest(arena_alloc, socket_path, request) catch |err| {
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

    return if (responseOk(arena_alloc, trimmed)) 0 else 1;
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

    if (!std.mem.eql(u8, group, "sessions")) return error.UnknownGroup;

    const verb_str = iter.next() orelse return error.MissingVerb;
    const verb = parseVerb(verb_str) orelse return error.UnknownVerb;

    var cmd: Command = .{ .verb = verb };
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
        } else if (try flagValue(alloc, arg, iter, "--metadata")) |v| {
            const eq = std.mem.indexOfScalar(u8, v, '=') orelse return error.InvalidMetadata;
            try cmd.metadata.append(alloc, .{ v[0..eq], v[eq + 1 ..] });
        } else if (try flagValue(alloc, arg, iter, "--env")) |v| {
            try cmd.env.append(alloc, v);
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

fn parseVerb(s: []const u8) ?Verb {
    inline for (@typeInfo(Verb).@"enum".fields) |field| {
        if (std.mem.eql(u8, s, field.name)) return @field(Verb, field.name);
    }
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
/// full response bytes.
fn sendRequest(alloc: Allocator, socket_path: []const u8, request: []const u8) ![]u8 {
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
    _ = c.shutdown(fd, SHUT_WR);

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
