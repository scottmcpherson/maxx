//! The automation trigger runner.
//!
//! This is the *execution* counterpart to the pure connector layer. The
//! connector layer (`src/connector`) turns a structured external payload into a
//! resolved `LaunchRequest` and stops there, on purpose. The runner is the small
//! local piece that actually *runs* it: it receives a trigger event, resolves
//! the configured action, suppresses duplicates, and launches a visible Maxx tab
//! through the existing Control API — then records what happened.
//!
//! The whole runner is one narrow pipeline, mirroring the issue's
//! `TriggerEvent -> RunnerAction -> VisibleTabExecution`:
//!
//!   1. **Receive** an event. Three adapters deliver the payload bytes — a
//!      `poll` check (`poll.zig`), a local `script` invocation, or a
//!      `webhook_relay` delivery — but all three converge on the same thing: a
//!      structured payload handed to a connector adapter. The trigger *type* is
//!      recorded as provenance; it never changes how the action is chosen.
//!   2. **Resolve** the payload (connector adapter → `TriggerEvent`) and the
//!      configured `LaunchTemplate` (`connector.resolve` → `LaunchRequest`).
//!   3. **Suppress duplicates** against the persistent `DedupStore`, keyed on the
//!      explicit adapter event id (or a configured cursor).
//!   4. **Execute** the launch: inject the capability token, send
//!      `sessions.create` to the running Maxx, and deliver the prompt out of band
//!      for `stdin`/`file` modes.
//!   5. **Record** an `ActivityRecord` (and mark the event seen) so the firing is
//!      visible and idempotent.
//!
//! ## No inference
//!
//! The runner is rigorously a runtime/control plane, never a workflow brain:
//!
//!   * It never scrapes or interprets terminal output. A poll check's *exit code*
//!     decides whether to fire (a configured contract); the check's stdout is an
//!     opaque payload forwarded to the adapter, not read for meaning.
//!   * Action selection comes only from explicit configuration and explicit
//!     event fields — never from process names, branch names, paths, tab titles,
//!     or idle time.
//!   * The provenance it attaches (`runner.*` metadata) is explicit
//!     caller-supplied data copied verbatim.

const std = @import("std");
const Allocator = std.mem.Allocator;

pub const DedupStore = @import("DedupStore.zig");
pub const poll = @import("poll.zig");

const connector = @import("../connector/connector.zig");
pub const TriggerEvent = connector.TriggerEvent;
pub const LaunchRequest = connector.LaunchRequest;
pub const Pair = connector.Template.Pair;
pub const PromptDelivery = connector.Template.PromptDelivery;

const log = std.log.scoped(.runner);

/// How a trigger's payload reached the runner. This is *provenance only* — it is
/// recorded and displayed, but never used to choose or alter the action.
pub const TriggerType = enum {
    /// A configured check command fired (`poll.zig`).
    poll,
    /// A local process invoked the runner with a concrete payload.
    script,
    /// A local webhook relay delivered an event.
    webhook_relay,
};

/// Abstraction over "send a control request, get a response". The CLI backs this
/// with a real Unix-socket round-trip (`control_client`); tests back it with a
/// recording fake. Keeping it injectable makes the whole dispatch pipeline —
/// dedup, execution, prompt delivery, recording — testable without a socket.
pub const Sender = struct {
    ctx: *anyopaque,
    sendFn: *const fn (ctx: *anyopaque, alloc: Allocator, request: []const u8) anyerror![]const u8,

    pub fn send(self: Sender, alloc: Allocator, request: []const u8) anyerror![]const u8 {
        return self.sendFn(self.ctx, alloc, request);
    }
};

/// The result of dispatching one trigger event.
pub const Outcome = enum {
    /// A visible tab was created for the event.
    launched,
    /// The event was already acted on (same trigger/source/key); skipped.
    duplicate,
    /// Resolution succeeded but execution failed; see `error_code`.
    failed,
    /// `--dry-run`: resolved and dedup-checked, but nothing was sent or recorded.
    dry_run,
    /// Explicit predicates did not match; nothing was resolved, sent, or recorded.
    filtered,
};

/// Everything needed to dispatch one already-resolved event.
pub const DispatchInput = struct {
    /// Display name of the configured trigger (provenance only).
    trigger: []const u8,
    trigger_type: TriggerType,
    /// The normalized event (for the source id and provenance).
    event: TriggerEvent,
    /// The resolved launch (command/cwd/env/metadata/prompt/caller/group).
    request: LaunchRequest,
    /// The per-call capability token to inject into the control request.
    token: []const u8,
    /// ISO-8601 UTC timestamp; recorded as provenance and as the dedup time.
    received_at: []const u8,
    /// Explicit duplicate-suppression key. Defaults to `event.id` when null —
    /// callers pass a configured cursor here when the source provides one.
    dedup_key: ?[]const u8 = null,
    /// Persistent dedup store, or null to disable suppression entirely.
    dedup: ?*DedupStore = null,
    /// Directory for the temp prompt file used by `.file` delivery.
    prompt_dir: ?[]const u8 = null,
    /// Resolve + dedup-check only; never send or record.
    dry_run: bool = false,
};

