import Foundation

public struct CalendarSource: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var title: String
    public var accountName: String
    public var accountID: String?
    public init(id: String, title: String, accountName: String, accountID: String? = nil) {
        self.id = id; self.title = title; self.accountName = accountName; self.accountID = accountID
    }
}

public enum CalendarSelection: Equatable, Sendable {
    case unconfirmed
    case saved(Set<String>)

    public static func load(from defaults: UserDefaults) -> Self {
        let selected = Set(defaults.stringArray(forKey: "meetingCalendar.selectedIDs") ?? [])
        let useAll = defaults.object(forKey: "meetingCalendar.useAll") as? Bool
        // Previous releases retained custom IDs when users switched to all calendars.
        // Only an active custom selection carries forward, including an explicitly empty one.
        if useAll == true || (useAll == nil && selected.isEmpty) { return .unconfirmed }
        return .saved(selected)
    }

    public static func save(_ selected: Set<String>, to defaults: UserDefaults) {
        defaults.set(selected.sorted(), forKey: "meetingCalendar.selectedIDs")
        defaults.set(false, forKey: "meetingCalendar.useAll")
    }

    public var savedIDs: Set<String>? {
        if case let .saved(ids) = self { return ids }
        return nil
    }

    public func identifiers(available: Set<String>) -> Set<String> {
        available.intersection(savedIDs ?? [])
    }
}

public enum MeetingPlatform: String, Codable, Sendable, CaseIterable {
    case googleMeet = "google_meet"
    case zoom
    case teams
}

/// Interpret only explicit call controls and known media states.
public enum MeetingCallControls {
    private static func matches(_ value: String, _ prefixes: [String]) -> Bool {
        prefixes.contains { value == $0 || value.hasPrefix($0 + " (") || value.hasPrefix($0 + ",") }
    }
    public static func active(platform: MeetingPlatform, labels: [String]) -> Bool {
        let leave = labels.contains { matches($0, ["leave call", "leave meeting", "leave"]) } ||
            (platform == .zoom && labels.contains("end"))
        let share = labels.contains { matches($0, ["present now", "share screen", "share content", "stop presenting", "stop sharing"]) } ||
            (platform == .zoom && labels.contains("share"))
        return leave && share
    }
    public static func mediaOff(labels: [String], continuedWithoutMedia: Bool) -> Bool {
        let micOn = labels.contains { matches($0, ["turn off microphone", "mute microphone", "mute my microphone"]) }
        let cameraOn = labels.contains { matches($0, ["turn off camera", "stop video"]) }
        let micOff = labels.contains { matches($0, ["turn on microphone", "unmute microphone", "unmute my microphone", "unmute"]) }
        let cameraOff = labels.contains { matches($0, ["turn on camera", "start video"]) }
        return !micOn && !cameraOn && (continuedWithoutMedia || (micOff && cameraOff))
    }
}

/// Stop after sustained confirmed departure or a longer period of unreadable state.
public struct MeetingCallWatchdog {
    private var absentSince: Date?
    private var endedSince: Date?
    public init() {}
    public mutating func shouldStop(active: Bool?, now: Date) -> Bool {
        if active == true { absentSince = nil; endedSince = nil; return false }
        if absentSince == nil { absentSince = now }
        if active == false {
            if endedSince == nil { endedSince = now }
        } else { endedSince = nil }
        return now.timeIntervalSince(absentSince!) >= 30 ||
            (endedSince.map { now.timeIntervalSince($0) >= 8 } ?? false)
    }
}

public struct CalendarMeeting: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var calendarID: String
    public var title: String
    public var start: Date
    public var end: Date
    public var joinURL: URL
    public var platform: MeetingPlatform
    public var attendeeEmails: [String]
    public var organizer: String?
    public var cancelled: Bool
    public var isPrivate: Bool
    public var ownerDeclined: Bool
    public var deliveryCalendar: MeetingCalendarReference?

    /// Shared calendar copies and routing metadata identify an occurrence without its title or query.
    public var occurrenceIdentity: String {
        (joinURL.host?.lowercased() ?? "") + joinURL.path + ":" + String(start.timeIntervalSince1970)
    }

    public init(externalID: String, calendarID: String, title: String, start: Date, end: Date,
                joinURL: URL, platform: MeetingPlatform, attendeeEmails: [String] = [],
                organizer: String? = nil, cancelled: Bool = false, isPrivate: Bool = false,
                ownerDeclined: Bool = false, deliveryCalendar: MeetingCalendarReference? = nil) {
        // Length prefixes avoid delimiter collisions; exact start distinguishes recurrence instances.
        self.id = "\(calendarID.utf8.count):\(calendarID)\(externalID.utf8.count):\(externalID):\(start.timeIntervalSince1970)"
        self.calendarID = calendarID; self.title = title; self.start = start; self.end = end
        self.joinURL = joinURL; self.platform = platform; self.attendeeEmails = attendeeEmails
        self.organizer = organizer; self.cancelled = cancelled; self.isPrivate = isPrivate
        self.ownerDeclined = ownerDeclined
        self.deliveryCalendar = deliveryCalendar
    }
}

