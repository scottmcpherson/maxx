import AppKit

/// AppleScript-facing wrapper around a logical Ghostty window.
///
/// In AppKit, each tab is often its own `NSWindow`. AppleScript users, however,
/// expect a single window object containing a list of tabs.
///
/// `ScriptWindow` is that compatibility layer:
/// - It presents one object per tab group.
/// - It translates tab-group state into `tabs` and `selected tab`.
/// - It exposes stable IDs that Cocoa scripting can resolve later.
@MainActor
@objc(GhosttyScriptWindow)
final class ScriptWindow: NSObject {
    /// Stable identifier used by AppleScript `window id "..."` references.
    ///
    /// We precompute this once so the object keeps a consistent ID for its whole
    /// lifetime, even if AppKit window bookkeeping changes after creation.
    let stableID: String

    /// Canonical representative for this scripting window's tab group.
    ///
    /// We intentionally keep only one controller reference; full tab membership
    /// is derived lazily from current AppKit state whenever needed.
    private weak var primaryController: BaseTerminalController?

    /// Control sessions registered while building an AppleScript reply, keyed by
    /// stable tab id. This lets the returned window vend a selected tab with its
    /// durable session id even when a quick-exit command closed the surface before
    /// AppleScript asks for `control session id`.
    private var registeredControlSessionIDs: [String: String]

    /// `scriptWindows` in `AppDelegate+AppleScript` constructs these objects.
    ///
    /// `stableID` must match the same identity scheme used by
    /// `valueInScriptWindowsWithUniqueID:` so Cocoa can re-resolve object
    /// specifiers produced earlier in a script.
    init(
        primaryController: BaseTerminalController,
        registeredControlSession: (tabID: String, sessionID: String)? = nil
    ) {
        self.stableID = Self.stableID(primaryController: primaryController)
        self.primaryController = primaryController
        if let registeredControlSession {
            self.registeredControlSessionIDs = [
                registeredControlSession.tabID: registeredControlSession.sessionID,
            ]
        } else {
            self.registeredControlSessionIDs = [:]
        }
    }

    /// Exposed as the AppleScript `id` property.
    ///
    /// This is what scripts read with `id of window ...`.
    @objc(id)
    var idValue: String {
        guard NSApp.isAppleScriptEnabled else { return "" }
        return stableID
    }

    /// Exposed as the AppleScript `title` property.
    ///
    /// Returns the title of the window (from the selected/primary controller's NSWindow).
    @objc(title)
    var title: String {
        guard NSApp.isAppleScriptEnabled else { return "" }
        return selectedController?.window?.title ?? ""
    }

    /// Exposed as the AppleScript `tabs` element.
    ///
    /// Cocoa asks for this collection when a script evaluates `tabs of window ...`
    /// or any tab-filter expression. We build wrappers from live controller state
    /// so tab additions/removals are reflected immediately.
    @objc(tabs)
    var tabs: [ScriptTab] {
        guard NSApp.isAppleScriptEnabled else { return [] }
        return controllers.map {
            ScriptTab(
                window: self,
                controller: $0,
                registeredControlSessionID: registeredControlSessionID(for: $0))
        }
    }

    /// Exposed as the AppleScript `selected tab` property.
    ///
    /// This powers expressions like `selected tab of window 1`.
    @objc(selectedTab)
    var selectedTab: ScriptTab? {
        guard NSApp.isAppleScriptEnabled else { return nil }
        guard let selectedController else { return detachedRegisteredControlSessionTab }
        return ScriptTab(
            window: self,
            controller: selectedController,
            registeredControlSessionID: registeredControlSessionID(for: selectedController))
    }

    /// Enables unique-ID lookup for `tabs` references.
    ///
    /// Required selector pattern for the `tabs` element key:
    /// `valueInTabsWithUniqueID:`.
    ///
    /// Cocoa uses this when a script resolves `tab id "..." of window ...`.
    @objc(valueInTabsWithUniqueID:)
    func valueInTabs(uniqueID: String) -> ScriptTab? {
        guard NSApp.isAppleScriptEnabled else { return nil }
        return tab(uniqueID: uniqueID)
    }

