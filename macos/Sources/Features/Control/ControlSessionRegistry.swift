import Foundation

/// Explicit inputs for creating a terminal through the control API.
struct ControlCreateRequest {
    var title: String?
    var command: String?
    var cwd: String?
    var env: [String: String]
    var location: ControlLocation
}

enum ControlLocation: String {
    case tab
    case window
}

/// Abstraction over the live terminal surfaces the registry manages.
///
/// Injected so the registry's validation, authorization, metadata, and
/// lifecycle logic can be unit tested without a running app. The production
/// implementation (`TerminalControlHost`) drives the real `TerminalController`
/// creation path; tests use an in-memory fake.
@MainActor
protocol ControlSessionHost: AnyObject {
    /// Create a new visible terminal from explicit inputs. Returns the stable
    /// surface UUID, or throws a `ControlError` on failure (e.g. invalid cwd).
    func createTerminal(_ request: ControlCreateRequest) throws -> UUID

    /// Returns a handle to a live surface by id, or `nil` if it no longer exists.
    func surface(for surfaceID: UUID) -> ControlSurfaceHandle?
}

/// A handle to a live surface.
///
/// Every operation here is an explicit control action. Nothing on this protocol
/// reads or interprets terminal output; `isProcessAlive` reflects only the
/// kernel-reported state of the child process.
@MainActor
protocol ControlSurfaceHandle {
    var surfaceID: UUID { get }
    var title: String { get }
    var workingDirectory: String? { get }
    var pid: Int? { get }
    /// Kernel-reported child-process liveness — NOT output inference.
    var isProcessAlive: Bool { get }
    func focus()
    func sendInput(_ text: String)
    /// Send an interrupt (Ctrl-C / ETX) to the foreground process.
    func interrupt()
    func close()
}

/// The in-memory registry of API-created sessions plus the request dispatcher.
///
/// Authorization model: the registry only ever exposes or mutates sessions it
/// created. The user's manually-opened terminals are never enumerated or
/// controllable through this API, so a caller cannot reach an arbitrary surface
/// even with a valid token.
@MainActor
final class ControlSessionRegistry {
    private var sessions: [UUID: ControlSession] = [:]
    private let now: () -> Date
    private let makeID: () -> UUID

    private static let iso8601: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    init(
        now: @escaping () -> Date = Date.init,
        makeID: @escaping () -> UUID = UUID.init
    ) {
        self.now = now
        self.makeID = makeID
    }

    /// Number of tracked sessions (including ended ones). Exposed for tests.
    var count: Int { sessions.count }

    // MARK: - Dispatch

    /// Handle one authorized request and produce a response. Token verification
    /// happens in the transport layer before this is called.
    func handle(_ request: ControlRequest, host: ControlSessionHost) -> ControlResponse {
        do {
            switch request.method {
            case .sessionsCreate:
                return .success(.init(session: try create(request.params, host: host)))
            case .sessionsGet:
                return .success(.init(session: try get(request.params, host: host)))
            case .sessionsList:
                return .success(.init(sessions: list(host: host)))
            case .sessionsUpdate:
                return .success(.init(session: try update(request.params, host: host)))
            case .sessionsAction:
                return try action(request.params, host: host)
            }
        } catch let error as ControlError {
            return .failure(error)
        } catch {
            return .failure(ControlError(.internalError, "\(error)"))
        }
    }

    // MARK: - Handlers

    private func create(
        _ params: ControlRequest.Params?,
        host: ControlSessionHost
    ) throws -> ControlSessionView {
        let title = try ControlValidation.validateTitle(params?.title)
        let command = try ControlValidation.validateCommand(params?.command)
        let cwd = try ControlValidation.validateCwd(params?.cwd)
        let env = try ControlValidation.validateEnv(params?.env)
        let metadata = try ControlValidation.validateMetadata(params?.metadata)
        let status = try ControlValidation.validateStatus(params?.status) ?? "created"

        let location: ControlLocation
        if let raw = params?.location {
            guard let parsed = ControlLocation(rawValue: raw) else {
                throw ControlError(.invalidRequest, "location must be 'tab' or 'window'")
            }
            location = parsed
        } else {
            location = .tab
        }

        let surfaceID = try host.createTerminal(.init(
            title: title,
            command: command,
            cwd: cwd,
            env: env,
            location: location))

        let session = ControlSession(
            id: makeID(),
            surfaceID: surfaceID,
            title: title,
            command: command,
            cwd: cwd,
            status: status,
            metadata: metadata,
            createdAt: now(),
            canceled: false)
        sessions[session.id] = session
        return view(of: session, host: host)
    }

    private func get(
        _ params: ControlRequest.Params?,
        host: ControlSessionHost
    ) throws -> ControlSessionView {
        let session = try requireSession(params?.id)
        return view(of: session, host: host)
    }

