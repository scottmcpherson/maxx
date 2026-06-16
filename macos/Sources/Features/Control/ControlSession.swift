import Darwin
import Foundation

/// A control session.
///
/// This is a control-plane object distinct from the terminal surface it manages:
/// either a tab Maxx created through `sessions.create`, or the caller's current
/// tab after explicit `sessions.register-current`. Its `id` is stable for the
/// lifetime of the session and is intentionally unrelated to the surface UUID,
/// the UI title, the process ID, the working directory, the git branch, or the
/// command text — callers manage sessions solely through this id.
struct ControlSession {
    /// Stable control-session identifier.
    let id: UUID
    /// The surface (tab) this session manages. Mutable so `restart` can rebind a
    /// session to the fresh surface it spawns while keeping `id` stable.
    var surfaceID: UUID
    let title: String?
    let command: String?
    let cwd: String?
    /// Environment overrides captured at create time, replayed on `restart`.
    let env: [String: String]
    /// Where the surface was created; replayed on `restart`.
    let location: ControlLocation
    /// Caller-owned status string. Doubles as the current agent-declared state:
    /// `declare-state` writes it (and records an audit entry); `update` writes it
    /// without one. `wait --state` matches against it.
    var status: String
    /// Agent-reported structured metadata (MAX-4): a namespaced key → arbitrary
    /// JSON value map an agent or orchestrator explicitly attaches to the session
    /// (e.g. `linear.issue`, `pr.url`, `repo`, `branch`, `run.id`,
    /// `cleanup.command`). Maxx stores and surfaces it verbatim — it never
    /// originates, normalizes, or interprets these values, and never derives them
    /// from terminal output, process names, branch names, paths, or idle time.
    var metadata: [String: ControlJSONValue]
    /// Optional group label for supervisor coordination (MAX-7). A session may
    /// belong to at most one group at a time; membership is set explicitly at
    /// create time or via `set-group` and is never inferred. Group membership
    /// changes emit Maxx-owned mechanical events on the structured stream.
    var group: String?
    /// Optional parent session id (MAX-5). A mechanical association edge the
    /// registry persists: it links this session to a parent session it was
    /// explicitly created under. Set only at create time from a caller-supplied
    /// id (validated to reference a known session) — never inferred from process
    /// names, paths, or any ambient signal. Richer parent-child UX/semantics are
    /// MAX-6; MAX-5 only stores and round-trips the edge.
    var parentID: UUID?
    /// Agent-declared agent type (MAX-5), e.g. `claude-code` or `codex`. An
    /// explicit self-declaration from the agent/integration, set at create time
    /// or via `set-agent-type`. Like every declared field it is stored verbatim
    /// and never inferred from the command, process name, branch, path, or title.
    var agentType: String?
    let createdAt: Date
    /// When any field on this record last changed (an API mutation or an
    /// observed mechanical lifecycle transition). Maxx-owned bookkeeping, bumped
    /// by the registry; used for retention of stale records across restarts.
    var updatedAt: Date
    /// The last time Maxx mechanically observed this session's surface still
    /// existing (set during reconciliation while the surface is present). A
    /// kernel/runtime fact, never output inference; nil until first observed.
    /// Used together with ``updatedAt`` for deterministic stale-record retention.
    var lastSeenAt: Date?
    /// True once the session was explicitly canceled/closed through the API.
    ///
    /// This is an explicit, Maxx-owned lifecycle fact recorded in response to an
    /// API call — never inferred from terminal output or ambient signals.
    var canceled: Bool
    /// True once the session was explicitly archived. The record is retained for
    /// inspection but its surface is closed and no longer active.
    var archived: Bool = false
    var archivedAt: Date?
    var archiveReason: String?
    /// Number of times the session's command has been restarted.
    var restartCount: Int = 0
    /// The Maxx-owned lifecycle value most recently *recorded* as a mechanical
    /// stream event, so the registry can emit a `process.exited`/`closed` event
    /// exactly once when it next observes the kernel-reported transition. nil
    /// until first observed (treated as `running`). This is reconciliation of an
    /// explicit kernel fact, never output inference.
    var lastObservedLifecycle: String?
    /// Append-only audit log of agent-declared facts and Maxx-owned lifecycle
    /// actions. Drives `wait`, `watch`, and `events`.
    var events: [ControlEvent] = []
    /// Next sequence number to assign to an appended event. Managed via
    /// ``appendEvent``; not `private` only so the synthesized memberwise
    /// initializer stays accessible within the module.
    var nextSeq: Int = 0

