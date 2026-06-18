@testable import Ghostty
import Foundation
import Testing

// Tests for the MAX-11 capability / policy enforcement model: the pure evaluator
// (`ControlPolicy`), the method→capability mapping, and end-to-end enforcement
// through `ControlSessionRegistry` (allow / deny / confirm / once-per-source),
// plus the `policy.check` diagnostic and the no-inference guarantee.

// MARK: - Pure evaluator

@MainActor
struct ControlPolicyEvaluatorTests {
    private let policy = ControlPolicy.default

    private func decide(
        _ caller: String?,
        _ capability: ControlCapability,
        _ target: ControlTarget = .none
    ) -> ControlPolicyDecision {
        policy.evaluate(source: policy.resolve(caller), capability: capability, target: target)
    }

    @Test func trustedLocalAllowsEveryImplementedCapability() {
        for capability in ControlCapability.allImplemented {
            #expect(decide("local-cli", capability) == .allow)
            #expect(decide(nil, capability) == .allow)  // omitted caller == local-cli
        }
    }

    @Test func unknownSourceIsDeniedEvenForReads() {
        #expect(decide("ghost", .tabsList) == .deny("unknown source 'ghost' is not in the policy"))
        if case .deny = decide("ghost", .tabsSpawn) {} else { Issue.record("expected deny") }
    }

    @Test func externalSourceCannotMutateButMayReadWhenAllowlisted() {
        // readonly-external explicitly allows tabs:list…
        #expect(decide("readonly-external", .tabsList) == .allow)
        // …but every mutation falls to the external deny default.
        for mutation in [ControlCapability.tabsSpawn, .tabsClose, .inputSend, .keysPress, .stateSet] {
            if case .deny = decide("readonly-external", mutation) {} else {
                Issue.record("expected deny for \(mutation.rawValue)")
            }
        }
    }

    @Test func webhookSourceGetsOnlyItsNarrowAllowlist() {
        #expect(decide("trusted-automation", .tabsSpawn) == .allow)
        #expect(decide("trusted-automation", .stateSet) == .allow)
        // Not granted: input, close, list — all deny by the external default.
        if case .deny = decide("trusted-automation", .inputSend) {} else { Issue.record("expected deny") }
        if case .deny = decide("trusted-automation", .tabsClose) {} else { Issue.record("expected deny") }
        if case .deny = decide("trusted-automation", .tabsList) {} else { Issue.record("expected deny") }
    }

    @Test func localPromptConfirmsMutationsButAllowsReads() {
        #expect(decide("local-prompt", .tabsList) == .allow)
        if case .confirm = decide("local-prompt", .inputSend, .session("S1")) {} else {
            Issue.record("expected confirm")
        }
        if case .confirm = decide("local-prompt", .tabsClose) {} else { Issue.record("expected confirm") }
    }

    @Test func outputReadIsDeniedForEveryoneEvenIfAllowlisted() {
        // Sensitive + unimplemented: denied for the trusted local source…
        if case .deny = decide("local-cli", .outputRead) {} else { Issue.record("expected deny") }
        // …and even a source that explicitly allowlists it is denied (unavailable).
        let optedIn = ControlPolicy(sources: [
            ControlPolicySource(id: "reader", kind: .local, allow: [.outputRead])
        ])
        let d = optedIn.evaluate(
            source: optedIn.resolve("reader"), capability: .outputRead, target: .none)
        if case let .deny(reason) = d {
            #expect(reason.contains("not available"))
        } else {
            Issue.record("expected deny")
        }
    }

    @Test func unimplementedCapabilitiesAreAlwaysDenied() {
        // `groups:create` became implemented with MAX-7, so it is no longer in
        // this set; `groups:list` and `automation:trigger` remain method-less.
        for capability in [ControlCapability.groupsList, .automationTrigger] {
            if case .deny = decide("local-cli", capability) {} else {
                Issue.record("expected deny for \(capability.rawValue)")
            }
        }
    }

