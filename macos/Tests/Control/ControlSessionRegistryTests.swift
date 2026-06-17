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
        var title = "fake"
        var workingDirectory: String?
        var registrationToken = "surface-token"
        var focusCount = 0
        var interruptCount = 0
        /// Signals passed to `interrupt`; nil entries mean "Ctrl-C via tty".
        var interruptSignals: [Int32?] = []
        var inputs: [String] = []
        var submitCount = 0
        var closed = false
        /// The most recent declared state/summary pushed to this surface for
        /// display. Lets tests assert the registry → UI path without a real view.
        var declaredState: ControlDeclaredState?
        /// The most recent agent-reported metadata pushed to this surface for
        /// display (MAX-4). Nil until a metadata declaration is pushed.
        var metadata: [String: ControlJSONValue]?
        /// The most recent parent/group relationship pushed to this surface for
        /// display (MAX-6). Nil until a relationship is pushed.
        var relationship: ControlRelationship?
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

    func surfaceForRegistration(surfaceID: UUID, token: String) -> ControlSurfaceHandle? {
        guard let surface = surfaces[surfaceID], surface.exists else { return nil }
        guard surface.registrationToken == token else { return nil }
        return FakeSurfaceHandle(id: surfaceID, surface: surface)
    }

    func addManualSurface(
        id: UUID = UUID(),
        token: String = "surface-token",
        title: String = "manual",
        workingDirectory: String? = nil
    ) -> UUID {
        let surface = Surface()
        surface.registrationToken = token
        surface.title = title
        surface.workingDirectory = workingDirectory
        surfaces[id] = surface
        return id
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
    var title: String { surface.title }
    var workingDirectory: String? { surface.workingDirectory }
    var pid: Int? { surface.pid }
    var isProcessAlive: Bool { surface.alive }
    func focus() { surface.focusCount += 1 }
    func sendInput(_ text: String) { surface.inputs.append(text) }
    func submitInput(_ text: String) {
        surface.inputs.append(text)
        surface.submitCount += 1
    }
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
    func applyMetadata(_ metadata: [String: ControlJSONValue]) {
        surface.metadata = metadata
    }
    func applyRelationship(_ relationship: ControlRelationship) {
        surface.relationship = relationship
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
        // The convenience overload takes plain strings; wrap them as JSON string
        // values to match the structured metadata model (MAX-4). Tests that need
        // structured values build `ControlRequest.Params` directly.
        .init(
            id: id, title: title, cwd: cwd, command: command, env: env,
            metadata: metadata?.mapValues { .string($0) }, status: status,
            location: location, action: action, input: input)
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

    @Test func registerSpawnedSurfaceReturnsSessionForAgentCommand() throws {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let surfaceID = host.addManualSurface(title: "Codex child", workingDirectory: "/tmp")

        let session = try registry.registerSpawnedSurface(.init(
            surfaceID: surfaceID,
            title: "Codex child",
            command: "codex --full-auto",
            cwd: "/tmp",
            env: [:],
            location: .tab),
            host: host)

        #expect(session.surfaceID == surfaceID.uuidString)
        #expect(UUID(uuidString: session.sessionID) != nil)
        #expect(session.sessionID != surfaceID.uuidString)
        #expect(session.command == "codex --full-auto")
        #expect(session.cwd == "/tmp")
        #expect(session.status == "created")
        #expect(session.lifecycle == "running")
        #expect(session.agentType == nil)

        let fetched = registry.handle(
            request(.sessionsGet, params(id: session.sessionID)),
            host: host)
        #expect(fetched.ok)
        #expect(fetched.result?.session?.sessionID == session.sessionID)
    }

    @Test func registerSpawnedSurfaceReturnsSessionForNonAgentCommand() throws {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let surfaceID = host.addManualSurface(title: "Server", workingDirectory: "/srv/app")

        let session = try registry.registerSpawnedSurface(.init(
            surfaceID: surfaceID,
            title: "Server",
            command: "npm run dev",
            cwd: "/srv/app",
            env: ["NODE_ENV": "development"],
            location: .tab),
            host: host)

        #expect(session.surfaceID == surfaceID.uuidString)
        #expect(session.command == "npm run dev")
        #expect(session.title == "Server")
        #expect(session.cwd == "/srv/app")
        #expect(session.agentType == nil)
        #expect(registry.count == 1)
        #expect(registry.sessionID(forRegisteredSurface: surfaceID) == session.sessionID)
    }

    @Test func registeredSpawnedSurfaceSessionIDSurvivesQuickExit() throws {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let surfaceID = host.addManualSurface(title: "Quick", workingDirectory: "/tmp")

        let session = try registry.registerSpawnedSurface(.init(
            surfaceID: surfaceID,
            title: "Quick",
            command: "echo done",
            cwd: "/tmp",
            env: [:],
            location: .tab),
            host: host)

        host.surfaces[surfaceID]?.exists = false

        #expect(registry.sessionID(forRegisteredSurface: surfaceID) == session.sessionID)

        let fetched = registry.handle(
            request(.sessionsGet, params(id: session.sessionID)),
            host: host)
        #expect(fetched.ok)
        #expect(fetched.result?.session?.sessionID == session.sessionID)
        #expect(fetched.result?.session?.lifecycle == "closed")
    }

    @Test func registerSpawnedSurfaceFailsWithoutLiveSurface() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()

        #expect(throws: ControlError.self) {
            _ = try registry.registerSpawnedSurface(.init(
                surfaceID: UUID(),
                title: "Missing",
                command: "codex",
                cwd: "/tmp",
                env: [:],
                location: .tab),
                host: host)
        }
        #expect(registry.count == 0)
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
        #expect(session?.metadata["workflow"] == .string("release"))
        #expect(session?.metadata["request_id"] == .string("abc"))
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

    @Test func metadataValueTooLargeRejected() {
        let long = String(repeating: "x", count: ControlSession.Limits.maxMetadataValueBytes + 1)
        let response = makeRegistry().handle(
            request(.sessionsCreate, params(metadata: ["k": long])),
            host: FakeControlSessionHost())
        #expect(response.error?.code == "invalid_request")
    }

    @Test func metadataTotalTooLargeRejected() {
        // Each value is within the per-value cap, but together they exceed the
        // total-map cap, so the whole map is rejected (no unbounded payloads).
        let chunk = String(repeating: "y", count: ControlSession.Limits.maxMetadataValueBytes - 16)
        var big: [String: String] = [:]
        for index in 0..<24 { big["k\(index)"] = chunk }
        let response = makeRegistry().handle(
            request(.sessionsCreate, params(metadata: big)),
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
        #expect(session?.metadata["a"] == .string("1"))
        #expect(session?.metadata["b"] == .string("2"))
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

    @Test func submitActionRequiresText() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let created = registry.handle(request(.sessionsCreate), host: host)
        let id = created.result?.session?.sessionID

        let response = registry.handle(
            request(.sessionsAction, params(id: id, action: "submit")),
            host: host)
        #expect(response.error?.code == "invalid_request")
    }

    @Test func submitActionSendsTextAndEnter() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let surfaceID = UUID()
        host.nextCreateID = surfaceID
        let created = registry.handle(request(.sessionsCreate), host: host)
        let id = created.result?.session?.sessionID

        let response = registry.handle(
            request(.sessionsAction, params(id: id, action: "submit", input: "echo hi")),
            host: host)
        #expect(response.ok)
        #expect(response.result?.applied == "submit")
        #expect(host.surfaces[surfaceID]?.inputs == ["echo hi"])
        #expect(host.surfaces[surfaceID]?.submitCount == 1)
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

    // MARK: Register current tab (MAX-17)

    @Test func registerCurrentCreatesSessionForManualSurface() throws {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let surfaceID = host.addManualSurface(
            token: "proof", title: "Supervisor", workingDirectory: "/tmp")

        let response = registry.handle(
            request(.sessionsRegisterCurrent, .init(
                surfaceID: surfaceID.uuidString,
                registrationToken: "proof")),
            host: host)

        #expect(response.ok)
        let session = try #require(response.result?.session)
        #expect(session.surfaceID == surfaceID.uuidString)
        #expect(session.title == "Supervisor")
        #expect(session.cwd == "/tmp")
        #expect(session.status == "registered")
        #expect(session.lifecycle == "running")
        #expect(host.createdRequests.isEmpty)

        let listed = registry.handle(request(.sessionsList), host: host)
        #expect(listed.result?.sessions?.map(\.sessionID) == [session.sessionID])
    }

    @Test func registerCurrentRetryIsIdempotentForSameLiveSurface() throws {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let surfaceID = host.addManualSurface(token: "proof")

        let first = registry.handle(
            request(.sessionsRegisterCurrent, .init(
                surfaceID: surfaceID.uuidString,
                registrationToken: "proof")),
            host: host)
        let second = registry.handle(
            request(.sessionsRegisterCurrent, .init(
                surfaceID: surfaceID.uuidString,
                registrationToken: "proof")),
            host: host)

        #expect(first.ok)
        #expect(second.ok)
        #expect(second.result?.session?.sessionID == first.result?.session?.sessionID)
        #expect(registry.count == 1)

        let (_, messages) = try registry.beginStreamWatch(.init(since: 0), host: host)
        let registered = messages.compactMap(\.event).filter { $0.name == "registered" }
        #expect(registered.count == 1)
    }

    @Test func registerCurrentRejectsGuessedDifferentSurface() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let surfaceID = host.addManualSurface(token: "real-proof")

        let wrongToken = registry.handle(
            request(.sessionsRegisterCurrent, .init(
                surfaceID: surfaceID.uuidString,
                registrationToken: "guessed")),
            host: host)
        #expect(wrongToken.error?.code == "unauthorized")
        #expect(registry.count == 0)

        let unknownSurface = registry.handle(
            request(.sessionsRegisterCurrent, .init(
                surfaceID: UUID().uuidString,
                registrationToken: "real-proof")),
            host: host)
        #expect(unknownSurface.error?.code == "unauthorized")
        #expect(registry.count == 0)
    }

    @Test func registerCurrentRejectsMutatingFields() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let surfaceID = host.addManualSurface(token: "proof")

        let response = registry.handle(
            request(.sessionsRegisterCurrent, .init(
                surfaceID: surfaceID.uuidString,
                registrationToken: "proof",
                status: "complete",
                parent: UUID().uuidString)),
            host: host)

        #expect(response.error?.code == "invalid_request")
        #expect(registry.count == 0)
    }

    @Test func registerCurrentPolicyDenialHappensBeforeProofValidation() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let response = registry.handle(
            request(.sessionsRegisterCurrent, .init(
                surfaceID: "not-a-uuid",
                registrationToken: "bad",
                caller: "readonly-external")),
            host: host)

        #expect(response.error?.code == "unauthorized")
        #expect(registry.count == 0)
    }

    @Test func registeredParentSupportsDeclarationsMetadataAndChildren() throws {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let parentSurface = host.addManualSurface(token: "proof")
        let parent = registry.handle(
            request(.sessionsRegisterCurrent, .init(
                surfaceID: parentSurface.uuidString,
                registrationToken: "proof")),
            host: host)
        let parentID = try #require(parent.result?.session?.sessionID)

        #expect(registry.handle(
            request(.sessionsSetState, .init(id: parentID, state: "running")),
            host: host).ok)
        #expect(registry.handle(
            request(.sessionsSetSummary, .init(id: parentID, summary: "Supervising children")),
            host: host).ok)
        #expect(registry.handle(
            request(.sessionsSetMetadata, .init(id: parentID, key: "linear.issue", value: "MAX-17")),
            host: host).ok)
        #expect(registry.handle(
            request(.sessionsSetGroup, .init(id: parentID, group: "max-17")),
            host: host).ok)

        let child = registry.handle(
            request(.sessionsCreate, .init(command: "codex", parent: parentID)),
            host: host)
        let childID = try #require(child.result?.session?.sessionID)
        #expect(child.result?.session?.parentID == parentID)

        let listed = registry.handle(request(.sessionsList, .init(parent: parentID)), host: host)
        #expect(listed.result?.sessions?.map(\.sessionID) == [childID])
        let parentView = registry.handle(request(.sessionsGet, .init(id: parentID)), host: host)
        #expect(parentView.result?.session?.workflowState == "running")
        #expect(parentView.result?.session?.summary == "Supervising children")
        #expect(parentView.result?.session?.metadata["linear.issue"] == .string("MAX-17"))
        #expect(parentView.result?.session?.group == "max-17")
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
        #expect(response.result?.event?.payload == .object(["pr": .integer(123)]))
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
        #expect(response.result?.session?.metadata["workflow"] == .string("release"))

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

    // MARK: - Agent-reported structured metadata (MAX-4)

    @Test func setMetadataStoresStructuredJSONValue() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, surface) = makeSession(registry, host)

        // A `value_json` carries an arbitrary nested value, stored verbatim.
        let response = registry.handle(
            request(.sessionsSetMetadata, .init(
                id: id, key: "run", valueJson: #"{"id":"run_abc","attempts":[1,2]}"#)),
            host: host)
        #expect(response.ok)
        #expect(response.result?.session?.metadata["run"] == .object([
            "id": .string("run_abc"),
            "attempts": .array([.integer(1), .integer(2)]),
        ]))
        // The structured value is also pushed to the surface for display.
        #expect(host.surfaces[surface]?.metadata?["run"] == .object([
            "id": .string("run_abc"),
            "attempts": .array([.integer(1), .integer(2)]),
        ]))
    }

    @Test func metadataPreservesLargeIntegerValues() {
        // Regression: a >2^53 integer supplied via value_json must round-trip
        // verbatim (not collapse to a lossy Double) through store + display.
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host)
        let response = registry.handle(
            request(.sessionsSetMetadata, .init(id: id, key: "run.id", valueJson: "9007199254740993")),
            host: host)
        #expect(response.ok)
        #expect(response.result?.session?.metadata["run.id"] == .integer(9_007_199_254_740_993))
        #expect(response.result?.session?.metadata["run.id"]?.displayString == "9007199254740993")
    }

    @Test func updateMetadataIsAuditedAndObservableViaWatch() throws {
        // `update` is a documented metadata-merge path, so a metadata change made
        // through it must be observable to a `watch`/`events` consumer — not just
        // the single-key `set-metadata`.
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host)

        let (plan, _) = try registry.beginWatch(.init(id: id), host: host)
        let updated = registry.handle(
            request(.sessionsUpdate, params(id: id, metadata: ["repo": "org/repo"])), host: host)
        #expect(updated.ok)

        // The active watch surfaces the change as a new metadata audit event.
        let watch = registry.pollWatch(plan, host: host)
        #expect(watch.messages.contains {
            $0.type == "event" && $0.event?.kind == "metadata" && $0.event?.name == "repo"
        })
        // And it is in the audit log read back by `events`.
        let log = registry.handle(request(.sessionsEvents, .init(id: id)), host: host)
        #expect(log.result?.events?.contains { $0.kind == "metadata" && $0.name == "repo" } == true)
    }

    @Test func metadataRoundTripsUnknownKeysWithoutNormalization() {
        // Acceptance: unknown, namespaced keys and structured values survive a
        // set → read round-trip byte-for-byte, with no interpretation.
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let original: [String: ControlJSONValue] = [
            "linear.issue": .string("MAX-4"),
            "pr.url": .string("https://github.com/org/repo/pull/456"),
            "repo": .string("org/repo"),
            "branch": .string("codex/agent-metadata-api"),
            "run.id": .string("run_abc123"),
            "cleanup.command": .string("git worktree remove ../wt"),
            "x.unknown.flag": .bool(true),
            "x.nested": .object(["a": .array([.number(1), .null, .string("z")])]),
        ]
        let surfaceID = UUID()
        host.nextCreateID = surfaceID
        let created = registry.handle(
            request(.sessionsCreate, .init(metadata: original)), host: host)
        let id = created.result?.session?.sessionID

        let got = registry.handle(request(.sessionsGet, .init(id: id)), host: host)
        #expect(got.result?.session?.metadata == original)
    }

    @Test func removeMetadataDropsNamedKeys() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let surfaceID = UUID()
        host.nextCreateID = surfaceID
        let created = registry.handle(
            request(.sessionsCreate, params(metadata: ["a": "1", "b": "2", "c": "3"])),
            host: host)
        let id = created.result?.session?.sessionID

        let response = registry.handle(
            request(.sessionsRemoveMetadata, .init(id: id, keys: ["a", "c"])), host: host)
        #expect(response.ok)
        #expect(response.result?.session?.metadata["a"] == nil)
        #expect(response.result?.session?.metadata["b"] == .string("2"))
        #expect(response.result?.session?.metadata["c"] == nil)
        // The surface reflects the post-removal map.
        #expect(host.surfaces[surfaceID]?.metadata?.keys.sorted() == ["b"])
        // Each present removed key is audited.
        let log = registry.handle(request(.sessionsEvents, .init(id: id)), host: host)
        let removed = log.result?.events?.filter { $0.message == "removed" }
        #expect(removed?.count == 2)
    }

    @Test func removeMetadataRequiresAKey() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host)
        let response = registry.handle(
            request(.sessionsRemoveMetadata, .init(id: id)), host: host)
        #expect(response.error?.code == "invalid_request")
    }

    @Test func removeMetadataIgnoresAbsentKeys() {
        // Removing a key that isn't present is a no-op success (idempotent) as
        // long as at least one key was named.
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let created = registry.handle(
            request(.sessionsCreate, params(metadata: ["a": "1"])), host: host)
        let id = created.result?.session?.sessionID
        let response = registry.handle(
            request(.sessionsRemoveMetadata, .init(id: id, keys: ["missing"])), host: host)
        #expect(response.ok)
        #expect(response.result?.session?.metadata["a"] == .string("1"))
        // Nothing was actually removed, so nothing is audited.
        let log = registry.handle(request(.sessionsEvents, .init(id: id)), host: host)
        #expect(log.result?.events?.contains { $0.message == "removed" } == false)
    }

    @Test func clearMetadataRemovesEverything() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let surfaceID = UUID()
        host.nextCreateID = surfaceID
        let created = registry.handle(
            request(.sessionsCreate, params(metadata: ["a": "1", "b": "2"])), host: host)
        let id = created.result?.session?.sessionID

        let response = registry.handle(
            request(.sessionsClearMetadata, .init(id: id)), host: host)
        #expect(response.ok)
        #expect(response.result?.session?.metadata.isEmpty == true)
        #expect(host.surfaces[surfaceID]?.metadata?.isEmpty == true)
        // The clear is audited once.
        let log = registry.handle(request(.sessionsEvents, .init(id: id)), host: host)
        #expect(log.result?.events?.filter { $0.message == "cleared" }.count == 1)
    }

    @Test func clearMetadataOnEmptyIsCleanNoOp() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host)
        let response = registry.handle(
            request(.sessionsClearMetadata, .init(id: id)), host: host)
        #expect(response.ok)
        let log = registry.handle(request(.sessionsEvents, .init(id: id)), host: host)
        #expect(log.result?.events?.contains { $0.message == "cleared" } == false)
    }

    @Test func setMetadataRejectsOversizedJSONValue() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host)
        let big = String(repeating: "z", count: ControlSession.Limits.maxMetadataValueBytes + 1)
        let response = registry.handle(
            request(.sessionsSetMetadata, .init(id: id, key: "k", valueJson: "\"\(big)\"")),
            host: host)
        #expect(response.error?.code == "invalid_request")
    }

    @Test func setMetadataRejectsInvalidJSONValue() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host)
        let response = registry.handle(
            request(.sessionsSetMetadata, .init(id: id, key: "k", valueJson: "{not json")),
            host: host)
        #expect(response.error?.code == "invalid_request")
    }

    @Test func metadataPersistsAcrossRestart() {
        // Metadata is scoped to the session record's lifetime, so a restart (which
        // keeps the stable session_id) preserves it — unlike the per-run workflow
        // state badge, which a restart clears.
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host, command: "ls")
        _ = registry.handle(
            request(.sessionsSetMetadata, .init(id: id, key: "repo", value: "org/repo")),
            host: host)

        let newSurface = UUID()
        host.nextCreateID = newSurface
        let restarted = registry.handle(request(.sessionsRestart, .init(id: id)), host: host)
        #expect(restarted.ok)
        #expect(restarted.result?.session?.metadata["repo"] == .string("org/repo"))
        // The metadata must also be re-pushed to the fresh surface so the chip
        // persists across the restart (the new surface starts with an empty map).
        #expect(host.surfaces[newSurface]?.metadata?["repo"] == .string("org/repo"))
    }

    @Test func listFiltersByMetadataKeyAndValue() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let a = registry.handle(
            request(.sessionsCreate, params(metadata: ["repo": "org/a", "stage": "build"])),
            host: host)
        let b = registry.handle(
            request(.sessionsCreate, params(metadata: ["repo": "org/b", "stage": "build"])),
            host: host)
        _ = registry.handle(
            request(.sessionsCreate, params(metadata: ["other": "x"])), host: host)

        // key=value selects exactly the matching session.
        let byRepo = registry.handle(
            request(.sessionsList, .init(metadataFilter: [.init(key: "repo", value: "org/a")])),
            host: host)
        #expect(byRepo.result?.sessions?.count == 1)
        #expect(byRepo.result?.sessions?.first?.sessionID == a.result?.session?.sessionID)

        // key-only (presence) selects every session carrying that key.
        let byStage = registry.handle(
            request(.sessionsList, .init(metadataFilter: [.init(key: "stage", value: nil)])),
            host: host)
        #expect(byStage.result?.sessions?.count == 2)

        // Multiple filters AND together.
        let both = registry.handle(
            request(.sessionsList, .init(metadataFilter: [
                .init(key: "stage", value: "build"),
                .init(key: "repo", value: "org/b"),
            ])),
            host: host)
        #expect(both.result?.sessions?.count == 1)
        #expect(both.result?.sessions?.first?.sessionID == b.result?.session?.sessionID)

        // A non-matching value selects nothing.
        let none = registry.handle(
            request(.sessionsList, .init(metadataFilter: [.init(key: "repo", value: "org/none")])),
            host: host)
        #expect(none.result?.sessions?.isEmpty == true)
    }

    @Test func listFilterMatchesStructuredValueByJSON() {
        // A structured value is matched by its compact JSON rendering, so a filter
        // can target e.g. a numeric or boolean value without special-casing.
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        _ = registry.handle(
            request(.sessionsCreate, .init(metadata: ["run.attempt": .number(3)])), host: host)
        let match = registry.handle(
            request(.sessionsList, .init(metadataFilter: [.init(key: "run.attempt", value: "3")])),
            host: host)
        #expect(match.result?.sessions?.count == 1)
    }

    @Test func metadataIsNeverInferredFromProcessState() {
        // Regression for the no-inference rule: a session created with no metadata
        // exposes an empty map and pushes nothing to the surface, and a process
        // exit (a Maxx-owned lifecycle change) never invents metadata.
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, surface) = makeSession(registry, host)

        let fresh = registry.handle(request(.sessionsGet, .init(id: id)), host: host)
        #expect(fresh.result?.session?.metadata.isEmpty == true)
        #expect(host.surfaces[surface]?.metadata == nil)

        host.surfaces[surface]?.alive = false
        let after = registry.handle(request(.sessionsGet, .init(id: id)), host: host)
        #expect(after.result?.session?.metadata.isEmpty == true)
        #expect(after.result?.session?.lifecycle == "exited")
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

    // MARK: - Parent-child tab groups (MAX-6)

    @Test func setParentEstablishesAndClearsEdge() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (parent, _) = makeSession(registry, host)
        let (child, _) = makeSession(registry, host)

        let set = registry.handle(
            request(.sessionsSetParent, .init(id: child, parent: parent)), host: host)
        #expect(set.ok)
        #expect(set.result?.session?.parentID == parent)

        // An empty parent clears the edge.
        let cleared = registry.handle(
            request(.sessionsSetParent, .init(id: child, parent: "")), host: host)
        #expect(cleared.ok)
        #expect(cleared.result?.session?.parentID == nil)
    }

    @Test func setParentRecordsMechanicalStreamEvents() throws {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (parent, _) = makeSession(registry, host)
        let (child, _) = makeSession(registry, host)

        _ = registry.handle(request(.sessionsSetParent, .init(id: child, parent: parent)), host: host)
        _ = registry.handle(request(.sessionsSetParent, .init(id: child, parent: "")), host: host)

        let (_, messages) = try registry.beginStreamWatch(.init(since: 0), host: host)
        let events = messages.compactMap { $0.event }
        // Maxx-owned mechanical facts (like group.joined/left), never agent-declared.
        #expect(events.contains {
            $0.name == "parent.set" && $0.message == parent && $0.sourceKind == "maxx"
        })
        #expect(events.contains { $0.name == "parent.cleared" && $0.sourceKind == "maxx" })
    }

    @Test func createWithParentEmitsParentSetStreamEvent() throws {
        // A create-time parent edge must emit the same Maxx-owned `parent.set`
        // mechanical event as `set-parent` (and as create-time `group.joined`), so
        // a supervisor replaying `stream.watch --since 0` can reconstruct
        // create-time parent edges from events rather than missing them until a
        // later re-parent.
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (parent, _) = makeSession(registry, host)
        let child = registry.handle(
            request(.sessionsCreate, .init(command: "ls", parent: parent)), host: host)
        #expect(child.result?.session?.parentID == parent)

        let (_, messages) = try registry.beginStreamWatch(.init(since: 0), host: host)
        let events = messages.compactMap { $0.event }
        #expect(events.contains {
            $0.name == "parent.set" && $0.message == parent && $0.sourceKind == "maxx"
        })
    }

    @Test func reParentingEmitsSingleParentSetForTheNewParent() throws {
        // A parent edge is single-valued, so re-parenting from P1 to P2 records one
        // `parent.set` carrying the new parent id — not a `parent.cleared` (the new
        // state still has a parent, so "cleared" would be a false claim).
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (p1, _) = makeSession(registry, host)
        let (p2, _) = makeSession(registry, host)
        let (child, _) = makeSession(registry, host)

        _ = registry.handle(request(.sessionsSetParent, .init(id: child, parent: p1)), host: host)
        let reparented = registry.handle(
            request(.sessionsSetParent, .init(id: child, parent: p2)), host: host)
        #expect(reparented.result?.session?.parentID == p2)

        let (_, messages) = try registry.beginStreamWatch(.init(since: 0), host: host)
        let parentEvents = messages.compactMap { $0.event }.filter { $0.name.hasPrefix("parent.") }
        // Two sets (p1 then p2), no cleared on the change.
        #expect(parentEvents.map(\.name) == ["parent.set", "parent.set"])
        #expect(parentEvents.last?.message == p2)
        #expect(!parentEvents.contains { $0.name == "parent.cleared" })
    }

    @Test func reSettingExistingParentIsNoOpEvenAfterParentArchived() {
        // The no-op guard runs BEFORE existence/cycle validation, so re-setting the
        // parent a child already has is a silent success regardless of the parent
        // record's later state — it never re-validates an edge already in place.
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (parent, _) = makeSession(registry, host)
        let (child, _) = makeSession(registry, host)
        _ = registry.handle(request(.sessionsSetParent, .init(id: child, parent: parent)), host: host)

        // Archive the parent (its record is retained but terminal), then re-assert
        // the same edge: still a no-op success, not a fresh validation pass.
        _ = registry.handle(request(.sessionsArchive, .init(id: parent)), host: host)
        let again = registry.handle(
            request(.sessionsSetParent, .init(id: child, parent: parent)), host: host)
        #expect(again.ok)
        #expect(again.result?.session?.parentID == parent)
    }

    @Test func setParentRejectsSelfParenting() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (child, _) = makeSession(registry, host)

        let response = registry.handle(
            request(.sessionsSetParent, .init(id: child, parent: child)), host: host)
        #expect(response.error?.code == "invalid_request")
    }

    @Test func setParentRejectsMissingParent() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (child, _) = makeSession(registry, host)

        let response = registry.handle(
            request(.sessionsSetParent, .init(id: child, parent: UUID().uuidString)), host: host)
        #expect(response.error?.code == "not_found")
    }

    @Test func setParentRejectsNonUUIDParent() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (child, _) = makeSession(registry, host)

        let response = registry.handle(
            request(.sessionsSetParent, .init(id: child, parent: "not-a-uuid")), host: host)
        #expect(response.error?.code == "invalid_request")
    }

    @Test func setParentRejectsCycle() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (a, _) = makeSession(registry, host)
        let (b, _) = makeSession(registry, host)

        // a -> b (b is a's parent). Now making a the parent of b would close a cycle.
        #expect(registry.handle(
            request(.sessionsSetParent, .init(id: a, parent: b)), host: host).ok)
        let response = registry.handle(
            request(.sessionsSetParent, .init(id: b, parent: a)), host: host)
        #expect(response.error?.code == "invalid_request")
    }

    @Test func setParentToUnchangedValueIsNoOp() throws {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (parent, _) = makeSession(registry, host)
        let (child, _) = makeSession(registry, host)

        let first = registry.handle(
            request(.sessionsSetParent, .init(id: child, parent: parent)), host: host)
        let updatedAt = first.result?.session?.updatedAt

        // Re-setting the same parent records nothing and does not bump updated_at
        // (so it cannot refresh a closed/restored record's retention recency).
        let again = registry.handle(
            request(.sessionsSetParent, .init(id: child, parent: parent)), host: host)
        #expect(again.result?.session?.updatedAt == updatedAt)

        let (_, messages) = try registry.beginStreamWatch(.init(since: 0), host: host)
        let parentSetCount = messages.compactMap { $0.event }.filter { $0.name == "parent.set" }.count
        #expect(parentSetCount == 1)
    }

    @Test func setParentDeniedForExternalSourceBeforeLookup() {
        // `set-parent` needs `groups:create`; an external source without it is
        // denied. Crucially the capability is checked BEFORE any session lookup,
        // so an unknown child id returns the same `unauthorized`, never an
        // existence-revealing `not_found`.
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (child, _) = makeSession(registry, host)

        let denied = registry.handle(
            request(.sessionsSetParent, .init(
                id: child, parent: UUID().uuidString, caller: "readonly-external")),
            host: host)
        #expect(denied.error?.code == "unauthorized")

        let deniedUnknownChild = registry.handle(
            request(.sessionsSetParent, .init(
                id: UUID().uuidString, parent: UUID().uuidString, caller: "readonly-external")),
            host: host)
        #expect(deniedUnknownChild.error?.code == "unauthorized")
    }

    @Test func listFilterByParentReturnsChildrenAndSiblings() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (parent, _) = makeSession(registry, host)
        let (childA, _) = makeSession(registry, host)
        let (childB, _) = makeSession(registry, host)
        let (loner, _) = makeSession(registry, host)

        _ = registry.handle(request(.sessionsSetParent, .init(id: childA, parent: parent)), host: host)
        _ = registry.handle(request(.sessionsSetParent, .init(id: childB, parent: parent)), host: host)

        let response = registry.handle(request(.sessionsList, .init(parent: parent)), host: host)
        let ids = Set((response.result?.sessions ?? []).map(\.sessionID))
        // Children (and thus siblings of each other) are exactly childA + childB.
        #expect(ids == [childA, childB])
        #expect(!ids.contains(parent))
        #expect(!ids.contains(loner))
    }

    @Test func listFilterByGroupReturnsMembersOnly() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let inGroup = makeGroupedSession(registry, host, group: "release")
        let (ungrouped, _) = makeSession(registry, host)

        let response = registry.handle(request(.sessionsList, .init(group: "release")), host: host)
        let ids = (response.result?.sessions ?? []).map(\.sessionID)
        #expect(ids == [inGroup.id])
        #expect(!ids.contains(ungrouped))
    }

    @Test func listRejectsNonUUIDParentFilter() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        _ = makeSession(registry, host)

        let response = registry.handle(request(.sessionsList, .init(parent: "nope")), host: host)
        #expect(response.error?.code == "invalid_request")
    }

    @Test func childEdgeSurvivesParentClose() {
        // Closing the parent is a mechanical lifecycle fact; it does NOT rewrite
        // the child's edge. The child is still listed under the (now closed)
        // parent, carrying its own lifecycle, so "active children" is a
        // client-side lifecycle filter over a preserved edge — not inference.
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (parent, parentSurface) = makeSession(registry, host)
        let (child, _) = makeSession(registry, host)
        _ = registry.handle(request(.sessionsSetParent, .init(id: child, parent: parent)), host: host)

        // User closes the parent tab out from under us.
        host.surfaces[parentSurface]?.exists = false

        let listed = registry.handle(request(.sessionsList, .init(parent: parent)), host: host)
        let children = listed.result?.sessions ?? []
        #expect(children.map(\.sessionID) == [child])
        // The edge is still readable on the child, and the closed parent reports
        // its terminal lifecycle.
        let childView = registry.handle(request(.sessionsGet, .init(id: child)), host: host)
        #expect(childView.result?.session?.parentID == parent)
        let parentView = registry.handle(request(.sessionsGet, .init(id: parent)), host: host)
        #expect(parentView.result?.session?.lifecycle == "closed")
    }

    @Test func relationshipPushedToSurfaceForGroupAndParent() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()

        // create --group pushes the group chip to the surface from the start.
        let grouped = makeGroupedSession(registry, host, group: "release")
        #expect(host.surfaces[grouped.surface]?.relationship?.group == "release")
        #expect(host.surfaces[grouped.surface]?.relationship?.isChild == false)

        // set-parent pushes the child indicator to the child's surface.
        let parent = makeSession(registry, host)
        let childSurface = UUID()
        host.nextCreateID = childSurface
        let child = registry.handle(request(.sessionsCreate, params(command: "ls")), host: host)
            .result!.session!.sessionID
        _ = registry.handle(
            request(.sessionsSetParent, .init(id: child, parent: parent.id)), host: host)
        #expect(host.surfaces[childSurface]?.relationship?.isChild == true)
    }

    @Test func ungroupedTabPushesNoRelationship() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (_, surface) = makeSession(registry, host)
        // A plain tab with no group and no parent surfaces no relationship badge,
        // so its UI is unchanged from any ordinary tab.
        #expect(host.surfaces[surface]?.relationship == nil)
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

    // MARK: - Capability policy gating of the MAX-7 surface (MAX-11 integration)

    @Test func streamWatchAllowedForReadonlyExternalSource() throws {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host)
        // Observing the stream is `tabs:list`, which `readonly-external` is
        // allowlisted for — so a watch under that source begins normally.
        let (_, messages) = try registry.beginStreamWatch(
            .init(id: id, caller: "readonly-external"), host: host)
        #expect(messages.first?.type == "hello")
    }

    @Test func streamWaitDeniedForUnknownSource() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        _ = makeGroupedSession(registry, host, group: "g")
        // An unknown source is denied by default — before the stream even begins.
        #expect(throws: ControlError.self) {
            _ = try registry.beginStreamWait(.init(group: "g", all: "exited", caller: "ghost"), host: host)
        }
    }

    @Test func setGroupDeniedForExternalSource() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host)
        // `set-group` needs `groups:create`; an external source without it is
        // denied (external callers cannot mutate by default).
        let response = registry.handle(
            request(.sessionsSetGroup, .init(id: id, group: "release", caller: "readonly-external")),
            host: host)
        #expect(response.error?.code == "unauthorized")
    }

    @Test func setGroupAllowedForDefaultLocalSource() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host)
        // The trusted first-party local source (no `--as`) holds every
        // implemented capability, including `groups:create`.
        let response = registry.handle(
            request(.sessionsSetGroup, .init(id: id, group: "release")), host: host)
        #expect(response.ok)
        #expect(response.result?.session?.group == "release")
    }

    @Test func createWithGroupRequiresGroupsCapability() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        // `trusted-automation` may `tabs:spawn` but not `groups:create`, so
        // `create --group` is denied — and no surface is spawned.
        let response = registry.handle(
            request(.sessionsCreate, .init(command: "ls", group: "release", caller: "trusted-automation")),
            host: host)
        #expect(response.error?.code == "unauthorized")
        #expect(host.createdRequests.isEmpty)
    }

    @Test func createWithoutGroupAllowedForTabsSpawnSource() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        // The same source may still spawn a plain (ungrouped) tab.
        let response = registry.handle(
            request(.sessionsCreate, .init(command: "ls", caller: "trusted-automation")),
            host: host)
        #expect(response.ok)
        #expect(host.createdRequests.count == 1)
    }

    @Test func createWithAgentTypeRequiresStateSet() {
        // Declaring an agent type at create time is gated by `state:set` (the same
        // gate as the standalone `set-agent-type` verb), so a source that may
        // spawn tabs but not declare state is denied — and no surface is spawned.
        let policy = ControlPolicy(sources: [
            ControlPolicySource(id: "spawn-only", kind: .external, allow: [.tabsSpawn])
        ])
        let registry = ControlSessionRegistry(policy: policy)
        let host = FakeControlSessionHost()
        let response = registry.handle(
            request(.sessionsCreate, .init(
                command: "ls", agentType: "claude-code", caller: "spawn-only")),
            host: host)
        #expect(response.error?.code == "unauthorized")
        #expect(host.createdRequests.isEmpty)
    }

    @Test func createWithAgentTypeAllowedWithStateSet() {
        let policy = ControlPolicy(sources: [
            ControlPolicySource(id: "declarer", kind: .external, allow: [.tabsSpawn, .stateSet])
        ])
        let registry = ControlSessionRegistry(policy: policy)
        let host = FakeControlSessionHost()
        let response = registry.handle(
            request(.sessionsCreate, .init(
                command: "ls", agentType: "claude-code", caller: "declarer")),
            host: host)
        #expect(response.ok)
        #expect(response.result?.session?.agentType == "claude-code")
    }

    @Test func createWithParentDoesNotLeakSessionExistenceWithoutGroupsCreate() {
        // A caller with `tabs:spawn` but not `groups:create` must not be able to
        // use `create --parent <id>` as an oracle for whether a session id exists.
        // An unknown id and an existing id must return the SAME error
        // (`unauthorized`) — the capability is checked before the parent lookup —
        // and neither denied request may spawn a surface.
        let policy = ControlPolicy(sources: [
            ControlPolicySource(id: "spawn-only", kind: .external, allow: [.tabsSpawn])
        ])
        let registry = ControlSessionRegistry(policy: policy)
        let host = FakeControlSessionHost()

        // Spawning a plain tab (no association) needs only `tabs:spawn`, so this
        // gives us a genuinely existing session id to probe with.
        let parent = registry.handle(
            request(.sessionsCreate, .init(command: "ls", caller: "spawn-only")), host: host)
        let existingID = parent.result?.session?.sessionID
        #expect(existingID != nil)
        #expect(host.createdRequests.count == 1)

        // Existing parent id → unauthorized (the association is not permitted).
        let withExisting = registry.handle(
            request(.sessionsCreate, .init(
                command: "ls", parent: existingID, caller: "spawn-only")), host: host)
        #expect(withExisting.error?.code == "unauthorized")

        // Unknown parent id → the SAME unauthorized, NOT not_found. No oracle.
        let withUnknown = registry.handle(
            request(.sessionsCreate, .init(
                command: "ls", parent: UUID().uuidString, caller: "spawn-only")), host: host)
        #expect(withUnknown.error?.code == "unauthorized")

        // Neither denied request spawned a surface — still just the one parent tab.
        #expect(host.createdRequests.count == 1)
    }

    @Test func createTimeAgentTypeIsRecordedInAuditLog() {
        // `--agent-type` at create is the same explicit declared fact as the
        // standalone `set-agent-type`, so it must land in the session audit log
        // (events / watch) with its source — not only as an initialized field.
        // Otherwise a supervisor sees it only if the agent re-declares it.
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let created = registry.handle(
            request(.sessionsCreate, .init(
                command: "claude", source: "operator", agentType: "claude-code")),
            host: host)
        #expect(created.ok)
        #expect(created.result?.session?.agentType == "claude-code")
        let id = created.result?.session?.sessionID

        let log = registry.handle(request(.sessionsEvents, .init(id: id)), host: host)
        let entry = log.result?.events?.first { $0.name == "agent_type" }
        #expect(entry?.kind == "metadata")
        #expect(entry?.message == "claude-code")
        #expect(entry?.source == "operator")
    }

    // MARK: - Connector launch glue (MAX-14)

    /// Policy decision (MAX-14): create-time metadata rides under `tabs:spawn`,
    /// not `metadata:set`. It is part of the atomic spawn request — an explicit
    /// caller declaration captured as the tab is created — not the post-create
    /// agent-metadata write surface (`set-metadata`/`update`) that `metadata:set`
    /// gates. So a webhook source that may spawn but not set metadata can still
    /// attach connector provenance at create time.
    @Test func createTimeMetadataRidesUnderTabsSpawnNotMetadataSet() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        // `trusted-automation` holds `tabs:spawn` but NOT `metadata:set`.
        let response = registry.handle(
            request(.sessionsCreate, .init(
                command: "claude",
                metadata: [
                    "connector": .string("linear"),
                    "connector.event_id": .string("evt-1"),
                ],
                caller: "trusted-automation")),
            host: host)
        #expect(response.ok)
        #expect(host.createdRequests.count == 1)
        #expect(response.result?.session?.metadata["connector"] == .string("linear"))
        // Surfaced for display from the start — a metadata-only post-create write
        // by the same source would instead be denied (needs `metadata:set`).
        let surfaceID = UUID(uuidString: response.result!.session!.surfaceID)!
        #expect(host.surfaces[surfaceID]?.metadata?["connector"] == .string("linear"))
    }

    /// The contrast that proves the gate is real: the same `tabs:spawn`-only
    /// source is denied a *post-create* metadata write, which requires
    /// `metadata:set`. Create-time metadata and the metadata-write surface are
    /// gated differently, on purpose.
    @Test func postCreateMetadataWriteDeniedWithoutMetadataSet() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let surfaceID = UUID()
        host.nextCreateID = surfaceID
        let created = registry.handle(
            request(.sessionsCreate, .init(command: "ls", caller: "trusted-automation")),
            host: host)
        let id = created.result!.session!.sessionID
        let response = registry.handle(
            request(.sessionsSetMetadata, .init(
                id: id, key: "connector", value: "linear", caller: "trusted-automation")),
            host: host)
        #expect(response.error?.code == "unauthorized")
    }

    /// A permitted caller (the trusted local source holds `groups:create`) creates
    /// a connector-style grouped launch — provenance metadata plus a supervisor
    /// group — and a supervisor watching the group observes BOTH Maxx-owned
    /// lifecycle events: `created` and `group.joined`. Coordination rides on
    /// explicit mechanical events, never inferred from output/branch/path/idle.
    @Test func connectorGroupedLaunchIsObservableViaStreamWatch() throws {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let surfaceID = UUID()
        host.nextCreateID = surfaceID

        let response = registry.handle(
            request(.sessionsCreate, .init(
                command: "claude",
                metadata: [
                    "connector": .string("linear"),
                    "connector.event_id": .string("evt-9"),
                ],
                group: "release-MAX-14")),
            host: host)
        #expect(response.ok)
        let id = response.result!.session!.sessionID
        #expect(response.result?.session?.group == "release-MAX-14")
        #expect(response.result?.session?.metadata["connector"] == .string("linear"))

        let (_, messages) = try registry.beginStreamWatch(
            .init(since: 0, group: "release-MAX-14"), host: host)
        let events = messages.compactMap { $0.event }
        #expect(events.contains {
            $0.name == "created" && $0.sourceKind == "maxx"
                && $0.sessionID == id && $0.group == "release-MAX-14"
        })
        #expect(events.contains {
            $0.name == "group.joined" && $0.sourceKind == "maxx"
                && $0.sessionID == id && $0.group == "release-MAX-14"
        })
        // Create-time metadata is stored and shown but emits NO stream event: a
        // create surfaces only the mechanical `created`/`group.joined`. A
        // supervisor must read the provenance from the snapshot/get/list, never
        // wait on a `kind: metadata` event that a create never produces.
        #expect(!events.contains { $0.kind == "metadata" })
    }

    /// A caller without `groups:create` cannot create a grouped connector launch:
    /// the secondary group check runs before the surface is spawned, so there is
    /// no tab AND nothing on the event stream — the denied launch leaves no trace.
    @Test func connectorGroupedLaunchDeniedLeavesNoTabAndNoStreamEvent() throws {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let response = registry.handle(
            request(.sessionsCreate, .init(
                command: "claude",
                metadata: ["connector": .string("linear")],
                group: "release-MAX-14",
                caller: "trusted-automation")),
            host: host)
        #expect(response.error?.code == "unauthorized")
        #expect(host.createdRequests.isEmpty)

        // Nothing reached the bus: a group watch from cursor 0 sees no event.
        let (_, messages) = try registry.beginStreamWatch(
            .init(since: 0, group: "release-MAX-14"), host: host)
        #expect(messages.compactMap { $0.event }.isEmpty)
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
        // Integer literals decode to `.integer` (exact), non-integers to `.number`.
        let value = try ControlJSONValue.parse(#"{"a":[1,true,"x"],"b":null,"c":1.5}"#)
        #expect(value == .object([
            "a": .array([.integer(1), .bool(true), .string("x")]),
            "b": .null,
            "c": .number(1.5),
        ]))
    }

    @Test func roundTripsThroughCoding() throws {
        let value = ControlJSONValue.object(["n": .integer(42), "f": .number(1.5), "s": .string("hi")])
        let data = try JSONEncoder().encode(value)
        let decoded = try JSONDecoder().decode(ControlJSONValue.self, from: data)
        #expect(decoded == value)
    }

    @Test func parsesLargeIntegersWithoutPrecisionLoss() throws {
        // 2^53 + 1 is the canonical value a Double cannot represent; it must
        // survive parse → serialize byte-for-byte (regression for verbatim
        // metadata corruption).
        let value = try ControlJSONValue.parse("9007199254740993")
        #expect(value == .integer(9_007_199_254_740_993))
        #expect(value.serializedJSON == "9007199254740993")
        #expect(value.displayString == "9007199254740993")
        // Int64.max also round-trips.
        let max = try ControlJSONValue.parse("9223372036854775807")
        #expect(max == .integer(Int64.max))
        #expect(max.serializedJSON == "9223372036854775807")
    }

    @Test func rejectsMalformedJSON() {
        #expect(throws: ControlError.self) { _ = try ControlJSONValue.parse("{nope") }
    }

    @Test func displayStringShowsBareStringsUnquoted() {
        // A bare string renders as itself; structured/scalar values render as
        // compact JSON. Used for the metadata chip and basic list filtering.
        #expect(ControlJSONValue.string("org/repo").displayString == "org/repo")
        #expect(ControlJSONValue.number(3).displayString == "3")
        #expect(ControlJSONValue.bool(true).displayString == "true")
        #expect(ControlJSONValue.array([.number(1), .number(2)]).displayString == "[1,2]")
    }

    @Test func serializedByteCountCountsScalarsAndStructures() {
        // Scalars are measured even though JSONEncoder rejects top-level fragments.
        #expect(ControlJSONValue.string("ab").serializedByteCount == 4) // "ab"
        #expect(ControlJSONValue.number(1).serializedByteCount == 1)
        #expect(ControlJSONValue.object(["a": .number(1)]).serializedByteCount == #"{"a":1}"#.utf8.count)
    }

    @Test func serializedJSONSortsObjectKeysDeterministically() {
        // Object keys serialize in sorted order, so display and `list` filtering
        // on object values are stable regardless of Dictionary hashing.
        let value = ControlJSONValue.object(["b": .number(2), "a": .number(1)])
        #expect(value.serializedJSON == #"{"a":1,"b":2}"#)
        #expect(value.displayString == #"{"a":1,"b":2}"#)
    }
}
