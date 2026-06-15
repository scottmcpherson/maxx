//! Per-route webhook request authentication.
//!
//! This is transport-level validation only: it proves a request was signed with
//! a configured shared secret, nothing more. It never inspects what the payload
//! *means* — that stays with the upstream system and the explicit route
//! configuration (see `docs/no-inference.md`). Two schemes are supported, both
//! configured per route without any provider-specific workflow logic:
//!
//!   * `.hmac` — HMAC-SHA256 over the raw request body, hex-encoded, compared
//!     against a configured request header (GitHub/Linear-style signatures).
//!   * `.token` — a shared secret compared against a configured request header
//!     (a simple bearer-style check for relays/tunnels that cannot sign bodies).
//!
//! All comparisons are constant-time so a caller cannot probe the secret a byte
//! at a time. A route may also opt out with `.none`, which the config layer
//! permits only on a loopback bind (an unauthenticated local command launcher
//! must never be exposed off-host).

const std = @import("std");
const HmacSha256 = std.crypto.auth.hmac.sha2.HmacSha256;

/// How a route authenticates incoming requests.
pub const Mode = enum {
    /// No authentication. Permitted by the config layer only on a loopback bind.
    none,
    /// Shared-secret token compared (constant-time) against a header value.
    token,
    /// HMAC-SHA256 over the raw body, hex-encoded, compared (constant-time)
    /// against a header value.
    hmac,
};

/// A route's resolved authentication configuration.
pub const Config = struct {
    mode: Mode,
    /// Request header carrying the token/signature. Required for `.token`/`.hmac`.
    header: ?[]const u8 = null,
    /// Literal prefix stripped from the header value before comparison — e.g.
    /// `"sha256="` for GitHub-style signatures or `"Bearer "` for tokens. Empty
    /// means compare the header value verbatim.
    prefix: []const u8 = "",
};

/// The outcome of verifying one request. Only `.ok` permits a launch; the two
/// rejections map to HTTP 401 and are deliberately not distinguished to the
/// caller in the response body (both just mean "not authorized").
pub const Verdict = enum {
    ok,
    /// The configured header was absent, empty, or lacked the required prefix.
    missing_signature,
    /// The signature/token was present but did not match.
    bad_signature,
};

/// Verify a request against `cfg`.
///
///   * `secret` is the resolved secret bytes (the value of the configured env
///     var). Ignored for `.none`.
///   * `header_value` is the raw value of the configured header, or null when
///     the request did not send it.
///   * `body` is the raw request body (used only for `.hmac`).
pub fn verify(cfg: Config, secret: []const u8, header_value: ?[]const u8, body: []const u8) Verdict {
    switch (cfg.mode) {
        .none => return .ok,
        .token => {
            const provided = strip(header_value orelse return .missing_signature, cfg.prefix) orelse
                return .missing_signature;
            if (provided.len == 0) return .missing_signature;
            return if (constantTimeEql(provided, secret)) .ok else .bad_signature;
        },
        .hmac => {
            const provided = strip(header_value orelse return .missing_signature, cfg.prefix) orelse
                return .missing_signature;
            if (provided.len == 0) return .missing_signature;

            var mac: [HmacSha256.mac_length]u8 = undefined;
            HmacSha256.create(&mac, body, secret);
            const expected = std.fmt.bytesToHex(mac, .lower);

            // A valid signature is exactly the hex digest length; reject anything
            // else before the constant-time compare (the length itself is not a
            // secret). Lower-case the provided hex so an upper-case signature
            // still matches, comparing in constant time.
            if (provided.len != expected.len) return .bad_signature;
            var provided_lower: [HmacSha256.mac_length * 2]u8 = undefined;
            for (provided, 0..) |ch, i| provided_lower[i] = std.ascii.toLower(ch);
            return if (std.crypto.timing_safe.eql([HmacSha256.mac_length * 2]u8, provided_lower, expected))
                .ok
            else
                .bad_signature;
        },
    }
}

/// Return `value` with `prefix` removed, or null if `value` does not start with
/// `prefix`. An empty prefix returns `value` unchanged.
fn strip(value: []const u8, prefix: []const u8) ?[]const u8 {
    if (prefix.len == 0) return value;
    if (!std.mem.startsWith(u8, value, prefix)) return null;
    return value[prefix.len..];
}

