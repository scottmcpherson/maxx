import Foundation

// The wire protocol for the external Maxx Control API.
//
// The transport is newline-delimited JSON over a Unix domain socket: a caller
// connects, writes exactly one ControlRequest object followed by a newline (or
// half-closes the write side), and reads back exactly one ControlResponse
// object terminated by a newline.
//
// The `method` field mirrors the REST shape proposed in MAX-1 — e.g.
// `sessions.create` corresponds to `POST /control/v1/sessions`,
// `sessions.update` to `PATCH /control/v1/sessions/{id}`, and so on — without
// requiring an HTTP stack or a listening TCP port.

// MARK: - Methods

enum ControlMethod: String, Codable {
    /// Create a tab/session from explicit inputs. (`POST /sessions`)
    case sessionsCreate = "sessions.create"

    /// Return explicit lifecycle state and declared metadata. (`GET /sessions/{id}`)
    case sessionsGet = "sessions.get"

    /// List API-created sessions visible to the caller. (`GET /sessions`)
    case sessionsList = "sessions.list"

    /// Update caller-owned metadata/status only. (`PATCH /sessions/{id}`)
    case sessionsUpdate = "sessions.update"

    /// Send a constrained action: focus, input, interrupt, cancel, close.
    /// (`POST /sessions/{id}/actions`)
    case sessionsAction = "sessions.action"

    // MARK: Lifecycle (MAX-2)

    /// Block until an agent-declared state/event or a Maxx-owned lifecycle is
    /// observed, or a timeout elapses. Single response carrying the outcome.
    case sessionsWait = "sessions.wait"

    /// Stream lifecycle/event changes as newline-delimited messages until the
    /// session ends, the timeout elapses, or the caller disconnects.
    case sessionsWatch = "sessions.watch"

    /// Archive a session: close its surface but retain the record for later
    /// inspection.
    case sessionsArchive = "sessions.archive"

    /// Restart a session's recorded (or caller-supplied) command in a fresh
    /// surface, keeping the stable session id.
    case sessionsRestart = "sessions.restart"

    // MARK: Agent declaration hooks (MAX-2)

    /// Declare an agent-owned lifecycle state, recorded with full audit context.
    case sessionsDeclareState = "sessions.declare-state"

    /// Emit a named agent event with an optional structured payload.
    case sessionsEmitEvent = "sessions.emit-event"

    /// Set a single caller-owned metadata key.
    case sessionsSetMetadata = "sessions.set-metadata"

    /// Return a session's audit log (declared states/events + lifecycle actions).
    case sessionsEvents = "sessions.events"

    // MARK: Agent-declared workflow state (MAX-3)

    /// Declare a validated, human-facing workflow state for display
    /// (`running`/`needsInput`/`blocked`/`complete`/`failed`).
    case sessionsSetState = "sessions.set-state"

    /// Set the short human-readable summary shown alongside the workflow state.
    case sessionsSetSummary = "sessions.set-summary"

    // MARK: Structured event stream (MAX-7)

    /// Set (or clear) a session's group membership, recorded as a Maxx-owned
    /// mechanical event on the structured stream.
    case sessionsSetGroup = "sessions.set-group"

    /// Stream the cross-resource structured event bus as newline-delimited
    /// messages, filtered by session/tab/group and resumable from a cursor.
    case streamWatch = "stream.watch"

    /// Block until a matching stream event arrives or a group-wide condition
    /// holds, or a timeout elapses. Single response carrying the outcome.
    case streamWait = "stream.wait"
}

// MARK: - Errors

/// Stable, machine-readable error codes. Documented and predictable so callers
/// can branch on them; the human-readable `message` is for logs/diagnostics.
enum ControlErrorCode: String, Codable {
    case invalidRequest = "invalid_request"
    case unauthorized
    case notFound = "not_found"
    case alreadyEnded = "already_ended"
    case unsupportedAction = "unsupported_action"
    /// The operation is not supported for this session in its current state
    /// (e.g. `restart` on a session with no restartable command).
    case unsupported
    case internalError = "internal"
}

