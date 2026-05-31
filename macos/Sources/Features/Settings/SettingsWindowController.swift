import AppKit
import SwiftUI

/// Hosts the agent-integration settings in a standalone, single-instance window.
///
/// Re-invoking `show()` focuses the existing window rather than opening a second
/// one, and refreshes detection state so status never goes stale while open.
final class SettingsWindowController: NSWindowController, NSWindowDelegate {
    static let shared = SettingsWindowController()

    private let model = SettingsViewModel()

    private init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 460, height: 480),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false)
        window.title = "Settings"
        window.isReleasedWhenClosed = false
        window.contentMinSize = NSSize(width: 420, height: 360)
        window.identifier = NSUserInterfaceItemIdentifier("MosttlySettingsWindow")
        window.center()

        super.init(window: window)

        window.delegate = self
        window.contentView = NSHostingView(rootView: SettingsView(model: model))
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    // MARK: - Functions

    func show() {
        model.refresh()
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // MARK: - NSWindowDelegate

    func windowDidBecomeKey(_ notification: Notification) {
        // Status is just filesystem existence checks, so refreshing on focus is
        // cheap and keeps the window current if the user installs a CLI elsewhere.
        model.refresh()
    }
}
