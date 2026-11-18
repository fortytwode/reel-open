import XCTest
@testable import ReelCore

final class SettingsTests: XCTestCase {
    func decode(_ json: String) throws -> ReelSettings {
        try JSONDecoder().decode(ReelSettings.self, from: Data(json.utf8))
    }

    func testEmptyObjectYieldsDefaults() throws {
        XCTAssertEqual(try decode("{}"), ReelSettings())
        let d = ReelSettings()
        XCTAssertEqual(d.fps, 30)
        XCTAssertEqual(d.countdownSeconds, 3)
        XCTAssertEqual(d.quality, .p1080)
        XCTAssertEqual(d.shortcut, .startStop)
        XCTAssertEqual(d.transcriptionLocaleIdentifier, "en-US")
    }

    func testInvalidFPSFallsBack() throws {
        XCTAssertEqual(try decode("{\"fps\":45}").fps, 30)
        XCTAssertEqual(try decode("{\"fps\":60}").fps, 60)
        XCTAssertEqual(try decode("{\"fps\":24}").fps, 24)
    }

    func testCountdownClamped() throws {
        XCTAssertEqual(try decode("{\"countdownSeconds\":99}").countdownSeconds, 10)
        XCTAssertEqual(try decode("{\"countdownSeconds\":-4}").countdownSeconds, 0)
        XCTAssertEqual(try decode("{\"countdownSeconds\":5}").countdownSeconds, 5)
    }

    func testInvalidShortcutFallsBack() throws {
        let bad = try decode("{\"shortcut\":{\"keyCode\":15,\"modifiers\":0,\"key\":\"r\"}}")
        XCTAssertEqual(bad.shortcut, .startStop)
        let shiftOnly = try decode("{\"shortcut\":{\"keyCode\":15,\"modifiers\":\(Shortcut.shift),\"key\":\"r\"}}")
        XCTAssertEqual(shiftOnly.shortcut, .startStop)
    }

    func testValidCustomShortcutKept() throws {
        let s = try decode("{\"shortcut\":{\"keyCode\":1,\"modifiers\":\(Shortcut.cmd | Shortcut.shift),\"key\":\"s\"}}")
        XCTAssertEqual(s.shortcut.keyCode, 1)
        XCTAssertEqual(s.shortcut.display, "⇧⌘S")
    }

    func testShortcutDisplayAndValidity() {
        XCTAssertEqual(Shortcut.startStop.display, "⌃⌥R")
        XCTAssertEqual(Shortcut.pauseResume.display, "⌃⌥P")
        XCTAssertTrue(Shortcut.startStop.isValid)
        XCTAssertFalse(Shortcut(keyCode: 200, modifiers: Shortcut.cmd, key: "x").isValid)
        XCTAssertFalse(Shortcut(keyCode: 1, modifiers: Shortcut.cmd, key: "").isValid)
        XCTAssertFalse(Shortcut(keyCode: 1, modifiers: Shortcut.cmd | 1, key: "x").isValid)
    }

    func testBadFieldsFallBackIndividually() throws {
        let s = try decode("{\"mode\":\"bogus\",\"autoUpload\":false,\"quality\":\"p720\"}")
        XCTAssertEqual(s.mode, .screen)
        XCTAssertFalse(s.autoUpload)
        XCTAssertEqual(s.quality, .p720)
    }

    func testRoundTrip() throws {
        var s = ReelSettings()
        s.mode = .camera
        s.cameraID = "cam"
        s.microphoneID = "mic"
        s.audio = .micAndSystem
        s.quality = .p2160
        s.fps = 60
        s.countdownSeconds = 7
        s.bubbleSize = .large
        s.autoUpload = false
        s.displayID = 42
        s.shortcut = .pauseResume
        s.transcriptionLocaleIdentifier = "fr-FR"
        let back = try JSONDecoder().decode(ReelSettings.self, from: JSONEncoder().encode(s))
        XCTAssertEqual(back, s)
    }

    func testMissingTranscriptionLanguageDefaultsToEnglish() throws {
        XCTAssertEqual(try decode("{}").transcriptionLocaleIdentifier, "en-US")
    }

    func testAudioSourceAndBubbleHelpers() {
        XCTAssertTrue(AudioSource.micAndSystem.usesMic && AudioSource.micAndSystem.usesSystem)
        XCTAssertFalse(AudioSource.none.usesMic || AudioSource.none.usesSystem)
        XCTAssertTrue(AudioSource.systemOnly.usesSystem && !AudioSource.systemOnly.usesMic)
        XCTAssertEqual(BubbleSize.large.diameter, 320)
    }
}
