//! Control API policy config validation for `maxx +control policy validate`.
//!
//! This intentionally mirrors the Swift app loader's JSON surface. It validates
//! only explicit policy fields: source id, kind, allow capabilities, confirm
//! capabilities, and confirmation scope. It never derives policy authority from
//! process names, paths, branches, or terminal output.

const std = @import("std");
const Allocator = std.mem.Allocator;

pub const max_config_bytes: usize = 128 * 1024;
const max_sources: usize = 128;

pub const Kind = enum { local, external, webhook, token };
pub const ConfirmScope = enum { always, once_per_source };

const built_in_source_ids = [_][]const u8{
    "local-cli",
    "local-prompt",
    "trusted-automation",
    "readonly-external",
};

const valid_capabilities = [_][]const u8{
    "tabs:list",
    "tabs:spawn",
    "tabs:restart",
    "tabs:focus",
    "tabs:close",
    "input:send",
    "keys:press",
    "output:read",
    "state:set",
    "metadata:set",
    "groups:list",
    "groups:create",
    "automation:trigger",
};

pub const Source = struct {
    id: []const u8,
    kind: Kind,
    allow: []const []const u8 = &.{},
    confirm: []const []const u8 = &.{},
    confirm_scope: ConfirmScope = .always,
};

pub const Config = struct {
    version: u32 = 1,
    sources: []const Source = &.{},
};

pub const Error = error{InvalidConfig} || Allocator.Error;

pub const Diagnostic = struct {
    message: []const u8 = "",
};

fn fail(diag: ?*Diagnostic, alloc: Allocator, comptime fmt: []const u8, args: anytype) Error {
    if (diag) |d| d.message = std.fmt.allocPrint(alloc, fmt, args) catch "out of memory";
    return error.InvalidConfig;
}

pub fn parse(alloc: Allocator, bytes: []const u8, diag: ?*Diagnostic) Error!Config {
    if (bytes.len > max_config_bytes)
        return fail(diag, alloc, "policy config exceeds {d} bytes", .{max_config_bytes});

    const parsed = std.json.parseFromSliceLeaky(std.json.Value, alloc, bytes, .{}) catch
        return fail(diag, alloc, "policy config is not valid JSON", .{});
    if (parsed != .object)
        return fail(diag, alloc, "policy config must be a JSON object", .{});

    const root = parsed.object;
    const version = try parseVersion(alloc, root, diag);
    if (version != 1)
        return fail(diag, alloc, "unsupported policy config version {d}", .{version});

    const sources_val = root.get("sources") orelse
        return fail(diag, alloc, "policy config requires a \"sources\" array", .{});
    if (sources_val != .array)
        return fail(diag, alloc, "\"sources\" must be an array", .{});
    if (sources_val.array.items.len > max_sources)
        return fail(diag, alloc, "policy config has too many sources", .{});

    var sources: std.ArrayList(Source) = .empty;
    for (sources_val.array.items, 0..) |sv, idx| {
        if (sv != .object)
            return fail(diag, alloc, "sources[{d}] must be an object", .{idx});
        const source = try parseSource(alloc, sv.object, idx, diag);

        for (sources.items) |existing| {
            if (std.mem.eql(u8, existing.id, source.id))
                return fail(diag, alloc, "duplicate policy source id \"{s}\"", .{source.id});
        }
        try sources.append(alloc, source);
    }

    return .{
        .version = version,
        .sources = try sources.toOwnedSlice(alloc),
    };
}

fn parseVersion(alloc: Allocator, root: std.json.ObjectMap, diag: ?*Diagnostic) Error!u32 {
    const v = root.get("version") orelse return 1;
    if (v != .integer)
        return fail(diag, alloc, "\"version\" must be an integer", .{});
    if (v.integer < 0 or v.integer > std.math.maxInt(u32))
        return fail(diag, alloc, "\"version\" is out of range", .{});
    return @intCast(v.integer);
}

fn parseSource(
    alloc: Allocator,
    obj: std.json.ObjectMap,
    idx: usize,
    diag: ?*Diagnostic,
) Error!Source {
    const id = getNonEmptyString(obj, "id") orelse
        return fail(diag, alloc, "sources[{d}] requires a non-empty \"id\"", .{idx});
    if (!validSourceID(id))
        return fail(diag, alloc, "invalid policy source id \"{s}\"", .{id});
    if (isBuiltInSourceID(id))
        return fail(diag, alloc, "policy source id \"{s}\" is reserved by Maxx", .{id});

    const kind_str = getNonEmptyString(obj, "kind") orelse
        return fail(diag, alloc, "source \"{s}\" requires a \"kind\"", .{id});
    const kind = std.meta.stringToEnum(Kind, kind_str) orelse
        return fail(diag, alloc, "source \"{s}\" kind must be local, external, webhook, or token", .{id});

    const allow = try parseCapabilities(alloc, obj, "allow", id, diag);
    const confirm = try parseCapabilities(alloc, obj, "confirm", id, diag);
    for (allow) |cap| {
        if (containsString(confirm, cap))
            return fail(diag, alloc, "source \"{s}\" lists capability \"{s}\" in both allow and confirm", .{ id, cap });
    }

    const confirm_scope: ConfirmScope = if (getString(obj, "confirm_scope")) |scope|
        std.meta.stringToEnum(ConfirmScope, scope) orelse
            return fail(diag, alloc, "source \"{s}\" confirm_scope must be always or once_per_source", .{id})
    else
        .always;

    return .{
        .id = try alloc.dupe(u8, id),
        .kind = kind,
        .allow = allow,
        .confirm = confirm,
        .confirm_scope = confirm_scope,
    };
}

