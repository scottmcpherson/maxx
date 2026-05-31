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
    }

    // MARK: - Helpers

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
    @Published private(set) var claudeConfigured = false
    @Published private(set) var codexStatus: CodexHooksStatus = .notInstalled

    func refresh() {
        claudeConfigured = Self.isClaudeConfigured()
        if codexStatus != .installing {
            codexStatus = Self.codexHooksInstalled() ? .installed : .notInstalled
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
        let codexHome = Self.codexHomeURL()
        let candidates = [
            codexHome.appendingPathComponent("config.toml"),
            codexHome.appendingPathComponent("hooks.json"),
        ]
        let existing = candidates.filter { FileManager.default.fileExists(atPath: $0.path) }
        if existing.isEmpty {
            NSWorkspace.shared.activateFileViewerSelecting([codexHome])
        } else {
            NSWorkspace.shared.activateFileViewerSelecting(existing)
        }
    }

    private func runCodexHook(action: String, failureFallback: String) {
        guard codexStatus != .installing else { return }

        codexStatus = .installing
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let result = Self.runCodexHookHelper(action: action)
            DispatchQueue.main.async {
                guard let self else { return }
                if result.success {
                    self.codexStatus = Self.codexHooksInstalled() ? .installed : .notInstalled
                } else {
                    self.codexStatus = .failed(result.message ?? failureFallback)
                }
            }
        }
    }

    private static func isClaudeConfigured() -> Bool {
        guard let helperURL else { return false }
        let claudeURL = helperURL.deletingLastPathComponent().appendingPathComponent("claude")
        return FileManager.default.isExecutableFile(atPath: claudeURL.path)
    }

    private static func codexHooksInstalled() -> Bool {
        let codexHome = codexHomeURL()
        let hooksURL = codexHome.appendingPathComponent("hooks.json")
        let configURL = codexHome.appendingPathComponent("config.toml")

        guard let hooks = try? String(contentsOf: hooksURL, encoding: .utf8),
              let config = try? String(contentsOf: configURL, encoding: .utf8)
        else {
            return false
        }

        return hooks.contains("ghostty-agent-hook") &&
            hooks.contains(" codex ") &&
            config.contains("ghostty-agent-codex-hooks-feature begin") &&
            config.contains("hooks = true")
    }

    private static func runCodexHookHelper(action: String) -> (success: Bool, message: String?) {
        guard let helperURL else {
            return (false, "Hook helper missing.")
        }

        let process = Process()
        process.executableURL = helperURL
        process.arguments = [action, "codex"]

        var environment = ProcessInfo.processInfo.environment
        if environment["HOME"]?.isEmpty ?? true {
            environment["HOME"] = NSHomeDirectory()
        }
        process.environment = environment

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return (false, error.localizedDescription)
        }

        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let output = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        guard process.terminationStatus == 0 else {
            return (false, output.isEmpty ? nil : output)
        }

        return (true, nil)
    }

    private static func codexHomeURL() -> URL {
        if let codexHome = ProcessInfo.processInfo.environment["CODEX_HOME"],
           !codexHome.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return URL(
                fileURLWithPath: (codexHome as NSString).expandingTildeInPath,
                isDirectory: true)
        }

        return URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
            .appendingPathComponent(".codex", isDirectory: true)
    }

    private static var helperURL: URL? {
        guard let resourcesURL = Bundle.main.resourceURL else { return nil }
        let helperURL = resourcesURL
            .appendingPathComponent("ghostty", isDirectory: true)
            .appendingPathComponent("bin", isDirectory: true)
            .appendingPathComponent("ghostty-agent-hook", isDirectory: false)

        return FileManager.default.isExecutableFile(atPath: helperURL.path) ? helperURL : nil
    }
}

enum CodexHooksStatus: Equatable {
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
