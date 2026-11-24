import XCTest
@testable import ReelCore

final class MeetingJoinScheduleTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_800_000_000)

    func testDoesNotAttemptBeforeStartAndAcceptsExactStart() {
        let schedule = MeetingJoinSchedule()
        XCTAssertFalse(schedule.shouldAttempt(key: "one", start: start, end: start.addingTimeInterval(600), now: start.addingTimeInterval(-0.001)))
        XCTAssertTrue(schedule.shouldAttempt(key: "one", start: start, end: start.addingTimeInterval(600), now: start))
    }

    func testFiveMinuteLatenessBoundaryAndExpiredEvents() {
        let schedule = MeetingJoinSchedule()
        let end = start.addingTimeInterval(900)
        XCTAssertTrue(schedule.shouldAttempt(key: "edge", start: start, end: end, now: start.addingTimeInterval(300)))
        XCTAssertFalse(schedule.shouldAttempt(key: "late", start: start, end: end, now: start.addingTimeInterval(300.001)))
        XCTAssertFalse(schedule.shouldAttempt(key: "ended", start: start, end: end, now: end))
    }

    func testThreeTotalAttemptsAndThirtySecondRetryDelay() {
        var schedule = MeetingJoinSchedule()
        let end = start.addingTimeInterval(3600)
        XCTAssertTrue(schedule.shouldAttempt(key: "retry", start: start, end: end, now: start))
        schedule.begin(key: "retry", now: start)
        schedule.finish(key: "retry", now: start, retryable: true)
        XCTAssertFalse(schedule.shouldAttempt(key: "retry", start: start, end: end, now: start.addingTimeInterval(29.999)))
        XCTAssertTrue(schedule.shouldAttempt(key: "retry", start: start, end: end, now: start.addingTimeInterval(30)))
        schedule.begin(key: "retry", now: start.addingTimeInterval(30))
        schedule.finish(key: "retry", now: start.addingTimeInterval(30), retryable: true)
        XCTAssertTrue(schedule.shouldAttempt(key: "retry", start: start, end: end, now: start.addingTimeInterval(60)))
        schedule.begin(key: "retry", now: start.addingTimeInterval(60))
        schedule.finish(key: "retry", now: start.addingTimeInterval(60), retryable: true)
        XCTAssertFalse(schedule.shouldAttempt(key: "retry", start: start, end: end, now: start.addingTimeInterval(90)))
    }

    func testInFlightCannotDuplicateAndNonretryableFailureIsTerminal() {
        var schedule = MeetingJoinSchedule()
        let end = start.addingTimeInterval(600)
        schedule.begin(key: "flight", now: start)
        XCTAssertFalse(schedule.shouldAttempt(key: "flight", start: start, end: end, now: start))
        schedule.finish(key: "flight", now: start, retryable: false)
        XCTAssertFalse(schedule.shouldAttempt(key: "flight", start: start, end: end, now: start.addingTimeInterval(300)))
    }

    func testCompletedMeetingIsExcludedAndResetClearsAllState() {
        var schedule = MeetingJoinSchedule()
        let end = start.addingTimeInterval(600)
        schedule.begin(key: "done", now: start)
        schedule.complete(key: "done")
        XCTAssertFalse(schedule.shouldAttempt(key: "done", start: start, end: end, now: start))
        schedule.reset()
        XCTAssertTrue(schedule.shouldAttempt(key: "done", start: start, end: end, now: start))
    }

    func testFailureCanBeRetriedInsteadOfPermanentlyBlockedByAttemptedSet() {
        var schedule = MeetingJoinSchedule()
        let end = start.addingTimeInterval(600)
        schedule.begin(key: "recover", now: start)
        schedule.finish(key: "recover", now: start, retryable: true)
        XCTAssertTrue(schedule.shouldAttempt(key: "recover", start: start, end: end, now: start.addingTimeInterval(30)))
    }

    func testRecorderContentionBacksOffOnlyThatMeetingWithoutUsingAnAttempt() {
        var schedule = MeetingJoinSchedule()
        let end = start.addingTimeInterval(600)
        var now = start
        for _ in 0..<4 {
            XCTAssertTrue(schedule.shouldAttempt(key: "waiting", start: start, end: end, now: now))
            schedule.begin(key: "waiting", now: now)
            schedule.deferForRecorder(key: "waiting", now: now)
            XCTAssertFalse(schedule.shouldAttempt(key: "waiting", start: start, end: end, now: now))
            XCTAssertTrue(schedule.shouldAttempt(key: "different", start: start, end: end, now: now))
            now = now.addingTimeInterval(30)
        }
        XCTAssertTrue(schedule.shouldAttempt(key: "waiting", start: start, end: end, now: now))
        XCTAssertFalse(schedule.shouldAttempt(key: "waiting", start: start, end: end, now: start.addingTimeInterval(301)))
    }

    func testTerminalIsReportedOnlyWhenNoAttemptRemains() {
        var schedule = MeetingJoinSchedule()
        let start = Date(timeIntervalSince1970: 1_000)
        let end = start.addingTimeInterval(1_800)
        XCTAssertFalse(schedule.isTerminal(key: "a"))
        schedule.begin(key: "a", now: start)
        schedule.finish(key: "a", now: start, retryable: true)
        XCTAssertFalse(schedule.isTerminal(key: "a"))
        XCTAssertTrue(schedule.shouldAttempt(key: "a", start: start, end: end, now: start.addingTimeInterval(31)))
        schedule.begin(key: "a", now: start.addingTimeInterval(31))
        schedule.finish(key: "a", now: start.addingTimeInterval(32), retryable: false)
        XCTAssertTrue(schedule.isTerminal(key: "a"))
        XCTAssertFalse(schedule.shouldAttempt(key: "a", start: start, end: end, now: start.addingTimeInterval(90)))
    }
}
