//! Pure webhook request handling.
//!
//! This is the front door's brain: given an already-received HTTP request (the
//! serve action handles the socket and HTTP framing) and the route registry, it
//! decides whether to launch a tab and what to answer. It is the webhook
//! counterpart to `runner.dispatch` — and in fact *delegates* the actual launch
//! to `runner.dispatch`, so a webhook launch is exactly a normal connector
//! launch through the existing Control API, with the same dedup, prompt
//! delivery, provenance, and policy attribution. The only thing the webhook
//! layer adds is the HTTP transport and its validation.
//!
//! The pipeline, all before any side effect:
//!
//!   1. **Route** — exact path match. Unknown path → 404 (existence of other
//!      routes is never revealed).
//!   2. **Transport guardrails** — POST only (405), `application/json` only
//!      (415), body within the route's size cap (413).
//!   3. **Authenticate** — per-route HMAC-SHA256 or shared-token check over the
//!      raw body (401). No request reaches an adapter, let alone a launch,
//!      without passing this.
//!   4. **Parse** — the configured connector adapter turns the opaque body into
//!      a `TriggerEvent` (400 on malformed/unsupported payloads). Maxx reads only
//!      the explicit fields the adapter copies; it never interprets meaning.
//!   5. **Filter** — exact configured predicates over explicit adapter fields;
//!      mismatches return `filtered` without launch side effects.
//!   6. **Resolve** — the route's launch template against the event (422 when the
//!      payload lacks a templated field).
//!   7. **Launch** — `runner.dispatch`: suppress duplicates, send
//!      `sessions.create` with the injected capability token, deliver the prompt
//!      and the raw payload file. The outcome (launched / duplicate / failed) is
//!      mapped to a status code and a tiny JSON body that never echoes the
//!      payload or any secret.
//!
//! Every effect — the control socket, the dedup store, the secret lookup, the
//! clock, the temp-file directory — is injected through `Deps`, so the whole
//! pipeline is exercised in unit tests without a socket, the environment, or a
//! real clock.

const std = @import("std");
const Allocator = std.mem.Allocator;

const Config = @import("Config.zig");
const auth = @import("auth.zig");
const connector = @import("../connector/connector.zig");
const runner = @import("../runner/runner.zig");
const Template = connector.Template;

const log = std.log.scoped(.webhook);

/// Environment variable carrying the path to the raw webhook payload file the
/// launched command can read. Written per launch (0600) when a temp dir is
/// available, in addition to the connector's own prompt delivery.
pub const payload_file_env_var = "MAXX_WEBHOOK_PAYLOAD_FILE";

/// Filename prefix for raw-payload temp files, matched by the sweeper.
const payload_file_prefix = "maxx-webhook-payload-";

/// A request header (name/value). Names are matched case-insensitively.
pub const Header = struct { name: []const u8, value: []const u8 };

/// The minimal view of an HTTP request the handler needs. The serve action
/// builds this from `std.http.Server`; tests build it directly.
pub const Request = struct {
    method: []const u8,
    /// Request path with any query string already stripped by the caller.
    path: []const u8,
    content_type: ?[]const u8 = null,
    headers: []const Header = &.{},
    body: []const u8 = "",

    pub fn header(self: Request, name: []const u8) ?[]const u8 {
        for (self.headers) |h| {
            if (std.ascii.eqlIgnoreCase(h.name, name)) return h.value;
        }
        return null;
    }
};

/// An HTTP response: a status code and a small JSON body.
pub const Response = struct {
    status: u16,
    body: []const u8,
};

/// Injected effects the handler needs to perform a launch.
pub const Deps = struct {
    /// Control-socket sender (real socket in serve; recording fake in tests).
    sender: runner.Sender,
    /// Persistent duplicate-suppression store, or null to disable it.
    dedup: ?*runner.DedupStore = null,
    /// Per-call capability token injected into the control request.
    token: []const u8 = "",
    /// ISO-8601 UTC timestamp recorded as provenance and the dedup time.
    received_at: []const u8,
    /// Directory for temp prompt/payload files. Null disables file writes (the
    /// raw payload file is then omitted).
    prompt_dir: ?[]const u8 = null,
    /// Resolves a route's `secret_env` *name* to its value, or null when unset.
    /// Backed by the process environment (captured at serve startup) in
    /// production and by a fixed map in tests.
    secret: *const fn (ctx: *anyopaque, name: []const u8) ?[]const u8,
    secret_ctx: *anyopaque = undefined,
    /// Durably persist the dedup store. Called by the handler *before* it
    /// acknowledges a launch that recorded a new dedup entry, so a successful
    /// `200` is never returned with a non-durable dedup key (which, after a
    /// listener restart, could let the same delivery re-launch). A returned error
    /// is surfaced as a `warning` on the otherwise-successful response rather than
    /// silently logged. Null disables persistence (e.g. tests use the in-memory
    /// store directly). Only invoked when `dedup` is active for the request.
    persist: ?*const fn (ctx: *anyopaque) anyerror!void = null,
    persist_ctx: *anyopaque = undefined,

    fn secretFor(self: Deps, name: []const u8) ?[]const u8 {
        return self.secret(self.secret_ctx, name);
    }
};

/// The result of handling one request.
pub const Result = struct {
    response: Response,
    /// Present when an event reached route-specific activity
    /// (launched/duplicate/failed/filtered); used for logging and temp-file
    /// housekeeping. Absent for transport/auth rejections.
    record: ?runner.ActivityRecord = null,
};

