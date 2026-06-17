import AppKit
import Darwin
import Foundation

/// Production ``ControlSessionHost`` that drives the real terminal UI.
///
/// Reuses the same `TerminalController` creation path as the New Terminal app
/// intent, so API-created sessions are ordinary, visible Maxx tabs. Every
/// operation is an explicit control action; nothing here reads or interprets
/// terminal output.
@MainActor
final class TerminalControlHost: ControlSessionHost {
    private let ghostty: Ghostty.App

    init(ghostty: Ghostty.App) {
        self.ghostty = ghostty
    }

    func createTerminal(_ request: ControlCreateRequest) throws -> UUID {
        var config = Ghostty.SurfaceConfiguration()

        // Run the command via initialInput (like NewTerminalIntent) so the
        // user's login scripts set up PATH and friends before it runs.
        if let command = request.command, !command.isEmpty {
            config.initialInput = "\(command); exit\n"
        }

        if let cwd = request.cwd {
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: cwd, isDirectory: &isDirectory),
                  isDirectory.boolValue else {
                throw ControlError(.invalidRequest, "working directory does not exist: \(cwd)")
            }
            config.workingDirectory = cwd
        }

        for (key, value) in request.env {
            config.environmentVariables[key] = value
        }

        let parent = TerminalController.preferredParent
        let controller: TerminalController?
        switch request.location {
        case .window:
            controller = TerminalController.newWindow(
                ghostty,
                withBaseConfig: config,
                withParent: parent?.window,
                focus: request.focus)
        case .tab:
            controller = TerminalController.newTab(
                ghostty,
                from: parent?.window,
                withBaseConfig: config,
                focus: request.focus)
        }

        // Surface the caller's explicit title in the UI (tab/window title), so
        // an API-created tab is recognizable rather than showing only the
        // running command.
        if let title = request.title, !title.isEmpty {
            controller?.titleOverride = title
        }

        guard let view = controller?.surfaceTree.root?.leftmostLeaf() else {
            throw ControlError(.internalError, "failed to create terminal surface")
        }

        // Only explicit focus requests bring the app forward. Background
        // control spawns are still visible in the parent tab group without
        // stealing the caller's current focus.
        if request.focus && !NSApp.isActive {
            NSApp.activate(ignoringOtherApps: true)
        }

        return view.id
    }

    func surface(for surfaceID: UUID) -> ControlSurfaceHandle? {
        guard let view = Self.allSurfaceViews.first(where: { $0.id == surfaceID }) else {
            return nil
        }
        return TerminalSurfaceHandle(view: view)
    }

    func surfaceForRegistration(surfaceID: UUID, token: String) -> ControlSurfaceHandle? {
        guard let view = Self.allSurfaceViews.first(where: { $0.id == surfaceID }) else {
            return nil
        }
        guard Self.timingSafeEquals(view.agentRegistrationToken, token) else {
            return nil
        }
        return TerminalSurfaceHandle(view: view)
    }

    /// All live terminal surfaces across every window (same enumeration the App
    /// Intents `TerminalQuery` uses).
    private static var allSurfaceViews: [Ghostty.SurfaceView] {
        NSApp.windows
            .compactMap { $0.windowController as? BaseTerminalController }
            .flatMap { $0.surfaceTree.root?.leaves() ?? [] }
    }

    private static func timingSafeEquals(_ expected: String, _ supplied: String) -> Bool {
        let expectedBytes = Array(expected.utf8)
        let suppliedBytes = Array(supplied.utf8)
        guard !expectedBytes.isEmpty else { return suppliedBytes.isEmpty }

        var paddedSupplied = [UInt8](repeating: 0, count: expectedBytes.count)
        let copyCount = min(suppliedBytes.count, expectedBytes.count)
        for index in 0..<copyCount {
            paddedSupplied[index] = suppliedBytes[index]
        }

        let bytesMatch = expectedBytes.withUnsafeBytes { expectedBuffer in
            paddedSupplied.withUnsafeBytes { suppliedBuffer in
                timingsafe_bcmp(
                    expectedBuffer.baseAddress!,
                    suppliedBuffer.baseAddress!,
                    expectedBytes.count) == 0
            }
        }
        return bytesMatch && suppliedBytes.count == expectedBytes.count
    }
}