    // MARK: Agent-declared workflow state (MAX-3)
    //
    // Explicit, human-facing workflow state + summary an agent declares through
    // `set-state` / `set-summary`. These are deliberately separate from the
    // free-form `status` (`declare-state`, machine coordination for `wait`) and
    // from the Maxx-owned `lifecycle` (process liveness): this vocabulary is
    // small, validated, and surfaced to the user as a badge. Every field here is
    // set ONLY in response to an explicit declaration — never inferred from
    // terminal output, process names, paths, idle time, or process exit.

    /// Latest declared workflow state, or nil until an agent declares one.
    var workflowState: WorkflowState?
    /// When `workflowState` was last declared.
    var workflowStateAt: Date?
    /// Who declared `workflowState` (defaults to `agent`).
    var workflowStateSource: String?
    /// Latest declared summary line, set independently of `workflowState` so an
    /// agent can update the displayed text without changing status.
    var summary: String?
    /// When `summary` was last declared.
    var summaryAt: Date?
    /// Who declared `summary` (defaults to `agent`).
    var summarySource: String?

    /// True when this record was rehydrated from disk on app launch rather than
    /// created live this run (MAX-5). A mechanical fact about *this* run — Maxx
    /// knows it loaded the record from its own store — not anything inferred
    /// about the work. Runtime-only: it is never persisted (every record on disk
    /// is, by definition, restorable), and a `restart` that spawns a fresh
    /// surface clears it. Surfaces from a previous run no longer exist, so a
    /// restored record's lifecycle computes as `closed` until it is restarted.
    var restoredFromPreviousRun: Bool = false

    /// Sequence of the most recently recorded event, or nil if none.
    var lastSeq: Int? { events.last?.seq }

    /// A snapshot of the current declared state + summary for the UI, or nil if
    /// nothing has been declared. The `source`/`updatedAt` describe the state
    /// badge when a state has been declared (so a later summary update from a
    /// different source never misattributes the state), and otherwise the
    /// summary.
    var declaredStateForDisplay: ControlDeclaredState? {
        guard workflowState != nil || summary != nil else { return nil }
        let useState = workflowState != nil
        return ControlDeclaredState(
            state: workflowState,
            summary: summary,
            source: (useState ? workflowStateSource : summarySource)
                ?? ControlSession.defaultSource,
            updatedAt: (useState ? workflowStateAt : summaryAt) ?? createdAt)
    }

    /// Append an audit-log entry, assigning it the next per-session sequence.
    mutating func appendEvent(
        kind: ControlEventKind,
        name: String,
        source: String,
        message: String? = nil,
        payload: ControlJSONValue? = nil,
        createdAt: Date,
        pid: Int?
    ) {
        events.append(ControlEvent(
            seq: nextSeq,
            kind: kind,
            name: name,
            source: source,
            message: message,
            payload: payload,
            createdAt: createdAt,
            surfaceID: surfaceID,
            pid: pid))
        nextSeq += 1
    }

    /// Documented limits for caller-supplied data. Enforced on create/update.
    enum Limits {
        static let maxTitle = 256
        static let maxStatus = 128
        static let maxCommand = 4096
        static let maxMetadataKeys = 32
        static let maxMetadataKeyLength = 64
        /// Per-value cap on the serialized (compact JSON) size of a single
        /// metadata value, so one key cannot carry an unbounded structure.
        static let maxMetadataValueBytes = 2048
        /// Cap on the total serialized size of a session's whole metadata map.
        static let maxMetadataBytes = 16384
        static let maxEnvEntries = 256
        static let maxStateLength = 128
        static let maxEventNameLength = 128
        static let maxSourceLength = 128
        static let maxReasonLength = 1024
        static let maxPayloadBytes = 8192
        static let maxSummaryLength = 1024
        static let maxGroupLength = 128
        static let maxAgentTypeLength = 128
    }

    /// The default `source` recorded for agent declarations when the caller does
    /// not supply one.
    static let defaultSource = "agent"
    /// The `source` recorded for Maxx-owned lifecycle entries.
    static let maxxSource = "maxx"
}

