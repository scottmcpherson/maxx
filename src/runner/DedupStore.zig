//! Persistent duplicate-suppression state for the automation trigger runner.
//!
//! The runner fires a configured action at most once per *(trigger, source,
//! key)*, where `key` is an explicit, adapter-supplied event id or a configured
//! cursor — never anything Maxx infers. This store records the keys it has
//! already acted on so a re-delivered event (a webhook retry, a poll that still
//! reports the same id) does not launch the action twice.
//!
//! Duplicate suppression is only as good as the key the adapter provides. When a
//! source emits a stable event id or cursor, suppression is exact. When a source
//! has no stable identity (it rotates ids on every delivery), the runner cannot
//! tell a retry from a new event and will act once per key — this is documented
//! best-effort, not a guess. The store never derives a key from terminal output,
//! process names, paths, or timing.
//!
//! ## Durability contract
//!
//! The state file is a small JSON document written 0600. The store is defensive
//! by construction, mirroring the persistent session registry:
//!
//!   * **Bounded read** — a file larger than `max_file_bytes` is refused (treated
//!     as empty), so a corrupt/oversized file cannot exhaust memory.
//!   * **Bounded retention** — at most `max_entries` records are kept (oldest
//!     dropped first). The count bound is enforced on load and on every insert;
//!     a time bound is available via `pruneOlderThan`, which the runner applies
//!     with a default cutoff before each save. The store never reads the clock
//!     itself — the caller passes the cutoff — so retention stays deterministic
//!     and testable. Either way the file cannot grow without limit.
//!   * **Atomic writes** — saves write a sibling temp file and rename it over the
//!     target, so a crash mid-write never truncates the previous good file.
//!   * **Preserve newer schemas** — a file whose `version` is newer than this
//!     build is left untouched: the store loads no entries (suppression is
//!     disabled, fail-open) and refuses to save, so a newer Maxx's state is never
//!     clobbered by an older one.
//!   * **Corrupt-file recovery** — an unreadable/!JSON/!object file loads as
//!     empty and is overwritten on the next save (a clean recovery, since atomic
//!     writes mean corruption came from outside).

const DedupStore = @This();

const std = @import("std");
const Allocator = std.mem.Allocator;

const log = std.log.scoped(.runner_dedup);

/// Current on-disk schema version.
pub const version_current: u32 = 1;

/// Largest state file we will read *and* write. The write path is bounded by
/// this too: with the per-field caps and the count cap below, a maximally full
/// file stays well under it, and `save` refuses to write a file that would exceed
/// it (so we never persist a file the next run would reject as oversized).
pub const max_file_bytes: usize = 8 * 1024 * 1024;

/// Hard cap on retained records. Oldest are dropped first on overflow.
pub const default_max_entries: usize = 4000;

/// Per-field length caps applied at insert time. They keep each record small so
/// the count cap (`default_max_entries`) also bounds the *serialized* size:
/// 4000 × (512 + 256 + 128 + 20 + JSON overhead) stays comfortably under
/// `max_file_bytes`. An event id / `--dedup-key` longer than `max_key_len` is an
/// abuse/edge case the store refuses to record (visibly), rather than letting it
/// grow the file past the read cap and silently lose all suppression.
pub const max_key_len: usize = 512;
pub const max_trigger_len: usize = 256;
pub const max_source_len: usize = 128;

/// Default age (seconds) past which the runner prunes records before saving, so
/// the file is bounded by time as well as count. The runner computes a cutoff
/// timestamp from this and calls `pruneOlderThan`; the store itself never reads
/// the clock.
pub const default_max_age_s: i64 = 30 * 24 * 60 * 60;

/// A single recorded firing. All strings are owned by `arena`.
pub const Entry = struct {
    trigger: []const u8,
    source: []const u8,
    key: []const u8,
    /// ISO-8601 UTC timestamp the firing was recorded. Provenance + age pruning.
    at: []const u8,
};

arena: std.heap.ArenaAllocator,
path: []const u8,
entries: std.ArrayListUnmanaged(Entry) = .empty,
max_entries: usize = default_max_entries,
/// Read/write size cap (defaults to `max_file_bytes`; overridable for tests).
max_bytes: usize = max_file_bytes,
/// False when a newer-schema file is present: we neither trust its contents nor
/// overwrite it. Suppression is disabled (fail-open) until the file is gone.
writable: bool = true,
dirty: bool = false,

