import AVFoundation
import ReelCore
import UniformTypeIdentifiers

/// AVAssetWriter in Apple-HLS fragmented-MP4 mode: H.264 (VideoToolbox, Loom's encoder
/// properties) + one AAC track, cut into ~4 s CMAF segments (`init.mp4`, `segNNNNN.m4s`) that are
/// written to `<folder>/segments/` the moment they close. Each segment is handed to the live
/// uploader, so the share link plays seconds after stopping (Loom streams 2 s TS segments the
/// same way), and the segments on disk make an interrupted recording recoverable. The local MP4
/// is assembled from the segments after stopping (`SegmentAssembler`).
final class SegmentedWriter: NSObject, AVAssetWriterDelegate, @unchecked Sendable {
    static let segmentInterval = 4.0

    let directory: URL
    let size: PixelSize
    private let writer: AVAssetWriter
    private let videoInput: AVAssetWriterInput
    let adaptor: AVAssetWriterInputPixelBufferAdaptor
    private let audioInput: AVAssetWriterInput?
    private let queue = DispatchQueue(label: "\(Log.subsystem).writer")
    private let logLock = NSLock()
    private var log = SegmentLog()
    private var writeError: Error?
    private var lastVideoPTS = -Double.infinity
    private(set) var videoFrames = 0
    private(set) var audioBuffers = 0
    private var failed = false
    private var audioFormat: CMAudioFormatDescription?
    /// Called on the writer's queue after each segment file is on disk (init has index 0).
    var onSegment: ((SegmentEntry?, SegmentLog) -> Void)?
    var onStorageError: ((Error) -> Void)?

    var hasAudio: Bool { audioInput != nil }
    var currentLog: SegmentLog { logLock.withLock { log } }