    @Test func defaultsApplyToUnlistedLocalCapabilities() {
        // A local source with an empty allowlist: reads allowed, mutations confirm.
        let custom = ControlPolicy(sources: [
            ControlPolicySource(id: "bare-local", kind: .local)
        ])
        #expect(custom.evaluate(
            source: custom.resolve("bare-local"), capability: .tabsList, target: .none) == .allow)
        if case .confirm = custom.evaluate(
            source: custom.resolve("bare-local"), capability: .tabsSpawn, target: .none) {} else {
            Issue.record("expected confirm")
        }
    }

    @Test func confirmationPromptNamesSourceActionTargetConsequence() {
        guard case let .confirm(prompt) = decide("local-prompt", .tabsClose, .session("S-42")) else {
            Issue.record("expected confirm")
            return
        }
        #expect(prompt.contains("local-prompt"))     // source
        #expect(prompt.contains("close"))            // action
        #expect(prompt.contains("session S-42"))     // target
        #expect(prompt.contains("tabs:close"))       // capability id
        #expect(prompt.contains("ends the session")) // consequence
    }
}

// MARK: - Configured policy sources

@MainActor
struct ControlPolicyConfigTests {
    private let linearWebhookConfig = """
        {
          "version": 1,
          "sources": [
            {
              "id": "linear-webhook",
              "kind": "webhook",
              "allow": ["tabs:spawn", "groups:create", "state:set"],
              "confirm": ["input:send"],
              "confirm_scope": "once_per_source"
            }
          ]
        }
        """

    private func configuredPolicy() throws -> ControlPolicy {
        try ControlPolicyConfigLoader.policy(from: Data(linearWebhookConfig.utf8))
    }

    @Test func configAddsWebhookSourceBesideSafeBuiltIns() throws {
        let policy = try configuredPolicy()

        #expect(policy.evaluate(
            source: policy.resolve("linear-webhook"),
            capability: .groupsCreate,
            target: .newSurface("tab")) == .allow)
        #expect(policy.evaluate(
            source: policy.resolve("linear-webhook"),
            capability: .stateSet,
            target: .none) == .allow)

        if case .deny = policy.evaluate(
            source: policy.resolve("trusted-automation"),
            capability: .groupsCreate,
            target: .newSurface("tab")) {
        } else {
            Issue.record("built-in trusted-automation must remain narrow")
        }

        let source = policy.sourceViews.first { $0.id == "linear-webhook" }
        #expect(source?.kind == "webhook")
        #expect(source?.allow.contains("groups:create") == true)
        #expect(source?.confirm == ["input:send"])
        #expect(source?.confirmScope == "once_per_source")
    }

    @Test func configRejectsReservedSourcesAndLoadFailureFallsBackSafely() throws {
        let invalid = """
            {
              "sources": [
                {
                  "id": "trusted-automation",
                  "kind": "webhook",
                  "allow": ["tabs:spawn", "groups:create"]
                }
              ]
            }
            """

        #expect(throws: ControlPolicyConfigError.reservedSourceID("trusted-automation")) {
            _ = try ControlPolicyConfigLoader.policy(from: Data(invalid.utf8))
        }

        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(
            at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let file = dir.appendingPathComponent("control-policy.json", isDirectory: false)
        try Data(invalid.utf8).write(to: file)

        let fallback = ControlPolicyConfigLoader.loadOrDefault(fileURL: file)
        if case .deny = fallback.evaluate(
            source: fallback.resolve("trusted-automation"),
            capability: .groupsCreate,
            target: .newSurface("tab")) {
        } else {
            Issue.record("invalid config fallback must not broaden trusted-automation")
        }
        if case .deny = fallback.evaluate(
            source: fallback.resolve("linear-webhook"),
            capability: .groupsCreate,
            target: .newSurface("tab")) {
        } else {
            Issue.record("invalid config fallback must not create configured sources")
        }
    }

    @Test func configuredWebhookCanCreateGroupedLaunch() throws {
        let registry = ControlSessionRegistry(policy: try configuredPolicy())
        let host = FakeControlSessionHost()

        let response = registry.handle(
            .init(token: "t", method: .sessionsCreate, params: .init(
                command: "claude",
                group: "issue-MAX-16",
                caller: "linear-webhook")),
            host: host)

        #expect(response.ok)
        #expect(response.result?.session?.group == "issue-MAX-16")
        #expect(host.createdRequests.count == 1)
    }

    @Test func configuredWebhookWithoutGroupsCreateCannotCreateGroupedLaunch() throws {
        let json = """
            {
              "sources": [
                {
                  "id": "spawn-only-webhook",
                  "kind": "webhook",
                  "allow": ["tabs:spawn"]
                }
              ]
            }
            """
        let policy = try ControlPolicyConfigLoader.policy(from: Data(json.utf8))
        let registry = ControlSessionRegistry(policy: policy)
        let host = FakeControlSessionHost()

        let response = registry.handle(
            .init(token: "t", method: .sessionsCreate, params: .init(
                command: "claude",
                group: "issue-MAX-16",
                caller: "spawn-only-webhook")),
            host: host)

        #expect(response.error?.code == ControlErrorCode.unauthorized.rawValue)
        #expect(host.createdRequests.isEmpty)
    }

    @Test func policySourcesListsActiveConfiguredSources() throws {
        let registry = ControlSessionRegistry(policy: try configuredPolicy())
        let host = FakeControlSessionHost()

        let response = registry.handle(
            .init(token: "t", method: .policySources, params: .init()),
            host: host)

        #expect(response.ok)
        let sources = response.result?.policySources ?? []
        #expect(sources.contains { $0.id == "local-cli" })
        #expect(sources.contains {
            $0.id == "linear-webhook" && $0.allow.contains("groups:create")
        })
        #expect(host.createdRequests.isEmpty)
    }
}

