//! Polling trigger adapter for the automation trigger runner.
//!
//! A polling trigger runs an explicit, user-configured *check* command and fires
//! only when that command's exit status matches a configured contract. The
//! check's stdout is then treated as the structured event payload handed to a
//! connector adapter — exactly the same payload a webhook or local script would
//! deliver.
//!
//! The no-inference boundary is precise and load-bearing:
//!
//!   * The decision to fire is the **configured exit-code contract** only. The
//!     runner never scrapes, regexes, or otherwise interprets the check's output
//!     to decide whether something "happened".
//!   * The check's stdout is an **opaque structured payload**. The runner does
//!     not read it to infer meaning; it forwards it verbatim to the configured
//!     adapter, which copies only explicit fields.
//!
//! So a check is a pure data source: "exit 0 (or a configured code) means an
//! event occurred; here is its payload on stdout." What the event *means* is the
//! adapter's and the launched command's concern, never the runner's.

const std = @import("std");
const builtin = @import("builtin");
const Allocator = std.mem.Allocator;

/// The contract that decides whether a check run counts as "fired".
pub const FireContract = struct {
    /// Exit codes that mean an event fired. Defaults to `{0}`. Any other clean
    /// exit is treated as "no event" (idle), not an error.
    fire_on: []const u8 = &.{0},
};

pub const Outcome = union(enum) {
    /// The check fired; `payload` is its stdout (caller owns it).
    fired: []const u8,
    /// The check ran cleanly but its exit code was not in the fire contract.
    idle: u8,
};

pub const Error = error{
    /// The check process could not be spawned (bad path, permissions, …).
    SpawnFailed,
    /// The check did not exit normally (killed by a signal, stopped). Without a
    /// clean exit code the fire contract cannot be evaluated.
    AbnormalExit,
} || Allocator.Error;

/// Largest amount of check stdout we will buffer as a payload.
pub const default_max_output: usize = 4 * 1024 * 1024;

pub const StopSignal = struct {
    ctx: *anyopaque,
    shouldStopFn: *const fn (ctx: *anyopaque) bool,

    pub fn shouldStop(self: StopSignal) bool {
        return self.shouldStopFn(self.ctx);
    }
};

pub const InterruptibleError = Error || error{ Canceled, OutputTooLarge };

/// Smallest retry delay after a failed watch-mode check. Even if the requested
/// poll interval is tiny, failures wait at least this long so a broken command
/// cannot spin.
pub const default_min_failure_delay_ms: u64 = 1000;

/// Default cap for repeated failure backoff. Tied to the configured interval so
/// slow pollers do not retry far more aggressively on failure than on success,
/// while fast pollers still get a practical upper bound.
pub fn defaultMaxBackoffMs(interval_ms: u64) u64 {
    return @max(30_000, @min(interval_ms *| 5, 5 * 60_000));
}

/// Exponential failure backoff for watch mode. Success resets the counter; each
/// failure doubles from `max(interval, 1s)` up to the configured cap.
pub const FailureBackoff = struct {
    interval_ms: u64,
    max_ms: u64,
    failures: u8 = 0,

    pub fn init(interval_ms: u64, max_ms: u64) FailureBackoff {
        const min_delay = @max(interval_ms, default_min_failure_delay_ms);
        return .{
            .interval_ms = interval_ms,
            .max_ms = @max(max_ms, min_delay),
        };
    }

    pub fn recordSuccess(self: *FailureBackoff) void {
        self.failures = 0;
    }

    pub fn nextDelayMs(self: *FailureBackoff) u64 {
        const min_delay = @max(self.interval_ms, default_min_failure_delay_ms);
        const exponent: u8 = @min(self.failures, 16);
        self.failures = self.failures +| 1;

        var delay = min_delay;
        var i: u8 = 0;
        while (i < exponent and delay < self.max_ms) : (i += 1) {
            delay = @min(delay *| 2, self.max_ms);
        }
        return @min(delay, self.max_ms);
    }
};

