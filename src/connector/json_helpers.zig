//! Small helpers for reading explicit fields out of a parsed JSON payload.
//!
//! These intentionally only *read* what is present — they never synthesize or
//! infer values. Each returns null when a field is absent or has an unexpected
//! type, leaving the "is this required?" decision to the calling adapter.

const std = @import("std");
const Allocator = std.mem.Allocator;

const Object = std.json.ObjectMap;
const Value = std.json.Value;

/// The string value of `obj[name]`, or null if absent / not a string.
pub fn getString(obj: Object, name: []const u8) ?[]const u8 {
    const v = obj.get(name) orelse return null;
    return switch (v) {
        .string => |s| s,
        else => null,
    };
}

/// The string value of `obj[name]` only when it is present, a string, and
/// non-empty. Use for required fields so an explicitly-empty value (e.g.
/// `"title": ""`) is treated as missing rather than silently accepted.
pub fn getNonEmptyString(obj: Object, name: []const u8) ?[]const u8 {
    const s = getString(obj, name) orelse return null;
    return if (s.len == 0) null else s;
}

/// The nested object at `obj[name]`, or null if absent / not an object.
pub fn getObject(obj: Object, name: []const u8) ?Object {
    const v = obj.get(name) orelse return null;
    return switch (v) {
        .object => |o| o,
        else => null,
    };
}

/// The boolean value of `obj[name]`, or null if absent / not a bool.
pub fn getBool(obj: Object, name: []const u8) ?bool {
    const v = obj.get(name) orelse return null;
    return switch (v) {
        .bool => |b| b,
        else => null,
    };
}

/// A numeric field rendered as a string (e.g. an issue/PR number), or null if
/// absent / not a number. The result is allocated with `alloc`.
pub fn getNumberAsString(alloc: Allocator, obj: Object, name: []const u8) Allocator.Error!?[]const u8 {
    const v = obj.get(name) orelse return null;
    return switch (v) {
        .integer => |n| try std.fmt.allocPrint(alloc, "{d}", .{n}),
        .float => |f| try std.fmt.allocPrint(alloc, "{d}", .{f}),
        // `number_string` carries integers too large for i64 as their raw text.
        .number_string => |s| try alloc.dupe(u8, s),
        else => null,
    };
}

/// The first present string among `obj[name]` for each candidate name. Useful
/// when a payload spells the same explicit field more than one way.
pub fn getStringAny(obj: Object, names: []const []const u8) ?[]const u8 {
    for (names) |name| {
        if (getString(obj, name)) |s| return s;
    }
    return null;
}

test "getString and getObject read explicit fields" {
    const testing = std.testing;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const parsed = try std.json.parseFromSliceLeaky(
        Value,
        alloc,
        \\{"title":"Hi","n":42,"nested":{"key":"v"},"flag":true}
    ,
        .{},
    );
    const obj = parsed.object;

    try testing.expectEqualStrings("Hi", getString(obj, "title").?);
    try testing.expect(getString(obj, "missing") == null);
    try testing.expect(getString(obj, "flag") == null); // wrong type
    try testing.expectEqualStrings("Hi", getNonEmptyString(obj, "title").?);
    try testing.expectEqualStrings("v", getObject(obj, "nested").?.get("key").?.string);
    try testing.expectEqual(true, getBool(obj, "flag").?);
    try testing.expect(getBool(obj, "title") == null);
    try testing.expectEqualStrings("42", (try getNumberAsString(alloc, obj, "n")).?);
    try testing.expect((try getNumberAsString(alloc, obj, "title")) == null);
}

test "getNonEmptyString rejects empty strings" {
    const testing = std.testing;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const parsed = try std.json.parseFromSliceLeaky(
        Value,
        alloc,
        \\{"empty":"","full":"x"}
    ,
        .{},
    );
    const obj = parsed.object;
    try testing.expect(getNonEmptyString(obj, "empty") == null);
    try testing.expect(getNonEmptyString(obj, "missing") == null);
    try testing.expectEqualStrings("x", getNonEmptyString(obj, "full").?);
}

test "getStringAny returns first present" {
    const testing = std.testing;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const parsed = try std.json.parseFromSliceLeaky(
        Value,
        alloc,
        \\{"b":"second"}
    ,
        .{},
    );
    const obj = parsed.object;
    try testing.expectEqualStrings("second", getStringAny(obj, &.{ "a", "b", "c" }).?);
    try testing.expect(getStringAny(obj, &.{ "x", "y" }) == null);
}