// MARK: - Method → capability mapping

@MainActor
struct ControlPolicyMappingTests {
    private func params(
        action: String? = nil, location: String? = nil, id: String? = nil, status: String? = nil,
        metadata: [String: ControlJSONValue]? = nil
    ) -> ControlRequest.Params {
        .init(id: id, metadata: metadata, status: status, location: location, action: action)
    }

    @Test func readMethodsMapToTabsList() {
        for method in [ControlMethod.sessionsList, .sessionsGet, .sessionsEvents, .sessionsWait, .sessionsWatch] {
            #expect(ControlPolicyMapping.capability(for: method, params: params()) == .tabsList)
        }
    }

    @Test func actionSubVerbsMapToDistinctCapabilities() {
        #expect(ControlPolicyMapping.capability(for: .sessionsAction, params: params(action: "focus")) == .tabsFocus)
        #expect(ControlPolicyMapping.capability(for: .sessionsAction, params: params(action: "input")) == .inputSend)
        #expect(ControlPolicyMapping.capability(for: .sessionsAction, params: params(action: "submit")) == .inputSend)
        #expect(ControlPolicyMapping.capability(for: .sessionsAction, params: params(action: "interrupt")) == .keysPress)
        #expect(ControlPolicyMapping.capability(for: .sessionsAction, params: params(action: "cancel")) == .tabsClose)
        #expect(ControlPolicyMapping.capability(for: .sessionsAction, params: params(action: "close")) == .tabsClose)
        // Unknown/missing action is ungated so the handler returns its own error.
        #expect(ControlPolicyMapping.capability(for: .sessionsAction, params: params(action: "frob")) == nil)
        #expect(ControlPolicyMapping.capability(for: .sessionsAction, params: params()) == nil)
    }

