import XCTest
@testable import ReelCore

final class PauseClockTests: XCTestCase {
    func testBeforeStartIsNil() {
        var c = PauseClock()
        XCTAssertNil(c.outputTime(for: 5))
        c.begin(at: 10)
        XCTAssertNil(c.outputTime(for: 9.9))
        XCTAssertEqual(PauseClock().elapsed(now: 100), 0)
    }

    func testSimpleMapping() {
        var c = PauseClock(); c.begin(at: 10)
        XCTAssertEqual(c.outputTime(for: 10), 0)
        XCTAssertEqual(c.outputTime(for: 12.5), 2.5)
        XCTAssertTrue(c.isRunning)
    }

    func testPauseDropsAndShifts() {
        var c = PauseClock(); c.begin(at: 0)
        c.pause(at: 5)
        XCTAssertTrue(c.isPaused)
        XCTAssertNil(c.outputTime(for: 5))
        XCTAssertNil(c.outputTime(for: 7))
        c.resume(at: 8)
        XCTAssertFalse(c.isPaused)
        XCTAssertEqual(c.outputTime(for: 9), 6)
    }

    func testMultiplePausesAccumulate() {
        var c = PauseClock(); c.begin(at: 0)
        c.pause(at: 2); c.resume(at: 4)
        c.pause(at: 6); c.resume(at: 9)
        XCTAssertEqual(c.pausedTotal, 5)
        XCTAssertEqual(c.outputTime(for: 10), 5)
    }

    func testStopWhilePausedEndsAtPauseTime() {
        var c = PauseClock(); c.begin(at: 0)
        c.pause(at: 5)
        c.stop(at: 20)
        XCTAssertFalse(c.isRunning)
        XCTAssertEqual(c.elapsed(now: 100), 5)
        XCTAssertNil(c.outputTime(for: 6))
        XCTAssertNil(c.outputTime(for: 20))
        XCTAssertEqual(c.outputTime(for: 4), 4)
    }

    func testStopWhileRunning() {
        var c = PauseClock(); c.begin(at: 0)
        c.stop(at: 10)
        XCTAssertEqual(c.elapsed(now: 99), 10)
        XCTAssertEqual(c.outputTime(for: 10), 10)
        XCTAssertNil(c.outputTime(for: 10.1))
    }

    func testElapsedWhilePausedDoesNotGrow() {
        var c = PauseClock(); c.begin(at: 0)
        c.pause(at: 5)
        XCTAssertEqual(c.elapsed(now: 5), 5)
        XCTAssertEqual(c.elapsed(now: 50), 5)
        c.resume(at: 50)
        XCTAssertEqual(c.elapsed(now: 52), 7)
    }

    func testPauseResumeIgnoredWhenNotApplicable() {
        var c = PauseClock()
        c.pause(at: 1); c.resume(at: 2)
        XCTAssertFalse(c.isPaused)
        c.begin(at: 0)
        c.resume(at: 3)
        XCTAssertEqual(c.pausedTotal, 0)
        c.pause(at: 4); c.pause(at: 6)
        XCTAssertEqual(c.pausedAt, 4)
    }

    func testBeginResetsState() {
        var c = PauseClock(); c.begin(at: 0); c.pause(at: 1); c.stop(at: 2)
        c.begin(at: 100)
        XCTAssertTrue(c.isRunning)
        XCTAssertFalse(c.isPaused)
        XCTAssertEqual(c.outputTime(for: 101), 1)
    }
}
