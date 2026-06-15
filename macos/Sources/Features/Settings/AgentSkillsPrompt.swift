import AppKit
import SwiftUI

/// App-wide controller for the one-time, opt-in prompt that offers to install the
/// "maxx-tabs" tab-control skill for the agents the user actually has (Claude
/// Code and/or Codex). It shows at most one non-modal banner across all windows,
/// attached to the front terminal window.
///
/// The prompt is evaluated on every launch / activation (not just first launch), so
/// users who adopt an agent after installing the app still get offered the skill.
/// It appears only when at least one detected agent is missing the skill and the
/// user hasn't answered the prompt before. It also defers to the Codex hooks
/// prompt so the two banners never stack; once that prompt is answered, this one
/// shows on a later activation.
final class AgentSkillsPromptController {
    static let shared = AgentSkillsPromptController()

    /// UserDefaults key for the persisted "answered" flag. Once set, we never prompt
    /// again — whether the user installed, declined permanently, or hit an error.
    static let answeredDefaultsKey = "agentSkillsPromptAnswered"

    /// Delay before showing the banner so we don't race a window's first paint or
    /// pop in mid-keystroke right after launch.
    private static let presentationDelay: TimeInterval = 0.4

    private let model = AgentSkillsPromptModel(theme: .fallback)
    private weak var hostWindow: TerminalWindow?
    private var bannerView: NSView?
    private var pollTimer: Timer?
    private var pendingPresentation = false

    private var answered: Bool {
        get { UserDefaults.standard.bool(forKey: Self.answeredDefaultsKey) }
        set { UserDefaults.standard.set(newValue, forKey: Self.answeredDefaultsKey) }
    }

    /// Which agents are present on disk and still missing the skill.
    private struct Candidates {
        var claude: Bool
        var codex: Bool

        var any: Bool { claude || codex }

        static func detect() -> Candidates {
            Candidates(
                claude: CodexHooksManager.claudeConfigDirExists()
                    && !CodexHooksManager.claudeSkillInstalled(),
                codex: CodexHooksManager.codexHomeExists()
                    && !CodexHooksManager.codexSkillInstalled())
        }
    }

    private init() {
        model.onInstall = { [weak self] in self?.install() }
        model.onNotNow = { [weak self] in self?.dismiss(animated: true) }
        model.onDontAskAgain = { [weak self] in
            self?.answered = true
            self?.dismiss(animated: true)
        }
        model.onOpenSettings = { [weak self] in
            SettingsWindowController.shared.show()
            self?.dismiss(animated: true)
        }

        // Defer until a terminal window exists and has finished its initial load.
        NotificationCenter.default.addObserver(
            forName: TerminalWindow.terminalDidAwake,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.evaluate()
        }
    }

    /// Evaluate whether to offer the prompt. Safe to call on every launch / activation;
    /// it's a no-op when a banner is already showing or scheduled, when the user has
    /// answered, when the Codex hooks prompt takes precedence, or when no detected
    /// agent is missing the skill.
    func evaluate() {
        guard bannerView == nil, !pendingPresentation, !answered else { return }
        guard !CodexHooksPromptController.wouldPrompt else { return }
        guard Candidates.detect().any else { return }
        guard frontTerminalWindow() != nil else { return }

        pendingPresentation = true
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.presentationDelay) { [weak self] in
            guard let self else { return }
            self.pendingPresentation = false
            self.presentIfStillEligible()
        }
    }

    // MARK: - Presentation

    /// Re-check every condition at the moment of showing, so the banner never appears
    /// if the user installed via Settings (or otherwise) while it was scheduled.
    private func presentIfStillEligible() {
        guard bannerView == nil, !answered else { return }
        guard !CodexHooksPromptController.wouldPrompt else { return }
        let candidates = Candidates.detect()
        guard candidates.any else { return }
        guard let window = frontTerminalWindow() else { return }
        present(in: window, candidates: candidates)
    }

    private func present(in window: TerminalWindow, candidates: Candidates) {
        guard let contentView = window.contentView else { return }

        model.phase = .prompt
        model.theme = window.sidebarTheme
        model.title = Self.title(for: candidates)

        let host = AgentSkillsPromptHostingView(rootView: AgentSkillsPromptBanner(model: model))
        host.translatesAutoresizingMaskIntoConstraints = false
        host.alphaValue = 0
        contentView.addSubview(host)

        // Pin across the top of the content area, just below the titlebar (the safe
        // area top sits under the full-size-content titlebar in all titlebar styles),
        // full width with the same horizontal inset as other window chrome.
        NSLayoutConstraint.activate([
            host.topAnchor.constraint(
                equalTo: contentView.safeAreaLayoutGuide.topAnchor,
                constant: 8),
            host.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 12),
            host.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -12),
        ])

        bannerView = host
        hostWindow = window

        // Fade in. We deliberately do not make the banner key or move first responder,
        // so it never steals keyboard focus from the terminal.
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.25
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            host.animator().alphaValue = 1
        }

        startOutOfBandInstallPolling()
    }

    private static func title(for candidates: Candidates) -> String {
        switch (candidates.claude, candidates.codex) {
        case (true, true):
            return "Install Maxx skills for Claude Code and Codex?"
        case (true, false):
            return "Install the Maxx skill for Claude Code?"
        default:
            return "Install the Maxx skill for Codex?"
        }
    }

    /// While the banner is visible and still in the prompt state, watch for the skills
    /// being installed out-of-band (e.g. via Settings in another window) and auto-dismiss.
    private func startOutOfBandInstallPolling() {
        pollTimer?.invalidate()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            guard let self, self.model.phase == .prompt else { return }
            if !Candidates.detect().any {
                self.dismiss(animated: true)
            }
        }
    }

    private func dismiss(animated: Bool) {
        pollTimer?.invalidate()
        pollTimer = nil

        guard let bannerView else { return }
        self.bannerView = nil
        hostWindow = nil

        guard animated else {
            bannerView.removeFromSuperview()
            return
        }

        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.2
            bannerView.animator().alphaValue = 0
        }, completionHandler: {
            bannerView.removeFromSuperview()
        })
    }

    // MARK: - Install

    private func install() {
        guard model.phase == .prompt else { return }

        let candidates = Candidates.detect()
        guard candidates.any else {
            dismiss(animated: true)
            return
        }

        model.phase = .installing
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var failure: String?
            if candidates.claude {
                let result = CodexHooksManager.runHelper(arguments: ["install", "claude"])
                if !result.success { failure = result.message ?? "Install failed." }
            }
            if candidates.codex, failure == nil {
                let result = CodexHooksManager.runHelper(arguments: ["install", "codex-skill"])
                if !result.success { failure = result.message ?? "Install failed." }
            }

            DispatchQueue.main.async {
                guard let self else { return }
                // Either way, mark answered so we never nag again — on failure the user
                // can retry from Settings.
                self.answered = true

                if let failure {
                    self.model.phase = .failure(failure)
                } else {
                    self.model.phase = .success
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                        self.dismiss(animated: true)
                    }
                }
            }
        }
    }

    // MARK: - Helpers

    private func frontTerminalWindow() -> TerminalWindow? {
        if let key = NSApp.keyWindow as? TerminalWindow { return key }
        if let main = NSApp.mainWindow as? TerminalWindow { return main }
        return TerminalController.all.first?.window as? TerminalWindow
    }
}

