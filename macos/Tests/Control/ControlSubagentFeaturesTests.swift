@testable import Ghostty
import Foundation
import Testing

// Regression tests for the cross-provider subagent features:
//   * declared result schema (structured-output contract)
//   * user-authored agent profiles
//   * pluggable transcript runtimes
//
// These reuse the top-level `FakeControlSessionHost` / `FakeSurfaceHandle` from
// ControlSessionRegistryTests.swift (same test target).

@MainActor
struct ControlResultSchemaTests {
    private func request(
        _ method: ControlMethod,
        _ params: ControlRequest.Params = .init()
    ) -> ControlRequest {
        .init(token: "token", method: method, params: params)
    }

    private let objectSchema = """
        {"type":"object","required":["verdict"],
         "properties":{"verdict":{"type":"string"},"confidence":{"type":"number"}}}
        """

    @Test func createWithResultSchemaSurfacesItInView() {
        let registry = ControlSessionRegistry()
        let host = FakeControlSessionHost()
        let response = registry.handle(
            request(.sessionsCreate, .init(command: "codex", resultSchema: objectSchema)),
            host: host)
        #expect(response.ok)
        #expect(response.result?.session?.resultSchema == objectSchema)
    }

    @Test func setResultRejectsNonConformingResult() {
        let registry = ControlSessionRegistry()
        let host = FakeControlSessionHost()
        let sid = registry.handle(
            request(.sessionsCreate, .init(command: "codex", resultSchema: objectSchema)),
            host: host).result?.session?.sessionID

        // A result that is not JSON at all is rejected.
        let prose = registry.handle(
            request(.sessionsSetResult, .init(id: sid, result: "looks good to me")),
            host: host)
        #expect(!prose.ok)
        #expect(prose.error?.code == "invalid_request")

        // A JSON result missing the required property is rejected.
        let missing = registry.handle(
            request(.sessionsSetResult, .init(id: sid, result: "{\"confidence\":0.9}")),
            host: host)
        #expect(!missing.ok)
        #expect(missing.error?.code == "invalid_request")

        // A wrong-typed property is rejected.
        let wrongType = registry.handle(
            request(
                .sessionsSetResult,
                .init(id: sid, result: "{\"verdict\":true}")),
            host: host)
        #expect(!wrongType.ok)

        // The session still has no result recorded (the rejected writes were no-ops).
        let view = registry.handle(request(.sessionsGet, .init(id: sid)), host: host)
        #expect(view.result?.session?.result == nil)
    }

    @Test func setResultAcceptsConformingResult() {
        let registry = ControlSessionRegistry()
        let host = FakeControlSessionHost()
        let sid = registry.handle(
            request(.sessionsCreate, .init(command: "codex", resultSchema: objectSchema)),
            host: host).result?.session?.sessionID

        let ok = registry.handle(
            request(
                .sessionsSetResult,
                .init(id: sid, result: "{\"verdict\":\"ship\",\"confidence\":0.9}")),
            host: host)
        #expect(ok.ok)
        #expect(ok.result?.session?.result == "{\"verdict\":\"ship\",\"confidence\":0.9}")
    }

    @Test func setResultUnconstrainedWhenNoSchema() {
        let registry = ControlSessionRegistry()
        let host = FakeControlSessionHost()
        let sid = registry.handle(
            request(.sessionsCreate, .init(command: "codex")),
            host: host).result?.session?.sessionID
        // No schema declared: any text is accepted.
        let ok = registry.handle(
            request(.sessionsSetResult, .init(id: sid, result: "free-form answer")),
            host: host)
        #expect(ok.ok)
        #expect(ok.result?.session?.result == "free-form answer")
    }

    @Test func setAndClearResultSchema() {
        let registry = ControlSessionRegistry()
        let host = FakeControlSessionHost()
        let sid = registry.handle(
            request(.sessionsCreate, .init(command: "codex")),
            host: host).result?.session?.sessionID

        let set = registry.handle(
            request(.sessionsSetResultSchema, .init(id: sid, resultSchema: "{\"type\":\"array\"}")),
            host: host)
        #expect(set.ok)
        #expect(set.result?.session?.resultSchema == "{\"type\":\"array\"}")

        // Now a non-array result is rejected.
        let bad = registry.handle(
            request(.sessionsSetResult, .init(id: sid, result: "{\"a\":1}")),
            host: host)
        #expect(!bad.ok)

        let cleared = registry.handle(
            request(.sessionsClearResultSchema, .init(id: sid)),
            host: host)
        #expect(cleared.ok)
        #expect(cleared.result?.session?.resultSchema == nil)

        // With the contract cleared, the previously-rejected result is accepted.
        let ok = registry.handle(
            request(.sessionsSetResult, .init(id: sid, result: "{\"a\":1}")),
            host: host)
        #expect(ok.ok)
    }

