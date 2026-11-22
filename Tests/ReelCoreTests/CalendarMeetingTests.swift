import XCTest
@testable import ReelCore

final class CalendarMeetingTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private let meet = "https://meet.google.com/abc-defg-hij"
    private func candidate() -> CalendarEventCandidate {
        CalendarEventCandidate(externalID: "series", calendarID: "calendar", title: "Client call",
                               start: now.addingTimeInterval(600), end: now.addingTimeInterval(2400),
                               linkTexts: [meet])
    }
    private func meeting(_ event: CalendarEventCandidate) -> CalendarMeeting? {
        event.meeting(now: now, horizonEnd: now.addingTimeInterval(7 * 86400))
    }

    private let teams = "https://teams.microsoft.com/meet/123456789?p=passcode"

    private func routingMeeting(_ url: String, start: Date? = nil, calendarID: String = "apple") -> CalendarMeeting {
        let link = MeetingLinkParser.parse(url)!
        return CalendarMeeting(externalID: "occurrence", calendarID: calendarID, title: "Calendar title",
            start: start ?? now.addingTimeInterval(600), end: now.addingTimeInterval(2400),
            joinURL: link.url, platform: link.platform)
    }

    private func routingEvent(_ meeting: CalendarMeeting, capture: String = "cloud") -> [String: Any] {
        ["id": "server-event", "title": "Different server title", "start": ISO8601DateFormatter().string(from: meeting.start),
         "end": ISO8601DateFormatter().string(from: meeting.end), "join_url": meeting.joinURL.absoluteString,
         "capture_provider": capture]
    }

    func testOngoingCloudRecordingIsVisibleAndStillExcludedFromLocalJoining() throws {
        let call = routingMeeting(meet, start: now.addingTimeInterval(-240))
        var event = routingEvent(call)
        event["status"] = "recording"
        event["attendees"] = ["invitee@example.net"]
        let routing = try XCTUnwrap(DesktopCalendarRouting(payload: ["events": [],
            "cloud_events": [event], "cloud_providers": ["google_meet"]], now: now))
        let row = try XCTUnwrap(routing.cloudMeetings.first)
        XCTAssertEqual(row.title, "Different server title")
        XCTAssertEqual(row.status, "recording")
        XCTAssertEqual(row.start, call.start)
        XCTAssertEqual(row.attendeeEmails, ["invitee@example.net"])
        XCTAssertFalse(DesktopCalendarRouting.allowsLocal(call, routing: routing))
    }

    func testCloudOccurrenceExcludesEveryMergedCalendarCopyButRetainsOtherLocalMeetings() throws {
        let cloud = routingMeeting(teams)
        let outlook = routingMeeting("https://teams.microsoft.com/meet/123456789/?p=passcode", calendarID: "outlook")
        let shared = routingMeeting(teams + "&other=query", calendarID: "shared")
        let next = routingMeeting(teams, start: now.addingTimeInterval(1200))
        let localTeams = routingMeeting("https://teams.live.com/meet/987654321", calendarID: "outlook")
        let meet = routingMeeting(meet)
        let zoom = routingMeeting("https://zoom.us/j/123456789")
        let routing = try XCTUnwrap(DesktopCalendarRouting(payload: ["events": [],
            "cloud_events": [routingEvent(cloud)], "cloud_providers": ["teams"]], now: now))
        let merged = [cloud, outlook, shared, next, localTeams, meet, zoom]
        XCTAssertEqual(merged.filter { DesktopCalendarRouting.allowsLocal($0, routing: routing) }, [next, localTeams, meet, zoom])
    }

    func testIndependentCloudFeedExcludesKnownMeetAndZoomButPreservesUnmatchedTeams() throws {
        let cloudMeet = routingMeeting(meet)
        let cloudZoom = routingMeeting("https://zoom.us/j/123456789")
        let routing = try XCTUnwrap(DesktopCalendarRouting(payload: ["events": [],
            "cloud_events": [routingEvent(cloudMeet), routingEvent(cloudZoom)], "cloud_providers": []], now: now))
        XCTAssertFalse(DesktopCalendarRouting.allowsLocal(cloudMeet, routing: routing))
        XCTAssertFalse(DesktopCalendarRouting.allowsLocal(cloudZoom, routing: routing))
        XCTAssertTrue(DesktopCalendarRouting.allowsLocal(routingMeeting(teams), routing: routing))
        XCTAssertTrue(DesktopCalendarRouting.allowsLocal(routingMeeting(meet, start: now.addingTimeInterval(1200)), routing: routing))
    }

    func testUnavailableRoutingHoldsMeetAndTeamsButAllowsZoom() {
        XCTAssertFalse(DesktopCalendarRouting.allowsLocal(routingMeeting(meet), routing: nil))
        XCTAssertFalse(DesktopCalendarRouting.allowsLocal(routingMeeting(teams), routing: nil))
        XCTAssertTrue(DesktopCalendarRouting.allowsLocal(routingMeeting("https://zoom.us/j/123456789"), routing: nil))
    }

    func testDesktopClaimsRequireAnExplicitCapabilityOnTheCurrentFeed() throws {
        let legacy = try XCTUnwrap(DesktopCalendarRouting(payload: ["events": []], now: now))
        XCTAssertFalse(legacy.requiresDesktopClaims)
        XCTAssertNil(legacy.desktopClaimsCapability)
        let current: [String: Any] = ["events": [], "cloud_events": [], "cloud_providers": []]
        XCTAssertTrue(try XCTUnwrap(DesktopCalendarRouting(payload: current.merging(["desktop_claims": true]) { _, new in new },
                                                         now: now)).requiresDesktopClaims)
        XCTAssertEqual(try XCTUnwrap(DesktopCalendarRouting(payload: current.merging(["desktop_claims": false]) { _, new in new },
                                                          now: now)).desktopClaimsCapability, false)
        XCTAssertNil(DesktopCalendarRouting(payload: ["events": [], "desktop_claims": true], now: now))
        XCTAssertNil(DesktopCalendarRouting(payload: current.merging(["desktop_claims": "true"]) { _, new in new }, now: now))
    }

    func testManualLinksUseActiveCloudWindowInsteadOfManufacturedStart() throws {
        for url in [teams, meet, "https://zoom.us/j/123456789"] {
            let cloud = routingMeeting(url, start: now.addingTimeInterval(-600))
            let routing = try XCTUnwrap(DesktopCalendarRouting(payload: ["events": [],
                "cloud_events": [routingEvent(cloud)], "cloud_providers": []], now: now))
            let manual = routingMeeting(url + (url.contains("?") ? "&" : "?") + "other=query", start: now, calendarID: "manual")
            XCTAssertFalse(DesktopCalendarRouting.allowsLocal(manual, routing: routing), url)
            XCTAssertTrue(DesktopCalendarRouting.allowsLocal(routingMeeting(url, start: now), routing: routing), url)
        }
    }

    func testManualCloudOwnershipRequiresSameLinkAndCurrentTimeInsideWindow() throws {
        let cloud = routingMeeting(teams, start: now.addingTimeInterval(-600))
        let payload: [String: Any] = ["events": [], "cloud_events": [routingEvent(cloud)], "cloud_providers": []]
        let manual = routingMeeting(teams, start: now, calendarID: "manual")
        let active = try XCTUnwrap(DesktopCalendarRouting(payload: payload, now: now))
        let slashedManual = routingMeeting("https://teams.microsoft.com/meet/123456789/?p=passcode", start: now, calendarID: "manual")
        XCTAssertFalse(DesktopCalendarRouting.allowsLocal(slashedManual, routing: active))
        XCTAssertTrue(DesktopCalendarRouting.allowsLocal(routingMeeting("https://teams.live.com/meet/987654321", start: now, calendarID: "manual"), routing: active))
        for checkTime in [cloud.start.addingTimeInterval(-1), cloud.end] {
            let inactive = try XCTUnwrap(DesktopCalendarRouting(payload: payload, now: checkTime))
            XCTAssertTrue(DesktopCalendarRouting.allowsLocal(manual, routing: inactive))
        }
        let atStart = try XCTUnwrap(DesktopCalendarRouting(payload: payload, now: cloud.start))
        XCTAssertFalse(DesktopCalendarRouting.allowsLocal(manual, routing: atStart))
    }

    func testLaunchedCloudOccurrenceRemainsOwnedAfterProviderPolicyIsRevoked() throws {
        let cloud = routingMeeting(teams)
        let routing = try XCTUnwrap(DesktopCalendarRouting(payload: ["events": [],
            "cloud_events": [routingEvent(cloud)], "cloud_providers": []], now: now))
        XCTAssertFalse(DesktopCalendarRouting.allowsLocal(cloud, routing: routing))
        XCTAssertTrue(DesktopCalendarRouting.allowsLocal(routingMeeting(teams, start: now.addingTimeInterval(1200)), routing: routing))
    }

    func testUnavailableOrMalformedRoutingCannotAuthorizeLocalTeamsFallback() {
        let event = routingMeeting(teams)
        let malformed: [[String: Any]] = [
            ["events": [] , "cloud_providers": ["teams"]],
            ["events": [], "cloud_events": [], "cloud_providers": "teams"],
            ["events": [], "cloud_events": [], "cloud_providers": ["unknown"]],
            ["events": [], "cloud_events": [routingEvent(event, capture: "desktop")], "cloud_providers": ["teams"]],
            ["events": [], "cloud_events": [["join_url": teams]], "cloud_providers": ["teams"]],
            ["events": [routingEvent(event)], "cloud_events": [], "cloud_providers": ["teams"]]
        ]
        for payload in malformed { XCTAssertNil(DesktopCalendarRouting(payload: payload, now: now)) }
        XCTAssertFalse(DesktopCalendarRouting.allowsLocal(event, routing: nil))
        XCTAssertFalse(DesktopCalendarRouting.allowsLocal(routingMeeting(meet), routing: nil))
        XCTAssertTrue(DesktopCalendarRouting.allowsLocal(routingMeeting("https://zoom.us/j/123456789"), routing: nil))
    }

    func testLegacyFeedAndFreshEmptyPolicyPreserveUnmatchedDesktopTeams() throws {
        for payload: [String: Any] in [["events": []], ["events": [], "cloud_events": [], "cloud_providers": []]] {
            let routing = try XCTUnwrap(DesktopCalendarRouting(payload: payload, now: now))
            XCTAssertTrue(DesktopCalendarRouting.allowsLocal(routingMeeting(teams), routing: routing))
        }
    }

    func testExpiredCloudOccurrenceDoesNotClaimLaterCalendarOccurrence() throws {
        var expired = routingMeeting(teams)
        expired.start = now.addingTimeInterval(-1200); expired.end = now.addingTimeInterval(-600)
        let routing = try XCTUnwrap(DesktopCalendarRouting(payload: ["events": [],
            "cloud_events": [routingEvent(expired)], "cloud_providers": ["teams"]], now: now))
        XCTAssertTrue(DesktopCalendarRouting.allowsLocal(routingMeeting(teams), routing: routing))
    }

    func testFreshAndFormerAllCalendarScopesRequireSelection() {
        withCalendarDefaults { defaults in
            let fresh = CalendarSelection.load(from: defaults)
            XCTAssertEqual(fresh, .unconfirmed)
            XCTAssertEqual(fresh.identifiers(available: ["apple", "google"]), [])

            defaults.set(true, forKey: "meetingCalendar.useAll")
            defaults.set(["google"], forKey: "meetingCalendar.selectedIDs")
            let formerlyAll = CalendarSelection.load(from: defaults)
            XCTAssertEqual(formerlyAll, .unconfirmed)
            XCTAssertEqual(formerlyAll.identifiers(available: ["apple", "google"]), [])
        }
    }

    func testExistingCustomCalendarScopeRemainsNarrow() {
        withCalendarDefaults { defaults in
            defaults.set(["google", "removed"], forKey: "meetingCalendar.selectedIDs")
            for useAll in [nil, false] as [Bool?] {
                defaults.set(useAll, forKey: "meetingCalendar.useAll")
                let selected = CalendarSelection.load(from: defaults)
                XCTAssertEqual(selected, .saved(["google", "removed"]))
                XCTAssertEqual(selected.identifiers(available: ["apple", "google", "new"]), ["google"])
            }
        }
    }

    func testSavingCalendarSelectionAllowsExactIDsIncludingEmpty() {
        withCalendarDefaults { defaults in
            defaults.set(true, forKey: "meetingCalendar.useAll")
            CalendarSelection.save(["google"], to: defaults)
            XCTAssertEqual(CalendarSelection.load(from: defaults), .saved(["google"]))

            CalendarSelection.save([], to: defaults)
            let empty = CalendarSelection.load(from: defaults)
            XCTAssertEqual(empty, .saved([]))
            XCTAssertEqual(empty.identifiers(available: ["apple", "google"]), [])
        }
    }

    private func withCalendarDefaults(_ test: (UserDefaults) -> Void) {
        let suite = "reel.test.calendar.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        test(defaults)
    }

    func testSupportedProvidersAndPasscodes() {
        let examples: [(String, MeetingPlatform)] = [
            (meet, .googleMeet),
            ("https://meet.google.com/meet/abc-defg-hij", .googleMeet),
            ("https://app.zoom.us/wc/12345678901/join?pwd=test", .zoom),
            ("https://acme.zoom.us/j/12345678901?pwd=test-passcode", .zoom),
            ("https://teams.microsoft.com/l/meetup-join/19%3ameeting_test%40thread.v2/0?context=%7B%7D", .teams),
            ("https://teams.microsoft.com/meet/123456789?p=test-passcode", .teams),
            ("https://teams.live.com/meet/123456789?p=test-passcode", .teams)
        ]
        for (url, platform) in examples {
            XCTAssertEqual(MeetingLinkParser.parse(url)?.platform, platform, url)
            XCTAssertEqual(MeetingLinkParser.parse(url)?.url.absoluteString, url)
            XCTAssertEqual(MeetingLinkParser.uniqueLink(in: ["Join: \(url)"])?.platform, platform, url)
        }
    }

    func testUnsafeAndUnrelatedLinksAreRejected() {
        for value in ["http://meet.google.com/abc-defg-hij", "https://meet.google.com.evil.test/abc-defg-hij",
                      "https://evil.test@meet.google.com/abc-defg-hij", "https://user:password@zoom.us/j/123456789",
                      "https://zoom.us:8443/j/123456789", "https://zoom.us.evil.test/j/123456789",
                      "https://zoom.us./j/123456789", "https://zoom.us/j/not-a-meeting",
                      "https://teams.microsoft.com.evil.test/meet/123", "https://teams.live.com/other/123",
                      "https://meet.google.com/abc-defg-hij#redirect", "file:///tmp/meeting"] {
            XCTAssertNil(MeetingLinkParser.parse(value), value)
        }
    }

    func testObservedProviderPageRequiresUnambiguousExactMeetingIdentity() throws {
        let expected = try XCTUnwrap(MeetingLinkParser.parse("https://us05web.zoom.us/j/12345678901?pwd=secret"))
        XCTAssertTrue(MeetingLinkParser.matchesObservedPage(["https://us05web.zoom.us/j/12345678901?pwd=secret"], expected: expected))
        for pages in [[], ["https://us05web.zoom.us/j/12345678902?pwd=secret"],
                      ["https://evil.test/j/12345678901?pwd=secret"],
                      ["https://us05web.zoom.us.evil.test/j/12345678901?pwd=secret"],
                      ["https://other.zoom.us/j/12345678901?pwd=secret"],
                      ["http://us05web.zoom.us/j/12345678901?pwd=secret"],
                      ["https://user@us05web.zoom.us/j/12345678901?pwd=secret"],
                      ["https://us05web.zoom.us/j/12345678901?pwd=other"],
                      ["https://us05web.zoom.us/j/12345678901?pwd=secret#success"],
                      ["https://us05web.zoom.us/j/12345678901?pwd=secret", "https://us05web.zoom.us/j/12345678901?pwd=secret"]] {
            XCTAssertFalse(MeetingLinkParser.matchesObservedPage(pages, expected: expected))
        }
    }

    func testZoomObservedBrowserStartRequiresOriginalIdentityAndTrustedRedirect() throws {
        let expected = try XCTUnwrap(MeetingLinkParser.parse("https://us05web.zoom.us/j/12345678901"))
        let query = "ref_from=launch&ts=123&fromPWA=1&pwd=encoded"
        let page = "https://app.zoom.us/wc/12345678901/start?" + query
        XCTAssertTrue(MeetingLinkParser.matchesObservedPage([page], expected: expected))
        for invalid in ["https://app.zoom.us/wc/12345678902/start?" + query,
                        "https://evil.test/wc/12345678901/start?" + query,
                        "https://app.zoom.us.evil.test/wc/12345678901/start?" + query,
                        "http://app.zoom.us/wc/12345678901/start?" + query,
                        "https://user@app.zoom.us/wc/12345678901/start?" + query,
                        "https://app.zoom.us/wc/12345678901/start?" + query + "&pwd=other",
                        "https://app.zoom.us/wc/12345678901/start?" + query + "&extra=x",
                        "https://app.zoom.us/wc/12345678901/start?pwd=encoded",
                        "https://app.zoom.us/wc/12345678901/start?" + query + "#success",
                        "https://app.zoom.us/wc/12345678901/start?ref_from=web&ts=123&fromPWA=1&pwd=encoded",
                        "https://app.zoom.us/wc/12345678901/start?ref_from=launch&ts=123&fromPWA=0&pwd=encoded",
                        "https://app.zoom.us/wc/12345678901/start?ref_from=launch&ts=abc&fromPWA=1&pwd=encoded",
                        "https://app.zoom.us/wc/12345678901/start?ref_from=launch&ts=123&fromPWA=1&pwd="] {
            XCTAssertFalse(MeetingLinkParser.matchesObservedPage([invalid], expected: expected))
        }
        XCTAssertFalse(MeetingLinkParser.matchesObservedPage([page, page], expected: expected))
        let protected = try XCTUnwrap(MeetingLinkParser.parse("https://us05web.zoom.us/j/12345678901?pwd=original"))
        XCTAssertTrue(MeetingLinkParser.matchesObservedPage([page], expected: protected))
    }

    func testZoomPasscodeSourceRetainsOnlyExactOriginalAndTrustedRedirects() throws {
        let original = "https://us05web.zoom.us/j/12345678901?pwd=source-passcode"
        let expected = try XCTUnwrap(MeetingLinkParser.parse(original))
        XCTAssertTrue(MeetingLinkParser.matchesObservedPage([original], expected: expected))
        XCTAssertTrue(MeetingLinkParser.matchesObservedPage(
            ["https://us05web.zoom.us/s/12345678901#success"], expected: expected))
        XCTAssertTrue(MeetingLinkParser.matchesObservedPage(
            ["https://us05web.zoom.us/s/12345678901?pwd=source-passcode"], expected: expected))
        XCTAssertTrue(MeetingLinkParser.matchesObservedPage(
            ["https://us05web.zoom.us/s/12345678901?pwd=source-passcode#success"], expected: expected))
        for invalid in ["https://us05web.zoom.us/s/12345678901?pwd=other-passcode",
                        "https://us05web.zoom.us/s/12345678901?pwd=source-passcode&extra=flag",
                        "https://us05web.zoom.us/s/12345678901?pwd=source-passcode&pwd=source-passcode",
                        "https://other.zoom.us/s/12345678901?pwd=source-passcode",
                        "https://us05web.zoom.us/s/12345678902?pwd=source-passcode",
                        "https://us05web.zoom.us/s/12345678901?pwd=source-passcode#other"] {
            XCTAssertFalse(MeetingLinkParser.matchesObservedPage([invalid], expected: expected), invalid)
        }
        let unprotected = try XCTUnwrap(MeetingLinkParser.parse("https://us05web.zoom.us/j/12345678901"))
        XCTAssertFalse(MeetingLinkParser.matchesObservedPage(
            ["https://us05web.zoom.us/s/12345678901?pwd=source-passcode"], expected: unprotected))
        XCTAssertTrue(MeetingLinkParser.matchesObservedPage(
            ["https://app.zoom.us/wc/12345678901/start?from=pwa&ref_from=launch"], expected: expected))
        XCTAssertTrue(MeetingLinkParser.matchesObservedPage(
            ["https://app.zoom.us/wc/12345678901/start?ref_from=launch&ts=123&fromPWA=1&pwd=source-passcode"],
            expected: expected))
        XCTAssertTrue(MeetingLinkParser.matchesObservedPage(
            ["https://app.zoom.us/wc/12345678901/start?ref_from=launch&ts=123&fromPWA=1&pwd=other-passcode"],
            expected: expected))

        let redirect = "https://us05web.zoom.us/s/12345678901#success"
        for source in ["https://us05web.zoom.us/j/12345678901?pwd=",
                       "https://us05web.zoom.us/j/12345678901?pwd=one&pwd=two",
                       "https://us05web.zoom.us/j/12345678901?pwd=one&extra=flag",
                       "https://us05web.zoom.us/j/12345678901?unknown=flag"] {
            let untrustedSource = try XCTUnwrap(MeetingLinkParser.parse(source))
            XCTAssertTrue(MeetingLinkParser.matchesObservedPage([source], expected: untrustedSource), source)
            XCTAssertFalse(MeetingLinkParser.matchesObservedPage([redirect], expected: untrustedSource), source)
            XCTAssertFalse(MeetingLinkParser.matchesObservedPage(
                ["https://app.zoom.us/wc/12345678901/start?from=pwa&ref_from=launch"], expected: untrustedSource), source)
            XCTAssertFalse(MeetingLinkParser.matchesObservedPage(
                ["https://app.zoom.us/wc/12345678901/join?from=pwa&ref_from=launch&ts=123"], expected: untrustedSource), source)
        }
    }

    func testZoomObservedSameHostLandingRequiresExactIDAndNoQuery() throws {
        let expected = try XCTUnwrap(MeetingLinkParser.parse("https://us05web.zoom.us/j/12345678901"))
        XCTAssertTrue(MeetingLinkParser.matchesObservedPage(["https://us05web.zoom.us/s/12345678901"], expected: expected))
        XCTAssertTrue(MeetingLinkParser.matchesObservedPage(["https://us05web.zoom.us/s/12345678901#success"], expected: expected))
        for invalid in ["https://us05web.zoom.us/s/12345678902", "https://evil.test/s/12345678901",
                        "https://other.zoom.us/s/12345678901", "https://us05web.zoom.us/s/12345678901?x=1",
                        "https://us05web.zoom.us/s/12345678901/extra", "https://us05web.zoom.us.evil.test/s/12345678901",
                        "https://us05web.zoom.us/s/12345678901#other", "https://us05web.zoom.us/s/12345678901#%73uccess",
                        "https://us05web.zoom.us/s/12345678902#success", "https://other.zoom.us/s/12345678901#success"] {
            XCTAssertFalse(MeetingLinkParser.matchesObservedPage([invalid], expected: expected))
        }
        let protected = try XCTUnwrap(MeetingLinkParser.parse("https://us05web.zoom.us/j/12345678901?pwd=secret"))
        XCTAssertTrue(MeetingLinkParser.matchesObservedPage(["https://us05web.zoom.us/s/12345678901"], expected: protected))
    }

    func testZoomStandaloneFrameRequiresObservedSameMeetingRoute() throws {
        let expected = try XCTUnwrap(MeetingLinkParser.parse("https://us05web.zoom.us/j/12345678901"))
        let frame = "https://app.zoom.us/wc/12345678901/start?from=pwa&ref_from=launch"
        XCTAssertTrue(MeetingLinkParser.isObservedZoomStandaloneFrame(frame, expected: expected))
        XCTAssertTrue(MeetingLinkParser.matchesObservedPage([frame], expected: expected))
        let webLaunchFrame = "https://app.zoom.us/wc/12345678901/start?from=pwa&jcs=web_launch-zwa-pcBrw&ref_from=launch"
        XCTAssertTrue(MeetingLinkParser.isObservedZoomStandaloneFrame(webLaunchFrame, expected: expected))
        XCTAssertTrue(MeetingLinkParser.matchesObservedPage([webLaunchFrame], expected: expected))
        for invalid in ["https://app.zoom.us/wc/12345678902/start?from=pwa&ref_from=launch",
                        "https://evil.test/wc/12345678901/start?from=pwa&ref_from=launch",
                        "https://app.zoom.us.evil.test/wc/12345678901/start?from=pwa&ref_from=launch",
                        "http://app.zoom.us/wc/12345678901/start?from=pwa&ref_from=launch",
                        "https://user@app.zoom.us/wc/12345678901/start?from=pwa&ref_from=launch",
                        frame + "&from=pwa", frame + "&pwd=other", frame + "#success",
                        "https://app.zoom.us/wc/12345678901/start?from=pwa&jcs=&ref_from=launch",
                        "https://app.zoom.us/wc/12345678901/start?from=pwa&jcs=wrong&ref_from=launch",
                        "https://app.zoom.us/wc/12345678901/start?from=pwa&jcs=web_launch-zwa-pcBrw&jcs=web_launch-zwa-pcBrw&ref_from=launch",
                        webLaunchFrame + "&extra=1"] {
            XCTAssertFalse(MeetingLinkParser.isObservedZoomStandaloneFrame(invalid, expected: expected))
            XCTAssertFalse(MeetingLinkParser.matchesObservedPage([invalid], expected: expected))
        }
        let protected = try XCTUnwrap(MeetingLinkParser.parse("https://us05web.zoom.us/j/12345678901?pwd=secret"))
        XCTAssertTrue(MeetingLinkParser.isObservedZoomStandaloneFrame(frame, expected: protected))
        XCTAssertTrue(MeetingLinkParser.isObservedZoomStandaloneFrame(webLaunchFrame, expected: protected))
        XCTAssertFalse(MeetingLinkParser.matchesObservedPage([frame, frame], expected: expected))
    }

    func testZoomObservedGuestJoinRequiresKnownRedirectAndExactID() throws {
        let expected = try XCTUnwrap(MeetingLinkParser.parse("https://us05web.zoom.us/j/12345678901"))
        let query = "from=pwa&ref_from=launch&ts=1794639874946"
        let page = "https://app.zoom.us/wc/12345678901/join?" + query
        XCTAssertTrue(MeetingLinkParser.matchesObservedPage([page], expected: expected))
        for invalid in ["https://app.zoom.us/wc/12345678902/join?" + query,
                        "https://evil.test/wc/12345678901/join?" + query,
                        "http://app.zoom.us/wc/12345678901/join?" + query,
                        "https://app.zoom.us/wc/12345678901/join?" + query + "&from=pwa",
                        "https://app.zoom.us/wc/12345678901/join?from=other&ref_from=launch&ts=123",
                        "https://app.zoom.us/wc/12345678901/join?from=pwa&ref_from=launch&ts=not-a-number",
                        "https://app.zoom.us/wc/12345678901/join?" + query + "&pwd=unexpected",
                        "https://app.zoom.us/wc/12345678901/join?" + query + "#success"] {
            XCTAssertFalse(MeetingLinkParser.matchesObservedPage([invalid], expected: expected))
        }
        XCTAssertFalse(MeetingLinkParser.matchesObservedPage([page, page], expected: expected))
        let protected = try XCTUnwrap(MeetingLinkParser.parse("https://us05web.zoom.us/j/12345678901?pwd=original"))
        XCTAssertTrue(MeetingLinkParser.matchesObservedPage([page], expected: protected))

        let chromeQuery = "ref_from=launch&ts=1794639874946&fromPWA=1"
        let chromeGuest = "https://app.zoom.us/wc/12345678901/join?" + chromeQuery
        let chromeGuestWithPassword = chromeGuest + "&pwd=guest-pass"
        XCTAssertTrue(MeetingLinkParser.matchesObservedPage([chromeGuest], expected: expected))
        XCTAssertTrue(MeetingLinkParser.matchesObservedPage([chromeGuestWithPassword], expected: expected))
        for invalid in ["https://app.zoom.us/wc/12345678902/join?" + chromeQuery,
                        "https://evil.test/wc/12345678901/join?" + chromeQuery,
                        "https://app.zoom.us.evil.test/wc/12345678901/join?" + chromeQuery,
                        "https://app.zoom.us/wc/12345678901/join?" + chromeQuery + "&fromPWA=1",
                        "https://app.zoom.us/wc/12345678901/join?" + chromeQuery + "&unknown=x",
                        "https://app.zoom.us/wc/12345678901/join?ref_from=launch&ts=abc&fromPWA=1",
                        "https://app.zoom.us/wc/12345678901/join?" + chromeQuery + "&pwd=",
                        "https://app.zoom.us/wc/12345678901/join?" + chromeQuery + "&pwd=a&pwd=b",
                        "https://app.zoom.us/wc/12345678901/join?ref_from=launch&ts=1794639874946&fromPWA=0",
                        "https://app.zoom.us/wc/12345678901/join?" + chromeQuery + "#success"] {
            XCTAssertFalse(MeetingLinkParser.matchesObservedPage([invalid], expected: expected), invalid)
        }
        let protectedChromeExpected = try XCTUnwrap(MeetingLinkParser.parse("https://us05web.zoom.us/j/12345678901?pwd=guest-pass"))
        XCTAssertTrue(MeetingLinkParser.matchesObservedPage([chromeGuestWithPassword], expected: protectedChromeExpected))
        XCTAssertTrue(MeetingLinkParser.matchesObservedPage([chromeGuest], expected: protectedChromeExpected))
        XCTAssertTrue(MeetingLinkParser.matchesObservedPage([chromeGuestWithPassword.replacingOccurrences(of: "guest-pass", with: "other")], expected: protectedChromeExpected))
    }

    func testCallConfirmationRequiresProviderControlsAndMediaOffProof() {
        XCTAssertTrue(MeetingCallControls.active(platform: .zoom, labels: ["end", "share"]))
        XCTAssertFalse(MeetingCallControls.active(platform: .googleMeet, labels: ["end", "share"]))
        XCTAssertFalse(MeetingCallControls.active(platform: .zoom, labels: ["end"]))
        XCTAssertTrue(MeetingCallControls.active(platform: .googleMeet, labels: ["leave call", "present now"]))
        XCTAssertFalse(MeetingCallControls.mediaOff(labels: ["audio", "video"], continuedWithoutMedia: false))
        XCTAssertTrue(MeetingCallControls.mediaOff(labels: ["audio", "video"], continuedWithoutMedia: true))
        XCTAssertTrue(MeetingCallControls.mediaOff(labels: ["unmute microphone", "start video"], continuedWithoutMedia: false))
        XCTAssertTrue(MeetingCallControls.mediaOff(labels: ["unmute my microphone", "start video"], continuedWithoutMedia: false))
        XCTAssertFalse(MeetingCallControls.mediaOff(labels: ["mute microphone", "start video"], continuedWithoutMedia: true))
        XCTAssertFalse(MeetingCallControls.mediaOff(labels: ["mute my microphone", "start video"], continuedWithoutMedia: true))
        XCTAssertFalse(MeetingCallControls.mediaOff(labels: ["unmute microphone", "stop video"], continuedWithoutMedia: true))
    }

    func testCallWatchdogBoundsKnownEndAndUnknownStates() {
        var watchdog = MeetingCallWatchdog()
        let start = Date(timeIntervalSince1970: 0)
        XCTAssertFalse(watchdog.shouldStop(active: nil, now: start))
        XCTAssertFalse(watchdog.shouldStop(active: nil, now: start.addingTimeInterval(29)))
        XCTAssertTrue(watchdog.shouldStop(active: nil, now: start.addingTimeInterval(30)))
        XCTAssertFalse(watchdog.shouldStop(active: true, now: start.addingTimeInterval(31)))
        XCTAssertFalse(watchdog.shouldStop(active: false, now: start.addingTimeInterval(32)))
        XCTAssertFalse(watchdog.shouldStop(active: false, now: start.addingTimeInterval(39)))
        XCTAssertTrue(watchdog.shouldStop(active: false, now: start.addingTimeInterval(40)))
        XCTAssertFalse(watchdog.shouldStop(active: nil, now: start.addingTimeInterval(41)))
        var alternating = MeetingCallWatchdog()
        XCTAssertFalse(alternating.shouldStop(active: nil, now: start))
        XCTAssertFalse(alternating.shouldStop(active: false, now: start.addingTimeInterval(26)))
        XCTAssertTrue(alternating.shouldStop(active: nil, now: start.addingTimeInterval(30)))
    }

    func testObservedTeamsPageRequiresExactIdentity() throws {
        let expected = try XCTUnwrap(MeetingLinkParser.parse("https://teams.microsoft.com/meet/123456789?p=passcode"))
        XCTAssertTrue(MeetingLinkParser.matchesObservedPage([expected.url.absoluteString], expected: expected))
        XCTAssertFalse(MeetingLinkParser.matchesObservedPage(["https://teams.microsoft.com/meet/123456780?p=passcode"], expected: expected))
        XCTAssertFalse(MeetingLinkParser.matchesObservedPage(["https://teams.live.com/meet/123456789?p=passcode"], expected: expected))
    }

    func testDuplicateLinksAreAcceptedAndMultipleMeetingsAreOmitted() {
        var event = candidate()
        event.linkTexts = [meet, "Join: \(meet)\nOther notes https://example.com"]
        XCTAssertNotNil(meeting(event))
        event.linkTexts.append("https://zoom.us/j/123456789")
        XCTAssertNil(meeting(event))
    }

    func testRecurringOccurrencesAndCalendarsHaveDistinctStableIDs() {
        let first = candidate()
        var next = first
        next.start = first.start.addingTimeInterval(86400)
        next.end = first.end.addingTimeInterval(86400)
        XCTAssertNotEqual(meeting(first)?.id, meeting(next)?.id)
        var otherCalendar = first
        otherCalendar.calendarID = "other-calendar"
        XCTAssertNotEqual(meeting(first)?.id, meeting(otherCalendar)?.id)
        var renamed = first
        renamed.title = "New title"
        XCTAssertEqual(meeting(first)?.id, meeting(renamed)?.id)
    }

    func testExcludedEventsAndTimeWindow() {
        var event = candidate(); event.allDay = true; XCTAssertNil(meeting(event))
        event = candidate(); event.cancelled = true; XCTAssertNil(meeting(event))
        event = candidate(); event.isPrivate = true; XCTAssertNil(meeting(event))
        event = candidate(); event.ownerDeclined = true; XCTAssertNil(meeting(event))
        event = candidate(); event.title = "[private] Client"; XCTAssertNil(meeting(event))
        event = candidate(); event.title = "Client [NO-REC]"; XCTAssertNil(meeting(event))
        event = candidate(); event.start = now.addingTimeInterval(-2400); event.end = now.addingTimeInterval(-1); XCTAssertNil(meeting(event))
        event = candidate(); event.start = now.addingTimeInterval(7 * 86400); XCTAssertNil(meeting(event))
        event = candidate(); event.end = event.start; XCTAssertNil(meeting(event))
    }

    func testIncludesMeetingAlreadyInProgress() {
        var event = candidate()
        event.start = now.addingTimeInterval(-300)
        event.end = now.addingTimeInterval(900)
        XCTAssertEqual(meeting(event)?.start, event.start)
    }

    func testJSONRoundTripDoesNotRetainCalendarNotes() throws {
        var event = candidate()
        event.linkTexts.append("Private source text that is not needed downstream")
        event.attendeeEmails = ["anna@example.com", "anna@example.com"]
        let value = try XCTUnwrap(meeting(event))
        let data = try ReelJSON.encoder.encode(value)
        XCTAssertEqual(try ReelJSON.decoder.decode(CalendarMeeting.self, from: data), value)
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("Private source text"))
        XCTAssertEqual(value.attendeeEmails, ["anna@example.com"])
    }
}
