import Foundation

// The lifecycle event/state model layered on top of the MAX-1 control API.
//
// This model is one instance of Maxx's no-inference rule: it shows mechanical
// facts and agent-declared facts, never workflow truth Maxx derived itself. See
// docs/no-inference.md for the canonical rule and docs/control-api.md for the
// API.
//
// Two kinds of facts flow through this model, and the type names keep the
// boundary explicit:
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
    /// An agent declared a validated, human-facing workflow state (`set-state`).
    case workflowState = "workflow-state"
    /// An agent set the human-readable summary line (`set-summary`).
    case summary
    /// Maxx recorded a runtime lifecycle action it performed (archive/restart).
    case lifecycle

    /// Who owns this fact. Maxx-owned mechanical runtime facts (`lifecycle`)
    /// versus agent-declared semantic facts (everything else). This is the
    /// load-bearing ownership boundary the global event stream exposes as
    /// `source_kind` so a supervisor never has to guess whether Maxx originated a
    /// fact or merely recorded an agent's declaration.
    var sourceKind: ControlEventOwner {
        switch self {
        case .lifecycle: return .maxx
        case .state, .event, .metadata, .workflowState, .summary: return .agent
        }
    }
}

/// Ownership of an event in the structured stream: a Maxx-owned mechanical
/// runtime fact, or a fact an agent declared. Kept explicit in the envelope
/// (`source_kind`) so supervisors can trust the boundary without inspecting the
/// event name. Distinct from ``ControlSourceKind`` (MAX-11), which classifies the
/// *caller* of a request for capability policy, not the owner of an event.
enum ControlEventOwner: String, Codable {
    case maxx
    case agent
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

// MARK: - Structured event stream (MAX-7)

/// One entry in the registry's append-only, bounded global event bus.
///
/// The bus is the cross-resource view of everything that happens to API-created
/// sessions, carrying a process-wide monotonic ``cursor`` so a supervisor can
/// stream, filter, and resume from a known point regardless of which session an
/// event belongs to. It is a superset of the per-session audit logs: every
/// per-session audit entry is mirrored here, and Maxx-owned mechanical events
/// that have no per-session audit entry (create/focus/close/process-exit/group
/// membership) are recorded here only — so the per-session contract is unchanged.
///
/// Internal value type; the wire form is ``ControlStreamEventView``.
struct ControlBusEvent {
    /// Process-wide monotonically increasing cursor, starting at 1. Stable for
    /// the life of the run; survives session restarts and is never reused.
    let cursor: Int
    let kind: ControlEventKind
    let name: String
    let source: String
    let sourceKind: ControlEventOwner
    let message: String?
    let payload: ControlJSONValue?
    let createdAt: Date
    let sessionID: UUID
    let surfaceID: UUID
    /// The group this event pertains to (the session's current group for most
    /// events; the affected group for `group.joined`/`group.left`). nil when the
    /// session is not in a group.
    let group: String?
    let pid: Int?
    /// The per-session audit sequence when this event also exists in a session's
    /// audit log; nil for bus-only mechanical events.
    let seq: Int?
}

/// The schema-versioned wire envelope emitted by the global event stream
/// (`stream.watch` / `stream.wait`).
///
/// A deliberate superset of ``ControlEventView`` so supervisors get a stable,
/// correlatable record with a global cursor and an explicit ownership tag. New
/// fields are additive and optional. Post-create agent-reported metadata
/// mutations (MAX-4: `set`/`remove`/`clear-metadata` and the `update` merge) flow
/// onto the stream as `kind: metadata` events that carry the affected key in
/// `name` and reuse the generic `message`/`payload` fields; the envelope adds no
/// metadata-value-specific fields, so it stays uniform and workflow-neutral (a
/// supervisor reads the full map via `get`/`list`/`watch`, not off the stream).
/// Metadata supplied at `create` time is the exception: it is stored and shown
/// but emits no stream event — a create surfaces only `created`/`group.joined`.
struct ControlStreamEventView: Codable, Equatable {
    /// Envelope schema version. Bumped only on an incompatible change so a
    /// supervisor can pin the contract it understands.
    var schema: Int
    /// Process-wide monotonic cursor. Pass back as `--since` to resume.
    var cursor: Int
    /// Per-session audit sequence, when this event is also in a session's audit
    /// log; omitted for bus-only mechanical events.
    var seq: Int?
    /// `maxx` for mechanical runtime facts Maxx owns; `agent` for declared facts.
    var sourceKind: String
    var kind: String
    var name: String
    var source: String
    var message: String?
    var payload: ControlJSONValue?
    var createdAt: String
    /// The kind of resource this event is about. Currently always `session`;
    /// reserved so future tab-/group-scoped events stay additive.
    var resourceKind: String
    var sessionID: String
    var surfaceID: String
    /// Group this event pertains to, if any.
    var group: String?
    var pid: Int?

