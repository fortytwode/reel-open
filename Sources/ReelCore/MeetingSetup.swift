import Foundation

/// Presentation history is separate from permission readiness and recording consent.
public enum MeetingSetupIntroduction {
    public static let currentVersion = 1
    public static let defaultsKey = "meetingSetup.lastPresentedVersion"

    public static func shouldPresent(lastPresentedVersion: Int) -> Bool {
        lastPresentedVersion < currentVersion
    }
}

/// A snapshot of prerequisites; evaluating it never requests access or enables recording.
public struct MeetingSetupReadiness: Equatable, Sendable {
    public enum Blocker: Equatable, Sendable {
        case calendarPermission, calendarSelection, screenRecording, accessibility, chrome
    }

    public let calendarAccessAllowed: Bool
    public let selectedCalendarCount: Int
    public let screenCaptureVerified: Bool
    public let accessibilityAllowed: Bool
    public let chromeAvailable: Bool

    public init(calendarAccessAllowed: Bool, selectedCalendarCount: Int, screenCaptureVerified: Bool,
                accessibilityAllowed: Bool, chromeAvailable: Bool) {
        self.calendarAccessAllowed = calendarAccessAllowed
        self.selectedCalendarCount = selectedCalendarCount
        self.screenCaptureVerified = screenCaptureVerified
        self.accessibilityAllowed = accessibilityAllowed
        self.chromeAvailable = chromeAvailable
    }

    public var blockers: [Blocker] {
        var result: [Blocker] = []
        if !calendarAccessAllowed { result.append(.calendarPermission) }
        if selectedCalendarCount <= 0 { result.append(.calendarSelection) }
        if !screenCaptureVerified { result.append(.screenRecording) }
        if !accessibilityAllowed { result.append(.accessibility) }
        if !chromeAvailable { result.append(.chrome) }
        return result
    }

    public var isReady: Bool { blockers.isEmpty }
}

public enum MeetingSetupJoining {
    /// An absent preference is a first setup. A prior pause survives completed setup.
    public static func enabledAfterCompletion(previousPreference: Bool?) -> Bool {
        previousPreference ?? true
    }

    /// A recorder launch can resume only an explicitly chosen desktop calendar scope and automation preference.
    public static func shouldMonitorInBackground(defaults: UserDefaults) -> Bool {
        CalendarSelection.load(from: defaults).savedIDs != nil &&
            (defaults.bool(forKey: "meetingCalendar.localReminders") ||
             (defaults.bool(forKey: "meetingCalendar.localAutoJoin") && defaults.bool(forKey: "meetingCalendar.standingConsent")))
    }
}
