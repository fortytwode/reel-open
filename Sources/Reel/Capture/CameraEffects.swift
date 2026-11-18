import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins
import Metal
import ReelCore
import Vision

/// Camera background effects, like Loom's (which also uses Vision's
/// VNGeneratePersonSegmentationRequest): the person mask from Vision keeps the subject sharp
/// over a blurred copy of the frame or over a virtual background image. Runs on the camera
/// queue; output frames feed both the bubble preview and the recording.
final class CameraEffects: @unchecked Sendable {
    private let context: CIContext
    private let request: VNGeneratePersonSegmentationRequest
    private let sequence = VNSequenceRequestHandler()
    private var pool: CVPixelBufferPool?
    private var poolSize: CGSize = .zero
    private var backgroundImage: CIImage?
    private var backgroundPath: String?
    private(set) var lastError: String?
    /// Frames processed / failed (for verification).
    private(set) var processed = 0

    init() {
        if let device = MTLCreateSystemDefaultDevice() {
            context = CIContext(mtlDevice: device, options: [.cacheIntermediates: false])
        } else {
            context = CIContext()
        }
        request = VNGeneratePersonSegmentationRequest()
        request.qualityLevel = .balanced
        request.outputPixelFormat = kCVPixelFormatType_OneComponent8
    }

    /// Loads (once) the virtual background; nil path = Reel's built-in gradient.
    func setBackgroundImage(path: String?) {
        guard path != backgroundPath || backgroundImage == nil else { return }
        backgroundPath = path
        if let path, let img = CIImage(contentsOf: URL(fileURLWithPath: path)) {
            backgroundImage = img
        } else {
            backgroundImage = Self.defaultBackground()
        }
    }

    /// A soft warm gradient (Reel accent to dusk blue).
    static func defaultBackground() -> CIImage {
        let g = CIFilter.linearGradient()
        g.point0 = CGPoint(x: 0, y: 0)
        g.point1 = CGPoint(x: 1280, y: 720)
        g.color0 = CIColor(red: 0.13, green: 0.16, blue: 0.30)
        g.color1 = CIColor(red: 0.91, green: 0.45, blue: 0.36)
        return g.outputImage!.cropped(to: CGRect(x: 0, y: 0, width: 1280, height: 720))
    }

    func process(_ frame: CVPixelBuffer, mode: CameraBackground) -> CVPixelBuffer? {
        guard mode != .none else { return frame }
        do { try sequence.perform([request], on: frame) } catch {
            lastError = error.localizedDescription
            return frame
        }
        guard let mask = request.results?.first?.pixelBuffer else { return frame }
        let src = CIImage(cvPixelBuffer: frame)
        let extent = src.extent
        var maskImage = CIImage(cvPixelBuffer: mask)
        maskImage = maskImage.transformed(by: CGAffineTransform(scaleX: extent.width / maskImage.extent.width,
                                                                 y: extent.height / maskImage.extent.height))
        // Feather the edge a little so hair doesn't look cut out.
        maskImage = maskImage.clampedToExtent().applyingGaussianBlur(sigma: 1.5).cropped(to: extent)

        let background: CIImage
        switch mode {
        case .blur:
            background = src.clampedToExtent().applyingGaussianBlur(sigma: 22).cropped(to: extent)
        case .image:
            if backgroundImage == nil { setBackgroundImage(path: backgroundPath) }
            background = Self.aspectFill(backgroundImage ?? Self.defaultBackground(), in: extent)
        case .none:
            return frame
        }
        let blend = CIFilter.blendWithMask()
        blend.inputImage = src
        blend.backgroundImage = background
        blend.maskImage = maskImage
        guard let out = blend.outputImage, let buffer = makeBuffer(size: extent.size) else { return frame }
        context.render(out, to: buffer)
        processed += 1
        return buffer
    }

    static func aspectFill(_ img: CIImage, in rect: CGRect) -> CIImage {
        let e = img.extent
        guard e.width > 0, e.height > 0 else { return img }
        let s = max(rect.width / e.width, rect.height / e.height)
        let scaled = img.transformed(by: CGAffineTransform(translationX: -e.minX, y: -e.minY).concatenating(.init(scaleX: s, y: s)))
        return scaled.transformed(by: .init(translationX: (rect.width - e.width * s) / 2, y: (rect.height - e.height * s) / 2)).cropped(to: rect)
    }

    private func makeBuffer(size: CGSize) -> CVPixelBuffer? {
        if pool == nil || poolSize != size {
            let attrs: [String: Any] = [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: Int(size.width),
                kCVPixelBufferHeightKey as String: Int(size.height),
                kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any],
                kCVPixelBufferMetalCompatibilityKey as String: true,
            ]
            var p: CVPixelBufferPool?
            CVPixelBufferPoolCreate(nil, [kCVPixelBufferPoolMinimumBufferCountKey as String: 6] as CFDictionary, attrs as CFDictionary, &p)
            pool = p
            poolSize = size
        }
        guard let pool else { return nil }
        var out: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, pool, &out)
        return out
    }
}
