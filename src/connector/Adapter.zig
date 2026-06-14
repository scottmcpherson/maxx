//! The connector adapter interface.
//!
//! A connector adapter turns a raw, source-specific trigger payload — the JSON
//! a system like Linear or GitHub delivers — into a normalized `TriggerEvent`.
//! That is the adapter's *entire* job: validate the payload shape just enough to
//! pull out the explicit fields a launch needs, assemble the prompt/context from
//! those fields, and surface a clear error when a required field is missing.
//!
//! Adapters are deliberately tiny and value-typed: each is a `pub const adapter:
//! Adapter` exposed by its own file (see `linear.zig`, `github.zig`). Adding a
//! new source means writing one such file and registering it in `connector.zig`.
//!
//! ## The no-inference contract
//!
//! An adapter MUST NOT:
//!
//!   * infer workflow intent from branch names, file paths, process names, tab
//!     titles, idle time, or any other incidental signal;
//!   * scrape, regex, or otherwise interpret terminal output;
//!   * attach Maxx domain meaning to source concepts — an "issue", "pull
//!     request", "worktree", "branch", or "test" is just a bag of payload
//!     fields to copy, never a Maxx object with behavior.
//!
//! An adapter MAY only read fields the payload states explicitly. Any reasoning
//! about what those fields mean belongs downstream, in the launched command's
//! agent prompt, skill, or upstream connector configuration — not here.

const Adapter = @This();

const std = @import("std");
const Allocator = std.mem.Allocator;
const TriggerEvent = @import("Event.zig");

/// Errors an adapter can raise while parsing a payload. They map to actionable
/// CLI messages; the connector layer never swallows them silently.
pub const Error = error{
    /// The payload was not valid JSON, or was not a JSON object.
    InvalidPayload,
    /// A field this adapter requires was missing or had the wrong type.
    MissingField,
    /// The payload's event/trigger type is not one this adapter handles.
    UnsupportedEventType,
} || Allocator.Error;

/// Stable connector source name. Matches `TriggerEvent.source`, the
/// `+connector --source` flag, and the launch configuration's source.
name: []const u8,

/// One-line human description, shown by `+connector list`.
description: []const u8,

/// Parse a raw payload into a normalized event. Every string referenced by the
/// returned event must be allocated with `alloc` (typically a caller-owned
/// arena), so freeing that arena frees the event.
parseFn: *const fn (alloc: Allocator, payload: []const u8) Error!TriggerEvent,

/// Parse a raw payload into a normalized event.
pub fn parse(self: Adapter, alloc: Allocator, payload: []const u8) Error!TriggerEvent {
    return self.parseFn(alloc, payload);
}