public struct MeetingLink: Equatable, Sendable {
    public var url: URL
    public var platform: MeetingPlatform
}

public enum MeetingLinkParser {
    /// Accept only direct provider URLs. No redirects, credentials, custom ports or fragments.
    public static func parse(_ value: String) -> MeetingLink? {
        guard var components = URLComponents(string: value), components.scheme?.lowercased() == "https",
              components.user == nil, components.password == nil,
              components.port == nil || components.port == 443,
              let host = components.host?.lowercased(), !host.hasSuffix("."),
              components.fragment == nil else { return nil }
        let path = components.percentEncodedPath
        let platform: MeetingPlatform
        if host == "meet.google.com", matches(path, "^/(meet/)?[a-z]{3}-[a-z]{4}-[a-z]{3}/?$") {
            platform = .googleMeet
        } else if (host == "zoom.us" || host.hasSuffix(".zoom.us")),
                  matches(path, "^/j/[0-9]{9,11}/?$") || matches(path, "^/wc/[0-9]{9,11}/join/?$") {
            platform = .zoom
        } else if host == "teams.microsoft.com",
                  matches(path, "^/l/meetup-join/[^/]+/[0-9]+/?$") || matches(path, "^/meet/[0-9]+/?$") {
            platform = .teams
        } else if host == "teams.live.com", matches(path, "^/meet/[0-9]+/?$") {
            platform = .teams
        } else { return nil }
        components.scheme = "https"; components.host = host; components.port = nil
        guard let url = components.url else { return nil }
        return MeetingLink(url: url, platform: platform)
    }

    /// The observed same-meeting Zoom iframe that can be opened as a standalone page.
    public static func isObservedZoomStandaloneFrame(_ value: String, expected: MeetingLink) -> Bool {
        guard let valid = parse(expected.url.absoluteString), valid == expected, expected.platform == .zoom,
              let source = URLComponents(url: expected.url, resolvingAgainstBaseURL: false), zoomSourceQueryAllowed(source),
              let actual = URLComponents(string: value), actual.scheme?.lowercased() == "https",
              actual.host?.lowercased() == "app.zoom.us", actual.user == nil, actual.password == nil,
              actual.port == nil || actual.port == 443, actual.fragment == nil else { return false }
        let parts = source.percentEncodedPath.split(separator: "/")
        guard parts.count == 2, parts[0] == "j", actual.percentEncodedPath == "/wc/\(parts[1])/start",
              let query = actual.queryItems,
              (query.count == 2 && Set(query.map(\.name)) == Set(["from", "ref_from"]) ||
               query.count == 3 && Set(query.map(\.name)) == Set(["from", "jcs", "ref_from"])),
              query.first(where: { $0.name == "from" })?.value == "pwa",
              query.first(where: { $0.name == "ref_from" })?.value == "launch",
              query.count == 2 || query.first(where: { $0.name == "jcs" })?.value == "web_launch-zwa-pcBrw" else { return false }
        return true
    }