    enum CodingKeys: String, CodingKey {
        case schema, cursor, seq
        case sourceKind = "source_kind"
        case kind, name, source, message, payload
        case createdAt = "created_at"
        case resourceKind = "resource_kind"
        case sessionID = "session_id"
        case surfaceID = "surface_id"
        case group, pid
    }
}

/// The schema version of ``ControlStreamEventView``.
let controlStreamSchemaVersion = 1

/// A single newline-delimited message in a `stream.watch` stream. Distinct from
/// the per-session ``ControlStreamMessage`` because the global stream is
/// event-centric and cursor-aware.
struct ControlStreamFeedMessage: Codable {
    /// `hello` (opening line: current cursor + retention window), `event` (one
    /// bus event), or `end` (the stream is closing).
    var type: String
    /// Present on `hello`: the latest global cursor at stream start, so a
    /// consumer that passed no `--since` can resume from here later.
    var cursor: Int?
    /// Present on `hello`: the envelope schema version.
    var schema: Int?
    /// Present on `hello` when a requested `--since` fell outside the retained
    /// window: the stream resumes from the oldest retained event and the events
    /// up to and including `dropped_through` were lost to retention.
    var reset: Bool?
    var droppedThrough: Int?
    /// Present on `event`.
    var event: ControlStreamEventView?

    enum CodingKeys: String, CodingKey {
        case type, cursor, schema, reset
        case droppedThrough = "dropped_through"
        case event
    }
}

/// A minimal JSON value, so `emit-event --payload-json` round-trips arbitrary
/// (validated) JSON back to watchers as real nested JSON rather than a string.
enum ControlJSONValue: Codable, Equatable {
    case null
    case bool(Bool)
    /// A JSON integer that fits in `Int64`. Kept distinct from `number` so large
    /// integers (external IDs, timestamps, run numbers) round-trip exactly — a
    /// `Double` silently corrupts integers past 2^53, which would violate the
    /// "metadata is stored/displayed/filtered verbatim" contract.
    case integer(Int64)
    case number(Double)
    case string(String)
    case array([ControlJSONValue])
    case object([String: ControlJSONValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            // Bool first: a JSON `true`/`false` is a `__NSCFBoolean` that would
            // otherwise also decode as Int64(1)/Int64(0).
            self = .bool(value)
        } else if let value = try? container.decode(Int64.self) {
            // Int64 before Double so integer literals keep full precision; a
            // fractional or out-of-Int64-range number falls through to Double.
            self = .integer(value)
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
        case let .integer(value): try container.encode(value)
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

    /// Compact JSON serialization of this value, used both to bound metadata size
    /// and to render/compare values without interpreting them. Scalars are
    /// wrapped in an array before encoding because `JSONEncoder` rejects a
    /// top-level fragment; the surrounding brackets are stripped back off.
    ///
    /// Keys are sorted so an object value renders deterministically: otherwise
    /// `Dictionary` iteration order would make the displayed text — and the
    /// `displayString` used for `list` filtering — vary from run to run.
    var serializedJSON: String {
        let wrapped = ControlJSONValue.array([self])
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(wrapped),
              let string = String(data: data, encoding: .utf8),
              string.count >= 2 else {
            return ""
        }
        return String(string.dropFirst().dropLast())
    }

    /// Serialized (compact JSON) byte count, used to enforce metadata size limits.
    var serializedByteCount: Int { serializedJSON.utf8.count }

    /// A human-facing rendering for display and basic filtering. A bare string
    /// shows as itself (no surrounding quotes); every other value shows as its
    /// compact JSON. This is a presentation/comparison affordance only — Maxx
    /// still stores the value verbatim and never reinterprets it.
    var displayString: String {
        switch self {
        case let .string(value): return value
        default: return serializedJSON
        }
    }
}
