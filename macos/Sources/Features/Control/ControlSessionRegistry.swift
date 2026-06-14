import Foundation
import os

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
    /// Interrupt the foreground process group. With `signal == nil`, deliver
    /// Ctrl-C (ETX) through the tty; with a signal number, send it to the
    /// foreground process group. Returns false if there was no foreground
    /// process to signal (so the caller can report `unsupported`).
    @discardableResult
    func interrupt(signal: Int32?) -> Bool
    func close()
    /// Push an explicit agent-declared workflow state/summary to the surface so
    /// the UI can render a badge. Called only in response to an explicit
    /// `set-state`/`set-summary` request — never from output inference.
    func applyDeclaredState(_ declared: ControlDeclaredState)
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

    /// Telemetry for declaration events only — the explicit `set-state` /
    /// `set-summary` calls Maxx receives, not any inferred interpretation.
    private static let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "com.scottmcpherson.maxx",
        category: "ControlSessionRegistry")

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
            case .sessionsArchive:
                return .success(.init(session: try archive(request.params, host: host)))
            case .sessionsRestart:
                return .success(.init(session: try restart(request.params, host: host)))
            case .sessionsDeclareState:
                return .success(.init(session: try declareState(request.params, host: host)))
            case .sessionsEmitEvent:
                let (view, event) = try emitEvent(request.params, host: host)
                return .success(.init(session: view, event: event))
            case .sessionsSetMetadata:
                return .success(.init(session: try setMetadata(request.params, host: host)))
            case .sessionsSetState:
                return .success(.init(session: try setState(request.params, host: host)))
            case .sessionsSetSummary:
                return .success(.init(session: try setSummary(request.params, host: host)))
            case .sessionsEvents:
                return .success(.init(events: try events(request.params, host: host)))
            case .sessionsWait, .sessionsWatch:
                // wait/watch are long-lived and handled by the streaming path in
                // ControlServer; they never reach this single-shot dispatcher.
                throw ControlError(
                    .invalidRequest, "wait/watch require a streaming connection")
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
            env: env,
            location: location,
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
            let handle = try requireLiveSurface(session, host: host)
            // No signal → deliver Ctrl-C through the tty (the most correct way to
            // interrupt the foreground process group). A named signal is sent to
            // the same foreground process group via the explicit process-control
            // path. The host reports delivery so we never claim success when
            // there was no foreground process to signal.
            let signal = try params?.signal.map(ControlValidation.parseSignal)
            guard handle.interrupt(signal: signal) else {
                throw ControlError(.unsupported, "session has no foreground process to signal")
            }
            return .success(.init(session: view(of: session, host: host), applied: "interrupt"))

        case "cancel", "close":
            return cancel(session, host: host)

        default:
            throw ControlError(.unsupportedAction, "unknown action '\(actionName)'")
        }
    }

    // MARK: - Agent declaration hooks

    /// Declare an agent-owned lifecycle state. Writes the session's current state
    /// and records an auditable entry (source, timestamp, surface, pid).
    private func declareState(
        _ params: ControlRequest.Params?,
        host: ControlSessionHost
    ) throws -> ControlSessionView {
        var session = try requireSession(params?.id)
        let state = try ControlValidation.validateState(params?.state)
        let source = try ControlValidation.validateSource(params?.source)
        let message = try validateMessage(params?.message)

        session.status = state
        session.appendEvent(
            kind: .state,
            name: state,
            source: source,
            message: message,
            createdAt: now(),
            pid: host.surface(for: session.surfaceID)?.pid)
        sessions[session.id] = session
        return view(of: session, host: host)
    }

    /// Emit a named agent event with an optional validated JSON payload.
    private func emitEvent(
        _ params: ControlRequest.Params?,
        host: ControlSessionHost
    ) throws -> (ControlSessionView, ControlEventView) {
        var session = try requireSession(params?.id)
        let name = try ControlValidation.validateEventName(params?.event)
        let source = try ControlValidation.validateSource(params?.source)
        let payload = try params?.payloadJson.map(ControlJSONValue.parse)

        session.appendEvent(
            kind: .event,
            name: name,
            source: source,
            payload: payload,
            createdAt: now(),
            pid: host.surface(for: session.surfaceID)?.pid)
        sessions[session.id] = session
        // `appendEvent` always appends, so `last` is the entry we just recorded.
        let recorded = eventView(session.events[session.events.count - 1], sessionID: session.id)
        return (view(of: session, host: host), recorded)
    }

    /// Set a single caller-owned metadata key (the auditable, one-key form of
    /// `update`).
    private func setMetadata(
        _ params: ControlRequest.Params?,
        host: ControlSessionHost
    ) throws -> ControlSessionView {
        var session = try requireSession(params?.id)
        guard let key = params?.key, !key.isEmpty else {
            throw ControlError(.invalidRequest, "set-metadata requires 'key'")
        }
        let source = try ControlValidation.validateSource(params?.source)

        var merged = session.metadata
        merged[key] = params?.value ?? ""
        session.metadata = try ControlValidation.validateMetadata(merged)
        session.appendEvent(
            kind: .metadata,
            name: key,
            source: source,
            createdAt: now(),
            pid: host.surface(for: session.surfaceID)?.pid)
        sessions[session.id] = session
        return view(of: session, host: host)
    }

    // MARK: - Agent-declared workflow state (MAX-3)

    /// Declare a validated, human-facing workflow state (`set-state`). Records
    /// the state with its timestamp and source, appends an audit entry, pushes
    /// the declaration to the UI, and logs the declaration event. An unknown
    /// state is rejected by validation before any field is touched, so the
    /// current declared state survives a bad request.
    private func setState(
        _ params: ControlRequest.Params?,
        host: ControlSessionHost
    ) throws -> ControlSessionView {
        var session = try requireSession(params?.id)
        let state = try ControlValidation.validateWorkflowState(params?.state)
        let source = try ControlValidation.validateSource(params?.source)
        let at = now()

        session.workflowState = state
        session.workflowStateAt = at
        session.workflowStateSource = source
        session.appendEvent(
            kind: .workflowState,
            name: state.rawValue,
            source: source,
            createdAt: at,
            pid: host.surface(for: session.surfaceID)?.pid)
        sessions[session.id] = session
        pushDeclaration(session, host: host)
        Self.logger.info(
            "declared state \(state.rawValue, privacy: .public) for session \(session.id.uuidString, privacy: .public) from \(source, privacy: .public)")
        return view(of: session, host: host)
    }

    /// Set the human-readable summary line (`set-summary`), independently of
    /// `set-state` so an agent can update the displayed text without changing
    /// status. Records the summary with its timestamp and source, appends an
    /// audit entry, pushes the declaration to the UI, and logs the event.
    private func setSummary(
        _ params: ControlRequest.Params?,
        host: ControlSessionHost
    ) throws -> ControlSessionView {
        var session = try requireSession(params?.id)
        let summary = try ControlValidation.validateSummary(params?.summary)
        let source = try ControlValidation.validateSource(params?.source)
        let at = now()

        session.summary = summary
        session.summaryAt = at
        session.summarySource = source
        session.appendEvent(
            kind: .summary,
            name: "summary",
            source: source,
            message: summary,
            createdAt: at,
            pid: host.surface(for: session.surfaceID)?.pid)
        sessions[session.id] = session
        pushDeclaration(session, host: host)
        Self.logger.info(
            "declared summary for session \(session.id.uuidString, privacy: .public) from \(source, privacy: .public)")
        return view(of: session, host: host)
    }

    /// Push the session's current declared workflow state + summary to its live
    /// surface so the UI badge reflects it. A no-op if the surface is gone. This
    /// is the only path from a declaration to the UI; it carries explicit
    /// declared values only — never anything Maxx inferred.
    private func pushDeclaration(_ session: ControlSession, host: ControlSessionHost) {
        guard let declared = session.declaredStateForDisplay else { return }
        host.surface(for: session.surfaceID)?.applyDeclaredState(declared)
    }

    // MARK: - Lifecycle control

    /// Archive a session: close its surface but keep the record (and its full
    /// audit log) for later inspection. Idempotent.
    private func archive(
        _ params: ControlRequest.Params?,
        host: ControlSessionHost
    ) throws -> ControlSessionView {
        var session = try requireSession(params?.id)
        let reason = try ControlValidation.validateReason(params?.reason)

        if !session.archived {
            if !session.canceled, let handle = host.surface(for: session.surfaceID) {
                handle.close()
            }
            let date = now()
            session.archived = true
            session.archivedAt = date
            session.archiveReason = reason
            session.appendEvent(
                kind: .lifecycle,
                name: "archived",
                source: ControlSession.maxxSource,
                message: reason,
                createdAt: date,
                pid: nil)
        }
        sessions[session.id] = session
        return view(of: session, host: host)
    }

    /// Restart a session's command in a fresh surface, keeping the stable session
    /// id. Restart is well-defined only when Maxx has a recorded command or the
    /// caller supplies one; otherwise it is an explicit `unsupported` error.
    private func restart(
        _ params: ControlRequest.Params?,
        host: ControlSessionHost
    ) throws -> ControlSessionView {
        var session = try requireSession(params?.id)
        // A caller-supplied command takes precedence for this restart only; the
        // session's recorded command remains the default for future restarts.
        let override = try ControlValidation.validateCommand(params?.command)
        guard let command = override ?? session.command, !command.isEmpty else {
            throw ControlError(
                .unsupported,
                "session has no restartable command; pass a command to restart it")
        }

        if !session.canceled, !session.archived, let handle = host.surface(for: session.surfaceID) {
            handle.close()
        }

        let newSurface = try host.createTerminal(.init(
            title: session.title,
            command: command,
            cwd: session.cwd,
            env: session.env,
            location: session.location))

        session.surfaceID = newSurface
        session.canceled = false
        session.archived = false
        session.archivedAt = nil
        session.archiveReason = nil
        session.restartCount += 1
        session.appendEvent(
            kind: .lifecycle,
            name: "restarted",
            source: ControlSession.maxxSource,
            message: override != nil ? "command override" : nil,
            createdAt: now(),
            pid: host.surface(for: newSurface)?.pid)
        sessions[session.id] = session
        return view(of: session, host: host)
    }

    /// Return a session's audit log, optionally only entries after `since`.
    private func events(
        _ params: ControlRequest.Params?,
        host: ControlSessionHost
    ) throws -> [ControlEventView] {
        let session = try requireSession(params?.id)
        let since = params?.since
        return session.events
            .filter { since == nil || $0.seq > since! }
            .map { eventView($0, sessionID: session.id) }
    }

    // MARK: - Wait / Watch (driven by the streaming server path)

    enum WaitCondition {
        case state(String)
        case event(String)
        case lifecycle(ControlLifecycle)
    }

    struct WaitPlan {
        let sessionID: UUID
        let condition: WaitCondition
        /// `wait --event` matches only entries with `seq` greater than this.
        let baselineSeq: Int
    }

    enum WaitProgress {
        case matched(ControlSessionView, ControlEventView?)
        case ended(ControlSessionView)
        case pending(ControlSessionView)
    }

    /// Validate a `wait` request and capture its baseline. Throws `not_found`
    /// (missing target) / `invalid_request` exactly like the single-shot handlers.
    func beginWait(_ params: ControlRequest.Params?) throws -> WaitPlan {
        let session = try requireSession(params?.id)
        let chosen = [params?.state, params?.event, params?.lifecycle].filter { $0 != nil }
        guard chosen.count == 1 else {
            throw ControlError(
                .invalidRequest,
                "wait requires exactly one of --state, --event, or --lifecycle")
        }

        let condition: WaitCondition
        if params?.state != nil {
            condition = .state(try ControlValidation.validateState(params?.state))
        } else if params?.event != nil {
            condition = .event(try ControlValidation.validateEventName(params?.event))
        } else {
            guard let raw = params?.lifecycle, let parsed = ControlLifecycle(rawValue: raw) else {
                throw ControlError(
                    .invalidRequest,
                    "lifecycle must be one of running, exited, closed, archived")
            }
            condition = .lifecycle(parsed)
        }

        // Default baseline = the current last sequence, so only events that
        // arrive after the wait begins count. `--since` lets callers close the
        // race by passing a sequence they already observed.
        let baseline = params?.since ?? (session.lastSeq ?? -1)
        return WaitPlan(sessionID: session.id, condition: condition, baselineSeq: baseline)
    }

    /// Evaluate a wait once. Returns nil only if the session vanished (it never
    /// does today; defensive). The server polls this until it resolves or times
    /// out.
    func pollWait(_ plan: WaitPlan, host: ControlSessionHost) -> WaitProgress? {
        guard let session = sessions[plan.sessionID] else { return nil }
        let snapshot = view(of: session, host: host)
        let current = lifecycle(of: session, host: host)

        switch plan.condition {
        case let .state(target):
            if session.status == target {
                let stateEvent = session.events.last { $0.kind == .state && $0.name == target }
                return .matched(snapshot, stateEvent.map { eventView($0, sessionID: session.id) })
            }
            // A state can only be (re)declared by a live process. Once the
            // process exits (or the surface is gone) the wait can never match,
            // so end it rather than block until timeout.
            return current == .running ? .pending(snapshot) : .ended(snapshot)

        case let .lifecycle(target):
            if current == target { return .matched(snapshot, nil) }
            // A lifecycle wait ends only at a *terminal* lifecycle other than the
            // target; `exited` is a legitimate value to wait for, or to pass
            // through toward `closed`, so it is not itself an end here.
            return current.isTerminal ? .ended(snapshot) : .pending(snapshot)

        case let .event(name):
            if let match = session.events.first(where: {
                $0.kind == .event && $0.name == name && $0.seq > plan.baselineSeq
            }) {
                return .matched(snapshot, eventView(match, sessionID: session.id))
            }
            // Likewise, no further events can arrive once the process is gone.
            return current == .running ? .pending(snapshot) : .ended(snapshot)
        }
    }

    struct WatchPlan {
        let sessionID: UUID
        var lastSeq: Int
        var lastLifecycle: String
    }

    struct WatchUpdate {
        var messages: [ControlStreamMessage]
        var plan: WatchPlan
        var ended: Bool
    }

    /// Validate a `watch` request and produce the initial snapshot message.
    func beginWatch(_ params: ControlRequest.Params?, host: ControlSessionHost) throws
        -> (WatchPlan, ControlStreamMessage) {
        let session = try requireSession(params?.id)
        let current = lifecycle(of: session, host: host)
        // `--since` replays entries after that sequence; default streams only new
        // ones. The snapshot always carries the current state regardless.
        let lastSeq = params?.since ?? (session.lastSeq ?? -1)
        let plan = WatchPlan(
            sessionID: session.id, lastSeq: lastSeq, lastLifecycle: current.rawValue)
        let snapshot = ControlStreamMessage(
            type: "snapshot",
            session: view(of: session, host: host),
            lifecycle: current.rawValue)
        return (plan, snapshot)
    }

    /// Produce the watch messages accumulated since the last poll plus the
    /// updated plan. `ended` is true once the session reaches a terminal state.
    func pollWatch(_ plan: WatchPlan, host: ControlSessionHost) -> WatchUpdate {
        guard let session = sessions[plan.sessionID] else {
            return WatchUpdate(messages: [], plan: plan, ended: true)
        }
        var messages: [ControlStreamMessage] = []
        var next = plan

        for event in session.events where event.seq > next.lastSeq {
            messages.append(ControlStreamMessage(
                type: "event", event: eventView(event, sessionID: session.id)))
            next.lastSeq = event.seq
        }

        let current = lifecycle(of: session, host: host)
        if current.rawValue != next.lastLifecycle {
            messages.append(ControlStreamMessage(
                type: "lifecycle",
                session: view(of: session, host: host),
                lifecycle: current.rawValue))
            next.lastLifecycle = current.rawValue
        }

        // A watch ends once the foreground process is no longer running —
        // including a plain `exited` — so a supervisor watching a command that
        // finishes without declaring anything is not left streaming forever.
        return WatchUpdate(messages: messages, plan: next, ended: current != .running)
    }

    // MARK: - Helpers

    private func validateMessage(_ message: String?) throws -> String? {
        guard let message else { return nil }
        guard message.count <= ControlSession.Limits.maxReasonLength else {
            throw ControlError(
                .invalidRequest,
                "message exceeds \(ControlSession.Limits.maxReasonLength) characters")
        }
        return message
    }

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

    /// Compute the Maxx-owned lifecycle from explicit state only: the archive/
    /// cancel flags, surface existence, and kernel-reported process liveness.
    /// Never consults terminal output.
    private func lifecycle(of session: ControlSession, host: ControlSessionHost) -> ControlLifecycle {
        if session.archived { return .archived }
        if session.canceled { return .closed }
        guard let handle = host.surface(for: session.surfaceID) else { return .closed }
        return handle.isProcessAlive ? .running : .exited
    }

    /// Build the wire view of a session.
    private func view(of session: ControlSession, host: ControlSessionHost) -> ControlSessionView {
        let lifecycle = lifecycle(of: session, host: host)
        // Expose the pid whenever a surface still exists (running or exited), to
        // match the MAX-1 behavior; a closed/archived session has none.
        let pid: Int? = lifecycle.isTerminal ? nil : host.surface(for: session.surfaceID)?.pid

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
            pid: pid,
            archivedAt: session.archivedAt.map(Self.iso8601.string(from:)),
            archiveReason: session.archiveReason,
            restartCount: session.restartCount > 0 ? session.restartCount : nil,
            lastEventSeq: session.lastSeq,
            workflowState: session.workflowState?.rawValue,
            workflowStateAt: session.workflowStateAt.map(Self.iso8601.string(from:)),
            workflowStateSource: session.workflowStateSource,
            summary: session.summary,
            summaryAt: session.summaryAt.map(Self.iso8601.string(from:)),
            summarySource: session.summarySource)
    }

    /// Build the wire view of an audit-log entry.
    private func eventView(_ event: ControlEvent, sessionID: UUID) -> ControlEventView {
        ControlEventView(
            seq: event.seq,
            kind: event.kind.rawValue,
            name: event.name,
            source: event.source,
            message: event.message,
            payload: event.payload,
            createdAt: Self.iso8601.string(from: event.createdAt),
            sessionID: sessionID.uuidString,
            surfaceID: event.surfaceID.uuidString,
            pid: event.pid)
    }
}