/// Handle one already-received request against the route registry. Performs the
/// launch (through the injected sender) and returns the HTTP response plus an
/// optional activity record. Only allocation failure propagates; every other
/// failure becomes a response.
pub fn handle(alloc: Allocator, cfg: Config, req: Request, deps: Deps) Allocator.Error!Result {
    // 1. Route on the exact path. An unknown path is answered EXACTLY like an
    //    authentication failure (a uniform 401) so an unauthenticated caller
    //    cannot enumerate which routes are configured — route paths may encode
    //    provider/project names or be treated as part of a tunnel secret.
    const route = routeFor(cfg, req.path) orelse
        return plain(try unauthorized(alloc));

    // 2. Authenticate BEFORE any route-specific rejection. A known route with a
    //    bad/missing signature returns the same 401 as an unknown path, so route
    //    existence is never disclosed until the caller proves the secret. (The
    //    secret-unavailable 500 is unreachable in production: `serve` fails closed
    //    at startup if a route's secret env is unset.)
    const secret: []const u8 = if (route.auth.mode == .none) "" else blk: {
        const name = route.secret_env orelse
            return plain(try jsonResp(alloc, 500, &.{kv("error", "secret_unavailable")}));
        break :blk deps.secretFor(name) orelse
            return plain(try jsonResp(alloc, 500, &.{kv("error", "secret_unavailable")}));
    };
    const header_value: ?[]const u8 = if (route.auth.header) |h| req.header(h) else null;
    switch (auth.verify(route.auth, secret, header_value, req.body)) {
        .ok => {},
        .missing_signature, .bad_signature => {
            log.warn("webhook {s}: unauthorized request rejected", .{route.path});
            return plain(try unauthorized(alloc));
        },
    }

    // 3. Transport guardrails. Only an authenticated caller reaches these, so the
    //    finer-grained status codes do not leak route existence.
    if (!std.ascii.eqlIgnoreCase(req.method, "POST"))
        return plain(try jsonResp(alloc, 405, &.{kv("error", "method_not_allowed")}));
    if (!isJsonContentType(req.content_type))
        return plain(try jsonResp(alloc, 415, &.{kv("error", "unsupported_media_type")}));
    if (req.body.len > route.max_body_bytes)
        return plain(try jsonResp(alloc, 413, &.{kv("error", "payload_too_large")}));

    // 4. Parse the opaque payload with the configured adapter (validated to
    //    exist at config time).
    const adapter = connector.adapterByName(route.source).?;
    const event = adapter.parse(alloc, req.body) catch |err| {
        const detail = switch (err) {
            error.InvalidPayload => "payload is not a JSON object",
            error.MissingField => "a required field is missing",
            error.UnsupportedEventType => "the payload's event type is not supported",
            error.OutOfMemory => return error.OutOfMemory,
        };
        return plain(try jsonResp(alloc, 400, &.{ kv("error", "invalid_payload"), kv("detail", detail) }));
    };

    // 5. Predicate filtering is exact and side-effect-free. It runs after
    // authentication + adapter parsing, but before template resolution, dedup,
    // raw-payload temp files, or Control API sends.
    if (connector.Predicate.firstMismatch(route.predicates, event)) |mismatch| {
        return .{
            .response = try jsonResp(alloc, 200, &.{
                ok(),
                kv("outcome", "filtered"),
                kv("field", mismatch.field),
            }),
            .record = filteredRecord(route, event, deps.received_at),
        };
    }

    // 6. Resolve the route's launch template against the explicit event fields.
    var diag: Template.Diagnostic = .{};
    const resolved = connector.resolve(alloc, route.template(), event, .{
        .launched_at = deps.received_at,
        .diag = &diag,
    }) catch |err| switch (err) {
        error.MissingField => return plain(try jsonResp(alloc, 422, &.{
            kv("error", "unresolved_field"),
            kv("field", diag.field),
        })),
        // Placeholder syntax is validated at config load, so this is unreachable
        // in practice; answer defensively rather than crash the listener.
        error.MalformedTemplate => return plain(try jsonResp(alloc, 500, &.{kv("error", "malformed_template")})),
        error.OutOfMemory => return error.OutOfMemory,
    };

    // Duplicate suppression is keyed on a per-DELIVERY id taken from a
    // route-configured request header (e.g. `X-GitHub-Delivery` /
    // `Linear-Delivery`). It suppresses provider RETRIES of the same delivery —
    // never distinct events for the same issue/PR. Dedup is OFF unless the route
    // configures `dedup_header` AND the request carries it: the adapter's
    // `event.id` is the OBJECT id (issue/PR), so keying on it would wrongly drop a
    // later legitimate event for the same object.
    var dedup_store: ?*runner.DedupStore = null;
    var dedup_key: ?[]const u8 = null;
    if (deps.dedup) |store| {
        if (route.dedup_header) |dh| {
            if (req.header(dh)) |dv| {
                if (dv.len > 0) {
                    dedup_store = store;
                    dedup_key = dv;
                }
            }
        }
    }

    // 7a. Short-circuit a known duplicate before writing any payload file, so a
    //     redelivery storm cannot leave orphan temp files. `runner.dispatch`
    //     re-checks dedup authoritatively for the non-duplicate path.
    if (dedup_store) |store| {
        const key = dedup_key.?;
        if (runner.DedupStore.recordable(route.trigger, event.source, key) and
            store.seen(route.trigger, event.source, key))
        {
            const rec = baseRecord(route, event, resolved, key, deps.received_at, .duplicate);
            return .{
                .response = try jsonResp(alloc, 200, &.{ ok(), kv("outcome", "duplicate") }),
                .record = rec,
            };
        }
    }

    // 7b. Deliver the raw payload as a temp file the command can read.
    var launch = resolved;
    var payload_path: ?[]const u8 = null;
    if (deps.prompt_dir) |dir| {
        payload_path = writePayloadFile(alloc, dir, event.id, req.body) catch |err| {
            log.warn("webhook {s}: could not write payload file: {s}", .{ route.path, @errorName(err) });
            return plain(try jsonResp(alloc, 500, &.{kv("error", "payload_file_failed")}));
        };
        launch.env = try appendEnv(alloc, resolved.env, .{ .key = payload_file_env_var, .value = payload_path.? });
    }

    // 7c. Launch through the existing runner/Control-API pipeline.
    const rec = try runner.dispatch(alloc, .{
        .trigger = route.trigger,
        .trigger_type = .webhook_relay,
        .event = event,
        .request = launch,
        .token = deps.token,
        .received_at = deps.received_at,
        .dedup = dedup_store,
        .dedup_key = dedup_key,
        .prompt_dir = deps.prompt_dir,
    }, deps.sender);

    // If no tab launched, the command never started, so the raw-payload file we
    // wrote is useless — delete it now rather than leaking it until the TTL sweep
    // (a redelivery storm against a down control socket would otherwise pile up
    // 0600 files holding the raw payload).
    if (rec.outcome != .launched) {
        if (payload_path) |p| std.fs.cwd().deleteFile(p) catch {};
    }

    return switch (rec.outcome) {
        // A launched tab is a success even if a follow-up (e.g. stdin prompt) had
        // an issue: the tab exists, so the provider should not retry. The detail
        // is logged and surfaced in the body for visibility.
        .launched => blk: {
            // Persist the just-recorded dedup entry BEFORE acknowledging, so a
            // 200 is never returned with a non-durable key. A persist failure is
            // surfaced as a warning (the tab launched, so this stays a 200 — a
            // 5xx would trigger a provider retry and a second tab).
            var warning: ?[]const u8 = rec.error_code;
            if (dedup_store != null) {
                if (deps.persist) |p| {
                    p(deps.persist_ctx) catch |err| {
                        log.warn("webhook {s}: dedup persist failed: {s}", .{ route.path, @errorName(err) });
                        if (warning == null) warning = "dedup_not_persisted";
                    };
                }
            }
            var fields: std.ArrayList(Field) = .empty;
            try fields.append(alloc, ok());
            try fields.append(alloc, kv("outcome", "launched"));
            try fields.append(alloc, kvOpt("session_id", rec.session_id));
            if (warning) |w| try fields.append(alloc, kv("warning", w));
            break :blk .{
                .response = try jsonResp(alloc, 200, fields.items),
                .record = rec,
            };
        },
        .duplicate => .{
            .response = try jsonResp(alloc, 200, &.{ ok(), kv("outcome", "duplicate") }),
            .record = rec,
        },
        .failed => .{
            .response = try jsonResp(alloc, 502, &.{
                .{ .key = "ok", .val = .{ .b = false } },
                kv("outcome", "failed"),
                kvOpt("error", rec.error_code),
            }),
            .record = rec,
        },
        // The webhook handler never dry-runs.
        .dry_run => unreachable,
        // Filtered requests return before runner.dispatch.
        .filtered => unreachable,
    };
}