    func tab(
        uniqueID: String,
        registeredControlSessionID: String? = nil
    ) -> ScriptTab? {
        let rememberedSessionID = registeredControlSessionIDs[uniqueID]
        let cachedSessionID = registeredControlSessionID
            ?? rememberedSessionID
        guard let controller = controller(tabID: uniqueID) else {
            guard let rememberedSessionID else { return nil }
            return ScriptTab(
                window: self,
                stableID: uniqueID,
                registeredControlSessionID: rememberedSessionID)
        }
        return ScriptTab(
            window: self,
            controller: controller,
            registeredControlSessionID: cachedSessionID)
    }

    func rememberRegisteredControlSession(tabID: String, sessionID: String) {
        registeredControlSessionIDs[tabID] = sessionID
    }

    /// Exposed as the AppleScript `terminals` element on a window.
    ///
    /// Returns all terminal surfaces across every tab in this window.
    @objc(terminals)
    var terminals: [ScriptTerminal] {
        guard NSApp.isAppleScriptEnabled else { return [] }
        return controllers
            .flatMap { $0.surfaceTree.root?.leaves() ?? [] }
            .map(ScriptTerminal.init)
    }

    /// Enables unique-ID lookup for `terminals` references on a window.
    ///
    /// Lookup is case-insensitive because the same UUID is exposed to
    /// terminal processes as a lowercased GHOSTTY_AGENT_SURFACE_ID.
    @objc(valueInTerminalsWithUniqueID:)
    func valueInTerminals(uniqueID: String) -> ScriptTerminal? {
        guard NSApp.isAppleScriptEnabled else { return nil }
        return controllers
            .flatMap { $0.surfaceTree.root?.leaves() ?? [] }
            .first(where: { $0.id.uuidString.caseInsensitiveCompare(uniqueID) == .orderedSame })
            .map(ScriptTerminal.init)
    }

    /// AppleScript tab indexes are 1-based, so we add one to Swift's 0-based
    /// array index.
    func tabIndex(for controller: BaseTerminalController) -> Int? {
        guard NSApp.isAppleScriptEnabled else { return nil }
        return controllers.firstIndex(where: { $0 === controller }).map { $0 + 1 }
    }

    /// Reports whether a given controller maps to this window's selected tab.
    func tabIsSelected(_ controller: BaseTerminalController) -> Bool {
        guard NSApp.isAppleScriptEnabled else { return false }
        return selectedController === controller
    }

    /// Best-effort native window to use as a tab parent for AppleScript commands.
    var preferredParentWindow: NSWindow? {
        guard NSApp.isAppleScriptEnabled else { return nil }
        return selectedController?.window ?? controllers.first?.window
    }

    /// Best-effort controller to use for window-scoped AppleScript commands.
    var preferredController: BaseTerminalController? {
        guard NSApp.isAppleScriptEnabled else { return nil }
        return selectedController ?? controllers.first
    }

    /// Resolves a previously generated tab ID back to a live controller.
    private func controller(tabID: String) -> BaseTerminalController? {
        controllers.first(where: { ScriptTab.stableID(controller: $0) == tabID })
    }

    private func registeredControlSessionID(
        for controller: BaseTerminalController
    ) -> String? {
        registeredControlSessionIDs[ScriptTab.stableID(controller: controller)]
    }

    private var detachedRegisteredControlSessionTab: ScriptTab? {
        guard registeredControlSessionIDs.count == 1,
              let registeredControlSession = registeredControlSessionIDs.first
        else { return nil }

        return ScriptTab(
            window: self,
            stableID: registeredControlSession.key,
            registeredControlSessionID: registeredControlSession.value)
    }

