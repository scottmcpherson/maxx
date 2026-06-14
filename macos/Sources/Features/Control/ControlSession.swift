import Darwin
import Foundation

/// An API-created session.
///
/// This is a control-plane object distinct from the terminal surface it manages.
/// Its `id` is stable for the lifetime of the session and is intentionally
/// unrelated to the surface UUID, the UI title, the process ID, the working
/// directory, the git branch, or the command text — callers manage sessions
/// solely through this id.
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
    /// Caller-owned metadata.
    var metadata: [String: String]
    let createdAt: Date
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
    /// Append-only audit log of agent-declared facts and Maxx-owned lifecycle
    /// actions. Drives `wait`, `watch`, and `events`.
    var events: [ControlEvent] = []
    /// Next sequence number to assign to an appended event. Managed via
    /// ``appendEvent``; not `private` only so the synthesized memberwise
    /// initializer stays accessible within the module.
    var nextSeq: Int = 0

    /// Sequence of the most recently recorded event, or nil if none.
    var lastSeq: Int? { events.last?.seq }

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
        static let maxMetadataValueLength = 1024
        static let maxEnvEntries = 256
        static let maxStateLength = 128
        static let maxEventNameLength = 128
        static let maxSourceLength = 128
        static let maxReasonLength = 1024
        static let maxPayloadBytes = 8192
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

    /// Validate and return a normalized metadata dictionary.
    static func validateMetadata(_ metadata: [String: String]?) throws -> [String: String] {
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
            guard value.count <= ControlSession.Limits.maxMetadataValueLength else {
                throw ControlError(
                    .invalidRequest,
                    "metadata value for '\(key)' exceeds \(ControlSession.Limits.maxMetadataValueLength) characters")
            }
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
