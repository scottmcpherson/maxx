@testable import Ghostty
import Foundation
import Testing

/// In-memory ``ControlSessionHost`` for exercising the registry without a
/// running app. Records every operation so tests can assert on them.
///
/// Note the surface of this fake (and of ``ControlSurfaceHandle``) exposes no
/// way to read terminal output: lifecycle is driven only by the explicit
/// `alive`/`exists` flags a test sets. That is the no-inference guarantee
/// expressed as a type boundary.
@MainActor
final class FakeControlSessionHost: ControlSessionHost {
    final class Surface {
        var alive = true
        var exists = true
        var pid: Int? = 4242
        var focusCount = 0
        var interruptCount = 0
        /// Signals passed to `interrupt`; nil entries mean "Ctrl-C via tty".
        var interruptSignals: [Int32?] = []
        var inputs: [String] = []
        var closed = false
        /// The most recent declared state/summary pushed to this surface for
        /// display. Lets tests assert the registry → UI path without a real view.
        var declaredState: ControlDeclaredState?
    }

    var surfaces: [UUID: Surface] = [:]
    var createdRequests: [ControlCreateRequest] = []
    var nextCreateID: UUID?
    var createError: ControlError?

    func createTerminal(_ request: ControlCreateRequest) throws -> UUID {
        if let createError { throw createError }
        createdRequests.append(request)
        let id = nextCreateID ?? UUID()
        nextCreateID = nil
        surfaces[id] = Surface()
        return id
    }

    func surface(for surfaceID: UUID) -> ControlSurfaceHandle? {
        guard let surface = surfaces[surfaceID], surface.exists else { return nil }
        return FakeSurfaceHandle(id: surfaceID, surface: surface)
    }
}

@MainActor
final class FakeSurfaceHandle: ControlSurfaceHandle {
    let id: UUID
    let surface: FakeControlSessionHost.Surface

    init(id: UUID, surface: FakeControlSessionHost.Surface) {
        self.id = id
        self.surface = surface
    }

    var surfaceID: UUID { id }
    var title: String { "fake" }
    var workingDirectory: String? { nil }
    var pid: Int? { surface.pid }
    var isProcessAlive: Bool { surface.alive }
    func focus() { surface.focusCount += 1 }
    func sendInput(_ text: String) { surface.inputs.append(text) }
    @discardableResult
    func interrupt(signal: Int32?) -> Bool {
        surface.interruptCount += 1
        surface.interruptSignals.append(signal)
        // Mirror production: nothing to interrupt once the process has exited;
        // a named signal additionally needs a foreground pid.
        guard surface.alive else { return false }
        return signal == nil || surface.pid != nil
    }
    func close() {
        surface.exists = false
        surface.closed = true
    }
    func applyDeclaredState(_ declared: ControlDeclaredState) {
        surface.declaredState = declared
    }
}

@MainActor
struct ControlSessionRegistryTests {
    private func makeRegistry() -> ControlSessionRegistry {
        ControlSessionRegistry()
    }

    private func params(
        id: String? = nil,
        title: String? = nil,
        cwd: String? = nil,
        command: String? = nil,
        env: [String]? = nil,
        metadata: [String: String]? = nil,
        status: String? = nil,
        location: String? = nil,
        action: String? = nil,
        input: String? = nil
    ) -> ControlRequest.Params {
        .init(
            id: id, title: title, cwd: cwd, command: command, env: env,
            metadata: metadata, status: status, location: location,
            action: action, input: input)
    }

    private func request(
        _ method: ControlMethod,
        _ params: ControlRequest.Params = .init()
    ) -> ControlRequest {
        .init(token: "token", method: method, params: params)
    }

    // MARK: Create

    @Test func createReturnsStableIDDistinctFromSurface() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let surfaceID = UUID()
        host.nextCreateID = surfaceID

        let response = registry.handle(
            request(.sessionsCreate, params(title: "Run checks", command: "ls")),
            host: host)

