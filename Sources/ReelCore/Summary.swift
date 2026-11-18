import Foundation

/// AI title + summary + chapters for a recording (Loom AI's auto title/summary/chapters),
/// produced on-device from the transcript.
public struct AISummary: Codable, Equatable, Sendable {
    public var title: String?
    public var summary: String?
    public var chapters: [Chapter]
    public var engine: String
    public init(title: String?, summary: String?, chapters: [Chapter], engine: String) {
        self.title = title
        self.summary = summary
        self.chapters = chapters
        self.engine = engine
    }

    /// Sanitises model output: trims, enforces lengths, keeps chapters inside the recording,
    /// sorted, de-duplicated, at least 20 s apart, first one at 0. Invalid parts become nil/empty.
    public func validated(duration: Double) -> AISummary {
        func clean(_ s: String?, max: Int) -> String? {
            guard var t = s?.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespacesAndNewlines) else { return nil }
            t = t.trimmingCharacters(in: CharacterSet(charactersIn: "\"“”'*#"))
            while t.contains("  ") { t = t.replacingOccurrences(of: "  ", with: " ") }
            guard t.count >= 3 else { return nil }
            return t.count > max ? String(t.prefix(max - 1)).trimmingCharacters(in: .whitespaces) + "…" : t
        }
        var summaryText = summary?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let s = summaryText, s.count > 700 { summaryText = String(s.prefix(699)) + "…" }
        if let s = summaryText, s.count < 10 { summaryText = nil }
        var out: [Chapter] = []
        for c in chapters.sorted(by: { $0.start < $1.start }) {
            guard c.start.isFinite, c.start >= 0, c.start < max(duration, 0.01), let t = clean(c.title, max: 60) else { continue }
            if let last = out.last, c.start - last.start < 20 { continue }
            out.append(Chapter(start: (c.start * 10).rounded() / 10, title: t))
        }
        if out.count < 2 { out = [] } else { out[0].start = 0 }
        return AISummary(title: clean(title, max: 90), summary: summaryText, chapters: out, engine: engine)
    }
}

/// Deterministic summary when no on-device language model is available: extractive (keyword
/// scored sentences), chapters split at the longest pauses near even intervals.
public enum FallbackSummarizer {
    static let stopwords: Set<String> = [
        "a", "an", "the", "and", "or", "but", "so", "of", "to", "in", "on", "for", "with", "at", "by", "from", "is", "are",
        "was", "were", "be", "been", "being", "it", "its", "it's", "this", "that", "these", "those", "i", "i'm", "you",
        "we", "they", "he", "she", "my", "your", "our", "their", "me", "us", "them", "as", "if", "then", "than", "just",
        "like", "um", "uh", "okay", "ok", "yeah", "so", "right", "really", "very", "can", "will", "would", "could",
        "should", "do", "does", "did", "have", "has", "had", "not", "no", "yes", "there", "here", "what", "which", "who",
        "how", "when", "where", "why", "all", "some", "any", "about", "into", "out", "up", "down", "over", "also", "going",
        "gonna", "get", "got", "let's", "let", "now", "know", "think", "want", "see", "look", "one", "two", "thing", "things",
        "kind", "sort", "lot", "bit", "actually", "basically", "hey", "hi", "hello", "everyone", "guys", "today", "go",
        "we're", "you're", "they're", "that's", "there's", "don't", "can't", "it'll", "i'll", "we'll", "you'll", "'s",
    ]
    static let fillerOpeners = ["so ", "okay ", "ok ", "um ", "uh ", "alright ", "all right ", "hey ", "hi ", "hello ", "and ", "yeah ", "right "]

