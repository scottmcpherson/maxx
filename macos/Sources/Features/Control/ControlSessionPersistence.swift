import Darwin
import Foundation
import os

// Durable storage for the session registry (MAX-5).
//
// The control session registry is otherwise purely in-memory; this layer lets it
// survive an app restart so Maxx keeps a durable, mechanical view of sessions and
// the facts agents declared on them. It persists ONLY explicit, Maxx-owned and
// agent-declared facts — identity, relationships, declared state/summary/agent
// type, metadata, mechanical lifecycle flags, and timestamps. It never derives or
// reconstructs workflow truth: loading a record replays exactly what was stored
// and nothing more (see docs/no-inference.md).

/// Versioned on-disk envelope for the persistent session registry.
///
/// The `version` makes the schema migration-friendly: a future incompatible
/// change bumps it, and a reader can recognize and refuse a file it does not
/// understand rather than misinterpret it. Forward/backward compatibility within
/// a version is handled by ``ControlSession``'s lenient `Codable` (missing fields
/// decode to their defaults).
struct ControlRegistrySnapshot: Codable {
    /// The schema version this build writes. Bump only on an incompatible change.
    static let currentVersion = 1

    var version: Int
    var sessions: [ControlSession]

    init(version: Int, sessions: [ControlSession]) {
        self.version = version
        self.sessions = sessions
    }

    private enum CodingKeys: String, CodingKey {
        case version, sessions
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = try container.decode(Int.self, forKey: .version)
        // Decode records leniently so a single forward-incompatible or corrupt
        // record (e.g. one carrying an enum value a newer build added without a
        // version bump) is skipped rather than failing the whole decode — one
        // bad entry must not wipe the entire persisted registry.
        let wrapped = try container.decodeIfPresent(
            [FailableDecodable<ControlSession>].self, forKey: .sessions) ?? []
        sessions = wrapped.compactMap(\.value)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(version, forKey: .version)
        try container.encode(sessions, forKey: .sessions)
    }
}

/// Decodes `T` if possible, otherwise yields `nil` instead of throwing — so a
/// lenient array decode can skip an element it cannot read without aborting the
/// whole array.
private struct FailableDecodable<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws {
        value = try? T(from: decoder)
    }
}

/// Deterministic retention for persisted records, so the on-disk registry cannot
/// grow without bound and stale records are retired predictably.
///
/// A record's recency is `max(updatedAt, lastSeenAt)`. The **age** cutoff retires
/// only records observed *terminal* (closed or archived) — a record that may
/// still be live (its last-observed lifecycle is `running`/`exited`, or unknown)
/// is never aged out, because its `lastSeenAt` can lag arbitrarily during a long
/// idle stretch with no `reconcile`, and dropping it would lose a still-existing
/// tab's record across a restart. The **count** cap (`maxRecords`) is a hard
/// backstop applied to everything, newest-first. Applied identically on save and
/// on load, so the policy is the single source of truth.
struct ControlRetentionPolicy {
    var maxRecords: Int
    var maxAge: TimeInterval

    /// 14 days / 500 records: generous enough that a normal week of work is never
    /// lost across restarts, bounded enough that the file stays small.
    static let `default` = ControlRetentionPolicy(
        maxRecords: 500, maxAge: 60 * 60 * 24 * 14)

    private func recency(_ session: ControlSession) -> Date {
        max(session.updatedAt, session.lastSeenAt ?? session.updatedAt)
    }

    /// Whether a record is observed terminal and therefore eligible for the age
    /// cutoff. Explicit cancel/archive flags, or a last-observed lifecycle of
    /// `closed`/`archived` (the surface is gone or the record is archived). A
    /// `running`/`exited`/unknown record is treated as potentially live and kept
    /// regardless of age. This is a mechanical liveness fact, not inference.
    private func isTerminal(_ session: ControlSession) -> Bool {
        if session.canceled || session.archived { return true }
        switch session.lastObservedLifecycle {
        case ControlLifecycle.closed.rawValue, ControlLifecycle.archived.rawValue:
            return true
        default:
            return false
        }
    }

    /// Apply the policy, returning the retained records sorted newest-first.
    func apply(to sessions: [ControlSession], now: Date) -> [ControlSession] {
        let cutoff = now.addingTimeInterval(-maxAge)
        return sessions
            // Age out only terminal records; keep potentially-live ones regardless
            // of how stale their timestamps look.
            .filter { !isTerminal($0) || recency($0) >= cutoff }
            .sorted { recency($0) > recency($1) }
            .prefix(maxRecords)
            .map { $0 }
    }
}

/// Reads and writes the persistent session registry to a single JSON file.
///
/// Persistence must never break the control plane, so every operation fails
/// soft: a load problem (missing file, unreadable, corrupt, or a newer schema
/// version) yields an empty registry — Maxx simply starts fresh — and a save
/// problem is logged and swallowed. Writes are atomic (temp file + rename) and
/// the file is created `0600` inside the `0700` control directory.
struct ControlSessionStore {
    let fileURL: URL
    var retention: ControlRetentionPolicy = .default

    private static let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "com.scottmcpherson.maxx",
        category: "ControlSessionStore")

    private static func makeEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        // Stable, human-readable output: deterministic key order avoids spurious
        // diffs, and ISO-8601 dates match the wire view (`view(of:)`).
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }

    private static func makeDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }

    /// Load the persisted sessions with retention applied, or `[]` on any
    /// problem. Pure w.r.t. the registry: it returns records for the caller to
    /// rehydrate and never touches live surfaces.
    func load(now: Date) -> [ControlSession] {
        guard let data = try? Data(contentsOf: fileURL) else {
            return []  // No file yet (first run) — start empty.
        }
        let snapshot: ControlRegistrySnapshot
        do {
            snapshot = try Self.makeDecoder().decode(ControlRegistrySnapshot.self, from: data)
        } catch {
            Self.logger.error(
                "ignoring unreadable session registry at \(fileURL.path, privacy: .public): \(String(describing: error), privacy: .public)")
            return []
        }
        guard snapshot.version <= ControlRegistrySnapshot.currentVersion else {
            // A file from a newer build whose schema we do not understand: refuse
            // it rather than risk misreading it. Don't delete it — a downgrade is
            // usually temporary and the newer build will read it again.
            Self.logger.error(
                "ignoring session registry with unsupported version \(snapshot.version) (this build understands up to \(ControlRegistrySnapshot.currentVersion))")
            return []
        }
        return retention.apply(to: snapshot.sessions, now: now)
    }

    /// Atomically write the given sessions (retention applied). Logs and returns
    /// on any error — a persistence failure never propagates to a control call.
    func save(_ sessions: [ControlSession], now: Date) {
        let snapshot = ControlRegistrySnapshot(
            version: ControlRegistrySnapshot.currentVersion,
            sessions: retention.apply(to: sessions, now: now))
        do {
            try ensureDirectory()
            let data = try Self.makeEncoder().encode(snapshot)
            try data.write(to: fileURL, options: [.atomic])
            // Tighten perms: the atomic write inherits the umask, so re-assert
            // owner-only access for a file that can hold agent-declared metadata.
            try? FileManager.default.setAttributes(
                [.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
        } catch {
            Self.logger.error(
                "failed to persist session registry to \(fileURL.path, privacy: .public): \(String(describing: error), privacy: .public)")
        }
    }

    /// Create the containing directory `0700` if it does not already exist. The
    /// control server also does this on launch; doing it here keeps the store
    /// self-contained (e.g. for tests that write before any server starts).
    private func ensureDirectory() throws {
        let dir = fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: dir,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
    }
}