/// Maxx-owned lifecycle state.
///
/// Derived ONLY from explicit session state: whether the surface still exists,
/// and whether its child process has exited (a kernel-reported fact via
/// `ghostty_surface_process_exited`). It is never inferred from terminal
/// output, process names, branch names, filesystem paths, or idle time.
enum ControlLifecycle: String {
    /// Surface exists and its child process is alive.
    case running
    /// Surface exists but its child process has exited.
    case exited
    /// The session was canceled via the API, or its surface no longer exists.
    case closed
    /// The session was explicitly archived; its record is retained but inactive.
    case archived

    /// A terminal lifecycle is one a session cannot leave except via `restart`.
    var isTerminal: Bool {
        switch self {
        case .running, .exited: return false
        case .closed, .archived: return true
        }
    }
}

/// An agent-declared workflow state (MAX-3).
///
/// A small, fixed vocabulary an agent or workflow tool declares explicitly via
/// `set-state` so Maxx can display it. Maxx records exactly what is declared and
/// never originates or infers a value here — not from terminal output, process
/// names, branch names, paths, idle time, or process exit. The enum is kept
/// intentionally small; new states are an additive change.
enum WorkflowState: String, CaseIterable, Codable {
    case running
    case needsInput
    case blocked
    case complete
    case failed

    /// Human-facing label rendered on the UI badge.
    var label: String {
        switch self {
        case .running: return "Running"
        case .needsInput: return "Needs input"
        case .blocked: return "Blocked"
        case .complete: return "Complete"
        case .failed: return "Failed"
        }
    }
}

/// A snapshot of a session's agent-declared workflow state + summary, pushed to
/// the live surface so the UI can render a badge.
///
/// Purely a value carrier across the control-plane → UI boundary: every field is
/// set only by an explicit `set-state` / `set-summary` declaration. Maxx never
/// derives any of it from terminal output or ambient signals.
struct ControlDeclaredState: Equatable {
    /// Declared workflow state, or nil when only a summary has been declared. The
    /// UI derives its label / icon / color from this typed value, so a new state
    /// can never silently render with a fallback style.
    var state: WorkflowState?
    /// Latest declared summary line, or nil if none.
    var summary: String?
    /// Source recorded for the declaration this snapshot describes.
    var source: String
    /// When that declaration was made.
    var updatedAt: Date
}

/// A snapshot of a session's explicit parent/group relationship (MAX-6), pushed
/// to the live surface so the tab UI can show grouping at a glance.
///
/// A pure value carrier across the control-plane → UI boundary, mirroring
/// ``ControlDeclaredState``: both fields are set only by an explicit
/// `create` / `set-group` / `set-parent` call. Maxx never derives the group or
/// the parent edge from terminal output, process names, branch names, paths, or
/// idle time — an ungrouped tab with no parent simply has nothing to show.
struct ControlRelationship: Equatable {
    /// Explicit group label, or nil when the session belongs to no group.
    var group: String?
    /// True when the session has an explicit parent edge (`parentID != nil`). A
    /// mechanical fact about a caller-supplied association — not about the work.
    var isChild: Bool

    /// Ungrouped and not a child: there is nothing to surface, so the UI shows
    /// no relationship badge and behaves exactly as it does for any plain tab.
    var isEmpty: Bool { group == nil && !isChild }
}

/// Validation for caller-supplied inputs. Pure and side-effect free so it can be
/// unit tested without a running app. Each failure maps to `invalid_request`.
enum ControlValidation {
    static func validateTitle(_ title: String?) throws -> String? {
        guard let title else { return nil }
        guard title.count <= ControlSession.Limits.maxTitle else {
            throw ControlError(
                .invalidRequest,
                "title exceeds \(ControlSession.Limits.maxTitle) characters")
        }
        return title
    }

    static func validateStatus(_ status: String?) throws -> String? {
        guard let status else { return nil }
        guard !status.isEmpty else {
            throw ControlError(.invalidRequest, "status must not be empty")
        }
        guard status.count <= ControlSession.Limits.maxStatus else {
            throw ControlError(
                .invalidRequest,
                "status exceeds \(ControlSession.Limits.maxStatus) characters")
        }
        return status
    }

    /// Validate an agent-declared workflow state against the fixed vocabulary.
    /// An unknown value is rejected with a clear error (and the caller's current
    /// declared state is left untouched), so a typo never silently becomes a
    /// state Maxx would display.
    static func validateWorkflowState(_ state: String?) throws -> WorkflowState {
        guard let state, !state.isEmpty else {
            throw ControlError(.invalidRequest, "state must not be empty")
        }
        guard let parsed = WorkflowState(rawValue: state) else {
            let valid = WorkflowState.allCases.map(\.rawValue).joined(separator: ", ")
            throw ControlError(
                .invalidRequest,
                "unknown state '\(state)' (valid: \(valid))")
        }
        return parsed
    }

