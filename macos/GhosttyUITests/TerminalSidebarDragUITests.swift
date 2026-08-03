import XCTest

final class TerminalSidebarDragUITests: GhosttyCustomConfigCase {
    override func setUp() async throws {
        try await super.setUp()

        try updateConfig(
            """
            macos-titlebar-style = sidebar
            title = "Sidebar Drag Test"
            window-save-state = never
            """
        )
    }

    @MainActor
    func testDraggingSessionToTopReordersSidebar() throws {
        let app = try ghosttyApplication()
        app.launch()

        let terminal = app.groups["Terminal pane"]
        XCTAssertTrue(terminal.waitForExistence(timeout: 5))

        renameSession(in: app, at: 1, to: "One")
        terminal.typeKey("t", modifierFlags: .command)
        renameSession(in: app, at: 2, to: "Two")
        terminal.typeKey("t", modifierFlags: .command)
        renameSession(in: app, at: 3, to: "Three")

        let first = session(in: app, at: 1)
        let third = session(in: app, at: 3)
        let source = third.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        let destination = first.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2))
        source.click(forDuration: 0.2, thenDragTo: destination)

        XCTAssertTrue(app.wait(
            for: session(in: app, at: 1),
            toHaveLabel: "Session 1: Three",
            timeout: 3))
        XCTAssertEqual(session(in: app, at: 2).label, "Session 2: One")
        XCTAssertEqual(session(in: app, at: 3).label, "Session 3: Two")

        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Sidebar sessions reordered by drag"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }

    private func renameSession(in app: XCUIApplication, at index: Int, to title: String) {
        let row = session(in: app, at: index)
        XCTAssertTrue(row.waitForExistence(timeout: 2))
        row.doubleClick()

        let field = app.textFields["TerminalSidebarRenameField"]
        XCTAssertTrue(field.waitForExistence(timeout: 2))
        field.typeKey("a", modifierFlags: .command)
        field.typeText(title)
        field.typeKey(XCUIKeyboardKey.return.rawValue, modifierFlags: [])
    }

    private func session(in app: XCUIApplication, at index: Int) -> XCUIElement {
        app.buttons["TerminalSidebarSession-\(index)"]
    }
}

private extension XCUIApplication {
    func wait(for element: XCUIElement, toHaveLabel label: String, timeout: TimeInterval) -> Bool {
        let predicate = NSPredicate(format: "label == %@", label)
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
    }
}
