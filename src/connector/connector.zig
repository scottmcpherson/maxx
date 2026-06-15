//! The connector adapter layer.
//!
//! This subsystem lets configured external trigger sources (starting with Linear
//! and GitHub) turn a structured event payload into a visible Maxx tab launch,
//! while keeping Maxx strictly a runtime/control plane — it owns visible tab
//! orchestration and process launch, never workflow reasoning.
//!
//! The pieces:
//!
//!   * `Adapter` — the source-adapter interface. An adapter parses a raw payload
//!     into a normalized `TriggerEvent`, reading only explicit fields.
//!   * `TriggerEvent` (`Event.zig`) — the normalized, source-agnostic event.
//!   * `Template`/`LaunchTemplate` — the per-connector launch configuration, and
//!     `resolve` which turns a template + event into a `LaunchRequest` (the
//!     concrete command/context/provenance for a tab).
//!   * `linear`, `github` — the starter adapters.
//!
//! Resolving a launch is pure and lives here. *Executing* a launch — sending the
//! resulting `sessions.create` to a running Maxx, receiving webhooks, or
//! fetching payloads over the network — is the runner, intentionally not part of
//! this module yet. See `docs/connector-adapters.md`.

const std = @import("std");

pub const Adapter = @import("Adapter.zig");
pub const TriggerEvent = @import("Event.zig");
pub const Template = @import("Template.zig");
pub const LaunchTemplate = Template.LaunchTemplate;
pub const LaunchRequest = Template.LaunchRequest;
pub const resolve = Template.resolve;

pub const linear = @import("linear.zig");
pub const github = @import("github.zig");

/// All built-in adapters, in display order. A new source adapter is added by
/// writing a `src/connector/<name>.zig` that exposes `pub const adapter: Adapter`
/// and appending it here.
pub const adapters = [_]Adapter{
    linear.adapter,
    github.adapter,
};

/// Look up a built-in adapter by its source name.
pub fn adapterByName(name: []const u8) ?Adapter {
    for (adapters) |a| {
        if (std.mem.eql(u8, a.name, name)) return a;
    }
    return null;
}

test {
    // Pull in every submodule so their tests run under `zig build test`.
    std.testing.refAllDecls(@This());
    _ = Adapter;
    _ = TriggerEvent;
    _ = Template;
    _ = @import("json_helpers.zig");
    _ = linear;
    _ = github;
}

test "adapterByName resolves built-ins and rejects unknown" {
    const testing = std.testing;
    try testing.expectEqualStrings("linear", adapterByName("linear").?.name);
    try testing.expectEqualStrings("github", adapterByName("github").?.name);
    try testing.expect(adapterByName("gitlab") == null);
}

test "every adapter has a unique, non-empty name and description" {
    const testing = std.testing;
    for (adapters, 0..) |a, i| {
        try testing.expect(a.name.len > 0);
        try testing.expect(a.description.len > 0);
        for (adapters[i + 1 ..]) |b| {
            try testing.expect(!std.mem.eql(u8, a.name, b.name));
        }
    }
}

// Enforce the no-inference rule: payload fields that are *not* explicitly
// copied by an adapter must never leak into the event, the prompt, the resolved
// metadata, or the serialized launch request. Both payloads below are stuffed
// with "bait" fields an inference-happy implementation might latch onto —
// branch names, head refs, labels, state, assignees, paths, idle time. None of
// them are fields the adapters copy, so none may appear anywhere downstream.
fn assertNoLeak(alloc: std.mem.Allocator, source: []const u8, payload: []const u8, bait: []const []const u8) !void {
    const testing = std.testing;
    const adapter = adapterByName(source).?;
    const event = try adapter.parse(alloc, payload);

    // Resolve a launch that echoes everything explicit into the request.
    const req = try resolve(alloc, .{
        .command = "agent ${title}",
        .title = "${title}",
    }, event, .{ .launched_at = "2026-06-14T00:00:00Z" });

    var out: std.io.Writer.Allocating = .init(alloc);
    var json: std.json.Stringify = .{ .writer = &out.writer, .options = .{} };
    try json.beginObject();
    try json.objectField("event");
    try event.writeJson(&json);
    try json.objectField("launch");
    try req.writeControlRequest(alloc, &json, .{});
    try json.endObject();
    const serialized = out.written();

    // No bait value may appear in the event, prompt, metadata, or request.
    for (bait) |needle| {
        if (std.mem.indexOf(u8, serialized, needle) != null) {
            std.debug.print("no-inference leak: '{s}' surfaced for {s}\n", .{ needle, source });
            return error.InferenceLeak;
        }
    }

    // Resolved metadata may only use the reserved connector.* provenance keys.
    const reserved = [_][]const u8{
        "connector",
        "connector.event_id",
        "connector.event_type",
        "connector.url",
        "connector.launched_at",
    };
    for (req.metadata) |m| {
        var ok = false;
        for (reserved) |r| {
            if (std.mem.eql(u8, m.key, r)) ok = true;
        }
        try testing.expect(ok);
    }
}

test "no-inference: adapters surface only explicit fields" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    // Bait values live in fields the adapters do not copy (branch, head.ref,
    // labels, state, assignee, path, idle). They must never leak.
    const linear_payload =
        \\{
        \\  "action": "update",
        \\  "type": "Issue",
        \\  "data": {
        \\    "id": "id-1", "identifier": "MAX-99", "title": "Safe Title",
        \\    "url": "https://linear.app/x",
        \\    "branch": "feature/LEAK_BRANCH",
        \\    "state": "LEAK_STATE",
        \\    "labels": ["LEAK_LABEL"],
        \\    "assignee": { "name": "LEAK_ASSIGNEE" },
        \\    "parentId": "LEAK_PARENT"
        \\  }
        \\}
    ;
    try assertNoLeak(alloc, "linear", linear_payload, &.{
        "LEAK_BRANCH",   "LEAK_STATE",  "LEAK_LABEL",
        "LEAK_ASSIGNEE", "LEAK_PARENT", "branch",
        "state",         "labels",
    });

    const github_payload =
        \\{
        \\  "action": "opened",
        \\  "issue": {
        \\    "id": 7, "node_id": "N_1", "number": 3, "title": "Safe Title",
        \\    "html_url": "https://github.com/a/b/issues/3",
        \\    "state": "LEAK_STATE",
        \\    "labels": [{ "name": "LEAK_LABEL" }],
        \\    "assignees": [{ "login": "LEAK_USER" }],
        \\    "head": { "ref": "LEAK_HEAD_REF" }
        \\  },
        \\  "repository": { "full_name": "a/b", "default_branch": "LEAK_DEFAULT_BRANCH" }
        \\}
    ;
    try assertNoLeak(alloc, "github", github_payload, &.{
        "LEAK_STATE",    "LEAK_LABEL",          "LEAK_USER",
        "LEAK_HEAD_REF", "LEAK_DEFAULT_BRANCH", "head",
        "labels",        "assignees",           "default_branch",
    });
}