fn routeFor(cfg: Config, path: []const u8) ?Config.Route {
    for (cfg.routes) |r| {
        if (std.mem.eql(u8, r.path, path)) return r;
    }
    return null;
}

/// Whether the Content-Type media type is `application/json` (parameters such as
/// `; charset=utf-8` are allowed and ignored).
fn isJsonContentType(ct: ?[]const u8) bool {
    const c = ct orelse return false;
    const semi = std.mem.indexOfScalar(u8, c, ';') orelse c.len;
    const mt = std.mem.trim(u8, c[0..semi], " \t");
    return std.ascii.eqlIgnoreCase(mt, "application/json");
}

/// A minimal activity record for a path that does not call `runner.dispatch`
/// (the duplicate short-circuit). It reports the *resolved* command/title (from
/// the already-resolved `LaunchRequest`), matching the record `runner.dispatch`
/// would have produced for the same event, so duplicate and launched log lines
/// are consistent rather than one showing raw `${...}` templates.
fn baseRecord(route: Config.Route, event: connector.TriggerEvent, resolved: connector.LaunchRequest, key: []const u8, at: []const u8, outcome: runner.Outcome) runner.ActivityRecord {
    return .{
        .trigger = route.trigger,
        .trigger_type = .webhook_relay,
        .received_at = at,
        .source = event.source,
        .event_id = event.id,
        .dedup_key = key,
        .command = resolved.command,
        .title = resolved.title,
        .outcome = outcome,
    };
}

fn filteredRecord(route: Config.Route, event: connector.TriggerEvent, at: []const u8) runner.ActivityRecord {
    return .{
        .trigger = route.trigger,
        .trigger_type = .webhook_relay,
        .received_at = at,
        .source = event.source,
        .event_id = event.id,
        .dedup_key = "",
        .command = route.command,
        .title = event.title,
        .outcome = .filtered,
    };
}

/// Write `body` to a unique 0600 temp file in `dir` and return its path. The
/// name carries the event id, pid, and a nanosecond stamp, and is created
/// exclusively so concurrent launches never clobber each other's payload.
fn writePayloadFile(alloc: Allocator, dir: []const u8, event_id: []const u8, body: []const u8) ![]const u8 {
    const safe = try sanitizeForFilename(alloc, event_id);
    const name = try std.fmt.allocPrint(alloc, payload_file_prefix ++ "{s}-{d}-{d}.json", .{
        safe, std.c.getpid(), std.time.nanoTimestamp(),
    });
    const path = try std.fs.path.join(alloc, &.{ dir, name });
    const file = try std.fs.cwd().createFile(path, .{ .exclusive = true, .mode = 0o600 });
    defer file.close();
    try file.writeAll(body);
    return path;
}

fn appendEnv(alloc: Allocator, base: []const Template.Pair, extra: Template.Pair) Allocator.Error![]const Template.Pair {
    const out = try alloc.alloc(Template.Pair, base.len + 1);
    @memcpy(out[0..base.len], base);
    out[base.len] = extra;
    return out;
}

fn sanitizeForFilename(alloc: Allocator, s: []const u8) Allocator.Error![]u8 {
    const out = try alloc.alloc(u8, s.len);
    for (s, 0..) |ch, i| {
        out[i] = switch (ch) {
            'A'...'Z', 'a'...'z', '0'...'9', '.', '_', '-' => ch,
            else => '_',
        };
    }
    return out;
}

/// Best-effort GC of stale raw-payload temp files left by previous launches (the
/// launched command reads its file shortly after launch, so the runner cannot
/// delete its own). Mirrors `runner.sweepStalePromptFiles`.
pub fn sweepStalePayloadFiles(dir_path: []const u8, max_age_s: i64, now_s: i64) void {
    var dir = std.fs.cwd().openDir(dir_path, .{ .iterate = true }) catch return;
    defer dir.close();
    const cutoff_ns: i128 = @as(i128, now_s - max_age_s) * std.time.ns_per_s;
    var it = dir.iterate();
    while (it.next() catch return) |entry| {
        if (entry.kind != .file) continue;
        if (!std.mem.startsWith(u8, entry.name, payload_file_prefix)) continue;
        if (!std.mem.endsWith(u8, entry.name, ".json")) continue;
        const st = dir.statFile(entry.name) catch continue;
        if (st.mtime < cutoff_ns) dir.deleteFile(entry.name) catch {};
    }
}

// ----- tiny JSON response builder -----

const Field = struct {
    key: []const u8,
    val: union(enum) {
        s: []const u8,
        b: bool,
        opt: ?[]const u8,
    },
};

fn kv(key: []const u8, value: []const u8) Field {
    return .{ .key = key, .val = .{ .s = value } };
}
fn kvOpt(key: []const u8, value: ?[]const u8) Field {
    return .{ .key = key, .val = .{ .opt = value } };
}
fn ok() Field {
    return .{ .key = "ok", .val = .{ .b = true } };
}

fn plain(response: Response) Result {
    return .{ .response = response };
}

