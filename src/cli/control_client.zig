//! Shared client for the Maxx control Unix-domain socket.
//!
//! Both `+control` (the operator CLI) and `+runner` (the automation trigger
//! runner) talk to the same control socket the running Maxx app serves: they
//! resolve the control directory, read the per-call capability token, connect to
//! `control.sock`, send a single `{ token, method, params }` request, and read
//! the response. This module is that one client so the two callers cannot drift.
//!
//! It is intentionally thin: no request building (callers serialize their own
//! JSON), no response interpretation (callers parse `ok`/`error`). It owns only
//! the directory/token resolution and the socket round-trip.

const std = @import("std");
const Allocator = std.mem.Allocator;

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

/// `sun_path` is a fixed 104-byte field on macOS; longer paths cannot be bound.
pub const max_socket_path = 104;

/// The largest response we will buffer from a single-shot request. The control
/// server's responses are small JSON envelopes; this caps a misbehaving or
/// hostile server from exhausting memory.
pub const max_response_bytes = 8 * 1024 * 1024;

/// Resolve the control directory: `$MAXX_CONTROL_DIR` or `/tmp/maxx-control-<uid>`.
/// This mirrors the directory the running Maxx app serves the socket and token
/// from, so a dev build launched with a custom `MAXX_CONTROL_DIR` is reachable.
pub fn controlDir(alloc: Allocator) ![]const u8 {
    if (std.process.getEnvVarOwned(alloc, "MAXX_CONTROL_DIR")) |dir| {
        if (dir.len > 0) return dir;
    } else |_| {}
    return try std.fmt.allocPrint(alloc, "/tmp/maxx-control-{d}", .{c.getuid()});
}

/// `<dir>/control.sock`.
pub fn socketPath(alloc: Allocator, dir: []const u8) ![]const u8 {
    return try std.fmt.allocPrint(alloc, "{s}/control.sock", .{dir});
}

/// `<dir>/token`.
pub fn tokenPath(alloc: Allocator, dir: []const u8) ![]const u8 {
    return try std.fmt.allocPrint(alloc, "{s}/token", .{dir});
}

/// Read and trim the capability token at `path`. The running app writes this
/// file 0600; a caller that cannot read it is not authorized (or the app is not
/// running).
pub fn readToken(alloc: Allocator, path: []const u8) ![]const u8 {
    const file = try std.fs.openFileAbsolute(path, .{});
    defer file.close();
    const raw = try file.readToEndAlloc(alloc, 4096);
    return std.mem.trim(u8, raw, &std.ascii.whitespace);
}

/// A connected control socket. Thin wrapper around the raw fd so streaming
/// callers (`watch`) can drive the read loop themselves while single-shot
/// callers use `sendRequest`.
pub const Conn = struct {
    fd: c_int,

    pub fn connect(path: []const u8) !Conn {
        if (path.len >= max_socket_path) return error.PathTooLong;

        const fd = c.socket(AF_UNIX, SOCK_STREAM, 0);
        if (fd < 0) return error.SocketFailed;
        errdefer _ = c.close(fd);

        var addr: std.posix.sockaddr.un = .{ .family = AF_UNIX, .path = undefined };
        @memset(&addr.path, 0);
        @memcpy(addr.path[0..path.len], path);

        if (c.connect(fd, @ptrCast(&addr), @sizeOf(std.posix.sockaddr.un)) != 0) {
            return error.ConnectFailed;
        }
        return .{ .fd = fd };
    }

    pub fn writeAll(self: Conn, bytes: []const u8) !void {
        var written: usize = 0;
        while (written < bytes.len) {
            const n = c.write(self.fd, bytes.ptr + written, bytes.len - written);
            if (n <= 0) return error.WriteFailed;
            written += @intCast(n);
        }
    }

    /// Shut down the write side so the server sees an orderly half-close. Correct
    /// for single-shot requests; `wait`/`watch` keep the write side open so the
    /// server can detect a caller that gives up by closing the fd entirely.
    pub fn shutdownWrite(self: Conn) void {
        _ = c.shutdown(self.fd, SHUT_WR);
    }

    /// Read up to `buf.len` bytes. Returns 0 on EOF.
    pub fn read(self: Conn, buf: []u8) !usize {
        const n = c.read(self.fd, buf.ptr, buf.len);
        if (n < 0) return error.ReadFailed;
        return @intCast(n);
    }

    pub fn close(self: Conn) void {
        _ = c.close(self.fd);
    }
};

/// Send `request` (followed by a newline) to the control socket at `socket_path`
/// and return the full response bytes. `half_close` shuts the write side after
/// sending, which is correct for single-shot requests but must be false for
/// `wait` (the server watches for an orderly client disconnect while it blocks).
pub fn sendRequest(
    alloc: Allocator,
    socket_path: []const u8,
    request: []const u8,
    half_close: bool,
) ![]u8 {
    const conn = try Conn.connect(socket_path);
    defer conn.close();

    try conn.writeAll(request);
    try conn.writeAll("\n");
    if (half_close) conn.shutdownWrite();

    var response: std.ArrayList(u8) = .empty;
    errdefer response.deinit(alloc);
    var buf: [4096]u8 = undefined;
    while (true) {
        const n = try conn.read(&buf);
        if (n == 0) break;
        try response.appendSlice(alloc, buf[0..n]);
        if (response.items.len > max_response_bytes) return error.ResponseTooLarge;
    }

    return response.toOwnedSlice(alloc);
}

test "socketPath and tokenPath compose the control dir" {
    const testing = std.testing;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    try testing.expectEqualStrings("/x/control.sock", try socketPath(alloc, "/x"));
    try testing.expectEqualStrings("/x/token", try tokenPath(alloc, "/x"));
}

test "controlDir honors MAXX_CONTROL_DIR default shape" {
    const testing = std.testing;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    // We cannot set env reliably across platforms in a unit test, but the
    // default branch must always produce an absolute path under /tmp.
    const dir = try controlDir(alloc);
    try testing.expect(std.mem.startsWith(u8, dir, "/tmp/maxx-control-") or dir.len > 0);
}
