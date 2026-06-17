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

/// Explicit facts captured from an in-process spawn path that already created
/// a visible terminal surface and now needs a durable control session record.
struct ControlSpawnedSurfaceRegistration {
    var surfaceID: UUID
    var title: String?
    var command: String?
    var cwd: String?
    var env: [String: String]
    var location: ControlLocation
}

enum ControlLocation: String, Codable {
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

    /// Returns a handle only when the supplied per-surface registration token
    /// proves the caller is running inside that live surface.
    ///
    /// Used by `sessions.register-current`. A nil result deliberately collapses
    /// "surface missing" and "bad token" so the registry can reject arbitrary
    /// surface-id adoption without turning the endpoint into a surface-existence
    /// oracle.
    func surfaceForRegistration(surfaceID: UUID, token: String) -> ControlSurfaceHandle?
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
    /// Paste text, then synthesize an Enter key press/release. This is distinct
    /// from `sendInput`, which is paste-only.
    func submitInput(_ text: String)
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
    /// Push the session's agent-reported metadata (MAX-4) to the surface so the
    /// UI can display it. Called only in response to an explicit metadata request
    /// (`create`/`update`/`set-metadata`/`remove-metadata`/`clear-metadata`) —
    /// never inferred from terminal output.
    func applyMetadata(_ metadata: [String: ControlJSONValue])
    /// Push the session's explicit parent/group relationship (MAX-6) to the
    /// surface so the tab UI can show grouping. Called only in response to an
    /// explicit `create`/`set-group`/`set-parent` (or a `restart` re-push) —
    /// never inferred from terminal output, process names, paths, or idle time.
    func applyRelationship(_ relationship: ControlRelationship)
}

/// The in-memory registry of control sessions plus the request dispatcher.
///
/// Authorization model: the registry only ever exposes or mutates sessions it
/// owns: sessions it created, plus the caller's current live tab after explicit
/// self-registration. Other manually-opened terminals are never enumerated or
/// controllable through this API, so a caller cannot reach an arbitrary surface
/// even with a valid token.
@MainActor
final class ControlSessionRegistry {
    private var sessions: [UUID: ControlSession] = [:]
    private let now: () -> Date
    private let makeID: () -> UUID

    // MARK: Persistence (MAX-5)

    /// Durable backing store, or nil for a purely in-memory registry. When set,
    /// the registry is rehydrated from it by its owner after the control directory
    /// is validated, and writes the full session set back on every mutation (and an
    /// explicit ``flush``). Injected so tests can point it at a temp file (or omit
    /// it entirely).
    private let store: ControlSessionStore?

    /// Whether writing to the store is permitted yet. The store lives in the
    /// world-writable control directory, which the owner (``ControlServer``) must
    /// validate before the registry touches it. Reads are gated by ``rehydrate``
    /// being the sole reader; writes are gated by this flag, set when ``rehydrate``
    /// runs (i.e. after `prepareDirectory()` secured the directory). Until then
    /// ``persist`` is a no-op, so a ``flush`` on a startup that never validated the
    /// directory cannot write a snapshot into — or clobber a registry in — an
    /// unvalidated directory.
    private var persistenceEnabled = false

    /// True once a write would clobber an existing registry file written by a
    /// newer build (an unsupported schema version). Set at rehydrate; while set,
    /// ``persist`` is a no-op so a downgrade run never destroys the newer file.
    private var persistenceSuspended = false

    // MARK: Structured event stream (MAX-7)

    /// Append-only, bounded global event bus: the cross-resource view of
    /// everything that happens to control sessions, carrying a process-wide
    /// monotonic cursor. Oldest entries are evicted once it exceeds
    /// ``maxBusEvents``; a `stream.watch --since` below the retained window is
    /// reported as a retention miss rather than silently skipped.
    private var bus: [ControlBusEvent] = []
    /// Next cursor to assign. Starts at 1 so cursor 0 / `--since 0` means
    /// "from the very beginning" and never collides with a real event.
    private var nextCursor: Int = 1
    /// Bounded retention for the in-memory bus. Generous enough that a normally
    /// attentive supervisor never misses events, small enough to cap memory.
    /// Injectable so retention-miss behavior is unit-testable with a small bound.
    private let maxBusEvents: Int

    // MARK: Capability policy (MAX-11)

    /// The capability policy enforced before every gated side effect (MAX-11).
    private let policy: ControlPolicy
    /// Confirmation grants recorded for `once_per_source` capabilities, keyed by
    /// `"<caller>\u{1}<capability>"`. Lasts for this app/control session, so a
    /// source confirms such a capability once rather than on every request.
    private var confirmationGrants: Set<String> = []