/// A concise, visible record of one trigger firing.
pub const ActivityRecord = struct {
    trigger: []const u8,
    trigger_type: TriggerType,
    received_at: []const u8,
    source: []const u8,
    event_id: []const u8,
    dedup_key: []const u8,
    command: []const u8,
    title: []const u8,
    outcome: Outcome,
    session_id: ?[]const u8 = null,
    error_code: ?[]const u8 = null,
    error_message: ?[]const u8 = null,

    pub fn writeJson(self: ActivityRecord, json: *std.json.Stringify) !void {
        try json.beginObject();
        try json.objectField("trigger");
        try json.write(self.trigger);
        try json.objectField("trigger_type");
        try json.write(@tagName(self.trigger_type));
        try json.objectField("received_at");
        try json.write(self.received_at);
        try json.objectField("source");
        try json.write(self.source);
        try json.objectField("event_id");
        try json.write(self.event_id);
        try json.objectField("dedup_key");
        try json.write(self.dedup_key);
        try json.objectField("command");
        try json.write(self.command);
        try json.objectField("title");
        try json.write(self.title);
        try json.objectField("outcome");
        try json.write(@tagName(self.outcome));
        try json.objectField("session_id");
        try json.write(self.session_id);
        if (self.error_code) |c| {
            try json.objectField("error_code");
            try json.write(c);
        }
        if (self.error_message) |m| {
            try json.objectField("error_message");
            try json.write(m);
        }
        try json.endObject();
    }
};

/// Dispatch one resolved trigger event: suppress duplicates, execute the launch,
/// deliver the prompt, and return a visible record. Operational failures (a
/// denied request, an unreachable socket, a prompt-file error) are captured into
/// the returned record as `outcome = .failed` with an `error_code`, never thrown
/// — only allocation failure propagates. A failed launch is NOT recorded as
/// seen, so a transient failure can be retried; a successful launch is.
pub fn dispatch(alloc: Allocator, in: DispatchInput, sender: Sender) Allocator.Error!ActivityRecord {
    const key = in.dedup_key orelse in.event.id;
    var rec: ActivityRecord = .{
        .trigger = in.trigger,
        .trigger_type = in.trigger_type,
        .received_at = in.received_at,
        .source = in.event.source,
        .event_id = in.event.id,
        .dedup_key = key,
        .command = in.request.command,
        .title = in.request.title,
        .outcome = .failed,
    };

    // 1. Duplicate suppression, before any side effect.
    if (in.dedup) |store| {
        // First, reject an unrecordable key up front. If the trigger/source/key
        // exceed the dedup store's field caps, the post-launch `markSeen` would
        // deterministically fail — leaving a launched tab whose dedup record is
        // impossible, so every retry would spawn another. Fail now, before any
        // create, so this known failure has no side effect (use --no-dedup if a
        // source legitimately needs keys this large).
        if (!DedupStore.recordable(in.trigger, in.event.source, key)) {
            rec.error_code = "dedup_key_too_long";
            rec.error_message = "trigger/source/dedup key exceeds the dedup store field caps";
            return rec; // outcome stays .failed; nothing launched
        }
        if (store.seen(in.trigger, in.event.source, key)) {
            rec.outcome = .duplicate;
            return rec;
        }
    }

    // 2. Dry-run stops here: resolved and dedup-checked, nothing sent or recorded.
    if (in.dry_run) {
        rec.outcome = .dry_run;
        return rec;
    }

    // 3. Build the create request: token + runner provenance + (for .file
    //    delivery) the prompt-file env var.
    var extra_env_buf: [1]Pair = undefined;
    var extra_env: []const Pair = &.{};
    if (in.request.prompt_delivery == .file and in.request.prompt != null) {
        const path = writePromptFile(alloc, in) catch |err| {
            rec.error_code = "prompt_file_failed";
            rec.error_message = @errorName(err);
            return rec;
        };
        extra_env_buf[0] = .{ .key = "MAXX_CONNECTOR_PROMPT_FILE", .value = path };
        extra_env = extra_env_buf[0..1];
    }
    const meta = try runnerMetadata(alloc, in);
    const create_req = try buildCreateRequest(alloc, in.request, .{
        .token = in.token,
        .extra_env = extra_env,
        .extra_metadata = meta,
    });

    // 4. Send the create request.
    const resp = sender.send(alloc, create_req) catch |err| {
        rec.error_code = "send_failed";
        rec.error_message = @errorName(err);
        return rec;
    };
    switch (parseResponse(alloc, resp) catch {
        rec.error_code = "bad_response";
        return rec;
    }) {
        .err => |e| {
            rec.error_code = e.code;
            rec.error_message = e.message;
            return rec;
        },
        .ok => |session_id| rec.session_id = session_id,
    }

    // 5. Out-of-band prompt delivery for stdin (env/file were handled at create).
    if (in.request.prompt_delivery == .stdin) {
        if (in.request.prompt) |p| {
            if (rec.session_id) |sid| {
                try deliverStdinPrompt(alloc, in, sid, p, sender, &rec);
            }
        }
    }

    // 6. Record as seen only after a successful launch.
    //
    // We key dedup on the *create* — the create is the side effect that must not
    // repeat (a retry would spawn a second visible tab). A failed stdin prompt
    // push (step 5) does not undo the create, so we still record the event; the
    // failure is surfaced loudly instead (`error_code` set above + a non-zero CLI
    // exit), and the operator re-delivers the prompt explicitly with
    // `sessions action <id> --action submit` rather than re-firing the trigger
    // and duplicating the tab.
    if (in.dedup) |store| {
        store.markSeen(in.trigger, in.event.source, key, in.received_at) catch |err| {
            if (rec.error_code == null) {
                rec.error_code = "dedup_record_failed";
                rec.error_message = @errorName(err);
            }
        };
    }

    rec.outcome = .launched;
    return rec;
}

