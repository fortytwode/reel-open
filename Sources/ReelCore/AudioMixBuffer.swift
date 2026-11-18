import Foundation

/// Real-time mixer for the recording's single audio track. Mic (mono) and system audio
/// (stereo) arrive on their own clocks, already mapped onto the output timeline (pause-shifted
/// seconds). Each source writes additively at the frame its timestamp maps to, continuing
/// contiguously while it stays within `resyncThreshold` of its timestamps (so jitter doesn't
/// cause clicks) and jumping when it drifts further. `drain(upTo:)` hands out finished,
/// interleaved stereo audio; gaps are silence, so the track is continuous like the video.
/// Loom mixes mic and system audio into one stream as well (aggregate device).
public struct AudioMixBuffer: Sendable {
    public let sampleRate: Double
    public let channels = 2
    /// Frames already handed out; everything before this is final.
    public private(set) var drainedFrame: Int64 = 0
    /// Interleaved stereo samples for frames [drainedFrame, drainedFrame + pending.count/2).
    private var pending: [Float] = []
    private var nextFrame: [Int: Int64] = [:]
    public let resyncThreshold: Int64

    public init(sampleRate: Double = 48_000, resyncThreshold: Double = 0.02) {
        self.sampleRate = sampleRate
        self.resyncThreshold = Int64(resyncThreshold * sampleRate)
    }

    public func frame(for seconds: Double) -> Int64 { Int64((seconds * sampleRate).rounded()) }

    /// Adds `samples` (interleaved, `channels` = 1 or 2) from `source` captured at output time
    /// `seconds`. Returns the frame it was placed at (nil when it was entirely too late).
    @discardableResult
    public mutating func add(source: Int, seconds: Double, samples: [Float], channels: Int) -> Int64? {
        guard channels == 1 || channels == 2, !samples.isEmpty, seconds.isFinite else { return nil }
        let count = Int64(samples.count / channels)
        let expected = frame(for: seconds)
        var start = nextFrame[source] ?? expected
        if abs(start - expected) > resyncThreshold { start = expected }
        nextFrame[source] = start + count
        // Drop the part that falls before what has already been drained.
        let skip = max(0, drainedFrame - start)
        guard skip < count else { return nil }
        let needed = Int(start + count - drainedFrame) * 2
        if pending.count < needed { pending.append(contentsOf: repeatElement(0, count: needed - pending.count)) }
        for i in Int(skip)..<Int(count) {
            let dst = Int(start + Int64(i) - drainedFrame) * 2
            let l: Float, r: Float
            if channels == 1 { l = samples[i]; r = samples[i] } else { l = samples[2 * i]; r = samples[2 * i + 1] }
            pending[dst] += l
            pending[dst + 1] += r
        }
        return start
    }

    /// Returns interleaved stereo frames [drainedFrame, frame) (clipped to ±1) and advances.
    public mutating func drain(upTo frame: Int64) -> (start: Int64, samples: [Float])? {
        guard frame > drainedFrame else { return nil }
        let n = Int(frame - drainedFrame)
        if pending.count < n * 2 { pending.append(contentsOf: repeatElement(0, count: n * 2 - pending.count)) }
        var out = Array(pending[0..<(n * 2)])
        for i in out.indices { out[i] = min(1, max(-1, out[i])) }
        pending.removeFirst(n * 2)
        let start = drainedFrame
        drainedFrame = frame
        return (start, out)
    }

    public mutating func drain(upToSeconds seconds: Double) -> (start: Int64, samples: [Float])? {
        drain(upTo: frame(for: seconds))
    }
}