/// The uniform 401 used for BOTH an unknown route and an authentication failure,
/// so the two are indistinguishable to an unauthenticated caller.
fn unauthorized(alloc: Allocator) Allocator.Error!Response {
    return jsonResp(alloc, 401, &.{kv("error", "unauthorized")});
}

fn jsonResp(alloc: Allocator, status: u16, fields: []const Field) Allocator.Error!Response {
    var out: std.io.Writer.Allocating = .init(alloc);
    var json: std.json.Stringify = .{ .writer = &out.writer, .options = .{} };
    buildObject(&json, fields) catch return error.OutOfMemory;
    return .{ .status = status, .body = try out.toOwnedSlice() };
}

fn buildObject(json: *std.json.Stringify, fields: []const Field) !void {
    try json.beginObject();
    for (fields) |f| switch (f.val) {
        .s => |s| {
            try json.objectField(f.key);
            try json.write(s);
        },
        .b => |b| {
            try json.objectField(f.key);
            try json.write(b);
        },
        .opt => |o| if (o) |s| {
            try json.objectField(f.key);
            try json.write(s);
        },
    };
    try json.endObject();
}

// ----- tests -----

const testing = std.testing;

/// A recording control-socket sender: captures requests and replays canned
/// responses, exactly like the runner's test fake.
const RecordingSender = struct {
    alloc: Allocator,
    responses: []const []const u8,
    idx: usize = 0,
    requests: std.ArrayListUnmanaged([]const u8) = .empty,

    fn sendImpl(ctx: *anyopaque, alloc: Allocator, request: []const u8) anyerror![]const u8 {
        const self: *RecordingSender = @ptrCast(@alignCast(ctx));
        try self.requests.append(self.alloc, try self.alloc.dupe(u8, request));
        if (self.idx >= self.responses.len) return error.NoResponseQueued;
        const r = self.responses[self.idx];
        self.idx += 1;
        return alloc.dupe(u8, r);
    }
    fn sender(self: *RecordingSender) runner.Sender {
        return .{ .ctx = self, .sendFn = sendImpl };
    }
};

/// A dedup persister for tests: counts calls and can be made to fail.
const CountingPersister = struct {
    calls: usize = 0,
    fail: bool = false,
    fn persist(ctx: *anyopaque) anyerror!void {
        const self: *CountingPersister = @ptrCast(@alignCast(ctx));
        self.calls += 1;
        if (self.fail) return error.DiskFull;
    }
};

/// A fixed secret resolver for tests.
const SecretMap = struct {
    entries: []const struct { name: []const u8, value: []const u8 },
    fn resolve(ctx: *anyopaque, name: []const u8) ?[]const u8 {
        const self: *SecretMap = @ptrCast(@alignCast(ctx));
        for (self.entries) |e| {
            if (std.mem.eql(u8, e.name, name)) return e.value;
        }
        return null;
    }
};

const ok_response = "{\"ok\":true,\"result\":{\"session\":{\"session_id\":\"SID-1\"}}}";

const linear_payload =
    \\{"action":"update","type":"Issue","data":{"id":"evt-1","identifier":"MAX-9","title":"Webhook ingestion","url":"https://linear.app/x/MAX-9"}}
;

const linear_todo_payload =
    \\{"action":"update","type":"Issue","data":{"id":"evt-1","identifier":"MAX-9","title":"Webhook ingestion","url":"https://linear.app/x/MAX-9","state":{"id":"state-todo","name":"Todo"}}}
;

const linear_done_payload =
    \\{"action":"update","type":"Issue","data":{"id":"evt-1","identifier":"MAX-9","title":"Webhook ingestion","url":"https://linear.app/x/MAX-9","state":{"id":"state-done","name":"Done"}}}
;

const github_pr_merged_payload =
    \\{"action":"closed","pull_request":{"id":99,"node_id":"PR_1","number":7,"title":"Cleanup","html_url":"https://github.com/o/r/pull/7","merged":true},"repository":{"full_name":"o/r"}}
;

const github_pr_unmerged_payload =
    \\{"action":"closed","pull_request":{"id":99,"node_id":"PR_1","number":7,"title":"Cleanup","html_url":"https://github.com/o/r/pull/7","merged":false},"repository":{"full_name":"o/r"}}
;

fn cfgWith(alloc: Allocator, route_json: []const u8) !Config {
    const json = try std.fmt.allocPrint(alloc, "{{\"routes\":[{s}]}}", .{route_json});
    return Config.parse(alloc, json, null);
}

fn makeDeps(sender: *RecordingSender, secrets: *SecretMap) Deps {
    return .{
        .sender = sender.sender(),
        .received_at = "2026-06-15T00:00:00Z",
        .secret = SecretMap.resolve,
        .secret_ctx = secrets,
    };
}

test "valid hmac request launches the configured command" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    // The command is static (placeholders are forbidden there); the title
    // templates from an explicit field so we still exercise substitution.
    const cfg = try cfgWith(alloc,
        \\{"path":"/hooks/linear","source":"linear","command":"claude","title":"${title}","caller":"trusted-automation","auth":{"mode":"hmac","secret_env":"S","header":"X-Sig","prefix":"sha256="}}
    );

    // Sign the body the way a sender would.
    const HmacSha256 = std.crypto.auth.hmac.sha2.HmacSha256;
    var mac: [HmacSha256.mac_length]u8 = undefined;
    HmacSha256.create(&mac, linear_payload, "topsecret");
    const hex = std.fmt.bytesToHex(mac, .lower);
    const sig = try std.fmt.allocPrint(alloc, "sha256={s}", .{hex[0..]});

    var sender = RecordingSender{ .alloc = alloc, .responses = &.{ok_response} };
    var secrets = SecretMap{ .entries = &.{.{ .name = "S", .value = "topsecret" }} };

    const res = try handle(alloc, cfg, .{
        .method = "POST",
        .path = "/hooks/linear",
        .content_type = "application/json",
        .headers = &.{.{ .name = "X-Sig", .value = sig }},
        .body = linear_payload,
    }, makeDeps(&sender, &secrets));

    try testing.expectEqual(@as(u16, 200), res.response.status);
    try testing.expect(std.mem.indexOf(u8, res.response.body, "\"outcome\":\"launched\"") != null);
    try testing.expect(std.mem.indexOf(u8, res.response.body, "SID-1") != null);

    // Exactly one control request: a sessions.create attributed to the policy
    // source, carrying the resolved command and provenance.
    try testing.expectEqual(@as(usize, 1), sender.requests.items.len);
    const sent = sender.requests.items[0];
    try testing.expect(std.mem.indexOf(u8, sent, "sessions.create") != null);
    try testing.expect(std.mem.indexOf(u8, sent, "\"command\":\"claude\"") != null);
    // The templated title resolved from the explicit event field.
    try testing.expect(std.mem.indexOf(u8, sent, "\"title\":\"Webhook ingestion\"") != null);
    try testing.expect(std.mem.indexOf(u8, sent, "\"caller\":\"trusted-automation\"") != null);
    try testing.expect(std.mem.indexOf(u8, sent, "webhook_relay") != null);
}

