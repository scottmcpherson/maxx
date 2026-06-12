import AppKit
import SwiftUI

struct SettingsView: View {
    @ObservedObject var model: SettingsViewModel

    var body: some View {
        VStack(spacing: 0) {
            Form {
                Section("Claude Code") {
                    claudeContent
                }

                Section("Codex") {
                    codexContent
                }

                Section("Ghostty") {
                    LabeledContent("Configuration") {
                        Button("Open Config…", action: model.openGhosttyConfig)
                            .buttonStyle(.bordered)
                            .accessibilityIdentifier("MosttlySettingsGhosttyConfigButton")
                    }
                }
            }
            .formStyle(.grouped)

            Divider()

            HStack {
                Spacer()
                Button(action: model.refresh) {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .help("Re-check installed agents")
                .accessibilityIdentifier("MosttlySettingsRefreshButton")
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
        }
        .frame(minWidth: 420, minHeight: 360)
        .accessibilityIdentifier("MosttlySettingsView")
    }

    // MARK: - Claude Code

    @ViewBuilder
    private var claudeContent: some View {
        if model.claudeConfigured {
            statusRow(title: "Configured", systemImage: "checkmark.circle.fill", tint: .green)
        } else {
            statusRow(title: "Not detected", systemImage: "circle", tint: .secondary)
            LabeledContent("Claude Code CLI") {
                Button("How to Enable…", action: model.openClaudeDocs)
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("MosttlySettingsClaudeHelpButton")
            }
        }

        skillRow(
            status: model.claudeSkillStatus,
            install: model.installClaudeSkill,
            uninstall: model.uninstallClaudeSkill,
            helpText: "Lets Claude Code open new Mosttly tabs and run commands in them",
            accessibilityPrefix: "MosttlySettingsClaudeSkill")

        Picker("Agent tab permission mode", selection: $model.claudeTabPermissionMode) {
            Text("Default").tag("default")
            Text("Plan").tag("plan")
            Text("Accept Edits").tag("acceptEdits")
            Text("Auto").tag("auto")
            Text("Don't Ask").tag("dontAsk")
            Text("Bypass Permissions").tag("bypassPermissions")
        }
        .help("Permission mode for Claude Code sessions that agents start in new tabs. "
            + "Applied unless the spawning agent passes explicit permission flags.")
        .accessibilityIdentifier("MosttlySettingsClaudeTabPermissionModePicker")
    }

    // MARK: - Codex

    @ViewBuilder
    private var codexContent: some View {
        statusRow(
            title: model.codexStatus.title,
            systemImage: model.codexStatus.systemImage,
            tint: model.codexStatus.tint)

        switch model.codexStatus {
        case .installed:
            LabeledContent("Hook files") {
                Button("Reveal in Finder", action: model.revealCodexHooks)
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("MosttlySettingsRevealCodexHooksButton")
            }
            LabeledContent("Ghostty integration") {
                Button("Uninstall Hooks", action: model.uninstallCodexHooks)
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("MosttlySettingsUninstallCodexHooksButton")
            }

        case .installing:
            HStack(spacing: 8) {
                ProgressView()
                    .controlSize(.small)
                Text("Working…")
                    .foregroundStyle(.secondary)
            }

        case .notInstalled, .failed:
            LabeledContent("Ghostty integration") {
                Button("Install Hooks", action: model.installCodexHooks)
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("MosttlySettingsInstallCodexHooksButton")
            }

            if case .failed(let message) = model.codexStatus {
                Text(message)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }

        skillRow(
            status: model.codexSkillStatus,
            install: model.installCodexSkill,
            uninstall: model.uninstallCodexSkill,
            helpText: "Lets Codex open new Mosttly tabs and run commands in them",
            accessibilityPrefix: "MosttlySettingsCodexSkill")

        Picker("Agent tab sandbox mode", selection: $model.codexTabSandboxMode) {
            Text("Default").tag("default")
            Text("Read Only").tag("read-only")
            Text("Workspace Write").tag("workspace-write")
            Text("Full Auto").tag("full-auto")
            Text("Danger Full Access").tag("danger-full-access")
            Text("Bypass Approvals and Sandbox").tag("bypass")
        }
        .help("Sandbox mode for Codex sessions that agents start in new tabs. "
            + "Applied unless the spawning agent passes explicit sandbox flags.")
        .accessibilityIdentifier("MosttlySettingsCodexTabSandboxModePicker")
    }

    // MARK: - Helpers

    /// Install/remove row for the "mosttly-tabs" tab-control skill, shared by
    /// the Claude Code and Codex sections.
    @ViewBuilder
    private func skillRow(
        status: AgentInstallStatus,
        install: @escaping () -> Void,
        uninstall: @escaping () -> Void,
        helpText: String,
        accessibilityPrefix: String
    ) -> some View {
        switch status {
        case .installed:
            LabeledContent("Tab control skill") {
                Button("Remove Skill", action: uninstall)
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("\(accessibilityPrefix)RemoveButton")
            }

        case .installing:
            HStack(spacing: 8) {
                ProgressView()
                    .controlSize(.small)
                Text("Working…")
                    .foregroundStyle(.secondary)
            }

        case .notInstalled, .failed:
            LabeledContent("Tab control skill") {
                Button("Install Skill", action: install)
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("\(accessibilityPrefix)InstallButton")
            }
            .help(helpText)

            if case .failed(let message) = status {
                Text(message)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func statusRow(title: String, systemImage: String, tint: Color) -> some View {
        Label {
            Text(title)
        } icon: {
            Image(systemName: systemImage)
                .foregroundStyle(tint)
        }
    }
}

final class SettingsViewModel: ObservableObject {
    /// UserDefaults keys for the default permission mode of agent-spawned
    /// tabs. Sync with `src/agent_hook/new_tab.zig`, which reads them when
    /// spawning claude/codex without explicit permission flags.
    static let claudeTabPermissionModeKey = "agentTabClaudePermissionMode"
    static let codexTabSandboxModeKey = "agentTabCodexSandboxMode"

    @Published private(set) var claudeConfigured = false
    @Published private(set) var claudeSkillStatus: AgentInstallStatus = .notInstalled
    @Published private(set) var codexStatus: AgentInstallStatus = .notInstalled
    @Published private(set) var codexSkillStatus: AgentInstallStatus = .notInstalled

    @Published var claudeTabPermissionMode: String {
        didSet { Self.persistMode(claudeTabPermissionMode, forKey: Self.claudeTabPermissionModeKey) }
    }

    @Published var codexTabSandboxMode: String {
        didSet { Self.persistMode(codexTabSandboxMode, forKey: Self.codexTabSandboxModeKey) }
    }

    init() {
        self.claudeTabPermissionMode =
            UserDefaults.standard.string(forKey: Self.claudeTabPermissionModeKey) ?? "default"
        self.codexTabSandboxMode =
            UserDefaults.standard.string(forKey: Self.codexTabSandboxModeKey) ?? "default"
    }

    /// "default" means "no opinion", which we persist as an absent key so the
    /// helper can skip the lookup cleanly.
    private static func persistMode(_ mode: String, forKey key: String) {
        if mode == "default" {
            UserDefaults.standard.removeObject(forKey: key)
        } else {
            UserDefaults.standard.set(mode, forKey: key)
        }
    }

    func refresh() {
        claudeConfigured = CodexHooksManager.claudeConfigured()
        if claudeSkillStatus != .installing {
            claudeSkillStatus = CodexHooksManager.claudeSkillInstalled() ? .installed : .notInstalled
        }
        if codexStatus != .installing {
            codexStatus = CodexHooksManager.hooksInstalled() ? .installed : .notInstalled
        }
        if codexSkillStatus != .installing {
            codexSkillStatus = CodexHooksManager.codexSkillInstalled() ? .installed : .notInstalled
        }
    }

    func openGhosttyConfig() {
        (NSApp.delegate as? AppDelegate)?.openConfig(nil)
    }

    func openClaudeDocs() {
        guard let url = URL(string: "https://www.anthropic.com/claude-code") else { return }
        NSWorkspace.shared.open(url)
    }

    func installCodexHooks() {
        runCodexHook(action: "install", failureFallback: "Install failed.")
    }

    func uninstallCodexHooks() {
        runCodexHook(action: "uninstall", failureFallback: "Uninstall failed.")
    }

    func revealCodexHooks() {
        CodexHooksManager.revealHooks()
    }

    func installClaudeSkill() {
        runSkillHelper(action: "install", agent: "claude", status: \.claudeSkillStatus,
                       installed: CodexHooksManager.claudeSkillInstalled)
    }

    func uninstallClaudeSkill() {
        runSkillHelper(action: "uninstall", agent: "claude", status: \.claudeSkillStatus,
                       installed: CodexHooksManager.claudeSkillInstalled)
    }

    func installCodexSkill() {
        runSkillHelper(action: "install", agent: "codex-skill", status: \.codexSkillStatus,
                       installed: CodexHooksManager.codexSkillInstalled)
    }

    func uninstallCodexSkill() {
        runSkillHelper(action: "uninstall", agent: "codex-skill", status: \.codexSkillStatus,
                       installed: CodexHooksManager.codexSkillInstalled)
    }

    private func runCodexHook(action: String, failureFallback: String) {
        guard codexStatus != .installing else { return }

        codexStatus = .installing
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let result = CodexHooksManager.runHook(action: action)
            DispatchQueue.main.async {
                guard let self else { return }
                if result.success {
                    self.codexStatus = CodexHooksManager.hooksInstalled() ? .installed : .notInstalled
                } else {
                    self.codexStatus = .failed(result.message ?? failureFallback)
                }
            }
        }
    }

    private func runSkillHelper(
        action: String,
        agent: String,
        status: ReferenceWritableKeyPath<SettingsViewModel, AgentInstallStatus>,
        installed: @escaping () -> Bool
    ) {
        guard self[keyPath: status] != .installing else { return }

        self[keyPath: status] = .installing
        let failureFallback = action == "install" ? "Install failed." : "Uninstall failed."
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let result = CodexHooksManager.runHelper(arguments: [action, agent])
            DispatchQueue.main.async {
                guard let self else { return }
                if result.success {
                    self[keyPath: status] = installed() ? .installed : .notInstalled
                } else {
                    self[keyPath: status] = .failed(result.message ?? failureFallback)
                }
            }
        }
    }
}

enum AgentInstallStatus: Equatable {
    case installed
    case notInstalled
    case installing
    case failed(String)

    var title: String {
        switch self {
        case .installed:
            return "Hooks installed"
        case .notInstalled:
            return "Not installed"
        case .installing:
            return "Working…"
        case .failed:
            return "Last action failed"
        }
    }

    var systemImage: String {
        switch self {
        case .installed:
            return "checkmark.circle.fill"
        case .notInstalled:
            return "circle"
        case .installing:
            return "arrow.triangle.2.circlepath"
        case .failed:
            return "exclamationmark.triangle.fill"
        }
    }

    var tint: Color {
        switch self {
        case .installed:
            return .green
        case .notInstalled, .installing:
            return .secondary
        case .failed:
            return .red
        }
    }
}

struct SettingsView_Previews: PreviewProvider {
    static var previews: some View {
        SettingsView(model: SettingsViewModel())
            .frame(width: 460, height: 480)
    }
}
