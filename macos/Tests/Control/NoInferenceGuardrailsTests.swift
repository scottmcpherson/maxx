@testable import Ghostty
import Foundation
import Testing

/// No-inference guardrails (MAX-12).
///
/// These fixtures lock down the rule documented in `docs/no-inference.md`: Maxx
/// shows mechanical facts and agent-declared facts, but never derives workflow
/// truth (complete / blocked / tests passed / PR created / ready for review)
/// from incidental signals. They feed the control registry the kinds of
/// tempting strings a contributor might be inclined to infer from — terminal
/// prose, completion words, PR URLs, process/command names, branch names,
/// paths, worktree locations — and assert the *displayed* workflow state stays
/// empty unless an explicit `set-state` / `set-summary` declaration arrives.
///
/// The registry has no access to terminal output at all (see
/// ``ControlSurfaceHandle``), so inference is impossible by construction; these
/// tests guard against a future change that would route any of these signals
/// into the displayed workflow state, and prove the positive path still works.
@MainActor
struct NoInferenceGuardrailsTests {
    private func makeRegistry() -> ControlSessionRegistry { ControlSessionRegistry() }

    private func request(
        _ method: ControlMethod,
        _ params: ControlRequest.Params = .init()
    ) -> ControlRequest {
        .init(token: "token", method: method, params: params)
    }

    /// Create a session (optionally with prose-laden inputs) and return its id
    /// plus the surface it was bound to.
    @discardableResult
    private func makeSession(
        _ registry: ControlSessionRegistry,
        _ host: FakeControlSessionHost,
        title: String? = nil,
        command: String? = "ls",
        cwd: String? = nil,
        metadata: [String: String]? = nil,
        status: String? = nil
    ) -> (id: String, surface: UUID) {
        let surfaceID = UUID()
        host.nextCreateID = surfaceID
        let created = registry.handle(
            request(.sessionsCreate, .init(
                title: title, cwd: cwd, command: command,
                metadata: metadata?.mapValues { .string($0) }, status: status)),
            host: host)
        return (created.result!.session!.sessionID, surfaceID)
    }

    private func get(
        _ registry: ControlSessionRegistry,
        _ host: FakeControlSessionHost,
        _ id: String
    ) -> ControlSessionView {
        registry.handle(request(.sessionsGet, .init(id: id)), host: host).result!.session!
    }

    // MARK: Terminal prose / completion words / PR URLs

    @Test func proseInCallerFieldsNeverBecomesWorkflowState() {
        // Strings that look like completion truth flow through every channel a
        // caller controls — title, command, cwd, metadata, free-form status.
        // None of them may surface as a displayed workflow state/summary.
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, surface) = makeSession(
            registry, host,
            title: "tests passed — done, ready for review",
            command: "claude --resume  # all green, PR https://github.com/x/y/pull/42",
            cwd: "/Users/dev/done",
            metadata: [
                "pr_url": "https://github.com/x/y/pull/42",
                "note": "implementation complete, blocked on nothing",
            ],
            status: "tests passed")