        #expect(response.ok)
        let session = response.result?.session
        #expect(session?.surfaceID == surfaceID.uuidString)
        // The session id is stable and distinct from the surface id.
        #expect(session?.sessionID != surfaceID.uuidString)
        #expect(UUID(uuidString: session?.sessionID ?? "") != nil)
        #expect(session?.lifecycle == "running")
        #expect(session?.status == "created")
        #expect(session?.pid == 4242)
        #expect(host.createdRequests.first?.title == "Run checks")
        #expect(host.createdRequests.first?.command == "ls")
        #expect(host.createdRequests.first?.location == .tab)
    }

    @Test func createEchoesMetadataAndStatus() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()

        let response = registry.handle(
            request(.sessionsCreate, params(
                metadata: ["workflow": "release", "request_id": "abc"],
                status: "waiting_for_review")),
            host: host)

        let session = response.result?.session
        #expect(session?.status == "waiting_for_review")
        #expect(session?.metadata["workflow"] == "release")
        #expect(session?.metadata["request_id"] == "abc")
    }

    @Test func createRejectsRelativeCwd() {
        let response = makeRegistry().handle(
            request(.sessionsCreate, params(cwd: "relative/path")),
            host: FakeControlSessionHost())
        #expect(!response.ok)
        #expect(response.error?.code == "invalid_request")
    }

    @Test func createRejectsBadEnv() {
        let response = makeRegistry().handle(
            request(.sessionsCreate, params(env: ["NOEQUALS"])),
            host: FakeControlSessionHost())
        #expect(response.error?.code == "invalid_request")
    }

    @Test func createPropagatesHostError() {
        let host = FakeControlSessionHost()
        host.createError = ControlError(.invalidRequest, "working directory does not exist")
        let response = makeRegistry().handle(
            request(.sessionsCreate, params(cwd: "/nope")),
            host: host)
        #expect(response.error?.code == "invalid_request")
    }

    @Test func createLocationWindow() {
        let host = FakeControlSessionHost()
        let response = makeRegistry().handle(
            request(.sessionsCreate, params(location: "window")),
            host: host)
        #expect(response.ok)
        #expect(host.createdRequests.first?.location == .window)
    }

    @Test func createRejectsBadLocation() {
        let response = makeRegistry().handle(
            request(.sessionsCreate, params(location: "sideways")),
            host: FakeControlSessionHost())
        #expect(response.error?.code == "invalid_request")
    }

    // MARK: Metadata limits

    @Test func metadataTooManyKeysRejected() {
        var big: [String: String] = [:]
        for index in 0..<(ControlSession.Limits.maxMetadataKeys + 1) {
            big["k\(index)"] = "v"
        }
        let response = makeRegistry().handle(
            request(.sessionsCreate, params(metadata: big)),
            host: FakeControlSessionHost())
        #expect(response.error?.code == "invalid_request")
    }

    @Test func metadataInvalidKeyRejected() {
        let response = makeRegistry().handle(
            request(.sessionsCreate, params(metadata: ["bad key": "v"])),
            host: FakeControlSessionHost())
        #expect(response.error?.code == "invalid_request")
    }

    @Test func metadataValueTooLongRejected() {
        let long = String(repeating: "x", count: ControlSession.Limits.maxMetadataValueLength + 1)
        let response = makeRegistry().handle(
            request(.sessionsCreate, params(metadata: ["k": long])),
            host: FakeControlSessionHost())
        #expect(response.error?.code == "invalid_request")
    }

    // MARK: Get / List

    @Test func getUnknownReturnsNotFound() {
        let response = makeRegistry().handle(
            request(.sessionsGet, params(id: UUID().uuidString)),
            host: FakeControlSessionHost())
        #expect(response.error?.code == "not_found")
    }

    @Test func getInvalidUUIDReturnsInvalidRequest() {
        let response = makeRegistry().handle(
            request(.sessionsGet, params(id: "not-a-uuid")),
            host: FakeControlSessionHost())
        #expect(response.error?.code == "invalid_request")
    }

    @Test func listReturnsCreatedSessions() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        _ = registry.handle(request(.sessionsCreate), host: host)
        _ = registry.handle(request(.sessionsCreate), host: host)

        let response = registry.handle(request(.sessionsList), host: host)
        #expect(response.result?.sessions?.count == 2)
    }

    // MARK: Update

    @Test func updateMergesMetadataAndSetsStatus() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let created = registry.handle(request(.sessionsCreate, params(metadata: ["a": "1"])), host: host)
        let id = created.result?.session?.sessionID

        let updated = registry.handle(
            request(.sessionsUpdate, params(
                id: id, metadata: ["b": "2"], status: "waiting_for_review")),
            host: host)

        let session = updated.result?.session
        #expect(session?.status == "waiting_for_review")
        #expect(session?.metadata["a"] == "1")
        #expect(session?.metadata["b"] == "2")
    }

    @Test func updateRejectsServerOwnedFields() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let created = registry.handle(request(.sessionsCreate), host: host)
        let id = created.result?.session?.sessionID

        let response = registry.handle(
            request(.sessionsUpdate, params(id: id, command: "rm -rf /")),
            host: host)
        #expect(response.error?.code == "invalid_request")
    }

    @Test func updateUnknownReturnsNotFound() {
        let response = makeRegistry().handle(
            request(.sessionsUpdate, params(id: UUID().uuidString, status: "x")),
            host: FakeControlSessionHost())
        #expect(response.error?.code == "not_found")
    }

    // MARK: Actions

    @Test func focusActionInvokesHost() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let surfaceID = UUID()
        host.nextCreateID = surfaceID
        let created = registry.handle(request(.sessionsCreate), host: host)
        let id = created.result?.session?.sessionID

        let response = registry.handle(
            request(.sessionsAction, params(id: id, action: "focus")),
            host: host)
        #expect(response.ok)
        #expect(response.result?.applied == "focus")
        #expect(host.surfaces[surfaceID]?.focusCount == 1)
    }

    @Test func inputActionRequiresText() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let created = registry.handle(request(.sessionsCreate), host: host)
        let id = created.result?.session?.sessionID

        let response = registry.handle(
            request(.sessionsAction, params(id: id, action: "input")),
            host: host)
        #expect(response.error?.code == "invalid_request")
    }

    @Test func inputActionSendsText() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let surfaceID = UUID()
        host.nextCreateID = surfaceID
        let created = registry.handle(request(.sessionsCreate), host: host)
        let id = created.result?.session?.sessionID

        let response = registry.handle(
            request(.sessionsAction, params(id: id, action: "input", input: "echo hi\n")),
            host: host)
        #expect(response.ok)
        #expect(host.surfaces[surfaceID]?.inputs == ["echo hi\n"])
    }

    @Test func interruptActionInvokesHost() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let surfaceID = UUID()
        host.nextCreateID = surfaceID
        let created = registry.handle(request(.sessionsCreate), host: host)
        let id = created.result?.session?.sessionID

        _ = registry.handle(
            request(.sessionsAction, params(id: id, action: "interrupt")),
            host: host)
        #expect(host.surfaces[surfaceID]?.interruptCount == 1)
    }

    @Test func unknownActionRejected() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let created = registry.handle(request(.sessionsCreate), host: host)
        let id = created.result?.session?.sessionID

        let response = registry.handle(
            request(.sessionsAction, params(id: id, action: "explode")),
            host: host)
        #expect(response.error?.code == "unsupported_action")
    }

    // MARK: Cancel (idempotency + lifecycle)

    @Test func cancelClosesAndIsIdempotent() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let surfaceID = UUID()
        host.nextCreateID = surfaceID
        let created = registry.handle(request(.sessionsCreate), host: host)
        let id = created.result?.session?.sessionID

        let first = registry.handle(
            request(.sessionsAction, params(id: id, action: "cancel")),
            host: host)
        #expect(first.ok)
        #expect(first.result?.canceled == true)
        #expect(first.result?.session?.lifecycle == "closed")
        #expect(host.surfaces[surfaceID]?.closed == true)

        // Idempotent: a second cancel still succeeds.
        let second = registry.handle(
            request(.sessionsAction, params(id: id, action: "cancel")),
            host: host)
        #expect(second.ok)
        #expect(second.result?.canceled == true)
    }

    @Test func actionOnCanceledSessionReturnsAlreadyEnded() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let created = registry.handle(request(.sessionsCreate), host: host)
        let id = created.result?.session?.sessionID
        _ = registry.handle(request(.sessionsAction, params(id: id, action: "cancel")), host: host)

        let response = registry.handle(
            request(.sessionsAction, params(id: id, action: "focus")),
            host: host)
        #expect(response.error?.code == "already_ended")
    }

    // MARK: Lifecycle is derived only from explicit state (no inference)

    @Test func lifecycleReflectsProcessExit() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let surfaceID = UUID()
        host.nextCreateID = surfaceID
        let created = registry.handle(request(.sessionsCreate), host: host)
        let id = created.result?.session?.sessionID

        // Flip the explicit kernel-process flag; lifecycle follows it, and
        // nothing about terminal output is consulted.
        host.surfaces[surfaceID]?.alive = false
        let response = registry.handle(request(.sessionsGet, params(id: id)), host: host)
        #expect(response.result?.session?.lifecycle == "exited")
    }

    @Test func lifecycleClosedWhenSurfaceGone() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let surfaceID = UUID()
        host.nextCreateID = surfaceID
        let created = registry.handle(request(.sessionsCreate), host: host)
        let id = created.result?.session?.sessionID

        host.surfaces[surfaceID]?.exists = false
        let response = registry.handle(request(.sessionsGet, params(id: id)), host: host)
        #expect(response.result?.session?.lifecycle == "closed")
    }

    // MARK: Authorization boundary

    @Test func registryOnlyExposesItsOwnSessions() {
        // A session created in one registry is invisible to another, so a caller
        // cannot reach an arbitrary surface even with a valid token.
        let registryA = makeRegistry()
        let registryB = makeRegistry()
        let host = FakeControlSessionHost()
        let created = registryA.handle(request(.sessionsCreate), host: host)
        let id = created.result?.session?.sessionID

        let response = registryB.handle(request(.sessionsGet, params(id: id)), host: host)
        #expect(response.error?.code == "not_found")
    }

    // MARK: - MAX-2 helpers

    /// Create a session and return its stable id plus the surface id it was
    /// bound to.
    @discardableResult
    private func makeSession(
        _ registry: ControlSessionRegistry,
        _ host: FakeControlSessionHost,
        command: String? = "ls"
    ) -> (id: String, surface: UUID) {
        let surfaceID = UUID()
        host.nextCreateID = surfaceID
        let created = registry.handle(
            request(.sessionsCreate, params(command: command)), host: host)
        return (created.result!.session!.sessionID, surfaceID)
    }

    // MARK: - Agent declaration hooks

    @Test func declareStateSetsStateAndRecordsAuditEntry() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, surface) = makeSession(registry, host)

        let declared = registry.handle(
            request(.sessionsDeclareState, .init(
                id: id, state: "tests:passed", message: "all green", source: "agent-a")),
            host: host)
        #expect(declared.ok)
        #expect(declared.result?.session?.status == "tests:passed")
        #expect(declared.result?.session?.lastEventSeq == 0)

        let log = registry.handle(request(.sessionsEvents, .init(id: id)), host: host)
        let entry = log.result?.events?.first
        #expect(log.result?.events?.count == 1)
        #expect(entry?.kind == "state")
        #expect(entry?.name == "tests:passed")
        #expect(entry?.source == "agent-a")
        #expect(entry?.message == "all green")
        // Auditable: records the surface and the kernel-reported pid, no output.
        #expect(entry?.surfaceID == surface.uuidString)
        #expect(entry?.pid == 4242)
    }

    @Test func declareStateRejectsInvalidStateName() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host)
        let response = registry.handle(
            request(.sessionsDeclareState, .init(id: id, state: "has space")), host: host)
        #expect(response.error?.code == "invalid_request")
    }

    @Test func emitEventRecordsPayloadAndReturnsEntry() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host)

        let response = registry.handle(
            request(.sessionsEmitEvent, .init(
                id: id, event: "pr.opened", payloadJson: #"{"pr":123}"#)),
            host: host)
        #expect(response.ok)
        #expect(response.result?.event?.name == "pr.opened")
        #expect(response.result?.event?.kind == "event")
        #expect(response.result?.event?.source == "agent")
        #expect(response.result?.event?.payload == .object(["pr": .number(123)]))
    }

    @Test func emitEventRejectsInvalidPayload() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host)
        let response = registry.handle(
            request(.sessionsEmitEvent, .init(id: id, event: "x", payloadJson: "{not json")),
            host: host)
        #expect(response.error?.code == "invalid_request")
    }

    @Test func setMetadataMergesAndAudits() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host)

        let response = registry.handle(
            request(.sessionsSetMetadata, .init(id: id, key: "workflow", value: "release")),
            host: host)
        #expect(response.result?.session?.metadata["workflow"] == "release")

        let log = registry.handle(request(.sessionsEvents, .init(id: id)), host: host)
        #expect(log.result?.events?.first?.kind == "metadata")
        #expect(log.result?.events?.first?.name == "workflow")
    }

    @Test func setMetadataRequiresKey() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host)
        let response = registry.handle(
            request(.sessionsSetMetadata, .init(id: id, value: "x")), host: host)
        #expect(response.error?.code == "invalid_request")
    }

    // MARK: - Agent-declared workflow state (MAX-3)

    @Test func setStateRecordsTimestampSourceAndAudits() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, surface) = makeSession(registry, host)

        let response = registry.handle(
            request(.sessionsSetState, .init(
                id: id, state: "needsInput", source: "release-agent")),
            host: host)
        #expect(response.ok)
        let session = response.result?.session
        #expect(session?.workflowState == "needsInput")
        #expect(session?.workflowStateSource == "release-agent")
        #expect(session?.workflowStateAt != nil)

        // The declaration is recorded in the audit log under a distinct kind.
        let log = registry.handle(request(.sessionsEvents, .init(id: id)), host: host)
        #expect(log.result?.events?.last?.kind == "workflow-state")
        #expect(log.result?.events?.last?.name == "needsInput")
        #expect(log.result?.events?.last?.source == "release-agent")

        // And pushed to the surface for display, with a human-facing label.
        #expect(host.surfaces[surface]?.declaredState?.state == .needsInput)
        #expect(host.surfaces[surface]?.declaredState?.state?.label == "Needs input")
        #expect(host.surfaces[surface]?.declaredState?.source == "release-agent")
    }

    @Test func setStateAcceptsEverySupportedValue() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host)
        for value in ["running", "needsInput", "blocked", "complete", "failed"] {
            let response = registry.handle(
                request(.sessionsSetState, .init(id: id, state: value)), host: host)
            #expect(response.ok)
            #expect(response.result?.session?.workflowState == value)
        }
    }

    @Test func setStateRejectsUnknownValueWithoutOverwriting() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host)
        _ = registry.handle(
            request(.sessionsSetState, .init(id: id, state: "running")), host: host)

        // An unknown value (e.g. a typo) is rejected with a clear error...
        let bad = registry.handle(
            request(.sessionsSetState, .init(id: id, state: "done")), host: host)
        #expect(bad.error?.code == "invalid_request")

        // ...and does not overwrite the current declared state.
        let after = registry.handle(request(.sessionsGet, .init(id: id)), host: host)
        #expect(after.result?.session?.workflowState == "running")
    }

    @Test func setStateRejectsEmpty() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host)
        let response = registry.handle(
            request(.sessionsSetState, .init(id: id, state: "")), host: host)
        #expect(response.error?.code == "invalid_request")
    }

    @Test func setSummaryIsIndependentOfState() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, surface) = makeSession(registry, host)

        _ = registry.handle(
            request(.sessionsSetState, .init(id: id, state: "running")), host: host)
        let summarized = registry.handle(
            request(.sessionsSetSummary, .init(
                id: id, summary: "Waiting on user confirmation.")),
            host: host)
        // The summary is set without changing the declared state.
        #expect(summarized.result?.session?.summary == "Waiting on user confirmation.")
        #expect(summarized.result?.session?.workflowState == "running")
        // Both appear in the pushed display snapshot.
        #expect(host.surfaces[surface]?.declaredState?.summary == "Waiting on user confirmation.")
        #expect(host.surfaces[surface]?.declaredState?.state == .running)

        // The summary declaration is also audited under its own kind.
        let log = registry.handle(request(.sessionsEvents, .init(id: id)), host: host)
        #expect(log.result?.events?.last?.kind == "summary")
    }

    @Test func setSummaryDisplaysEvenWithoutState() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, surface) = makeSession(registry, host)
        _ = registry.handle(
            request(.sessionsSetSummary, .init(id: id, summary: "Step 2 of 5")), host: host)
        #expect(host.surfaces[surface]?.declaredState?.summary == "Step 2 of 5")
        #expect(host.surfaces[surface]?.declaredState?.state == nil)
    }

    @Test func setSummaryRejectsEmpty() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host)
        let response = registry.handle(
            request(.sessionsSetSummary, .init(id: id, summary: "")), host: host)
        #expect(response.error?.code == "invalid_request")
    }

    @Test func declaredWorkflowStateIsSeparateFromStatus() {
        // Regression: the free-form `status` / `declare-state` machinery must not
        // feed the displayed workflow state. A fresh session has neither a
        // declared workflow state nor a pushed display snapshot, and declaring a
        // free-form state writes `status` only.
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, surface) = makeSession(registry, host)

        let fresh = registry.handle(request(.sessionsGet, .init(id: id)), host: host)
        #expect(fresh.result?.session?.workflowState == nil)
        #expect(fresh.result?.session?.summary == nil)
        #expect(host.surfaces[surface]?.declaredState == nil)

        _ = registry.handle(
            request(.sessionsDeclareState, .init(id: id, state: "tests:passed")), host: host)
        let afterDeclare = registry.handle(request(.sessionsGet, .init(id: id)), host: host)
        #expect(afterDeclare.result?.session?.status == "tests:passed")
        #expect(afterDeclare.result?.session?.workflowState == nil)
        #expect(host.surfaces[surface]?.declaredState == nil)
    }

    @Test func processExitDoesNotChangeDeclaredState() {
        // Acceptance: process exit (a Maxx-owned lifecycle change) must never set
        // or change the declared workflow state.
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, surface) = makeSession(registry, host)
        _ = registry.handle(
            request(.sessionsSetState, .init(id: id, state: "running")), host: host)

        host.surfaces[surface]?.alive = false

        let after = registry.handle(request(.sessionsGet, .init(id: id)), host: host)
        #expect(after.result?.session?.workflowState == "running")
        #expect(after.result?.session?.lifecycle == "exited")
    }

    @Test func restartClearsDeclaredWorkflowState() {
        // A restart begins a fresh run, so the previous run's declared state and
        // summary must not linger (e.g. a stale `complete` on a now-running tab).
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host, command: "ls")
        _ = registry.handle(
            request(.sessionsSetState, .init(id: id, state: "complete")), host: host)
        _ = registry.handle(
            request(.sessionsSetSummary, .init(id: id, summary: "done")), host: host)

        let restarted = registry.handle(request(.sessionsRestart, .init(id: id)), host: host)
        #expect(restarted.ok)
        #expect(restarted.result?.session?.workflowState == nil)
        #expect(restarted.result?.session?.summary == nil)

        // The fresh surface shows no badge until the agent re-declares.
        let newSurface = restarted.result!.session!.surfaceID
        #expect(host.surfaces[UUID(uuidString: newSurface)!]?.declaredState == nil)
    }

    @Test func eventsSinceFiltersBySequence() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host)
        _ = registry.handle(request(.sessionsEmitEvent, .init(id: id, event: "a")), host: host)
        _ = registry.handle(request(.sessionsEmitEvent, .init(id: id, event: "b")), host: host)

        let all = registry.handle(request(.sessionsEvents, .init(id: id)), host: host)
        #expect(all.result?.events?.count == 2)
        let after = registry.handle(request(.sessionsEvents, .init(id: id, since: 0)), host: host)
        #expect(after.result?.events?.count == 1)
        #expect(after.result?.events?.first?.name == "b")
    }

    // MARK: - interrupt --signal

    @Test func interruptWithSignalForwardsSignal() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, surface) = makeSession(registry, host)

        let response = registry.handle(
            request(.sessionsAction, .init(id: id, action: "interrupt", signal: "SIGTERM")),
            host: host)
        #expect(response.ok)
        let signals = host.surfaces[surface]!.interruptSignals
        #expect(signals.count == 1)
        #expect(signals[0] == SIGTERM)
    }

    @Test func interruptWithoutSignalSendsCtrlC() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, surface) = makeSession(registry, host)

        _ = registry.handle(
            request(.sessionsAction, .init(id: id, action: "interrupt")), host: host)
        #expect(host.surfaces[surface]!.interruptSignals == [nil])
    }

    @Test func interruptSignalWithoutPidIsUnsupported() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, surface) = makeSession(registry, host)
        host.surfaces[surface]?.pid = nil

        let response = registry.handle(
            request(.sessionsAction, .init(id: id, action: "interrupt", signal: "SIGTERM")),
            host: host)
        #expect(response.error?.code == "unsupported")
    }

    @Test func interruptRejectsUnknownSignal() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host)
        let response = registry.handle(
            request(.sessionsAction, .init(id: id, action: "interrupt", signal: "SIGBOGUS")),
            host: host)
        #expect(response.error?.code == "invalid_request")
    }

    // MARK: - Archive

    @Test func archiveClosesSurfaceButRetainsRecord() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, surface) = makeSession(registry, host)

        let response = registry.handle(
            request(.sessionsArchive, .init(id: id, reason: "cleanup")), host: host)
        #expect(response.result?.session?.lifecycle == "archived")
        #expect(response.result?.session?.archiveReason == "cleanup")
        #expect(host.surfaces[surface]?.closed == true)

        // The record is still retrievable for inspection after archiving.
        let got = registry.handle(request(.sessionsGet, params(id: id)), host: host)
        #expect(got.ok)
        #expect(got.result?.session?.lifecycle == "archived")
    }

    @Test func archiveIsIdempotent() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host)
        _ = registry.handle(request(.sessionsArchive, .init(id: id)), host: host)
        let second = registry.handle(request(.sessionsArchive, .init(id: id)), host: host)
        #expect(second.ok)
        #expect(second.result?.session?.lifecycle == "archived")
        // Only one lifecycle entry is recorded despite two archive calls.
        let log = registry.handle(request(.sessionsEvents, .init(id: id)), host: host)
        #expect(log.result?.events?.filter { $0.name == "archived" }.count == 1)
    }

    // MARK: - Restart

    @Test func restartRebindsSurfaceAndCountsRestarts() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, surface) = makeSession(registry, host, command: "zig build")

        let newSurface = UUID()
        host.nextCreateID = newSurface
        let response = registry.handle(request(.sessionsRestart, .init(id: id)), host: host)
        #expect(response.ok)
        #expect(response.result?.session?.surfaceID == newSurface.uuidString)
        #expect(response.result?.session?.restartCount == 1)
        #expect(response.result?.session?.lifecycle == "running")
        // The original surface was closed, and the recorded command was replayed.
        #expect(host.surfaces[surface]?.closed == true)
        #expect(host.createdRequests.last?.command == "zig build")
    }

    @Test func restartWithoutCommandIsUnsupported() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host, command: nil)
        let response = registry.handle(request(.sessionsRestart, .init(id: id)), host: host)
        #expect(response.error?.code == "unsupported")
    }

    @Test func restartAcceptsCommandOverride() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host, command: nil)
        host.nextCreateID = UUID()
        let response = registry.handle(
            request(.sessionsRestart, .init(id: id, command: "echo hi")), host: host)
        #expect(response.ok)
        #expect(host.createdRequests.last?.command == "echo hi")
    }

    @Test func restartRevivesAnArchivedSession() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host, command: "ls")
        _ = registry.handle(request(.sessionsArchive, .init(id: id)), host: host)
        host.nextCreateID = UUID()

        let response = registry.handle(request(.sessionsRestart, .init(id: id)), host: host)
        #expect(response.result?.session?.lifecycle == "running")
        #expect(response.result?.session?.archivedAt == nil)
    }

    // MARK: - Wait

    @Test func waitMatchesAgentDeclaredState() throws {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host)

        let plan = try registry.beginWait(.init(id: id, state: "ready"))
        guard case .pending = registry.pollWait(plan, host: host)! else {
            Issue.record("expected pending before the state is declared")
            return
        }

        _ = registry.handle(request(.sessionsDeclareState, .init(id: id, state: "ready")), host: host)
        guard case let .matched(view, _) = registry.pollWait(plan, host: host)! else {
            Issue.record("expected matched after declaring the state")
            return
        }
        #expect(view.status == "ready")
    }

    @Test func waitForEventIgnoresPriorEventsViaBaseline() throws {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host)

        // An event emitted before the wait must not satisfy it (baseline).
        _ = registry.handle(request(.sessionsEmitEvent, .init(id: id, event: "ping")), host: host)
        let plan = try registry.beginWait(.init(id: id, event: "ping"))
        guard case .pending = registry.pollWait(plan, host: host)! else {
            Issue.record("a pre-existing event must not match a fresh wait")
            return
        }

        _ = registry.handle(request(.sessionsEmitEvent, .init(id: id, event: "ping")), host: host)
        guard case let .matched(_, event) = registry.pollWait(plan, host: host)! else {
            Issue.record("expected matched after a new event")
            return
        }
        #expect(event?.name == "ping")
    }

    @Test func waitForLifecycleMatchesProcessExit() throws {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, surface) = makeSession(registry, host)

        let plan = try registry.beginWait(.init(id: id, lifecycle: "exited"))
        guard case .pending = registry.pollWait(plan, host: host)! else {
            Issue.record("expected pending while the process is alive")
            return
        }
        host.surfaces[surface]?.alive = false
        guard case .matched = registry.pollWait(plan, host: host)! else {
            Issue.record("expected matched once the process exits")
            return
        }
    }

    @Test func waitEndsWhenSessionBecomesTerminal() throws {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host)

        let plan = try registry.beginWait(.init(id: id, state: "never"))
        _ = registry.handle(request(.sessionsArchive, .init(id: id)), host: host)
        guard case .ended = registry.pollWait(plan, host: host)! else {
            Issue.record("expected ended after the session was archived")
            return
        }
    }

    @Test func waitRequiresExactlyOneCondition() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host)
        #expect(throws: ControlError.self) {
            _ = try registry.beginWait(.init(id: id))
        }
        #expect(throws: ControlError.self) {
            _ = try registry.beginWait(.init(id: id, state: "a", event: "b"))
        }
    }

    @Test func waitUnknownSessionIsNotFound() {
        let registry = makeRegistry()
        #expect(throws: ControlError.self) {
            _ = try registry.beginWait(.init(id: UUID().uuidString, state: "x"))
        }
    }

    // MARK: - Watch

    @Test func watchStreamsEventsThenLifecycleEnd() throws {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host)

        let (plan, snapshot) = try registry.beginWatch(.init(id: id), host: host)
        #expect(snapshot.type == "snapshot")
        #expect(snapshot.session?.lifecycle == "running")

        _ = registry.handle(request(.sessionsEmitEvent, .init(id: id, event: "tick")), host: host)
        var update = registry.pollWatch(plan, host: host)
        #expect(update.messages.contains { $0.type == "event" && $0.event?.name == "tick" })
        #expect(!update.ended)

        _ = registry.handle(request(.sessionsArchive, .init(id: id)), host: host)
        update = registry.pollWatch(update.plan, host: host)
        #expect(update.ended)
        #expect(update.messages.contains { $0.type == "lifecycle" && $0.lifecycle == "archived" })
    }

    // MARK: - wait/watch end on process exit (no declared state/event)

    @Test func waitForStateEndsWhenProcessExits() throws {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, surface) = makeSession(registry, host)

        let plan = try registry.beginWait(.init(id: id, state: "tests:passed"))
        guard case .pending = registry.pollWait(plan, host: host)! else {
            Issue.record("expected pending while the process runs")
            return
        }
        // The command exits without ever declaring the state.
        host.surfaces[surface]?.alive = false
        guard case .ended = registry.pollWait(plan, host: host)! else {
            Issue.record("expected ended once the process exits, not an indefinite wait")
            return
        }
    }

    @Test func waitForEventEndsWhenProcessExits() throws {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, surface) = makeSession(registry, host)

        let plan = try registry.beginWait(.init(id: id, event: "done"))
        host.surfaces[surface]?.alive = false
        guard case .ended = registry.pollWait(plan, host: host)! else {
            Issue.record("expected ended once the process exits")
            return
        }
    }

    @Test func watchEndsWhenProcessExits() throws {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, surface) = makeSession(registry, host)

        let (plan, _) = try registry.beginWatch(.init(id: id), host: host)
        host.surfaces[surface]?.alive = false
        let update = registry.pollWatch(plan, host: host)
        #expect(update.ended)
        #expect(update.messages.contains { $0.type == "lifecycle" && $0.lifecycle == "exited" })
    }

    @Test func interruptOnExitedProcessIsUnsupported() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, surface) = makeSession(registry, host)
        // Surface still exists, but its process has exited — nothing to Ctrl-C.
        host.surfaces[surface]?.alive = false

        let response = registry.handle(
            request(.sessionsAction, .init(id: id, action: "interrupt")), host: host)
        #expect(response.error?.code == "unsupported")
    }

    @Test func interruptWithSignalOnExitedProcessIsUnsupported() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, surface) = makeSession(registry, host)
        // Same guard must cover the named-signal path: an exited process must
        // never be signaled (its pgid may have been reused).
        host.surfaces[surface]?.alive = false

        let response = registry.handle(
            request(.sessionsAction, .init(id: id, action: "interrupt", signal: "SIGTERM")),
            host: host)
        #expect(response.error?.code == "unsupported")
    }

    // MARK: - Structured event stream (MAX-7)

    private func makeGroupedSession(
        _ registry: ControlSessionRegistry,
        _ host: FakeControlSessionHost,
        group: String
    ) -> (id: String, surface: UUID) {
        let surfaceID = UUID()
        host.nextCreateID = surfaceID
        let created = registry.handle(
            request(.sessionsCreate, .init(command: "ls", group: group)), host: host)
        return (created.result!.session!.sessionID, surfaceID)
    }

    @Test func streamWatchReplaysFromCursorZeroIncludingCreated() throws {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host)

        let (_, messages) = try registry.beginStreamWatch(.init(since: 0), host: host)
        #expect(messages.first?.type == "hello")
        #expect(messages.first?.schema == controlStreamSchemaVersion)
        #expect((messages.first?.cursor ?? 0) >= 1)
        let events = messages.compactMap { $0.event }
        // Create is a Maxx-owned mechanical fact on the stream with a cursor.
        #expect(events.contains {
            $0.name == "created" && $0.sourceKind == "maxx" && $0.sessionID == id
                && $0.resourceKind == "session" && $0.cursor >= 1
        })
    }

    @Test func streamWatchDefaultStreamsOnlyNewEvents() throws {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host)

        // No `--since`: the opening line carries only `hello` (no replay of the
        // create event that happened before the watch began).
        let (plan, messages) = try registry.beginStreamWatch(.init(), host: host)
        #expect(messages.count == 1)
        #expect(messages.first?.type == "hello")

        _ = registry.handle(request(.sessionsEmitEvent, .init(id: id, event: "ping")), host: host)
        let update = registry.pollStreamWatch(plan, host: host)
        #expect(update.messages.contains { $0.event?.name == "ping" && $0.event?.sourceKind == "agent" })
    }

    @Test func streamWatchFiltersByGroup() throws {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let inGroup = makeGroupedSession(registry, host, group: "g1")
        let other = makeGroupedSession(registry, host, group: "g2")

        let (_, messages) = try registry.beginStreamWatch(.init(since: 0, group: "g1"), host: host)
        let events = messages.compactMap { $0.event }
        #expect(!events.isEmpty)
        #expect(events.allSatisfy { $0.group == "g1" })
        #expect(events.contains { $0.sessionID == inGroup.id })
        #expect(!events.contains { $0.sessionID == other.id })
    }

    @Test func streamWatchFiltersBySession() throws {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let a = makeSession(registry, host)
        let b = makeSession(registry, host)
        _ = registry.handle(request(.sessionsEmitEvent, .init(id: b.id, event: "noise")), host: host)

        let (_, messages) = try registry.beginStreamWatch(.init(id: a.id, since: 0), host: host)
        let events = messages.compactMap { $0.event }
        #expect(events.allSatisfy { $0.sessionID == a.id })
        #expect(!events.contains { $0.sessionID == b.id })
    }

    @Test func streamWatchSinceResumesInOrderWithoutRetentionMiss() throws {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host)  // created = cursor 1
        _ = registry.handle(request(.sessionsEmitEvent, .init(id: id, event: "ping")), host: host)  // 2
        _ = registry.handle(request(.sessionsEmitEvent, .init(id: id, event: "pong")), host: host)  // 3

        let (_, messages) = try registry.beginStreamWatch(.init(id: id, since: 1), host: host)
        #expect(messages.first?.reset == nil)
        let names = messages.compactMap { $0.event?.name }
        #expect(names == ["ping", "pong"])
    }

    @Test func streamWatchReportsRetentionMiss() throws {
        // A tiny bus so eviction is easy to force.
        let registry = ControlSessionRegistry(maxBusEvents: 3)
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host)  // created = cursor 1
        for index in 0..<4 {  // cursors 2,3,4,5 -> bus retains 3,4,5
            _ = registry.handle(
                request(.sessionsEmitEvent, .init(id: id, event: "e\(index)")), host: host)
        }

        let (_, messages) = try registry.beginStreamWatch(.init(since: 1), host: host)
        #expect(messages.first?.type == "hello")
        #expect(messages.first?.reset == true)
        // Events up to and including cursor 2 were dropped to retention.
        #expect(messages.first?.droppedThrough == 2)
    }

    @Test func streamWatchStaleForwardSinceResets() throws {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host)  // created = cursor 1, latest = 1
        _ = id
        // A cursor beyond anything this run assigned (e.g. resumed with a cursor
        // from a previous app run) must not gate events forever: the stream flags
        // a reset and replays what is retained instead of silently swallowing.
        let (plan, messages) = try registry.beginStreamWatch(.init(since: 999), host: host)
        #expect(messages.first?.reset == true)
        #expect(messages.compactMap { $0.event }.contains { $0.name == "created" })
        // And live events after the (small) latest cursor still stream.
        _ = registry.handle(request(.sessionsEmitEvent, .init(id: id, event: "after")), host: host)
        let update = registry.pollStreamWatch(plan, host: host)
        #expect(update.messages.contains { $0.event?.name == "after" })
    }

    @Test func reconcileEmitsExitedMechanicalEvent() throws {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, surface) = makeSession(registry, host)
        host.surfaces[surface]?.alive = false  // kernel-reported process exit

        let (_, messages) = try registry.beginStreamWatch(.init(id: id, since: 0), host: host)
        let events = messages.compactMap { $0.event }
        #expect(events.contains { $0.name == "exited" && $0.sourceKind == "maxx" })
    }

    @Test func mechanicalEventsAreBusOnlyNotInPerSessionLog() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host)
        _ = registry.handle(request(.sessionsAction, .init(id: id, action: "focus")), host: host)
        _ = registry.handle(request(.sessionsEmitEvent, .init(id: id, event: "ping")), host: host)

        // The per-session audit log (MAX-2 contract) is unchanged: it holds only
        // the agent-declared emit-event, not the bus-only create/focus events.
        let response = registry.handle(request(.sessionsEvents, .init(id: id)), host: host)
        let kinds = response.result?.events?.map(\.kind) ?? []
        #expect(kinds == ["event"])
    }

    @Test func setGroupRecordsMembershipEventsAndUpdatesView() throws {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host)

        let joined = registry.handle(
            request(.sessionsSetGroup, .init(id: id, group: "release")), host: host)
        #expect(joined.result?.session?.group == "release")

        let left = registry.handle(request(.sessionsSetGroup, .init(id: id)), host: host)
        #expect(left.result?.session?.group == nil)

        let (_, messages) = try registry.beginStreamWatch(.init(since: 0), host: host)
        let events = messages.compactMap { $0.event }
        #expect(events.contains {
            $0.name == "group.joined" && $0.group == "release" && $0.sourceKind == "maxx"
        })
        #expect(events.contains { $0.name == "group.left" && $0.group == "release" })
    }

    @Test func streamWaitForEventMatchesAcrossGroup() throws {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let member = makeGroupedSession(registry, host, group: "g")

        let plan = try registry.beginStreamWait(.init(event: "ready", group: "g"), host: host)
        guard case .pending = registry.pollStreamWait(plan, host: host) else {
            Issue.record("expected pending before any matching event")
            return
        }
        _ = registry.handle(request(.sessionsEmitEvent, .init(id: member.id, event: "ready")), host: host)
        guard case let .matched(event, _) = registry.pollStreamWait(plan, host: host) else {
            Issue.record("expected matched after the event arrives")
            return
        }
        #expect(event?.name == "ready")
        #expect(event?.sourceKind == "agent")
    }

    @Test func streamWaitGroupAllExited() throws {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let a = makeGroupedSession(registry, host, group: "g")
        let b = makeGroupedSession(registry, host, group: "g")

        let plan = try registry.beginStreamWait(.init(group: "g", all: "exited"), host: host)
        guard case .pending = registry.pollStreamWait(plan, host: host) else {
            Issue.record("expected pending while both members run")
            return
        }
        host.surfaces[a.surface]?.alive = false
        guard case .pending = registry.pollStreamWait(plan, host: host) else {
            Issue.record("expected pending while one member still runs")
            return
        }
        host.surfaces[b.surface]?.alive = false
        guard case let .matched(_, sessions) = registry.pollStreamWait(plan, host: host) else {
            Issue.record("expected matched once all members exited")
            return
        }
        #expect(sessions?.count == 2)
    }

    @Test func streamWaitGroupAllDeclared() throws {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let a = makeGroupedSession(registry, host, group: "g")
        let b = makeGroupedSession(registry, host, group: "g")

        let plan = try registry.beginStreamWait(.init(group: "g", all: "declared:complete"), host: host)
        _ = registry.handle(request(.sessionsSetState, .init(id: a.id, state: "complete")), host: host)
        guard case .pending = registry.pollStreamWait(plan, host: host) else {
            Issue.record("expected pending until every member declares complete")
            return
        }
        _ = registry.handle(request(.sessionsSetState, .init(id: b.id, state: "complete")), host: host)
        guard case .matched = registry.pollStreamWait(plan, host: host) else {
            Issue.record("expected matched once all members declared complete")
            return
        }
    }

    @Test func streamWaitGroupAllIdle() throws {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let a = makeGroupedSession(registry, host, group: "g")
        _ = makeGroupedSession(registry, host, group: "g")

        // No member declared `running`, so the group is idle straight away.
        let idlePlan = try registry.beginStreamWait(.init(group: "g", all: "idle"), host: host)
        guard case .matched = registry.pollStreamWait(idlePlan, host: host) else {
            Issue.record("expected matched: no member is declared running")
            return
        }

        // Declaring `running` on a member makes the group not-idle.
        _ = registry.handle(request(.sessionsSetState, .init(id: a.id, state: "running")), host: host)
        let busyPlan = try registry.beginStreamWait(.init(group: "g", all: "idle"), host: host)
        guard case .pending = registry.pollStreamWait(busyPlan, host: host) else {
            Issue.record("expected pending: a member is declared running")
            return
        }
    }

    @Test func streamWaitAllRequiresGroup() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        _ = makeSession(registry, host)
        #expect(throws: ControlError.self) {
            _ = try registry.beginStreamWait(.init(all: "exited"), host: host)
        }
    }

    @Test func streamWaitEmptyGroupRejected() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        #expect(throws: ControlError.self) {
            _ = try registry.beginStreamWait(.init(group: "nobody", all: "exited"), host: host)
        }
    }

    @Test func streamWaitEventEndsWhenSessionTerminal() throws {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host)

        let plan = try registry.beginStreamWait(.init(id: id, event: "never"), host: host)
        _ = registry.handle(request(.sessionsArchive, .init(id: id)), host: host)
        guard case .ended = registry.pollStreamWait(plan, host: host) else {
            Issue.record("expected ended once the session is terminal")
            return
        }
    }

    @Test func streamWatchEndsWhenFilteredSessionTerminal() throws {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host)

        let (plan, _) = try registry.beginStreamWatch(.init(id: id), host: host)
        _ = registry.handle(request(.sessionsArchive, .init(id: id)), host: host)
        let update = registry.pollStreamWatch(plan, host: host)
        #expect(update.ended)
    }

    @Test func streamEnforcesNoInferenceOwnershipBoundary() throws {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host)

        // With no agent declaration, every event on the stream is a Maxx-owned
        // mechanical fact — Maxx never originates an `agent` event.
        let (_, mechanical) = try registry.beginStreamWatch(.init(id: id, since: 0), host: host)
        let before = mechanical.compactMap { $0.event }
        #expect(!before.isEmpty)
        #expect(before.allSatisfy { $0.sourceKind == "maxx" })

        // Only an explicit declaration produces an `agent`-owned event.
        _ = registry.handle(request(.sessionsEmitEvent, .init(id: id, event: "ci.passed")), host: host)
        let (_, after) = try registry.beginStreamWatch(.init(id: id, since: 0), host: host)
        let declared = after.compactMap { $0.event }.filter { $0.sourceKind == "agent" }
        #expect(declared.contains { $0.name == "ci.passed" })
    }
}