struct ControlError: Error {
    let code: ControlErrorCode
    let message: String

    init(_ code: ControlErrorCode, _ message: String) {
        self.code = code
        self.message = message
    }
}

// MARK: - Request

struct ControlRequest: Codable {
    /// Capability token. Verified by the server before the request is dispatched.
    var token: String?
    var method: ControlMethod
    var params: Params?

    /// A single, flat parameter object shared across methods. Each handler reads
    /// only the fields it understands; unexpected fields for a given method are
    /// rejected explicitly (e.g. `sessions.update` rejects `command`/`cwd`).
    struct Params: Codable {
        /// Control session id (UUID string) for get/update/action.
        var id: String?
        var title: String?
        var cwd: String?
        var command: String?
        /// Environment overrides in `KEY=VALUE` form.
        var env: [String]?
        /// Caller-owned metadata (string → string).
        var metadata: [String: String]?
        /// Caller-owned status string (e.g. `waiting_for_review`).
        var status: String?
        /// `tab` (default) or `window`.
        var location: String?
        /// Action name for `sessions.action`.
        var action: String?
        /// Input text for the `input` action.
        var input: String?

        // MARK: Lifecycle (MAX-2)

        /// Agent-declared state name (`declare-state`) or the state to `wait` for.
        var state: String?
        /// Event name (`emit-event`) or the event to `wait` for.
        var event: String?
        /// Maxx-owned lifecycle value to `wait` for (`running`/`exited`/etc.).
        var lifecycle: String?
        /// Human-readable message for `declare-state`.
        var message: String?
        /// Who declared a state/event. Defaults to `agent` when omitted.
        var source: String?
        /// Raw JSON string payload for `emit-event`.
        var payloadJson: String?
        /// Metadata key for `set-metadata`.
        var key: String?
        /// Metadata value for `set-metadata`.
        var value: String?
        /// Optional reason recorded by `archive`.
        var reason: String?
        /// Signal name for the `interrupt` action (default: send Ctrl-C via tty).
        var signal: String?
        /// Timeout in milliseconds for `wait`/`watch`.
        var timeoutMs: Int?
        /// Replay/baseline event sequence for `wait --event` and `watch`.
        var since: Int?

        // MARK: Agent-declared workflow state (MAX-3)

        /// Short human-readable summary for `set-summary`. (`set-state` reuses
        /// the `state` field above, validated against the workflow vocabulary.)
        var summary: String?

        // MARK: Structured event stream (MAX-7)

        /// Group label: set membership (`set-group`/`create`) or filter a
        /// `stream.watch`/`stream.wait` to a group. Empty/absent on `set-group`
        /// means "leave the current group".
        var group: String?
        /// Surface (tab) id to filter a `stream.watch`/`stream.wait` by.
        var tab: String?
        /// Group-wide condition for `stream.wait --group`: `idle`, `exited`, or
        /// `declared:<workflow-state>`.
        var all: String?

        enum CodingKeys: String, CodingKey {
            case id, title, cwd, command, env, metadata, status, location
            case action, input, state, event, lifecycle, message, source
            case payloadJson = "payload_json"
            case key, value, reason, signal
            case timeoutMs = "timeout_ms"
            case since
            case summary
            case group, tab, all
        }
    }
}

// MARK: - Response

