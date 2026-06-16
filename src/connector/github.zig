//! GitHub connector adapter.
//!
//! Parses a GitHub webhook payload for an issue or pull request into a
//! normalized `TriggerEvent`. GitHub delivers the event kind in the
//! `X-GitHub-Event` header rather than the body, so the adapter identifies the
//! object by which explicit key the payload carries — `pull_request` or `issue`.
//! That is structural parsing of the payload's own shape, not inference of
//! workflow intent: the adapter never reads branch names, paths, or process
//! state to decide meaning. It copies only fields the payload states explicitly
//! (title, number, url, body, repo full name) and assembles the prompt from
//! them, including the pull request `merged` boolean when GitHub states it
//! explicitly. See the no-inference contract in `Adapter.zig`.

const std = @import("std");
const Allocator = std.mem.Allocator;

const Adapter = @import("Adapter.zig");
const TriggerEvent = @import("Event.zig");
const j = @import("json_helpers.zig");

const log = std.log.scoped(.connector_github);

pub const adapter: Adapter = .{
    .name = "github",
    .description = "GitHub issue/pull-request webhook payloads",
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

    // Identify the carried object by its explicit key. "pull_request" takes
    // precedence because PR payloads can also carry an "issue"-shaped subset.
    const event_type: []const u8, const obj: std.json.ObjectMap = blk: {
        if (j.getObject(root, "pull_request")) |pr| break :blk .{ "pull_request", pr };
        if (j.getObject(root, "issue")) |issue| break :blk .{ "issue", issue };
        log.warn("payload carries neither \"pull_request\" nor \"issue\"", .{});
        return error.UnsupportedEventType;
    };

    // A stable id: prefer the global node id, fall back to the numeric id.
    const id = j.getNonEmptyString(obj, "node_id") orelse
        (try j.getNumberAsString(alloc, obj, "id")) orelse
        {
            log.warn("object missing both \"node_id\" and \"id\"", .{});
            return error.MissingField;
        };

    const title = j.getNonEmptyString(obj, "title") orelse {
        log.warn("object missing \"title\"", .{});
        return error.MissingField;
    };

    // Optional explicit fields.
    const url = j.getString(obj, "html_url");
    const body = j.getString(obj, "body");
    const number = try j.getNumberAsString(alloc, obj, "number");
    const action = j.getString(root, "action");
    const repo_full_name = if (j.getObject(root, "repository")) |repo|
        j.getString(repo, "full_name")
    else
        null;
    const merged = if (std.mem.eql(u8, event_type, "pull_request"))
        j.getBool(obj, "merged")
    else
        null;

    var event: TriggerEvent = .{
        .source = adapter.name,
        .id = try alloc.dupe(u8, id),
        .type = try alloc.dupe(u8, event_type),
        .title = try alloc.dupe(u8, title),
        .url = if (url) |u| try alloc.dupe(u8, u) else null,
        .prompt = try buildPrompt(alloc, event_type, number, title, url, body),
    };

    try event.putField(alloc, "action", action);
    try event.putField(alloc, "object.type", event_type);
    try event.putField(alloc, "repo.full_name", repo_full_name);
    try event.putField(alloc, "number", number);
    if (std.mem.eql(u8, event_type, "pull_request")) {
        try event.putField(alloc, "pull_request.number", number);
        try event.putBoolField(alloc, "pull_request.merged", merged);
    } else if (std.mem.eql(u8, event_type, "issue")) {
        try event.putField(alloc, "issue.number", number);
    }

    return event;
}

/// Assemble a prompt from explicit payload fields plus a constant "GitHub"
/// source label and a `#` number sigil. No payload field is interpreted or
/// transformed — only copied and joined with fixed separators.
fn buildPrompt(
    alloc: Allocator,
    event_type: []const u8,
    number: ?[]const u8,
    title: []const u8,
    url: ?[]const u8,
    body: ?[]const u8,
) Allocator.Error![]const u8 {
    var out: std.io.Writer.Allocating = .init(alloc);
    errdefer out.deinit();

    // The Allocating writer only fails on OOM; surface that.
    if (number) |n| {
        out.writer.print("GitHub {s} #{s}: {s}", .{ event_type, n, title }) catch return error.OutOfMemory;
    } else {
        out.writer.print("GitHub {s}: {s}", .{ event_type, title }) catch return error.OutOfMemory;
    }
    if (url) |u| out.writer.print("\n{s}", .{u}) catch return error.OutOfMemory;
    if (body) |b| out.writer.print("\n\n{s}", .{b}) catch return error.OutOfMemory;

    return out.written();
}