/// A handle to a single live terminal surface.
@MainActor
final class TerminalSurfaceHandle: ControlSurfaceHandle {
    private let view: Ghostty.SurfaceView

    init(view: Ghostty.SurfaceView) {
        self.view = view
    }

    var surfaceID: UUID { view.id }
    var title: String { view.title }
    var workingDirectory: String? { view.pwd }
    var pid: Int? { view.surfaceModel?.foregroundPID }
    /// Kernel-reported child-process liveness — not output inference.
    var isProcessAlive: Bool { !view.processExited }

    func focus() {
        guard let controller = view.window?.windowController as? BaseTerminalController else {
            return
        }
        controller.focusSurface(view)
    }

    func sendInput(_ text: String) {
        view.surfaceModel?.sendText(text)
    }

    func submitInput(_ text: String) {
        guard let surface = view.surfaceModel else { return }
        surface.sendText(text)
        surface.sendKeyEvent(.init(key: .enter, action: .press))
        surface.sendKeyEvent(.init(key: .enter, action: .release))
    }

    @discardableResult
    func interrupt(signal: Int32?) -> Bool {
        // Nothing to interrupt once the process has exited or the surface model
        // is gone. Guard *both* the Ctrl-C and named-signal paths here so neither
        // reports a phantom success — and so the signal path can never `killpg` a
        // stale foreground process group id that the OS may have since reused.
        guard !view.processExited, let model = view.surfaceModel else { return false }

        guard let signal else {
            // ETX (Ctrl-C). Sent as text so we don't depend on key-event
            // encoding, and so the tty delivers it to the whole foreground
            // process group — the most correct way to interrupt.
            model.sendText("\u{03}")
            return true
        }
        // A specific signal is delivered through the explicit process-control
        // path (a kernel call against a pid Maxx already knows), never by
        // synthesizing terminal input. `foregroundPID` is the foreground
        // process *group* id, so `killpg` delivers to the whole group — matching
        // what Ctrl-C does, not just the group leader.
        guard let pid = model.foregroundPID else { return false }
        return killpg(pid_t(pid), signal) == 0
    }

    func close() {
        guard let controller = view.window?.windowController as? BaseTerminalController else {
            return
        }

        // The API caller has already decided to cancel, so this must never block
        // on a confirmation dialog (an external automation client cannot dismiss
        // one). `closeSurface(withConfirmation:)` is honored for splits, but
        // closing a whole tab routes through `closeTab`, which always confirms a
        // running process. Use the immediate close path for the whole-tab case.
        if let terminal = controller as? TerminalController,
           (terminal.surfaceTree.root?.leaves().count ?? 0) <= 1 {
            terminal.closeTabImmediately()
        } else {
            controller.closeSurface(view, withConfirmation: false)
        }
    }

    func applyDeclaredState(_ declared: ControlDeclaredState) {
        // An explicit agent declaration only — the surface stores and displays it
        // verbatim and never derives anything from terminal output.
        view.applyDeclaredAgentState(declared)
    }

    func applyMetadata(_ metadata: [String: ControlJSONValue]) {
        // An explicit agent declaration only — the surface stores and displays the
        // map verbatim and never derives anything from terminal output.
        view.applyAgentMetadata(metadata)
    }

    func applyRelationship(_ relationship: ControlRelationship) {
        // An explicit caller-set parent/group edge only (MAX-6) — the surface
        // stores and displays it verbatim and never derives a relationship from
        // terminal output, process names, paths, or idle time.
        view.applyAgentRelationship(relationship)
    }
}