test "unknown route is indistinguishable from an auth failure (401)" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    // A real route that requires auth, so the unknown-route 401 can be compared
    // byte-for-byte against the known-route auth-failure 401.
    const cfg = try cfgWith(alloc,
        \\{"path":"/hooks/linear","source":"linear","command":"c","auth":{"mode":"hmac","secret_env":"S","header":"X-Sig","prefix":"sha256="}}
    );
    var secrets = SecretMap{ .entries = &.{.{ .name = "S", .value = "topsecret" }} };

    var s1 = RecordingSender{ .alloc = alloc, .responses = &.{} };
    const unknown = try handle(alloc, cfg, .{
        .method = "POST",
        .path = "/nope",
        .content_type = "application/json",
        .body = linear_payload,
    }, makeDeps(&s1, &secrets));
    try testing.expectEqual(@as(u16, 401), unknown.response.status);
    try testing.expectEqual(@as(usize, 0), s1.requests.items.len);
    try testing.expect(unknown.record == null);

    // A known route with a bad signature returns the identical 401 body, so the
    // configured path cannot be distinguished by an unauthenticated probe.
    var s2 = RecordingSender{ .alloc = alloc, .responses = &.{} };
    const known_bad = try handle(alloc, cfg, .{
        .method = "POST",
        .path = "/hooks/linear",
        .content_type = "application/json",
        .headers = &.{.{ .name = "X-Sig", .value = "sha256=deadbeef" }},
        .body = linear_payload,
    }, makeDeps(&s2, &secrets));
    try testing.expectEqual(@as(u16, 401), known_bad.response.status);
    try testing.expectEqualStrings(unknown.response.body, known_bad.response.body);
    try testing.expectEqual(@as(usize, 0), s2.requests.items.len);
}

test "wrong method and content type are rejected before any launch" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    const cfg = try cfgWith(alloc,
        \\{"path":"/h","source":"linear","command":"c","auth":{"mode":"none"}}
    );
    var sender = RecordingSender{ .alloc = alloc, .responses = &.{} };
    var secrets = SecretMap{ .entries = &.{} };

    const get = try handle(alloc, cfg, .{ .method = "GET", .path = "/h", .content_type = "application/json", .body = linear_payload }, makeDeps(&sender, &secrets));
    try testing.expectEqual(@as(u16, 405), get.response.status);

    const wrong_ct = try handle(alloc, cfg, .{ .method = "POST", .path = "/h", .content_type = "text/plain", .body = linear_payload }, makeDeps(&sender, &secrets));
    try testing.expectEqual(@as(u16, 415), wrong_ct.response.status);

    const no_ct = try handle(alloc, cfg, .{ .method = "POST", .path = "/h", .content_type = null, .body = linear_payload }, makeDeps(&sender, &secrets));
    try testing.expectEqual(@as(u16, 415), no_ct.response.status);

    try testing.expectEqual(@as(usize, 0), sender.requests.items.len);
}

test "oversized body is rejected with 413" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    const cfg = try cfgWith(alloc,
        \\{"path":"/h","source":"linear","command":"c","max_body_bytes":16,"auth":{"mode":"none"}}
    );
    var sender = RecordingSender{ .alloc = alloc, .responses = &.{} };
    var secrets = SecretMap{ .entries = &.{} };
    const res = try handle(alloc, cfg, .{
        .method = "POST",
        .path = "/h",
        .content_type = "application/json",
        .body = linear_payload, // longer than 16 bytes
    }, makeDeps(&sender, &secrets));
    try testing.expectEqual(@as(u16, 413), res.response.status);
    try testing.expectEqual(@as(usize, 0), sender.requests.items.len);
}

test "bad signature is 401 and launches nothing" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    const cfg = try cfgWith(alloc,
        \\{"path":"/h","source":"linear","command":"c","auth":{"mode":"hmac","secret_env":"S","header":"X-Sig","prefix":"sha256="}}
    );
    var sender = RecordingSender{ .alloc = alloc, .responses = &.{} };
    var secrets = SecretMap{ .entries = &.{.{ .name = "S", .value = "topsecret" }} };
    const res = try handle(alloc, cfg, .{
        .method = "POST",
        .path = "/h",
        .content_type = "application/json",
        .headers = &.{.{ .name = "X-Sig", .value = "sha256=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }},
        .body = linear_payload,
    }, makeDeps(&sender, &secrets));
    try testing.expectEqual(@as(u16, 401), res.response.status);
    try testing.expectEqual(@as(usize, 0), sender.requests.items.len);
}

test "missing secret in env is a server error" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    const cfg = try cfgWith(alloc,
        \\{"path":"/h","source":"linear","command":"c","auth":{"mode":"token","secret_env":"MISSING","header":"X-Tok"}}
    );
    var sender = RecordingSender{ .alloc = alloc, .responses = &.{} };
    var secrets = SecretMap{ .entries = &.{} };
    const res = try handle(alloc, cfg, .{
        .method = "POST",
        .path = "/h",
        .content_type = "application/json",
        .headers = &.{.{ .name = "X-Tok", .value = "whatever" }},
        .body = linear_payload,
    }, makeDeps(&sender, &secrets));
    try testing.expectEqual(@as(u16, 500), res.response.status);
    try testing.expect(std.mem.indexOf(u8, res.response.body, "secret_unavailable") != null);
    try testing.expectEqual(@as(usize, 0), sender.requests.items.len);
}

test "malformed payload is 400" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    const cfg = try cfgWith(alloc,
        \\{"path":"/h","source":"linear","command":"c","auth":{"mode":"none"}}
    );
    var sender = RecordingSender{ .alloc = alloc, .responses = &.{} };
    var secrets = SecretMap{ .entries = &.{} };
    const res = try handle(alloc, cfg, .{
        .method = "POST",
        .path = "/h",
        .content_type = "application/json",
        .body = "not a json object",
    }, makeDeps(&sender, &secrets));
    try testing.expectEqual(@as(u16, 400), res.response.status);
    try testing.expect(std.mem.indexOf(u8, res.response.body, "invalid_payload") != null);
    try testing.expectEqual(@as(usize, 0), sender.requests.items.len);
}