    @Test func malformedResultSchemaRejected() {
        let registry = ControlSessionRegistry()
        let host = FakeControlSessionHost()
        let sid = registry.handle(
            request(.sessionsCreate, .init(command: "codex")),
            host: host).result?.session?.sessionID

        // Not JSON.
        #expect(
            !registry.handle(
                request(.sessionsSetResultSchema, .init(id: sid, resultSchema: "not json")),
                host: host).ok)
        // Bad `type`.
        #expect(
            !registry.handle(
                request(
                    .sessionsSetResultSchema,
                    .init(id: sid, resultSchema: "{\"type\":\"widget\"}")),
                host: host).ok)
        // `required` not an array of strings.
        #expect(
            !registry.handle(
                request(
                    .sessionsSetResultSchema,
                    .init(id: sid, resultSchema: "{\"type\":\"object\",\"required\":[1]}")),
                host: host).ok)
    }

    @Test func resultSchemaRetainedAcrossRestart() {
        let registry = ControlSessionRegistry()
        let host = FakeControlSessionHost()
        let created = registry.handle(
            request(.sessionsCreate, .init(command: "codex", resultSchema: objectSchema)),
            host: host).result?.session
        let sid = created?.sessionID
        // Record a conforming result, then restart.
        _ = registry.handle(
            request(
                .sessionsSetResult,
                .init(id: sid, result: "{\"verdict\":\"ok\"}")),
            host: host)
        let restarted = registry.handle(request(.sessionsRestart, .init(id: sid)), host: host)
        #expect(restarted.ok)
        // The per-run result is cleared, but the schema contract is retained.
        #expect(restarted.result?.session?.result == nil)
        #expect(restarted.result?.session?.resultSchema == objectSchema)
    }
}

@MainActor
struct ControlAgentProfileTests {
    private func request(
        _ method: ControlMethod,
        _ params: ControlRequest.Params = .init()
    ) -> ControlRequest {
        .init(token: "token", method: method, params: params)
    }

    private func registry(
        _ profiles: [String: ControlAgentProfile]
    ) -> ControlSessionRegistry {
        ControlSessionRegistry(profiles: { profiles })
    }

    private let kimi = ControlAgentProfile(
        command: "kimi --model kimi-3 exec",
        agentType: "kimi",
        env: ["OPENROUTER_API_KEY=sk-secret", "MODE=review"],
        metadata: ["role": .string("reviewer")])

    @Test func createWithProfileExpandsFields() {
        let host = FakeControlSessionHost()
        let response = registry(["kimi-reviewer": kimi]).handle(
            request(.sessionsCreate, .init(profile: "kimi-reviewer")),
            host: host)
        #expect(response.ok)
        let session = response.result?.session
        #expect(session?.command == "kimi --model kimi-3 exec")
        #expect(session?.agentType == "kimi")
        #expect(session?.metadata["role"] == .string("reviewer"))
        // Env is applied to the spawn but never persisted in the view.
        #expect(host.createdRequests.first?.env["OPENROUTER_API_KEY"] == "sk-secret")
        #expect(host.createdRequests.first?.env["MODE"] == "review")
    }

    @Test func explicitFieldsOverrideProfile() {
        let host = FakeControlSessionHost()
        let response = registry(["kimi-reviewer": kimi]).handle(
            request(
                .sessionsCreate,
                .init(
                    command: "kimi --model kimi-3 exec 'other'",
                    env: ["MODE=build"],
                    metadata: ["role": .string("builder")],
                    agentType: "kimi-custom",
                    profile: "kimi-reviewer")),
            host: host)
        #expect(response.ok)
        let session = response.result?.session
        #expect(session?.command == "kimi --model kimi-3 exec 'other'")
        #expect(session?.agentType == "kimi-custom")
        #expect(session?.metadata["role"] == .string("builder"))
        // Caller env wins by key; the profile's other keys still apply.
        #expect(host.createdRequests.first?.env["MODE"] == "build")
        #expect(host.createdRequests.first?.env["OPENROUTER_API_KEY"] == "sk-secret")
    }

    @Test func unknownProfileRejected() {
        let host = FakeControlSessionHost()
        let response = registry(["kimi-reviewer": kimi]).handle(
            request(.sessionsCreate, .init(profile: "does-not-exist")),
            host: host)
        #expect(!response.ok)
        #expect(response.error?.code == "invalid_request")
        // A rejected profile create never spawns a surface.
        #expect(host.createdRequests.isEmpty)
    }