    /// Validate an agent-declared summary line.
    static func validateSummary(_ summary: String?) throws -> String {
        guard let summary, !summary.isEmpty else {
            throw ControlError(.invalidRequest, "summary must not be empty")
        }
        guard summary.count <= ControlSession.Limits.maxSummaryLength else {
            throw ControlError(
                .invalidRequest,
                "summary exceeds \(ControlSession.Limits.maxSummaryLength) characters")
        }
        return summary
    }

    static func validateCommand(_ command: String?) throws -> String? {
        guard let command else { return nil }
        guard command.count <= ControlSession.Limits.maxCommand else {
            throw ControlError(
                .invalidRequest,
                "command exceeds \(ControlSession.Limits.maxCommand) characters")
        }
        return command
    }

    static func validateCwd(_ cwd: String?) throws -> String? {
        guard let cwd else { return nil }
        guard !cwd.isEmpty else {
            throw ControlError(.invalidRequest, "cwd must not be empty")
        }
        guard cwd.hasPrefix("/") else {
            throw ControlError(.invalidRequest, "cwd must be an absolute path")
        }
        return cwd
    }

    /// Validate a structured metadata map and return it **unchanged**.
    ///
    /// The map is agent-reported (MAX-4): keys are namespaced identifiers and
    /// values are arbitrary JSON. Validation only bounds size and key shape so a
    /// caller cannot push an unbounded payload — it never normalizes, reorders,
    /// or reinterprets values, so unknown keys and structured values round-trip
    /// verbatim.
    static func validateMetadata(
        _ metadata: [String: ControlJSONValue]?
    ) throws -> [String: ControlJSONValue] {
        guard let metadata else { return [:] }
        guard metadata.count <= ControlSession.Limits.maxMetadataKeys else {
            throw ControlError(
                .invalidRequest,
                "metadata has more than \(ControlSession.Limits.maxMetadataKeys) keys")
        }
        for (key, value) in metadata {
            guard !key.isEmpty else {
                throw ControlError(.invalidRequest, "metadata key must not be empty")
            }
            guard key.count <= ControlSession.Limits.maxMetadataKeyLength else {
                throw ControlError(
                    .invalidRequest,
                    "metadata key '\(key)' exceeds \(ControlSession.Limits.maxMetadataKeyLength) characters")
            }
            guard isValidMetadataKey(key) else {
                throw ControlError(
                    .invalidRequest,
                    "metadata key '\(key)' contains invalid characters (allowed: A-Z a-z 0-9 _ . -)")
            }
            guard value.serializedByteCount <= ControlSession.Limits.maxMetadataValueBytes else {
                throw ControlError(
                    .invalidRequest,
                    "metadata value for '\(key)' exceeds \(ControlSession.Limits.maxMetadataValueBytes) bytes")
            }
        }
        // Bound the whole map, not just each value, so many medium values cannot
        // add up to an unbounded payload.
        let total = metadata.values.reduce(0) { $0 + $1.serializedByteCount }
        guard total <= ControlSession.Limits.maxMetadataBytes else {
            throw ControlError(
                .invalidRequest,
                "metadata exceeds \(ControlSession.Limits.maxMetadataBytes) bytes total")
        }
        return metadata
    }

    static func isValidMetadataKey(_ key: String) -> Bool {
        key.allSatisfy { character in
            guard let ascii = character.asciiValue else { return false }
            switch ascii {
            case UInt8(ascii: "A")...UInt8(ascii: "Z"),
                 UInt8(ascii: "a")...UInt8(ascii: "z"),
                 UInt8(ascii: "0")...UInt8(ascii: "9"):
                return true
            default:
                return character == "_" || character == "." || character == "-"
            }
        }
    }