const issue_fixture =
    \\{
    \\  "action": "opened",
    \\  "issue": {
    \\    "id": 2200000010,
    \\    "node_id": "I_kwDOAbcdef4ABCDE",
    \\    "number": 42,
    \\    "title": "Crash when opening a tab",
    \\    "body": "Steps to reproduce: open a tab and it crashes.",
    \\    "html_url": "https://github.com/maxx/maxx/issues/42"
    \\  },
    \\  "repository": { "full_name": "maxx/maxx" }
    \\}
;

const pr_fixture =
    \\{
    \\  "action": "synchronize",
    \\  "pull_request": {
    \\    "id": 99,
    \\    "node_id": "PR_kwDOzzzz",
    \\    "number": 7,
    \\    "title": "Add connector adapter layer",
    \\    "body": "Implements MAX-10.",
    \\    "html_url": "https://github.com/maxx/maxx/pull/7",
    \\    "merged": true
    \\  },
    \\  "repository": { "full_name": "maxx/maxx" }
    \\}
;

test "github: parses an issue webhook" {
    const testing = std.testing;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const ev = try adapter.parse(alloc, issue_fixture);
    try testing.expectEqualStrings("github", ev.source);
    try testing.expectEqualStrings("I_kwDOAbcdef4ABCDE", ev.id);
    try testing.expectEqualStrings("issue", ev.type);
    try testing.expectEqualStrings("Crash when opening a tab", ev.title);
    try testing.expectEqualStrings("https://github.com/maxx/maxx/issues/42", ev.url.?);
    try testing.expectEqualStrings("issue", ev.fields.get("object.type").?.string);
    try testing.expectEqualStrings("42", ev.fields.get("number").?.string);
    try testing.expectEqualStrings("42", ev.fields.get("issue.number").?.string);
    try testing.expectEqualStrings("maxx/maxx", ev.fields.get("repo.full_name").?.string);
    try testing.expectEqualStrings("opened", ev.fields.get("action").?.string);
    try testing.expect(std.mem.indexOf(u8, ev.prompt.?, "#42") != null);
}

test "github: parses a pull_request webhook and prefers it over issue subset" {
    const testing = std.testing;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const ev = try adapter.parse(alloc, pr_fixture);
    try testing.expectEqualStrings("pull_request", ev.type);
    try testing.expectEqualStrings("Add connector adapter layer", ev.title);
    try testing.expectEqualStrings("https://github.com/maxx/maxx/pull/7", ev.url.?);
    try testing.expectEqualStrings("pull_request", ev.fields.get("object.type").?.string);
    try testing.expectEqualStrings("7", ev.fields.get("number").?.string);
    try testing.expectEqualStrings("7", ev.fields.get("pull_request.number").?.string);
    try testing.expectEqual(true, ev.fields.get("pull_request.merged").?.bool);
}

test "github: falls back to numeric id when node_id absent" {
    const testing = std.testing;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const payload =
        \\{"issue":{"id":12345,"number":1,"title":"T"}}
    ;
    const ev = try adapter.parse(alloc, payload);
    try testing.expectEqualStrings("12345", ev.id);
}

test "github: payload without issue or pull_request is unsupported" {
    const testing = std.testing;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const payload =
        \\{"action":"created","repository":{"full_name":"a/b"}}
    ;
    try testing.expectError(error.UnsupportedEventType, adapter.parse(alloc, payload));
}

test "github: missing title fails clearly" {
    const testing = std.testing;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const payload =
        \\{"issue":{"id":1,"number":1}}
    ;
    try testing.expectError(error.MissingField, adapter.parse(alloc, payload));
}
