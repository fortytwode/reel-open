import Foundation

/// Maps capture timestamps (host clock seconds) onto the output timeline, removing paused
/// intervals ("time shift on pause", as Loom's recorder does). Samples captured while paused
/// or before the start are dropped (nil).
public struct PauseClock: Equatable, Sendable {
    public private(set) var start: Double?
    public private(set) var pausedTotal: Double = 0
    public private(set) var pausedAt: Double?
    public private(set) var stoppedAt: Double?

    public init() {}

    public var isPaused: Bool { pausedAt != nil }
    public var isRunning: Bool { start != nil && stoppedAt == nil }

    public mutating func begin(at t: Double) {
        start = t
        pausedTotal = 0
        pausedAt = nil
        stoppedAt = nil
    }

    public mutating func pause(at t: Double) {
        guard isRunning, pausedAt == nil else { return }
        pausedAt = t
    }

    public mutating func resume(at t: Double) {
        guard isRunning, let p = pausedAt else { return }
        pausedTotal += max(0, t - p)
        pausedAt = nil
    }

    public mutating func stop(at t: Double) {
        guard isRunning else { return }
        // Stopping while paused ends the recording at the moment of the pause.
        if let p = pausedAt {
            stoppedAt = p
            pausedAt = nil
        } else {
            stoppedAt = t
        }
    }

    /// Output time for a sample captured at host time `t`, or nil if it must be dropped.
    public func outputTime(for t: Double) -> Double? {
        guard let start, t >= start else { return nil }
        if let stoppedAt, t > stoppedAt { return nil }
        if let pausedAt, t >= pausedAt { return nil }
        return t - start - pausedTotal
    }

    /// Recorded (non-paused) duration as of host time `now`.
    public func elapsed(now: Double) -> Double {
        guard let start else { return 0 }
        let end = stoppedAt ?? now
        let currentPause = pausedAt.map { max(0, end - $0) } ?? 0
        return max(0, end - start - pausedTotal - currentPause)
    }
}