/// Run `argv` as the check and evaluate the fire contract. `argv` is the literal
/// command vector — the CLI builds `{ "/bin/sh", "-c", <command> }` for a shell
/// string. `cwd` optionally sets the check's working directory. Returns `.fired`
/// with captured stdout, or `.idle` with the non-matching exit code.
pub fn runCheck(
    alloc: Allocator,
    argv: []const []const u8,
    cwd: ?[]const u8,
    contract: FireContract,
    max_output: usize,
) Error!Outcome {
    const result = std.process.Child.run(.{
        .allocator = alloc,
        .argv = argv,
        .cwd = cwd,
        .max_output_bytes = max_output,
    }) catch {
        return error.SpawnFailed;
    };
    // We only need stdout (the payload); free stderr.
    alloc.free(result.stderr);

    switch (result.term) {
        .Exited => |code| {
            for (contract.fire_on) |fc| {
                if (code == fc) return .{ .fired = result.stdout };
            }
            alloc.free(result.stdout);
            return .{ .idle = code };
        },
        else => {
            alloc.free(result.stdout);
            return error.AbnormalExit;
        },
    }
}

/// Run a check like `runCheck`, but let a long-running watch-mode caller cancel
/// the child when shutdown is requested. POSIX pipes are drained while waiting so
/// a verbose check cannot block forever on a full stdout/stderr pipe.
pub fn runCheckInterruptible(
    alloc: Allocator,
    argv: []const []const u8,
    cwd: ?[]const u8,
    contract: FireContract,
    max_output: usize,
    stop: StopSignal,
) InterruptibleError!Outcome {
    if (comptime builtin.os.tag == .windows) {
        if (stop.shouldStop()) return error.Canceled;
        return runCheck(alloc, argv, cwd, contract, max_output);
    }

    var child = std.process.Child.init(argv, alloc);
    child.cwd = cwd;
    child.stdout_behavior = .Pipe;
    child.stderr_behavior = .Pipe;
    child.stdin_behavior = .Ignore;
    child.spawn() catch return error.SpawnFailed;
    errdefer _ = child.kill() catch {};

    const stdout_file = child.stdout.?;
    const stderr_file = child.stderr.?;
    setNonBlocking(stdout_file);
    setNonBlocking(stderr_file);

    var stdout: std.ArrayList(u8) = .empty;
    errdefer stdout.deinit(alloc);
    var term: std.process.Child.Term = undefined;

    while (true) {
        drainToList(alloc, stdout_file, &stdout, max_output) catch |err| switch (err) {
            error.OutOfMemory => return error.OutOfMemory,
            error.OutputTooLarge => return error.OutputTooLarge,
            else => return error.SpawnFailed,
        };
        drainDiscard(stderr_file) catch return error.SpawnFailed;

        const waited = std.posix.waitpid(child.id, std.posix.W.NOHANG);
        if (waited.pid != 0) {
            term = termFromStatus(waited.status);
            break;
        }

        if (stop.shouldStop()) {
            _ = child.kill() catch {};
            return error.Canceled;
        }

        std.Thread.sleep(10 * std.time.ns_per_ms);
    }

    // The child is reaped, but its pipes may still contain buffered output.
    drainToList(alloc, stdout_file, &stdout, max_output) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        error.OutputTooLarge => return error.OutputTooLarge,
        else => return error.SpawnFailed,
    };
    drainDiscard(stderr_file) catch return error.SpawnFailed;

    child.term = term;
    _ = child.wait() catch {};

    switch (term) {
        .Exited => |code| {
            for (contract.fire_on) |fc| {
                if (code == fc) return .{ .fired = try stdout.toOwnedSlice(alloc) };
            }
            stdout.deinit(alloc);
            return .{ .idle = code };
        },
        else => {
            stdout.deinit(alloc);
            return error.AbnormalExit;
        },
    }
}

fn setNonBlocking(file: std.fs.File) void {
    const flags = std.posix.fcntl(file.handle, std.posix.F.GETFL, 0) catch return;
    const nonblock_bit: usize = 1 << @bitOffsetOf(std.posix.O, "NONBLOCK");
    _ = std.posix.fcntl(file.handle, std.posix.F.SETFL, flags | nonblock_bit) catch {};
}

const DrainError = error{
    OutputTooLarge,
    ReadFailed,
} || Allocator.Error;

fn drainToList(alloc: Allocator, file: std.fs.File, out: *std.ArrayList(u8), max_output: usize) DrainError!void {
    var buf: [4096]u8 = undefined;
    while (true) {
        const n = file.read(&buf) catch |err| switch (err) {
            error.WouldBlock => return,
            else => return error.ReadFailed,
        };
        if (n == 0) return;
        if (out.items.len + n > max_output) return error.OutputTooLarge;
        try out.appendSlice(alloc, buf[0..n]);
    }
}

