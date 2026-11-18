import XCTest
@testable import ReelCore

final class LiveUploadTests: XCTestCase {
    func entries(_ durations: [Double]) -> [SegmentEntry] {
        durations.enumerated().map { SegmentEntry(index: $0.offset + 1, duration: $0.element, bytes: 100) }
    }

    func testPlaylistVOD() {
        let p = HLSPlaylist.make(segments: entries([4.0, 4.0, 2.5]), ended: true) { "https://x/\($0.rawValue)" }
        let lines = p.split(separator: "\n").map(String.init)
        XCTAssertEqual(lines.first, "#EXTM3U")
        XCTAssertTrue(lines.contains("#EXT-X-TARGETDURATION:4"))
        XCTAssertTrue(lines.contains("#EXT-X-PLAYLIST-TYPE:VOD"))
        XCTAssertTrue(lines.contains("#EXT-X-MAP:URI=\"https://x/init.mp4\""))
        XCTAssertEqual(lines.filter { $0.hasPrefix("#EXTINF") }, ["#EXTINF:4.00000,", "#EXTINF:4.00000,", "#EXTINF:2.50000,"])
        XCTAssertEqual(lines.filter { $0.hasPrefix("https://x/seg") }, ["https://x/seg00001.m4s", "https://x/seg00002.m4s", "https://x/seg00003.m4s"])
        XCTAssertEqual(lines.last, "#EXT-X-ENDLIST")
    }

    func testPlaylistEventHasNoEndAndRoundsTargetUp() {
        let p = HLSPlaylist.make(segments: entries([4.02]), ended: false) { $0.rawValue }
        XCTAssertTrue(p.contains("#EXT-X-PLAYLIST-TYPE:EVENT"))
        XCTAssertTrue(p.contains("#EXT-X-TARGETDURATION:5"))
        XCTAssertFalse(p.contains("ENDLIST"))
    }

    func testPlaylistSortsSegments() {
        let segs = [SegmentEntry(index: 2, duration: 1, bytes: 0), SegmentEntry(index: 1, duration: 1, bytes: 0)]
        let p = HLSPlaylist.make(segments: segs, ended: true) { $0.rawValue }
        XCTAssertLessThan(p.range(of: "seg00001")!.lowerBound, p.range(of: "seg00002")!.lowerBound)
    }

    func testSegmentLogUploadTracking() throws {
        var log = SegmentLog()
        log.hasInit = true
        log.append(SegmentEntry(index: 1, duration: 4, bytes: 10))
        log.append(SegmentEntry(index: 2, duration: 3, bytes: 10))
        log.append(SegmentEntry(index: 2, duration: 3.5, bytes: 11))   // replaced, not duplicated
        XCTAssertEqual(log.segments.count, 2)
        XCTAssertEqual(log.totalDuration, 7.5)
        XCTAssertEqual(log.nextIndex, 3)
        XCTAssertFalse(log.allUploaded)
        log.uploadedInit = true
        log.uploaded = [1]
        XCTAssertEqual(log.pendingUploads.map(\.index), [2])
        log.uploaded.insert(2)
        XCTAssertTrue(log.allUploaded)
        log.resetUploads(to: .keyed("k"))
        XCTAssertEqual(log.uploadedLocation, .keyed("k"))
        XCTAssertFalse(log.allUploaded)
        let back = try JSONDecoder().decode(SegmentLog.self, from: JSONEncoder().encode(log))
        XCTAssertEqual(back, log)
    }

    func testAdoptOrphanSegments() {
        var log = SegmentLog()
        log.append(SegmentEntry(index: 1, duration: 4, bytes: 1))
        log.adopt(segmentFileNames: ["seg00001.m4s", "seg00002.m4s", "seg00003.m4s", "init.mp4", "state.json", "segX.m4s"], fallbackDuration: 4)
        XCTAssertEqual(log.segments.map(\.index), [1, 2, 3])
        XCTAssertEqual(SegmentLog.segmentIndex("seg00042.m4s"), 42)
        XCTAssertNil(SegmentLog.segmentIndex("init.mp4"))
    }