    /// A provider page must be the sole top-level page and match the authorized URL.
    public static func matchesObservedPage(_ pages: [String], expected: MeetingLink) -> Bool {
        guard pages.count == 1 else { return false }
        if isObservedZoomStandaloneFrame(pages[0], expected: expected) { return true }
        guard let validExpected = parse(expected.url.absoluteString), validExpected == expected,
              let wanted = URLComponents(url: expected.url, resolvingAgainstBaseURL: false),
              let actual = URLComponents(string: pages[0]), actual.scheme?.lowercased() == "https",
              actual.user == nil, actual.password == nil, actual.port == nil || actual.port == 443 else { return false }
        if let observed = parse(pages[0]), observed.platform == expected.platform,
           wanted.host == actual.host?.lowercased(),
           wanted.percentEncodedPath.trimmingCharacters(in: CharacterSet(charactersIn: "/")) == actual.percentEncodedPath.trimmingCharacters(in: CharacterSet(charactersIn: "/")),
           wanted.percentEncodedQuery == actual.percentEncodedQuery { return true }

        // Only observed browser redirects from /j links with no query or one passcode.
        let parts = wanted.percentEncodedPath.split(separator: "/")
        guard expected.platform == .zoom, zoomSourceQueryAllowed(wanted),
              parts.count == 2, parts[0] == "j" else { return false }
        if wanted.host == actual.host?.lowercased(), actual.percentEncodedPath == "/s/\(parts[1])" {
            let samePasscodeQuery = actual.percentEncodedQuery == wanted.percentEncodedQuery
            return (actual.percentEncodedQuery == nil || samePasscodeQuery) &&
                (actual.percentEncodedFragment == nil || actual.percentEncodedFragment == "success")
        }
        guard actual.fragment == nil, actual.host?.lowercased() == "app.zoom.us", let query = actual.queryItems else { return false }
        if actual.percentEncodedPath == "/wc/\(parts[1])/start" {
            guard query.count == 4, Set(query.map(\.name)) == Set(["ref_from", "ts", "fromPWA", "pwd"]),
                  query.first(where: { $0.name == "ref_from" })?.value == "launch",
                  query.first(where: { $0.name == "fromPWA" })?.value == "1",
                  let timestamp = query.first(where: { $0.name == "ts" })?.value,
                  !timestamp.isEmpty, timestamp.allSatisfy({ $0.isASCII && $0.isNumber }),
                  query.first(where: { $0.name == "pwd" })?.value?.isEmpty == false else { return false }
            return true
        }
        if actual.percentEncodedPath == "/wc/\(parts[1])/join" {
            guard query.first(where: { $0.name == "ref_from" })?.value == "launch",
                  let timestamp = query.first(where: { $0.name == "ts" })?.value,
                  !timestamp.isEmpty, timestamp.allSatisfy({ $0.isASCII && $0.isNumber }) else { return false }
            let names = Set(query.map(\.name))
            if query.count == 3, names == Set(["from", "ref_from", "ts"]) {
                return query.first(where: { $0.name == "from" })?.value == "pwa"
            }
            if (query.count == 3 && names == Set(["ref_from", "ts", "fromPWA"])) ||
               (query.count == 4 && names == Set(["ref_from", "ts", "fromPWA", "pwd"])) {
                guard query.first(where: { $0.name == "fromPWA" })?.value == "1" else { return false }
                return query.count == 3 || query.first(where: { $0.name == "pwd" })?.value?.isEmpty == false
            }
            return false
        }
        return false
    }

    /// Returns nil for ambiguous events rather than choosing a meeting arbitrarily.
    public static func uniqueLink(in texts: [String]) -> MeetingLink? {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return nil }
        var links: [URL: MeetingLink] = [:]
        for text in texts {
            for match in detector.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
                guard let url = match.url, let link = parse(url.absoluteString) else { continue }
                links[link.url] = link
            }
        }
        return links.count == 1 ? links.values.first : nil
    }

    private static func zoomSourceQueryAllowed(_ source: URLComponents) -> Bool {
        if source.percentEncodedQuery == nil { return true }
        guard let items = source.queryItems, items.count == 1, items[0].name == "pwd",
              items[0].value?.isEmpty == false else { return false }
        return true
    }

    private static func matches(_ value: String, _ pattern: String) -> Bool {
        value.range(of: pattern, options: .regularExpression) != nil
    }
}

/// Transient calendar input. Notes/location are inspected for URLs and never stored in the result.
public struct CalendarEventCandidate: Sendable {
    public var externalID: String
    public var calendarID: String
    public var title: String
    public var start: Date
    public var end: Date
    public var linkTexts: [String]
    public var attendeeEmails: [String]
    public var organizer: String?
    public var allDay: Bool
    public var cancelled: Bool
    public var isPrivate: Bool
    public var ownerDeclined: Bool
    public var occurrenceStart: Date?

    public init(externalID: String, calendarID: String, title: String, start: Date, end: Date,
                linkTexts: [String], attendeeEmails: [String] = [], organizer: String? = nil,
                allDay: Bool = false, cancelled: Bool = false, isPrivate: Bool = false,
                ownerDeclined: Bool = false, occurrenceStart: Date? = nil) {
        self.externalID = externalID; self.calendarID = calendarID; self.title = title
        self.start = start; self.end = end; self.linkTexts = linkTexts
        self.attendeeEmails = attendeeEmails; self.organizer = organizer; self.allDay = allDay
        self.cancelled = cancelled; self.isPrivate = isPrivate; self.ownerDeclined = ownerDeclined
        self.occurrenceStart = occurrenceStart
    }

