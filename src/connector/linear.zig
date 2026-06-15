//! Linear connector adapter.
//!
//! Parses a Linear webhook/event payload (the canonical
//! `{ type, action, data: { ... }, url }` envelope Linear delivers) into a
//! normalized `TriggerEvent`. It copies only fields Linear states explicitly —
//! issue id, title, identifier, url, description, team key — and assembles the
//! prompt by concatenating them. It assigns no Maxx meaning to "issue": the word
//! is just a label on a bag of payload fields. See the no-inference contract in
//! `Adapter.zig`.

const std = @import("std");
const Allocator = std.mem.Allocator;

const Adapter = @import("Adapter.zig");
const TriggerEvent = @import("Event.zig");
const j = @import("json_helpers.zig");

const log = std.log.scoped(.connector_linear);

pub const adapter: Adapter = .{
    .name = "linear",
    .description = "Linear issue/event webhook payloads",
    .parseFn = parse,
};

fn parse(alloc: Allocator, payload: []const u8) Adapter.Error!TriggerEvent {
    const parsed = std.json.parseFromSliceLeaky(
        std.json.Value,
        alloc,
        payload,
        .{},
    ) catch {
        return error.InvalidPayload;
    };
    if (parsed != .object) return error.InvalidPayload;
    const root = parsed.object;

    // The event type is the top-level discriminator (e.g. "Issue").
    const event_type = j.getNonEmptyString(root, "type") orelse {
        log.warn("payload missing top-level \"type\"", .{});
        return error.MissingField;
    };

    const data = j.getObject(root, "data") orelse {
        log.warn("payload missing \"data\" object", .{});
        return error.MissingField;
    };

    const id = j.getNonEmptyString(data, "id") orelse {
        log.warn("payload missing \"data.id\"", .{});
        return error.MissingField;
    };

    const title = j.getNonEmptyString(data, "title") orelse {
        log.warn("payload missing \"data.title\"", .{});
        return error.MissingField;
    };

    // Optional explicit fields.
    const identifier = j.getString(data, "identifier");
    const url = j.getString(data, "url") orelse j.getString(root, "url");
    const description = j.getString(data, "description");
    const action = j.getString(root, "action");
    const team_key = if (j.getObject(data, "team")) |team| j.getString(team, "key") else null;

    var event: TriggerEvent = .{
        .source = adapter.name,
        .id = try alloc.dupe(u8, id),
        .type = try alloc.dupe(u8, event_type),
        .title = try alloc.dupe(u8, title),
        .url = if (url) |u| try alloc.dupe(u8, u) else null,
        .prompt = try buildPrompt(alloc, event_type, identifier, title, url, description),
    };

    try event.putField(alloc, "action", action);
    try event.putField(alloc, "issue.identifier", identifier);
    try event.putField(alloc, "issue.url", url);
    try event.putField(alloc, "team.key", team_key);

    return event;
}

/// Assemble a prompt from explicit payload fields plus a constant "Linear"
/// source label. No payload field is interpreted or transformed — only copied
/// and joined with fixed separators.
fn buildPrompt(
    alloc: Allocator,
    event_type: []const u8,
    identifier: ?[]const u8,
    title: []const u8,
    url: ?[]const u8,
    description: ?[]const u8,
) Allocator.Error![]const u8 {
    var out: std.io.Writer.Allocating = .init(alloc);
    errdefer out.deinit();

    // The Allocating writer only fails on OOM; surface that.
    if (identifier) |ident| {
        out.writer.print("Linear {s} {s}: {s}", .{ event_type, ident, title }) catch return error.OutOfMemory;
    } else {
        out.writer.print("Linear {s}: {s}", .{ event_type, title }) catch return error.OutOfMemory;
    }
    if (url) |u| out.writer.print("\n{s}", .{u}) catch return error.OutOfMemory;
    if (description) |d| out.writer.print("\n\n{s}", .{d}) catch return error.OutOfMemory;

    return out.written();
}

const fixture =
    \\{
    \\  "action": "create",
    \\  "type": "Issue",
    \\  "createdAt": "2026-06-14T11:35:16.578Z",
    \\  "data": {
    \\    "id": "e8f3c1a2-0000-4444-8888-000000000010",
    \\    "identifier": "MAX-10",
    \\    "title": "Implement connector adapter layer",
    \\    "description": "Build a connector adapter layer.",
    \\    "url": "https://linear.app/maxx/issue/MAX-10/implement-connector-adapter-layer",
    \\    "team": { "key": "MAX", "name": "Maxx" }
    \\  },
    \\  "url": "https://linear.app/maxx/issue/MAX-10/implement-connector-adapter-layer"
    \\}
;

test "linear: parses a representative issue webhook" {
    const testing = std.testing;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const ev = try adapter.parse(alloc, fixture);
    try testing.expectEqualStrings("linear", ev.source);
    try testing.expectEqualStrings("e8f3c1a2-0000-4444-8888-000000000010", ev.id);
    try testing.expectEqualStrings("Issue", ev.type);
    try testing.expectEqualStrings("Implement connector adapter layer", ev.title);
    try testing.expectEqualStrings(
        "https://linear.app/maxx/issue/MAX-10/implement-connector-adapter-layer",
        ev.url.?,
    );
    try testing.expectEqualStrings("MAX-10", ev.fields.get("issue.identifier").?);
    try testing.expectEqualStrings("MAX", ev.fields.get("team.key").?);
    try testing.expectEqualStrings("create", ev.fields.get("action").?);

    // The prompt is just explicit fields concatenated.
    try testing.expect(std.mem.indexOf(u8, ev.prompt.?, "MAX-10") != null);
    try testing.expect(std.mem.indexOf(u8, ev.prompt.?, "Implement connector adapter layer") != null);
    try testing.expect(std.mem.indexOf(u8, ev.prompt.?, "Build a connector adapter layer.") != null);
}

test "linear: missing required field fails clearly" {
    const testing = std.testing;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    // data.title is required.
    const bad =
        \\{"type":"Issue","data":{"id":"x"}}
    ;
    try testing.expectError(error.MissingField, adapter.parse(alloc, bad));
}

test "linear: non-JSON payload fails clearly" {
    const testing = std.testing;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    try testing.expectError(error.InvalidPayload, adapter.parse(alloc, "not json"));
    try testing.expectError(error.InvalidPayload, adapter.parse(alloc, "[1,2,3]"));
}

test "linear: url falls back to top-level when data.url absent" {
    const testing = std.testing;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const payload =
        \\{"type":"Issue","url":"https://linear.app/top","data":{"id":"i","title":"T"}}
    ;
    const ev = try adapter.parse(alloc, payload);
    try testing.expectEqualStrings("https://linear.app/top", ev.url.?);
}