    @Test func profilesListOmitsEnvValues() {
        let response = registry(["kimi-reviewer": kimi]).handle(
            request(.profilesList),
            host: FakeControlSessionHost())
        #expect(response.ok)
        let profiles = response.result?.profiles
        #expect(profiles?.count == 1)
        let profile = profiles?.first
        #expect(profile?.name == "kimi-reviewer")
        #expect(profile?.command == "kimi --model kimi-3 exec")
        #expect(profile?.agentType == "kimi")
        // Only env KEY NAMES are exposed — never the secret values.
        #expect(profile?.envKeys == ["MODE", "OPENROUTER_API_KEY"])
        #expect(profile?.metadata["role"] == .string("reviewer"))
    }

    @Test func profilesListDeniedForReadonlyExternalWithoutCapability() {
        // A source without `profiles:list` cannot enumerate profiles.
        let registry = ControlSessionRegistry(policy: .default, profiles: { ["kimi": kimi] })
        let response = registry.handle(
            .init(
                token: "token", method: .profilesList,
                params: .init(caller: "readonly-external")),
            host: FakeControlSessionHost())
        #expect(!response.ok)
        #expect(response.error?.code == "unauthorized")
    }
}

@MainActor
struct ControlTranscriptRuntimeTests {
    @Test func unknownRuntimeHasNoAdapter() {
        #expect(AgentTranscriptResultExtractor.runtime(for: "kimi") == nil)
        #expect(AgentTranscriptResultExtractor.runtime(for: "grok") == nil)
    }

    @Test func builtInRuntimesResolveCaseInsensitively() {
        #expect(AgentTranscriptResultExtractor.runtime(for: "CODEX")?.name == "codex")
        #expect(AgentTranscriptResultExtractor.runtime(for: " Claude ")?.name == "claude")
    }

    /// One physical line: a JSONL transcript record is a single line, so the
    /// object must not wrap.
    private let claudeTranscriptLine =
        "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"stop_reason\":\"end_turn\",\"content\":[{\"type\":\"text\",\"text\":\"the answer\"}]}}"

    @Test func resultCaptureNilForRuntimeWithoutAdapter() {
        // Even a well-formed Claude-shaped transcript is not captured for an agent
        // with no registered adapter — no inference from another runtime's format.
        #expect(
            AgentTranscriptResultExtractor.result(
                fromJSONL: claudeTranscriptLine, agent: "kimi") == nil)
    }

    @Test func resultCaptureWorksForRegisteredRuntime() {
        #expect(
            AgentTranscriptResultExtractor.result(
                fromJSONL: claudeTranscriptLine, agent: "claude") == "the answer")
    }
}

struct ControlProfileStoreParsingTests {
    @Test func parsesVersionedEnvelope() throws {
        let json = """
            {"version":1,"profiles":{"kimi":{"command":"kimi exec","agent_type":"kimi",
             "env":["K=V"],"metadata":{"role":"reviewer"}}}}
            """
        let profiles = try ControlProfileStore.profiles(from: Data(json.utf8))
        #expect(profiles.count == 1)
        #expect(profiles["kimi"]?.command == "kimi exec")
        #expect(profiles["kimi"]?.agentType == "kimi")
        #expect(profiles["kimi"]?.env == ["K=V"])
        #expect(profiles["kimi"]?.metadata["role"] == .string("reviewer"))
    }

    @Test func parsesBareMap() throws {
        let json = """
            {"grok":{"command":"grok exec"},"codex":{"command":"codex --full-auto"}}
            """
        let profiles = try ControlProfileStore.profiles(from: Data(json.utf8))
        #expect(profiles.count == 2)
        #expect(profiles["grok"]?.command == "grok exec")
        #expect(profiles["codex"]?.command == "codex --full-auto")
    }

    @Test func rejectsUnsupportedVersion() {
        let json = "{\"version\":99,\"profiles\":{}}"
        #expect(throws: ControlProfileError.self) {
            _ = try ControlProfileStore.profiles(from: Data(json.utf8))
        }
    }

    @Test func rejectsInvalidProfileName() {
        let json = "{\"bad name!\":{\"command\":\"x\"}}"
        #expect(throws: ControlProfileError.self) {
            _ = try ControlProfileStore.profiles(from: Data(json.utf8))
        }
    }

    @Test func absentFileYieldsEmpty() {
        let store = ControlProfileStore(
            fileURL: URL(fileURLWithPath: "/tmp/does-not-exist-\(UUID().uuidString).json"))
        #expect(store.load().isEmpty)
    }
}
