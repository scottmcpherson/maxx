import Foundation

// Sidebar agent-activity status — the "automatic" Claude Code / Codex indicator.
//
// This is the no-inference rule applied to the sidebar (see docs/no-inference.md).
// Every state here is an agent-declared fact or a mechanical terminal fact;
// nothing is inferred from terminal output:
//
//   * Agent-declared: the agent CLI fires explicit hooks (e.g. Claude Code's
//     `UserPromptSubmit` / `Stop` / `Notification`), the bundled
//     `maxx-agent` helper maps the explicit hook *event name* to a state
//     and writes a structured JSON line, and the reducer below consumes that
//     line. The reducer recognizes only a closed vocabulary of declared event
//     names / state values; an unrecognized event yields no state (`nil`)
//     rather than a guess. It never reads PTY contents or agent prose.
//   * Mechanical: `derive(...)` also surfaces the terminal bell (BEL) and OSC
//     9/4 progress. Those are terminal escape sequences the running program
//     emits — mechanical facts Maxx observes as a terminal, attributed to
//     "terminal", not a semantic claim about an agent's workflow.
//
// The reducer must not grow heuristics that derive workflow truth (complete /
// blocked / tests passed / done) from text, timing, or names. The one
// time-based transition (`expireRunningState`) is a display-hygiene bound, not
// idle-time inference: it only clears a stale `running` spinner back to the
// neutral `idle` baseline and can never assert completion.

enum TerminalAgentActivityState: Equatable {
    case idle
    case running(agent: String)
    case needsInput(agent: String)
    case error(agent: String)

    var agent: String? {
        switch self {
        case .idle:
            nil
        case .running(let agent), .needsInput(let agent), .error(let agent):
            agent
        }
    }
}

enum TerminalSidebarStatusIndicatorState: Equatable {
    case none
    case spinner(agent: String)
    case bell(agent: String)
    case error(agent: String)

    var accessibilityDescription: String? {
        switch self {
        case .none:
            nil
        case .spinner(let agent):
            "\(Self.displayName(for: agent)) running"
        case .bell(let agent):
            agent == "terminal" ? "Terminal bell" : "\(Self.displayName(for: agent)) needs input"
        case .error(let agent):
            "\(Self.displayName(for: agent)) error"
        }
    }

    var isAttentionIndicator: Bool {
        switch self {
        case .bell, .error:
            true
        case .none, .spinner:
            false
        }
    }

    func visibleState(isSelected: Bool) -> TerminalSidebarStatusIndicatorState {
        isSelected && isAttentionIndicator ? .none : self
    }

    static func derive(
        from states: [TerminalAgentActivityState],
        hasTerminalProgress: Bool,
        hasTerminalBell: Bool
    ) -> TerminalSidebarStatusIndicatorState {
        for state in states {
            if case .running(let agent) = state {
                return .spinner(agent: agent)
            }
        }

        for state in states {
            if case .error(let agent) = state {
                return .error(agent: agent)
            }
        }

        for state in states {
            if case .needsInput(let agent) = state {
                return .bell(agent: agent)
            }
        }

        if hasTerminalProgress {
            return .spinner(agent: "terminal")
        }

        if hasTerminalBell {
            return .bell(agent: "terminal")
        }

        return .none
    }

    private static func displayName(for agent: String) -> String {
        switch agent.lowercased() {
        case "claude":
            "Claude"
        case "codex":
            "Codex"
        case "terminal":
            "Terminal"
        default:
            agent
        }
    }
}

struct TerminalAgentActivityEvent: Decodable, Equatable {
    let version: Int?
    let surfaceID: String?
    let agent: String
    let event: String?
    let state: String?
    let statusTitle: String?
    let statusValue: String?
    let sessionID: String?
    let turnID: String?
    let promptTitle: String?
    let transcriptPath: String?
    let pid: Int?
    let timestamp: TimeInterval?

