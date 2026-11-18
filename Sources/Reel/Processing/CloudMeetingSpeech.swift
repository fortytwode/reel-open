import AVFoundation
import Foundation
import ReelCore

/// Meeting audio leaves this Mac only through the authenticated Reel backend.
@MainActor
enum CloudMeetingSpeech {
    private static let base = CloudConfig.default.speechServiceURL
    private static let rate = 16_000
    private static let chunkFrames = 180 * rate
    private static let searchFrames = 10 * rate
    private static let windowFrames = 320 // 20 ms

    private struct SpeechResponse: Decodable {
        struct Language: Decodable { let code: String }
        let text: String
        let languages: [Language]
        let engine: String
    }
    private struct SummaryRequest: Encodable { let text: String; let title: String; let attendees: [String] }
    private struct SummaryResponse: Decodable {
        let title: String; let summary: String; let engine: String
        let has_meeting_content: Bool?
    }

    static func transcribe(video: URL, meeting: MeetingDetails, title: String, localeIdentifier: String) async throws -> TranscriptionService.Output {
        let owner = try requiredOwner(meeting)
        _ = try await authorizedSession(owner: owner)
        let audioURL = FileManager.default.temporaryDirectory.appendingPathComponent("reel-meeting-\(UUID().uuidString).caf")
        defer { try? FileManager.default.removeItem(at: audioURL) }
        guard try await PostProcessor.extractSpeechAudio(from: video, to: audioURL) else {
            throw CloudError.message("This meeting has no audio to transcribe.")
        }
        let file = try AVAudioFile(forReading: audioURL, commonFormat: .pcmFormatInt16, interleaved: true)
        guard file.processingFormat.sampleRate == Double(rate), file.processingFormat.channelCount == 1 else {
            throw CloudError.message("Meeting audio has an unexpected format.")
        }
        let language = Locale(identifier: localeIdentifier).language.languageCode?.identifier.lowercased() ?? "en"
        guard language.count == 2, language.allSatisfy({ $0.isASCII && $0.isLetter }) else {
            throw CloudError.message("Choose a supported transcription language in Settings.")
        }
        guard file.length > 0 else { throw CloudError.message("This meeting has no audio to transcribe.") }
        var pieces: [TranscriptSegmenter.Piece] = []
        var detectedLanguage = language
        var previousText = ""
        while file.framePosition < file.length {
            try Task.checkCancellation()
            let start = file.framePosition
            let frames = AVAudioFrameCount(min(Int64(chunkFrames), file.length - start))
            guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: frames) else {
                throw CloudError.message("Could not prepare meeting audio for transcription.")
            }
            try file.read(into: buffer, frameCount: frames)
            guard buffer.frameLength > 0, let samples = buffer.int16ChannelData?[0] else {
                throw CloudError.message("Could not read all meeting audio for transcription.")
            }
            var count = Int(buffer.frameLength)
            // AVAudioFile may return fewer frames than requested before EOF. Fill the
            // chunk so a short read cannot become a tiny, untranscribable final request.
            while count < Int(frames) {
                let remaining = frames - AVAudioFrameCount(count)
                guard let tail = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: remaining) else {
                    throw CloudError.message("Could not prepare meeting audio for transcription.")
                }
                try file.read(into: tail, frameCount: remaining)
                guard tail.frameLength > 0, let tailSamples = tail.int16ChannelData?[0] else {
                    throw CloudError.message("Could not read all meeting audio for transcription.")
                }
                samples.advanced(by: count).update(from: tailSamples, count: Int(tail.frameLength))
                count += Int(tail.frameLength)
            }
            if start + Int64(count) < file.length, count > searchFrames {
                var best = count - searchFrames
                var lowest = Double.infinity
                var offset = best
                // Keep at least a second for the final request when the recording
                // ends just beyond this chunk's nominal boundary.
                let searchEnd = min(count, Int(file.length - start) - rate)
                while offset + windowFrames <= searchEnd {
                    var energy = 0.0
                    for i in offset..<(offset + windowFrames) {
                        let value = Double(samples[i]); energy += value * value
                    }
                    if energy < lowest { lowest = energy; best = offset + windowFrames / 2 }
                    offset += windowFrames
                }
                count = best
                file.framePosition = start + Int64(count)
            }
            // Skip only exact digital silence; do not discard quiet speech with an energy threshold.
            guard SpeechAudioSignal.hasNonzeroPCM16(UnsafeBufferPointer(start: samples, count: count)) else { continue }
            let wav = wavData(samples: samples, count: count)
            let boundary = "Reel-\(UUID().uuidString)"
            var body = Data()
            func field(_ name: String, _ value: String) {
                body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".utf8))
            }
            field("language", language)
            field("title", String(title.prefix(200)))
            if !previousText.isEmpty { field("previous_text", String(previousText.suffix(1000))) }
            body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"meeting.wav\"\r\nContent-Type: audio/wav\r\n\r\n".utf8))
            body.append(wav)
            body.append(Data("\r\n--\(boundary)--\r\n".utf8))
            let data = try await request(path: "transcription", contentType: "multipart/form-data; boundary=\(boundary)", body: body, owner: owner)
            guard let result = try? JSONDecoder().decode(SpeechResponse.self, from: data), result.engine == "OpenAI gpt-transcribe" else {
                throw CloudError.message("Meeting transcription returned an invalid response.")
            }
            let text = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty {
                pieces.append(.init(start: Double(start) / Double(rate), end: Double(start + Int64(count)) / Double(rate), text: text))
                previousText = String((previousText + " " + text).suffix(1000))
            }
            if let code = result.languages.first?.code, !code.isEmpty { detectedLanguage = code }
        }
        return .init(engine: "OpenAI gpt-transcribe", locale: detectedLanguage, pieces: pieces)
    }

    static func summarize(transcript: Transcript, meeting: MeetingDetails, title: String) async throws -> AISummary {
        let owner = try requiredOwner(meeting)
        guard transcript.text.count <= 200_000 else { throw CloudError.message("Meeting transcript is too long for cloud summary.") }
        let body = try JSONEncoder().encode(SummaryRequest(text: transcript.text, title: String(title.prefix(200)), attendees: meeting.attendees))
        let data = try await request(path: "summary", contentType: "application/json", body: body, owner: owner)
        guard let result = try? JSONDecoder().decode(SummaryResponse.self, from: data), result.engine == "OpenAI gpt-6.1-sol", result.has_meeting_content == true,
              !result.summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw CloudError.message("Meeting summary returned an invalid response.")
        }
        return AISummary(title: result.title, summary: result.summary, chapters: [], engine: result.engine)
    }

    private static func requiredOwner(_ meeting: MeetingDetails) throws -> String {
        guard let owner = meeting.ownerUserID, !owner.isEmpty else { throw CloudError.message("Sign in as the meeting owner to process this meeting.") }
        return owner
    }

    private static func authorizedSession(owner: String) async throws -> CloudSession {
        guard await CloudAuth.shared.current?.userID == owner else {
            throw CloudError.message("Sign in as the meeting owner to process this meeting.")
        }
        let session = try await CloudAuth.shared.validSession()
        guard session.userID == owner, await CloudAuth.shared.current?.userID == owner else { throw CloudError.message("Sign in as the meeting owner to process this meeting.") }
        return session
    }

    private static func request(path: String, contentType: String, body: Data, owner: String) async throws -> Data {
        try Task.checkCancellation()
        let auth = try await authorizedSession(owner: owner)
        try Task.checkCancellation()
        var request = URLRequest(url: base.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.timeoutInterval = 180
        request.setValue("Bearer \(auth.idToken)", forHTTPHeaderField: "Authorization")
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 180
        configuration.timeoutIntervalForResource = 180
        let session = URLSession(configuration: configuration, delegate: MeetingSpeechRedirectBlocker(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            _ = try await authorizedSession(owner: owner)
            throw error
        }
        _ = try await authorizedSession(owner: owner)
        try Task.checkCancellation()
        if path == "summary", (response as? HTTPURLResponse)?.statusCode == 422,
           let error = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           error["code"] as? String == "meeting_review_required" {
            throw MeetingSummaryReviewError.required
        }
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw CloudError.message("Meeting cloud processing failed. Please try again.")
        }
        return data
    }

    private static func wavData(samples: UnsafePointer<Int16>, count: Int) -> Data {
        var data = Data()
        func append<T: FixedWidthInteger>(_ value: T) { var little = value.littleEndian; withUnsafeBytes(of: &little) { data.append(contentsOf: $0) } }
        data.append(contentsOf: "RIFF".utf8); append(UInt32(36 + count * 2))
        data.append(contentsOf: "WAVEfmt ".utf8); append(UInt32(16)); append(UInt16(1)); append(UInt16(1))
        append(UInt32(rate)); append(UInt32(rate * 2)); append(UInt16(2)); append(UInt16(16))
        data.append(contentsOf: "data".utf8); append(UInt32(count * 2))
        // All supported macOS CPUs are little-endian, matching PCM16 WAV.
        data.append(Data(bytes: samples, count: count * MemoryLayout<Int16>.size))
        return data
    }
}

private final class MeetingSpeechRedirectBlocker: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