/// Deliver the resolved prompt to a freshly-created session over stdin via a
/// `sessions.action submit` request, then inspect the result. The follow-up is
/// attributed to the SAME policy `caller` as the create (so a restricted source
/// cannot be evaluated as the trusted local source for the `input:send`
/// capability), and a denied/failed delivery (`ok:false`, a socket error, or an
/// unparseable response) is recorded on `rec` rather than silently treated as
/// success. The create already succeeded, so this never throws on a delivery
/// failure — only allocation failure propagates.
fn deliverStdinPrompt(
    alloc: Allocator,
    in: DispatchInput,
    session_id: []const u8,
    prompt: []const u8,
    sender: Sender,
    rec: *ActivityRecord,
) Allocator.Error!void {
    const input_req = try buildInputRequest(alloc, in.token, in.request.caller, session_id, prompt);
    const resp = sender.send(alloc, input_req) catch |err| {
        setPromptError(rec, "prompt_delivery_failed", @errorName(err));
        return;
    };
    switch (parseResponse(alloc, resp) catch {
        setPromptError(rec, "prompt_delivery_failed", "unparseable response");
        return;
    }) {
        .ok => {},
        // The server rejected the submit (e.g. unauthorized / confirmation_required
        // / already_ended). The tab launched but the prompt was not delivered.
        .err => |e| setPromptError(rec, e.code, e.message orelse "prompt delivery rejected"),
    }
}

fn setPromptError(rec: *ActivityRecord, code: []const u8, message: ?[]const u8) void {
    if (rec.error_code != null) return; // keep the first failure
    rec.error_code = code;
    rec.error_message = message;
}

/// Build the runner's explicit provenance metadata. Reserved `runner.*` keys
/// only; every value is explicit caller-supplied data copied verbatim.
fn runnerMetadata(alloc: Allocator, in: DispatchInput) Allocator.Error![]const Pair {
    var list: std.ArrayList(Pair) = .empty;
    try list.append(alloc, .{ .key = "runner.trigger", .value = in.trigger });
    try list.append(alloc, .{ .key = "runner.trigger_type", .value = @tagName(in.trigger_type) });
    try list.append(alloc, .{ .key = "runner.received_at", .value = in.received_at });
    return list.toOwnedSlice(alloc);
}

fn buildCreateRequest(
    alloc: Allocator,
    req: LaunchRequest,
    opts: LaunchRequest.ControlRequestOptions,
) Allocator.Error![]u8 {
    var out: std.io.Writer.Allocating = .init(alloc);
    errdefer out.deinit();
    var json: std.json.Stringify = .{ .writer = &out.writer, .options = .{} };
    req.writeControlRequest(alloc, &json, opts) catch return error.OutOfMemory;
    return out.toOwnedSlice();
}

/// Build a `sessions.action` request that pastes `input` into `session_id` and
/// sends Enter. The optional `caller` attributes the action to the same policy
/// source as the create, so the `input:send` capability is evaluated against
/// that source rather than defaulting to the trusted local source.
fn buildInputRequest(
    alloc: Allocator,
    token: []const u8,
    caller: ?[]const u8,
    session_id: []const u8,
    input: []const u8,
) Allocator.Error![]u8 {
    var out: std.io.Writer.Allocating = .init(alloc);
    errdefer out.deinit();
    var json: std.json.Stringify = .{ .writer = &out.writer, .options = .{} };
    writeInputRequest(&json, token, caller, session_id, input) catch return error.OutOfMemory;
    return out.toOwnedSlice();
}

fn writeInputRequest(
    json: *std.json.Stringify,
    token: []const u8,
    caller: ?[]const u8,
    session_id: []const u8,
    input: []const u8,
) !void {
    try json.beginObject();
    try json.objectField("token");
    try json.write(token);
    try json.objectField("method");
    try json.write("sessions.action");
    try json.objectField("params");
    try json.beginObject();
    try json.objectField("id");
    try json.write(session_id);
    // Same policy source as the create — never silently the trusted local source.
    if (caller) |c| {
        try json.objectField("caller");
        try json.write(c);
    }
    try json.objectField("action");
    try json.write("submit");
    try json.objectField("input");
    try json.write(input);
    try json.endObject();
    try json.endObject();
}