    /// Validate `KEY=VALUE` env entries and return them as a dictionary.
    static func validateEnv(_ env: [String]?) throws -> [String: String] {
        guard let env else { return [:] }
        guard env.count <= ControlSession.Limits.maxEnvEntries else {
            throw ControlError(
                .invalidRequest,
                "more than \(ControlSession.Limits.maxEnvEntries) environment entries")
        }
        var result: [String: String] = [:]
        for entry in env {
            guard let separator = entry.firstIndex(of: "=") else {
                throw ControlError(
                    .invalidRequest,
                    "environment entry '\(entry)' is not in KEY=VALUE format")
            }
            let key = String(entry[..<separator])
            let value = String(entry[entry.index(after: separator)...])
            guard !key.isEmpty else {
                throw ControlError(.invalidRequest, "environment entry has an empty key")
            }
            guard isValidEnvKey(key) else {
                throw ControlError(
                    .invalidRequest,
                    "environment key '\(key)' contains invalid characters")
            }
            result[key] = value
        }
        return result
    }

    static func isValidEnvKey(_ key: String) -> Bool {
        key.allSatisfy { character in
            guard let ascii = character.asciiValue else { return false }
            switch ascii {
            case UInt8(ascii: "A")...UInt8(ascii: "Z"),
                 UInt8(ascii: "a")...UInt8(ascii: "z"),
                 UInt8(ascii: "0")...UInt8(ascii: "9"):
                return true
            default:
                return character == "_"
            }
        }
    }

    /// Validate an agent-declared state name. States may be namespaced (e.g.
    /// `tests:passed`) so multiple agents can update the same tab unambiguously.
    static func validateState(_ state: String?) throws -> String {
        guard let state, !state.isEmpty else {
            throw ControlError(.invalidRequest, "state must not be empty")
        }
        guard state.count <= ControlSession.Limits.maxStateLength else {
            throw ControlError(
                .invalidRequest,
                "state exceeds \(ControlSession.Limits.maxStateLength) characters")
        }
        guard isValidNamespacedName(state) else {
            throw ControlError(
                .invalidRequest,
                "state '\(state)' contains invalid characters (allowed: A-Z a-z 0-9 _ . - : /)")
        }
        return state
    }

    /// Validate a group label. Same namespaced character rules as states/events
    /// so a group id is a stable, opaque token (no inference from its text).
    /// Returns nil for an absent/empty group (which means "no group" / "leave").
    static func validateGroup(_ group: String?) throws -> String? {
        guard let group, !group.isEmpty else { return nil }
        guard group.count <= ControlSession.Limits.maxGroupLength else {
            throw ControlError(
                .invalidRequest,
                "group exceeds \(ControlSession.Limits.maxGroupLength) characters")
        }
        guard isValidNamespacedName(group) else {
            throw ControlError(
                .invalidRequest,
                "group '\(group)' contains invalid characters (allowed: A-Z a-z 0-9 _ . - : /)")
        }
        return group
    }

    /// Validate an agent-declared agent type (MAX-5), e.g. `claude-code`. Same
    /// namespaced character rules as states/groups so it stays a stable, opaque
    /// token (Maxx never derives meaning from its text). Returns nil for an
    /// absent/empty value (meaning "no agent type" at create / "leave unchanged"
    /// is handled by the caller).
    static func validateAgentType(_ agentType: String?) throws -> String? {
        guard let agentType, !agentType.isEmpty else { return nil }
        guard agentType.count <= ControlSession.Limits.maxAgentTypeLength else {
            throw ControlError(
                .invalidRequest,
                "agent_type exceeds \(ControlSession.Limits.maxAgentTypeLength) characters")
        }
        guard isValidNamespacedName(agentType) else {
            throw ControlError(
                .invalidRequest,
                "agent_type '\(agentType)' contains invalid characters (allowed: A-Z a-z 0-9 _ . - : /)")
        }
        return agentType
    }

    /// Validate an emitted event name. Same character rules as states.
    static func validateEventName(_ name: String?) throws -> String {
        guard let name, !name.isEmpty else {
            throw ControlError(.invalidRequest, "event must not be empty")
        }
        guard name.count <= ControlSession.Limits.maxEventNameLength else {
            throw ControlError(
                .invalidRequest,
                "event exceeds \(ControlSession.Limits.maxEventNameLength) characters")
        }
        guard isValidNamespacedName(name) else {
            throw ControlError(
                .invalidRequest,
                "event '\(name)' contains invalid characters (allowed: A-Z a-z 0-9 _ . - : /)")
        }
        return name
    }