fn drainDiscard(file: std.fs.File) error{ReadFailed}!void {
    var buf: [4096]u8 = undefined;
    while (true) {
        const n = file.read(&buf) catch |err| switch (err) {
            error.WouldBlock => return,
            else => return error.ReadFailed,
        };
        if (n == 0) return;
    }
}

fn termFromStatus(status: u32) std.process.Child.Term {
    return if (std.posix.W.IFEXITED(status))
        .{ .Exited = std.posix.W.EXITSTATUS(status) }
    else if (std.posix.W.IFSIGNALED(status))
        .{ .Signal = std.posix.W.TERMSIG(status) }
    else if (std.posix.W.IFSTOPPED(status))
        .{ .Stopped = std.posix.W.STOPSIG(status) }
    else
        .{ .Unknown = status };
}

/// Build the conventional shell argv for a check command string.
pub fn shellArgv(command: []const u8) [3][]const u8 {
    return .{ "/bin/sh", "-c", command };
}

// ----- tests -----

const testing = std.testing;

test "check that exits 0 fires and captures stdout payload" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const argv = shellArgv("printf '{\"type\":\"Issue\"}'; exit 0");
    const outcome = try runCheck(alloc, &argv, null, .{}, default_max_output);
    switch (outcome) {
        .fired => |payload| try testing.expectEqualStrings("{\"type\":\"Issue\"}", payload),
        .idle => return error.TestUnexpectedResult,
    }
}

test "check with non-matching exit code is idle, not an error" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const argv = shellArgv("echo nothing; exit 7");
    const outcome = try runCheck(alloc, &argv, null, .{}, default_max_output);
    switch (outcome) {
        .fired => return error.TestUnexpectedResult,
        .idle => |code| try testing.expectEqual(@as(u8, 7), code),
    }
}

test "configured fire_on code fires on that code" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const argv = shellArgv("printf payload; exit 3");
    const outcome = try runCheck(alloc, &argv, null, .{ .fire_on = &.{3} }, default_max_output);
    switch (outcome) {
        .fired => |payload| try testing.expectEqualStrings("payload", payload),
        .idle => return error.TestUnexpectedResult,
    }
}

test "unspawnable check reports SpawnFailed" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const argv = [_][]const u8{"/nonexistent/definitely/not/here"};
    try testing.expectError(error.SpawnFailed, runCheck(alloc, &argv, null, .{}, default_max_output));
}

test "interruptible check cancels and reaps a running child" {
    const StopAfterOne = struct {
        calls: usize = 0,

        fn shouldStop(ctx: *anyopaque) bool {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            self.calls += 1;
            return self.calls > 1;
        }
    };

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var stopper = StopAfterOne{};
    const argv = shellArgv("sleep 30");
    try testing.expectError(
        error.Canceled,
        runCheckInterruptible(
            alloc,
            &argv,
            null,
            .{},
            default_max_output,
            .{ .ctx = &stopper, .shouldStopFn = StopAfterOne.shouldStop },
        ),
    );
}

test "interruptible check preserves output size failures" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const NeverStop = struct {
        fn shouldStop(_: *anyopaque) bool {
            return false;
        }
    };

    var stopper: u8 = 0;
    const argv = shellArgv("printf 'abcdef'");
    try testing.expectError(
        error.OutputTooLarge,
        runCheckInterruptible(
            alloc,
            &argv,
            null,
            .{},
            3,
            .{ .ctx = &stopper, .shouldStopFn = NeverStop.shouldStop },
        ),
    );
}

test "failure backoff doubles from interval and resets on success" {
    var b = FailureBackoff.init(500, 4000);
    try testing.expectEqual(@as(u64, 1000), b.nextDelayMs());
    try testing.expectEqual(@as(u64, 2000), b.nextDelayMs());
    try testing.expectEqual(@as(u64, 4000), b.nextDelayMs());
    try testing.expectEqual(@as(u64, 4000), b.nextDelayMs());

    b.recordSuccess();
    try testing.expectEqual(@as(u64, 1000), b.nextDelayMs());
}

test "failure backoff uses interval as the first delay for slower pollers" {
    var b = FailureBackoff.init(60_000, defaultMaxBackoffMs(60_000));
    try testing.expectEqual(@as(u64, 60_000), b.nextDelayMs());
    try testing.expectEqual(@as(u64, 120_000), b.nextDelayMs());
    try testing.expectEqual(@as(u64, 240_000), b.nextDelayMs());
    try testing.expectEqual(@as(u64, 300_000), b.nextDelayMs());
}