const ParsedResponse = union(enum) {
    ok: ?[]const u8, // session_id, when present
    err: struct { code: []const u8, message: ?[]const u8 },
};

/// Parse a control response envelope into ok(session_id?) or err(code,message).
/// `alloc` is needed for JSON parsing; returned strings borrow the parsed tree,
/// which lives in `alloc`.
fn parseResponse(alloc: Allocator, response: []const u8) !ParsedResponse {
    const trimmed = std.mem.trim(u8, response, &std.ascii.whitespace);
    const parsed = try std.json.parseFromSliceLeaky(std.json.Value, alloc, trimmed, .{});
    if (parsed != .object) return error.BadResponse;
    const obj = parsed.object;

    const ok = obj.get("ok") orelse return error.BadResponse;
    if (ok == .bool and ok.bool) {
        var session_id: ?[]const u8 = null;
        if (obj.get("result")) |result| {
            if (result == .object) {
                if (result.object.get("session")) |session| {
                    if (session == .object) {
                        if (session.object.get("session_id")) |sid| {
                            if (sid == .string) session_id = sid.string;
                        }
                    }
                }
            }
        }
        return .{ .ok = session_id };
    }

    var code: []const u8 = "error";
    var message: ?[]const u8 = null;
    if (obj.get("error")) |err| {
        if (err == .object) {
            if (err.object.get("code")) |c| {
                if (c == .string) code = c.string;
            }
            if (err.object.get("message")) |m| {
                if (m == .string) message = m.string;
            }
        }
    }
    return .{ .err = .{ .code = code, .message = message } };
}

/// Write the resolved prompt to a temp file in `prompt_dir` (0600) and return
/// its path. Used for `.file` delivery; the path rides in `MAXX_CONNECTOR_PROMPT_FILE`.
///
/// The filename is unique per launch — `maxx-prompt-<id>-<pid>-<nanos>.txt` — and
/// created exclusively, so two invocations for the same event id (two triggers,
/// or a retry before the first tab reads its prompt) never overwrite each other's
/// file. Without this, an earlier tab could read a later launch's prompt.
fn writePromptFile(alloc: Allocator, in: DispatchInput) ![]const u8 {
    const dir = in.prompt_dir orelse return error.NoPromptDir;
    const safe = try sanitizeForFilename(alloc, in.event.id);
    const name = try std.fmt.allocPrint(alloc, "maxx-prompt-{s}-{d}-{d}.txt", .{
        safe, std.c.getpid(), std.time.nanoTimestamp(),
    });
    const path = try std.fs.path.join(alloc, &.{ dir, name });
    // Exclusive create: never silently overwrite an existing prompt file.
    const file = try std.fs.cwd().createFile(path, .{ .exclusive = true, .mode = 0o600 });
    defer file.close();
    try file.writeAll(in.request.prompt.?);
    return path;
}

/// Default age past which `.file`-delivery prompt temp files are swept. They are
/// read by the launched agent shortly after launch, so a day is ample.
pub const default_prompt_file_ttl_s: i64 = 24 * 60 * 60;

/// Best-effort GC of stale `.file`-delivery prompt files in `dir_path`. A prompt
/// file must outlive the runner process (the launched agent reads it later), so
/// the runner cannot delete its own; instead each `.file` run sweeps files left
/// by *previous* runs once they age past `max_age_s`. Errors are ignored — this
/// is housekeeping, never load-bearing. `now_s` is the current epoch (seconds).
pub fn sweepStalePromptFiles(dir_path: []const u8, max_age_s: i64, now_s: i64) void {
    var dir = std.fs.cwd().openDir(dir_path, .{ .iterate = true }) catch return;
    defer dir.close();
    const cutoff_ns: i128 = @as(i128, now_s - max_age_s) * std.time.ns_per_s;
    var it = dir.iterate();
    while (it.next() catch return) |entry| {
        if (entry.kind != .file) continue;
        if (!std.mem.startsWith(u8, entry.name, "maxx-prompt-")) continue;
        if (!std.mem.endsWith(u8, entry.name, ".txt")) continue;
        const st = dir.statFile(entry.name) catch continue;
        if (st.mtime < cutoff_ns) dir.deleteFile(entry.name) catch {};
    }
}

/// Replace any character outside `[A-Za-z0-9._-]` with `_` so an arbitrary event
/// id is safe as a filename component.
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

/// Format `epoch_secs` (UTC seconds) as `YYYY-MM-DDTHH:MM:SSZ` into `buf`.
pub fn epochToIso(buf: []u8, epoch_secs: u64) []const u8 {
    const es = std.time.epoch.EpochSeconds{ .secs = epoch_secs };
    const day = es.getEpochDay();
    const yd = day.calculateYearDay();
    const md = yd.calculateMonthDay();
    const ds = es.getDaySeconds();
    return std.fmt.bufPrint(buf, "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}Z", .{
        yd.year,
        md.month.numeric(),
        @as(u16, md.day_index) + 1,
        ds.getHoursIntoDay(),
        ds.getMinutesIntoHour(),
        ds.getSecondsIntoMinute(),
    }) catch unreachable; // 20-byte output always fits the buffers we pass.
}