    init(directory: URL, size: PixelSize, fps: Int, audio: Bool) throws {
        self.directory = directory
        self.size = size
        try? FileManager.default.removeItem(at: directory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        writer = AVAssetWriter(contentType: UTType(AVFileType.mp4.rawValue)!)
        writer.outputFileTypeProfile = .mpeg4AppleHLS
        writer.preferredOutputSegmentInterval = CMTime(seconds: Self.segmentInterval, preferredTimescale: 1)
        writer.initialSegmentStartTime = .zero

        let compression: [String: Any] = [
            AVVideoAverageBitRateKey: VideoGeometry.bitrate(for: size, fps: fps),
            AVVideoExpectedSourceFrameRateKey: fps,
            AVVideoMaxKeyFrameIntervalDurationKey: 2,
            AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            AVVideoAllowFrameReorderingKey: false,
            AVVideoH264EntropyModeKey: AVVideoH264EntropyModeCABAC,
        ]
        videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: size.width,
            AVVideoHeightKey: size.height,
            AVVideoCompressionPropertiesKey: compression,
            AVVideoColorPropertiesKey: [
                AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
            ],
        ])
        videoInput.expectsMediaDataInRealTime = true
        adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: videoInput, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: size.width,
            kCVPixelBufferHeightKey as String: size.height,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any],
            kCVPixelBufferMetalCompatibilityKey as String: true,
        ])
        guard writer.canAdd(videoInput) else { throw NSError(domain: "Reel", code: 10, userInfo: [NSLocalizedDescriptionKey: "Can't add video track"]) }
        writer.add(videoInput)

        if audio {
            var layout = AudioChannelLayout()
            layout.mChannelLayoutTag = kAudioChannelLayoutTag_Stereo
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48_000,
                AVNumberOfChannelsKey: 2,
                AVEncoderBitRateKey: 128_000,
                AVChannelLayoutKey: Data(bytes: &layout, count: MemoryLayout<AudioChannelLayout>.size),
            ])
            input.expectsMediaDataInRealTime = true
            if writer.canAdd(input) { writer.add(input) }
            audioInput = input
            var asbd = AudioStreamBasicDescription(mSampleRate: 48_000, mFormatID: kAudioFormatLinearPCM,
                                                   mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
                                                   mBytesPerPacket: 8, mFramesPerPacket: 1, mBytesPerFrame: 8,
                                                   mChannelsPerFrame: 2, mBitsPerChannel: 32, mReserved: 0)
            CMAudioFormatDescriptionCreate(allocator: nil, asbd: &asbd, layoutSize: 0, layout: nil, magicCookieSize: 0,
                                           magicCookie: nil, extensions: nil, formatDescriptionOut: &audioFormat)
        } else {
            audioInput = nil
        }
        super.init()
        writer.delegate = self
    }

    func start() throws {
        guard writer.startWriting() else { throw writer.error ?? NSError(domain: "Reel", code: 11, userInfo: [NSLocalizedDescriptionKey: "Writer failed to start"]) }
        writer.startSession(atSourceTime: .zero)
    }

    /// Called on the render queue with a pixel buffer from `adaptor.pixelBufferPool`.
    func appendVideo(_ pb: CVPixelBuffer, at seconds: Double) {
        queue.sync {
            guard !failed, writer.status == .writing, seconds > lastVideoPTS + 0.001 else { return }
            guard videoInput.isReadyForMoreMediaData else { return }   // drop rather than block real-time capture
            if adaptor.append(pb, withPresentationTime: CMTime(seconds: seconds, preferredTimescale: 600)) {
                lastVideoPTS = seconds
                videoFrames += 1
            } else { noteFailure() }
        }
    }

    /// Interleaved stereo Float32 at 48 kHz starting at output frame `startFrame`.
    func appendAudio(samples: [Float], startFrame: Int64) {
        guard let audioInput, let audioFormat, !samples.isEmpty else { return }
        let frames = samples.count / 2
        let bytes = samples.count * MemoryLayout<Float>.size
        var block: CMBlockBuffer?
        guard CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: bytes, blockAllocator: nil,
                                                 customBlockSource: nil, offsetToData: 0, dataLength: bytes,
                                                 flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block) == noErr, let block else { return }
        _ = samples.withUnsafeBytes { CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: bytes) }
        var sample: CMSampleBuffer?
        guard CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: nil, dataBuffer: block, formatDescription: audioFormat,
                                                                   sampleCount: frames, presentationTimeStamp: CMTime(value: startFrame, timescale: 48_000),
                                                                   packetDescriptions: nil, sampleBufferOut: &sample) == noErr, let sample else { return }
        queue.async { [self] in
            guard !failed, writer.status == .writing, audioInput.isReadyForMoreMediaData else { return }
            if audioInput.append(sample) { audioBuffers += 1 } else { noteFailure() }
        }
    }

    private func noteFailure() {
        failed = true
        Log.writer.error("Writer append failed: \(self.writer.error?.localizedDescription ?? "unknown", privacy: .public)")
    }

    // MARK: AVAssetWriterDelegate

    func assetWriter(_ writer: AVAssetWriter, didOutputSegmentData segmentData: Data, segmentType: AVAssetSegmentType, segmentReport: AVAssetSegmentReport?) {
        let result: Result<(SegmentEntry?, SegmentLog), Error>? = logLock.withLock {
            guard writeError == nil else { return nil }
            do {
                var entry: SegmentEntry?
                if segmentType == .initialization {
                    try write(segmentData, name: RemoteFile.initSegment.rawValue)
                    log.hasInit = true
                } else {
                    let index = log.nextIndex
                    try write(segmentData, name: RemoteFile.segment(index).rawValue)
                    let reports = segmentReport?.trackReports ?? []
                    let duration = reports.first(where: { $0.mediaType == .video })?.duration.seconds
                        ?? reports.map(\.duration.seconds).max() ?? Self.segmentInterval
                    let segment = SegmentEntry(index: index, duration: duration.isFinite ? duration : Self.segmentInterval, bytes: segmentData.count)
                    log.append(segment)
                    entry = segment
                }
                try persistLog()
                return .success((entry, log))
            } catch {
                writeError = error
                return .failure(error)
            }
        }
        switch result {
        case .success(let (entry, snapshot)):
            onSegment?(entry, snapshot)
        case .failure(let error):
            Log.writer.error("Segment write failed: \(error.localizedDescription, privacy: .public)")
            onStorageError?(error)
        case nil:
            break
        }
    }

    private func write(_ data: Data, name: String) throws {
        try data.write(to: directory.appendingPathComponent(name), options: .atomic)
    }

    /// Call with `logLock` held.
    private func persistLog() throws {
        try write(JSONEncoder().encode(log), name: SegmentLog.fileName)
    }

    /// Flushes the last segment and marks the log ended.
    func finish(endTime: Double) async throws -> SegmentLog {
        let w = writer, inputs = [videoInput, audioInput].compactMap { $0 }
        queue.sync {
            if w.status == .writing {
                w.endSession(atSourceTime: CMTime(seconds: max(endTime, 0.1), preferredTimescale: 600))
                inputs.forEach { $0.markAsFinished() }
            }
        }
        if w.status == .writing { await w.finishWriting() }
        guard w.status == .completed else {
            throw w.error ?? NSError(domain: "Reel", code: 12, userInfo: [NSLocalizedDescriptionKey: "Recording could not be finalized"])
        }
        let final: SegmentLog = try logLock.withLock {
            if let writeError { throw writeError }
            guard log.hasInit, !log.segments.isEmpty else {
                throw NSError(domain: "Reel", code: 12, userInfo: [NSLocalizedDescriptionKey: "No playable frames were saved"])
            }
            log.ended = true
            try persistLog()
            return log
        }
        Log.writer.info("Wrote \(self.videoFrames) frames, \(self.audioBuffers) audio buffers, \(final.segments.count) segments")
        return final
    }

    func cancel() {
        queue.sync { if writer.status == .writing { writer.cancelWriting() } }
    }
}

