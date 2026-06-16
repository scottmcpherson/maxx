//! Explicit trigger predicates over connector event fields.
//!
//! Predicates compare only fields that an adapter copied into `TriggerEvent`.
//! They never inspect raw payload text, process state, terminal output, or any
//! Maxx-derived workflow signal.

const Predicate = @This();

const std = @import("std");
const TriggerEvent = @import("Event.zig");

pub const Op = enum {
    /// Exact string equality against a string field.
    equals,
    /// Exact boolean equality against a boolean field.
    equals_bool,
    /// Field must be present with any explicit value.
    present,
};

field: []const u8,
op: Op,
string_value: ?[]const u8 = null,
bool_value: bool = false,

pub const Mismatch = struct {
    field: []const u8,
};

pub fn equals(field: []const u8, value: []const u8) Predicate {
    return .{ .field = field, .op = .equals, .string_value = value };
}

pub fn equalsBool(field: []const u8, value: bool) Predicate {
    return .{ .field = field, .op = .equals_bool, .bool_value = value };
}

pub fn present(field: []const u8) Predicate {
    return .{ .field = field, .op = .present };
}

pub fn matches(self: Predicate, event: TriggerEvent) bool {
    const value = event.lookupValue(self.field) orelse return false;
    return switch (self.op) {
        .present => true,
        .equals => switch (value) {
            .string => |actual| std.mem.eql(u8, actual, self.string_value orelse ""),
            .bool => false,
        },
        .equals_bool => switch (value) {
            .string => false,
            .bool => |actual| actual == self.bool_value,
        },
    };
}

pub fn firstMismatch(predicates: []const Predicate, event: TriggerEvent) ?Mismatch {
    for (predicates) |p| {
        if (!p.matches(event)) return .{ .field = p.field };
    }
    return null;
}

pub fn writeJson(self: Predicate, json: *std.json.Stringify) !void {
    try json.beginObject();
    try json.objectField("field");
    try json.write(self.field);
    switch (self.op) {
        .equals => {
            try json.objectField("equals");
            try json.write(self.string_value orelse "");
        },
        .equals_bool => {
            try json.objectField("equals_bool");
            try json.write(self.bool_value);
        },
        .present => {
            try json.objectField("present");
            try json.write(true);
        },
    }
    try json.endObject();
}

const testing = std.testing;

test "predicates match string equality, boolean equality, and presence" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var ev: TriggerEvent = .{
        .source = "github",
        .id = "PR_kwDOzzzz",
        .type = "pull_request",
        .title = "Merge cleanup",
    };
    try ev.putField(alloc, "repo.full_name", "org/repo");
    try ev.putBoolField(alloc, "pull_request.merged", true);

    try testing.expect(equals("repo.full_name", "org/repo").matches(ev));
    try testing.expect(equalsBool("pull_request.merged", true).matches(ev));
    try testing.expect(present("title").matches(ev));
    try testing.expect(firstMismatch(&.{
        equals("type", "pull_request"),
        equalsBool("pull_request.merged", true),
        present("repo.full_name"),
    }, ev) == null);
}

test "predicates treat missing fields and wrong types as mismatches" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var ev: TriggerEvent = .{
        .source = "github",
        .id = "1",
        .type = "pull_request",
        .title = "T",
    };
    try ev.putField(alloc, "string.true", "true");
    try ev.putBoolField(alloc, "bool.true", true);

    try testing.expect(!equals("missing", "x").matches(ev));
    try testing.expect(!present("missing").matches(ev));
    try testing.expect(!equalsBool("string.true", true).matches(ev));
    try testing.expect(!equals("bool.true", "true").matches(ev));

    const mismatch = firstMismatch(&.{equalsBool("string.true", true)}, ev).?;
    try testing.expectEqualStrings("string.true", mismatch.field);
}
