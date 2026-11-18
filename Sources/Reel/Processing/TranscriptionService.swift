import AVFoundation
import Foundation
import ReelCore
import Speech

/// On-device transcription of a finished recording, following Murmur's approach:
/// SpeechAnalyzer + SpeechTranscriber (macOS 26) with word timings, falling back to
/// SFSpeechRecognizer with `requiresOnDeviceRecognition`. Nothing leaves the Mac.
enum TranscriptionService {
    struct Output {
        var engine: String
        var locale: String
        var pieces: [TranscriptSegmenter.Piece]
    }

    static func transcribe(video: URL, localeIdentifier: String = "en-US") async throws -> Output {
        let audioURL = FileManager.default.temporaryDirectory.appendingPathComponent("reel-speech-\(UUID().uuidString).caf")
        defer { try? FileManager.default.removeItem(at: audioURL) }
        guard try await PostProcessor.extractSpeechAudio(from: video, to: audioURL) else {
            return Output(engine: "none", locale: localeIdentifier, pieces: [])
        }
        if #available(macOS 26.0, *), SpeechTranscriber.isAvailable {
            do { return try await analyzer(audioURL: audioURL, localeIdentifier: localeIdentifier) }
            catch { Log.speech.error("SpeechAnalyzer failed, falling back: \(error.localizedDescription, privacy: .public)") }
        }
        return try await legacy(audioURL: audioURL, localeIdentifier: localeIdentifier)
    }

    @available(macOS 26.0, *)
    private static func analyzer(audioURL: URL, localeIdentifier: String) async throws -> Output {
        let resolved = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: localeIdentifier))
        guard let locale = resolved else {
            throw NSError(domain: "Reel", code: 40, userInfo: [NSLocalizedDescriptionKey: "SpeechTranscriber does not support \(localeIdentifier)"])
        }
        let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange])
        switch await AssetInventory.status(forModules: [transcriber]) {
        case .installed: break
        case .unsupported: throw NSError(domain: "Reel", code: 41, userInfo: [NSLocalizedDescriptionKey: "Speech model unsupported"])
        default:
            if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                Log.speech.info("Downloading speech model for \(locale.identifier, privacy: .public)")
                try await request.downloadAndInstall()
            }
        }
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let collector = Task { () throws -> [TranscriptSegmenter.Piece] in
            var pieces: [TranscriptSegmenter.Piece] = []
            for try await result in transcriber.results where result.isFinal {
                var added = false
                for run in result.text.runs {
                    guard let range = run.audioTimeRange else { continue }
                    let text = String(result.text[run.range].characters)
                    guard !text.trimmingCharacters(in: .whitespaces).isEmpty else { continue }
                    pieces.append(.init(start: range.start.seconds, end: range.end.seconds, text: text))
                    added = true
                }
                if !added {
                    let text = String(result.text.characters)
                    pieces.append(.init(start: result.range.start.seconds, end: result.range.end.seconds, text: text))
                }
            }
            return pieces
        }
        let file = try AVAudioFile(forReading: audioURL)
        if let last = try await analyzer.analyzeSequence(from: file) {
            try await analyzer.finalizeAndFinish(through: last)
        } else {
            await analyzer.cancelAndFinishNow()
        }
        let pieces = try await collector.value
        return Output(engine: "SpeechAnalyzer", locale: locale.identifier, pieces: mergeWordRuns(pieces))
    }

    /// SpeechTranscriber runs can split words and attach spacing to runs; merge pieces that
    /// don't start with whitespace into the previous one so words aren't broken.
    static func mergeWordRuns(_ pieces: [TranscriptSegmenter.Piece]) -> [TranscriptSegmenter.Piece] {
        var out: [TranscriptSegmenter.Piece] = []
        for p in pieces {
            if let last = out.last, let first = p.text.first, !first.isWhitespace, !(last.text.last?.isWhitespace ?? true), p.start - last.end < 0.05 {
                out[out.count - 1].text += p.text
                out[out.count - 1].end = p.end
            } else {
                out.append(p)
            }
        }
        return out.map { .init(start: $0.start, end: $0.end, text: $0.text.trimmingCharacters(in: .whitespaces)) }
    }

    private static func legacy(audioURL: URL, localeIdentifier: String) async throws -> Output {
        func localeKey(_ locale: Locale) -> String {
            locale.identifier.replacingOccurrences(of: "_", with: "-").lowercased()
        }
        let requestedKey = localeKey(Locale(identifier: localeIdentifier))
        guard let locale = SFSpeechRecognizer.supportedLocales().first(where: { localeKey($0) == requestedKey }),
              let recognizer = SFSpeechRecognizer(locale: locale), localeKey(recognizer.locale) == requestedKey,
              recognizer.supportsOnDeviceRecognition else {
            throw NSError(domain: "Reel", code: 43, userInfo: [NSLocalizedDescriptionKey: "On-device speech recognition is unavailable for \(localeIdentifier). Choose a supported transcription language in Settings."])
        }
        if SFSpeechRecognizer.authorizationStatus() == .notDetermined {
            _ = await withCheckedContinuation { c in SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) } }
        }
        guard SFSpeechRecognizer.authorizationStatus() == .authorized else {
            throw NSError(domain: "Reel", code: 42, userInfo: [NSLocalizedDescriptionKey: "Speech Recognition permission is off (needed on macOS < 26)"])
        }
        let request = SFSpeechURLRecognitionRequest(url: audioURL)
        request.taskHint = .dictation
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = false
        request.addsPunctuation = true
        let pieces: [TranscriptSegmenter.Piece] = try await withCheckedThrowingContinuation { c in
            var resumed = false
            recognizer.recognitionTask(with: request) { result, error in
                guard !resumed else { return }
                if let result, result.isFinal {
                    resumed = true
                    c.resume(returning: result.bestTranscription.segments.map {
                        .init(start: $0.timestamp, end: $0.timestamp + $0.duration, text: $0.substring)
                    })
                } else if let error {
                    resumed = true
                    let ns = error as NSError
                    // 1110 = no speech detected
                    if ns.code == 1110 || ns.code == 203 { c.resume(returning: []) } else { c.resume(throwing: error) }
                }
            }
        }
        return Output(engine: "SFSpeechRecognizer", locale: recognizer.locale.identifier, pieces: pieces)
    }
}