/// Open the store at `path`, reading and pruning any existing state. A missing
/// file is fine (empty store). A corrupt file loads empty. A newer-schema file
/// loads empty and marks the store read-only. `parent` owns the store's arena;
/// `path` is duped into it.
pub fn open(parent: Allocator, path: []const u8) Allocator.Error!DedupStore {
    var store: DedupStore = .{
        .arena = std.heap.ArenaAllocator.init(parent),
        .path = "",
    };
    const a = store.arena.allocator();
    store.path = try a.dupe(u8, path);
    store.load() catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        // A newer-schema file must be preserved: load() already set
        // `writable = false`, so leave it read-only (fail-open, no clobber).
        error.NewerSchema => store.entries.clearRetainingCapacity(),
        // Any other read/parse problem is non-fatal: start from an empty,
        // writable store and let the next save recover the file.
        else => {
            store.entries.clearRetainingCapacity();
            store.writable = true;
        },
    };
    return store;
}

pub fn deinit(self: *DedupStore) void {
    self.arena.deinit();
}

const LoadError = error{
    NewerSchema,
    TooLarge,
    Malformed,
} || Allocator.Error || std.fs.File.OpenError || std.fs.File.ReadError;

fn load(self: *DedupStore) LoadError!void {
    const a = self.arena.allocator();
    const file = std.fs.cwd().openFile(self.path, .{}) catch |err| switch (err) {
        error.FileNotFound => return, // empty store, writable
        else => return err,
    };
    defer file.close();

    const stat = try file.stat();
    if (stat.size > self.max_bytes) {
        log.warn("dedup state file {s} is {d} bytes (> {d}); ignoring", .{
            self.path, stat.size, self.max_bytes,
        });
        return error.TooLarge;
    }

    const bytes = try file.readToEndAlloc(a, self.max_bytes);
    const parsed = std.json.parseFromSliceLeaky(std.json.Value, a, bytes, .{}) catch
        return error.Malformed;
    if (parsed != .object) return error.Malformed;
    const root = parsed.object;

    const version: u32 = blk: {
        const v = root.get("version") orelse break :blk version_current;
        if (v != .integer or v.integer < 0) break :blk 0;
        break :blk std.math.cast(u32, v.integer) orelse std.math.maxInt(u32);
    };
    if (version > version_current) {
        log.warn(
            "dedup state file {s} has newer schema v{d} (this build is v{d}); " ++
                "disabling suppression and preserving the file",
            .{ self.path, version, version_current },
        );
        // Leave entries empty and refuse to overwrite.
        self.writable = false;
        return error.NewerSchema;
    }

    const arr = root.get("entries") orelse return;
    if (arr != .array) return error.Malformed;
    for (arr.array.items) |item| {
        if (item != .object) continue;
        const o = item.object;
        const trigger = strField(o, "trigger") orelse continue;
        const source = strField(o, "source") orelse continue;
        const key = strField(o, "key") orelse continue;
        const at = strField(o, "at") orelse "";
        try self.entries.append(a, .{
            .trigger = try a.dupe(u8, trigger),
            .source = try a.dupe(u8, source),
            .key = try a.dupe(u8, key),
            .at = try a.dupe(u8, at),
        });
    }

    // Enforce the count bound immediately so a hand-edited oversized file is
    // trimmed on the first load rather than only after the next firing.
    self.enforceCountBound();
}

fn strField(o: std.json.ObjectMap, name: []const u8) ?[]const u8 {
    const v = o.get(name) orelse return null;
    if (v != .string) return null;
    if (v.string.len == 0) return null;
    return v.string;
}

/// True if `(trigger, source, key)` has already been recorded.
pub fn seen(self: *const DedupStore, trigger: []const u8, source: []const u8, key: []const u8) bool {
    for (self.entries.items) |e| {
        if (std.mem.eql(u8, e.trigger, trigger) and
            std.mem.eql(u8, e.source, source) and
            std.mem.eql(u8, e.key, key)) return true;
    }
    return false;
}

pub const MarkError = error{
    /// A field exceeded its per-field length cap. Refused rather than recorded so
    /// a pathological event id / dedup key cannot grow the file past the read cap
    /// and silently disable all suppression.
    FieldTooLong,
} || Allocator.Error;

