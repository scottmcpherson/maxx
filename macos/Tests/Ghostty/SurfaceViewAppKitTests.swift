@testable import Ghostty
import AppKit
import CoreGraphics
import Foundation
import SwiftUI
import Testing

struct SurfaceViewAppKitTests {
    @Test(arguments: [
        ("\u{0008}", true),
        ("\u{001F}", true),
        ("\u{007F}", false),
        (" ", false),
        ("h", false),
        ("", false),
        ("\u{0009}x", false),
        ("\u{0009}\u{0009}", false),
    ])
    func suppressesOnlySingleC0ControlTextWhileComposing(
        text: String,
        expected: Bool
    ) {
        #expect(
            Ghostty.SurfaceView.shouldSuppressComposingControlInput(
                text,
                composing: true
            ) == expected
        )
    }

    @Test func doesNotSuppressControlTextWhenNotComposing() {
        #expect(
            Ghostty.SurfaceView.shouldSuppressComposingControlInput(
                "\u{0008}",
                composing: false
            ) == false
        )
    }

    @Test func doesNotSuppressMissingText() {
        #expect(
            Ghostty.SurfaceView.shouldSuppressComposingControlInput(
                nil,
                composing: true
            ) == false
        )
    }

    @Test func agentFactsModelHidesWhenNoFactsExist() {
        #expect(AgentFactsTitlebarModel.hasFacts(
            declared: nil,
            relationship: nil,
            metadata: [:]) == false)
        #expect(AgentFactsTitlebarModel.visiblePillCount(
            declared: nil,
            relationship: nil,
            metadata: [:]) == 0)
    }

    @Test func agentFactsModelCollapsesStateAndSummaryIntoOnePill() {
        let declared = ControlDeclaredState(
            state: .complete,
            summary: "All checks passed",
            source: "agent",
            updatedAt: Date(timeIntervalSince1970: 0))

        #expect(Ghostty.AgentStateBadge.inlineLabel(for: declared) == "Complete")
        #expect(AgentFactsTitlebarModel.visiblePillCount(
            declared: declared,
            relationship: nil,
            metadata: [:]) == 1)
    }

    @Test func agentFactsModelCountsRelationshipAndMetadataPills() {
        let relationship = ControlRelationship(group: "Release", isChild: true)
        let metadata: [String: ControlJSONValue] = [
            "pr": .string("38"),
            "branch": .string("agent/max-24"),
        ]

        #expect(AgentFactsTitlebarModel.visiblePillCount(
            declared: nil,
            relationship: relationship,
            metadata: metadata) == 2)
    }

    @Test func agentFactsLeadingOffsetTracksExpandedSidebar() {
        #expect(TerminalWindow.agentFactsLeadingOffset(
            sidebarMode: true,
            visibleButtonMaxX: 70,
            sidebarControlsMaxX: 104,
            sidebarTrailingX: 176) == 184)
    }

    @Test func agentFactsLeadingOffsetFallsBackToCollapsedSidebarControls() {
        #expect(TerminalWindow.agentFactsLeadingOffset(
            sidebarMode: true,
            visibleButtonMaxX: 70,
            sidebarControlsMaxX: 104,
            sidebarTrailingX: 0) == 116)
    }

    @Test func nonDraggableHostingViewHitTestUsesSuperviewCoordinates() {
        let container = NSView(frame: NSRect(x: 0, y: 0, width: 240, height: 40))
        let hostingView = NonDraggableHostingView(rootView: Color.clear)
        hostingView.frame = NSRect(x: 80, y: 8, width: 120, height: 24)
        container.addSubview(hostingView)

        #expect(hostingView.hitTest(NSPoint(x: 40, y: 20)) == nil)
        #expect(hostingView.hitTest(NSPoint(x: 120, y: 20)) != nil)
    }
}
