import XCTest
@testable import ReelCore

final class DeviceDefaultsTests: XCTestCase {
    let phone = DeviceInfo(id: "p", name: "Sam's iPhone Camera", kind: .continuity)
    let phoneNamedOnly = DeviceInfo(id: "p2", name: "iPhone Microphone", kind: .external)
    let mbp = DeviceInfo(id: "m", name: "MacBook Pro Camera", kind: .builtIn)
    let builtIn = DeviceInfo(id: "b", name: "FaceTime HD Camera", kind: .builtIn)
    let ext = DeviceInfo(id: "e", name: "Logitech", kind: .external)
    let virt = DeviceInfo(id: "v", name: "OBS", kind: .virtual)

    func testCameraSavedWins() {
        XCTAssertEqual(DeviceDefaults.camera(from: [mbp, ext], savedID: "e"), ext)
    }
    func testCameraSavedMissingFallsThrough() {
        XCTAssertEqual(DeviceDefaults.camera(from: [ext, mbp], savedID: "zzz"), mbp)
    }
    func testCameraExactNameBeatsOtherBuiltIn() {
        XCTAssertEqual(DeviceDefaults.camera(from: [builtIn, mbp], savedID: nil), mbp)
    }
    func testCameraNeverAutoPicksContinuityEvenFirst() {
        XCTAssertEqual(DeviceDefaults.camera(from: [phone, ext], savedID: nil), ext)
        XCTAssertEqual(DeviceDefaults.camera(from: [phone, builtIn], savedID: nil), builtIn)
    }
    func testCameraNameContainingIPhoneIsContinuity() {
        let sneaky = DeviceInfo(id: "s", name: "My iPhone", kind: .external)
        XCTAssertTrue(sneaky.isContinuity)
        XCTAssertNil(DeviceDefaults.camera(from: [sneaky], savedID: nil))
    }
    func testCameraFallsBackBuiltInThenExternal() {
        XCTAssertEqual(DeviceDefaults.camera(from: [ext, builtIn], savedID: nil), builtIn)
        XCTAssertEqual(DeviceDefaults.camera(from: [virt, ext], savedID: nil), ext)
    }
    func testCameraSavedContinuityIsHonoured() {
        XCTAssertEqual(DeviceDefaults.camera(from: [mbp, phone], savedID: "p"), phone)
    }
    func testCameraNilWhenOnlyContinuityOrEmpty() {
        XCTAssertNil(DeviceDefaults.camera(from: [phone], savedID: nil))
        XCTAssertNil(DeviceDefaults.camera(from: [], savedID: nil))
        XCTAssertNil(DeviceDefaults.camera(from: [virt], savedID: nil))
    }

    let mic = DeviceInfo(id: "mic", name: "MacBook Pro Microphone", kind: .builtIn)
    let usb = DeviceInfo(id: "usb", name: "USB Mic", kind: .external)

    func testMicSavedWins() {
        XCTAssertEqual(DeviceDefaults.microphone(from: [mic, usb], savedID: "usb", systemDefaultID: "mic"), usb)
    }
    func testMicSystemDefaultUnlessPhone() {
        XCTAssertEqual(DeviceDefaults.microphone(from: [mic, usb], savedID: nil, systemDefaultID: "usb"), usb)
        XCTAssertEqual(DeviceDefaults.microphone(from: [phoneNamedOnly, usb, mic], savedID: nil, systemDefaultID: "p2"), mic)
    }
    func testMicFallsBackToBuiltInThenFirstNonContinuity() {
        XCTAssertEqual(DeviceDefaults.microphone(from: [usb, mic], savedID: nil, systemDefaultID: nil), mic)
        XCTAssertEqual(DeviceDefaults.microphone(from: [phoneNamedOnly, usb], savedID: nil, systemDefaultID: nil), usb)
        XCTAssertNil(DeviceDefaults.microphone(from: [phoneNamedOnly], savedID: nil, systemDefaultID: nil))
    }
}