/// Record `(trigger, source, key)` as fired at `at`. No-op if already present
/// (idempotent — a retry never refreshes recency or grows the file). Rejects
/// over-long fields, enforces the count bound, and marks the store dirty so
/// `save` persists it.
pub fn markSeen(
    self: *DedupStore,
    trigger: []const u8,
    source: []const u8,
    key: []const u8,
    at: []const u8,
) MarkError!void {
    if (trigger.len > max_trigger_len or source.len > max_source_len or key.len > max_key_len) {
        log.warn(
            "refusing dedup record with over-long field (trigger {d}/{d}, source {d}/{d}, key {d}/{d})",
            .{ trigger.len, max_trigger_len, source.len, max_source_len, key.len, max_key_len },
        );
        return error.FieldTooLong;
    }
    if (self.seen(trigger, source, key)) return;
    const a = self.arena.allocator();
    try self.entries.append(a, .{
        .trigger = try a.dupe(u8, trigger),
        .source = try a.dupe(u8, source),
        .key = try a.dupe(u8, key),
        .at = try a.dupe(u8, at),
    });
    self.enforceCountBound();
    self.dirty = true;
}

/// Drop records whose `at` timestamp is lexicographically less than `cutoff_iso`
/// (a fixed-width ISO-8601 UTC string compares correctly as bytes). Records with
/// an empty `at` are kept (we cannot age them out). Marks dirty if anything was
/// removed.
pub fn pruneOlderThan(self: *DedupStore, cutoff_iso: []const u8) void {
    var write_i: usize = 0;
    for (self.entries.items) |e| {
        const keep = e.at.len == 0 or std.mem.order(u8, e.at, cutoff_iso) != .lt;
        if (keep) {
            self.entries.items[write_i] = e;
            write_i += 1;
        }
    }
    if (write_i != self.entries.items.len) {
        self.entries.shrinkRetainingCapacity(write_i);
        self.dirty = true;
    }
}

/// Keep only the most recent `max_entries` records (drop from the front, which
/// is the oldest by insertion order).
fn enforceCountBound(self: *DedupStore) void {
    if (self.entries.items.len <= self.max_entries) return;
    const drop = self.entries.items.len - self.max_entries;
    std.mem.copyForwards(
        Entry,
        self.entries.items[0..self.max_entries],
        self.entries.items[drop..],
    );
    self.entries.shrinkRetainingCapacity(self.max_entries);
    self.dirty = true;
}

pub fn count(self: *const DedupStore) usize {
    return self.entries.items.len;
}

/// Serialize the current entries to JSON. Caller owns the returned slice.
pub fn serialize(self: *const DedupStore, alloc: Allocator) Allocator.Error![]u8 {
    var out: std.io.Writer.Allocating = .init(alloc);
    errdefer out.deinit();
    var json: std.json.Stringify = .{ .writer = &out.writer, .options = .{ .whitespace = .indent_2 } };
    json.beginObject() catch return error.OutOfMemory;
    json.objectField("version") catch return error.OutOfMemory;
    json.write(version_current) catch return error.OutOfMemory;
    json.objectField("entries") catch return error.OutOfMemory;
    json.beginArray() catch return error.OutOfMemory;
    for (self.entries.items) |e| {
        json.beginObject() catch return error.OutOfMemory;
        json.objectField("trigger") catch return error.OutOfMemory;
        json.write(e.trigger) catch return error.OutOfMemory;
        json.objectField("source") catch return error.OutOfMemory;
        json.write(e.source) catch return error.OutOfMemory;
        json.objectField("key") catch return error.OutOfMemory;
        json.write(e.key) catch return error.OutOfMemory;
        json.objectField("at") catch return error.OutOfMemory;
        json.write(e.at) catch return error.OutOfMemory;
        json.endObject() catch return error.OutOfMemory;
    }
    json.endArray() catch return error.OutOfMemory;
    json.endObject() catch return error.OutOfMemory;
    return out.toOwnedSlice();
}

pub const SaveError = error{
    /// A newer-schema file is present; saving would clobber it.
    ReadOnly,
    /// The serialized state would exceed `max_bytes` — i.e. the next run would
    /// reject it as oversized. Refused so we never persist an unreadable file;
    /// the previous good file is left intact. With the per-field and count caps
    /// this is a backstop that should not trigger in normal operation.
    TooLarge,
} || Allocator.Error || std.fs.File.OpenError || std.fs.File.WriteError || std.posix.RenameError;

