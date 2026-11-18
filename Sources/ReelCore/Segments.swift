import Foundation

/// One HLS media segment written during capture (fragmented MP4, `segNNNNN.m4s`).
public struct SegmentEntry: Codable, Equatable, Sendable {
    public var index: Int          // 1-based
    public var duration: Double
    public var bytes: Int
    public init(index: Int, duration: Double, bytes: Int) {
        self.index = index
        self.duration = duration
        self.bytes = bytes
    }
    public var file: RemoteFile { .segment(index) }
}

/// `<recording folder>/segments/state.json`: the segments written so far and which of them
/// have been uploaded (and where). Rewritten after every segment, so it survives a crash and
/// drives both crash recovery and resuming an interrupted upload (Loom keeps an equivalent
/// on-disk RecordingManifest).
public struct SegmentLog: Codable, Equatable, Sendable {
    public var hasInit = false
    public var segments: [SegmentEntry] = []
    /// Capture finished normally (the last segment has been flushed).
    public var ended = false
    /// Location the uploaded objects below were written to.
    public var uploadedLocation: RemoteLocation?
    public var uploadedInit = false
    public var uploaded: Set<Int> = []
    /// The final playlist (with EXT-X-ENDLIST) has been uploaded.
    public var uploadedFinalPlaylist = false

    public init() {}

    public static let fileName = "state.json"
    public static let directoryName = "segments"

    public var totalDuration: Double { segments.reduce(0) { $0 + $1.duration } }
    public var nextIndex: Int { (segments.map(\.index).max() ?? 0) + 1 }
    public var pendingUploads: [SegmentEntry] { segments.filter { !uploaded.contains($0.index) } }
    public var allUploaded: Bool { hasInit && uploadedInit && pendingUploads.isEmpty }

    public mutating func append(_ entry: SegmentEntry) {
        segments.removeAll { $0.index == entry.index }
        segments.append(entry)
        segments.sort { $0.index < $1.index }
    }

    /// Forgets upload progress (used when the recording moves to another location).
    public mutating func resetUploads(to location: RemoteLocation?) {
        uploadedLocation = location
        uploadedInit = false
        uploaded = []
        uploadedFinalPlaylist = false
    }

    /// Segment files that exist on disk but are missing from the log (the app died between
    /// writing a segment and updating the log). Durations are unknown, so the recovered log
    /// uses `fallbackDuration` for them.
    public mutating func adopt(segmentFileNames: [String], fallbackDuration: Double) {
        let known = Set(segments.map(\.index))
        for name in segmentFileNames {
            guard let n = Self.segmentIndex(name), !known.contains(n) else { continue }
            append(SegmentEntry(index: n, duration: fallbackDuration, bytes: 0))
        }
    }

    public static func segmentIndex(_ fileName: String) -> Int? {
        guard fileName.hasPrefix("seg"), fileName.hasSuffix(".m4s") else { return nil }
        return Int(fileName.dropFirst(3).dropLast(4))
    }
}

/// Builds the HLS media playlist for fMP4 segments. URIs are absolute (Firebase Storage object
/// URLs are a single percent-encoded path component, so relative URIs can't resolve).
public enum HLSPlaylist {
    public static func make(segments: [SegmentEntry], ended: Bool, uri: (RemoteFile) -> String) -> String {
        let target = max(1, Int((segments.map(\.duration).max() ?? 4).rounded(.up)))
        var lines = [
            "#EXTM3U",
            "#EXT-X-VERSION:7",
            "#EXT-X-TARGETDURATION:\(target)",
            "#EXT-X-MEDIA-SEQUENCE:0",
            "#EXT-X-PLAYLIST-TYPE:\(ended ? "VOD" : "EVENT")",
            "#EXT-X-INDEPENDENT-SEGMENTS",
            "#EXT-X-MAP:URI=\"\(uri(.initSegment))\"",
        ]
        for s in segments.sorted(by: { $0.index < $1.index }) {
            lines.append(String(format: "#EXTINF:%.5f,", s.duration))
            lines.append(uri(s.file))
        }
        if ended { lines.append("#EXT-X-ENDLIST") }
        return lines.joined(separator: "\n") + "\n"
    }
}

/// Decides what to do with a recording folder found at launch.
public enum RecoveryPlan: Equatable, Sendable {
    /// Nothing to recover.
    case none
    /// The capture never finished: rebuild video.mp4 from the segments on disk.
    case rebuildFromSegments
    /// The MP4 exists but post-processing (thumbnail/transcript/upload) didn't finish.
    case finishProcessing
    /// Nothing usable was captured: discard the folder.
    case discard

    public static func decide(captureState: CaptureState, hasVideo: Bool, hasInitSegment: Bool, segmentCount: Int) -> RecoveryPlan {
        switch captureState {
        case .complete, .recovered:
            return .none
        case .recording, .finalizing:
            if hasVideo { return .finishProcessing }
            if hasInitSegment && segmentCount > 0 { return .rebuildFromSegments }
            return .discard
        }
    }
}
