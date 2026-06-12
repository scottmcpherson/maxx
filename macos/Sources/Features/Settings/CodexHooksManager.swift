import AppKit
import Foundation

/// Single source of truth for detecting, revealing, and installing the Ghostty Codex
/// agent hooks. Both the Settings window and the one-time install prompt go through
/// here so detection and installation never drift apart.
///
/// The hooks are written by the bundled `ghostty-agent-hook` helper, which adds a
/// marked block to `~/.codex/config.toml` and `~/.codex/hooks.json` (or `$CODEX_HOME`).
enum CodexHooksManager {
    /// The Codex home directory, respecting `$CODEX_HOME`, else `~/.codex`.
    static func codexHomeURL() -> URL {
        if let codexHome = ProcessInfo.processInfo.environment["CODEX_HOME"],
           !codexHome.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return URL(
                fileURLWithPath: (codexHome as NSString).expandingTildeInPath,
                isDirectory: true)
        }

        return URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
            .appendingPathComponent(".codex", isDirectory: true)
    }

    /// Whether the Codex home directory exists on disk. This is the gate for the
    /// one-time install prompt: the live "Codex is running" signal only exists after
    /// hooks are installed, so we can't use it to decide whether to offer them.
    static func codexHomeExists() -> Bool {
        var isDirectory: ObjCBool = false
        let exists = FileManager.default.fileExists(
            atPath: codexHomeURL().path,
            isDirectory: &isDirectory)
        return exists && isDirectory.boolValue
    }

    /// Whether our hooks are already installed in the Codex config.
    static func hooksInstalled() -> Bool {
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

    /// Reveal the hook files in Finder, falling back to the Codex home directory.
    static func revealHooks() {
        let codexHome = codexHomeURL()
        let candidates = [
            codexHome.appendingPathComponent("config.toml"),
            codexHome.appendingPathComponent("hooks.json"),
        ]
        let existing = candidates.filter { FileManager.default.fileExists(atPath: $0.path) }
        NSWorkspace.shared.activateFileViewerSelecting(existing.isEmpty ? [codexHome] : existing)
    }

    /// Run the hook helper for `install` / `uninstall`. This blocks while the helper
    /// runs, so call it off the main thread.
    static func runHook(action: String) -> (success: Bool, message: String?) {
        runHelper(arguments: [action, "codex"])
    }

    /// Run the bundled hook helper with arbitrary arguments. This blocks while
    /// the helper runs, so call it off the main thread.
    static func runHelper(arguments: [String]) -> (success: Bool, message: String?) {
        guard let helperURL else {
            return (false, "Hook helper missing.")
        }

        let process = Process()
        process.executableURL = helperURL
        process.arguments = arguments

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

    /// Whether the Claude Code CLI helper is available alongside the hook helper.
    static func claudeConfigured() -> Bool {
        guard let helperURL else { return false }
        let claudeURL = helperURL.deletingLastPathComponent().appendingPathComponent("claude")
        return FileManager.default.isExecutableFile(atPath: claudeURL.path)
    }

    /// The Claude Code config directory, respecting `$CLAUDE_CONFIG_DIR`, else
    /// `~/.claude`. Mirrors `claudeSkillsRoot` in `src/agent_hook/skills.zig`.
    static func claudeConfigURL() -> URL {
        if let configDir = ProcessInfo.processInfo.environment["CLAUDE_CONFIG_DIR"],
           !configDir.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return URL(
                fileURLWithPath: (configDir as NSString).expandingTildeInPath,
                isDirectory: true)
        }

        return URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
            .appendingPathComponent(".claude", isDirectory: true)
    }

    /// Whether the Claude Code config directory exists on disk. This is the gate
    /// for offering the Claude skill: it's the most reliable on-disk signal that
    /// the user actually uses Claude Code.
    static func claudeConfigDirExists() -> Bool {
        var isDirectory: ObjCBool = false
        let exists = FileManager.default.fileExists(
            atPath: claudeConfigURL().path,
            isDirectory: &isDirectory)
        return exists && isDirectory.boolValue
    }

    /// Path of the tab-control skill installed for Claude Code.
    static func claudeSkillURL() -> URL {
        claudeConfigURL()
            .appendingPathComponent("skills", isDirectory: true)
            .appendingPathComponent("mosttly-tabs", isDirectory: true)
            .appendingPathComponent("SKILL.md", isDirectory: false)
    }

    /// Path of the tab-control skill installed for Codex. Codex discovers
    /// user skills in `~/.agents/skills`, the cross-agent standard location.
    static func codexSkillURL() -> URL {
        URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
            .appendingPathComponent(".agents", isDirectory: true)
            .appendingPathComponent("skills", isDirectory: true)
            .appendingPathComponent("mosttly-tabs", isDirectory: true)
            .appendingPathComponent("SKILL.md", isDirectory: false)
    }

    /// Whether the tab-control skill is installed for Claude Code.
    static func claudeSkillInstalled() -> Bool {
        skillInstalled(at: claudeSkillURL())
    }

    /// Whether the tab-control skill is installed for Codex.
    static func codexSkillInstalled() -> Bool {
        skillInstalled(at: codexSkillURL())
    }

    /// Only files written by the helper count; a hand-written skill of the
    /// same name is not ours.
    private static func skillInstalled(at url: URL) -> Bool {
        guard let content = try? String(contentsOf: url, encoding: .utf8) else {
            return false
        }
        return content.contains("managed by ghostty-agent-hook")
    }

    /// The bundled `ghostty-agent-hook` helper, if present and executable.
    static var helperURL: URL? {
        guard let resourcesURL = Bundle.main.resourceURL else { return nil }
        let helperURL = resourcesURL
            .appendingPathComponent("ghostty", isDirectory: true)
            .appendingPathComponent("bin", isDirectory: true)
            .appendingPathComponent("ghostty-agent-hook", isDirectory: false)

        return FileManager.default.isExecutableFile(atPath: helperURL.path) ? helperURL : nil
    }
}