    /// Validate and default the `source` recorded on a declared fact.
    static func validateSource(_ source: String?) throws -> String {
        guard let source else { return ControlSession.defaultSource }
        guard !source.isEmpty else {
            throw ControlError(.invalidRequest, "source must not be empty")
        }
        guard source.count <= ControlSession.Limits.maxSourceLength else {
            throw ControlError(
                .invalidRequest,
                "source exceeds \(ControlSession.Limits.maxSourceLength) characters")
        }
        return source
    }

    static func validateReason(_ reason: String?) throws -> String? {
        guard let reason else { return nil }
        guard reason.count <= ControlSession.Limits.maxReasonLength else {
            throw ControlError(
                .invalidRequest,
                "reason exceeds \(ControlSession.Limits.maxReasonLength) characters")
        }
        return reason
    }

    static func isValidNamespacedName(_ name: String) -> Bool {
        name.allSatisfy { character in
            guard let ascii = character.asciiValue else { return false }
            switch ascii {
            case UInt8(ascii: "A")...UInt8(ascii: "Z"),
                 UInt8(ascii: "a")...UInt8(ascii: "z"),
                 UInt8(ascii: "0")...UInt8(ascii: "9"):
                return true
            default:
                return character == "_" || character == "." || character == "-"
                    || character == ":" || character == "/"
            }
        }
    }

    /// Map a signal name (case-insensitive, `SIG`-prefix optional) to its number.
    /// Restricted to the signals it is meaningful to deliver to a foreground
    /// terminal process.
    static func parseSignal(_ name: String) throws -> Int32 {
        let upper = name.uppercased()
        let bare = upper.hasPrefix("SIG") ? String(upper.dropFirst(3)) : upper
        switch bare {
        case "INT": return SIGINT
        case "TERM": return SIGTERM
        case "KILL": return SIGKILL
        case "HUP": return SIGHUP
        case "QUIT": return SIGQUIT
        default:
            throw ControlError(
                .invalidRequest,
                "unsupported signal '\(name)' (allowed: SIGINT, SIGTERM, SIGKILL, SIGHUP, SIGQUIT)")
        }
    }
}

// MARK: - Persistence (MAX-5)

