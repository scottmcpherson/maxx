//! TriggerEvent is the normalized, source-agnostic representation of an external
//! trigger after a connector adapter has parsed a raw payload.
//!
//! Every field here is an *explicit* value lifted straight from the connector
//! payload. The connector layer never infers workflow meaning: it does not read
//! branch names, paths, process names, tab titles, idle time, or terminal
//! output to decide what an event "means". An adapter only copies fields the
//! payload states outright. See `Adapter.zig` and `docs/connector-adapters.md`
//! for the full no-inference contract.
//!
//! All string memory referenced by a TriggerEvent is owned by the allocator the
//! adapter was given (in practice an arena owned by the caller), so the whole
//! event can be discarded by freeing that arena.

const TriggerEvent = @This();

const std = @import("std");
const Allocator = std.mem.Allocator;

/// Map of extra explicit payload fields, keyed by dotted names like
/// "issue.identifier" or "repo.full_name". Surfaced as launch-template
/// placeholders and as provenance. Insertion order is preserved for stable
/// output.
pub const Fields = std.StringArrayHashMapUnmanaged([]const u8);

/// Connector source name, e.g. "linear" or "github". Set by the adapter and
/// matched against the launch configuration and `+connector --source`.
source: []const u8,

/// Stable identifier for this event from the source (e.g. Linear's `data.id`
/// or GitHub's object node id). Required; used for provenance and de-dup, never
/// interpreted.
id: []const u8,

/// The source's own event/trigger type, taken verbatim from the payload
/// (e.g. "Issue", "issues", "pull_request"). Required. Used for display,
/// provenance, and adapter dispatch only — never to infer workflow intent.
type: []const u8,

/// Human-facing title for the launched tab, copied from explicit payload
/// fields. Required and non-empty.
title: []const u8,

/// Canonical URL back to the source object, when the payload provides one
/// (issue/PR URL). Optional — null when the payload did not include it.
url: ?[]const u8 = null,

/// Prompt/context text the launched command should receive. Assembled only by
/// concatenating explicit payload fields (identifier, title, url, body), never
/// derived from anything Maxx observes. Optional.
prompt: ?[]const u8 = null,

/// Additional explicit fields from the payload. See `Fields`.
fields: Fields = .{},

/// Look up a placeholder name against the event. Well-known names resolve to
/// the typed fields above; anything else falls through to `fields`. Returns
/// null when the value is absent (the caller decides whether that is an error).
pub fn lookup(self: TriggerEvent, name: []const u8) ?[]const u8 {
    if (std.mem.eql(u8, name, "source")) return self.source;
    if (std.mem.eql(u8, name, "id")) return self.id;
    if (std.mem.eql(u8, name, "type")) return self.type;
    if (std.mem.eql(u8, name, "title")) return self.title;
    if (std.mem.eql(u8, name, "url")) return self.url;
    if (std.mem.eql(u8, name, "prompt")) return self.prompt;
    return self.fields.get(name);
}

/// Insert an extra explicit field. Both key and value are duped into `alloc`.
/// A null or empty value is dropped so optional payload fields stay absent
/// rather than present-but-empty.
pub fn putField(
    self: *TriggerEvent,
    alloc: Allocator,
    key: []const u8,
    value: ?[]const u8,
) Allocator.Error!void {
    const v = value orelse return;
    if (v.len == 0) return;
    try self.fields.put(alloc, try alloc.dupe(u8, key), try alloc.dupe(u8, v));
}

/// Write the event as a JSON object for human inspection (`+connector resolve`).
/// This is provenance/debug output, not a wire format.
pub fn writeJson(self: TriggerEvent, json: *std.json.Stringify) !void {
    try json.beginObject();
    try json.objectField("source");
    try json.write(self.source);
    try json.objectField("id");
    try json.write(self.id);
    try json.objectField("type");
    try json.write(self.type);
    try json.objectField("title");
    try json.write(self.title);
    if (self.url) |v| {
        try json.objectField("url");
        try json.write(v);
    }
    if (self.prompt) |v| {
        try json.objectField("prompt");
        try json.write(v);
    }
    if (self.fields.count() > 0) {
        try json.objectField("fields");
        try json.beginObject();
        var it = self.fields.iterator();
        while (it.next()) |entry| {
            try json.objectField(entry.key_ptr.*);
            try json.write(entry.value_ptr.*);
        }
        try json.endObject();
    }
    try json.endObject();
}

test "lookup resolves typed fields and extra fields" {
    const testing = std.testing;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var ev: TriggerEvent = .{
        .source = "linear",
        .id = "abc",
        .type = "Issue",
        .title = "Fix the thing",
        .url = "https://linear.app/x/MAX-10",
    };
    try ev.putField(alloc, "issue.identifier", "MAX-10");

    try testing.expectEqualStrings("linear", ev.lookup("source").?);
    try testing.expectEqualStrings("Fix the thing", ev.lookup("title").?);
    try testing.expectEqualStrings("https://linear.app/x/MAX-10", ev.lookup("url").?);
    try testing.expectEqualStrings("MAX-10", ev.lookup("issue.identifier").?);
    try testing.expect(ev.lookup("prompt") == null);
    try testing.expect(ev.lookup("nonexistent") == null);
}

test "putField drops null and empty values" {
    const testing = std.testing;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var ev: TriggerEvent = .{
        .source = "github",
        .id = "1",
        .type = "issues",
        .title = "T",
    };
    try ev.putField(alloc, "a", null);
    try ev.putField(alloc, "b", "");
    try ev.putField(alloc, "c", "value");
    try testing.expectEqual(@as(usize, 1), ev.fields.count());
    try testing.expectEqualStrings("value", ev.fields.get("c").?);
}
