import Foundation

/// Tracks bounded automatic attempts for calendar occurrences. Consent and app state
/// are deliberately checked by the caller, not inferred by this policy.
public struct MeetingJoinSchedule {
    private struct Entry {
        var attempts = 0
        var inFlight = false
        var terminal = false
        var completed = false
        var retryAfter: Date?
    }

    private var entries: [String: Entry] = [:]
    private let maximumAttempts = 3
    private let maximumLateness: TimeInterval = 5 * 60
    private let retryDelay: TimeInterval = 30

    public init() {}

    public func shouldAttempt(key: String, start: Date, end: Date, now: Date) -> Bool {
        guard !key.isEmpty, start < end,
              now >= start,
              now <= start.addingTimeInterval(maximumLateness),
              now < end else { return false }
        guard let entry = entries[key] else { return true }
        return !entry.inFlight && !entry.terminal && !entry.completed &&
            entry.attempts < maximumAttempts && (entry.retryAfter.map { now >= $0 } ?? true)
    }

    public mutating func begin(key: String, now: Date) {
        var entry = entries[key, default: Entry()]
        guard !entry.inFlight, !entry.terminal, !entry.completed,
              entry.attempts < maximumAttempts,
              entry.retryAfter.map({ now >= $0 }) ?? true else { return }
        entry.attempts += 1
        entry.inFlight = true
        entry.retryAfter = nil
        entries[key] = entry
    }

    public mutating func finish(key: String, now: Date, retryable: Bool) {
        guard var entry = entries[key], entry.inFlight else { return }
        entry.inFlight = false
        if !retryable || entry.attempts >= maximumAttempts {
            entry.terminal = true
        } else {
            entry.retryAfter = now.addingTimeInterval(retryDelay)
        }
        entries[key] = entry
    }

    /// A competing reservation may expire without either Mac trying to join.
    public mutating func deferForRecorder(key: String, now: Date) {
        guard var entry = entries[key], entry.inFlight else { return }
        entry.inFlight = false
        entry.attempts -= 1
        entry.retryAfter = now.addingTimeInterval(retryDelay)
        entries[key] = entry
    }

    /// True once no further automatic attempt will be made for this occurrence.
    public func isTerminal(key: String) -> Bool { entries[key]?.terminal ?? false }

    public mutating func complete(key: String) {
        var entry = entries[key, default: Entry()]
        entry.completed = true
        entry.inFlight = false
        entries[key] = entry
    }

    public mutating func reset() {
        entries.removeAll()
    }
}
