import AppKit

/// AppleScript-facing wrapper around a single tab in a scripting window.
///
/// `ScriptWindow.tabs` vends these objects so AppleScript can traverse
/// `window -> tab` without knowing anything about AppKit controllers.
@MainActor
@objc(GhosttyScriptTab)
final class ScriptTab: NSObject {
    /// Stable identifier used by AppleScript `tab id "..."` references.
    private let stableID: String

    /// Back-reference to the scripting window that owns this tab wrapper.
    ///
    /// We only need this for dynamic properties (`index`, `selected`) and for
    /// building an object specifier path.
    ///
    /// Strong on purpose: command handlers (e.g. `new tab`) return tabs whose
    /// owning `ScriptWindow` may be a function-local wrapper. Cocoa packages
    /// the reply by asking for `objectSpecifier` after the handler returns, so
    /// the tab has to keep its window alive or the reply fails with -1708.
    /// `ScriptWindow` never retains tabs and only weakly references its
    /// controller, so this cannot create a cycle.
    private let window: ScriptWindow

    /// Live terminal controller for this tab.
    ///
    /// This can become `nil` if the tab closes while a script is running.
    private weak var controller: BaseTerminalController?

    /// Control session created while building this AppleScript reply.
    ///
    /// `maxx-agent-hook new-tab --exec` can launch a command that exits and closes
    /// its surface before AppleScript asks this wrapper for `control session id`.
    /// The registration already happened in-process, so keep the durable id here
    /// for the reply path instead of depending on the surface still being live.
    private let registeredControlSessionID: String?

    /// Called by `ScriptWindow.tabs` / `ScriptWindow.selectedTab`.
    ///
    /// The ID is computed once so object specifiers built from this instance keep
    /// a consistent tab identity.
    init(
        window: ScriptWindow,
        controller: BaseTerminalController,
        registeredControlSessionID: String? = nil
    ) {
        self.stableID = Self.stableID(controller: controller)
        self.window = window
        self.controller = controller
        self.registeredControlSessionID = registeredControlSessionID
    }

    /// Build a scripting tab for a just-registered session whose terminal surface
    /// has already closed. Only properties backed by stable scripting identity or
    /// the cached control session id can answer meaningfully.
    init(
        window: ScriptWindow,
        stableID: String,
        registeredControlSessionID: String
    ) {
        self.stableID = stableID
        self.window = window
        self.controller = nil
        self.registeredControlSessionID = registeredControlSessionID
    }

    /// Exposed as the AppleScript `id` property.
    @objc(id)
    var idValue: String {
        guard NSApp.isAppleScriptEnabled else { return "" }
        return stableID
    }

    /// Exposed as the AppleScript `name` property (read/write).
    ///
    /// Returns the title of the tab's window. Setting it stores a manual
    /// title override on the controller — the same mechanism as renaming a
    /// session in the sidebar — so the name wins over titles reported by the
    /// terminal. Setting an empty string clears the override.
    @objc(title)
    var title: String {
        get {
            guard NSApp.isAppleScriptEnabled else { return "" }
            return controller?.window?.title ?? ""
        }
        set {
            guard NSApp.isAppleScriptEnabled else { return }
            guard let controller else { return }
            let trimmed = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
            controller.titleOverride = trimmed.isEmpty ? nil : trimmed
        }
    }

    /// Exposed as the AppleScript `index` property.
    ///
    /// Cocoa scripting expects this to be 1-based for user-facing collections.
    @objc(index)
    var index: Int {
        guard NSApp.isAppleScriptEnabled else { return 0 }
        guard let controller else { return 0 }
        return window.tabIndex(for: controller) ?? 0
    }

    /// Exposed as the AppleScript `selected` property.
    ///
    /// Powers script conditions such as `if selected of tab 1 then ...`.
    @objc(selected)
    var selected: Bool {
        guard NSApp.isAppleScriptEnabled else { return false }
        guard let controller else { return false }
        return window.tabIsSelected(controller)
    }

    /// Exposed as the AppleScript `focused terminal` property.
    ///
    /// Uses the currently focused surface for this tab.
    @objc(focusedTerminal)
    var focusedTerminal: ScriptTerminal? {
        guard NSApp.isAppleScriptEnabled else { return nil }
        guard let controller else { return nil }
        guard let surface = controller.focusedSurface,
              controller.surfaceTree.contains(surface)
        else { return nil }

        return ScriptTerminal(surfaceView: surface)
    }

