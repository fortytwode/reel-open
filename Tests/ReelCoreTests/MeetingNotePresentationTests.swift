import XCTest
@testable import ReelCore

final class MeetingNotePresentationTests: XCTestCase {
    func testCanonicalSummaryRetainsSectionOrderAndOriginalCopy() {
        let source = """
        Outcome
        The launch remains on track.

        Key points
        • Draft: ready for review.

        Decisions
        • Ship the first version.

        Action items
        • Alice: Share the build (due: Friday)

        Open questions
        • Who owns the release notes?
        """
        let note = MeetingNotePresentation(summary: source)
        XCTAssertEqual(note.source, source)
        XCTAssertEqual(note.sections.map(\.kind), [.outcome, .keyPoints, .decisions, .actionItems, .openQuestions])
        XCTAssertEqual(note.sections[0].blocks, [.paragraph("The launch remains on track.")])
        XCTAssertEqual(note.sections[3].blocks, [.bullet(text: "Alice: Share the build (due: Friday)", depth: 0, marker: "•")])
    }

    func testLegacyHeadingsAndNestedListsPreserveUnrecognizedText() {
        let source = "First line.\r\nSecond line.\r\n\r\n**Next steps:**\n1. Main step\n  - Substep\n    ◦ Detail\n2) Second step\n\n## Related reading\nhttps://example.com/notes"
        let note = MeetingNotePresentation(summary: source)
        XCTAssertEqual(note.source, source)
        XCTAssertEqual(note.sections.map(\.title), [nil, "Next steps", "Related reading"])
        XCTAssertEqual(note.sections.map(\.kind), [nil, .actionItems, nil])
        XCTAssertEqual(note.sections[0].blocks, [.paragraph("First line.\nSecond line.")])
        XCTAssertEqual(note.sections[1].blocks, [
            .bullet(text: "Main step", depth: 0, marker: "1."),
            .bullet(text: "Substep", depth: 1, marker: "-"),
            .bullet(text: "Detail", depth: 2, marker: "◦"),
            .bullet(text: "Second step", depth: 0, marker: "2)")
        ])
        XCTAssertEqual(note.sections[2].blocks, [.paragraph("https://example.com/notes")])
    }

    func testUnstructuredAndBlankSummaries() {
        let note = MeetingNotePresentation(summary: "Outcome was discussed.\n\nNo follow-up is planned.")
        XCTAssertEqual(note.sections.count, 1)
        XCTAssertNil(note.sections[0].title)
        XCTAssertEqual(note.sections[0].blocks, [.paragraph("Outcome was discussed."), .paragraph("No follow-up is planned.")])
        XCTAssertTrue(MeetingNotePresentation(summary: " \n").sections.isEmpty)
    }
}