        let session = get(registry, host, id)
        // The displayed workflow state + summary are agent-declared only; none
        // was declared, so they stay nil despite all the prose above.
        #expect(session.workflowState == nil)
        #expect(session.summary == nil)
        // Nothing was pushed to the surface for display.
        #expect(host.surfaces[surface]?.declaredState == nil)
        // Mechanical facts are still shown verbatim (no semantic embellishment).
        #expect(session.lifecycle == "running")
        #expect(session.status == "tests passed")
        #expect(session.metadata["pr_url"] == .string("https://github.com/x/y/pull/42"))
    }

    @Test func freeFormDeclareStateDoesNotFeedDisplayedWorkflowState() {
        // `declare-state` is free-form machine coordination for `wait`; it writes
        // the `status` field. It must NOT be read as the displayed workflow
        // truth — only the validated `set-state` vocabulary does that.
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, surface) = makeSession(registry, host)

        for declared in ["tests:passed", "complete", "done", "ready_for_review"] {
            _ = registry.handle(
                request(.sessionsDeclareState, .init(id: id, state: declared)), host: host)
            let session = get(registry, host, id)
            #expect(session.status == declared)         // free-form status updates
            #expect(session.workflowState == nil)        // displayed state does not
            #expect(host.surfaces[surface]?.declaredState == nil)
        }
    }

    // MARK: Process / command names

    @Test func commandNameNeverImpliesWorkflowState() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        // A command whose very name reads like a finished task.
        let (id, _) = makeSession(registry, host, command: "run-tests && echo DONE")
        #expect(get(registry, host, id).workflowState == nil)
    }

    // MARK: Branch names / paths / worktree locations / PR URLs

    @Test func branchPathAndWorktreeNamesNeverImplyWorkflowState() {
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(
            registry, host,
            cwd: "/Users/dev/.worktrees/max-12-complete",
            metadata: [
                "branch": "agent/max-12-done",
                "worktree": "/Users/dev/.worktrees/ready-for-review",
                "pr": "https://github.com/x/y/pull/7",
            ])
        let session = get(registry, host, id)
        #expect(session.workflowState == nil)
        #expect(session.summary == nil)
        // The cwd and metadata are displayed as the mechanical facts they are.
        #expect(session.cwd == "/Users/dev/.worktrees/max-12-complete")
        #expect(session.metadata["branch"] == .string("agent/max-12-done"))
    }

    // MARK: Idle time / process lifecycle

    @Test func processExitAndIdleNeverProduceWorkflowState() {
        // A Maxx-owned lifecycle change (the kernel-reported process exit) is the
        // closest thing Maxx has to "the command finished". It still must not be
        // read as a completion of the *workflow*: the displayed workflow state
        // stays nil, only the mechanical `lifecycle` moves to `exited`.
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, surface) = makeSession(registry, host)

        host.surfaces[surface]?.alive = false  // process exits; time passes
        let session = get(registry, host, id)
        #expect(session.lifecycle == "exited")   // mechanical fact moves
        #expect(session.workflowState == nil)     // workflow truth does not
        #expect(host.surfaces[surface]?.declaredState == nil)
    }

    // MARK: Parent/group relationships are explicit only (MAX-6)

    @Test func parentAndGroupAreNeverInferredFromIncidentalSignals() {
        // A child tab's parent/group edges are explicit caller metadata. Tempting
        // signals — a "parent"-looking cwd, branch/worktree-style metadata, a
        // command that reads like a supervisor — must never auto-populate the
        // relationship: an undeclared session stays ungrouped with no parent, and
        // pushes no relationship badge to its surface.
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, surface) = makeSession(
            registry, host,
            command: "supervisor --children 3",
            cwd: "/Users/dev/.worktrees/release-group",
            metadata: ["group": "release", "parent": UUID().uuidString])

        let session = get(registry, host, id)
        // The `group`/`parent` *relationship* fields stay empty (the lookalike
        // values live only in the verbatim metadata map, not as edges).
        #expect(session.group == nil)
        #expect(session.parentID == nil)
        #expect(host.surfaces[surface]?.relationship == nil)
    }

    @Test func registerCurrentNeverInfersWorkflowStateFromExistingTabFacts() {
        // Registering a manually opened tab snapshots mechanical facts (surface
        // id, title, cwd), but none of that prose may become workflow truth.
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let surface = host.addManualSurface(
            token: "proof",
            title: "tests passed, ready for review",
            workingDirectory: "/Users/dev/worktrees/max-17-complete")

        let registered = registry.handle(
            request(.sessionsRegisterCurrent, .init(
                surfaceID: surface.uuidString,
                registrationToken: "proof")),
            host: host)
        let id = registered.result!.session!.sessionID
        let session = get(registry, host, id)

        #expect(session.title == "tests passed, ready for review")
        #expect(session.cwd == "/Users/dev/worktrees/max-17-complete")
        #expect(session.workflowState == nil)
        #expect(session.summary == nil)
        #expect(host.surfaces[surface]?.declaredState == nil)
    }

    @Test func explicitRelationshipRendersButGroupMetadataKeyDoesNot() {
        // The flip side: an explicit `create --group` / `set-parent` edge IS
        // surfaced, while a metadata key that merely happens to be named "group"
        // is never read as group membership.
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let parentSurface = UUID()
        host.nextCreateID = parentSurface
        let parent = registry.handle(
            request(.sessionsCreate, .init(command: "ls", group: "release")), host: host)
            .result!.session!.sessionID
        // The explicit group edge is surfaced to the parent's tab.
        #expect(host.surfaces[parentSurface]?.relationship?.group == "release")

        let childSurface = UUID()
        host.nextCreateID = childSurface
        let child = registry.handle(
            request(.sessionsCreate, .init(
                command: "ls", metadata: ["group": .string("not-a-real-group")])),
            host: host)
            .result!.session!.sessionID
        // A metadata key named "group" is not membership: no relationship badge.
        #expect(host.surfaces[childSurface]?.relationship == nil)
        #expect(get(registry, host, child).group == nil)

        // Declaring the edge explicitly is what surfaces it.
        _ = registry.handle(request(.sessionsSetParent, .init(id: child, parent: parent)), host: host)
        #expect(host.surfaces[childSurface]?.relationship?.isChild == true)
    }

    // MARK: Positive controls — declared facts DO render

    @Test func explicitDeclarationStillRendersWorkflowState() {
        // The flip side of the rule: an explicit, validated declaration is shown
        // verbatim, with its source and pushed to the surface for display.
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, surface) = makeSession(registry, host)

        let response = registry.handle(
            request(.sessionsSetState, .init(id: id, state: "complete", source: "ci-agent")),
            host: host)
        #expect(response.ok)

        let session = get(registry, host, id)
        #expect(session.workflowState == "complete")
        #expect(session.workflowStateSource == "ci-agent")
        #expect(host.surfaces[surface]?.declaredState?.state == .complete)

        _ = registry.handle(
            request(.sessionsSetSummary, .init(id: id, summary: "Merged in #42.")), host: host)
        #expect(get(registry, host, id).summary == "Merged in #42.")
        #expect(host.surfaces[surface]?.declaredState?.summary == "Merged in #42.")
    }

    @Test func unknownDeclaredWorkflowStateIsRejectedNotCoerced() {
        // A value outside the fixed vocabulary (e.g. a prose word like "done") is
        // rejected rather than coerced into some nearest state — Maxx never
        // guesses what an unrecognized declaration "probably means".
        let registry = makeRegistry()
        let host = FakeControlSessionHost()
        let (id, _) = makeSession(registry, host)
        for bad in ["done", "tests passed", "ready_for_review", "merged"] {
            let response = registry.handle(
                request(.sessionsSetState, .init(id: id, state: bad)), host: host)
            #expect(response.error?.code == "invalid_request")
            #expect(get(registry, host, id).workflowState == nil)
        }
    }
}