    public static func words(_ s: String) -> [String] {
        s.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber && $0 != "'" && $0 != "’" }).map(String.init)
    }

    /// Sentences with their start time (from the segment they begin in).
    public static func sentences(_ segments: [TranscriptSegment]) -> [(start: Double, text: String)] {
        var out: [(Double, String)] = []
        for seg in segments {
            var current = ""
            for ch in seg.text {
                current.append(ch)
                if ".?!".contains(ch) {
                    let t = current.trimmingCharacters(in: .whitespaces)
                    if !t.isEmpty { out.append((seg.start, t)) }
                    current = ""
                }
            }
            let t = current.trimmingCharacters(in: .whitespaces)
            if !t.isEmpty { out.append((seg.start, t)) }
        }
        return out
    }

    static func stripFiller(_ s: String) -> String {
        var t = s.trimmingCharacters(in: .whitespaces)
        var changed = true
        while changed {
            changed = false
            for f in fillerOpeners where t.lowercased().hasPrefix(f) {
                t = String(t.dropFirst(f.count)).trimmingCharacters(in: CharacterSet(charactersIn: " ,"))
                changed = true
            }
        }
        return t
    }

    static func headline(_ s: String, maxWords: Int) -> String? {
        let t = stripFiller(s).trimmingCharacters(in: CharacterSet(charactersIn: ".?!,; "))
        let w = t.split(separator: " ")
        guard w.count >= 2 else { return nil }
        var h = w.prefix(maxWords).joined(separator: " ")
        if w.count > maxWords { h += "…" }
        return h.prefix(1).uppercased() + h.dropFirst()
    }

    public static func summarize(_ transcript: Transcript, duration: Double) -> AISummary {
        let sents = sentences(transcript.segments)
        guard !sents.isEmpty else { return AISummary(title: nil, summary: nil, chapters: [], engine: "fallback") }
        var freq: [String: Int] = [:]
        for s in sents { for w in words(s.text) where !stopwords.contains(w) && w.count > 2 { freq[w, default: 0] += 1 } }
        func score(_ s: String) -> Double {
            let ws = words(s)
            guard ws.count >= 4 else { return 0 }
            let sum = ws.reduce(0) { $0 + Double(stopwords.contains($1) ? 0 : (freq[$1] ?? 0)) }
            return sum / Double(ws.count).squareRoot()
        }
        // Title: the best-scoring of the first few sentences, as a short headline.
        let titleSource = sents.prefix(4).max { score($0.text) < score($1.text) }?.text ?? sents[0].text
        let title = headline(titleSource, maxWords: 9)
        // Summary: top 3 sentences in their original order, ≤ 420 chars.
        let ranked = sents.enumerated().sorted { score($0.element.text) > score($1.element.text) }.prefix(3).map(\.offset).sorted()
        var summary = ""
        for i in ranked {
            let s = stripFiller(sents[i].text)
            let sentence = s.prefix(1).uppercased() + s.dropFirst()
            if summary.count + sentence.count > 420 { break }
            summary += (summary.isEmpty ? "" : " ") + sentence
        }
        return AISummary(title: title, summary: summary.isEmpty ? nil : summary,
                         chapters: chapters(transcript.segments, duration: duration), engine: "fallback").validated(duration: duration)
    }

    /// 2–8 chapters for recordings ≥ 90 s: target even intervals, cut at the longest pause
    /// between segments within ±40 % of the target.
    public static func chapters(_ segments: [TranscriptSegment], duration: Double) -> [Chapter] {
        guard duration >= 90, segments.count >= 4 else { return [] }
        let count = min(8, max(2, Int((duration / 120).rounded())))
        let interval = duration / Double(count)
        var starts = [0]
        for k in 1..<count {
            let target = interval * Double(k)
            var best: (index: Int, gap: Double)?
            for i in 1..<segments.count {
                let s = segments[i]
                guard abs(s.start - target) <= interval * 0.4, i > (starts.last ?? 0) else { continue }
                let gap = s.start - segments[i - 1].end
                if best == nil || gap > best!.gap { best = (i, gap) }
            }
            if let b = best { starts.append(b.index) }
        }
        return starts.compactMap { i -> Chapter? in
            guard let h = headline(segments[i].text, maxWords: 6) else { return nil }
            return Chapter(start: i == 0 ? 0 : segments[i].start, title: h)
        }
    }

    /// Transcript text for a prompt, with [m:ss] markers, condensed to `maxChars` by keeping
    /// evenly spaced segments.
    public static func promptTranscript(_ segments: [TranscriptSegment], maxChars: Int) -> String {
        let lines = segments.map { "[\(Transcript.timestamp($0.start))] \($0.text)" }
        let total = lines.reduce(0) { $0 + $1.count + 1 }
        guard total > maxChars, !lines.isEmpty else { return lines.joined(separator: "\n") }
        let keep = max(1, Int(Double(lines.count) * Double(maxChars) / Double(total)))
        let step = Double(lines.count) / Double(keep)
        return (0..<keep).map { lines[min(lines.count - 1, Int(Double($0) * step))] }.joined(separator: "\n")
    }

    /// Whether a recording's title is still Reel's default ("Recording – …") and so may be replaced.
    public static func isDefaultTitle(_ t: String) -> Bool { t.hasPrefix("Recording – ") }
}