/// A snapshot of a control session returned to callers. The `sessionID` is
/// stable and intentionally distinct from `surfaceID`, title, PID, working
/// directory, or command text, so callers manage sessions without relying on
/// any UI heuristic or terminal output.
struct ControlSessionView: Codable, Equatable {
    var sessionID: String
    var surfaceID: String
    var title: String?
    var command: String?
    var cwd: String?
    /// Caller-owned status.
    var status: String
    /// Maxx-owned lifecycle: `running`, `exited`, or `closed`. Derived only from
    /// explicit session state (surface existence + kernel-reported process
    /// liveness), never from terminal output.
    var lifecycle: String
    var metadata: [String: String]
    /// Group membership for supervisor coordination (MAX-7); omitted when the
    /// session is not in a group. Explicitly set, never inferred.
    var group: String?
    var createdAt: String
    var pid: Int?
    /// When the session was archived, if it has been.
    var archivedAt: String?
    /// The reason recorded by `archive`, if any.
    var archiveReason: String?
    /// How many times the session's command has been restarted (omitted if 0).
    var restartCount: Int?
    /// Sequence of the most recent audit-log entry (omitted if none). Use as a
    /// baseline for `wait --event --since` / `watch --since` to avoid races.
    var lastEventSeq: Int?
    /// Agent-declared workflow state for display: one of `running`, `needsInput`,
    /// `blocked`, `complete`, `failed`. Omitted until declared via `set-state`;
    /// never inferred. Distinct from caller-owned `status` and Maxx-owned
    /// `lifecycle`.
    var workflowState: String?
    /// When `workflowState` was last declared (ISO-8601), if ever.
    var workflowStateAt: String?
    /// Who declared `workflowState`, if ever.
    var workflowStateSource: String?
    /// Agent-declared summary line, set via `set-summary`. Omitted until declared.
    var summary: String?
    /// When `summary` was last declared (ISO-8601), if ever.
    var summaryAt: String?
    /// Who declared `summary`, if ever.
    var summarySource: String?

    enum CodingKeys: String, CodingKey {
        case sessionID = "session_id"
        case surfaceID = "surface_id"
        case title, command, cwd, status, lifecycle, metadata, group
        case createdAt = "created_at"
        case pid
        case archivedAt = "archived_at"
        case archiveReason = "archive_reason"
        case restartCount = "restart_count"
        case lastEventSeq = "last_event_seq"
        case workflowState = "workflow_state"
        case workflowStateAt = "workflow_state_at"
        case workflowStateSource = "workflow_state_source"
        case summary
        case summaryAt = "summary_at"
        case summarySource = "summary_source"
    }
}

struct ControlResponse: Codable {
    var ok: Bool
    var result: Result?
    var error: ErrorBody?

    struct ErrorBody: Codable {
        var code: String
        var message: String
    }

    struct Result: Codable {
        var session: ControlSessionView?
        var sessions: [ControlSessionView]?
        /// True when a cancel/close action ended (or already-ended) the session.
        var canceled: Bool?
        /// The action that was applied, echoed back for `sessions.action`.
        var applied: String?
        /// `wait` outcome: `matched`, `timeout`, or `ended`.
        var outcome: String?
        /// The audit-log entry that satisfied a `wait --event`/`--state`.
        var event: ControlEventView?
        /// A session's audit log, returned by `sessions.events`.
        var events: [ControlEventView]?
        /// The structured stream envelope that satisfied a `stream.wait --event`.
        var streamEvent: ControlStreamEventView?

        enum CodingKeys: String, CodingKey {
            case session, sessions, canceled, applied, outcome, event, events
            case streamEvent = "stream_event"
        }

        init(
            session: ControlSessionView? = nil,
            sessions: [ControlSessionView]? = nil,
            canceled: Bool? = nil,
            applied: String? = nil,
            outcome: String? = nil,
            event: ControlEventView? = nil,
            events: [ControlEventView]? = nil,
            streamEvent: ControlStreamEventView? = nil
        ) {
            self.session = session
            self.sessions = sessions
            self.canceled = canceled
            self.applied = applied
            self.outcome = outcome
            self.event = event
            self.events = events
            self.streamEvent = streamEvent
        }
    }

    static func success(_ result: Result) -> ControlResponse {
        .init(ok: true, result: result, error: nil)
    }

    static func failure(_ error: ControlError) -> ControlResponse {
        .init(
            ok: false,
            result: nil,
            error: .init(code: error.code.rawValue, message: error.message))
    }
}