/// On-disk encoding for the persistent session registry.
///
/// A dedicated `Codable` conformance (rather than the synthesized one) so the
/// stored schema is explicit, snake-cased, and **migration-friendly**: every
/// field beyond the stable identity (`id`/`surface_id`/`created_at`) is decoded
/// with `decodeIfPresent` and a default, so a registry file written by an older
/// (or newer) Maxx build still loads — a missing field becomes its default
/// rather than a hard decode failure. `restoredFromPreviousRun` is deliberately
/// **not** encoded: it is a fact about the current run, recomputed on load.
extension ControlSession: Codable {
    enum CodingKeys: String, CodingKey {
        case id
        case surfaceID = "surface_id"
        case parentID = "parent_id"
        case title, command, cwd, env, location, status, metadata, group
        case agentType = "agent_type"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case lastSeenAt = "last_seen_at"
        case canceled, archived
        case archivedAt = "archived_at"
        case archiveReason = "archive_reason"
        case restartCount = "restart_count"
        case lastObservedLifecycle = "last_observed_lifecycle"
        case events
        case nextSeq = "next_seq"
        case workflowState = "workflow_state"
        case workflowStateAt = "workflow_state_at"
        case workflowStateSource = "workflow_state_source"
        case summary
        case summaryAt = "summary_at"
        case summarySource = "summary_source"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let id = try container.decode(UUID.self, forKey: .id)
        let surfaceID = try container.decode(UUID.self, forKey: .surfaceID)
        let createdAt = try container.decode(Date.self, forKey: .createdAt)
        let events = try container.decodeIfPresent([ControlEvent].self, forKey: .events) ?? []
        self.init(
            id: id,
            surfaceID: surfaceID,
            title: try container.decodeIfPresent(String.self, forKey: .title),
            command: try container.decodeIfPresent(String.self, forKey: .command),
            cwd: try container.decodeIfPresent(String.self, forKey: .cwd),
            // `env` is intentionally NOT restored from disk: create-time `--env`
            // can carry secrets (e.g. API tokens passed only to the spawned agent),
            // which must not have a plaintext at-rest copy revived across restarts.
            // It is runtime-only — held in memory for the current run, never
            // persisted (see encode(to:)). A legacy file that still contains it is
            // ignored here and scrubbed on the next save.
            env: [:],
            // Tolerate an unknown future `location`/`workflow_state` raw value:
            // fall back rather than throw, so an additive enum case from a newer
            // build doesn't drop the whole record on an older build.
            location: ((try? container.decodeIfPresent(ControlLocation.self, forKey: .location)) ?? nil) ?? .tab,
            status: try container.decodeIfPresent(String.self, forKey: .status) ?? "created",
            metadata: try container.decodeIfPresent(
                [String: ControlJSONValue].self, forKey: .metadata) ?? [:],
            group: try container.decodeIfPresent(String.self, forKey: .group),
            parentID: try container.decodeIfPresent(UUID.self, forKey: .parentID),
            agentType: try container.decodeIfPresent(String.self, forKey: .agentType),
            createdAt: createdAt,
            // Older schemas may predate updatedAt; fall back to createdAt.
            updatedAt: try container.decodeIfPresent(Date.self, forKey: .updatedAt) ?? createdAt,
            lastSeenAt: try container.decodeIfPresent(Date.self, forKey: .lastSeenAt),
            canceled: try container.decodeIfPresent(Bool.self, forKey: .canceled) ?? false,
            archived: try container.decodeIfPresent(Bool.self, forKey: .archived) ?? false,
            archivedAt: try container.decodeIfPresent(Date.self, forKey: .archivedAt),
            archiveReason: try container.decodeIfPresent(String.self, forKey: .archiveReason),
            restartCount: try container.decodeIfPresent(Int.self, forKey: .restartCount) ?? 0,
            lastObservedLifecycle: try container.decodeIfPresent(
                String.self, forKey: .lastObservedLifecycle),
            events: events,
            // Keep sequence numbers monotonic across restarts: resume past the
            // last persisted event even if `next_seq` was absent in the file.
            nextSeq: try container.decodeIfPresent(Int.self, forKey: .nextSeq)
                ?? ((events.last?.seq).map { $0 + 1 } ?? 0),
            workflowState: (try? container.decodeIfPresent(WorkflowState.self, forKey: .workflowState)) ?? nil,
            workflowStateAt: try container.decodeIfPresent(Date.self, forKey: .workflowStateAt),
            workflowStateSource: try container.decodeIfPresent(
                String.self, forKey: .workflowStateSource),
            summary: try container.decodeIfPresent(String.self, forKey: .summary),
            summaryAt: try container.decodeIfPresent(Date.self, forKey: .summaryAt),
            summarySource: try container.decodeIfPresent(String.self, forKey: .summarySource))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(surfaceID, forKey: .surfaceID)
        try container.encodeIfPresent(parentID, forKey: .parentID)
        try container.encodeIfPresent(title, forKey: .title)
        try container.encodeIfPresent(command, forKey: .command)
        try container.encodeIfPresent(cwd, forKey: .cwd)
        // `env` is deliberately omitted from the durable record: it can hold
        // secrets and must never be written to disk (see init(from:)).
        try container.encode(location, forKey: .location)
        try container.encode(status, forKey: .status)
        if !metadata.isEmpty { try container.encode(metadata, forKey: .metadata) }
        try container.encodeIfPresent(group, forKey: .group)
        try container.encodeIfPresent(agentType, forKey: .agentType)
        try container.encode(createdAt, forKey: .createdAt)
        try container.encode(updatedAt, forKey: .updatedAt)
        try container.encodeIfPresent(lastSeenAt, forKey: .lastSeenAt)
        try container.encode(canceled, forKey: .canceled)
        try container.encode(archived, forKey: .archived)
        try container.encodeIfPresent(archivedAt, forKey: .archivedAt)
        try container.encodeIfPresent(archiveReason, forKey: .archiveReason)
        try container.encode(restartCount, forKey: .restartCount)
        try container.encodeIfPresent(lastObservedLifecycle, forKey: .lastObservedLifecycle)
        if !events.isEmpty { try container.encode(events, forKey: .events) }
        try container.encode(nextSeq, forKey: .nextSeq)
        try container.encodeIfPresent(workflowState, forKey: .workflowState)
        try container.encodeIfPresent(workflowStateAt, forKey: .workflowStateAt)
        try container.encodeIfPresent(workflowStateSource, forKey: .workflowStateSource)
        try container.encodeIfPresent(summary, forKey: .summary)
        try container.encodeIfPresent(summaryAt, forKey: .summaryAt)
        try container.encodeIfPresent(summarySource, forKey: .summarySource)
    }
}
