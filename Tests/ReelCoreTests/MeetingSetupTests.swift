import XCTest
@testable import ReelCore

final class MeetingSetupTests: XCTestCase {
    func testIntroductionOnlyPresentsForNewOrUpgradedVersion() {
        XCTAssertTrue(MeetingSetupIntroduction.shouldPresent(lastPresentedVersion: 0))
        XCTAssertFalse(MeetingSetupIntroduction.shouldPresent(lastPresentedVersion: 1))
        XCTAssertFalse(MeetingSetupIntroduction.shouldPresent(lastPresentedVersion: 2))
        XCTAssertEqual(MeetingSetupIntroduction.currentVersion, 1)
        XCTAssertFalse(MeetingSetupIntroduction.defaultsKey.isEmpty)
    }

    func testReadinessReportsOrderedBlockersWithoutChangingItsInputs() {
        let readiness = MeetingSetupReadiness(calendarAccessAllowed: false, selectedCalendarCount: 0,
            screenCaptureVerified: false, accessibilityAllowed: false, chromeAvailable: false)
        XCTAssertEqual(readiness.blockers, [.calendarPermission, .calendarSelection, .screenRecording, .accessibility, .chrome])
        XCTAssertFalse(readiness.isReady)
        XCTAssertFalse(readiness.screenCaptureVerified)
        XCTAssertFalse(readiness.calendarAccessAllowed)
    }

    func testReadyAndRevokedPermissionsAreRecomputed() {
        let ready = MeetingSetupReadiness(calendarAccessAllowed: true, selectedCalendarCount: 2,
            screenCaptureVerified: true, accessibilityAllowed: true, chromeAvailable: true)
        XCTAssertTrue(ready.isReady)
        XCTAssertEqual(ready.blockers, [])
        let revoked = MeetingSetupReadiness(calendarAccessAllowed: true, selectedCalendarCount: 2,
            screenCaptureVerified: false, accessibilityAllowed: false, chromeAvailable: true)
        XCTAssertEqual(revoked.blockers, [.screenRecording, .accessibility])
        XCTAssertFalse(revoked.isReady)
    }

    func testCompletionDefaultsOnAndRespectsPriorPreference() {
        XCTAssertTrue(MeetingSetupJoining.enabledAfterCompletion(previousPreference: nil))
        XCTAssertTrue(MeetingSetupJoining.enabledAfterCompletion(previousPreference: true))
        XCTAssertFalse(MeetingSetupJoining.enabledAfterCompletion(previousPreference: false))
    }

    func testCustomScopeWithNoAvailableSelectedCalendarsIsBlocked() {
        let readiness = MeetingSetupReadiness(calendarAccessAllowed: true, selectedCalendarCount: 0,
            screenCaptureVerified: true, accessibilityAllowed: true, chromeAvailable: true)
        XCTAssertEqual(readiness.blockers, [.calendarSelection])
    }
}
