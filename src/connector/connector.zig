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
