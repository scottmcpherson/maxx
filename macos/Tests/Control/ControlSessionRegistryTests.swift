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
        var inputs: [String] = []
        var closed = false
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
    func interrupt() { surface.interruptCount += 1 }
    func close() {
        surface.exists = false
        surface.closed = true
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
}