    var normalizedAgent: String {
        agent.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    var displayTitle: String {
        if let statusTitle = statusTitle?.trimmingCharacters(in: .whitespacesAndNewlines),
           !statusTitle.isEmpty {
            return statusTitle
        }

        switch normalizedAgent {
        case "claude":
            return "Claude Code"
        case "codex":
            return "Codex"
        default:
            return agent.trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }

    enum CodingKeys: String, CodingKey {
        case version
        case surfaceID = "surface_id"
        case agent
        case event
        case state
        case statusTitle = "status_title"
        case statusValue = "status_value"
        case sessionID = "session_id"
        case turnID = "turn_id"
        case promptTitle = "prompt_title"
        case transcriptPath = "transcript_path"
        case pid
        case timestamp
    }

    enum AlternateCodingKeys: String, CodingKey {
        case surfaceId
        case statusTitle
        case statusValue
        case sessionId
        case turnId
        case promptTitle
        case transcriptPath
    }

    init(
        version: Int? = 1,
        surfaceID: String?,
        agent: String,
        event: String?,
        state: String?,
        statusTitle: String? = nil,
        statusValue: String? = nil,
        sessionID: String? = nil,
        turnID: String? = nil,
        promptTitle: String? = nil,
        transcriptPath: String? = nil,
        pid: Int? = nil,
        timestamp: TimeInterval? = nil
    ) {
        self.version = version
        self.surfaceID = surfaceID
        self.agent = agent
        self.event = event
        self.state = state
        self.statusTitle = statusTitle
        self.statusValue = statusValue
        self.sessionID = sessionID
        self.turnID = turnID
        self.promptTitle = promptTitle
        self.transcriptPath = transcriptPath
        self.pid = pid
        self.timestamp = timestamp
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let alternate = try decoder.container(keyedBy: AlternateCodingKeys.self)

        self.version = try container.decodeIfPresent(Int.self, forKey: .version)
        self.surfaceID = try container.decodeIfPresent(String.self, forKey: .surfaceID)
            ?? alternate.decodeIfPresent(String.self, forKey: .surfaceId)
        self.agent = try container.decode(String.self, forKey: .agent)
        self.event = try container.decodeIfPresent(String.self, forKey: .event)
        self.state = try container.decodeIfPresent(String.self, forKey: .state)
        self.statusTitle = try container.decodeIfPresent(String.self, forKey: .statusTitle)
            ?? alternate.decodeIfPresent(String.self, forKey: .statusTitle)
        self.statusValue = try container.decodeIfPresent(String.self, forKey: .statusValue)
            ?? alternate.decodeIfPresent(String.self, forKey: .statusValue)
        self.sessionID = try container.decodeIfPresent(String.self, forKey: .sessionID)
            ?? alternate.decodeIfPresent(String.self, forKey: .sessionId)
        self.turnID = try container.decodeIfPresent(String.self, forKey: .turnID)
            ?? alternate.decodeIfPresent(String.self, forKey: .turnId)
        self.promptTitle = try container.decodeIfPresent(String.self, forKey: .promptTitle)
            ?? alternate.decodeIfPresent(String.self, forKey: .promptTitle)
        self.transcriptPath = try container.decodeIfPresent(String.self, forKey: .transcriptPath)
            ?? alternate.decodeIfPresent(String.self, forKey: .transcriptPath)
        self.pid = try container.decodeIfPresent(Int.self, forKey: .pid)
        self.timestamp = try container.decodeIfPresent(TimeInterval.self, forKey: .timestamp)
    }

    static func parse(jsonLine line: String) -> TerminalAgentActivityEvent? {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let data = trimmed.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(TerminalAgentActivityEvent.self, from: data)
    }
}

enum AgentTranscriptResultExtractor {
    static let maxTranscriptTailBytes = 2 * 1024 * 1024
    private static let truncationMarker = "\n\n[Result truncated by Maxx]"

    static func result(
        fromTranscriptAt path: String,
        agent: String,
        maxBytes: Int = ControlSession.Limits.maxResultBytes,
        allowedRoots: [URL]? = nil
    ) -> String? {
        guard let transcript = validatedTranscriptURL(
            path: path,
            agent: agent,
            allowedRoots: allowedRoots)
        else { return nil }
        guard let contents = tailContents(from: transcript) else { return nil }
        return result(fromJSONL: contents, agent: agent, maxBytes: maxBytes)
    }

    static func result(
        fromJSONL contents: String,
        agent: String,
        maxBytes: Int = ControlSession.Limits.maxResultBytes
    ) -> String? {
        let normalizedAgent = agent.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard normalizedAgent == "codex" || normalizedAgent == "claude" else { return nil }

        var candidate: String?
        for rawLine in contents.components(separatedBy: .newlines) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !line.isEmpty, let data = line.data(using: .utf8) else { continue }
            guard let rawObject = try? JSONSerialization.jsonObject(with: data),
                  let object = rawObject as? [String: Any]
            else {
                continue
            }

            switch normalizedAgent {
            case "codex":
                candidate = codexResult(from: object) ?? candidate
            case "claude":
                candidate = claudeResult(from: object) ?? candidate
            default:
                break
            }
        }

        guard let candidate else { return nil }
        return bounded(candidate, maxBytes: maxBytes)
    }

    private static func validatedTranscriptURL(
        path: String,
        agent: String,
        allowedRoots: [URL]?
    ) -> URL? {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let url = URL(fileURLWithPath: trimmed)
            .standardizedFileURL
            .resolvingSymlinksInPath()
        guard url.pathExtension.lowercased() == "jsonl" else { return nil }

        let roots = allowedRoots ?? transcriptRoots(for: agent)
        guard roots.contains(where: { root in
            let resolvedRoot = root.standardizedFileURL.resolvingSymlinksInPath()
            return url.path == resolvedRoot.path
                || url.path.hasPrefix(resolvedRoot.path + "/")
        }) else { return nil }

        return url
    }

    private static func transcriptRoots(for agent: String) -> [URL] {
        let home = FileManager.default.homeDirectoryForCurrentUser
        switch agent.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "codex":
            return [
                home.appendingPathComponent(".codex/sessions", isDirectory: true),
                home.appendingPathComponent(".codex/archived_sessions", isDirectory: true),
            ]
        case "claude":
            return [
                home.appendingPathComponent(".claude/projects", isDirectory: true),
            ]
        default:
            return []
        }
    }