test "a templated field the payload lacks is 422" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    // The unresolved placeholder is in a templated field (title); the command
    // itself may not carry placeholders.
    const cfg = try cfgWith(alloc,
        \\{"path":"/h","source":"linear","command":"claude","title":"${nonexistent.field}","auth":{"mode":"none"}}
    );
    var sender = RecordingSender{ .alloc = alloc, .responses = &.{} };
    var secrets = SecretMap{ .entries = &.{} };
    const res = try handle(alloc, cfg, .{
        .method = "POST",
        .path = "/h",
        .content_type = "application/json",
        .body = linear_payload,
    }, makeDeps(&sender, &secrets));
    try testing.expectEqual(@as(u16, 422), res.response.status);
    try testing.expect(std.mem.indexOf(u8, res.response.body, "nonexistent.field") != null);
    try testing.expectEqual(@as(usize, 0), sender.requests.items.len);
}

test "matching linear predicate launches only Todo payloads" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const cfg = try cfgWith(alloc,
        \\{"path":"/h","source":"linear","command":"c","predicates":[{"field":"issue.state.name","equals":"Todo"}],"auth":{"mode":"none"}}
    );
    var sender = RecordingSender{ .alloc = alloc, .responses = &.{ok_response} };
    var secrets = SecretMap{ .entries = &.{} };
    const res = try handle(alloc, cfg, .{
        .method = "POST",
        .path = "/h",
        .content_type = "application/json",
        .body = linear_todo_payload,
    }, makeDeps(&sender, &secrets));

    try testing.expectEqual(@as(u16, 200), res.response.status);
    try testing.expect(std.mem.indexOf(u8, res.response.body, "\"outcome\":\"launched\"") != null);
    try testing.expectEqual(@as(usize, 1), sender.requests.items.len);
}

test "predicate mismatch filters before resolve dedup payload file or launch" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var td = testing.tmpDir(.{});
    defer td.cleanup();
    const dir = try td.dir.realpathAlloc(alloc, ".");
    const state_path = try std.fs.path.join(alloc, &.{ dir, "seen.json" });
    var store = try runner.DedupStore.open(testing.allocator, state_path);
    defer store.deinit();

    const cfg = try cfgWith(alloc,
        \\{"path":"/h","source":"linear","command":"c","title":"${missing.required}","dedup_header":"X-Delivery","predicates":[{"field":"issue.state.name","equals":"Todo"}],"auth":{"mode":"none"}}
    );
    var sender = RecordingSender{ .alloc = alloc, .responses = &.{} };
    var secrets = SecretMap{ .entries = &.{} };
    var persister = CountingPersister{};
    var deps = makeDeps(&sender, &secrets);
    deps.prompt_dir = dir;
    deps.dedup = &store;
    deps.persist = CountingPersister.persist;
    deps.persist_ctx = &persister;

    const res = try handle(alloc, cfg, .{
        .method = "POST",
        .path = "/h",
        .content_type = "application/json",
        .headers = &.{.{ .name = "X-Delivery", .value = "D1" }},
        .body = linear_done_payload,
    }, deps);

    try testing.expectEqual(@as(u16, 200), res.response.status);
    try testing.expect(std.mem.indexOf(u8, res.response.body, "\"outcome\":\"filtered\"") != null);
    try testing.expect(std.mem.indexOf(u8, res.response.body, "issue.state.name") != null);
    try testing.expectEqual(runner.Outcome.filtered, res.record.?.outcome);
    try testing.expectEqual(@as(usize, 0), sender.requests.items.len);
    try testing.expectEqual(@as(usize, 0), store.count());
    try testing.expectEqual(@as(usize, 0), persister.calls);

    var it = td.dir.iterate();
    while (try it.next()) |entry| {
        try testing.expect(!std.mem.startsWith(u8, entry.name, payload_file_prefix));
    }
}

test "missing predicate field filters without launching" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const cfg = try cfgWith(alloc,
        \\{"path":"/h","source":"linear","command":"c","predicates":[{"field":"issue.state.name","equals":"Todo"}],"auth":{"mode":"none"}}
    );
    var sender = RecordingSender{ .alloc = alloc, .responses = &.{} };
    var secrets = SecretMap{ .entries = &.{} };
    const res = try handle(alloc, cfg, .{
        .method = "POST",
        .path = "/h",
        .content_type = "application/json",
        .body = linear_payload,
    }, makeDeps(&sender, &secrets));

    try testing.expectEqual(@as(u16, 200), res.response.status);
    try testing.expect(std.mem.indexOf(u8, res.response.body, "\"outcome\":\"filtered\"") != null);
    try testing.expectEqual(@as(usize, 0), sender.requests.items.len);
}

test "boolean predicate filters GitHub pull requests by merged flag" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const cfg = try cfgWith(alloc,
        \\{"path":"/h","source":"github","command":"c","predicates":[{"field":"object.type","equals":"pull_request"},{"field":"pull_request.merged","equals_bool":true}],"auth":{"mode":"none"}}
    );
    var secrets = SecretMap{ .entries = &.{} };

    var s1 = RecordingSender{ .alloc = alloc, .responses = &.{ok_response} };
    const merged = try handle(alloc, cfg, .{
        .method = "POST",
        .path = "/h",
        .content_type = "application/json",
        .body = github_pr_merged_payload,
    }, makeDeps(&s1, &secrets));
    try testing.expectEqual(@as(u16, 200), merged.response.status);
    try testing.expect(std.mem.indexOf(u8, merged.response.body, "\"outcome\":\"launched\"") != null);
    try testing.expectEqual(@as(usize, 1), s1.requests.items.len);

    var s2 = RecordingSender{ .alloc = alloc, .responses = &.{} };
    const unmerged = try handle(alloc, cfg, .{
        .method = "POST",
        .path = "/h",
        .content_type = "application/json",
        .body = github_pr_unmerged_payload,
    }, makeDeps(&s2, &secrets));
    try testing.expectEqual(@as(u16, 200), unmerged.response.status);
    try testing.expect(std.mem.indexOf(u8, unmerged.response.body, "\"outcome\":\"filtered\"") != null);
    try testing.expectEqual(@as(usize, 0), s2.requests.items.len);
}

