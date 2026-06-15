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
