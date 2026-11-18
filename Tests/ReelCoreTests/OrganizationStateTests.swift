import XCTest
@testable import ReelCore

final class OrganizationStateTests: XCTestCase {
    func testLibrariesAndAutomaticQueuesUseProjectAndDomainEvenForIdenticalUIDs() throws {
        let movies = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: movies) }

        let owner = "shared-uid"
        let config = testOrganization
        var otherProject = config
        otherProject.projectID = "other-reel"
        var otherDomain = config
        otherDomain.allowedEmailDomain = "another.example"
        var unconfigured = config
        unconfigured.apiKey = ""
        let configs = [config, otherProject, otherDomain, unconfigured]
        let libraries = configs.map { LibraryStore(root: OrganizationState(config: $0).directory(under: movies)) }
        let legacy = LibraryStore(root: movies.appendingPathComponent("Reel"))
        try legacy.save(recording("legacy", meetingOwner: owner))
        XCTAssertEqual(Set(libraries.map(\.root)).count, libraries.count)

        for (index, library) in libraries.enumerated() {
            XCTAssertTrue(library.load().isEmpty, "Switching deployments must start with an empty library")
            let pending = recording("pending-\(index)")
            var local = recording("local-\(index)")
            local.upload = .localOnly
            let meeting = recording("meeting-\(index)", meetingOwner: owner)
            for recording in [pending, local, meeting] { try library.save(recording) }

            let reopened = LibraryStore(root: OrganizationState(config: configs[index]).directory(under: movies))
            let entries = reopened.load()
            XCTAssertEqual(Set(entries.map(\.id)), [pending.id, local.id, meeting.id])
            XCTAssertEqual(Set(entries.filter(\.awaitsUploadOnSignIn).map(\.id)), [pending.id, local.id])
            XCTAssertEqual(entries.filter { $0.canResumeMeetingProcessing(owner: owner) }.map(\.id), [meeting.id])
            XCTAssertTrue(entries.filter { $0.canResumeMeetingProcessing(owner: "different-uid") }.isEmpty)
        }
        XCTAssertEqual(legacy.load().map(\.folderName), ["legacy"])
        XCTAssertEqual(LibraryStore.defaultRoot, OrganizationState.current.directory(
            under: FileManager.default.urls(for: .moviesDirectory, in: .userDomainMask)[0]))
    }

    func testConsentCredentialsAndSupportFilesArePartitionedBeforeSignIn() {
        let bundleID = "org.reel.fixture.\(UUID().uuidString)"
        var project = testOrganization
        project.projectID = "other-reel"
        var domain = testOrganization
        domain.allowedEmailDomain = "other.example"
        var unconfigured = testOrganization
        unconfigured.projectID = ""
        let states = [testOrganization, project, domain, unconfigured].map { OrganizationState(config: $0, bundleID: bundleID) }
        let support = URL(fileURLWithPath: "/fixture/Application Support")
        XCTAssertEqual(Set(states.map { $0.directory(under: support) }).count, states.count)
        XCTAssertEqual(Set(states.map(\.sessionService)).count, states.count)
        XCTAssertEqual(Set(states.map(\.notionService)).count, states.count)

        let suites = states.map { UserDefaults(suiteName: $0.defaultsSuite)! }
        defer {
            for (suite, state) in zip(suites, states) { suite.removePersistentDomain(forName: state.defaultsSuite) }
        }
        suites[0].set(true, forKey: "meetingCalendar.standingConsent")
        suites[0].set("shared-uid", forKey: "meetingCalendar.standingConsentOwner")
        suites[0].set(["a-private-calendar"], forKey: "meetingCalendar.selectedIDs")
        XCTAssertEqual(suites[0].string(forKey: "meetingCalendar.standingConsentOwner"), "shared-uid")
        for suite in suites.dropFirst() {
            XCTAssertFalse(suite.bool(forKey: "meetingCalendar.standingConsent"))
            XCTAssertNil(suite.string(forKey: "meetingCalendar.standingConsentOwner"))
            XCTAssertNil(suite.stringArray(forKey: "meetingCalendar.selectedIDs"))
        }
    }

    private func recording(_ name: String, meetingOwner: String? = nil) -> Recording {
        var meeting = meetingOwner.map { MeetingDetails(ownerUserID: $0) }
        meeting?.deliveryStatus = .pending
        return Recording(title: name, createdAt: Date(), durationSeconds: 3, width: 2, height: 2,
                         mode: .screen, folderName: name, meeting: meeting)
    }
}