/// Current time as an ISO-8601 UTC string, owned by `alloc`.
pub fn nowIso(alloc: Allocator) Allocator.Error![]const u8 {
    const secs = std.time.timestamp();
    var buf: [32]u8 = undefined;
    const s = epochToIso(&buf, @intCast(@max(secs, 0)));
    return alloc.dupe(u8, s);
}

// ----- tests -----

const testing = std.testing;

test {
    std.testing.refAllDecls(@This());
    _ = DedupStore;
    _ = poll;
}

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

    fn sender(self: *RecordingSender) Sender {
        return .{ .ctx = self, .sendFn = sendImpl };
    }
};

const FailingSender = struct {
    fn sendImpl(ctx: *anyopaque, alloc: Allocator, request: []const u8) anyerror![]const u8 {
        _ = ctx;
        _ = alloc;
        _ = request;
        return error.ConnectFailed;
    }
    fn sender(self: *FailingSender) Sender {
        return .{ .ctx = self, .sendFn = sendImpl };
    }
};

fn linearEvent(alloc: Allocator) !TriggerEvent {
    var ev: TriggerEvent = .{
        .source = "linear",
        .id = "evt-1",
        .type = "Issue",
        .title = "Implement runner",
        .url = "https://linear.app/x/MAX-8",
        .prompt = "Work on MAX-8",
    };
    try ev.putField(alloc, "issue.identifier", "MAX-8");
    return ev;
}

test "dispatch launches a visible tab and records provenance" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const ev = try linearEvent(alloc);
    const req = try connector.resolve(alloc, .{ .command = "claude" }, ev, .{});

    var sender = RecordingSender{
        .alloc = alloc,
        .responses = &.{
            \\{"ok":true,"result":{"session":{"session_id":"SID-1"}}}
        },
    };

    const rec = try dispatch(alloc, .{
        .trigger = "linear-issues",
        .trigger_type = .webhook_relay,
        .event = ev,
        .request = req,
        .token = "cap-token",
        .received_at = "2026-06-15T00:00:00Z",
    }, sender.sender());

    try testing.expectEqual(Outcome.launched, rec.outcome);
    try testing.expectEqualStrings("SID-1", rec.session_id.?);
    try testing.expectEqual(@as(usize, 1), sender.requests.items.len);

    const sent = sender.requests.items[0];
    try testing.expect(std.mem.indexOf(u8, sent, "\"token\":\"cap-token\"") != null);
    try testing.expect(std.mem.indexOf(u8, sent, "sessions.create") != null);
    try testing.expect(std.mem.indexOf(u8, sent, "runner.trigger") != null);
    try testing.expect(std.mem.indexOf(u8, sent, "linear-issues") != null);
    try testing.expect(std.mem.indexOf(u8, sent, "webhook_relay") != null);
    // The prompt rides in env for the default delivery.
    try testing.expect(std.mem.indexOf(u8, sent, "MAXX_CONNECTOR_PROMPT=Work on MAX-8") != null);
}

test "dispatch suppresses a duplicate before sending" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var td = testing.tmpDir(.{});
    defer td.cleanup();
    const base = try td.dir.realpathAlloc(alloc, ".");
    const path = try std.fs.path.join(alloc, &.{ base, "seen.json" });

    var store = try DedupStore.open(testing.allocator, path);
    defer store.deinit();

    const ev = try linearEvent(alloc);
    const req = try connector.resolve(alloc, .{ .command = "claude" }, ev, .{});

    const ok_resp = "{\"ok\":true,\"result\":{\"session\":{\"session_id\":\"SID-1\"}}}";

    // First dispatch launches and records the event as seen.
    var s1 = RecordingSender{ .alloc = alloc, .responses = &.{ok_resp} };
    const rec1 = try dispatch(alloc, .{
        .trigger = "t",
        .trigger_type = .script,
        .event = ev,
        .request = req,
        .token = "tok",
        .received_at = "2026-06-15T00:00:00Z",
        .dedup = &store,
    }, s1.sender());
    try testing.expectEqual(Outcome.launched, rec1.outcome);
    try testing.expect(store.seen("t", "linear", "evt-1"));

    // Second dispatch of the same event is suppressed: no request sent.
    var s2 = RecordingSender{ .alloc = alloc, .responses = &.{} };
    const rec2 = try dispatch(alloc, .{
        .trigger = "t",
        .trigger_type = .script,
        .event = ev,
        .request = req,
        .token = "tok",
        .received_at = "2026-06-15T01:00:00Z",
        .dedup = &store,
    }, s2.sender());
    try testing.expectEqual(Outcome.duplicate, rec2.outcome);
    try testing.expectEqual(@as(usize, 0), s2.requests.items.len);
}