test "no-inference: predicate ignores bait fields the adapter did not copy" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const cfg = try cfgWith(alloc,
        \\{"path":"/h","source":"linear","command":"c","predicates":[{"field":"issue.state.name","equals":"Todo"}],"auth":{"mode":"none"}}
    );
    const bait_payload =
        \\{"action":"update","type":"Issue","data":{"id":"evt-1","identifier":"MAX-9","title":"Safe Title","state":"Todo","branch":"LEAK_BRANCH"}}
    ;
    var sender = RecordingSender{ .alloc = alloc, .responses = &.{} };
    var secrets = SecretMap{ .entries = &.{} };
    const res = try handle(alloc, cfg, .{
        .method = "POST",
        .path = "/h",
        .content_type = "application/json",
        .body = bait_payload,
    }, makeDeps(&sender, &secrets));

    try testing.expectEqual(@as(u16, 200), res.response.status);
    try testing.expect(std.mem.indexOf(u8, res.response.body, "\"outcome\":\"filtered\"") != null);
    try testing.expectEqual(@as(usize, 0), sender.requests.items.len);
}

test "a redelivered delivery id is suppressed; a new id launches" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var td = testing.tmpDir(.{});
    defer td.cleanup();
    const base = try td.dir.realpathAlloc(alloc, ".");
    const path = try std.fs.path.join(alloc, &.{ base, "seen.json" });
    var store = try runner.DedupStore.open(testing.allocator, path);
    defer store.deinit();

    // Dedup keys on a configured per-delivery header, NOT the object id.
    const cfg = try cfgWith(alloc,
        \\{"path":"/h","source":"linear","command":"c","dedup_header":"X-Delivery","auth":{"mode":"none"}}
    );
    var secrets = SecretMap{ .entries = &.{} };

    // First delivery (id D1) launches.
    var s1 = RecordingSender{ .alloc = alloc, .responses = &.{ok_response} };
    var d1 = makeDeps(&s1, &secrets);
    d1.dedup = &store;
    const r1 = try handle(alloc, cfg, .{
        .method = "POST",
        .path = "/h",
        .content_type = "application/json",
        .headers = &.{.{ .name = "X-Delivery", .value = "D1" }},
        .body = linear_payload,
    }, d1);
    try testing.expectEqual(@as(u16, 200), r1.response.status);
    try testing.expect(std.mem.indexOf(u8, r1.response.body, "launched") != null);

    // A RETRY of D1 (same delivery, same object) is suppressed: no control request.
    var s2 = RecordingSender{ .alloc = alloc, .responses = &.{} };
    var d2 = makeDeps(&s2, &secrets);
    d2.dedup = &store;
    const r2 = try handle(alloc, cfg, .{
        .method = "POST",
        .path = "/h",
        .content_type = "application/json",
        .headers = &.{.{ .name = "X-Delivery", .value = "D1" }},
        .body = linear_payload,
    }, d2);
    try testing.expectEqual(@as(u16, 200), r2.response.status);
    try testing.expect(std.mem.indexOf(u8, r2.response.body, "duplicate") != null);
    try testing.expectEqual(@as(usize, 0), s2.requests.items.len);

    // A DIFFERENT delivery (id D2) for the same object/payload still launches —
    // distinct events for the same issue/PR are not treated as duplicates.
    var s3 = RecordingSender{ .alloc = alloc, .responses = &.{ok_response} };
    var d3 = makeDeps(&s3, &secrets);
    d3.dedup = &store;
    const r3 = try handle(alloc, cfg, .{
        .method = "POST",
        .path = "/h",
        .content_type = "application/json",
        .headers = &.{.{ .name = "X-Delivery", .value = "D2" }},
        .body = linear_payload,
    }, d3);
    try testing.expectEqual(@as(u16, 200), r3.response.status);
    try testing.expect(std.mem.indexOf(u8, r3.response.body, "launched") != null);
    try testing.expectEqual(@as(usize, 1), s3.requests.items.len);
}

test "a dedup launch persists before acknowledging; a persist failure is surfaced" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var td = testing.tmpDir(.{});
    defer td.cleanup();
    const base = try td.dir.realpathAlloc(alloc, ".");
    const path = try std.fs.path.join(alloc, &.{ base, "seen.json" });
    var store = try runner.DedupStore.open(testing.allocator, path);
    defer store.deinit();

    const cfg = try cfgWith(alloc,
        \\{"path":"/h","source":"linear","command":"c","dedup_header":"X-Delivery","auth":{"mode":"none"}}
    );
    var secrets = SecretMap{ .entries = &.{} };

    // A successful persist: launched, persister called once, no warning.
    var ok_p = CountingPersister{};
    var s1 = RecordingSender{ .alloc = alloc, .responses = &.{ok_response} };
    var d1 = makeDeps(&s1, &secrets);
    d1.dedup = &store;
    d1.persist = CountingPersister.persist;
    d1.persist_ctx = &ok_p;
    const r1 = try handle(alloc, cfg, .{
        .method = "POST",
        .path = "/h",
        .content_type = "application/json",
        .headers = &.{.{ .name = "X-Delivery", .value = "D1" }},
        .body = linear_payload,
    }, d1);
    try testing.expectEqual(@as(u16, 200), r1.response.status);
    try testing.expect(std.mem.indexOf(u8, r1.response.body, "\"outcome\":\"launched\"") != null);
    try testing.expect(std.mem.indexOf(u8, r1.response.body, "warning") == null);
    try testing.expectEqual(@as(usize, 1), ok_p.calls);

    // A failing persist on a NEW delivery: still 200 launched (the tab exists),
    // but the non-durable dedup is surfaced as a warning rather than hidden.
    var bad_p = CountingPersister{ .fail = true };
    var s2 = RecordingSender{ .alloc = alloc, .responses = &.{ok_response} };
    var d2 = makeDeps(&s2, &secrets);
    d2.dedup = &store;
    d2.persist = CountingPersister.persist;
    d2.persist_ctx = &bad_p;
    const r2 = try handle(alloc, cfg, .{
        .method = "POST",
        .path = "/h",
        .content_type = "application/json",
        .headers = &.{.{ .name = "X-Delivery", .value = "D2" }},
        .body = linear_payload,
    }, d2);
    try testing.expectEqual(@as(u16, 200), r2.response.status);
    try testing.expect(std.mem.indexOf(u8, r2.response.body, "\"outcome\":\"launched\"") != null);
    try testing.expect(std.mem.indexOf(u8, r2.response.body, "dedup_not_persisted") != null);
    try testing.expectEqual(@as(usize, 1), bad_p.calls);
}

