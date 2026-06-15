@testable import Ghostty
import Foundation
import Testing

/// Tests for the persistent session registry (MAX-5): the `ControlSessionStore`
/// in isolation (round-trip, retention, migration/defaults) and the registry's
/// rehydration of persisted records across a simulated app restart.
///
/// Reuses ``FakeControlSessionHost`` / ``FakeSurfaceHandle`` from
/// `ControlSessionRegistryTests` (same test target). The no-inference guarantee
/// is expressed as a type boundary there too: nothing the store reads or writes
/// can reach terminal output.
@MainActor
struct ControlSessionPersistenceTests {
    /// A mutable clock so tests can stamp deterministic, whole-second timestamps
    /// (the on-disk ISO-8601 encoding is second-granularity, so whole seconds
    /// round-trip exactly).
    final class Clock {
        var now: Date
        init(_ now: Date) { self.now = now }
    }

    private func tempStoreURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("maxx-registry-test-\(UUID().uuidString)", isDirectory: true)
            .appendingPathComponent("registry.json", isDirectory: false)
    }

    private func request(
        _ method: ControlMethod,
        _ params: ControlRequest.Params = .init()
    ) -> ControlRequest {
        .init(token: "token", method: method, params: params)
    }

    /// A bare session value at a fixed time, with the required fields set and the
    /// rest defaulted. Tests tweak the `var` fields they care about.
    private func makeSession(
        id: UUID = UUID(),
        surfaceID: UUID = UUID(),
        at date: Date
    ) -> ControlSession {
        ControlSession(
            id: id,
            surfaceID: surfaceID,
            title: nil,
            command: nil,
            cwd: nil,
            env: [:],
            location: .tab,
            status: "created",
            metadata: [:],
            createdAt: date,
            updatedAt: date,
            canceled: false)
    }

    // MARK: - Store round-trip

    @Test func storeRoundTripsAllFields() {
        let url = tempStoreURL()
        let store = ControlSessionStore(fileURL: url)
        let date = Date(timeIntervalSince1970: 1_700_000_000)

        let id = UUID(), surfaceID = UUID(), parentID = UUID()
        var session = makeSession(id: id, surfaceID: surfaceID, at: date)
        session.parentID = parentID
        session.agentType = "claude-code"
        session.group = "release"
        session.metadata = ["linear.issue": .string("MAX-5"), "run.id": .integer(42)]
        session.workflowState = .complete
        session.workflowStateAt = date
        session.workflowStateSource = "release-agent"
        session.summary = "All green"
        session.summaryAt = date
        session.summarySource = "release-agent"
        session.lastSeenAt = date
        session.restartCount = 2
        session.appendEvent(
            kind: .workflowState, name: "complete", source: "release-agent",
            createdAt: date, pid: 4242)

        store.save([session], now: date)

        let loaded = store.load(now: date)
        #expect(loaded.count == 1)
        let restored = loaded.first
        #expect(restored?.id == id)
        #expect(restored?.surfaceID == surfaceID)
        #expect(restored?.parentID == parentID)
        #expect(restored?.agentType == "claude-code")
        #expect(restored?.group == "release")
        #expect(restored?.metadata["linear.issue"] == .string("MAX-5"))
        // Integers round-trip without becoming Doubles (verbatim metadata).
        #expect(restored?.metadata["run.id"] == .integer(42))
        #expect(restored?.workflowState == .complete)
        #expect(restored?.summary == "All green")
        #expect(restored?.restartCount == 2)
        #expect(restored?.events.count == 1)
        #expect(restored?.events.first?.name == "complete")
        // Timestamps preserved (second precision).
        #expect(restored?.createdAt == date)
        #expect(restored?.updatedAt == date)
        #expect(restored?.lastSeenAt == date)
        // Never persisted: this is a fact about the current run.
        #expect(restored?.restoredFromPreviousRun == false)
    }

    @Test func loadMissingFileReturnsEmpty() {
        let store = ControlSessionStore(fileURL: tempStoreURL())
        #expect(store.load(now: Date()).isEmpty)
    }

    @Test func loadCorruptFileReturnsEmpty() throws {
        let url = tempStoreURL()
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("{ not json".utf8).write(to: url)
        let store = ControlSessionStore(fileURL: url)
        #expect(store.load(now: Date()).isEmpty)
    }

    // MARK: - Migration / defaults

    @Test func loadAppliesDefaultsForMissingFields() throws {
        // A minimal record from a hypothetical older schema: only identity,
        // created_at, and status. Every newer field must default rather than fail.
        let url = tempStoreURL()
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let id = UUID(), surfaceID = UUID()
        let json = """
        {
          "version": 1,
          "sessions": [
            {
              "id": "\(id.uuidString)",
              "surface_id": "\(surfaceID.uuidString)",
              "created_at": "2023-11-14T22:13:20Z",
              "status": "created"
            }
          ]
        }
        """
        try Data(json.utf8).write(to: url)

        let loaded = ControlSessionStore(fileURL: url).load(now: Date(timeIntervalSince1970: 1_700_000_001))
        let session = try #require(loaded.first)
        #expect(session.id == id)
        #expect(session.agentType == nil)
        #expect(session.parentID == nil)
        #expect(session.metadata.isEmpty)
        #expect(session.location == .tab)
        #expect(session.canceled == false)
        #expect(session.nextSeq == 0)
        // updated_at defaults to created_at when absent.
        #expect(session.updatedAt == session.createdAt)
    }

    @Test func loadRefusesUnsupportedNewerVersion() throws {
        let url = tempStoreURL()
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let json = """
        { "version": 999, "sessions": [
          { "id": "\(UUID().uuidString)", "surface_id": "\(UUID().uuidString)",
            "created_at": "2023-11-14T22:13:20Z", "status": "created" } ] }
        """
        try Data(json.utf8).write(to: url)
        // A file from a newer build is ignored rather than misread.
        #expect(ControlSessionStore(fileURL: url).load(now: Date()).isEmpty)
    }

    // MARK: - Retention

    @Test func retentionDropsStaleTerminalRecordsBeyondMaxAge() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let policy = ControlRetentionPolicy(maxRecords: 100, maxAge: 1000)
        var fresh = makeSession(at: now.addingTimeInterval(-100))
        fresh.updatedAt = now.addingTimeInterval(-100)
        var staleTerminal = makeSession(at: now.addingTimeInterval(-5000))
        staleTerminal.updatedAt = now.addingTimeInterval(-5000)
        staleTerminal.canceled = true  // observed terminal → eligible for the age cutoff

        let kept = policy.apply(to: [fresh, staleTerminal], now: now)
        #expect(kept.count == 1)
        #expect(kept.first?.id == fresh.id)
    }

    @Test func retentionKeepsStaleButPotentiallyLiveRecords() {
        // A record whose last-observed lifecycle is still `running` must survive
        // the age cutoff no matter how stale its timestamps look — its surface may
        // still exist (no reconcile has refreshed `lastSeenAt` during a long idle
        // stretch), and dropping it would lose a live tab's record across restart.
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let policy = ControlRetentionPolicy(maxRecords: 100, maxAge: 1000)
        var liveButStale = makeSession(at: now.addingTimeInterval(-5000))
        liveButStale.updatedAt = now.addingTimeInterval(-5000)
        liveButStale.lastSeenAt = now.addingTimeInterval(-5000)
        liveButStale.lastObservedLifecycle = "running"

        let kept = policy.apply(to: [liveButStale], now: now)
        #expect(kept.count == 1)
        #expect(kept.first?.id == liveButStale.id)
    }

    @Test func retentionKeepsNewestUpToMaxRecords() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let policy = ControlRetentionPolicy(maxRecords: 2, maxAge: 1_000_000)
        var a = makeSession(at: now); a.updatedAt = now.addingTimeInterval(-10)
        var b = makeSession(at: now); b.updatedAt = now.addingTimeInterval(-20)
        var c = makeSession(at: now); c.updatedAt = now.addingTimeInterval(-30)

        let kept = policy.apply(to: [c, a, b], now: now)
        #expect(kept.count == 2)
        // Newest first, oldest dropped.
        #expect(kept.map(\.id) == [a.id, b.id])
    }

    @Test func retentionAppliesOnSaveAndLoad() {
        let url = tempStoreURL()
        let store = ControlSessionStore(
            fileURL: url, retention: ControlRetentionPolicy(maxRecords: 1, maxAge: 1_000_000))
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        var keep = makeSession(at: now); keep.updatedAt = now
        var drop = makeSession(at: now); drop.updatedAt = now.addingTimeInterval(-100)

        store.save([drop, keep], now: now)
        let loaded = store.load(now: now)
        #expect(loaded.count == 1)
        #expect(loaded.first?.id == keep.id)
    }

    // MARK: - Registry rehydration (simulated restart)

    /// Build a registry backed by a store at `url`, with a fixed clock and a host.
    private func makeRegistry(
        url: URL, clock: Clock
    ) -> (ControlSessionRegistry, FakeControlSessionHost) {
        let registry = ControlSessionRegistry(
            now: { clock.now }, store: ControlSessionStore(fileURL: url))
        return (registry, FakeControlSessionHost())
    }

    @Test func registryRehydratesSessionsAcrossRestart() {
        let url = tempStoreURL()
        let clock = Clock(Date(timeIntervalSince1970: 1_700_000_000))

        // First run: create a session and declare facts on it.
        let (registry1, host1) = makeRegistry(url: url, clock: clock)
        let created = registry1.handle(
            request(.sessionsCreate, .init(
                title: "Drive MAX-5", command: "zig build test",
                metadata: ["linear.issue": .string("MAX-5")],
                agentType: "claude-code")),
            host: host1)
        let sessionID = try? #require(created.result?.session?.sessionID)
        clock.now = clock.now.addingTimeInterval(5)
        _ = registry1.handle(
            request(.sessionsSetState, .init(id: sessionID, state: "complete")), host: host1)
        clock.now = clock.now.addingTimeInterval(5)
        _ = registry1.handle(
            request(.sessionsSetSummary, .init(id: sessionID, summary: "All green")), host: host1)

        // Second run: a fresh registry over the SAME file, fresh (empty) host.
        let (registry2, host2) = makeRegistry(url: url, clock: clock)
        #expect(registry2.count == 1)
        let view = registry2.handle(
            request(.sessionsGet, .init(id: sessionID)), host: host2).result?.session
        #expect(view?.sessionID == sessionID)
        #expect(view?.title == "Drive MAX-5")
        #expect(view?.command == "zig build test")
        #expect(view?.agentType == "claude-code")
        #expect(view?.metadata["linear.issue"] == .string("MAX-5"))
        #expect(view?.workflowState == "complete")
        #expect(view?.summary == "All green")
        // Restored mechanical facts: the surface is gone, so lifecycle is closed,
        // there is no pid, and the record is flagged as restored.
        #expect(view?.lifecycle == "closed")
        #expect(view?.pid == nil)
        #expect(view?.restored == true)
    }

    @Test func restoredSessionIgnoresCoincidentalLiveSurface() {
        let url = tempStoreURL()
        let clock = Clock(Date(timeIntervalSince1970: 1_700_000_000))
        let (registry1, host1) = makeRegistry(url: url, clock: clock)
        let created = registry1.handle(
            request(.sessionsCreate, .init(command: "x")), host: host1)
        let sid = created.result?.session?.sessionID
        let surfaceID = UUID(uuidString: created.result?.session?.surfaceID ?? "")

        // Second run: a fresh host that happens to host a LIVE surface reusing the
        // same UUID — as macOS window restoration would rebuild — but which this
        // control API did not create this run.
        let registry2 = ControlSessionRegistry(
            now: { clock.now }, store: ControlSessionStore(fileURL: url))
        let host2 = FakeControlSessionHost()
        if let surfaceID { host2.surfaces[surfaceID] = FakeControlSessionHost.Surface() }

        // The restored record must NOT adopt that surface: it reads as closed (not
        // running), exposes no pid, and is flagged restored.
        let view = registry2.handle(
            request(.sessionsGet, .init(id: sid)), host: host2).result?.session
        #expect(view?.lifecycle == "closed")
        #expect(view?.restored == true)
        #expect(view?.pid == nil)

        // And a control action must not reach the coincidental surface.
        let focus = registry2.handle(
            request(.sessionsAction, .init(id: sid, action: "focus")), host: host2)
        #expect(focus.error?.code == "already_ended")
        if let surfaceID { #expect(host2.surfaces[surfaceID]?.focusCount == 0) }
    }

    @Test func restoredSessionCanBeRestarted() {
        let url = tempStoreURL()
        let clock = Clock(Date(timeIntervalSince1970: 1_700_000_000))
        let (registry1, host1) = makeRegistry(url: url, clock: clock)
        let created = registry1.handle(
            request(.sessionsCreate, .init(command: "zig build test")), host: host1)
        let sessionID = try? #require(created.result?.session?.sessionID)

        let (registry2, host2) = makeRegistry(url: url, clock: clock)
        let newSurface = UUID()
        host2.nextCreateID = newSurface
        let restarted = registry2.handle(
            request(.sessionsRestart, .init(id: sessionID)), host: host2).result?.session
        // A restored record carries its command, so it is restartable: a fresh
        // surface spawns and the record is live again (no longer "restored").
        #expect(restarted?.lifecycle == "running")
        #expect(restarted?.surfaceID == newSurface.uuidString)
        #expect(restarted?.restored == nil)
        #expect(restarted?.restartCount == 1)
    }

    // MARK: - Agent type declaration

    @Test func setAgentTypeUpdatesAndPersists() {
        let url = tempStoreURL()
        let clock = Clock(Date(timeIntervalSince1970: 1_700_000_000))
        let (registry1, host1) = makeRegistry(url: url, clock: clock)
        let created = registry1.handle(request(.sessionsCreate, .init()), host: host1)
        let sessionID = try? #require(created.result?.session?.sessionID)

        let updated = registry1.handle(
            request(.sessionsSetAgentType, .init(id: sessionID, agentType: "codex")),
            host: host1).result?.session
        #expect(updated?.agentType == "codex")

        // Survives a restart.
        let (registry2, host2) = makeRegistry(url: url, clock: clock)
        let view = registry2.handle(
            request(.sessionsGet, .init(id: sessionID)), host: host2).result?.session
        #expect(view?.agentType == "codex")
    }

    @Test func setAgentTypeRejectsMissingValue() {
        let clock = Clock(Date())
        let (registry, host) = makeRegistry(url: tempStoreURL(), clock: clock)
        let created = registry.handle(request(.sessionsCreate, .init()), host: host)
        let sessionID = created.result?.session?.sessionID
        let response = registry.handle(
            request(.sessionsSetAgentType, .init(id: sessionID)), host: host)
        #expect(!response.ok)
        #expect(response.error?.code == "invalid_request")
    }

    @Test func setAgentTypeRejectsInvalidCharacters() {
        let clock = Clock(Date())
        let (registry, host) = makeRegistry(url: tempStoreURL(), clock: clock)
        let created = registry.handle(request(.sessionsCreate, .init()), host: host)
        let sessionID = created.result?.session?.sessionID
        let response = registry.handle(
            request(.sessionsSetAgentType, .init(id: sessionID, agentType: "bad type!")),
            host: host)
        #expect(response.error?.code == "invalid_request")
    }

    // MARK: - Parent association

    @Test func createWithParentPersistsEdge() {
        let url = tempStoreURL()
        let clock = Clock(Date(timeIntervalSince1970: 1_700_000_000))
        let (registry1, host1) = makeRegistry(url: url, clock: clock)
        let parent = registry1.handle(request(.sessionsCreate, .init()), host: host1)
        let parentID = try? #require(parent.result?.session?.sessionID)
        let child = registry1.handle(
            request(.sessionsCreate, .init(parent: parentID)), host: host1).result?.session
        #expect(child?.parentID == parentID)

        // Survives a restart.
        let childID = child?.sessionID
        let (registry2, host2) = makeRegistry(url: url, clock: clock)
        let view = registry2.handle(
            request(.sessionsGet, .init(id: childID)), host: host2).result?.session
        #expect(view?.parentID == parentID)
    }

    @Test func createRejectsUnknownParent() {
        let clock = Clock(Date())
        let (registry, host) = makeRegistry(url: tempStoreURL(), clock: clock)
        let response = registry.handle(
            request(.sessionsCreate, .init(parent: UUID().uuidString)), host: host)
        #expect(!response.ok)
        #expect(response.error?.code == "not_found")
    }

    @Test func createRejectsNonUUIDParent() {
        let clock = Clock(Date())
        let (registry, host) = makeRegistry(url: tempStoreURL(), clock: clock)
        let response = registry.handle(
            request(.sessionsCreate, .init(parent: "not-a-uuid")), host: host)
        #expect(response.error?.code == "invalid_request")
    }

    // MARK: - No inference on rehydration

    /// Loading a persisted record replays exactly what was stored and nothing
    /// more: a record whose mechanical fields (command, cwd, title) look like
    /// workflow signals must NOT come back with a guessed workflow state, summary,
    /// or agent type. Only explicitly declared facts survive — verbatim.
    @Test func rehydrationNeverInfersUndeclaredSemanticFields() {
        let url = tempStoreURL()
        let clock = Clock(Date(timeIntervalSince1970: 1_700_000_000))

        let (registry1, host1) = makeRegistry(url: url, clock: clock)
        // Bait: a command/cwd/title stuffed with completion-looking words. None of
        // it may become a declared field.
        let created = registry1.handle(
            request(.sessionsCreate, .init(
                title: "tests passed — ready for review",
                cwd: "/repo/feature-complete",
                command: "git commit -m done && gh pr create")),
            host: host1)
        let sessionID = try? #require(created.result?.session?.sessionID)

        let (registry2, host2) = makeRegistry(url: url, clock: clock)
        let view = registry2.handle(
            request(.sessionsGet, .init(id: sessionID)), host: host2).result?.session
        // The mechanical fields are preserved verbatim...
        #expect(view?.command == "git commit -m done && gh pr create")
        #expect(view?.title == "tests passed — ready for review")
        // ...but nothing semantic was invented from them.
        #expect(view?.workflowState == nil)
        #expect(view?.summary == nil)
        #expect(view?.agentType == nil)
    }

    // MARK: - Forward-incompatible resilience

    @Test func loadSkipsBadRecordsAndToleratesUnknownEnumValues() throws {
        // One record is structurally broken (no `id`) and must be skipped without
        // taking down the whole file; a second carries a `workflow_state` value a
        // hypothetical newer build added, which must load with the unknown state
        // dropped to nil rather than discarding the record.
        let url = tempStoreURL()
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let goodID = UUID()
        let json = """
        {
          "version": 1,
          "sessions": [
            {
              "surface_id": "\(UUID().uuidString)",
              "created_at": "2023-11-14T22:13:20Z",
              "status": "created"
            },
            {
              "id": "\(goodID.uuidString)",
              "surface_id": "\(UUID().uuidString)",
              "created_at": "2023-11-14T22:13:20Z",
              "status": "created",
              "workflow_state": "merging"
            }
          ]
        }
        """
        try Data(json.utf8).write(to: url)

        let loaded = ControlSessionStore(fileURL: url).load(now: Date(timeIntervalSince1970: 1_700_000_001))
        #expect(loaded.count == 1)
        #expect(loaded.first?.id == goodID)
        // The unrecognized state degrades to nil, never a guess.
        #expect(loaded.first?.workflowState == nil)
    }

    // MARK: - updatedAt semantics

    @Test func redundantClearMetadataDoesNotBumpUpdatedAt() {
        let clock = Clock(Date(timeIntervalSince1970: 1_700_000_000))
        let (registry, host) = makeRegistry(url: tempStoreURL(), clock: clock)
        let created = registry.handle(request(.sessionsCreate, .init()), host: host)
        let sid = created.result?.session?.sessionID
        let createdUpdatedAt = created.result?.session?.updatedAt

        // A no-op clear on an already-empty map must not advance updated_at.
        clock.now = clock.now.addingTimeInterval(60)
        let cleared = registry.handle(
            request(.sessionsClearMetadata, .init(id: sid)), host: host).result?.session
        #expect(cleared?.updatedAt == createdUpdatedAt)
    }

    @Test func mutationResponseReflectsBumpedUpdatedAt() {
        let clock = Clock(Date(timeIntervalSince1970: 1_700_000_000))
        let (registry, host) = makeRegistry(url: tempStoreURL(), clock: clock)
        let created = registry.handle(request(.sessionsCreate, .init()), host: host)
        let sid = created.result?.session?.sessionID
        let createdAt = created.result?.session?.createdAt

        clock.now = clock.now.addingTimeInterval(120)
        // The immediate mutation response must carry the bumped updated_at, not a
        // stale one (the registry stamps it through the same `store` choke point).
        let updated = registry.handle(
            request(.sessionsSetState, .init(id: sid, state: "running")), host: host).result?.session
        #expect(updated?.updatedAt != createdAt)
        #expect(updated?.createdAt == createdAt)
    }

    @Test func noOpUpdateDoesNotBumpUpdatedAt() {
        let clock = Clock(Date(timeIntervalSince1970: 1_700_000_000))
        let (registry, host) = makeRegistry(url: tempStoreURL(), clock: clock)
        let created = registry.handle(request(.sessionsCreate, .init()), host: host)
        let sid = created.result?.session?.sessionID
        let createdUpdatedAt = created.result?.session?.updatedAt

        // An update carrying neither status nor metadata is a no-op and must not
        // advance updated_at or rewrite the registry.
        clock.now = clock.now.addingTimeInterval(60)
        let updated = registry.handle(
            request(.sessionsUpdate, .init(id: sid)), host: host).result?.session
        #expect(updated?.updatedAt == createdUpdatedAt)
    }

    @Test func archivedRecordIsNotRefreshedByRestartReconcile() {
        let url = tempStoreURL()
        let clock = Clock(Date(timeIntervalSince1970: 1_700_000_000))
        let (registry1, host1) = makeRegistry(url: url, clock: clock)
        let created = registry1.handle(request(.sessionsCreate, .init()), host: host1)
        let sid = created.result?.session?.sessionID
        clock.now = clock.now.addingTimeInterval(10)
        let archived = registry1.handle(
            request(.sessionsArchive, .init(id: sid)), host: host1).result?.session
        #expect(archived?.lifecycle == "archived")
        let archivedUpdatedAt = archived?.updatedAt

        // Restart a day later. The first list() reconcile must NOT treat the
        // archived record as a lifecycle transition (its rehydrated baseline is
        // `archived`, matching what lifecycle(of:) computes), so updated_at — and
        // thus retention recency — is preserved rather than refreshed every launch.
        clock.now = clock.now.addingTimeInterval(60 * 60 * 24)
        let (registry2, host2) = makeRegistry(url: url, clock: clock)
        let listed = registry2.handle(
            request(.sessionsList, .init()), host: host2).result?.sessions?.first
        #expect(listed?.lifecycle == "archived")
        #expect(listed?.updatedAt == archivedUpdatedAt)
    }

    @Test func redundantArchiveDoesNotBumpUpdatedAt() {
        let clock = Clock(Date(timeIntervalSince1970: 1_700_000_000))
        let (registry, host) = makeRegistry(url: tempStoreURL(), clock: clock)
        let created = registry.handle(request(.sessionsCreate, .init()), host: host)
        let sid = created.result?.session?.sessionID
        let archived = registry.handle(
            request(.sessionsArchive, .init(id: sid)), host: host).result?.session
        let archivedUpdatedAt = archived?.updatedAt

        // A second archive of an already-archived session is an idempotent no-op:
        // it must not bump updated_at (which would refresh the retention recency
        // of this now-terminal record on every redundant cleanup-loop retry).
        clock.now = clock.now.addingTimeInterval(120)
        let again = registry.handle(
            request(.sessionsArchive, .init(id: sid)), host: host).result?.session
        #expect(again?.lifecycle == "archived")
        #expect(again?.updatedAt == archivedUpdatedAt)
    }

    @Test func redundantCancelDoesNotBumpUpdatedAt() {
        let clock = Clock(Date(timeIntervalSince1970: 1_700_000_000))
        let (registry, host) = makeRegistry(url: tempStoreURL(), clock: clock)
        let created = registry.handle(request(.sessionsCreate, .init()), host: host)
        let sid = created.result?.session?.sessionID
        let canceled = registry.handle(
            request(.sessionsAction, .init(id: sid, action: "cancel")), host: host).result?.session
        #expect(canceled?.lifecycle == "closed")
        let canceledUpdatedAt = canceled?.updatedAt

        // A second cancel of an already-canceled session is an idempotent no-op:
        // it must not bump updated_at (which would refresh the terminal record's
        // retention recency on every retry from a cleanup loop).
        clock.now = clock.now.addingTimeInterval(120)
        let again = registry.handle(
            request(.sessionsAction, .init(id: sid, action: "cancel")), host: host).result?.session
        #expect(again?.lifecycle == "closed")
        #expect(again?.updatedAt == canceledUpdatedAt)
    }

    @Test func cancelingAnArchivedSessionDoesNotBumpUpdatedAt() {
        let clock = Clock(Date(timeIntervalSince1970: 1_700_000_000))
        let (registry, host) = makeRegistry(url: tempStoreURL(), clock: clock)
        let created = registry.handle(request(.sessionsCreate, .init()), host: host)
        let sid = created.result?.session?.sessionID
        let archived = registry.handle(
            request(.sessionsArchive, .init(id: sid)), host: host).result?.session
        let archivedUpdatedAt = archived?.updatedAt

        // Canceling an already-archived (terminal) session is a no-op: its
        // lifecycle stays `archived` and updated_at must not advance.
        clock.now = clock.now.addingTimeInterval(120)
        let canceled = registry.handle(
            request(.sessionsAction, .init(id: sid, action: "cancel")), host: host).result?.session
        #expect(canceled?.lifecycle == "archived")
        #expect(canceled?.updatedAt == archivedUpdatedAt)
    }

    // MARK: - Newer-schema preservation (downgrade safety)

    @Test func newerVersionFileIsPreservedAcrossMutations() throws {
        let url = tempStoreURL()
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let original = "{ \"version\": 999, \"sessions\": [] }"
        try Data(original.utf8).write(to: url)

        let clock = Clock(Date(timeIntervalSince1970: 1_700_000_000))
        let (registry, host) = makeRegistry(url: url, clock: clock)
        // The newer schema loads nothing and suspends persistence for this run.
        #expect(registry.count == 0)

        // A mutation that would normally persist must NOT overwrite the newer file.
        _ = registry.handle(request(.sessionsCreate, .init()), host: host)

        let after = try Data(contentsOf: url)
        let parsed = try JSONSerialization.jsonObject(with: after) as? [String: Any]
        #expect(parsed?["version"] as? Int == 999)
        #expect((parsed?["sessions"] as? [Any])?.isEmpty == true)
    }

    @Test func loadPreservesNewerFileEvenWhenSessionsShapeIsUnparsable() throws {
        // A newer build may also change the *shape* of `sessions` (here an object
        // instead of an array). The version is read before the body, so this is
        // still recognized as newer-and-preserved rather than misread as corrupt.
        let url = tempStoreURL()
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("{ \"version\": 999, \"sessions\": { \"unexpected\": \"shape\" } }".utf8).write(to: url)

        let result = ControlSessionStore(fileURL: url).loadResult(now: Date(timeIntervalSince1970: 1_700_000_000))
        #expect(result.sessions.isEmpty)
        #expect(result.preserveExistingFile == true)
    }

    @Test func newerVersionWithIncompatibleSessionsShapeSurvivesMutation() throws {
        let url = tempStoreURL()
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let original = "{ \"version\": 999, \"sessions\": { \"unexpected\": \"shape\" } }"
        try Data(original.utf8).write(to: url)

        let clock = Clock(Date(timeIntervalSince1970: 1_700_000_000))
        let (registry, host) = makeRegistry(url: url, clock: clock)
        #expect(registry.count == 0)
        _ = registry.handle(request(.sessionsCreate, .init()), host: host)

        let after = try Data(contentsOf: url)
        let parsed = try JSONSerialization.jsonObject(with: after) as? [String: Any]
        #expect(parsed?["version"] as? Int == 999)
        // The original object-shaped `sessions` payload is untouched.
        #expect(parsed?["sessions"] is [String: Any])
    }
}