    /// Live controller list for this scripting window.
    ///
    /// We recalculate on every access so AppleScript immediately sees tab-group
    /// changes (new tabs, closed tabs, tab moves) without rebuilding all objects.
    private var controllers: [BaseTerminalController] {
        guard NSApp.isAppleScriptEnabled else { return [] }
        guard let primaryController else { return [] }
        guard let window = primaryController.window else { return [primaryController] }

        if let tabGroup = window.tabGroup {
            let groupControllers = tabGroup.windows.compactMap {
                $0.windowController as? BaseTerminalController
            }
            if !groupControllers.isEmpty {
                return groupControllers
            }
        }

        return [primaryController]
    }

    /// Live selected controller for this scripting window.
    ///
    /// AppKit tracks selected tab on `NSWindowTabGroup.selectedWindow`; for
    /// non-tabbed windows we fall back to the primary controller.
    private var selectedController: BaseTerminalController? {
        guard let primaryController else { return nil }
        guard let window = primaryController.window else { return primaryController }

        if let tabGroup = window.tabGroup,
           let selectedController = tabGroup.selectedWindow?.windowController as? BaseTerminalController {
            return selectedController
        }

        return controllers.first
    }

    /// Handler for `activate window <window>`.
    @objc(handleActivateWindowCommand:)
    func handleActivateWindow(_ command: NSScriptCommand) -> Any? {
        guard NSApp.validateScript(command: command) else { return nil }

        guard let windowContainer = preferredParentWindow else {
            command.scriptErrorNumber = errAEEventFailed
            command.scriptErrorString = "Window is no longer available."
            return nil
        }

        windowContainer.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        return nil
    }

    /// Handler for `close window <window>`.
    @objc(handleCloseWindowCommand:)
    func handleCloseWindow(_ command: NSScriptCommand) -> Any? {
        guard NSApp.validateScript(command: command) else { return nil }

        if let managedTerminalController = preferredController as? TerminalController {
            managedTerminalController.closeWindowImmediately()
            return nil
        }

        guard let windowContainer = preferredParentWindow else {
            command.scriptErrorNumber = errAEEventFailed
            command.scriptErrorString = "Window is no longer available."
            return nil
        }

        windowContainer.close()
        return nil
    }

    /// Provides Cocoa scripting with a canonical "path" back to this object.
    ///
    /// Without this, Cocoa can return data but cannot reliably build object
    /// references for later script statements. This specifier encodes:
    /// `application -> scriptWindows[id]`.
    override var objectSpecifier: NSScriptObjectSpecifier? {
        guard NSApp.isAppleScriptEnabled else { return nil }
        guard let appClassDescription = NSApplication.shared.classDescription as? NSScriptClassDescription else {
            return nil
        }

        return NSUniqueIDSpecifier(
            containerClassDescription: appClassDescription,
            containerSpecifier: nil,
            key: "scriptWindows",
            uniqueID: stableID
        )
    }
}

extension ScriptWindow {
    /// Produces the window-level stable ID from the primary controller.
    ///
    /// - Tabbed windows are keyed by tab-group identity.
    /// - Standalone windows are keyed by window identity.
    /// - Detached controllers fall back to controller identity.
    static func stableID(primaryController: BaseTerminalController) -> String {
        guard let window = primaryController.window else {
            return "controller-\(ObjectIdentifier(primaryController).hexString)"
        }

        if let tabGroup = window.tabGroup {
            return stableID(tabGroup: tabGroup)
        }

        return stableID(window: window)
    }

    /// Stable ID for a standalone native window.
    static func stableID(window: NSWindow) -> String {
        "window-\(ObjectIdentifier(window).hexString)"
    }

    /// Stable ID for a native AppKit tab group.
    static func stableID(tabGroup: NSWindowTabGroup) -> String {
        "tab-group-\(ObjectIdentifier(tabGroup).hexString)"
    }
}