test "without a configured delivery header, repeated deliveries each launch" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var td = testing.tmpDir(.{});
    defer td.cleanup();
    const base = try td.dir.realpathAlloc(alloc, ".");
    const path = try std.fs.path.join(alloc, &.{ base, "seen.json" });
    var store = try runner.DedupStore.open(testing.allocator, path);
    defer store.deinit();

    // No dedup_header: the object-id default would be wrong, so dedup is off.
    const cfg = try cfgWith(alloc,
        \\{"path":"/h","source":"linear","command":"c","auth":{"mode":"none"}}
    );
    var secrets = SecretMap{ .entries = &.{} };
    const req: Request = .{ .method = "POST", .path = "/h", .content_type = "application/json", .body = linear_payload };

    for (0..2) |_| {
        var s = RecordingSender{ .alloc = alloc, .responses = &.{ok_response} };
        var d = makeDeps(&s, &secrets);
        d.dedup = &store;
        const r = try handle(alloc, cfg, req, d);
        try testing.expectEqual(@as(u16, 200), r.response.status);
        try testing.expect(std.mem.indexOf(u8, r.response.body, "launched") != null);
        try testing.expectEqual(@as(usize, 1), s.requests.items.len);
    }
}

test "failed launch maps to 502" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    const cfg = try cfgWith(alloc,
        \\{"path":"/h","source":"linear","command":"c","auth":{"mode":"none"}}
    );
    var sender = RecordingSender{ .alloc = alloc, .responses = &.{
        "{\"ok\":false,\"error\":{\"code\":\"unauthorized\",\"message\":\"denied\"}}",
    } };
    var secrets = SecretMap{ .entries = &.{} };
    const res = try handle(alloc, cfg, .{
        .method = "POST",
        .path = "/h",
        .content_type = "application/json",
        .body = linear_payload,
    }, makeDeps(&sender, &secrets));
    try testing.expectEqual(@as(u16, 502), res.response.status);
    try testing.expect(std.mem.indexOf(u8, res.response.body, "unauthorized") != null);
}

test "raw payload is delivered as a temp file env var" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var td = testing.tmpDir(.{});
    defer td.cleanup();
    const dir = try td.dir.realpathAlloc(alloc, ".");

    const cfg = try cfgWith(alloc,
        \\{"path":"/h","source":"linear","command":"c","auth":{"mode":"none"}}
    );
    var sender = RecordingSender{ .alloc = alloc, .responses = &.{ok_response} };
    var secrets = SecretMap{ .entries = &.{} };
    var d = makeDeps(&sender, &secrets);
    d.prompt_dir = dir;

    const res = try handle(alloc, cfg, .{
        .method = "POST",
        .path = "/h",
        .content_type = "application/json",
        .body = linear_payload,
    }, d);
    try testing.expectEqual(@as(u16, 200), res.response.status);

    // The create request carries the payload-file env var pointing at a file that
    // holds the exact raw body.
    const sent = sender.requests.items[0];
    const parsed = try std.json.parseFromSliceLeaky(std.json.Value, alloc, sent, .{});
    const env = parsed.object.get("params").?.object.get("env").?.array;
    const prefix = payload_file_env_var ++ "=";
    var payload_path: ?[]const u8 = null;
    for (env.items) |e| {
        if (std.mem.startsWith(u8, e.string, prefix)) payload_path = e.string[prefix.len..];
    }
    try testing.expect(payload_path != null);
    const written = try std.fs.cwd().readFileAlloc(alloc, payload_path.?, 4096);
    try testing.expectEqualStrings(linear_payload, written);
    try testing.expect(std.mem.startsWith(u8, std.fs.path.basename(payload_path.?), payload_file_prefix));
}

test "a failed launch deletes the raw payload temp file" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var td = testing.tmpDir(.{});
    defer td.cleanup();
    const dir = try td.dir.realpathAlloc(alloc, ".");

    const cfg = try cfgWith(alloc,
        \\{"path":"/h","source":"linear","command":"c","auth":{"mode":"none"}}
    );
    // The control API denies the create -> outcome .failed.
    var sender = RecordingSender{ .alloc = alloc, .responses = &.{
        "{\"ok\":false,\"error\":{\"code\":\"unauthorized\"}}",
    } };
    var secrets = SecretMap{ .entries = &.{} };
    var d = makeDeps(&sender, &secrets);
    d.prompt_dir = dir;

    const res = try handle(alloc, cfg, .{
        .method = "POST",
        .path = "/h",
        .content_type = "application/json",
        .body = linear_payload,
    }, d);
    try testing.expectEqual(@as(u16, 502), res.response.status);

    // No orphan payload file is left behind.
    var it = td.dir.iterate();
    while (try it.next()) |entry| {
        try testing.expect(!std.mem.startsWith(u8, entry.name, payload_file_prefix));
    }
}

test "no-inference: webhook bait fields never reach the launch" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const cfg = try cfgWith(alloc,
        \\{"path":"/h","source":"linear","command":"claude","title":"${title}","auth":{"mode":"none"}}
    );
    // A payload stuffed with bait the adapter does not copy.
    const payload =
        \\{"action":"update","type":"Issue","data":{"id":"evt-1","identifier":"MAX-9","title":"Safe Title","url":"https://linear.app/x","branch":"feature/LEAK_BRANCH","state":"LEAK_STATE"}}
    ;
    var sender = RecordingSender{ .alloc = alloc, .responses = &.{ok_response} };
    var secrets = SecretMap{ .entries = &.{} };
    _ = try handle(alloc, cfg, .{
        .method = "POST",
        .path = "/h",
        .content_type = "application/json",
        .body = payload,
    }, makeDeps(&sender, &secrets));

    // None of the bait fields may appear in the emitted control request. (The raw
    // payload file is off by default — no prompt_dir — so the body cannot leak
    // through it here either.)
    const sent = sender.requests.items[0];
    for ([_][]const u8{ "LEAK_BRANCH", "LEAK_STATE", "branch", "state" }) |needle| {
        try testing.expect(std.mem.indexOf(u8, sent, needle) == null);
    }
}

test "isJsonContentType accepts parameters" {
    try testing.expect(isJsonContentType("application/json"));
    try testing.expect(isJsonContentType("application/json; charset=utf-8"));
    try testing.expect(isJsonContentType("APPLICATION/JSON"));
    try testing.expect(!isJsonContentType("text/plain"));
    try testing.expect(!isJsonContentType(null));
}