@MainActor
struct ControlTokenAuthTests {
    @Test func matchingTokenAuthorizes() {
        #expect(ControlServer.tokensMatch("secret", "secret"))
    }

    @Test func wrongTokenRejected() {
        #expect(!ControlServer.tokensMatch("nope", "secret"))
    }

    @Test func missingTokenRejected() {
        #expect(!ControlServer.tokensMatch(nil, "secret"))
    }

    @Test func differentLengthRejected() {
        #expect(!ControlServer.tokensMatch("sec", "secret"))
    }
}

struct ControlValidationTests {
    @Test func metadataKeyAllowsExpectedCharacters() {
        #expect(ControlValidation.isValidMetadataKey("workflow.id-2_x"))
        #expect(!ControlValidation.isValidMetadataKey("has space"))
        #expect(!ControlValidation.isValidMetadataKey("emoji😀"))
    }

    @Test func envKeyRejectsInvalidCharacters() {
        #expect(throws: ControlError.self) {
            _ = try ControlValidation.validateEnv(["BAD-KEY=1"])
        }
    }

    @Test func envParsesKeyValue() throws {
        let parsed = try ControlValidation.validateEnv(["FOO=bar", "BAZ=qux=1"])
        #expect(parsed["FOO"] == "bar")
        // Only the first '=' splits; the rest is the value.
        #expect(parsed["BAZ"] == "qux=1")
    }

    @Test func stateAndEventAllowNamespacing() throws {
        #expect(try ControlValidation.validateState("tests:passed") == "tests:passed")
        #expect(try ControlValidation.validateEventName("ci/build.done") == "ci/build.done")
        #expect(throws: ControlError.self) { _ = try ControlValidation.validateState("has space") }
        #expect(throws: ControlError.self) { _ = try ControlValidation.validateEventName("") }
    }

    @Test func sourceDefaultsToAgent() throws {
        #expect(try ControlValidation.validateSource(nil) == "agent")
        #expect(try ControlValidation.validateSource("webhook") == "webhook")
    }

    @Test func parseSignalMapsNames() throws {
        #expect(try ControlValidation.parseSignal("SIGTERM") == SIGTERM)
        #expect(try ControlValidation.parseSignal("term") == SIGTERM)
        #expect(try ControlValidation.parseSignal("INT") == SIGINT)
        #expect(throws: ControlError.self) { _ = try ControlValidation.parseSignal("SIGBOGUS") }
    }
}

struct ControlJSONValueTests {
    @Test func parsesNestedJSON() throws {
        let value = try ControlJSONValue.parse(#"{"a":[1,true,"x"],"b":null}"#)
        #expect(value == .object([
            "a": .array([.number(1), .bool(true), .string("x")]),
            "b": .null,
        ]))
    }

    @Test func roundTripsThroughCoding() throws {
        let value = ControlJSONValue.object(["n": .number(42), "s": .string("hi")])
        let data = try JSONEncoder().encode(value)
        let decoded = try JSONDecoder().decode(ControlJSONValue.self, from: data)
        #expect(decoded == value)
    }

    @Test func rejectsMalformedJSON() {
        #expect(throws: ControlError.self) { _ = try ControlJSONValue.parse("{nope") }
    }
}