test "dispatch suppresses duplicate poll event after dedup store reopen" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var td = testing.tmpDir(.{});
    defer td.cleanup();
    const base = try td.dir.realpathAlloc(alloc, ".");
    const path = try std.fs.path.join(alloc, &.{ base, "seen.json" });

    const ev = try linearEvent(alloc);
    const req = try connector.resolve(alloc, .{ .command = "claude" }, ev, .{});
    const ok_resp = "{\"ok\":true,\"result\":{\"session\":{\"session_id\":\"SID-1\"}}}";

    {
        var store = try DedupStore.open(testing.allocator, path);
        defer store.deinit();
        var sender = RecordingSender{ .alloc = alloc, .responses = &.{ok_resp} };
        const rec = try dispatch(alloc, .{
            .trigger = "linear-poll",
            .trigger_type = .poll,
            .event = ev,
            .request = req,
            .token = "tok",
            .received_at = "2026-06-16T00:00:00Z",
            .dedup = &store,
        }, sender.sender());
        try testing.expectEqual(Outcome.launched, rec.outcome);
        try store.save();
    }

    {
        var store = try DedupStore.open(testing.allocator, path);
        defer store.deinit();
        var sender = RecordingSender{ .alloc = alloc, .responses = &.{} };
        const rec = try dispatch(alloc, .{
            .trigger = "linear-poll",
            .trigger_type = .poll,
            .event = ev,
            .request = req,
            .token = "tok",
            .received_at = "2026-06-16T00:01:00Z",
            .dedup = &store,
        }, sender.sender());
        try testing.expectEqual(Outcome.duplicate, rec.outcome);
        try testing.expectEqual(@as(usize, 0), sender.requests.items.len);
    }
}

test "dispatch failure is visible and not recorded as seen" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var td = testing.tmpDir(.{});
    defer td.cleanup();
    const base = try td.dir.realpathAlloc(alloc, ".");
    const path = try std.fs.path.join(alloc, &.{ base, "seen.json" });
    var store = try DedupStore.open(testing.allocator, path);
    defer store.deinit();

    const ev = try linearEvent(alloc);
    const req = try connector.resolve(alloc, .{ .command = "claude" }, ev, .{});

    // Server denies the request.
    var sender = RecordingSender{
        .alloc = alloc,
        .responses = &.{
            \\{"ok":false,"error":{"code":"unauthorized","message":"denied"}}
        },
    };
    const rec = try dispatch(alloc, .{
        .trigger = "t",
        .trigger_type = .script,
        .event = ev,
        .request = req,
        .token = "tok",
        .received_at = "2026-06-15T00:00:00Z",
        .dedup = &store,
    }, sender.sender());

    try testing.expectEqual(Outcome.failed, rec.outcome);
    try testing.expectEqualStrings("unauthorized", rec.error_code.?);
    try testing.expectEqualStrings("denied", rec.error_message.?);
    // A denied launch is not recorded — it can be retried once the policy allows.
    try testing.expect(!store.seen("t", "linear", "evt-1"));
}

test "dispatch reports an unreachable socket as failed" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const ev = try linearEvent(alloc);
    const req = try connector.resolve(alloc, .{ .command = "claude" }, ev, .{});
    var sender = FailingSender{};
    const rec = try dispatch(alloc, .{
        .trigger = "t",
        .trigger_type = .script,
        .event = ev,
        .request = req,
        .token = "tok",
        .received_at = "2026-06-15T00:00:00Z",
    }, sender.sender());
    try testing.expectEqual(Outcome.failed, rec.outcome);
    try testing.expectEqualStrings("send_failed", rec.error_code.?);
}

test "dry-run resolves and dedup-checks but never sends or records" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var td = testing.tmpDir(.{});
    defer td.cleanup();
    const base = try td.dir.realpathAlloc(alloc, ".");
    const path = try std.fs.path.join(alloc, &.{ base, "seen.json" });
    var store = try DedupStore.open(testing.allocator, path);
    defer store.deinit();

    const ev = try linearEvent(alloc);
    const req = try connector.resolve(alloc, .{ .command = "claude" }, ev, .{});
    var sender = RecordingSender{ .alloc = alloc, .responses = &.{} };
    const rec = try dispatch(alloc, .{
        .trigger = "t",
        .trigger_type = .script,
        .event = ev,
        .request = req,
        .token = "tok",
        .received_at = "2026-06-15T00:00:00Z",
        .dedup = &store,
        .dry_run = true,
    }, sender.sender());

    try testing.expectEqual(Outcome.dry_run, rec.outcome);
    try testing.expectEqual(@as(usize, 0), sender.requests.items.len);
    try testing.expect(!store.seen("t", "linear", "evt-1"));
}