    /// Exposed as the AppleScript `control session id` property.
    ///
    /// This is empty for ordinary tabs and for restored records from a previous
    /// app run. `maxx-agent-hook new-tab` marks its spawn request so the app
    /// registers the new live surface immediately; after that this property
    /// returns the durable Control API `session_id` for follow-up work.
    @objc(controlSessionID)
    var controlSessionID: String {
        guard NSApp.isAppleScriptEnabled else { return "" }
        if let registeredControlSessionID { return registeredControlSessionID }
        guard let controller else { return "" }
        guard let appDelegate = NSApp.delegate as? AppDelegate else { return "" }

        if let focused = controller.focusedSurface,
           controller.surfaceTree.contains(focused),
           let sessionID = appDelegate.controlSessionID(forRegisteredSurface: focused.id) {
            return sessionID
        }

        for surface in controller.surfaceTree.root?.leaves() ?? [] {
            if let sessionID = appDelegate.controlSessionID(forRegisteredSurface: surface.id) {
                return sessionID
            }
        }
        return ""
    }

    /// Best-effort native window containing this tab.
    var parentWindow: NSWindow? {
        guard NSApp.isAppleScriptEnabled else { return nil }
        return controller?.window
    }

    /// Live controller backing this tab wrapper.
    var parentController: BaseTerminalController? {
        guard NSApp.isAppleScriptEnabled else { return nil }
        return controller
    }

    /// Exposed as the AppleScript `terminals` element on a tab.
    ///
    /// Returns all terminal surfaces (split panes) within this tab.
    @objc(terminals)
    var terminals: [ScriptTerminal] {
        guard NSApp.isAppleScriptEnabled else { return [] }
        guard let controller else { return [] }
        return (controller.surfaceTree.root?.leaves() ?? [])
            .map(ScriptTerminal.init)
    }

    /// Enables unique-ID lookup for `terminals` references on a tab.
    ///
    /// Lookup is case-insensitive because the same UUID is exposed to
    /// terminal processes as a lowercased GHOSTTY_AGENT_SURFACE_ID.
    @objc(valueInTerminalsWithUniqueID:)
    func valueInTerminals(uniqueID: String) -> ScriptTerminal? {
        guard NSApp.isAppleScriptEnabled else { return nil }
        guard let controller else { return nil }
        return (controller.surfaceTree.root?.leaves() ?? [])
            .first(where: { $0.id.uuidString.caseInsensitiveCompare(uniqueID) == .orderedSame })
            .map(ScriptTerminal.init)
    }

    /// Handler for `select tab <tab>`.
    @objc(handleSelectTabCommand:)
    func handleSelectTab(_ command: NSScriptCommand) -> Any? {
        guard NSApp.validateScript(command: command) else { return nil }

        guard let tabContainerWindow = parentWindow else {
            command.scriptErrorNumber = errAEEventFailed
            command.scriptErrorString = "Tab is no longer available."
            return nil
        }

        tabContainerWindow.makeKeyAndOrderFront(nil)
        return nil
    }

    /// Handler for `close tab <tab>`.
    @objc(handleCloseTabCommand:)
    func handleCloseTab(_ command: NSScriptCommand) -> Any? {
        guard NSApp.validateScript(command: command) else { return nil }

        guard let tabController = parentController else {
            command.scriptErrorNumber = errAEEventFailed
            command.scriptErrorString = "Tab is no longer available."
            return nil
        }

        if let managedTerminalController = tabController as? TerminalController {
            managedTerminalController.closeTabImmediately(registerRedo: false)
            return nil
        }

        guard let tabContainerWindow = parentWindow else {
            command.scriptErrorNumber = errAEEventFailed
            command.scriptErrorString = "Tab container window is no longer available."
            return nil
        }

        tabContainerWindow.close()
        return nil
    }

    /// Provides Cocoa scripting with a canonical "path" back to this object.
    override var objectSpecifier: NSScriptObjectSpecifier? {
        guard NSApp.isAppleScriptEnabled else { return nil }
        guard let windowClassDescription = window.classDescription as? NSScriptClassDescription else {
            return nil
        }
        guard let windowSpecifier = window.objectSpecifier else { return nil }

        // This tells Cocoa how to re-find this tab later:
        // application -> scriptWindows[id] -> tabs[id].
        return NSUniqueIDSpecifier(
            containerClassDescription: windowClassDescription,
            containerSpecifier: windowSpecifier,
            key: "tabs",
            uniqueID: stableID
        )
    }
}

extension ScriptTab {
    /// Stable ID for one tab controller.
    ///
    /// Tab identity belongs to `ScriptTab`, so both tab creation and tab ID
    /// lookups in `ScriptWindow` call this helper.
    static func stableID(controller: BaseTerminalController) -> String {
        "tab-\(ObjectIdentifier(controller).hexString)"
    }
}
