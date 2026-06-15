//! Webhook ingestion for tab launch commands.
//!
//! This subsystem lets external event sources trigger preconfigured Maxx tab
//! launches over HTTP, while keeping Maxx strictly a runtime/control plane: it
//! accepts a request on an explicitly configured route, validates the transport
//! (method, content type, size, and a per-route HMAC/token signature), parses
//! the opaque payload with a configured connector adapter, and launches exactly
//! the configured command through the existing Control API. Maxx never decides
//! what a Linear/GitHub/CI event *means* — the route mapping and the launched
//! command own that.
//!
//! The pieces:
//!
//!   * `Config` (`Config.zig`) — the JSON route registry and its validation,
//!     including the bind-safety invariant.
//!   * `auth` (`auth.zig`) — per-route HMAC-SHA256 / shared-token verification.
//!   * `handler` (`handler.zig`) — the pure request pipeline that turns a
//!     received request into a launch (via `runner.dispatch`) and a response.
//!
//! Receiving requests over a real socket — the `std.http.Server` accept loop, the
//! capability token, the dedup store, the environment secrets — is the `+webhook`
//! CLI action (`src/cli/webhook.zig`), kept thin on purpose so this core stays
//! testable without a socket. See `docs/webhook-ingestion.md`.

const std = @import("std");

pub const Config = @import("Config.zig");
pub const auth = @import("auth.zig");
pub const handler = @import("handler.zig");

pub const Request = handler.Request;
pub const Response = handler.Response;
pub const Header = handler.Header;
pub const Deps = handler.Deps;
pub const Result = handler.Result;
pub const handle = handler.handle;
pub const sweepStalePayloadFiles = handler.sweepStalePayloadFiles;
pub const payload_file_env_var = handler.payload_file_env_var;

test {
    std.testing.refAllDecls(@This());
    _ = Config;
    _ = auth;
    _ = handler;
}
