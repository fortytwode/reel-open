import XCTest
@testable import ReelCore

final class VideoGeometryTests: XCTestCase {
    func testLandscapeFitsBoxKeepingAspect() {
        let src = PixelSize(width: 3456, height: 2234)
        let o = VideoGeometry.outputSize(source: src, preset: .p1080)
        let scale = min(1920.0 / 3456, 1080.0 / 2234)
        func even(_ v: Double) -> Int { Int((v / 2).rounded(.down)) * 2 }
        XCTAssertEqual(o.width, even(3456 * scale))
        XCTAssertEqual(o.height, even(2234 * scale))
        XCTAssertEqual(o.width, 1670)
        XCTAssertLessThanOrEqual(o.width, 1920)
        XCTAssertLessThanOrEqual(o.height, 1080)
        XCTAssertEqual(o.width % 2, 0)
        XCTAssertEqual(o.height % 2, 0)
        XCTAssertEqual(Double(o.width) / Double(o.height), 3456.0 / 2234, accuracy: 0.01)
    }

    func testNoUpscaling() {
        XCTAssertEqual(VideoGeometry.outputSize(source: PixelSize(width: 800, height: 600), preset: .p1080), PixelSize(width: 800, height: 600))
    }

    func testOddDimensionsRoundedToEven() {
        XCTAssertEqual(VideoGeometry.outputSize(source: PixelSize(width: 801, height: 601), preset: .p1080), PixelSize(width: 800, height: 600))
    }

    func test16by9Exact() {
        XCTAssertEqual(VideoGeometry.outputSize(source: PixelSize(width: 3840, height: 2160), preset: .p1080), PixelSize(width: 1920, height: 1080))
        XCTAssertEqual(VideoGeometry.outputSize(source: PixelSize(width: 3840, height: 2160), preset: .p720), PixelSize(width: 1280, height: 720))
    }

    func testPortraitUsesSwappedBox() {
        XCTAssertEqual(VideoGeometry.outputSize(source: PixelSize(width: 2160, height: 3840), preset: .p1080), PixelSize(width: 1080, height: 1920))
    }

    func testPresetBoundsAndLabels() {
        XCTAssertEqual(QualityPreset.p2160.label, "4K")
        XCTAssertEqual(QualityPreset.p1440.bounds.long, 2560)
        XCTAssertEqual(QualityPreset.p720.bounds.short, 720)
    }

    func testBitrate() {
        XCTAssertEqual(VideoGeometry.bitrate(for: PixelSize(width: 1920, height: 1080), fps: 30), 4_000_000)
        XCTAssertEqual(VideoGeometry.bitrate(for: PixelSize(width: 1670, height: 1080), fps: 30), 4_000_000)
        XCTAssertEqual(VideoGeometry.bitrate(for: PixelSize(width: 100, height: 100), fps: 30), 800_000)
        XCTAssertEqual(VideoGeometry.bitrate(for: PixelSize(width: 1280, height: 720), fps: 30), 2_500_000)
        XCTAssertEqual(VideoGeometry.bitrate(for: PixelSize(width: 2560, height: 1440), fps: 24), 6_000_000)
        XCTAssertEqual(VideoGeometry.bitrate(for: PixelSize(width: 3840, height: 2160), fps: 30), 10_000_000)
        XCTAssertEqual(VideoGeometry.bitrate(for: PixelSize(width: 1920, height: 1080), fps: 60), 6_000_000)
    }

    func testBubbleRectMapsAndScales() {
        let cap = Rect(x: 100, y: 200, width: 1000, height: 500)
        let r = VideoGeometry.bubbleRect(bubble: Rect(x: 200, y: 300, width: 100, height: 50), captureRect: cap, output: PixelSize(width: 2000, height: 1000))
        XCTAssertEqual(r, Rect(x: 200, y: 200, width: 200, height: 100))
    }

    func testBubbleRectNilWhenOutside() {
        let cap = Rect(x: 0, y: 0, width: 1000, height: 500)
        let out = PixelSize(width: 1000, height: 500)
        XCTAssertNil(VideoGeometry.bubbleRect(bubble: Rect(x: 1100, y: 10, width: 50, height: 50), captureRect: cap, output: out))
        XCTAssertNil(VideoGeometry.bubbleRect(bubble: Rect(x: -100, y: 10, width: 50, height: 50), captureRect: cap, output: out))
        XCTAssertNil(VideoGeometry.bubbleRect(bubble: Rect(x: 10, y: 600, width: 50, height: 50), captureRect: cap, output: out))
        XCTAssertNotNil(VideoGeometry.bubbleRect(bubble: Rect(x: -25, y: 10, width: 50, height: 50), captureRect: cap, output: out))
        XCTAssertNil(VideoGeometry.bubbleRect(bubble: Rect(x: 0, y: 0, width: 5, height: 5), captureRect: Rect(x: 0, y: 0, width: 0, height: 0), output: out))
    }

    func testCornerBubble() {
        let r = VideoGeometry.cornerBubble(output: PixelSize(width: 1920, height: 1080))
        XCTAssertEqual(r, Rect(x: 32, y: 32, width: 238, height: 238))
    }
}
