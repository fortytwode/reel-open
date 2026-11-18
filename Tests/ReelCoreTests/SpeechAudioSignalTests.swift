import XCTest
import ReelCore

final class SpeechAudioSignalTests: XCTestCase {
    func testDigitalSilenceIsEmptyOrAllZeroPCM() {
        XCTAssertFalse(SpeechAudioSignal.hasNonzeroPCM16([Int16]()))
        XCTAssertFalse(SpeechAudioSignal.hasNonzeroPCM16([Int16](repeating: 0, count: 32)))
    }

    func testAnyNonzeroPCMIsRetainedWithoutAmplitudeThreshold() {
        XCTAssertTrue(SpeechAudioSignal.hasNonzeroPCM16([1]))
        XCTAssertTrue(SpeechAudioSignal.hasNonzeroPCM16([-1]))
        XCTAssertTrue(SpeechAudioSignal.hasNonzeroPCM16([Int16.min]))
        XCTAssertTrue(SpeechAudioSignal.hasNonzeroPCM16([0, 0, -1, 0, 0]))
    }
}