/// Atomically persist the store. Writes `<path>.tmp.<pid>` 0600 then renames it
/// over `path`, so a failure leaves the previous good file intact. A no-op when
/// the store is not dirty. Refuses to write when a newer-schema file is present
/// or when the serialized state would exceed the read cap.
pub fn save(self: *DedupStore) SaveError!void {
    if (!self.writable) return error.ReadOnly;
    if (!self.dirty) return;

    const a = self.arena.allocator();
    const bytes = try self.serialize(a);

    // Never persist a file the next run would reject as oversized. The per-field
    // caps and count cap keep us well under this in practice; this is the hard
    // backstop, checked before we touch the filesystem so the prior file stands.
    if (bytes.len > self.max_bytes) {
        log.warn("refusing to write {d}-byte dedup state to {s} (> {d})", .{
            bytes.len, self.path, self.max_bytes,
        });
        return error.TooLarge;
    }

    // Use a per-process temp name so two runners writing the same state file do
    // not corrupt each other's temp before the rename. The final rename is still
    // last-writer-wins (a given state file is meant to be driven by one runner at
    // a time — see docs/automation-runner.md), but neither writes a half file.
    const tmp_path = try std.fmt.allocPrint(a, "{s}.tmp.{d}", .{ self.path, std.c.getpid() });

    // Create the temp file 0600 (owner read/write only): dedup keys are
    // low-sensitivity, but the file lives next to the control token, so we keep
    // the same restrictive mode as the rest of the control directory.
    const tmp = try std.fs.cwd().createFile(tmp_path, .{ .truncate = true, .mode = 0o600 });
    {
        errdefer {
            tmp.close();
            std.fs.cwd().deleteFile(tmp_path) catch {};
        }
        try tmp.writeAll(bytes);
    }
    tmp.close();

    std.fs.cwd().rename(tmp_path, self.path) catch |err| {
        std.fs.cwd().deleteFile(tmp_path) catch {};
        return err;
    };
    self.dirty = false;
}

// ----- tests -----

const testing = std.testing;

fn tmpDirPath(arena: Allocator, td: *std.testing.TmpDir, name: []const u8) ![]const u8 {
    const base = try td.dir.realpathAlloc(arena, ".");
    return std.fs.path.join(arena, &.{ base, name });
}

test "markSeen/seen are idempotent and persist across reopen" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var td = testing.tmpDir(.{});
    defer td.cleanup();
    const path = try tmpDirPath(arena, &td, "seen.json");

    {
        var store = try DedupStore.open(testing.allocator, path);
        defer store.deinit();
        try testing.expect(!store.seen("t", "linear", "MAX-1"));
        try store.markSeen("t", "linear", "MAX-1", "2026-06-15T00:00:00Z");
        // Idempotent: a second mark does not duplicate.
        try store.markSeen("t", "linear", "MAX-1", "2026-06-15T01:00:00Z");
        try testing.expectEqual(@as(usize, 1), store.count());
        try testing.expect(store.seen("t", "linear", "MAX-1"));
        try store.save();
    }

    // Reopen: the recorded key survives.
    {
        var store = try DedupStore.open(testing.allocator, path);
        defer store.deinit();
        try testing.expectEqual(@as(usize, 1), store.count());
        try testing.expect(store.seen("t", "linear", "MAX-1"));
        // A different trigger/source/key namespace is independent.
        try testing.expect(!store.seen("other", "linear", "MAX-1"));
        try testing.expect(!store.seen("t", "github", "MAX-1"));
    }
}

test "count bound drops oldest records" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var td = testing.tmpDir(.{});
    defer td.cleanup();
    const path = try tmpDirPath(arena, &td, "bound.json");

    var store = try DedupStore.open(testing.allocator, path);
    defer store.deinit();
    store.max_entries = 3;
    for (0..5) |i| {
        const key = try std.fmt.allocPrint(arena, "k{d}", .{i});
        try store.markSeen("t", "s", key, "2026-06-15T00:00:00Z");
    }
    try testing.expectEqual(@as(usize, 3), store.count());
    // Oldest (k0, k1) dropped; newest kept.
    try testing.expect(!store.seen("t", "s", "k0"));
    try testing.expect(!store.seen("t", "s", "k1"));
    try testing.expect(store.seen("t", "s", "k4"));
}

test "pruneOlderThan removes stale records by timestamp" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var td = testing.tmpDir(.{});
    defer td.cleanup();
    const path = try tmpDirPath(arena, &td, "prune.json");

    var store = try DedupStore.open(testing.allocator, path);
    defer store.deinit();
    try store.markSeen("t", "s", "old", "2026-01-01T00:00:00Z");
    try store.markSeen("t", "s", "new", "2026-06-15T00:00:00Z");
    store.pruneOlderThan("2026-03-01T00:00:00Z");
    try testing.expect(!store.seen("t", "s", "old"));
    try testing.expect(store.seen("t", "s", "new"));
}