/// Hosting view for the banner that claims the standard arrow cursor over its bounds,
/// so hovering the banner doesn't show the terminal's I-beam cursor.
private final class AgentSkillsPromptHostingView<Content: View>: NSHostingView<Content> {
    override func resetCursorRects() {
        super.resetCursorRects()
        addCursorRect(bounds, cursor: .arrow)
    }
}

/// Drives the banner's visual state. The controller owns this and mutates `phase` /
/// `theme` / `title`; the SwiftUI view just renders it.
final class AgentSkillsPromptModel: ObservableObject {
    enum Phase: Equatable {
        case prompt
        case installing
        case success
        case failure(String)
    }

    @Published var phase: Phase = .prompt
    @Published var theme: TerminalSidebarTheme
    @Published var title: String = ""

    var onInstall: () -> Void = {}
    var onNotNow: () -> Void = {}
    var onDontAskAgain: () -> Void = {}
    var onOpenSettings: () -> Void = {}

    init(theme: TerminalSidebarTheme) {
        self.theme = theme
    }
}

/// Non-modal, themed banner offering to install the tab-control skill. Matches the
/// Settings section styling and the active terminal colors via `TerminalSidebarTheme`.
private struct AgentSkillsPromptBanner: View {
    @ObservedObject var model: AgentSkillsPromptModel

    private var theme: TerminalSidebarTheme { model.theme }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "sparkles")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Color(nsColor: theme.buttonTint))
                .frame(width: 20)

            VStack(alignment: .leading, spacing: 3) {
                Text(model.title)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color(nsColor: theme.foreground))
                Text("Gives agents the ability to create and manage tabs in Maxx — "
                    + "for example, ask one to start another session in a new tab, or "
                    + "supervise a group of child tabs. Installs the maxx-tabs and "
                    + "maxx-supervisor-workflows skills in your home folder; you can "
                    + "remove them anytime in Settings.")
                    .font(.system(size: 11))
                    .foregroundStyle(Color(nsColor: theme.mutedForeground))
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 12)

            actions
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(
            // Opaque base so the terminal never shows through, with the selected
            // tint layered on top to match the Settings section styling.
            RoundedRectangle(cornerRadius: 6)
                .fill(Color(nsColor: theme.background.withAlphaComponent(1)))
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(Color(nsColor: theme.selectedBackground))))
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(Color(nsColor: theme.separator), lineWidth: 1))
        .shadow(color: .black.opacity(0.12), radius: 4, y: 1)
        .environment(\.colorScheme, theme.colorScheme)
        .accessibilityIdentifier("MaxxAgentSkillsPromptBanner")
    }

    @ViewBuilder
    private var actions: some View {
        switch model.phase {
        case .prompt:
            HStack(spacing: 8) {
                Button("Don't Ask Again", action: model.onDontAskAgain)
                    .buttonStyle(.plain)
                    .foregroundStyle(Color(nsColor: theme.mutedForeground))
                Button("Not Now", action: model.onNotNow)
                    .buttonStyle(.bordered)
                Button("Install", action: model.onInstall)
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("MaxxAgentSkillsPromptInstallButton")
            }

        case .installing:
            HStack(spacing: 8) {
                ProgressView()
                    .controlSize(.small)
                Text("Installing…")
                    .foregroundStyle(Color(nsColor: theme.mutedForeground))
            }

        case .success:
            HStack(spacing: 6) {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                Text("Skills installed")
                    .foregroundStyle(Color(nsColor: theme.foreground))
            }

        case .failure(let message):
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .trailing, spacing: 4) {
                    Text(message)
                        .font(.system(size: 11))
                        .foregroundStyle(Color(nsColor: theme.error))
                        .multilineTextAlignment(.trailing)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 8) {
                        Button("Dismiss", action: model.onNotNow)
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                        Button("Open Settings", action: model.onOpenSettings)
                            .buttonStyle(.borderedProminent)
                            .controlSize(.small)
                    }
                }
            }
        }
    }
}
