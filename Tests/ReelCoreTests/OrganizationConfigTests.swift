import Foundation
import XCTest
@testable import ReelCore

let exampleOrganizationURL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("organization.example.json")

let testOrganization = CloudConfig.load(from: exampleOrganizationURL)!

final class OrganizationConfigTests: XCTestCase {
    func testConfigurationAcceptsProvisionedStorageBucketNames() throws {
        let fixture = try Data(contentsOf: exampleOrganizationURL)
        var values = try XCTUnwrap(JSONSerialization.jsonObject(with: fixture) as? [String: Any])
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let source = directory.appendingPathComponent("organization.json")
        for bucket in ["northwind-recordings", "northwind_recordings", "demo-reel.firebasestorage.app"] {
            values["bucket"] = bucket
            try JSONSerialization.data(withJSONObject: values).write(to: source)
            XCTAssertEqual(CloudConfig.load(from: source)?.bucket, bucket)
        }
        for bucket in ["ab", "Bad-Bucket", "bad/bucket", "192.168.0.1", String(repeating: "a", count: 64)] {
            values["bucket"] = bucket
            try JSONSerialization.data(withJSONObject: values).write(to: source)
            XCTAssertNil(CloudConfig.load(from: source))
        }
    }

    func testExampleOrganizationAcceptsOnlyItsExactDomain() {
        XCTAssertEqual(testOrganization.projectID, "demo-reel")
        XCTAssertTrue(testOrganization.permits(email: "User@NORTHWIND.EXAMPLE"))
        for invalid in ["user@evilnorthwind.example", "user@northwind.example.other", "u@bad@northwind.example", "@northwind.example"] {
            XCTAssertFalse(testOrganization.permits(email: invalid))
        }
        XCTAssertNil(CloudConfig.load(from: nil))
    }
}
