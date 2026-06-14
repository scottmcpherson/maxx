import Foundation

// The lifecycle event/state model layered on top of the MAX-1 control API.
//
// Two kinds of facts flow through this model, and the type names keep the
// boundary explicit (see docs/control-api.md):
//
//   * Agent-declared semantic facts — states, events, and metadata an agent or
//     orchestrator explicitly declares through the API. Maxx stores and replays
//     them verbatim; it never originates or interprets them.
//   * Maxx-owned runtime facts — `lifecycle` transitions (running/exited/
//     closed/archived) and `restart`/`archive` actions, derived only from
//     explicit session state and kernel-reported process liveness.
//
// Everything here is recorded in response to an explicit API request or an
// explicit, kernel-reported state change. Nothing is ever scraped or inferred
// from terminal output.

/// What produced an event, so callers can filter audit logs.
enum ControlEventKind: String, Codable {
    /// An agent declared a lifecycle state (`declare-state`).
    case state
    /// An agent emitted a named event (`emit-event`).
    case event
    /// An agent set a metadata key (`set-metadata`).
    case metadata
    /// Maxx recorded a runtime lifecycle action it performed (archive/restart).
    case lifecycle
}

/// A single append-only entry in a session's audit log.
///
/// Each entry is fully auditable: it records the source, a per-session monotonic
/// sequence number, a timestamp, and the tab (surface) and process ids that were
/// current when it was recorded.
struct ControlEvent {
    /// Per-session monotonically increasing sequence number, starting at 0.
    let seq: Int
    let kind: ControlEventKind
    /// Event/state name (e.g. `tests:passed`) or the metadata key.
    let name: String
    /// Who declared it. Agent-supplied for declared facts; `maxx` for runtime
    /// facts Maxx records itself.
    let source: String
    /// Optional human-readable message (used by `declare-state`).
    let message: String?
    /// Optional structured payload (validated JSON), used by `emit-event`.
    let payload: ControlJSONValue?
    let createdAt: Date
    /// The surface (tab) this session managed when the entry was recorded.
    let surfaceID: UUID
    /// Foreground process id at record time, where Maxx could observe one.
    let pid: Int?
}

/// The wire view of a ``ControlEvent``.
struct ControlEventView: Codable, Equatable {
    var seq: Int
    var kind: String
    var name: String
    var source: String
    var message: String?
    var payload: ControlJSONValue?
    var createdAt: String
    var sessionID: String
    var surfaceID: String
    var pid: Int?

    enum CodingKeys: String, CodingKey {
        case seq, kind, name, source, message, payload
        case createdAt = "created_at"
        case sessionID = "session_id"
        case surfaceID = "surface_id"
        case pid
    }
}

/// A single message in a `watch` stream. Distinct from ``ControlResponse`` so a
/// long-lived `watch` connection can emit many newline-delimited objects.
struct ControlStreamMessage: Codable {
    /// `snapshot` (initial state), `event` (a new audit-log entry), `lifecycle`
    /// (a Maxx-owned lifecycle transition), or `end` (the session is terminal).
    var type: String
    var session: ControlSessionView?
    var event: ControlEventView?
    /// Present for `lifecycle` and `end` messages.
    var lifecycle: String?
}

/// A minimal JSON value, so `emit-event --payload-json` round-trips arbitrary
/// (validated) JSON back to watchers as real nested JSON rather than a string.
enum ControlJSONValue: Codable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([ControlJSONValue])
    case object([String: ControlJSONValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([ControlJSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: ControlJSONValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorrupted(.init(
                codingPath: decoder.codingPath,
                debugDescription: "not a JSON value"))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case let .bool(value): try container.encode(value)
        case let .number(value): try container.encode(value)
        case let .string(value): try container.encode(value)
        case let .array(value): try container.encode(value)
        case let .object(value): try container.encode(value)
        }
    }

    /// Parse and validate a raw JSON string, rejecting anything that is not
    /// well-formed JSON within the documented size limit.
    static func parse(_ raw: String) throws -> ControlJSONValue {
        guard raw.utf8.count <= ControlSession.Limits.maxPayloadBytes else {
            throw ControlError(
                .invalidRequest,
                "payload exceeds \(ControlSession.Limits.maxPayloadBytes) bytes")
        }
        do {
            return try JSONDecoder().decode(ControlJSONValue.self, from: Data(raw.utf8))
        } catch {
            throw ControlError(.invalidRequest, "payload is not valid JSON")
        }
    }
}
