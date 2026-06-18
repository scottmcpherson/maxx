@testable import Ghostty
import Foundation
import Testing

struct TerminalAgentActivityTests {
    @Test func parsesJSONEvent() throws {
        let event = try #require(TerminalAgentActivityEvent.parse(jsonLine: """
        {"version":1,"surface_id":"surface-1","agent":"claude","event":"prompt-submit","state":"running","session_id":"s1","prompt_title":"Fix codex titles","transcript_path":"/tmp/claude.jsonl"}
        """))

        #expect(event.surfaceID == "surface-1")
        #expect(event.agent == "claude")
        #expect(event.event == "prompt-submit")
        #expect(event.state == "running")
        #expect(event.sessionID == "s1")
        #expect(event.promptTitle == "Fix codex titles")
        #expect(event.transcriptPath == "/tmp/claude.jsonl")
    }

    @Test func eventProvidesDisplayTitle() throws {
        let titled = TerminalAgentActivityEvent(
            surfaceID: "surface-1",
            agent: "codex",
            event: "prompt-submit",
            state: "running",
            statusTitle: " Codex "
        )
        #expect(titled.normalizedAgent == "codex")
        #expect(titled.displayTitle == "Codex")

        let fallback = TerminalAgentActivityEvent(
            surfaceID: "surface-1",
            agent: "claude",
            event: "prompt-submit",
            state: "running"
        )
        #expect(fallback.displayTitle == "Claude Code")
    }

    @Test func malformedJSONIsIgnored() {
        #expect(TerminalAgentActivityEvent.parse(jsonLine: "{") == nil)
    }

    @Test func codexSessionIndexProvidesLatestThreadName() {
        let contents = """
        {"id":"other","thread_name":"Other"}
        {"id":"s1","thread_name":" First title "}
        {"id":"s1","thread_name":"a-new-title","updated_at":"2026-05-31T07:49:04.508506Z"}
        {"id":"s1","thread_name":"   "}
        not-json
        """

        #expect(CodexSessionIndexEntry.threadName(for: "s1", in: contents) == "a-new-title")
        #expect(CodexSessionIndexEntry.threadName(for: "missing", in: contents) == nil)
        #expect(CodexSessionIndexEntry.threadName(for: " ", in: contents) == nil)
    }

    @Test func codexTranscriptResultUsesTaskCompleteMessage() {
        let contents = """
        {"type":"event_msg","payload":{"type":"agent_message","message":"draft","phase":"analysis"}}
        {"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"fallback final"}],"phase":"final_answer"}}
        {"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"task complete final"}}
        """

        #expect(AgentTranscriptResultExtractor.result(fromJSONL: contents, agent: "codex") == "task complete final")
    }

    @Test func claudeTranscriptResultUsesAssistantEndTurnText() {
        let contents = """
        {"type":"assistant","message":{"role":"assistant","stop_reason":"tool_use","content":[{"type":"text","text":"tool request"}]}}
        {"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"Claude final"},{"type":"tool_use","name":"Edit"}]}}
        """

        #expect(AgentTranscriptResultExtractor.result(fromJSONL: contents, agent: "claude") == "Claude final")
    }

    @Test func transcriptResultIgnoresUnsupportedAgents() {
        let contents = """
        {"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"final"}]}}
        """

        #expect(AgentTranscriptResultExtractor.result(fromJSONL: contents, agent: "unknown") == nil)
    }

    @Test func transcriptResultTruncatesToByteLimit() throws {
        let contents = """
        {"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"\(String(repeating: "x", count: 200))"}}
        """

        let result = try #require(AgentTranscriptResultExtractor.result(
            fromJSONL: contents,
            agent: "codex",
            maxBytes: 80))
        #expect(result.utf8.count <= 80)
        #expect(result.contains("[Result truncated by Maxx]"))
    }

    @Test func transcriptResultReadsTranscriptPath() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("maxx-transcript-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let transcript = directory.appendingPathComponent("codex.jsonl", isDirectory: false)
        let contents = """
        {"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"file final"}}
        """
        try contents.write(to: transcript, atomically: true, encoding: .utf8)

        #expect(AgentTranscriptResultExtractor.result(
            fromTranscriptAt: transcript.path,
            agent: "codex") == "file final")
    }

    @Test func reducerMapsLifecycleStates() throws {
        var reducer = TerminalAgentActivityReducer()
        let surfaceID = "surface-1"

        #expect(reducer.apply(event("prompt-submit", state: "running"), expectedSurfaceID: surfaceID) == .running(agent: "claude"))
        #expect(reducer.apply(event("notification", state: "needsInput"), expectedSurfaceID: surfaceID) == .needsInput(agent: "claude"))
        #expect(reducer.apply(event("stop", state: "idle"), expectedSurfaceID: surfaceID) == .needsInput(agent: "claude"))
        #expect(reducer.apply(event("session-end", state: "idle"), expectedSurfaceID: surfaceID) == .idle)
    }

    @Test func reducerIgnoresStaleStop() throws {
        var reducer = TerminalAgentActivityReducer()
        let surfaceID = "surface-1"

        #expect(reducer.apply(event("prompt-submit", state: "running", sessionID: "old"), expectedSurfaceID: surfaceID) == .running(agent: "claude"))
        #expect(reducer.apply(event("prompt-submit", state: "running", sessionID: "new"), expectedSurfaceID: surfaceID) == .running(agent: "claude"))
        #expect(reducer.apply(event("stop", state: "idle", sessionID: "old"), expectedSurfaceID: surfaceID) == nil)
        #expect(reducer.state == .running(agent: "claude"))
    }

    @Test func reducerIgnoresWrongSurface() throws {
        var reducer = TerminalAgentActivityReducer()
        #expect(reducer.apply(event("prompt-submit", state: "running"), expectedSurfaceID: "other") == nil)
        #expect(reducer.state == .idle)
    }

    @Test func reducerAcknowledgesAttentionStates() throws {
        var reducer = TerminalAgentActivityReducer()

        #expect(reducer.apply(event("notification", state: "needsInput")) == .needsInput(agent: "claude"))
        #expect(reducer.acknowledgeAttention() == .idle)
        #expect(reducer.state == .idle)
        #expect(reducer.acknowledgeAttention() == nil)

        #expect(reducer.apply(event("hook-error", state: nil)) == .error(agent: "claude"))
        #expect(reducer.acknowledgeAttention() == .idle)
        #expect(reducer.state == .idle)
    }

    @Test func acknowledgedAttentionIgnoresIdleNotification() throws {
        var reducer = TerminalAgentActivityReducer()
        let surfaceID = "surface-1"

        // A turn runs, finishes, and the user acknowledges the indicator.
        #expect(reducer.apply(event("prompt-submit", state: "running", sessionID: "s1"), expectedSurfaceID: surfaceID) == .running(agent: "claude"))
        #expect(reducer.apply(event("stop", state: nil, sessionID: "s1"), expectedSurfaceID: surfaceID) == .needsInput(agent: "claude"))
        #expect(reducer.acknowledgeAttention() == .idle)

        // Claude's idle "waiting for input" Notification hook re-fires ~60s
        // later for the same session: it must not re-light the indicator.
        #expect(reducer.apply(event("notification", state: "needsInput", sessionID: "s1"), expectedSurfaceID: surfaceID) == nil)
        #expect(reducer.state == .idle)

        // A redundant stop for the same idle session is likewise ignored.
        #expect(reducer.apply(event("stop", state: nil, sessionID: "s1"), expectedSurfaceID: surfaceID) == nil)
        #expect(reducer.state == .idle)
    }

    @Test func newTurnReArmsAcknowledgedAttention() throws {
        var reducer = TerminalAgentActivityReducer()

        #expect(reducer.apply(event("prompt-submit", state: "running", sessionID: "s1")) == .running(agent: "claude"))
        #expect(reducer.apply(event("stop", state: nil, sessionID: "s1")) == .needsInput(agent: "claude"))
        #expect(reducer.acknowledgeAttention() == .idle)
        #expect(reducer.apply(event("notification", state: "needsInput", sessionID: "s1")) == nil)

        // Submitting a new prompt re-arms attention, so the next stop lights it.
        #expect(reducer.apply(event("prompt-submit", state: "running", sessionID: "s1")) == .running(agent: "claude"))
        #expect(reducer.apply(event("stop", state: nil, sessionID: "s1")) == .needsInput(agent: "claude"))
    }

    @Test func errorSurfacesAfterAcknowledgement() throws {
        var reducer = TerminalAgentActivityReducer()

        #expect(reducer.apply(event("stop", state: nil, sessionID: "s1")) == .needsInput(agent: "claude"))
        #expect(reducer.acknowledgeAttention() == .idle)

        // Errors are not suppressed by acknowledgement; they always surface.
        #expect(reducer.apply(event("hook-error", state: nil, sessionID: "s1")) == .error(agent: "claude"))
        #expect(reducer.state == .error(agent: "claude"))
    }

    @Test func reducerInterruptsRunningState() throws {
        var reducer = TerminalAgentActivityReducer()

        #expect(
            reducer.apply(event("prompt-submit", state: "running", sessionID: "s1")) ==
                .running(agent: "claude"))
        #expect(reducer.interruptRunningState() == .idle)
        #expect(reducer.state == .idle)
        #expect(reducer.interruptRunningState() == nil)
    }

    @Test func runningStateExpiresAfterTTL() throws {
        var reducer = TerminalAgentActivityReducer()
        let start = Date()

        #expect(reducer.apply(event("prompt-submit", state: "running"), now: start) == .running(agent: "claude"))
        #expect(reducer.expireRunningState(now: start.addingTimeInterval(TerminalAgentActivityReducer.runningTTL - 1)) == nil)
        #expect(reducer.expireRunningState(now: start.addingTimeInterval(TerminalAgentActivityReducer.runningTTL)) == .idle)
    }

    // MARK: - No-inference guardrails (MAX-12)
    //
    // The reducer maps only declared hook events / state values; it must never
    // derive workflow truth from prose, PR URLs, branch/path names, or elapsed
    // time. See docs/no-inference.md.

    @Test func unrecognizedEventInfersNoState() throws {
        var reducer = TerminalAgentActivityReducer()
        // A hook event whose name is not in the declared vocabulary — including
        // completion-sounding words and PR/branch-like strings — yields no
        // transition and leaves the reducer in its neutral idle baseline.
        for name in ["done", "tests-passed", "completed", "ready-for-review",
                     "https://github.com/x/y/pull/7", "agent/max-12-complete"] {
            #expect(reducer.apply(event(name, state: nil)) == nil)
            #expect(reducer.state == .idle)
        }
    }

    @Test func proseFieldsNeverProduceState() throws {
        var reducer = TerminalAgentActivityReducer()
        // Even when human-facing text fields carry completion prose, the state
        // comes only from the declared `event` / `state`. An unrecognized event
        // with a "tests passed / PR ready" title must not light any indicator.
        let prosey = TerminalAgentActivityEvent(
            surfaceID: "surface-1",
            agent: "claude",
            event: "log",
            state: nil,
            statusTitle: "All tests passed — PR ready for review",
            promptTitle: "done: shipped https://github.com/x/y/pull/9")
        #expect(reducer.apply(prosey, expectedSurfaceID: "surface-1") == nil)
        #expect(reducer.state == .idle)
    }

    @Test func declaredStateStillRendersUnderGuardrails() throws {
        // Positive control: an explicit declared `state` of "complete" maps to
        // the supported activity vocabulary (there is no "complete" activity
        // state, so "running" is the representative positive case). Explicit
        // declarations are the only thing that ever drives the indicator.
        var reducer = TerminalAgentActivityReducer()
        #expect(reducer.apply(event("status", state: "running")) == .running(agent: "claude"))
        #expect(reducer.apply(event("status", state: "error")) == .error(agent: "claude"))
    }

    @Test func elapsedTimeOnlyEverYieldsIdleNeverCompletion() throws {
        // Idle time is never a proxy for completion: the only time-based
        // transition is the stale-running safety bound, and it can only return
        // idle — never a completion/success claim.
        var reducer = TerminalAgentActivityReducer()
        let start = Date()
        #expect(reducer.apply(event("prompt-submit", state: "running"), now: start) == .running(agent: "claude"))
        let expired = reducer.expireRunningState(now: start.addingTimeInterval(TerminalAgentActivityReducer.runningTTL))
        #expect(expired == .idle)
        // Repeated expiry from idle is a no-op; time alone produces no new state.
        #expect(reducer.expireRunningState(now: start.addingTimeInterval(TerminalAgentActivityReducer.runningTTL * 10)) == nil)
        #expect(reducer.state == .idle)
    }

    @Test func sidebarIndicatorPrecedence() {
        #expect(TerminalSidebarStatusIndicatorState.derive(
            from: [.needsInput(agent: "codex"), .running(agent: "claude")],
            hasTerminalProgress: false,
            hasTerminalBell: true
        ) == .spinner(agent: "claude"))

        #expect(TerminalSidebarStatusIndicatorState.derive(
            from: [.needsInput(agent: "codex"), .error(agent: "claude")],
            hasTerminalProgress: false,
            hasTerminalBell: true
        ) == .error(agent: "claude"))

        #expect(TerminalSidebarStatusIndicatorState.derive(
            from: [.idle, .needsInput(agent: "codex")],
            hasTerminalProgress: true,
            hasTerminalBell: true
        ) == .bell(agent: "codex"))

        #expect(TerminalSidebarStatusIndicatorState.derive(
            from: [.idle],
            hasTerminalProgress: true,
            hasTerminalBell: true
        ) == .spinner(agent: "terminal"))

        #expect(TerminalSidebarStatusIndicatorState.derive(
            from: [.idle],
            hasTerminalProgress: false,
            hasTerminalBell: true
        ) == .bell(agent: "terminal"))
    }

    @Test func sidebarAttentionIndicatorsCanBeAcknowledged() {
        #expect(TerminalSidebarStatusIndicatorState.bell(agent: "codex").isAttentionIndicator)
        #expect(TerminalSidebarStatusIndicatorState.error(agent: "codex").isAttentionIndicator)
        #expect(!TerminalSidebarStatusIndicatorState.spinner(agent: "codex").isAttentionIndicator)
        #expect(!TerminalSidebarStatusIndicatorState.none.isAttentionIndicator)
    }

    @Test func selectedTabsHideAttentionIndicators() {
        #expect(TerminalSidebarStatusIndicatorState.bell(agent: "codex").visibleState(isSelected: true) == .none)
        #expect(TerminalSidebarStatusIndicatorState.error(agent: "codex").visibleState(isSelected: true) == .none)
        #expect(TerminalSidebarStatusIndicatorState.bell(agent: "codex").visibleState(isSelected: false) == .bell(agent: "codex"))
        #expect(TerminalSidebarStatusIndicatorState.error(agent: "codex").visibleState(isSelected: false) == .error(agent: "codex"))
        #expect(TerminalSidebarStatusIndicatorState.spinner(agent: "codex").visibleState(isSelected: true) == .spinner(agent: "codex"))
    }

    private func event(
        _ event: String,
        state: String?,
        sessionID: String? = nil
    ) -> TerminalAgentActivityEvent {
        TerminalAgentActivityEvent(
            surfaceID: "surface-1",
            agent: "claude",
            event: event,
            state: state,
            sessionID: sessionID
        )
    }
}