    private static func tailContents(from url: URL) -> String? {
        let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
        let fileSize = (attributes?[.size] as? NSNumber)?.uint64Value ?? 0
        guard let handle = try? FileHandle(forReadingFrom: url) else {
            return nil
        }
        defer { try? handle.close() }

        let tailBytes = UInt64(maxTranscriptTailBytes)
        if fileSize > tailBytes {
            handle.seek(toFileOffset: fileSize - tailBytes)
        }
        let data = handle.readDataToEndOfFile()
        return String(bytes: data, encoding: .utf8)
    }

    private static func codexResult(from object: [String: Any]) -> String? {
        let type = object["type"] as? String
        let payload = object["payload"] as? [String: Any]

        if type == "event_msg", let payload {
            switch payload["type"] as? String {
            case "task_complete":
                return payload["last_agent_message"] as? String
            case "agent_message":
                guard payload["phase"] as? String == "final_answer" else { return nil }
                return payload["message"] as? String
            default:
                return nil
            }
        }

        if type == "response_item", let payload,
           payload["type"] as? String == "message",
           payload["role"] as? String == "assistant",
           payload["phase"] as? String == "final_answer" {
            return textContent(from: payload["content"], acceptedTypes: ["output_text", "text"])
        }

        return nil
    }

    private static func claudeResult(from object: [String: Any]) -> String? {
        guard object["type"] as? String == "assistant",
              let message = object["message"] as? [String: Any],
              message["role"] as? String == "assistant"
        else { return nil }

        if let stopReason = message["stop_reason"] as? String, stopReason != "end_turn" {
            return nil
        }

        return textContent(from: message["content"], acceptedTypes: ["text"])
    }

    private static func textContent(
        from rawContent: Any?,
        acceptedTypes: Set<String>
    ) -> String? {
        guard let items = rawContent as? [[String: Any]] else { return nil }
        let parts = items.compactMap { item -> String? in
            guard let type = item["type"] as? String,
                  acceptedTypes.contains(type),
                  let text = item["text"] as? String
            else { return nil }
            return text
        }
        guard !parts.isEmpty else { return nil }
        return parts.joined(separator: "\n")
    }

    private static func bounded(_ raw: String, maxBytes: Int) -> String? {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        guard text.utf8.count > maxBytes else { return text }

        let markerBytes = truncationMarker.utf8.count
        guard maxBytes > markerBytes else { return nil }

        var bytes = Array(text.utf8.prefix(maxBytes - markerBytes))
        while !bytes.isEmpty && String(bytes: bytes, encoding: .utf8) == nil {
            bytes.removeLast()
        }
        guard let prefix = String(bytes: bytes, encoding: .utf8) else { return nil }
        return prefix + truncationMarker
    }
}

struct CodexSessionIndexEntry: Decodable, Equatable {
    let id: String
    let threadName: String?
    let updatedAt: String?

    var displayTitle: String? {
        guard let title = threadName?.trimmingCharacters(in: .whitespacesAndNewlines),
              !title.isEmpty
        else { return nil }
        return title
    }

    enum CodingKeys: String, CodingKey {
        case id
        case threadName = "thread_name"
        case updatedAt = "updated_at"
    }

    static func parse(jsonLine line: String) -> CodexSessionIndexEntry? {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let data = trimmed.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(CodexSessionIndexEntry.self, from: data)
    }

    static func threadName(for sessionID: String, in contents: String) -> String? {
        let normalizedSessionID = sessionID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedSessionID.isEmpty else { return nil }

        var title: String?
        for line in contents.components(separatedBy: .newlines) {
            guard let entry = parse(jsonLine: line),
                  entry.id == normalizedSessionID,
                  let displayTitle = entry.displayTitle
            else {
                continue
            }
            title = displayTitle
        }
        return title
    }
}

struct TerminalAgentActivityReducer {
    static let runningTTL: TimeInterval = 6 * 60 * 60

    private(set) var state: TerminalAgentActivityState = .idle
    private var activeSessionIDByAgent: [String: String] = [:]
    private var runningStartedAt: Date?