    /// Telemetry for declaration events only — the explicit `set-state` /
    /// `set-summary` calls Maxx receives, not any inferred interpretation.
    private static let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "com.scottmcpherson.maxx",
        category: "ControlSessionRegistry")

    /// Audit/debug log for policy decisions (allow/deny/confirm), separate from
    /// declaration telemetry so integrators can filter for authorization events.
    private static let policyLogger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "com.scottmcpherson.maxx",
        category: "ControlPolicy")

    private static let iso8601: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    init(
        now: @escaping () -> Date = Date.init,
        makeID: @escaping () -> UUID = UUID.init,
        maxBusEvents: Int = 10_000,
        policy: ControlPolicy = .default,
        store: ControlSessionStore? = nil
    ) {
        self.now = now
        self.makeID = makeID
        self.maxBusEvents = max(1, maxBusEvents)
        self.policy = policy
        self.store = store
        // NB: rehydration is intentionally NOT done here. The store reads a file
        // from the world-writable control directory (`/tmp/maxx-control-<uid>`),
        // which must be validated as ours and private before it is trusted. The
        // owner (``ControlServer``) calls ``rehydrate()`` only after
        // `prepareDirectory()` has secured that directory; rehydrating in this
        // initializer would decode an attacker-planted file first.
    }

    /// Load persisted records into the in-memory registry on launch (MAX-5).
    ///
    /// Must be called only after the control directory has been validated as ours
    /// and `0700` (``ControlServer`` does this in `prepareDirectory()` before
    /// invoking this), so a file planted by another local user in an insecure
    /// `/tmp` directory is never read or decoded. Tests that simulate a restart
    /// call this directly to stand in for that post-validation step.
    ///
    /// Restored records are marked so the UI can tell a record from a previous
    /// run apart from a live one, and their `lastObservedLifecycle` is baselined
    /// to the lifecycle they will compute with no live surface — `archived` for an
    /// archived record, otherwise `closed`. This matches `lifecycle(of:)` exactly,
    /// so the first reconcile after launch sees no transition and does NOT stamp a
    /// fresh `updatedAt` (which would otherwise refresh retention recency on every
    /// restart and keep archived records from ever aging out). No event bus entries
    /// are replayed — the cross-resource cursor is per-run by design. Nothing here
    /// infers anything: each field is the verbatim persisted value.
    func rehydrate() {
        guard let store else { return }
        // The owner validated the control directory before calling us, so the store
        // is now safe to write as well as read.
        persistenceEnabled = true
        let result = store.loadResult(now: now())
        // A newer build's file must not be overwritten by this (older) run.
        persistenceSuspended = result.preserveExistingFile
        for var session in result.sessions {
            session.restoredFromPreviousRun = true
            session.lastObservedLifecycle = session.archived
                ? ControlLifecycle.archived.rawValue
                : ControlLifecycle.closed.rawValue
            sessions[session.id] = session
        }
    }

    /// Persist the current session set, if a store is configured. Called from the
    /// single mutation choke point (``store(_:)``), on observed lifecycle
    /// transitions, and from ``flush``. A no-op without a store, before
    /// ``rehydrate`` has enabled persistence (the directory is not yet validated),
    /// or while persistence is suspended to preserve a newer build's registry file.
    private func persist() {
        guard persistenceEnabled, !persistenceSuspended else { return }
        store?.save(Array(sessions.values), now: now())
    }

    /// Commit a mutated session back to the in-memory map and persist it. The one
    /// choke point for record mutations: it stamps `updatedAt` (a real change
    /// just happened) and writes through to disk, so no handler has to remember
    /// to do either. Pass `touch: false` for a write that should not count as a
    /// content change (`create`, which keeps `updatedAt == createdAt`).
    ///
    /// `inout` so the caller's `session` carries the bumped `updatedAt` back out —
    /// the handler then returns a `view(of:)` that reflects the new timestamp
    /// rather than a stale one. Only call this when something actually changed; a
    /// no-op caller must skip it so a redundant request can't bump `updatedAt`,
    /// refresh retention recency, or rewrite the file.
    private func store(_ session: inout ControlSession, touch: Bool = true) {
        if touch { session.updatedAt = now() }
        sessions[session.id] = session
        persist()
    }

    /// Flush the current state to disk (e.g. on app termination), capturing the
    /// latest `lastSeenAt` values reconciliation has observed in memory. Safe to
    /// call repeatedly; a no-op without a store, and — crucially — a no-op until
    /// ``rehydrate`` has run. So a flush on app termination after a startup that
    /// failed to validate the control directory (``ControlServer/start`` swallows
    /// that failure, yet the app still retains the server) cannot write a snapshot
    /// into, or clobber a registry in, the directory startup refused.
    func flush() {
        persist()
    }

    /// Number of tracked sessions (including ended ones). Exposed for tests.
    var count: Int { sessions.count }

    // MARK: - Dispatch

    /// Handle one authorized request and produce a response. Token verification
    /// happens in the transport layer before this is called; capability policy is
    /// enforced here (``enforce``) before any side effect runs.
    func handle(_ request: ControlRequest, host: ControlSessionHost) -> ControlResponse {
        do {
            // Capability policy is the first gate: a denied caller never reaches
            // a handler, and a confirmation-required action returns before any
            // side effect. Metadata writes are gated by `metadata:set` (MAX-4);
            // the only ungated methods are `policy.check`, a no-op
            // `sessions.update`, and `sessions.action` with an unknown action
            // name (see ``ControlPolicyMapping``).
            try enforce(request.method, request.params)

            switch request.method {
            case .sessionsCreate:
                return .success(.init(session: try create(request.params, host: host)))
            case .sessionsRegisterCurrent:
                return .success(.init(session: try registerCurrent(request.params, host: host)))
            case .sessionsGet:
                return .success(.init(session: try get(request.params, host: host)))
            case .sessionsList:
                return .success(.init(sessions: try list(request.params, host: host)))
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
            case .sessionsRemoveMetadata:
                return .success(.init(session: try removeMetadata(request.params, host: host)))
            case .sessionsClearMetadata:
                return .success(.init(session: try clearMetadata(request.params, host: host)))
            case .sessionsSetState:
                return .success(.init(session: try setState(request.params, host: host)))
            case .sessionsSetSummary:
                return .success(.init(session: try setSummary(request.params, host: host)))
            case .sessionsSetAgentType:
                return .success(.init(session: try setAgentType(request.params, host: host)))
            case .sessionsSetParent:
                return .success(.init(session: try setParent(request.params, host: host)))
            case .sessionsEvents:
                return .success(.init(events: try events(request.params, host: host)))
            case .sessionsSetGroup:
                return .success(.init(session: try setGroup(request.params, host: host)))
            case .policyCheck:
                return .success(.init(policy: try policyCheck(request.params)))
            case .policySources:
                return .success(.init(policySources: policy.sourceViews))
            case .sessionsWait, .sessionsWatch, .streamWatch, .streamWait:
                // wait/watch (and the stream variants) are long-lived and handled
                // by the streaming path in ControlServer; they never reach this
                // single-shot dispatcher.
                throw ControlError(
                    .invalidRequest, "wait/watch require a streaming connection")
            }
        } catch let error as ControlError {
            return .failure(error)
        } catch {
            return .failure(ControlError(.internalError, "\(error)"))
        }
    }

    // MARK: - Capability policy enforcement (MAX-11)

    /// Enforce the capability policy for a request before any side effect runs.
    /// Throws `unauthorized` on a deny and `confirmation_required` on a confirm
    /// that the caller has not acknowledged; returns normally when the action may
    /// proceed. Ungated methods (`policy.check`, a no-op `sessions.update`, and
    /// unknown `action` names) return without a decision so their existing
    /// handler/error semantics are preserved; metadata writes are *not* ungated —
    /// they require `metadata:set` (MAX-4).
    ///
    /// The decision depends only on the explicit caller, capability, and target —
    /// never on terminal output or any ambient signal — and every outcome is
    /// recorded to the policy audit log.
    func enforce(_ method: ControlMethod, _ params: ControlRequest.Params?) throws {
        guard let capability = ControlPolicyMapping.capability(for: method, params: params) else {
            return
        }
        let target = ControlPolicyMapping.target(for: method, params: params)
        try enforceCapability(
            capability, caller: params?.caller, confirm: params?.confirm, target: target)
    }

    /// Enforce a single capability for an explicit caller/target. Shared by the
    /// method-level ``enforce`` and by handlers that gate a *secondary*
    /// capability beyond their primary method capability — e.g. `create --group`
    /// also requires `groups:create`, and `set-group` requires it on its own.
    /// PURE w.r.t. terminal state: depends only on caller, capability, target.
    func enforceCapability(
        _ capability: ControlCapability,
        caller: String?,
        confirm: Bool?,
        target: ControlTarget
    ) throws {
        let source = policy.resolve(caller)

        // A previously granted `once_per_source` confirmation short-circuits to
        // allow without re-prompting. This is safe because a grant is recorded
        // only in the `.confirm` branch below — i.e. only for a capability the
        // evaluator already returned `.confirm` for — so it can never authorize a
        // capability the policy would deny.
        if case let .known(configured) = source,
           configured.confirmScope == .oncePerSource,
           confirmationGrants.contains(Self.grantKey(source.id, capability)) {
            logDecision("allow", source: source, capability: capability, target: target,
                        reason: "prior confirmation grant")
            return
        }

        let decision = policy.evaluate(source: source, capability: capability, target: target)
        switch decision {
        case .allow:
            logDecision("allow", source: source, capability: capability, target: target)

        case let .deny(reason):
            logDecision("deny", source: source, capability: capability, target: target,
                        reason: reason)
            throw ControlError(.unauthorized, reason)

        case let .confirm(prompt):
            if confirm == true {
                if case let .known(configured) = source, configured.confirmScope == .oncePerSource {
                    confirmationGrants.insert(Self.grantKey(source.id, capability))
                }
                logDecision("confirm-granted", source: source, capability: capability,
                            target: target, reason: "caller acknowledged")
            } else {
                logDecision("confirm-required", source: source, capability: capability,
                            target: target, reason: "confirmation required")
                throw ControlError(.confirmationRequired, prompt)
            }
        }
    }

    /// Evaluate the policy for an explicit (caller, capability, target) without
    /// performing any action — the `policy.check` diagnostic. Records the decision
    /// to the audit log but never mutates grants or sessions.
    private func policyCheck(_ params: ControlRequest.Params?) throws -> ControlPolicyDecisionView {
        guard let raw = params?.capability, !raw.isEmpty else {
            throw ControlError(.invalidRequest, "policy.check requires 'capability'")
        }
        guard let capability = ControlCapability(rawValue: raw) else {
            let valid = ControlCapability.allCases.map(\.rawValue).joined(separator: ", ")
            throw ControlError(.invalidRequest, "unknown capability '\(raw)' (valid: \(valid))")
        }
        let source = policy.resolve(params?.caller)
        let target: ControlTarget = (params?.id?.isEmpty == false)
            ? .session(params!.id!) : .none
        let decision = policy.evaluate(source: source, capability: capability, target: target)
        logDecision("check", source: source, capability: capability, target: target)

        switch decision {
        case .allow:
            return .init(
                decision: "allow", source: source.id, sourceKind: source.kind?.rawValue,
                capability: capability.rawValue, target: targetID(target))
        case let .deny(reason):
            return .init(
                decision: "deny", source: source.id, sourceKind: source.kind?.rawValue,
                capability: capability.rawValue, target: targetID(target), reason: reason)
        case let .confirm(prompt):
            return .init(
                decision: "confirm", source: source.id, sourceKind: source.kind?.rawValue,
                capability: capability.rawValue, target: targetID(target), prompt: prompt)
        }
    }

    private static func grantKey(_ source: String, _ capability: ControlCapability) -> String {
        "\(source)\u{1}\(capability.rawValue)"
    }

    /// A compact target identifier for the diagnostic view (the session id, or a
    /// short label). Distinct from `ControlTarget.description` (prose for prompts).
    private func targetID(_ target: ControlTarget) -> String? {
        switch target {
        case let .session(id): return id
        case let .newSurface(location): return location
        case .collection: return "*"
        case .none: return nil
        }
    }

    /// Log one policy decision with the source, capability, target, and reason.
    /// Never logs request params (which may carry commands/secrets).
    private func logDecision(
        _ outcome: String,
        source: ControlResolvedSource,
        capability: ControlCapability,
        target: ControlTarget,
        reason: String? = nil
    ) {
        let level: OSLogType = (outcome == "deny") ? .error
            : (outcome == "confirm-required" || outcome == "confirm-granted") ? .default
            : .info
        Self.policyLogger.log(
            level: level,
            "policy \(outcome, privacy: .public): source=\(source.id, privacy: .public) capability=\(capability.rawValue, privacy: .public) target=\(target.description, privacy: .public) reason=\(reason ?? "-", privacy: .public)")
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
        let group = try ControlValidation.validateGroup(params?.group)
        let agentType = try ControlValidation.validateAgentType(params?.agentType)
        // A create-time agent-type is the same explicit declared fact as the
        // standalone `set-agent-type`, and carries a source. Validate the source up
        // front (before spawning) so an invalid one can't leave a stray tab behind.
        let agentTypeSource = try agentType.map { _ in
            try ControlValidation.validateSource(params?.source)
        }
        // A parent association (MAX-5) is an explicit, caller-supplied edge to a
        // session this registry already knows. We never infer a parent from
        // naming, paths, or spawn order. Whether an edge is *requested* is read
        // from the raw params, not from a resolved id, so the capability check
        // below can run before any session lookup.
        let parentRequested = !(params?.parent ?? "").isEmpty
        // Spawning is gated by `tabs:spawn` in `handle`; assigning a group or a
        // parent on create additionally requires `groups:create` (both are
        // association edges between sessions), and declaring an agent type at
        // create requires `state:set` (the same gate as the standalone
        // `set-agent-type` verb — otherwise create would be a way to declare it
        // without the capability). Enforce these BEFORE resolving the parent id and
        // before the surface is spawned: a caller without `groups:create` must not
        // be able to tell an unknown parent id (`not_found`) from an existing one
        // (`unauthorized`) — that differential would be a session-existence oracle —
        // and a denied request must never leave a stray tab behind.
        if group != nil || parentRequested {
            try enforceCapability(
                .groupsCreate, caller: params?.caller, confirm: params?.confirm,
                target: ControlPolicyMapping.target(for: .sessionsCreate, params: params))
        }
        if agentType != nil {
            try enforceCapability(
                .stateSet, caller: params?.caller, confirm: params?.confirm,
                target: ControlPolicyMapping.target(for: .sessionsCreate, params: params))
        }
        // Authorized to create the association now; resolve the parent edge (which
        // may throw `not_found` / `invalid_request`) before spawning the surface.
        let parentID = try resolveParent(params?.parent)

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

        let createdAt = now()
        var session = ControlSession(
            id: makeID(),
            surfaceID: surfaceID,
            title: title,
            command: command,
            cwd: cwd,
            env: env,
            location: location,
            status: status,
            metadata: metadata,
            group: group,
            parentID: parentID,
            agentType: agentType,
            createdAt: createdAt,
            // At creation the record has just been written and just been seen.
            updatedAt: createdAt,
            lastSeenAt: createdAt,
            canceled: false)
        // Baseline the observed lifecycle so reconciliation later emits exactly
        // one `exited`/`closed` event on the kernel-reported transition.
        session.lastObservedLifecycle = ControlLifecycle.running.rawValue
        // `touch: false` keeps updatedAt == createdAt for a brand-new record.
        store(&session, touch: false)

        let pid = liveSurface(of: session, host: host)?.pid
        recordMechanical(
            session, name: "created", group: session.group,
            createdAt: session.createdAt, pid: pid)
        if let group {
            recordMechanical(
                session, name: "group.joined", message: group, group: group,
                createdAt: session.createdAt, pid: pid)
        }
        // A create-time parent edge (MAX-6) emits the same Maxx-owned `parent.set`
        // mechanical event as the post-create `set-parent`, so a supervisor
        // replaying `stream.watch --since 0` can reconstruct create-time parent
        // edges from events (the `created` event carries no parent id). Mirrors the
        // create-time `group.joined` above.
        if let parentID = session.parentID {
            recordMechanical(
                session, name: "parent.set", message: parentID.uuidString,
                group: session.group, createdAt: session.createdAt, pid: pid)
        }
        // A create-time agent-type declaration is an explicit declared fact,
        // identical to `set-agent-type`: record it in the audit log (events /
        // watch) with its source so supervisors see it and it persists, rather than
        // it being only an initialized field. `touch: false` keeps
        // `updatedAt == createdAt` for the brand-new record.
        if let agentType, let agentTypeSource {
            record(
                &session, kind: .metadata, name: "agent_type", source: agentTypeSource,
                message: agentType, createdAt: session.createdAt, pid: pid)
            store(&session, touch: false)
        }
        // Surface any metadata supplied at create time so the UI shows it from
        // the start (an explicit caller declaration, never inferred).
        if !metadata.isEmpty {
            pushMetadata(session, to: liveSurface(of: session, host: host))
        }
        // Likewise surface a create-time group/parent relationship (MAX-6) so a
        // tab created under a parent or in a group shows its grouping from the
        // start. A plain ungrouped tab has nothing to push, so its UI is unchanged.
        if !relationship(of: session).isEmpty {
            pushRelationship(session, to: liveSurface(of: session, host: host))
        }
        return view(of: session, host: host)
    }

    /// Register the caller's current, already-open tab as a control session.
    ///
    /// This is the only adoption path for manually opened tabs. It is scoped to
    /// the caller's own live surface by a per-surface registration token injected
    /// into that tab's environment; a caller that merely guesses another
    /// `surface_id` cannot satisfy the proof. Restored records from a previous app
    /// run are intentionally ignored for idempotence so this path never rebinds a
    /// persisted session to a coincidentally restored live surface by matching the
    /// old surface id.
    private func registerCurrent(
        _ params: ControlRequest.Params?,
        host: ControlSessionHost
    ) throws -> ControlSessionView {
        // Keep registration as a pure "bind my current tab" operation. Existing
        // post-registration verbs own declarations/relationships/metadata, so a
        // retry cannot accidentally mutate the session while trying to be
        // idempotent.
        if params?.id != nil
            || params?.title != nil
            || params?.cwd != nil
            || params?.command != nil
            || params?.env != nil
            || params?.metadata != nil
            || params?.status != nil
            || params?.location != nil
            || params?.parent != nil
            || params?.group != nil
            || params?.agentType != nil {
            throw ControlError(
                .invalidRequest,
                "register-current only accepts the current tab registration proof")
        }

        guard let rawSurfaceID = params?.surfaceID, !rawSurfaceID.isEmpty else {
            throw ControlError(.invalidRequest, "surface_id is required")
        }
        guard let surfaceID = UUID(uuidString: rawSurfaceID) else {
            throw ControlError(.invalidRequest, "surface_id is not a valid UUID")
        }
        guard let token = params?.registrationToken, !token.isEmpty else {
            throw ControlError(.invalidRequest, "registration_token is required")
        }
        guard let handle = host.surfaceForRegistration(surfaceID: surfaceID, token: token) else {
            // Collapse missing surface and bad token into one response so this
            // endpoint cannot be used to probe arbitrary manually opened tabs.
            throw ControlError(.unauthorized, "current tab registration proof failed")
        }

        if let existing = liveSession(for: surfaceID, host: host) {
            return view(of: existing, host: host)
        }

        let createdAt = now()
        let title = handle.title.isEmpty ? nil : handle.title
        var session = ControlSession(
            id: makeID(),
            surfaceID: surfaceID,
            title: title,
            command: nil,
            cwd: handle.workingDirectory,
            env: [:],
            location: .tab,
            status: "registered",
            metadata: [:],
            group: nil,
            parentID: nil,
            agentType: nil,
            createdAt: createdAt,
            updatedAt: createdAt,
            lastSeenAt: createdAt,
            canceled: false)
        session.lastObservedLifecycle = handle.isProcessAlive
            ? ControlLifecycle.running.rawValue
            : ControlLifecycle.exited.rawValue
        store(&session, touch: false)
        recordMechanical(
            session, name: "registered", group: nil, createdAt: createdAt, pid: handle.pid)
        return view(of: session, host: host)
    }

    /// Register a surface that Maxx just created through an in-process spawn
    /// path outside `sessions.create`, such as the AppleScript-backed
    /// `maxx-agent-hook new-tab` command.
    ///
    /// This is deliberately not a public Control API adoption endpoint: callers
    /// cannot name arbitrary surface ids over the socket. The app passes the
    /// UUID it just received from its own spawn path, then this method creates
    /// the durable control session record that external callers can use later.
    /// Restored records are ignored for idempotence so a previous-run record is
    /// never rebound to a live surface by a matching persisted surface id.
    func registerSpawnedSurface(
        _ registration: ControlSpawnedSurfaceRegistration,
        host: ControlSessionHost
    ) throws -> ControlSessionView {
        let title = try ControlValidation.validateTitle(registration.title)
        let command = try ControlValidation.validateCommand(registration.command)
        let cwd = try ControlValidation.validateCwd(registration.cwd)
        let env = try ControlValidation.validateEnv(registration.env)

        guard let handle = host.surface(for: registration.surfaceID) else {
            throw ControlError(.internalError, "spawned surface no longer exists")
        }

        if let existing = liveSession(for: registration.surfaceID, host: host) {
            return view(of: existing, host: host)
        }

        let createdAt = now()
        var session = ControlSession(
            id: makeID(),
            surfaceID: registration.surfaceID,
            title: title,
            command: command,
            cwd: cwd ?? handle.workingDirectory,
            env: env,
            location: registration.location,
            status: "created",
            metadata: [:],
            group: nil,
            parentID: nil,
            agentType: nil,
            createdAt: createdAt,
            updatedAt: createdAt,
            lastSeenAt: createdAt,
            canceled: false)
        session.lastObservedLifecycle = handle.isProcessAlive
            ? ControlLifecycle.running.rawValue
            : ControlLifecycle.exited.rawValue
        store(&session, touch: false)
        recordMechanical(
            session, name: "created", group: nil, createdAt: createdAt, pid: handle.pid)
        return view(of: session, host: host)
    }

    /// Return the durable session id for a registered, current-run surface if
    /// this registry owns one. Unlike live control actions, this lookup is used
    /// by the in-process spawn reply path and intentionally does not require the
    /// child process to still be alive by the time AppleScript reads the property.
    func sessionID(forRegisteredSurface surfaceID: UUID) -> String? {
        currentRunSession(for: surfaceID)?.id.uuidString
    }

    private func liveSession(
        for surfaceID: UUID,
        host: ControlSessionHost
    ) -> ControlSession? {
        sessions.values
            .filter({
                isCurrentRunSession($0, surfaceID: surfaceID)
                    && liveSurface(of: $0, host: host) != nil
            })
            .sorted(by: { $0.createdAt < $1.createdAt })
            .first
    }

    private func currentRunSession(for surfaceID: UUID) -> ControlSession? {
        sessions.values
            .filter({ isCurrentRunSession($0, surfaceID: surfaceID) })
            .sorted(by: { $0.createdAt < $1.createdAt })
            .first
    }

    private func isCurrentRunSession(
        _ session: ControlSession,
        surfaceID: UUID
    ) -> Bool {
        session.surfaceID == surfaceID
            && !session.restoredFromPreviousRun
            && !session.canceled
            && !session.archived
    }

    private func get(
        _ params: ControlRequest.Params?,
        host: ControlSessionHost
    ) throws -> ControlSessionView {
        // No reconcile here: `get` reports current state (view() computes the
        // lifecycle fresh), and a global reconcile pass on a single-resource read
        // would be wasted work. `list` and the stream polls own event recording.
        let session = try requireSession(params?.id)
        return view(of: session, host: host)
    }

    private func list(
        _ params: ControlRequest.Params?,
        host: ControlSessionHost
    ) throws -> [ControlSessionView] {
        reconcile(host: host)
        let metadataFilters = params?.metadataFilter ?? []
        // Group-aware query filters (MAX-6), composed (AND) with the metadata
        // filters and with each other. Both are explicit equality checks over the
        // stored relationship metadata — a `group` filter returns a group's
        // members; a `parent` filter returns a tab's children. Mechanical, never
        // inferred. A supervisor finds a tab's siblings by listing the children of
        // its parent (`parent_id` from `get`, then `list --parent <thatParent>`).
        //
        // The `parent` filter is parsed (shape only) but its id is deliberately
        // NOT required to name a known session: the `tabs:list` read capability
        // already enumerates every session, so an unknown/closed parent id is not
        // an existence oracle — it simply matches no children. This is also what
        // keeps a child of a *closed* parent listed by `list --parent <closed>`,
        // carrying its own lifecycle, so "active visible children" is a
        // client-side lifecycle filter over a mechanically-preserved edge.
        let groupFilter = try ControlValidation.validateGroup(params?.group)
        let parentFilter = try parseParentID(params?.parent)
        return sessions.values
            .filter { Self.matchesMetadataFilter($0.metadata, metadataFilters) }
            .filter { groupFilter == nil || $0.group == groupFilter }
            .filter { parentFilter == nil || $0.parentID == parentFilter }
            .sorted { $0.createdAt < $1.createdAt }
            .map { view(of: $0, host: host) }
    }

    /// Whether a session's metadata satisfies every supplied filter (AND). A
    /// filter with only a `key` requires that key to be present; a filter with a
    /// `value` additionally requires the value to match when compared as a string
    /// (``ControlJSONValue/displayString``). Comparison is a display affordance —
    /// Maxx never reinterprets the stored value.
    static func matchesMetadataFilter(
        _ metadata: [String: ControlJSONValue],
        _ filters: [ControlRequest.MetadataFilter]
    ) -> Bool {
        for filter in filters {
            guard let value = metadata[filter.key] else { return false }
            if let target = filter.value, value.displayString != target { return false }
        }
        return true
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

        var changed = false
        // Setting status to the value it already holds is a no-op: don't mark the
        // record changed (which would bump updated_at and refresh retention recency
        // for a closed/restored record). Validation still runs, rejecting a bad
        // status regardless.
        if let status = try ControlValidation.validateStatus(params?.status),
            status != session.status {
            session.status = status
            changed = true
        }

        var metadataChanged = false
        if let metadata = params?.metadata {
            // Merge (append) semantics: provided keys overwrite/add to existing
            // metadata. The combined map is re-validated against the limits.
            let validated = try ControlValidation.validateMetadata(metadata)
            // Validate the source up front — before the no-op check — so an invalid
            // source (empty/overlong) is rejected even when the merge changes
            // nothing, matching the other metadata mutators.
            let source = try ControlValidation.validateSource(params?.source)
            var merged = session.metadata
            merged.merge(validated) { _, new in new }
            let normalized = try ControlValidation.validateMetadata(merged)
            // Only a real change counts. An empty (`metadata: {}`) or value-identical
            // merge changes nothing, so it must not bump `updated_at`, rewrite the
            // registry, re-push the map, or emit audit events — that would refresh
            // retention recency for a closed/restored record and break the no-op
            // invariant. Treat it like an update carrying no metadata at all.
            if normalized != session.metadata {
                session.metadata = normalized
                metadataChanged = true
                changed = true

                // Audit each provided key the same way `set-metadata` does, so a
                // `watch`/`events` consumer observes update-driven metadata changes.
                // `update` is a documented metadata-merge path; it must not be a
                // silent, unobservable mutation.
                let at = now()
                let pid = liveSurface(of: session, host: host)?.pid
                for key in validated.keys.sorted() {
                    record(
                        &session,
                        kind: .metadata, name: key, source: source, createdAt: at, pid: pid)
                }
            }
        }

        // An update carrying neither status nor metadata is a no-op (and is
        // ungated by policy precisely because it changes nothing): don't bump
        // updatedAt, rewrite the registry, or re-push an unchanged map.
        if changed {
            store(&session)
        }
        if metadataChanged {
            pushMetadata(session, to: liveSurface(of: session, host: host))
        }
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
            let handle = try requireLiveSurface(session, host: host)
            handle.focus()
            recordMechanical(session, name: "focused", group: session.group, createdAt: now(), pid: handle.pid)
            return .success(.init(session: view(of: session, host: host), applied: "focus"))

        case "input":
            guard let input = params?.input else {
                throw ControlError(.invalidRequest, "input action requires 'input' text")
            }
            try requireLiveSurface(session, host: host).sendInput(input)
            return .success(.init(session: view(of: session, host: host), applied: "input"))

        case "submit":
            guard let input = params?.input else {
                throw ControlError(.invalidRequest, "submit action requires 'input' text")
            }
            try requireLiveSurface(session, host: host).submitInput(input)
            return .success(.init(session: view(of: session, host: host), applied: "submit"))

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
        record(
            &session,
            kind: .state,
            name: state,
            source: source,
            message: message,
            createdAt: now(),
            pid: liveSurface(of: session, host: host)?.pid)
        store(&session)
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

        record(
            &session,
            kind: .event,
            name: name,
            source: source,
            payload: payload,
            createdAt: now(),
            pid: liveSurface(of: session, host: host)?.pid)
        store(&session)
        // `record` always appends, so `last` is the entry we just recorded.
        let recorded = eventView(session.events[session.events.count - 1], sessionID: session.id)
        return (view(of: session, host: host), recorded)
    }

    /// Set (merge) a single agent-reported metadata key — the auditable, one-key
    /// form of `update`. The value is either a plain string (`value`) or, when
    /// `value_json` is supplied, an arbitrary parsed JSON value (so a single key
    /// can carry a nested object/array). Maxx stores it verbatim.
    private func setMetadata(
        _ params: ControlRequest.Params?,
        host: ControlSessionHost
    ) throws -> ControlSessionView {
        var session = try requireSession(params?.id)
        guard let key = params?.key, !key.isEmpty else {
            throw ControlError(.invalidRequest, "set-metadata requires 'key'")
        }
        let source = try ControlValidation.validateSource(params?.source)

        // `value_json` (structured) takes precedence over `value` (plain string);
        // with neither, the key is set to an empty string.
        let value: ControlJSONValue
        if let raw = params?.valueJson {
            value = try ControlJSONValue.parse(raw)
        } else {
            value = .string(params?.value ?? "")
        }

        var merged = session.metadata
        merged[key] = value
        let normalized = try ControlValidation.validateMetadata(merged)
        // Setting a key to the value it already holds changes nothing: don't bump
        // updatedAt, rewrite the registry, append an audit event, or re-push the
        // unchanged map (matches update / remove-metadata / clear-metadata).
        // Validation runs first so an invalid value is still rejected, not no-op'd.
        guard normalized != session.metadata else {
            return view(of: session, host: host)
        }
        session.metadata = normalized
        let handle = liveSurface(of: session, host: host)
        record(
            &session,
            kind: .metadata,
            name: key,
            source: source,
            createdAt: now(),
            pid: handle?.pid)
        store(&session)
        pushMetadata(session, to: handle)
        return view(of: session, host: host)
    }

    /// Remove one or more agent-reported metadata keys. Accepts a single `key`
    /// and/or a `keys` array; at least one key must be named. Keys that are not
    /// present are ignored (idempotent), but at least one named key is required
    /// so the call is never a silent no-op against a typo.
    private func removeMetadata(
        _ params: ControlRequest.Params?,
        host: ControlSessionHost
    ) throws -> ControlSessionView {
        var session = try requireSession(params?.id)
        let source = try ControlValidation.validateSource(params?.source)

        var targets: [String] = []
        if let key = params?.key, !key.isEmpty { targets.append(key) }
        if let keys = params?.keys { targets.append(contentsOf: keys.filter { !$0.isEmpty }) }
        guard !targets.isEmpty else {
            throw ControlError(.invalidRequest, "remove-metadata requires 'key' or 'keys'")
        }

        let handle = liveSurface(of: session, host: host)
        let at = now()
        var changed = false
        for key in targets where session.metadata[key] != nil {
            session.metadata[key] = nil
            record(
                &session,
                kind: .metadata,
                name: key,
                source: source,
                message: "removed",
                createdAt: at,
                pid: handle?.pid)
            changed = true
        }
        // A remove of only already-absent keys is an idempotent no-op: don't
        // store/persist or bump `updatedAt`, and don't re-push an unchanged map.
        if changed {
            store(&session)
            pushMetadata(session, to: handle)
        }
        return view(of: session, host: host)
    }

    /// Clear all agent-reported metadata for a session in one atomic step, so
    /// the UI/filtering never observes a partially-cleared map.
    private func clearMetadata(
        _ params: ControlRequest.Params?,
        host: ControlSessionHost
    ) throws -> ControlSessionView {
        var session = try requireSession(params?.id)
        let source = try ControlValidation.validateSource(params?.source)
        let handle = liveSurface(of: session, host: host)

        // Only record/store when there was something to clear, so a redundant
        // clear stays a true no-op: no audit entry, no `updatedAt` bump, no
        // retention-recency refresh, no file write, no surface re-push.
        if !session.metadata.isEmpty {
            session.metadata = [:]
            record(
                &session,
                kind: .metadata,
                name: "*",
                source: source,
                message: "cleared",
                createdAt: now(),
                pid: handle?.pid)
            store(&session)
            pushMetadata(session, to: handle)
        }
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
        // Resolve the surface once: used for the audit pid and the UI push.
        let handle = liveSurface(of: session, host: host)

        session.workflowState = state
        session.workflowStateAt = at
        session.workflowStateSource = source
        record(
            &session,
            kind: .workflowState,
            name: state.rawValue,
            source: source,
            createdAt: at,
            pid: handle?.pid)
        store(&session)
        pushDeclaration(session, to: handle)
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
        // Resolve the surface once: used for the audit pid and the UI push.
        let handle = liveSurface(of: session, host: host)

        session.summary = summary
        session.summaryAt = at
        session.summarySource = source
        record(
            &session,
            kind: .summary,
            name: "summary",
            source: source,
            message: summary,
            createdAt: at,
            pid: handle?.pid)
        store(&session)
        pushDeclaration(session, to: handle)
        Self.logger.info(
            "declared summary for session \(session.id.uuidString, privacy: .public) from \(source, privacy: .public)")
        return view(of: session, host: host)
    }

    /// Declare the session's agent type (`set-agent-type`, MAX-5), e.g.
    /// `claude-code`. An explicit agent self-declaration recorded with its source
    /// and timestamp and persisted, so a restored session keeps its declared
    /// type. Maxx never derives the type from the command, process name, branch,
    /// path, or title — an undeclared session has no agent type rather than a
    /// guessed one. An invalid value is rejected before any field is touched.
    private func setAgentType(
        _ params: ControlRequest.Params?,
        host: ControlSessionHost
    ) throws -> ControlSessionView {
        var session = try requireSession(params?.id)
        guard let raw = params?.agentType, !raw.isEmpty else {
            throw ControlError(.invalidRequest, "set-agent-type requires 'agent_type'")
        }
        let agentType = try ControlValidation.validateAgentType(raw)
        let source = try ControlValidation.validateSource(params?.source)
        let at = now()
        let pid = liveSurface(of: session, host: host)?.pid

        session.agentType = agentType
        record(
            &session,
            kind: .metadata,
            name: "agent_type",
            source: source,
            message: agentType,
            createdAt: at,
            pid: pid)
        store(&session)
        return view(of: session, host: host)
    }

    // MARK: - Parent-child tab groups (MAX-6)

    /// Set or clear a session's parent edge after creation (`set-parent`), the
    /// update counterpart to `create --parent`. Records the Maxx-owned
    /// `parent.set`/`parent.cleared` mechanical events (mirroring
    /// `group.joined`/`group.left`) and re-pushes the relationship to the live
    /// surface so the tab UI reflects it.
    ///
    /// The edge is explicit caller-supplied metadata, never inferred. Validation
    /// keeps the graph sound: an empty/absent `parent` clears the edge; otherwise
    /// the parent must be a valid UUID (`invalid_request`) naming a known session
    /// (`not_found`), must not be the session itself (`invalid_request`), and must
    /// not introduce a cycle (`invalid_request`). Setting the parent to the value
    /// it already holds is an idempotent no-op: nothing is recorded, `updated_at`
    /// is not bumped, and a closed/restored record's retention recency is not
    /// refreshed (matching `set-group` / the metadata mutators).
    private func setParent(
        _ params: ControlRequest.Params?,
        host: ControlSessionHost
    ) throws -> ControlSessionView {
        var session = try requireSession(params?.id)
        // Parse the requested edge (shape only) and compare BEFORE validating, so
        // re-setting the parent a session already has is a true no-op: it must not
        // bump `updated_at`, refresh a closed/restored record's retention recency,
        // emit an event, or re-run existence/cycle validation (which — on a
        // corrupt/restored graph that already contains a cycle — would wrongly
        // reject a harmless redundant call). Matches `set-group`, which compares
        // the new value first and only does work on a real change.
        let candidate = try parseParentID(params?.parent)
        guard session.parentID != candidate else { return view(of: session, host: host) }
        // The edge is actually changing: fully validate the new parent before
        // applying it (existence / self / cycle).
        if let candidate {
            try validateParentEdge(candidate, for: session.id)
        }

        let at = now()
        let pid = liveSurface(of: session, host: host)?.pid
        let old = session.parentID
        session.parentID = candidate
        store(&session)
        // A single-valued edge: `parent.set` (with the new parent id) fully
        // describes a set OR a re-parent; `parent.cleared` is recorded only when
        // the edge is actually removed (it would be false to claim "cleared" on a
        // P1→P2 change, where the new state still has a parent).
        if let candidate {
            recordMechanical(
                session, name: "parent.set", message: candidate.uuidString,
                group: session.group, createdAt: at, pid: pid)
        } else if old != nil {
            recordMechanical(
                session, name: "parent.cleared", group: session.group, createdAt: at, pid: pid)
        }
        pushRelationship(session, to: liveSurface(of: session, host: host))
        return view(of: session, host: host)
    }

    /// Parse a `set-parent` / `list --parent` parent id, shape only: absent/empty
    /// → nil (clear, or "no filter"); a non-UUID value is `invalid_request`.
    /// Existence, self, and cycle are validated separately (``validateParentEdge``)
    /// and only when an edge actually changes, so a redundant re-set or a filter by
    /// an unknown id never triggers them.
    private func parseParentID(_ idString: String?) throws -> UUID? {
        guard let idString, !idString.isEmpty else { return nil }
        guard let id = UUID(uuidString: idString) else {
            throw ControlError(.invalidRequest, "parent is not a valid UUID")
        }
        return id
    }

    /// Validate a *new* parent edge for `childID`: the parent must name a known
    /// session (`not_found`), must not be the child itself, and must not introduce
    /// a cycle (all `invalid_request`). Only called when the edge actually changes,
    /// never on a no-op re-set.
    private func validateParentEdge(_ parentID: UUID, for childID: UUID) throws {
        guard sessions[parentID] != nil else {
            throw ControlError(.notFound, "no parent session with id \(parentID.uuidString)")
        }
        guard parentID != childID else {
            throw ControlError(.invalidRequest, "a session cannot be its own parent")
        }
        guard !wouldFormCycle(child: childID, proposedParent: parentID) else {
            throw ControlError(.invalidRequest, "parent edge would create a cycle")
        }
    }

    /// Whether making `childID` a child of `proposedParent` would form a cycle,
    /// i.e. `childID` already appears on `proposedParent`'s ancestry chain. Walks
    /// parent edges via the persisted `parentID` pointers only — a purely
    /// mechanical graph traversal, never output inference. The hop guard is
    /// defensive against a pre-existing cycle (which set-parent's validation
    /// prevents creating in the first place).
    private func wouldFormCycle(child childID: UUID, proposedParent: UUID) -> Bool {
        var cursor: UUID? = proposedParent
        var hops = 0
        while let id = cursor {
            if id == childID { return true }
            hops += 1
            if hops > sessions.count + 1 { return true }
            cursor = sessions[id]?.parentID
        }
        return false
    }

    /// A snapshot of the session's explicit parent/group relationship for the UI.
    private func relationship(of session: ControlSession) -> ControlRelationship {
        ControlRelationship(group: session.group, isChild: session.parentID != nil)
    }

    /// Push the session's current parent/group relationship to its live surface so
    /// the tab UI reflects it. A no-op if the surface is gone. Like
    /// ``pushMetadata`` this is the only path from a relationship declaration to
    /// the UI; it carries explicit, caller-set values only — never anything Maxx
    /// inferred. The full snapshot is sent every time so the badge swaps (or
    /// clears) atomically.
    private func pushRelationship(_ session: ControlSession, to handle: ControlSurfaceHandle?) {
        handle?.applyRelationship(relationship(of: session))
    }

    /// Push the session's current declared workflow state + summary to its live
    /// surface so the UI badge reflects it. A no-op if the surface is gone. This
    /// is the only path from a declaration to the UI; it carries explicit
    /// declared values only — never anything Maxx inferred.
    private func pushDeclaration(_ session: ControlSession, to handle: ControlSurfaceHandle?) {
        guard let declared = session.declaredStateForDisplay else { return }
        handle?.applyDeclaredState(declared)
    }

    /// Push the session's current agent-reported metadata to its live surface so
    /// the UI reflects it. A no-op if the surface is gone. Like ``pushDeclaration``
    /// this is the only path from a metadata declaration to the UI; it carries the
    /// explicit map verbatim — never anything Maxx inferred. The whole map is sent
    /// on every change so the UI swaps atomically rather than observing a
    /// partially-applied update.
    private func pushMetadata(_ session: ControlSession, to handle: ControlSurfaceHandle?) {
        handle?.applyMetadata(session.metadata)
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
            if !session.canceled, let handle = liveSurface(of: session, host: host) {
                handle.close()
            }
            let date = now()
            session.archived = true
            session.archivedAt = date
            session.archiveReason = reason
            session.lastObservedLifecycle = ControlLifecycle.archived.rawValue
            record(
                &session,
                kind: .lifecycle,
                name: "archived",
                source: ControlSession.maxxSource,
                message: reason,
                createdAt: date,
                pid: nil)
            store(&session)
        }
        // Re-archiving an already-archived session is an idempotent no-op: don't
        // store/bump updatedAt, which would refresh the retention recency of a
        // terminal record on every redundant archive from a cleanup loop.
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

        if !session.canceled, !session.archived, let handle = liveSurface(of: session, host: host) {
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
        // Restarting a record rehydrated from a previous run spawns a fresh,
        // live surface this run — it is no longer a restored-but-dead record,
        // and we just observed its new surface alive.
        session.restoredFromPreviousRun = false
        session.lastSeenAt = now()
        // A restart begins a fresh run, so the agent-declared workflow state and
        // summary from the previous run no longer apply — clear them rather than
        // leave a stale `complete`/`failed` badge on the newly-running surface.
        // (The fresh surface starts with no badge; the agent re-declares state
        // for the new run.) This is an explicit consequence of the restart
        // action, not inference. The free-form `status` is kept, as before.
        session.workflowState = nil
        session.workflowStateAt = nil
        session.workflowStateSource = nil
        session.summary = nil
        session.summaryAt = nil
        session.summarySource = nil
        // The fresh surface starts running; baseline observation accordingly so
        // reconciliation emits exactly one exit event for the new run.
        session.lastObservedLifecycle = ControlLifecycle.running.rawValue
        record(
            &session,
            kind: .lifecycle,
            name: "restarted",
            source: ControlSession.maxxSource,
            message: override != nil ? "command override" : nil,
            createdAt: now(),
            pid: host.surface(for: newSurface)?.pid)
        store(&session)
        // Metadata is scoped to the session record, so it survives the restart;
        // re-push it to the fresh surface so the chip persists (the new surface
        // starts with an empty map). The declared workflow-state badge, by
        // contrast, was cleared above because it is per-run.
        if !session.metadata.isEmpty {
            pushMetadata(session, to: host.surface(for: newSurface))
        }
        // The group/parent relationship (MAX-6) is likewise scoped to the record
        // and survives the restart; re-push it so the fresh surface shows the
        // grouping. (A plain ungrouped session has nothing to push.)
        if !relationship(of: session).isEmpty {
            pushRelationship(session, to: host.surface(for: newSurface))
        }
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
        // Observing a session is the `tabs:list` capability; enforce it before
        // the streaming server begins polling.
        try enforce(.sessionsWait, params)
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
        // Streaming a session's events is the `tabs:list` capability.
        try enforce(.sessionsWatch, params)
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

    // MARK: - Structured event stream (MAX-7)

    /// Assign the next global cursor.
    private func takeCursor() -> Int {
        let cursor = nextCursor
        nextCursor += 1
        return cursor
    }

    /// Append one entry to the bounded global bus, evicting the oldest entries
    /// once retention is exceeded.
    private func appendToBus(_ event: ControlBusEvent) {
        bus.append(event)
        if bus.count > maxBusEvents {
            bus.removeFirst(bus.count - maxBusEvents)
        }
    }

    /// Append a per-session audit entry *and* mirror it onto the global bus with
    /// a fresh cursor. Use for every agent-declared fact and the archive/restart
    /// lifecycle actions — preserving the MAX-2/3 per-session audit contract
    /// while making the same facts visible on the cross-resource stream.
    private func record(
        _ session: inout ControlSession,
        kind: ControlEventKind,
        name: String,
        source: String,
        message: String? = nil,
        payload: ControlJSONValue? = nil,
        createdAt: Date,
        pid: Int?
    ) {
        session.appendEvent(
            kind: kind, name: name, source: source,
            message: message, payload: payload, createdAt: createdAt, pid: pid)
        let entry = session.events[session.events.count - 1]
        appendToBus(ControlBusEvent(
            cursor: takeCursor(),
            kind: kind, name: name, source: source, sourceKind: kind.sourceKind,
            message: message, payload: payload, createdAt: createdAt,
            sessionID: session.id, surfaceID: session.surfaceID,
            group: session.group, pid: pid, seq: entry.seq))
    }

    /// Record a Maxx-owned mechanical event onto the global bus *only* (no
    /// per-session audit entry, so the MAX-2/3 per-session contract is
    /// unchanged). These are the create/focus/close/process-exit/group-membership
    /// facts the structured stream owns. Every one is derived from an explicit
    /// API action or a kernel-reported state change — never from terminal output.
    private func recordMechanical(
        _ session: ControlSession,
        name: String,
        message: String? = nil,
        group: String?,
        createdAt: Date,
        pid: Int?
    ) {
        appendToBus(ControlBusEvent(
            cursor: takeCursor(),
            kind: .lifecycle, name: name, source: ControlSession.maxxSource,
            sourceKind: .maxx, message: message, payload: nil, createdAt: createdAt,
            sessionID: session.id, surfaceID: session.surfaceID,
            // The caller names the group this event pertains to explicitly: the
            // session's current group for most events, or the affected group for
            // group.joined/group.left.
            group: group, pid: pid, seq: nil))
    }

    /// Observe kernel-reported lifecycle transitions and record the mechanical
    /// stream events (`exited`, `closed`) that have no explicit API call behind
    /// them, exactly once each. Idempotent and side-effect-free beyond appending
    /// those events, so it is safe to call on every read/poll. Never inspects
    /// terminal output: a transition is only ever the kernel-reported process
    /// exit or the surface ceasing to exist.
    private func reconcile(host: ControlSessionHost) {
        var transitioned = false
        for id in Array(sessions.keys) {
            guard var session = sessions[id] else { continue }
            let current = lifecycle(of: session, host: host).rawValue
            let last = session.lastObservedLifecycle ?? ControlLifecycle.running.rawValue
            var changed = false

            // Mechanical liveness observation (MAX-5): while the surface still
            // exists (running or exited), stamp that we just saw it. A pure
            // kernel/runtime fact used only for stale-record retention — never
            // output inference. Kept in memory each poll; only flushed to disk on
            // a real transition (below) so the 150ms reconcile poll doesn't churn.
            if current == ControlLifecycle.running.rawValue
                || current == ControlLifecycle.exited.rawValue {
                session.lastSeenAt = now()
                changed = true
            }

            if current != last {
                switch current {
                case ControlLifecycle.exited.rawValue:
                    recordMechanical(
                        session, name: "exited", group: session.group, createdAt: now(),
                        pid: liveSurface(of: session, host: host)?.pid)
                case ControlLifecycle.closed.rawValue:
                    // Surface vanished without an API cancel/archive (e.g. the user
                    // closed the tab). cancel()/archive()/restart() set
                    // lastObservedLifecycle themselves, so this fires only for the
                    // un-instrumented case.
                    recordMechanical(session, name: "closed", group: session.group, createdAt: now(), pid: nil)
                default:
                    break
                }
                session.lastObservedLifecycle = current
                session.updatedAt = now()
                transitioned = true
                changed = true
            }

            if changed { sessions[id] = session }
        }
        // Persist only when a lifecycle actually transitioned; pure lastSeenAt
        // bumps ride along on the next mutation or `flush()` to avoid writing the
        // file on every poll.
        if transitioned { persist() }
    }

    /// Set or clear a session's group membership, recording the Maxx-owned
    /// `group.left`/`group.joined` mechanical events. A no-op (same group)
    /// records nothing.
    private func setGroup(
        _ params: ControlRequest.Params?,
        host: ControlSessionHost
    ) throws -> ControlSessionView {
        var session = try requireSession(params?.id)
        let newGroup = try ControlValidation.validateGroup(params?.group)
        let old = session.group
        guard old != newGroup else { return view(of: session, host: host) }

        let at = now()
        let pid = liveSurface(of: session, host: host)?.pid
        session.group = newGroup
        store(&session)
        if let old {
            recordMechanical(session, name: "group.left", message: old, group: old, createdAt: at, pid: pid)
        }
        if let newGroup {
            recordMechanical(session, name: "group.joined", message: newGroup, group: newGroup, createdAt: at, pid: pid)
        }
        // Re-push the relationship (MAX-6) so the tab's group chip updates — or
        // clears, when the session just left its group.
        pushRelationship(session, to: liveSurface(of: session, host: host))
        return view(of: session, host: host)
    }

    /// A filter over the stream by session/tab/group. An unset field matches
    /// everything; set fields are ANDed together.
    struct StreamFilter {
        var sessionID: UUID?
        var surfaceID: UUID?
        var group: String?

        func matches(_ event: ControlBusEvent) -> Bool {
            if let sessionID, event.sessionID != sessionID { return false }
            if let surfaceID, event.surfaceID != surfaceID { return false }
            if let group, event.group != group { return false }
            return true
        }
    }

    /// Parse and validate the shared `--session`/`--tab`/`--group` filter.
    private func parseFilter(_ params: ControlRequest.Params?) throws -> StreamFilter {
        var filter = StreamFilter()
        if let raw = params?.id, !raw.isEmpty {
            guard let id = UUID(uuidString: raw) else {
                throw ControlError(.invalidRequest, "session id is not a valid UUID")
            }
            guard sessions[id] != nil else {
                throw ControlError(.notFound, "no session with id \(raw)")
            }
            filter.sessionID = id
        }
        if let raw = params?.tab, !raw.isEmpty {
            guard let id = UUID(uuidString: raw) else {
                throw ControlError(.invalidRequest, "tab id is not a valid UUID")
            }
            filter.surfaceID = id
        }
        if let group = try ControlValidation.validateGroup(params?.group) {
            filter.group = group
        }
        return filter
    }

    struct StreamWatchPlan {
        let filter: StreamFilter
        var lastCursor: Int
        /// When set, end the stream once this (single-session-filtered) session
        /// reaches a terminal lifecycle.
        let endSessionID: UUID?
    }

    /// Validate a `stream.watch`, run reconciliation, and produce the opening
    /// `hello` line plus any retained events to replay.
    func beginStreamWatch(
        _ params: ControlRequest.Params?,
        host: ControlSessionHost
    ) throws -> (StreamWatchPlan, [ControlStreamFeedMessage]) {
        // Observing the event stream is the `tabs:list` capability; enforce it
        // before the streaming server begins polling (mirrors begin{Wait,Watch}).
        try enforce(.streamWatch, params)
        reconcile(host: host)
        let filter = try parseFilter(params)
        let latest = nextCursor - 1
        var baseline = params?.since ?? latest

        var hello = ControlStreamFeedMessage(
            type: "hello", cursor: latest, schema: controlStreamSchemaVersion)
        if let since = params?.since {
            let firstRetained = bus.first?.cursor
            if since > latest {
                // A cursor beyond anything this run has assigned — typically a
                // resume with a cursor from a previous app run (the bus is
                // in-memory and the cursor resets on restart). Don't silently
                // gate past it forever: flag a reset and replay what we retain.
                hello.reset = true
                baseline = firstRetained.map { $0 - 1 } ?? latest
            } else if let firstRetained, since + 1 < firstRetained {
                // Retention miss: the requested cursor's successors were evicted.
                hello.reset = true
                hello.droppedThrough = firstRetained - 1
                baseline = since
            } else {
                baseline = since
            }
        }

        var messages: [ControlStreamFeedMessage] = [hello]
        for event in bus where event.cursor > baseline && filter.matches(event) {
            messages.append(ControlStreamFeedMessage(type: "event", event: streamEventView(event)))
        }

        let plan = StreamWatchPlan(
            filter: filter,
            lastCursor: max(latest, baseline),
            endSessionID: filter.sessionID)
        return (plan, messages)
    }

    struct StreamWatchUpdate {
        var messages: [ControlStreamFeedMessage]
        var plan: StreamWatchPlan
        var ended: Bool
    }

    /// Produce the stream messages accumulated since the last poll. Reconciles
    /// first so process-exit events are captured while watching.
    func pollStreamWatch(_ plan: StreamWatchPlan, host: ControlSessionHost) -> StreamWatchUpdate {
        reconcile(host: host)
        var next = plan
        var messages: [ControlStreamFeedMessage] = []

        // Mid-stream retention miss: events we had not yet emitted were evicted.
        if let firstRetained = bus.first?.cursor, firstRetained > next.lastCursor + 1 {
            messages.append(ControlStreamFeedMessage(
                type: "reset", reset: true, droppedThrough: firstRetained - 1))
            next.lastCursor = firstRetained - 1
        }

        for event in bus where event.cursor > next.lastCursor && plan.filter.matches(event) {
            messages.append(ControlStreamFeedMessage(type: "event", event: streamEventView(event)))
        }
        // Advance past everything scanned (including non-matching events) so we
        // never rescan the retained window.
        next.lastCursor = max(next.lastCursor, nextCursor - 1)

        var ended = false
        if let sid = plan.endSessionID, let session = sessions[sid] {
            ended = lifecycle(of: session, host: host).isTerminal
        }
        return StreamWatchUpdate(messages: messages, plan: next, ended: ended)
    }

    /// A group-wide condition for `stream.wait --group --all`.
    enum GroupCondition: Equatable {
        /// No member is actively declared `running` (idle = not busy). A member
        /// that declared any non-running workflow state, or never declared one,
        /// counts as idle; only an explicit `running` declaration is busy.
        case idle
        /// Every member's Maxx-owned lifecycle has left `running` (exited/closed/
        /// archived) — a purely mechanical condition.
        case exited
        /// Every member's declared workflow state equals this value.
        case declared(WorkflowState)
    }

    enum StreamWaitMode {
        case event(name: String, baselineCursor: Int)
        case groupAll(group: String, condition: GroupCondition)
    }

    struct StreamWaitPlan {
        let filter: StreamFilter
        let mode: StreamWaitMode
    }

    enum StreamWaitProgress {
        case matched(ControlStreamEventView?, [ControlSessionView]?)
        case ended
        case pending
    }

    /// Validate a `stream.wait` and capture its plan/baseline.
    func beginStreamWait(_ params: ControlRequest.Params?, host: ControlSessionHost) throws -> StreamWaitPlan {
        // Observing the event stream is the `tabs:list` capability; enforce it
        // before the streaming server begins polling (mirrors begin{Wait,Watch}).
        try enforce(.streamWait, params)
        reconcile(host: host)
        let filter = try parseFilter(params)

        if let allRaw = params?.all, !allRaw.isEmpty {
            guard params?.event == nil else {
                throw ControlError(.invalidRequest, "pass either --event or --all, not both")
            }
            guard let group = filter.group else {
                throw ControlError(.invalidRequest, "--all requires --group")
            }
            let condition = try parseGroupCondition(allRaw)
            guard !membersOfGroup(group).isEmpty else {
                throw ControlError(.invalidRequest, "no sessions in group '\(group)'")
            }
            return StreamWaitPlan(filter: filter, mode: .groupAll(group: group, condition: condition))
        }

        let name = try ControlValidation.validateEventName(params?.event)
        let baseline = params?.since ?? (nextCursor - 1)
        return StreamWaitPlan(filter: filter, mode: .event(name: name, baselineCursor: baseline))
    }

    /// Evaluate a `stream.wait` once. The server polls this until it resolves or
    /// times out. Reconciles first so process-exit/idle conditions are observed.
    func pollStreamWait(_ plan: StreamWaitPlan, host: ControlSessionHost) -> StreamWaitProgress {
        reconcile(host: host)
        switch plan.mode {
        case let .event(name, baseline):
            if let match = bus.first(where: {
                $0.cursor > baseline && $0.name == name && plan.filter.matches($0)
            }) {
                return .matched(streamEventView(match), nil)
            }
            // A single-session-filtered event wait can never match once that
            // session is terminal: end rather than block to the timeout.
            if let sid = plan.filter.sessionID, let session = sessions[sid],
               lifecycle(of: session, host: host).isTerminal {
                return .ended
            }
            return .pending

        case let .groupAll(group, condition):
            let members = membersOfGroup(group)
            // The group emptied out (all members left/closed). The condition is
            // no longer meaningful; keep waiting until it is satisfied or the
            // timeout fires rather than reporting a vacuous match.
            guard !members.isEmpty else { return .pending }
            let satisfied = members.allSatisfy { memberSatisfies($0, condition, host: host) }
            guard satisfied else { return .pending }
            let views = members
                .sorted { $0.createdAt < $1.createdAt }
                .map { view(of: $0, host: host) }
            return .matched(nil, views)
        }
    }

    private func parseGroupCondition(_ raw: String) throws -> GroupCondition {
        if raw == "idle" { return .idle }
        if raw == "exited" { return .exited }
        if raw.hasPrefix("declared:") {
            let name = String(raw.dropFirst("declared:".count))
            return .declared(try ControlValidation.validateWorkflowState(name))
        }
        throw ControlError(
            .invalidRequest,
            "--all must be one of idle, exited, or declared:<state>")
    }

    private func membersOfGroup(_ group: String) -> [ControlSession] {
        sessions.values.filter { $0.group == group }
    }

    private func memberSatisfies(
        _ session: ControlSession,
        _ condition: GroupCondition,
        host: ControlSessionHost
    ) -> Bool {
        switch condition {
        case .exited:
            return lifecycle(of: session, host: host) != .running
        case .idle:
            return session.workflowState != .running
        case let .declared(state):
            return session.workflowState == state
        }
    }

    /// Build the wire envelope of a bus event.
    private func streamEventView(_ event: ControlBusEvent) -> ControlStreamEventView {
        ControlStreamEventView(
            schema: controlStreamSchemaVersion,
            cursor: event.cursor,
            seq: event.seq,
            sourceKind: event.sourceKind.rawValue,
            kind: event.kind.rawValue,
            name: event.name,
            source: event.source,
            message: event.message,
            payload: event.payload,
            createdAt: Self.iso8601.string(from: event.createdAt),
            resourceKind: "session",
            sessionID: event.sessionID.uuidString,
            surfaceID: event.surfaceID.uuidString,
            group: event.group,
            pid: event.pid)
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

    /// Resolve an explicit parent session id supplied at create time (MAX-5).
    /// Absent/empty → no parent. A non-UUID string is `invalid_request`; a UUID
    /// that names no known session is `not_found`. The edge is always a
    /// caller-supplied id we can verify — never inferred from naming or order.
    /// (Self/cycle checks are not needed at create: the new session's id does not
    /// exist yet, so it can neither be its own parent nor be on any chain.)
    private func resolveParent(_ idString: String?) throws -> UUID? {
        guard let id = try parseParentID(idString) else { return nil }
        guard sessions[id] != nil else {
            throw ControlError(.notFound, "no parent session with id \(id.uuidString)")
        }
        return id
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
        guard let handle = liveSurface(of: session, host: host) else {
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
        let wasCanceled = session.canceled
        // A terminal mechanical event was already recorded if the session was
        // canceled/archived, or reconciliation already observed the surface
        // vanish. Keying off the observed lifecycle (not just `canceled`) is what
        // keeps `closed` exactly-once even when the user closes the tab first and
        // reconcile records it before an API cancel/close arrives.
        let alreadyTerminal = wasCanceled
            || session.archived
            || session.lastObservedLifecycle == ControlLifecycle.closed.rawValue
            || session.lastObservedLifecycle == ControlLifecycle.archived.rawValue
        if !wasCanceled, let handle = liveSurface(of: session, host: host) {
            handle.close()
        }
        session.canceled = true
        // Only the first transition into a terminal state mutates the record (the
        // one-shot `closed` event + lifecycle) and is worth persisting. Canceling a
        // session that is ALREADY terminal — already canceled, archived, or
        // observed closed — changes nothing observable (its lifecycle is unchanged),
        // so record nothing and skip store(): an idempotent cancel retry, including
        // one against an already-archived session, never bumps updatedAt or
        // refreshes the terminal record's retention recency.
        if !alreadyTerminal {
            session.lastObservedLifecycle = ControlLifecycle.closed.rawValue
            recordMechanical(session, name: "closed", group: session.group, createdAt: now(), pid: nil)
            store(&session)
        }
        return .success(.init(session: view(of: session, host: host), canceled: true))
    }

    /// The live surface backing a session *this run*, or nil.
    ///
    /// A record rehydrated from a previous run (`restoredFromPreviousRun`) is
    /// intentionally detached: its persisted `surfaceID` names a surface from the
    /// prior run, and with macOS window restoration a *different*, user-owned
    /// surface can be rebuilt this run reusing that same UUID. The control API only
    /// ever owns surfaces it created this run, so it must never adopt, observe,
    /// signal, or close such a coincidental match. A restored record therefore
    /// resolves no surface — its lifecycle stays `closed` and actions error as
    /// `already_ended` — until `restart` spawns a fresh surface this run (which
    /// clears the flag and rebinds `surfaceID`). This is the MAX-1 ownership
    /// boundary preserved across a restart, not output inference.
    private func liveSurface(
        of session: ControlSession,
        host: ControlSessionHost
    ) -> ControlSurfaceHandle? {
        guard !session.restoredFromPreviousRun else { return nil }
        return host.surface(for: session.surfaceID)
    }

    /// Compute the Maxx-owned lifecycle from explicit state only: the archive/
    /// cancel flags, surface existence, and kernel-reported process liveness.
    /// Never consults terminal output.
    private func lifecycle(of session: ControlSession, host: ControlSessionHost) -> ControlLifecycle {
        if session.archived { return .archived }
        if session.canceled { return .closed }
        guard let handle = liveSurface(of: session, host: host) else { return .closed }
        return handle.isProcessAlive ? .running : .exited
    }

    /// Build the wire view of a session.
    private func view(of session: ControlSession, host: ControlSessionHost) -> ControlSessionView {
        let lifecycle = lifecycle(of: session, host: host)
        // Expose the pid whenever a surface still exists (running or exited), to
        // match the MAX-1 behavior; a closed/archived session has none.
        let pid: Int? = lifecycle.isTerminal ? nil : liveSurface(of: session, host: host)?.pid

        return ControlSessionView(
            sessionID: session.id.uuidString,
            surfaceID: session.surfaceID.uuidString,
            parentID: session.parentID?.uuidString,
            title: session.title,
            command: session.command,
            cwd: session.cwd,
            status: session.status,
            lifecycle: lifecycle.rawValue,
            metadata: session.metadata,
            group: session.group,
            agentType: session.agentType,
            createdAt: Self.iso8601.string(from: session.createdAt),
            updatedAt: Self.iso8601.string(from: session.updatedAt),
            lastSeenAt: session.lastSeenAt.map(Self.iso8601.string(from:)),
            restored: session.restoredFromPreviousRun ? true : nil,
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