fn parseCapabilities(
    alloc: Allocator,
    obj: std.json.ObjectMap,
    field: []const u8,
    source_id: []const u8,
    diag: ?*Diagnostic,
) Error![]const []const u8 {
    const val = obj.get(field) orelse return &.{};
    if (val != .array)
        return fail(diag, alloc, "source \"{s}\" field \"{s}\" must be an array", .{ source_id, field });

    var caps: std.ArrayList([]const u8) = .empty;
    for (val.array.items, 0..) |cv, idx| {
        if (cv != .string)
            return fail(diag, alloc, "source \"{s}\" {s}[{d}] must be a string", .{ source_id, field, idx });
        const cap = cv.string;
        if (!isKnownCapability(cap))
            return fail(diag, alloc, "source \"{s}\" has unknown capability \"{s}\"", .{ source_id, cap });
        if (containsString(caps.items, cap))
            return fail(diag, alloc, "source \"{s}\" repeats capability \"{s}\"", .{ source_id, cap });
        try caps.append(alloc, try alloc.dupe(u8, cap));
    }
    return try caps.toOwnedSlice(alloc);
}

fn isKnownCapability(capability: []const u8) bool {
    for (valid_capabilities) |known| {
        if (std.mem.eql(u8, known, capability)) return true;
    }
    return false;
}

fn isBuiltInSourceID(id: []const u8) bool {
    for (built_in_source_ids) |reserved| {
        if (std.mem.eql(u8, reserved, id)) return true;
    }
    return false;
}

fn containsString(items: []const []const u8, needle: []const u8) bool {
    for (items) |item| {
        if (std.mem.eql(u8, item, needle)) return true;
    }
    return false;
}

fn validSourceID(id: []const u8) bool {
    if (id.len == 0 or id.len > 128) return false;
    for (id) |ch| {
        if (std.ascii.isAlphanumeric(ch) or ch == '-' or ch == '_' or
            ch == '.' or ch == ':' or ch == '/')
        {
            continue;
        }
        return false;
    }
    return true;
}

fn getString(obj: std.json.ObjectMap, name: []const u8) ?[]const u8 {
    const v = obj.get(name) orelse return null;
    return switch (v) {
        .string => |s| s,
        else => null,
    };
}

fn getNonEmptyString(obj: std.json.ObjectMap, name: []const u8) ?[]const u8 {
    const s = getString(obj, name) orelse return null;
    return if (s.len == 0) null else s;
}

test "parse accepts configured webhook source" {
    const testing = std.testing;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var diag: Diagnostic = .{};
    const cfg = try parse(alloc,
        \\{
        \\  "version": 1,
        \\  "sources": [
        \\    {
        \\      "id": "linear-webhook",
        \\      "kind": "webhook",
        \\      "allow": ["tabs:spawn", "groups:create", "state:set"],
        \\      "confirm": ["input:send"],
        \\      "confirm_scope": "once_per_source"
        \\    }
        \\  ]
        \\}
    , &diag);

    try testing.expectEqual(@as(usize, 1), cfg.sources.len);
    try testing.expectEqualStrings("linear-webhook", cfg.sources[0].id);
    try testing.expect(cfg.sources[0].kind == .webhook);
    try testing.expectEqual(@as(usize, 3), cfg.sources[0].allow.len);
    try testing.expectEqualStrings("groups:create", cfg.sources[0].allow[1]);
    try testing.expectEqual(@as(usize, 1), cfg.sources[0].confirm.len);
    try testing.expect(cfg.sources[0].confirm_scope == .once_per_source);
}

test "parse rejects reserved and overlapping sources" {
    const testing = std.testing;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var reserved_diag: Diagnostic = .{};
    try testing.expectError(error.InvalidConfig, parse(alloc,
        \\{"sources":[{"id":"trusted-automation","kind":"webhook","allow":["groups:create"]}]}
    , &reserved_diag));
    try testing.expect(std.mem.indexOf(u8, reserved_diag.message, "reserved") != null);

    var overlap_diag: Diagnostic = .{};
    try testing.expectError(error.InvalidConfig, parse(alloc,
        \\{"sources":[{"id":"linear-webhook","kind":"webhook","allow":["tabs:spawn"],"confirm":["tabs:spawn"]}]}
    , &overlap_diag));
    try testing.expect(std.mem.indexOf(u8, overlap_diag.message, "both allow and confirm") != null);
}
