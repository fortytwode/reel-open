import Combine
import EventKit
import Foundation
import ReelCore

/// Lists calendar names and scans only the calendars the user has saved.
@MainActor
final class CalendarDiscovery: ObservableObject {
    @Published private(set) var calendars: [CalendarSource] = []
    @Published private(set) var meetings: [CalendarMeeting] = []
    @Published private(set) var authorizationMessage = "Connect calendars to discover meetings."
    @Published private(set) var accessNeedsSettings = false
    private let store = EKEventStore()

    func connect() async {
        _ = try? await store.requestFullAccessToEvents()
    }

    func refresh() {
        guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else {
            calendars = []; meetings = []
            let status = EKEventStore.authorizationStatus(for: .event)
            accessNeedsSettings = status == .denied || status == .restricted || status == .writeOnly
            authorizationMessage = accessNeedsSettings
                ? "Calendar access is blocked. Allow Reel in System Settings → Privacy & Security → Calendars."
                : "Allow calendar access to see the calendars available on this Mac."
            return
        }
        accessNeedsSettings = false
        let available = store.calendars(for: .event)
        calendars = available.map {
            CalendarSource(id: $0.calendarIdentifier, title: $0.title, accountName: $0.source.title,
                           accountID: $0.source.sourceIdentifier)
        }
        let selection = CalendarSelection.load(from: OrganizationState.defaults)
        let ids = selection.identifiers(available: Set(available.map(\.calendarIdentifier)))
        let selected = available.filter { ids.contains($0.calendarIdentifier) }
        guard !selected.isEmpty else {
            meetings = []
            if selection == .saved([]) {
                authorizationMessage = "Apple Calendar is skipped."
            } else if available.isEmpty {
                authorizationMessage = "No calendars are available. Add an account in Apple Calendar, then refresh."
            } else if selection == .unconfirmed {
                authorizationMessage = "Choose which calendars Reel can read, then save your selection."
            } else {
                authorizationMessage = "None of your saved calendars are available."
            }
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
        authorizationMessage = "Showing the next seven days from your saved calendars."
    }

    private static func email(_ url: URL) -> String? {
        guard url.scheme?.lowercased() == "mailto",
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let address = components.path.trimmingCharacters(in: .whitespacesAndNewlines)
        return address.contains("@") ? address : nil
    }
}
