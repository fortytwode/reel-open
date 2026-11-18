import Foundation

public struct TranscriptSegment: Codable, Equatable, Sendable {
    public var start: Double
    public var end: Double
    public var text: String
    public init(start: Double, end: Double, text: String) {
        self.start = start
        self.end = end
        self.text = text
    }
}

/// The transcript document stored next to each recording, locally and at
/// `reel/v/<id>/transcript.json`. Stable, documented schema (see README "Transcript API").
public struct Transcript: Codable, Equatable, Sendable {
    public var schemaVersion: Int
    public var id: String?
    public var title: String
    public var language: String
    public var engine: String
    public var createdAt: Date
    public var durationSeconds: Double
    public var text: String
    public var segments: [TranscriptSegment]
    /// "chunk" means seek times describe audio chunks, not aligned words or captions.
    public var timingGranularity: String?

    public init(id: String?, title: String, language: String, engine: String, createdAt: Date, durationSeconds: Double, segments: [TranscriptSegment]) {
        self.schemaVersion = 1
        self.id = id
        self.title = title
        self.language = language
        self.engine = engine
        self.createdAt = createdAt
        self.durationSeconds = durationSeconds
        self.segments = segments
        self.text = Self.joinedText(segments)
    }

    public static func joinedText(_ segments: [TranscriptSegment]) -> String {
        segments.map { $0.text.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }

    /// Plain text with `[m:ss]` timestamps, one segment per line.
    public func plainText() -> String {
        var lines = ["\(title)", ""]
        if timingGranularity == "chunk" {
            lines.append("Times are approximate audio-chunk boundaries, not word timestamps.")
            lines.append("")
        }
        if segments.isEmpty { lines.append(text.isEmpty ? "(no speech detected)" : text) }
        for s in segments { lines.append("[\(Self.timestamp(s.start))] \(s.text)") }
        return lines.joined(separator: "\n") + "\n"
    }

    public static func timestamp(_ seconds: Double) -> String {
        let total = max(0, Int(seconds.rounded(.down)))
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }

    public func encoded() throws -> Data { try ReelJSON.encoder.encode(self) }
}

/// Groups timed word/phrase runs (from SpeechTranscriber results or SFSpeech segments)
/// into readable caption-sized segments: break after sentence-ending punctuation once a
/// segment has a few words, on long pauses, or when a segment gets too long.
public enum TranscriptSegmenter {
    public struct Piece: Equatable, Sendable {
        public var start: Double
        public var end: Double
        public var text: String
        public init(start: Double, end: Double, text: String) {
            self.start = start
            self.end = end
            self.text = text
        }
    }

    public static func segments(from pieces: [Piece], maxDuration: Double = 12, pauseBreak: Double = 1.2, maxChars: Int = 220) -> [TranscriptSegment] {
        var result: [TranscriptSegment] = []
        var current: TranscriptSegment?
        for piece in pieces.sorted(by: { $0.start < $1.start }) {
            let text = piece.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { continue }
            if var c = current {
                let gap = piece.start - c.end
                let tooLong = piece.end - c.start > maxDuration || c.text.count + text.count > maxChars
                let sentenceDone = c.text.last.map { ".?!".contains($0) } ?? false
                if gap >= pauseBreak || tooLong || (sentenceDone && c.text.split(separator: " ").count >= 4) {
                    result.append(c)
                    current = TranscriptSegment(start: piece.start, end: piece.end, text: text)
                } else {
                    c.text += (needsNoSpace(before: text) ? "" : " ") + text
                    c.end = max(c.end, piece.end)
                    current = c
                }
            } else {
                current = TranscriptSegment(start: piece.start, end: piece.end, text: text)
            }
        }
        if let c = current { result.append(c) }
        return result
    }

    static func needsNoSpace(before text: String) -> Bool {
        guard let first = text.first else { return true }
        return ",.?!;:'’)".contains(first)
    }
}

public enum ReelJSON {
    public static var encoder: JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        e.dateEncodingStrategy = .iso8601
        return e
    }
    public static var decoder: JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }
}