    /// Agents whose attention indicator the user has already acknowledged while
    /// the agent sits idle. Cleared when a new turn starts (a `.running`
    /// transition). Used to ignore redundant "needs input" events — notably
    /// Claude Code's idle Notification hook, which re-fires ~60s after a turn
    /// ends while it waits for input — so an acknowledged indicator does not
    /// re-light itself without any new activity.
    private var acknowledgedAgents: Set<String> = []

    mutating func apply(
        _ event: TerminalAgentActivityEvent,
        expectedSurfaceID: String? = nil,
        now: Date = Date()
    ) -> TerminalAgentActivityState? {
        if let expectedSurfaceID,
           let eventSurfaceID = event.surfaceID,
           eventSurfaceID != expectedSurfaceID {
            return nil
        }

        let agent = event.normalizedAgent
        guard !agent.isEmpty else { return nil }
        guard let nextState = Self.state(from: event, agent: agent) else { return nil }

        // Once the user has acknowledged an attention indicator, a redundant
        // "needs input" event for the same idle session must not re-light it.
        // Only a new turn re-arms attention (see the `.running` case below,
        // which clears `acknowledgedAgents`). Errors are intentionally not
        // suppressed here — they always represent new information.
        if case .needsInput = nextState, acknowledgedAgents.contains(agent) {
            return nil
        }

        if Self.isSessionBoundaryEvent(event),
           let sessionID = Self.normalized(event.sessionID),
           let activeSessionID = activeSessionIDByAgent[agent],
           activeSessionID != sessionID {
            return nil
        }

        if let sessionID = Self.normalized(event.sessionID), Self.startsOrContinuesSession(nextState) {
            activeSessionIDByAgent[agent] = sessionID
        }

        switch nextState {
        case .idle:
            activeSessionIDByAgent[agent] = nil
            guard state.agent == nil || state.agent == agent else { return state }
            state = .idle
            runningStartedAt = nil

        case .running:
            acknowledgedAgents.remove(agent)
            state = nextState
            runningStartedAt = now

        case .needsInput, .error:
            state = nextState
            runningStartedAt = nil
        }

        return state
    }

    mutating func acknowledgeAttention() -> TerminalAgentActivityState? {
        switch state {
        case .needsInput(let agent), .error(let agent):
            acknowledgedAgents.insert(agent)
            activeSessionIDByAgent[agent] = nil
            state = .idle
            runningStartedAt = nil
            return state

        case .idle, .running:
            return nil
        }
    }

    mutating func interruptRunningState() -> TerminalAgentActivityState? {
        guard case .running = state else { return nil }

        state = .idle
        runningStartedAt = nil
        return state
    }

    /// Safety bound on a stale `running` indicator: if an agent declares
    /// `running` and never closes the turn out with a further hook event, drop
    /// the spinner back to the neutral `idle` baseline after `runningTTL`. This
    /// is display hygiene, not idle-time inference — it never asserts completion
    /// or any other workflow truth (it can only ever return `.idle`). See
    /// docs/no-inference.md.
    mutating func expireRunningState(now: Date = Date()) -> TerminalAgentActivityState? {
        guard case .running = state,
              let runningStartedAt,
              now.timeIntervalSince(runningStartedAt) >= Self.runningTTL
        else {
            return nil
        }

        state = .idle
        self.runningStartedAt = nil
        return state
    }

    private static func state(
        from event: TerminalAgentActivityEvent,
        agent: String
    ) -> TerminalAgentActivityState? {
        if normalized(event.event) == "stop" {
            return .needsInput(agent: agent)
        }

        if let state = normalized(event.state) {
            switch state {
            case "running":
                return .running(agent: agent)
            case "needsinput", "needs-input", "needs_input":
                return .needsInput(agent: agent)
            case "error":
                return .error(agent: agent)
            case "idle":
                return .idle
            default:
                return nil
            }
        }

        switch normalized(event.event) {
        case "session-start":
            return .idle
        case "prompt-submit", "user-prompt-submit", "pre-tool-use":
            return .running(agent: agent)
        case "notification", "permission-request", "ask-user-question":
            return .needsInput(agent: agent)
        case "stop":
            return .needsInput(agent: agent)
        case "idle", "session-end":
            return .idle
        case "error", "failure", "failed", "hook-error":
            return .error(agent: agent)
        default:
            return nil
        }
    }

    private static func startsOrContinuesSession(_ state: TerminalAgentActivityState) -> Bool {
        switch state {
        case .idle:
            false
        case .running, .needsInput, .error:
            true
        }
    }

    private static func isSessionBoundaryEvent(_ event: TerminalAgentActivityEvent) -> Bool {
        switch normalized(event.event) {
        case "stop", "idle", "session-end":
            true
        default:
            false
        }
    }

    private static func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed.lowercased()
    }
}
