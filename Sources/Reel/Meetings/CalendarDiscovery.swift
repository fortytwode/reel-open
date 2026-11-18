import Combine
import EventKit
import Foundation
import ReelCore

/// Discovers meeting links in desktop calendars; all calendars are the normal setup.
@MainActor
final class CalendarDiscovery: ObservableObject {
    @Published private(set) var calendars: [CalendarSource] = []
    @Published private(set) var meetings: [CalendarMeeting] = []
    @Published private(set) var authorizationMessage = "Connect calendars to discover meetings."
    @Published private(set) var accessNeedsSettings = false
    private let store = EKEventStore()

    func connect() async {
        do {
            let granted = try await store.requestFullAccessToEvents()
            authorizationMessage = granted ? "Desktop calendars connected." : "Calendar access was not granted. Enable it in System Settings > Privacy & Security > Calendars."
        } catch {
            // Provider errors can contain account details; present a fixed message.
            authorizationMessage = "Calendar access could not be requested. Check System Settings > Privacy & Security > Calendars."
        }
        await refresh(selectedCalendarIDs: [])
    }

    func refresh(selectedCalendarIDs: Set<String>, useAllCalendars: Bool = true) async {
        guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else {
            calendars = []; meetings = []
            let status = EKEventStore.authorizationStatus(for: .event)
            accessNeedsSettings = status == .denied || status == .restricted || status == .writeOnly
            authorizationMessage = accessNeedsSettings
                ? "Calendar access is blocked. Allow Reel in System Settings → Privacy & Security → Calendars."
                : "Connect calendars once to let Reel find your Google, Apple and other desktop calendar meetings."
            return
        }
        accessNeedsSettings = false
        let available = store.calendars(for: .event)
        calendars = available.map {
            CalendarSource(id: $0.calendarIdentifier, title: $0.title, accountName: $0.source.title)
        }.sorted { ($0.accountName, $0.title, $0.id) < ($1.accountName, $1.title, $1.id) }
        let ids = CalendarSelection.identifiers(available: Set(available.map(\.calendarIdentifier)),
                                                selected: selectedCalendarIDs, useAll: useAllCalendars)
        let selected = available.filter { ids.contains($0.calendarIdentifier) }
        guard !selected.isEmpty else {
            meetings = []; authorizationMessage = useAllCalendars ? "No desktop calendars are available. Add your account in Apple Calendar, then refresh." : "Choose calendars to discover meetings."
            return
        }
        let now = Date()
        let horizon = now.addingTimeInterval(7 * 24 * 60 * 60)
        let predicate = store.predicateForEvents(withStart: now, end: horizon, calendars: selected)
        meetings = store.events(matching: predicate).compactMap { event in
            guard let start = event.startDate, let end = event.endDate,
                  let calendarID = event.calendar?.calendarIdentifier else { return nil }
            let candidate = CalendarEventCandidate(
                externalID: event.calendarItemExternalIdentifier ?? event.calendarItemIdentifier,
                calendarID: calendarID, title: event.title ?? "Meeting", start: start, end: end,
                linkTexts: [event.url?.absoluteString, event.location, event.notes].compactMap { $0 },
                attendeeEmails: (event.attendees ?? []).compactMap { Self.email($0.url) },
                organizer: event.organizer.flatMap { Self.email($0.url) },
                allDay: event.isAllDay, cancelled: event.status == .canceled,
                ownerDeclined: (event.attendees ?? []).contains { $0.isCurrentUser && $0.participantStatus == .declined },
                occurrenceStart: event.occurrenceDate)
            return candidate.meeting(now: now, horizonEnd: horizon)
        }.sorted { ($0.start, $0.id) < ($1.start, $1.id) }
        authorizationMessage = useAllCalendars ? "Using all calendars on this Mac for the next seven days." : "Using your selected calendars for the next seven days."
    }

    private static func email(_ url: URL) -> String? {
        guard url.scheme?.lowercased() == "mailto",
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let address = components.path.trimmingCharacters(in: .whitespacesAndNewlines)
        return address.contains("@") ? address : nil
    }
}