    @Test func registerCurrentMapsToTabsSpawn() {
        #expect(ControlPolicyMapping.capability(
            for: .sessionsRegisterCurrent,
            params: params()) == .tabsSpawn)
    }

    @Test func stateDeclarationsMapToStateSet() {
        for method in [
            ControlMethod.sessionsDeclareState,
            .sessionsEmitEvent,
            .sessionsSetState,
            .sessionsSetSummary,
            .sessionsSetResult,
            .sessionsClearResult,
        ] {
            #expect(ControlPolicyMapping.capability(for: method, params: params()) == .stateSet)
        }
    }

    @Test func metadataWritesMapToMetadataSet() {
        // MAX-4 wires the deferred metadata-write gating: set/remove/clear and a
        // metadata-only update all require `metadata:set`.
        #expect(ControlPolicyMapping.capability(
            for: .sessionsSetMetadata, params: params()) == .metadataSet)
        #expect(ControlPolicyMapping.capability(
            for: .sessionsRemoveMetadata, params: params()) == .metadataSet)
        #expect(ControlPolicyMapping.capability(
            for: .sessionsClearMetadata, params: params()) == .metadataSet)
        #expect(ControlPolicyMapping.capability(
            for: .sessionsUpdate, params: params(metadata: ["k": .string("v")])) == .metadataSet)
        // A no-op update (neither status nor metadata) gates on nothing.
        #expect(ControlPolicyMapping.capability(for: .sessionsUpdate, params: params()) == nil)
        // A `status` write via update is a state mutation, gated by state:set
        // (the stronger gate even when metadata is present too).
        #expect(ControlPolicyMapping.capability(
            for: .sessionsUpdate, params: params(status: "blocked")) == .stateSet)
    }

    @Test func policyCheckIsUngated() {
        #expect(ControlPolicyMapping.capability(for: .policyCheck, params: params()) == nil)
        #expect(ControlPolicyMapping.capability(for: .policySources, params: params()) == nil)
    }

    @Test func targetsAreDescribed() {
        if case .collection = ControlPolicyMapping.target(for: .sessionsList, params: params()) {} else {
            Issue.record("expected collection")
        }
        if case let .newSurface(loc) = ControlPolicyMapping.target(
            for: .sessionsCreate, params: params(location: "window")) {
            #expect(loc == "window")
        } else {
            Issue.record("expected newSurface")
        }
        if case let .session(id) = ControlPolicyMapping.target(
            for: .sessionsAction, params: params(action: "focus", id: "S9")) {
            #expect(id == "S9")
        } else {
            Issue.record("expected session")
        }
    }
}

// MARK: - End-to-end enforcement through the registry

@MainActor
struct ControlPolicyEnforcementTests {
    private func makeRegistry(policy: ControlPolicy = .default) -> ControlSessionRegistry {
        ControlSessionRegistry(policy: policy)
    }

    /// Create a session as the trusted local source and return its id.
    private func seedSession(_ registry: ControlSessionRegistry, _ host: FakeControlSessionHost) -> String {
        let response = registry.handle(
            .init(token: "t", method: .sessionsCreate, params: .init(command: "ls")),
            host: host)
        return response.result!.session!.sessionID
    }

