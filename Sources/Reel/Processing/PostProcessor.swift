import AppKit
import AVFoundation
import ReelCore

/// After capture: assembles the HLS segments into a regular MP4 (video and the already-mixed
/// audio passed through, faststart), trims, and makes thumbnails and speech audio.
enum PostProcessor {
    /// init.mp4 + segNNNNN.m4s concatenated is a valid fragmented MP4; a passthrough export turns
    /// it into a plain faststart MP4 in a couple of seconds even for long recordings (no re-encode).
    static func assemble(segments dir: URL, log: SegmentLog, output: URL) async throws {
        let fm = FileManager.default
        let name = UUID().uuidString
        let fragmented = dir.appendingPathComponent(".assembled-\(name).mp4")
        let staged = output.deletingLastPathComponent().appendingPathComponent(".export-\(name).mp4")
        guard fm.createFile(atPath: fragmented.path, contents: nil) else { throw err("Could not create \(fragmented.path)") }
        defer {
            try? fm.removeItem(at: fragmented)
            try? fm.removeItem(at: staged)
            removeWriterLeftovers(next: staged)
        }
        let handle = try FileHandle(forWritingTo: fragmented)
        do {
            try handle.write(contentsOf: Data(contentsOf: dir.appendingPathComponent(RemoteFile.initSegment.rawValue)))
            for s in log.segments.sorted(by: { $0.index < $1.index }) {
                let url = dir.appendingPathComponent(s.file.rawValue)
                try handle.write(contentsOf: Data(contentsOf: url, options: .mappedIfSafe))
            }
            try handle.close()
        } catch {
            try? handle.close()
            throw error
        }
        try await export(AVURLAsset(url: fragmented), to: staged, preset: AVAssetExportPresetPassthrough, range: nil)
        if fm.fileExists(atPath: output.path) {
            _ = try fm.replaceItemAt(output, withItemAt: staged)
        } else {
            try fm.moveItem(at: staged, to: output)
        }
    }

    /// Re-exports [trim.start, trim.end] exactly (re-encoded, so cuts aren't limited to keyframes).
    static func exportTrimmed(video: URL, trim: TrimRange, to output: URL) async throws {
        try? FileManager.default.removeItem(at: output)
        let range = CMTimeRange(start: CMTime(seconds: trim.start, preferredTimescale: 600), end: CMTime(seconds: trim.end, preferredTimescale: 600))
        try await export(AVURLAsset(url: video), to: output, preset: AVAssetExportPresetHighestQuality, range: range)
    }

    private static func export(_ asset: AVAsset, to output: URL, preset: String, range: CMTimeRange?) async throws {
        guard let session = AVAssetExportSession(asset: asset, presetName: preset) else { throw err("Export unavailable") }
        session.shouldOptimizeForNetworkUse = true
        if let range { session.timeRange = range }
        try await session.export(to: output, as: .mp4)
        removeWriterLeftovers(next: output)
    }

    /// AVAssetWriter's network optimization can leave "<name>.sb-*" temp files behind.
    static func removeWriterLeftovers(next file: URL) {
        let dir = file.deletingLastPathComponent()
        let prefix = file.lastPathComponent + ".sb-"
        for f in (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [] where f.hasPrefix(prefix) {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(f))
        }
    }

    static func duration(of url: URL) async -> Double {
        (try? await AVURLAsset(url: url).load(.duration).seconds) ?? 0
    }

    static func makeThumbnail(video: URL, to output: URL) async -> Bool {
        let asset = AVURLAsset(url: video)
        let gen = AVAssetImageGenerator(asset: asset)
        gen.appliesPreferredTrackTransform = true
        gen.maximumSize = CGSize(width: 960, height: 960)
        let d = await duration(of: video)
        let t = CMTime(seconds: min(1.0, d / 2), preferredTimescale: 600)
        guard let (cg, _) = try? await gen.image(at: t) else { return false }
        let rep = NSBitmapImageRep(cgImage: cg)
        guard let data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.8]) else { return false }
        return (try? data.write(to: output, options: .atomic)) != nil
    }

    /// Extracts the (mixed) audio as 16 kHz mono PCM .caf for speech recognition.
    static func extractSpeechAudio(from video: URL, to output: URL) async throws -> Bool {
        try? FileManager.default.removeItem(at: output)
        let asset = AVURLAsset(url: video)
        let tracks = try await asset.loadTracks(withMediaType: .audio)
        guard !tracks.isEmpty else { return false }
        let reader = try AVAssetReader(asset: asset)
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16_000, AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsNonInterleaved: false, AVLinearPCMIsBigEndianKey: false,
        ]
        let out = AVAssetReaderAudioMixOutput(audioTracks: tracks, audioSettings: settings)
        reader.add(out)
        guard reader.startReading() else { throw reader.error ?? err("Could not read audio") }
        let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!
        let file = try AVAudioFile(forWriting: output, settings: format.settings, commonFormat: .pcmFormatInt16, interleaved: true)
        while let sample = out.copyNextSampleBuffer() {
            let frames = AVAudioFrameCount(CMSampleBufferGetNumSamples(sample))
            guard frames > 0 else { continue }
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else {
                throw err("Not enough memory to read all recording audio for transcription")
            }
            buffer.frameLength = frames
            let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(sample, at: 0, frameCount: Int32(frames), into: buffer.mutableAudioBufferList)
            guard status == noErr else {
                throw NSError(domain: NSOSStatusErrorDomain, code: Int(status),
                              userInfo: [NSLocalizedDescriptionKey: "Could not read all recording audio for transcription"])
            }
            try file.write(from: buffer)
        }
        guard reader.status == .completed else {
            throw reader.error ?? err("Recording audio extraction did not complete")
        }
        return true
    }

    private static func err(_ m: String) -> NSError { NSError(domain: "Reel", code: 30, userInfo: [NSLocalizedDescriptionKey: m]) }
}