test "corrupt file loads empty and is recoverable" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var td = testing.tmpDir(.{});
    defer td.cleanup();
    try td.dir.writeFile(.{ .sub_path = "corrupt.json", .data = "not valid json{{{" });
    const path = try tmpDirPath(arena, &td, "corrupt.json");

    var store = try DedupStore.open(testing.allocator, path);
    defer store.deinit();
    try testing.expectEqual(@as(usize, 0), store.count());
    try testing.expect(store.writable);
    // Recovers: we can record and save over the corrupt file.
    try store.markSeen("t", "s", "k", "2026-06-15T00:00:00Z");
    try store.save();

    var reopened = try DedupStore.open(testing.allocator, path);
    defer reopened.deinit();
    try testing.expect(reopened.seen("t", "s", "k"));
}

test "newer schema is preserved and not overwritten" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var td = testing.tmpDir(.{});
    defer td.cleanup();
    const newer =
        \\{"version":9999,"entries":[{"trigger":"t","source":"s","key":"future","at":"2030-01-01T00:00:00Z"}]}
    ;
    try td.dir.writeFile(.{ .sub_path = "newer.json", .data = newer });
    const path = try tmpDirPath(arena, &td, "newer.json");

    var store = try DedupStore.open(testing.allocator, path);
    defer store.deinit();
    // Fail-open: no entries loaded, suppression disabled, file marked read-only.
    try testing.expectEqual(@as(usize, 0), store.count());
    try testing.expect(!store.writable);
    try testing.expect(!store.seen("t", "s", "future"));

    // save refuses to clobber the newer file.
    try store.markSeen("t", "s", "k", "2026-06-15T00:00:00Z");
    try testing.expectError(error.ReadOnly, store.save());

    // The original newer file is intact on disk.
    const on_disk = try td.dir.readFileAlloc(arena, "newer.json", max_file_bytes);
    try testing.expect(std.mem.indexOf(u8, on_disk, "9999") != null);
    try testing.expect(std.mem.indexOf(u8, on_disk, "future") != null);
}

test "oversized file is refused and loads empty" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var td = testing.tmpDir(.{});
    defer td.cleanup();

    // Write a file just over the bound.
    const big = try arena.alloc(u8, max_file_bytes + 16);
    @memset(big, 'x');
    try td.dir.writeFile(.{ .sub_path = "big.json", .data = big });
    const path = try tmpDirPath(arena, &td, "big.json");

    var store = try DedupStore.open(testing.allocator, path);
    defer store.deinit();
    try testing.expectEqual(@as(usize, 0), store.count());
    try testing.expect(store.writable);
}

test "markSeen refuses an over-long key instead of growing unbounded" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var td = testing.tmpDir(.{});
    defer td.cleanup();
    const path = try tmpDirPath(arena, &td, "long.json");

    var store = try DedupStore.open(testing.allocator, path);
    defer store.deinit();

    const huge = try arena.alloc(u8, max_key_len + 1);
    @memset(huge, 'k');
    try testing.expectError(error.FieldTooLong, store.markSeen("t", "s", huge, "2026-06-15T00:00:00Z"));
    // Nothing recorded, store stays clean (no dirty write of a bloated record).
    try testing.expectEqual(@as(usize, 0), store.count());
    try testing.expect(!store.dirty);
    // A normal-length key still records fine.
    try store.markSeen("t", "s", "ok-key", "2026-06-15T00:00:00Z");
    try testing.expect(store.seen("t", "s", "ok-key"));
}

test "save refuses to write a file larger than the read cap" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var td = testing.tmpDir(.{});
    defer td.cleanup();
    const path = try tmpDirPath(arena, &td, "cap.json");

    var store = try DedupStore.open(testing.allocator, path);
    defer store.deinit();
    // Tighten the cap so a couple of records exceed it (the production default is
    // far larger than any record the per-field caps allow).
    store.max_bytes = 64;
    try store.markSeen("trigger", "source", "key-one", "2026-06-15T00:00:00Z");
    try store.markSeen("trigger", "source", "key-two", "2026-06-15T00:00:01Z");
    // The serialized state exceeds 64 bytes, so save refuses and leaves no file.
    try testing.expectError(error.TooLarge, store.save());
    try testing.expectError(error.FileNotFound, td.dir.access("cap.json", .{}));
}