/// Converts captured audio sample buffers (any Float32/Int16 layout, 1–2 channels, 48 kHz) to
/// interleaved Float32 for `AudioMixBuffer`.
enum AudioSamples {
    static func interleavedFloats(_ sample: CMSampleBuffer) -> (samples: [Float], channels: Int)? {
        guard let fmt = CMSampleBufferGetFormatDescription(sample),
              let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(fmt) else { return nil }
        let asbd = asbdPtr.pointee
        let frames = CMSampleBufferGetNumSamples(sample)
        let channels = Int(asbd.mChannelsPerFrame)
        guard frames > 0, channels >= 1, abs(asbd.mSampleRate - 48_000) < 1 else { return nil }
        let isFloat = asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0
        let nonInterleaved = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
        let bits = Int(asbd.mBitsPerChannel)
        guard (isFloat && bits == 32) || (!isFloat && bits == 16) else { return nil }

        var blockBuffer: CMBlockBuffer?
        let bufferCount = nonInterleaved ? channels : 1
        let listSize = AudioBufferList.sizeInBytes(maximumBuffers: bufferCount)
        let raw = UnsafeMutableRawPointer.allocate(byteCount: listSize, alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        let list = raw.bindMemory(to: AudioBufferList.self, capacity: 1)
        guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample, bufferListSizeNeededOut: nil, bufferListOut: list,
                                                                      bufferListSize: listSize, blockBufferAllocator: nil,
                                                                      blockBufferMemoryAllocator: nil, flags: 0,
                                                                      blockBufferOut: &blockBuffer) == noErr else { return nil }
        let buffers = UnsafeMutableAudioBufferListPointer(list)
        let outChannels = min(channels, 2)
        var out = [Float](repeating: 0, count: frames * outChannels)
        func value(_ buffer: AudioBuffer, _ index: Int) -> Float {
            guard let data = buffer.mData else { return 0 }
            return isFloat ? data.assumingMemoryBound(to: Float.self)[index] : Float(data.assumingMemoryBound(to: Int16.self)[index]) / 32768
        }
        for f in 0..<frames {
            for c in 0..<outChannels {
                out[f * outChannels + c] = nonInterleaved ? value(buffers[c], f) : value(buffers[0], f * channels + c)
            }
        }
        return (out, outChannels)
    }
}