/// Constant-time equality for two byte slices. The length comparison can
/// short-circuit (a secret's length is not itself sensitive here); the byte
/// comparison accumulates differences so it never returns early on content.
fn constantTimeEql(a: []const u8, b: []const u8) bool {
    if (a.len != b.len) return false;
    var diff: u8 = 0;
    for (a, b) |x, y| diff |= x ^ y;
    return diff == 0;
}

// ----- tests -----

const testing = std.testing;

test "none mode always passes" {
    try testing.expectEqual(Verdict.ok, verify(.{ .mode = .none }, "", null, "anything"));
    try testing.expectEqual(Verdict.ok, verify(.{ .mode = .none }, "ignored", "ignored", "body"));
}

test "token mode compares secret against header with prefix" {
    const cfg: Config = .{ .mode = .token, .header = "X-Token", .prefix = "Bearer " };
    try testing.expectEqual(Verdict.ok, verify(cfg, "s3cret", "Bearer s3cret", "body"));
    try testing.expectEqual(Verdict.bad_signature, verify(cfg, "s3cret", "Bearer nope", "body"));
    // Missing header, or header without the required prefix, is missing_signature.
    try testing.expectEqual(Verdict.missing_signature, verify(cfg, "s3cret", null, "body"));
    try testing.expectEqual(Verdict.missing_signature, verify(cfg, "s3cret", "s3cret", "body"));
}

test "token mode without prefix compares verbatim" {
    const cfg: Config = .{ .mode = .token, .header = "X-Token" };
    try testing.expectEqual(Verdict.ok, verify(cfg, "abc", "abc", "body"));
    try testing.expectEqual(Verdict.bad_signature, verify(cfg, "abc", "abcd", "body"));
    try testing.expectEqual(Verdict.missing_signature, verify(cfg, "abc", "", "body"));
}

test "hmac mode verifies a sha256 hex signature over the body" {
    const cfg: Config = .{ .mode = .hmac, .header = "X-Sig", .prefix = "sha256=" };
    const secret = "topsecret";
    const body = "{\"hello\":\"world\"}";

    // Compute the expected signature the same way a sender would.
    var mac: [HmacSha256.mac_length]u8 = undefined;
    HmacSha256.create(&mac, body, secret);
    const hex = std.fmt.bytesToHex(mac, .lower);
    const header = try std.fmt.allocPrint(testing.allocator, "sha256={s}", .{hex[0..]});
    defer testing.allocator.free(header);

    try testing.expectEqual(Verdict.ok, verify(cfg, secret, header, body));

    // Upper-case hex still matches (case-insensitive, constant-time).
    const upper = try std.ascii.allocUpperString(testing.allocator, hex[0..]);
    defer testing.allocator.free(upper);
    const header_upper = try std.fmt.allocPrint(testing.allocator, "sha256={s}", .{upper});
    defer testing.allocator.free(header_upper);
    try testing.expectEqual(Verdict.ok, verify(cfg, secret, header_upper, body));

    // A tampered body fails.
    try testing.expectEqual(Verdict.bad_signature, verify(cfg, secret, header, "{\"hello\":\"mars\"}"));
    // The wrong secret fails.
    try testing.expectEqual(Verdict.bad_signature, verify(cfg, "wrong", header, body));
}

test "hmac mode rejects malformed and missing signatures" {
    const cfg: Config = .{ .mode = .hmac, .header = "X-Sig", .prefix = "sha256=" };
    try testing.expectEqual(Verdict.missing_signature, verify(cfg, "k", null, "body"));
    // Present but missing the required prefix.
    try testing.expectEqual(Verdict.missing_signature, verify(cfg, "k", "deadbeef", "body"));
    // Right prefix, wrong length (not a 64-char digest).
    try testing.expectEqual(Verdict.bad_signature, verify(cfg, "k", "sha256=deadbeef", "body"));
    // Right prefix, empty digest.
    try testing.expectEqual(Verdict.missing_signature, verify(cfg, "k", "sha256=", "body"));
}

test "strip handles prefixes" {
    try testing.expectEqualStrings("abc", strip("abc", "").?);
    try testing.expectEqualStrings("abc", strip("sha256=abc", "sha256=").?);
    try testing.expect(strip("abc", "sha256=") == null);
}
