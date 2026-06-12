//! Shared plumbing for subcommands that drive the running app's AppleScript
//! interface via osascript. Only works on macOS, inside terminals created by
//! the app (which inject GHOSTTY_AGENT_SURFACE_ID).

const std = @import("std");

const Allocator = std.mem.Allocator;

/// Bundle id used when the inherited __CFBundleIdentifier is unavailable.
pub const default_bundle_id = "com.scottmcpherson.mosttly-ghostty";

/// Requires the surface id env var that marks "inside a Mosttly terminal".
pub fn requireSurfaceId(alloc: Allocator) ![]const u8 {
    return try envOwned(alloc, "GHOSTTY_AGENT_SURFACE_ID") orelse {
        fail(
            "this command must be run inside a Mosttly terminal " ++
                "(GHOSTTY_AGENT_SURFACE_ID is not set)",
            .{},
        );
    };
}

/// The bundle id of the app that owns this terminal.
pub fn appId(alloc: Allocator) ![]const u8 {
    return try envOwned(alloc, "__CFBundleIdentifier") orelse default_bundle_id;
}

/// Renders a script template by substituting the %APP_ID% placeholder. The
/// bundle id must be embedded as a literal because `tell application` needs
/// one for compile-time terminology resolution; everything else is passed via
/// argv so nothing needs escaping into the script source.
pub fn renderScript(alloc: Allocator, template: []const u8, app_id: []const u8) ![]const u8 {
    return try std.mem.replaceOwned(
        u8,
        alloc,
        template,
        "%APP_ID%",
        try escapeAppleScriptString(alloc, app_id),
    );
}

/// Runs a rendered script through osascript with the given argv items and
/// returns trimmed stdout. Exits with the script's error message on failure.
pub fn runScript(alloc: Allocator, script: []const u8, args: []const []const u8) ![]const u8 {
    var argv: std.ArrayListUnmanaged([]const u8) = .empty;
    try argv.appendSlice(alloc, &.{ "/usr/bin/osascript", "-e", script });
    try argv.appendSlice(alloc, args);

    const result = std.process.Child.run(.{
        .allocator = alloc,
        .argv = argv.items,
    }) catch |err| {
        fail("failed to run osascript: {}", .{err});
    };

    switch (result.term) {
        .Exited => |code| if (code != 0) {
            const message = std.mem.trim(u8, result.stderr, &std.ascii.whitespace);
            fail("{s}", .{message});
        },
        else => fail("osascript terminated abnormally", .{}),
    }

    return std.mem.trim(u8, result.stdout, &std.ascii.whitespace);
}

pub fn escapeAppleScriptString(alloc: Allocator, value: []const u8) Allocator.Error![]const u8 {
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

pub fn envOwned(alloc: Allocator, key: []const u8) !?[]const u8 {
    return std.process.getEnvVarOwned(alloc, key) catch |err| switch (err) {
        error.EnvironmentVariableNotFound => null,
        else => return err,
    };
}

pub fn fail(comptime fmt: []const u8, args: anytype) noreturn {
    var buffer: [4096]u8 = undefined;
    var stderr = std.fs.File.stderr().writer(&buffer);
    stderr.interface.print("error: " ++ fmt ++ "\n", args) catch {};
    stderr.interface.flush() catch {};
    std.process.exit(1);
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

test "render script substitutes app id" {
    const testing = std.testing;
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const rendered = try renderScript(arena, "tell application id \"%APP_ID%\"", "com.x.y");
    try testing.expectEqualStrings("tell application id \"com.x.y\"", rendered);
}
