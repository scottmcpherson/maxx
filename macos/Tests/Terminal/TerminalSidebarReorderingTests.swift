import Testing
@testable import Ghostty

struct TerminalSidebarReorderingTests {
    @Test func movesLaterSessionToTop() {
        #expect(reorderedSessions(
            sourceIndex: 3,
            destinationIndex: 0,
            placement: .before) == [3, 0, 1, 2])
    }

    @Test func movesFirstSessionToBottom() {
        #expect(reorderedSessions(
            sourceIndex: 0,
            destinationIndex: 3,
            placement: .after) == [1, 2, 3, 0])
    }

    @Test func insertsBeforeAndAfterDestination() {
        #expect(reorderedSessions(
            sourceIndex: 0,
            destinationIndex: 2,
            placement: .before) == [1, 0, 2, 3])
        #expect(reorderedSessions(
            sourceIndex: 3,
            destinationIndex: 1,
            placement: .after) == [0, 1, 3, 2])
    }

    @Test func adjacentDropThatPreservesOrderIsNoOp() {
        #expect(TerminalSidebarReordering.destinationIndex(
            sourceIndex: 0,
            destinationIndex: 1,
            placement: .before) == 0)
        #expect(TerminalSidebarReordering.destinationIndex(
            sourceIndex: 1,
            destinationIndex: 0,
            placement: .after) == 1)
    }

    @Test func adjacentDropZonesShareOneInsertionBoundary() {
        let afterFirst = TerminalSidebarDropTargeting.insertionIndex(
            destinationIndex: 0,
            placement: .after)
        let beforeSecond = TerminalSidebarDropTargeting.insertionIndex(
            destinationIndex: 1,
            placement: .before)

        #expect(afterFirst == 1)
        #expect(beforeSecond == afterFirst)
    }

    @Test func outerDropZonesUseListBoundaries() {
        #expect(TerminalSidebarDropTargeting.insertionIndex(
            destinationIndex: 0,
            placement: .before) == 0)
        #expect(TerminalSidebarDropTargeting.insertionIndex(
            destinationIndex: 3,
            placement: .after) == 4)
    }

    @Test func adjacentDropTargetsTileWithoutDeadSpace() {
        let rowCount = 4

        for index in 1..<rowCount {
            let previous = TerminalSidebarDropTargeting.targetRange(
                rowIndex: index - 1,
                rowCount: rowCount)
            let current = TerminalSidebarDropTargeting.targetRange(
                rowIndex: index,
                rowCount: rowCount)

            #expect(previous.upperBound == current.lowerBound)
        }
    }

    private func reorderedSessions(
        sourceIndex: Int,
        destinationIndex: Int,
        placement: TerminalSidebarDropPlacement
    ) -> [Int] {
        var sessions = Array(0..<4)
        let session = sessions.remove(at: sourceIndex)
        let finalIndex = TerminalSidebarReordering.destinationIndex(
            sourceIndex: sourceIndex,
            destinationIndex: destinationIndex,
            placement: placement)
        sessions.insert(session, at: finalIndex)
        return sessions
    }
}