    func testRecoveryPlan() {
        XCTAssertEqual(RecoveryPlan.decide(captureState: .complete, hasVideo: true, hasInitSegment: true, segmentCount: 3), .none)
        XCTAssertEqual(RecoveryPlan.decide(captureState: .recording, hasVideo: false, hasInitSegment: true, segmentCount: 3), .rebuildFromSegments)
        XCTAssertEqual(RecoveryPlan.decide(captureState: .recording, hasVideo: false, hasInitSegment: true, segmentCount: 0), .discard)
        XCTAssertEqual(RecoveryPlan.decide(captureState: .recording, hasVideo: false, hasInitSegment: false, segmentCount: 2), .discard)
        XCTAssertEqual(RecoveryPlan.decide(captureState: .finalizing, hasVideo: true, hasInitSegment: true, segmentCount: 3), .finishProcessing)
        XCTAssertEqual(RecoveryPlan.decide(captureState: .recovered, hasVideo: true, hasInitSegment: true, segmentCount: 3), .none)
    }

    // MARK: Audio mixing

    func testMixesTwoSourcesAdditively() {
        var m = AudioMixBuffer(sampleRate: 100)
        m.add(source: 0, seconds: 0, samples: [Float](repeating: 0.25, count: 10), channels: 1)
        m.add(source: 1, seconds: 0.05, samples: [Float](repeating: 0.5, count: 10), channels: 2)   // 5 stereo frames at frame 5
        let out = m.drain(upTo: 10)!
        XCTAssertEqual(out.start, 0)
        XCTAssertEqual(out.samples.count, 20)
        XCTAssertEqual(out.samples[0], 0.25)
        XCTAssertEqual(out.samples[9], 0.25)       // frame 4 right
        XCTAssertEqual(out.samples[10], 0.75)      // frame 5: both
        XCTAssertEqual(out.samples[19], 0.75)
        XCTAssertEqual(m.drainedFrame, 10)
    }

    func testGapsAreSilenceAndOutputClips() {
        var m = AudioMixBuffer(sampleRate: 100)
        m.add(source: 0, seconds: 0.1, samples: [0.9, 0.9], channels: 1)
        m.add(source: 1, seconds: 0.1, samples: [0.9, 0.9], channels: 2)
        let out = m.drain(upTo: 12)!
        XCTAssertEqual(Array(out.samples[0..<20]), [Float](repeating: 0, count: 20))
        XCTAssertEqual(out.samples[20], 1)   // 1.8 clipped
        XCTAssertNil(m.drain(upTo: 12))
    }

    func testContinuesContiguouslyWithinJitterAndResyncsBeyond() {
        var m = AudioMixBuffer(sampleRate: 1000, resyncThreshold: 0.02)   // 20 frames
        XCTAssertEqual(m.add(source: 0, seconds: 0, samples: [Float](repeating: 0.1, count: 100), channels: 1), 0)
        // Timestamp says 0.105 s (frame 105) but we're contiguous at 100: within jitter → 100.
        XCTAssertEqual(m.add(source: 0, seconds: 0.105, samples: [0.1], channels: 1), 100)
        // Far off (frame 300) → jump.
        XCTAssertEqual(m.add(source: 0, seconds: 0.3, samples: [0.1], channels: 1), 300)
    }

    func testLateSamplesAreDropped() {
        var m = AudioMixBuffer(sampleRate: 100)
        _ = m.drain(upTo: 50)
        XCTAssertNil(m.add(source: 0, seconds: 0.1, samples: [1, 1, 1], channels: 1))
        // Partially late: only the tail lands.
        XCTAssertEqual(m.add(source: 1, seconds: 0.48, samples: [Float](repeating: 0.5, count: 4), channels: 1), 48)
        let out = m.drain(upTo: 53)!
        XCTAssertEqual(out.start, 50)
        XCTAssertEqual(out.samples, [0.5, 0.5, 0.5, 0.5, 0, 0])
    }

    func testRejectsBadInput() {
        var m = AudioMixBuffer()
        XCTAssertNil(m.add(source: 0, seconds: 0, samples: [1], channels: 3))
        XCTAssertNil(m.add(source: 0, seconds: .infinity, samples: [1], channels: 1))
        XCTAssertNil(m.add(source: 0, seconds: 0, samples: [], channels: 1))
    }
}