    public func meeting(now: Date, horizonEnd: Date) -> CalendarMeeting? {
        guard !externalID.isEmpty, !calendarID.isEmpty, !allDay, !cancelled, !isPrivate, !ownerDeclined,
              start < horizonEnd, end > now, end > start,
              !title.localizedCaseInsensitiveContains("[NO-REC]"),
              !title.localizedCaseInsensitiveContains("[PRIVATE]"),
              let link = MeetingLinkParser.uniqueLink(in: linkTexts) else { return nil }
        return CalendarMeeting(externalID: externalID, calendarID: calendarID, title: title,
                               start: start, end: end, joinURL: link.url, platform: link.platform,
                               attendeeEmails: Array(Set(attendeeEmails)).sorted(), organizer: organizer,
                               deliveryCalendar: MeetingCalendarReference(icalUID: externalID,
                                   occurrenceStart: ISO8601DateFormatter().string(from: occurrenceStart ?? start)))
    }
}

/// Display information from the signed-in account's cloud calendar feed.
public struct CloudCalendarMeeting: Identifiable {
    public let id: String
    public let title: String
    public let start: Date
    public let end: Date
    public let platform: MeetingPlatform
    public let status: String
    public let attendeeEmails: [String]
}

/// A fresh owner-scoped desktop feed. Only occurrence and active link identities retain cloud ownership.
public struct DesktopCalendarRouting {
    private var cloudOccurrences: Set<String> = []
    private var activeCloudLinks: Set<String> = []
    public private(set) var cloudMeetings: [CloudCalendarMeeting] = []
    public let desktopClaimsCapability: Bool?
    public var requiresDesktopClaims: Bool { desktopClaimsCapability == true }

    public init?(payload: [String: Any], now: Date) {
        guard let events = payload["events"] as? [[String: Any]] else { return nil }
        if let advertised = payload["desktop_claims"] {
            guard let required = advertised as? Bool else { return nil }
            desktopClaimsCapability = required
        } else { desktopClaimsCapability = nil }
        let legacy = payload["cloud_events"] == nil && payload["cloud_providers"] == nil
        if legacy {
            guard !requiresDesktopClaims,
                  events.allSatisfy({ $0["capture_provider"] == nil || $0["capture_provider"] as? String == "desktop" }) else { return nil }
            return
        }
        guard let cloud = payload["cloud_events"] as? [[String: Any]],
              let providers = payload["cloud_providers"] as? [String],
              providers.allSatisfy({ MeetingPlatform(rawValue: $0) != nil }),
              events.allSatisfy({ $0["capture_provider"] as? String == "desktop" }) else { return nil }
        for event in cloud {
            guard event["capture_provider"] as? String == "cloud",
                  let id = event["id"] as? String, !id.isEmpty,
                  let start = Self.date(event["start"]), let end = Self.date(event["end"]), end > start,
                  let raw = event["join_url"] as? String,
                  let link = MeetingLinkParser.parse(raw) else { return nil }
            guard end > now else { continue }
            let occurrence = CalendarMeeting(externalID: id, calendarID: "reel-cloud", title: "",
                start: start, end: end, joinURL: link.url, platform: link.platform)
            cloudOccurrences.insert(occurrence.occurrenceIdentity)
            if start <= now { activeCloudLinks.insert(Self.linkIdentity(link.url)) }
            if let title = event["title"] as? String, !title.isEmpty,
               let status = event["status"] as? String {
                cloudMeetings.append(CloudCalendarMeeting(id: id, title: title, start: start, end: end,
                    platform: link.platform, status: status, attendeeEmails: event["attendees"] as? [String] ?? []))
            }
        }
    }

    /// Unknown routing holds Meet and Teams; Zoom keeps its desktop behavior.
    public static func allowsLocal(_ meeting: CalendarMeeting, routing: DesktopCalendarRouting?) -> Bool {
        guard let routing else { return meeting.platform == .zoom }
        // Manual links have a manufactured start, so match only currently active ownership.
        if meeting.calendarID == "manual" {
            return !routing.activeCloudLinks.contains(Self.linkIdentity(meeting.joinURL))
        }
        return !routing.cloudOccurrences.contains(meeting.occurrenceIdentity)
    }

    private static func linkIdentity(_ url: URL) -> String {
        (url.host?.lowercased() ?? "") + url.path
    }

    private static func date(_ value: Any?) -> Date? {
        guard let text = value as? String else { return nil }
        let formatter = ISO8601DateFormatter()
        if let date = formatter.date(from: text) { return date }
        formatter.formatOptions.insert(.withFractionalSeconds)
        return formatter.date(from: text)
    }
}