test "stdin delivery sends a follow-up submit action" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const ev = try linearEvent(alloc);
    const req = try connector.resolve(alloc, .{
        .command = "codex",
        .prompt_delivery = .stdin,
        // A restricted policy source: the follow-up submit must be attributed to it.
        .caller = "trusted-automation",
    }, ev, .{});

    var sender = RecordingSender{
        .alloc = alloc,
        .responses = &.{
            "{\"ok\":true,\"result\":{\"session\":{\"session_id\":\"SID-9\"}}}",
            "{\"ok\":true,\"result\":{}}",
        },
    };
    const rec = try dispatch(alloc, .{
        .trigger = "t",
        .trigger_type = .script,
        .event = ev,
        .request = req,
        .token = "tok",
        .received_at = "2026-06-15T00:00:00Z",
    }, sender.sender());

    try testing.expectEqual(Outcome.launched, rec.outcome);
    try testing.expect(rec.error_code == null);
    try testing.expectEqual(@as(usize, 2), sender.requests.items.len);
    // The create request must NOT carry the prompt for stdin delivery.
    try testing.expect(std.mem.indexOf(u8, sender.requests.items[0], "Work on MAX-8") == null);
    // The follow-up is a sessions.action submit carrying the prompt AND the same
    // policy caller as the create (so input:send is evaluated against that source,
    // not the trusted local source).
    const second = sender.requests.items[1];
    try testing.expect(std.mem.indexOf(u8, second, "sessions.action") != null);
    try testing.expect(std.mem.indexOf(u8, second, "\"action\":\"submit\"") != null);
    try testing.expect(std.mem.indexOf(u8, second, "Work on MAX-8") != null);
    try testing.expect(std.mem.indexOf(u8, second, "SID-9") != null);
    try testing.expect(std.mem.indexOf(u8, second, "\"caller\":\"trusted-automation\"") != null);
}

test "stdin delivery surfaces a rejected submit without claiming success" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var td = testing.tmpDir(.{});
    defer td.cleanup();
    const base = try td.dir.realpathAlloc(alloc, ".");
    const path = try std.fs.path.join(alloc, &.{ base, "seen.json" });
    var store = try DedupStore.open(testing.allocator, path);
    defer store.deinit();

    const ev = try linearEvent(alloc);
    const req = try connector.resolve(alloc, .{
        .command = "codex",
        .prompt_delivery = .stdin,
        .caller = "trusted-automation",
    }, ev, .{});

    // The create succeeds, but the policy denies the follow-up submit.
    var sender = RecordingSender{
        .alloc = alloc,
        .responses = &.{
            "{\"ok\":true,\"result\":{\"session\":{\"session_id\":\"SID-9\"}}}",
            "{\"ok\":false,\"error\":{\"code\":\"unauthorized\",\"message\":\"input denied\"}}",
        },
    };
    const rec = try dispatch(alloc, .{
        .trigger = "t",
        .trigger_type = .script,
        .event = ev,
        .request = req,
        .token = "tok",
        .received_at = "2026-06-15T00:00:00Z",
        .dedup = &store,
    }, sender.sender());

    // The tab launched (the create succeeded), but the prompt failure is surfaced
    // — not reported as a clean success.
    try testing.expectEqual(Outcome.launched, rec.outcome);
    try testing.expectEqualStrings("unauthorized", rec.error_code.?);
    try testing.expectEqualStrings("input denied", rec.error_message.?);
    // The create's side effect is recorded so a retry does not spawn a second tab;
    // the operator re-delivers the prompt explicitly instead.
    try testing.expect(store.seen("t", "linear", "evt-1"));
}

test "file delivery writes a temp file and injects the path env" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var td = testing.tmpDir(.{});
    defer td.cleanup();
    const dir = try td.dir.realpathAlloc(alloc, ".");

    const ev = try linearEvent(alloc);
    const req = try connector.resolve(alloc, .{
        .command = "codex",
        .prompt_delivery = .file,
    }, ev, .{});

    var sender = RecordingSender{
        .alloc = alloc,
        .responses = &.{"{\"ok\":true,\"result\":{\"session\":{\"session_id\":\"SID-1\"}}}"},
    };
    const rec = try dispatch(alloc, .{
        .trigger = "t",
        .trigger_type = .script,
        .event = ev,
        .request = req,
        .token = "tok",
        .received_at = "2026-06-15T00:00:00Z",
        .prompt_dir = dir,
    }, sender.sender());

    try testing.expectEqual(Outcome.launched, rec.outcome);
    const sent = sender.requests.items[0];
    try testing.expect(std.mem.indexOf(u8, sent, "MAXX_CONNECTOR_PROMPT_FILE=") != null);
    // The prompt content itself is in the file, not the request.
    try testing.expect(std.mem.indexOf(u8, sent, "Work on MAX-8") == null);
    // The temp file path is unique per launch; read it back from the request env
    // entry (we cannot predict the pid/nanos suffix) and confirm it holds the prompt.
    const prompt_path = try promptFilePathFromRequest(alloc, sent);
    const written = try std.fs.cwd().readFileAlloc(alloc, prompt_path, 4096);
    try testing.expectEqualStrings("Work on MAX-8", written);
    // The name carries the unique components and the runner prefix the sweep matches.
    const base = std.fs.path.basename(prompt_path);
    try testing.expect(std.mem.startsWith(u8, base, "maxx-prompt-evt-1-"));
    try testing.expect(std.mem.endsWith(u8, base, ".txt"));
}