    @Test func unknownCallerIsDenied() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let response = registry.handle(
            .init(token: "t", method: .sessionsCreate, params: .init(command: "ls", caller: "ghost")),
            host: host)
        #expect(!response.ok)
        #expect(response.error?.code == ControlErrorCode.unauthorized.rawValue)
        // The side effect never happened.
        #expect(host.createdRequests.isEmpty)
    }

    @Test func readonlyExternalMayListButNotSpawnOrClose() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let id = seedSession(registry, host)

        // list: allowed
        let list = registry.handle(
            .init(token: "t", method: .sessionsList, params: .init(caller: "readonly-external")),
            host: host)
        #expect(list.ok)

        // spawn: denied
        let spawn = registry.handle(
            .init(token: "t", method: .sessionsCreate, params: .init(command: "ls", caller: "readonly-external")),
            host: host)
        #expect(spawn.error?.code == ControlErrorCode.unauthorized.rawValue)

        // close: denied (and the session must remain open)
        let close = registry.handle(
            .init(token: "t", method: .sessionsAction,
                  params: .init(id: id, action: "close", caller: "readonly-external")),
            host: host)
        #expect(close.error?.code == ControlErrorCode.unauthorized.rawValue)
        let surface = host.surfaces.values.first
        #expect(surface?.closed == false)
    }

    @Test func confirmRequiredThenAcknowledged() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let id = seedSession(registry, host)

        // First attempt without acknowledgement → confirmation_required, no input sent.
        let pending = registry.handle(
            .init(token: "t", method: .sessionsAction,
                  params: .init(id: id, action: "input", input: "hi\n", caller: "local-prompt")),
            host: host)
        #expect(!pending.ok)
        #expect(pending.error?.code == ControlErrorCode.confirmationRequired.rawValue)
        #expect(pending.error?.message.contains("Approve?") == true)
        #expect(host.surfaces[host.surfaces.keys.first!]?.inputs.isEmpty == true)

        // Re-send with confirm: true → proceeds.
        let confirmed = registry.handle(
            .init(token: "t", method: .sessionsAction,
                  params: .init(id: id, action: "input", input: "hi\n", caller: "local-prompt", confirm: true)),
            host: host)
        #expect(confirmed.ok)
        #expect(host.surfaces.values.first?.inputs == ["hi\n"])
    }

    @Test func webhookSourceMaySpawnAndDeclareStateButNotSendInput() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()

        let spawn = registry.handle(
            .init(token: "t", method: .sessionsCreate, params: .init(command: "ls", caller: "trusted-automation")),
            host: host)
        #expect(spawn.ok)
        let id = spawn.result!.session!.sessionID

        let state = registry.handle(
            .init(token: "t", method: .sessionsSetState,
                  params: .init(id: id, state: "running", caller: "trusted-automation")),
            host: host)
        #expect(state.ok)

        let input = registry.handle(
            .init(token: "t", method: .sessionsAction,
                  params: .init(id: id, action: "input", input: "x", caller: "trusted-automation")),
            host: host)
        #expect(input.error?.code == ControlErrorCode.unauthorized.rawValue)
    }

    @Test func updateIsGatedByMetadataSetAndStateSet() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let id = seedSession(registry, host)

        // A metadata-only update is gated by metadata:set (MAX-4), which
        // readonly-external lacks → denied.
        let metaOnly = registry.handle(
            .init(token: "t", method: .sessionsUpdate,
                  params: .init(id: id, metadata: ["k": .string("v")], caller: "readonly-external")),
            host: host)
        #expect(metaOnly.error?.code == ControlErrorCode.unauthorized.rawValue)

        // A `status` write through update is a state mutation gated by state:set,
        // which readonly-external also lacks → denied.
        let statusWrite = registry.handle(
            .init(token: "t", method: .sessionsUpdate,
                  params: .init(id: id, status: "blocked", caller: "readonly-external")),
            host: host)
        #expect(statusWrite.error?.code == ControlErrorCode.unauthorized.rawValue)

        // The trusted local source (no caller claim) can do both.
        let localMeta = registry.handle(
            .init(token: "t", method: .sessionsUpdate,
                  params: .init(id: id, metadata: ["k": .string("v")])),
            host: host)
        #expect(localMeta.ok)
    }

    @Test func resultWriteDenialHappensBeforeLookupOrMutation() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let id = seedSession(registry, host)

        let deniedExisting = registry.handle(
            .init(token: "t", method: .sessionsSetResult,
                  params: .init(id: id, result: "answer", caller: "readonly-external")),
            host: host)
        #expect(deniedExisting.error?.code == ControlErrorCode.unauthorized.rawValue)

        let after = registry.handle(
            .init(token: "t", method: .sessionsGet, params: .init(id: id)),
            host: host)
        #expect(after.result?.session?.result == nil)
        #expect(after.result?.session?.lastEventSeq == nil)

        let deniedMissing = registry.handle(
            .init(token: "t", method: .sessionsSetResult,
                  params: .init(id: UUID().uuidString, result: "answer", caller: "readonly-external")),
            host: host)
        #expect(deniedMissing.error?.code == ControlErrorCode.unauthorized.rawValue)
    }

    @Test func existingLocalFlowsAreUnchanged() {
        // No caller claim → trusted local source → everything works as before.
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let id = seedSession(registry, host)
        for action in ["focus", "input", "submit", "interrupt", "close"] {
            let response = registry.handle(
                .init(token: "t", method: .sessionsAction,
                      params: .init(id: id, action: action, input: "x")),
                host: host)
            // close/focus/interrupt/input all succeed for the trusted local source
            // (interrupt may report unsupported only if there were no process —
            // here the fake surface is alive, so it succeeds).
            #expect(response.ok, "action \(action) should be allowed for local-cli")
        }
    }

    @Test func oncePerSourceGrantSkipsLaterPrompts() {
        let policy = ControlPolicy(sources: [
            ControlPolicySource(
                id: "approver", kind: .local, allow: [.tabsSpawn],
                confirm: [.inputSend], confirmScope: .oncePerSource)
        ])
        let registry = makeRegistry(policy: policy)
        let host = FakeControlSessionHost()

        // This custom policy has only the "approver" source (local-cli is absent),
        // so seed the session as approver, which allows tabs:spawn.
        let created = registry.handle(
            .init(token: "t", method: .sessionsCreate, params: .init(command: "ls", caller: "approver")),
            host: host)
        #expect(created.ok)
        let sid = created.result!.session!.sessionID

        // First input requires confirmation.
        let first = registry.handle(
            .init(token: "t", method: .sessionsAction,
                  params: .init(id: sid, action: "input", input: "a", caller: "approver")),
            host: host)
        #expect(first.error?.code == ControlErrorCode.confirmationRequired.rawValue)

        // Acknowledge once.
        let ack = registry.handle(
            .init(token: "t", method: .sessionsAction,
                  params: .init(id: sid, action: "input", input: "a", caller: "approver", confirm: true)),
            host: host)
        #expect(ack.ok)

        // A later input from the same source no longer prompts.
        let later = registry.handle(
            .init(token: "t", method: .sessionsAction,
                  params: .init(id: sid, action: "input", input: "b", caller: "approver")),
            host: host)
        #expect(later.ok)
    }

    // MARK: policy.check diagnostic

    @Test func policyCheckReportsDecisionsWithoutSideEffects() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()

        let allow = registry.handle(
            .init(token: "t", method: .policyCheck, params: .init(caller: "local-cli", capability: "tabs:spawn")),
            host: host)
        #expect(allow.result?.policy?.decision == "allow")

        let deny = registry.handle(
            .init(token: "t", method: .policyCheck,
                  params: .init(caller: "readonly-external", capability: "tabs:close")),
            host: host)
        #expect(deny.result?.policy?.decision == "deny")
        #expect(deny.result?.policy?.reason?.isEmpty == false)

        let confirm = registry.handle(
            .init(token: "t", method: .policyCheck,
                  params: .init(caller: "local-prompt", capability: "input:send")),
            host: host)
        #expect(confirm.result?.policy?.decision == "confirm")
        #expect(confirm.result?.policy?.prompt?.contains("Approve?") == true)

        let outputRead = registry.handle(
            .init(token: "t", method: .policyCheck,
                  params: .init(caller: "readonly-external", capability: "output:read")),
            host: host)
        #expect(outputRead.result?.policy?.decision == "deny")

        // No sessions were created by any of the checks.
        #expect(registry.count == 0)
    }

    @Test func policyCheckRejectsUnknownCapability() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let response = registry.handle(
            .init(token: "t", method: .policyCheck, params: .init(capability: "bogus:cap")),
            host: host)
        #expect(response.error?.code == ControlErrorCode.invalidRequest.rawValue)
    }

    // MARK: No-inference regression

    @Test func authorizationIsIndependentOfTerminalAndProcessState() {
        // The policy decision depends only on caller + capability + target, never
        // on process liveness or any surface state. Flipping the fake surface
        // between alive/exited/closed must not change a deny/allow outcome.
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let id = seedSession(registry, host)
        let surface = host.surfaces.values.first!

        for alive in [true, false] {
            for exists in [true, false] {
                surface.alive = alive
                surface.exists = exists

                // Denied external mutation stays denied regardless of state.
                let denied = registry.handle(
                    .init(token: "t", method: .sessionsCreate,
                          params: .init(command: "ls", caller: "readonly-external")),
                    host: host)
                #expect(denied.error?.code == ControlErrorCode.unauthorized.rawValue)

                // Allowed read authorization does not depend on process state
                // (the read itself may report lifecycle, but it is never *denied*
                // for liveness reasons).
                let allowed = registry.handle(
                    .init(token: "t", method: .policyCheck,
                          params: .init(id: id, caller: "readonly-external", capability: "tabs:list")),
                    host: host)
                #expect(allowed.result?.policy?.decision == "allow")
            }
        }
    }
}
