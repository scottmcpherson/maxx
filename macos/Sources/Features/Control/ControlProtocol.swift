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
    var createdAt: String
    var pid: Int?

    enum CodingKeys: String, CodingKey {
        case sessionID = "session_id"
        case surfaceID = "surface_id"
        case title, command, cwd, status, lifecycle, metadata
        case createdAt = "created_at"
        case pid
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

        init(
            session: ControlSessionView? = nil,
            sessions: [ControlSessionView]? = nil,
            canceled: Bool? = nil,
            applied: String? = nil
        ) {
            self.session = session
            self.sessions = sessions
            self.canceled = canceled
            self.applied = applied
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
