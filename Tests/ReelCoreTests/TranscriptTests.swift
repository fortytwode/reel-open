import XCTest
@testable import ReelCore

final class TranscriptTests: XCTestCase {
    typealias P = TranscriptSegmenter.Piece

    func testTimestampFormatting() {
        XCTAssertEqual(Transcript.timestamp(0), "0:00")
        XCTAssertEqual(Transcript.timestamp(65), "1:05")
        XCTAssertEqual(Transcript.timestamp(3725), "1:02:05")
        XCTAssertEqual(Transcript.timestamp(59.9), "0:59")
        XCTAssertEqual(Transcript.timestamp(-5), "0:00")
    }

    func makeTranscript(_ segs: [TranscriptSegment]) -> Transcript {
        Transcript(id: "abc", title: "My Title", language: "en-US", engine: "test", createdAt: Date(timeIntervalSince1970: 1_700_000_000), durationSeconds: 100, segments: segs)
    }

    func testPlainText() {
        let t = makeTranscript([.init(start: 0, end: 2, text: "Hello"), .init(start: 65, end: 70, text: "World")])
        XCTAssertEqual(t.plainText(), "My Title\n\n[0:00] Hello\n[1:05] World\n")
        XCTAssertEqual(t.text, "Hello World")
    }

    func testPlainTextEmpty() {
        XCTAssertEqual(makeTranscript([]).plainText(), "My Title\n\n(no speech detected)\n")
    }

    func testJoinedTextTrimsAndSkipsEmpty() {
        let s: [TranscriptSegment] = [.init(start: 0, end: 1, text: " a "), .init(start: 1, end: 2, text: "  "), .init(start: 2, end: 3, text: "b")]
        XCTAssertEqual(Transcript.joinedText(s), "a b")
    }

    func testJSONRoundTrip() throws {
        let t = makeTranscript([.init(start: 0, end: 2, text: "Hello"), .init(start: 3, end: 4, text: "there")])
        let data = try t.encoded()
        let json = String(decoding: data, as: UTF8.self)
        XCTAssertTrue(json.contains("2023-11-14T22:13:20Z"))
        XCTAssertTrue(json.contains("\"schemaVersion\" : 1"))
        let back = try ReelJSON.decoder.decode(Transcript.self, from: data)
        XCTAssertEqual(back, t)
    }

    func testCloudChunkTimingIsLabeledAndRoundTrips() throws {
        var t = makeTranscript([.init(start: 0, end: 180, text: "Meeting notes.")])
        t.timingGranularity = "chunk"
        XCTAssertTrue(t.plainText().contains("Times are approximate audio-chunk boundaries"))
        let back = try ReelJSON.decoder.decode(Transcript.self, from: t.encoded())
        XCTAssertEqual(back.timingGranularity, "chunk")
        XCTAssertEqual(back, t)
        XCTAssertNil(try ReelJSON.decoder.decode(Transcript.self, from: makeTranscript([]).encoded()).timingGranularity)
    }

    func testSegmenterSplitsOnLongPause() {
        let r = TranscriptSegmenter.segments(from: [P(start: 0, end: 1, text: "hello"), P(start: 3, end: 4, text: "world")])
        XCTAssertEqual(r.map(\.text), ["hello", "world"])
    }

    func testSegmenterKeepsShortGap() {
        let r = TranscriptSegmenter.segments(from: [P(start: 0, end: 1, text: "hello"), P(start: 1.5, end: 2, text: "world")])
        XCTAssertEqual(r, [TranscriptSegment(start: 0, end: 2, text: "hello world")])
    }

    func testSegmenterSplitsOnSentenceEndAfterFourWords() {
        let pieces = [P(start: 0, end: 1, text: "one"), P(start: 1, end: 2, text: "two"), P(start: 2, end: 3, text: "three"), P(start: 3, end: 4, text: "four."), P(start: 4, end: 5, text: "five")]
        let r = TranscriptSegmenter.segments(from: pieces)
        XCTAssertEqual(r.map(\.text), ["one two three four.", "five"])
    }

    func testSegmenterDoesNotSplitShortSentence() {
        let r = TranscriptSegmenter.segments(from: [P(start: 0, end: 1, text: "Hi."), P(start: 1, end: 2, text: "There")])
        XCTAssertEqual(r.map(\.text), ["Hi. There"])
    }

    func testSegmenterSplitsOnMaxDuration() {
        let r = TranscriptSegmenter.segments(from: [P(start: 0, end: 5, text: "a"), P(start: 5, end: 11, text: "b"), P(start: 11, end: 13, text: "c")], maxDuration: 12)
        XCTAssertEqual(r.map(\.text), ["a b", "c"])
    }

    func testSegmenterJoinsPunctuationWithoutSpace() {
        let r = TranscriptSegmenter.segments(from: [P(start: 0, end: 1, text: "hello"), P(start: 1, end: 1.2, text: ","), P(start: 1.2, end: 2, text: "world")])
        XCTAssertEqual(r.map(\.text), ["hello, world"])
    }

    func testSegmenterIgnoresEmptyAndSorts() {
        let r = TranscriptSegmenter.segments(from: [P(start: 1, end: 2, text: "world"), P(start: 0.5, end: 0.8, text: "   "), P(start: 0, end: 1, text: "hello")])
        XCTAssertEqual(r, [TranscriptSegment(start: 0, end: 2, text: "hello world")])
    }

    func testSegmenterEmptyInput() {
        XCTAssertEqual(TranscriptSegmenter.segments(from: []), [])
    }
}