/// Pull the `MAXX_CONNECTOR_PROMPT_FILE` path out of a serialized create request.
fn promptFilePathFromRequest(alloc: Allocator, request: []const u8) ![]const u8 {
    const parsed = try std.json.parseFromSliceLeaky(std.json.Value, alloc, request, .{});
    const env = parsed.object.get("params").?.object.get("env").?.array;
    const prefix = "MAXX_CONNECTOR_PROMPT_FILE=";
    for (env.items) |e| {
        if (std.mem.startsWith(u8, e.string, prefix)) return e.string[prefix.len..];
    }
    return error.NotFound;
}

test "dispatch rejects an unrecordable dedup key before launching" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var td = testing.tmpDir(.{});
    defer td.cleanup();
    const base = try td.dir.realpathAlloc(alloc, ".");
    const path = try std.fs.path.join(alloc, &.{ base, "seen.json" });
    var store = try DedupStore.open(testing.allocator, path);
    defer store.deinit();

    const ev = try linearEvent(alloc);
    const req = try connector.resolve(alloc, .{ .command = "claude" }, ev, .{});

    const huge = try alloc.alloc(u8, DedupStore.max_key_len + 1);
    @memset(huge, 'k');

    var sender = RecordingSender{ .alloc = alloc, .responses = &.{} };
    const rec = try dispatch(alloc, .{
        .trigger = "t",
        .trigger_type = .webhook_relay,
        .event = ev,
        .request = req,
        .token = "tok",
        .received_at = "2026-06-15T00:00:00Z",
        .dedup_key = huge,
        .dedup = &store,
    }, sender.sender());

    // Rejected up front: no create was sent, so the deterministic dedup failure
    // has no side effect (no duplicate-tab-on-retry).
    try testing.expectEqual(Outcome.failed, rec.outcome);
    try testing.expectEqualStrings("dedup_key_too_long", rec.error_code.?);
    try testing.expectEqual(@as(usize, 0), sender.requests.items.len);
    try testing.expectEqual(@as(usize, 0), store.count());
}

test "sweepStalePromptFiles removes only stale runner prompt files" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var td = testing.tmpDir(.{});
    defer td.cleanup();
    try td.dir.writeFile(.{ .sub_path = "maxx-prompt-old.txt", .data = "x" });
    try td.dir.writeFile(.{ .sub_path = "maxx-prompt-new.txt", .data = "y" });
    try td.dir.writeFile(.{ .sub_path = "unrelated.log", .data = "z" });

    const now_s = std.time.timestamp();
    // Backdate the "old" prompt file ~2 days.
    {
        const f = try td.dir.openFile("maxx-prompt-old.txt", .{ .mode = .read_write });
        defer f.close();
        const two_days_ago_ns: i128 = (@as(i128, now_s) - 2 * 24 * 3600) * std.time.ns_per_s;
        try f.updateTimes(two_days_ago_ns, two_days_ago_ns);
    }

    const dir_path = try td.dir.realpathAlloc(alloc, ".");
    // 1-day TTL: the old file is swept; the fresh prompt file and the unrelated
    // file are left untouched.
    sweepStalePromptFiles(dir_path, 24 * 3600, now_s);

    try testing.expectError(error.FileNotFound, td.dir.access("maxx-prompt-old.txt", .{}));
    try td.dir.access("maxx-prompt-new.txt", .{});
    try td.dir.access("unrelated.log", .{});
}

test "no-inference: only explicit fields and reserved provenance reach the request" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    // A Linear payload stuffed with bait the adapter does not copy.
    const payload =
        \\{
        \\  "action": "update", "type": "Issue",
        \\  "data": {
        \\    "id": "evt-1", "identifier": "MAX-8", "title": "Safe Title",
        \\    "url": "https://linear.app/x",
        \\    "branch": "feature/LEAK_BRANCH", "state": "LEAK_STATE"
        \\  }
        \\}
    ;
    const ev = try connector.adapterByName("linear").?.parse(alloc, payload);
    const req = try connector.resolve(alloc, .{ .command = "claude ${title}" }, ev, .{});

    var sender = RecordingSender{
        .alloc = alloc,
        .responses = &.{"{\"ok\":true,\"result\":{\"session\":{\"session_id\":\"S\"}}}"},
    };
    _ = try dispatch(alloc, .{
        .trigger = "linear-issues",
        .trigger_type = .webhook_relay,
        .event = ev,
        .request = req,
        .token = "tok",
        .received_at = "2026-06-15T00:00:00Z",
    }, sender.sender());

    const sent = sender.requests.items[0];
    for ([_][]const u8{ "LEAK_BRANCH", "LEAK_STATE", "branch", "state" }) |needle| {
        try testing.expect(std.mem.indexOf(u8, sent, needle) == null);
    }
}

test "epochToIso formats a known instant" {
    var buf: [32]u8 = undefined;
    // 1781526896 == 2026-06-15T12:34:56Z.
    const s = epochToIso(&buf, 1781526896);
    try testing.expectEqualStrings("2026-06-15T12:34:56Z", s);
}