    private func list(host: ControlSessionHost) -> [ControlSessionView] {
        sessions.values
            .sorted { $0.createdAt < $1.createdAt }
            .map { view(of: $0, host: host) }
    }

    private func update(
        _ params: ControlRequest.Params?,
        host: ControlSessionHost
    ) throws -> ControlSessionView {
        var session = try requireSession(params?.id)

        // PATCH only touches caller-owned status and metadata. Any attempt to
        // set server-owned fields (command/cwd/title/location/env) via update is
        // rejected so ownership boundaries stay clear.
        if params?.command != nil
            || params?.cwd != nil
            || params?.title != nil
            || params?.location != nil
            || params?.env != nil {
            throw ControlError(
                .invalidRequest,
                "only 'status' and 'metadata' may be updated")
        }

        if let status = try ControlValidation.validateStatus(params?.status) {
            session.status = status
        }

        if let metadata = params?.metadata {
            // Merge (append) semantics: provided keys overwrite/add to existing
            // metadata. The combined map is re-validated against the limits.
            let validated = try ControlValidation.validateMetadata(metadata)
            var merged = session.metadata
            merged.merge(validated) { _, new in new }
            session.metadata = try ControlValidation.validateMetadata(merged)
        }

        sessions[session.id] = session
        return view(of: session, host: host)
    }

    private func action(
        _ params: ControlRequest.Params?,
        host: ControlSessionHost
    ) throws -> ControlResponse {
        let session = try requireSession(params?.id)
        guard let actionName = params?.action, !actionName.isEmpty else {
            throw ControlError(.invalidRequest, "action is required")
        }

        switch actionName {
        case "focus":
            try requireLiveSurface(session, host: host).focus()
            return .success(.init(session: view(of: session, host: host), applied: "focus"))

        case "input":
            guard let input = params?.input else {
                throw ControlError(.invalidRequest, "input action requires 'input' text")
            }
            try requireLiveSurface(session, host: host).sendInput(input)
            return .success(.init(session: view(of: session, host: host), applied: "input"))

        case "interrupt":
            try requireLiveSurface(session, host: host).interrupt()
            return .success(.init(session: view(of: session, host: host), applied: "interrupt"))

        case "cancel", "close":
            return cancel(session, host: host)

        default:
            throw ControlError(.unsupportedAction, "unknown action '\(actionName)'")
        }
    }

    // MARK: - Helpers

    private func requireSession(_ idString: String?) throws -> ControlSession {
        guard let idString, !idString.isEmpty else {
            throw ControlError(.invalidRequest, "session id is required")
        }
        guard let id = UUID(uuidString: idString) else {
            throw ControlError(.invalidRequest, "session id is not a valid UUID")
        }
        guard let session = sessions[id] else {
            throw ControlError(.notFound, "no session with id \(idString)")
        }
        return session
    }

    @discardableResult
    private func requireLiveSurface(
        _ session: ControlSession,
        host: ControlSessionHost
    ) throws -> ControlSurfaceHandle {
        if session.canceled {
            throw ControlError(.alreadyEnded, "session \(session.id.uuidString) has already ended")
        }
        guard let handle = host.surface(for: session.surfaceID) else {
            throw ControlError(
                .alreadyEnded,
                "session \(session.id.uuidString) surface no longer exists")
        }
        return handle
    }

    /// Cancel/close a session. Idempotent: canceling an already-ended session is
    /// a success no-op so callers can retry safely.
    private func cancel(_ input: ControlSession, host: ControlSessionHost) -> ControlResponse {
        var session = input
        if !session.canceled, let handle = host.surface(for: session.surfaceID) {
            handle.close()
        }
        session.canceled = true
        sessions[session.id] = session
        return .success(.init(session: view(of: session, host: host), canceled: true))
    }

    /// Build the wire view of a session, computing lifecycle from explicit state
    /// only (cancel flag, surface existence, kernel process liveness).
    private func view(of session: ControlSession, host: ControlSessionHost) -> ControlSessionView {
        let lifecycle: ControlLifecycle
        let pid: Int?
        if session.canceled {
            lifecycle = .closed
            pid = nil
        } else if let handle = host.surface(for: session.surfaceID) {
            lifecycle = handle.isProcessAlive ? .running : .exited
            pid = handle.pid
        } else {
            lifecycle = .closed
            pid = nil
        }

        return ControlSessionView(
            sessionID: session.id.uuidString,
            surfaceID: session.surfaceID.uuidString,
            title: session.title,
            command: session.command,
            cwd: session.cwd,
            status: session.status,
            lifecycle: lifecycle.rawValue,
            metadata: session.metadata,
            createdAt: Self.iso8601.string(from: session.createdAt),
            pid: pid)
    }
}
