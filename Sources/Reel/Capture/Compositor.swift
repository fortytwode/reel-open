import CoreImage
import CoreImage.CIFilterBuiltins
import CoreVideo
import Metal

/// Composites each output frame on the GPU: the latest screen frame scaled to the output size,
/// plus the latest camera frame as a circular, mirrored bubble. Loom records the camera as a
/// separate track and composites at playback/server side; Reel bakes it in so a single MP4
/// plays anywhere with a plain <video> tag.
final class Compositor: @unchecked Sendable {
    private let context: CIContext
    private let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

    init() {
        if let device = MTLCreateSystemDefaultDevice() {
            context = CIContext(mtlDevice: device, options: [.workingColorSpace: colorSpace, .cacheIntermediates: false])
        } else {
            context = CIContext(options: [.workingColorSpace: colorSpace])
        }
    }

    /// - bubble: bubble rect in output pixels, origin bottom-left (Core Image space).
    /// - overlays: annotation/click images already in output pixel space, drawn above the
    ///   screen and below the bubble (Loom draws annotations over the content, not the camera).
    func render(screen: CVPixelBuffer?, camera: CVPixelBuffer?, bubble: CGRect?, cameraOnly: Bool, overlays: [CIImage] = [], into output: CVPixelBuffer) {
        let size = CGSize(width: CVPixelBufferGetWidth(output), height: CVPixelBufferGetHeight(output))
        let canvas = CGRect(origin: .zero, size: size)
        var image = CIImage(color: .black).cropped(to: canvas)

        if cameraOnly {
            if let camera { image = aspectFill(mirrored(CIImage(cvPixelBuffer: camera)), in: canvas).composited(over: image) }
        } else {
            if let screen {
                let s = CIImage(cvPixelBuffer: screen)
                image = aspectFit(s, in: canvas).composited(over: image)
            }
            for o in overlays { image = o.composited(over: image) }
            if let camera, let bubble, bubble.width > 4 {
                image = composeBubble(camera: CIImage(cvPixelBuffer: camera), rect: bubble.integral, over: image)
            }
        }
        context.render(image.cropped(to: canvas), to: output, bounds: canvas, colorSpace: colorSpace)
    }

    private func mirrored(_ img: CIImage) -> CIImage {
        img.transformed(by: CGAffineTransform(scaleX: -1, y: 1).translatedBy(x: -img.extent.width, y: 0))
    }

    private func aspectFit(_ img: CIImage, in rect: CGRect) -> CIImage {
        let e = img.extent
        guard e.width > 0, e.height > 0 else { return img }
        if abs(e.width - rect.width) < 1, abs(e.height - rect.height) < 1 { return img.transformed(by: .init(translationX: -e.minX, y: -e.minY)) }
        let scale = min(rect.width / e.width, rect.height / e.height)
        let scaled = img.transformed(by: CGAffineTransform(translationX: -e.minX, y: -e.minY).concatenating(.init(scaleX: scale, y: scale)))
        return scaled.transformed(by: .init(translationX: (rect.width - e.width * scale) / 2, y: (rect.height - e.height * scale) / 2))
    }

    private func aspectFill(_ img: CIImage, in rect: CGRect) -> CIImage {
        let e = img.extent
        guard e.width > 0, e.height > 0 else { return img }
        let scale = max(rect.width / e.width, rect.height / e.height)
        let scaled = img.transformed(by: CGAffineTransform(translationX: -e.minX, y: -e.minY).concatenating(.init(scaleX: scale, y: scale)))
        return scaled.transformed(by: .init(translationX: (rect.width - e.width * scale) / 2, y: (rect.height - e.height * scale) / 2)).cropped(to: rect)
    }

    private func composeBubble(camera: CIImage, rect: CGRect, over base: CIImage) -> CIImage {
        let cam = mirrored(camera)
        let e = cam.extent
        let side = min(e.width, e.height)
        let square = cam.cropped(to: CGRect(x: e.minX + (e.width - side) / 2, y: e.minY + (e.height - side) / 2, width: side, height: side))
        let scale = rect.width / side
        let placed = square
            .transformed(by: CGAffineTransform(translationX: -square.extent.minX, y: -square.extent.minY))
            .transformed(by: .init(scaleX: scale, y: scale))
            .transformed(by: .init(translationX: rect.minX, y: rect.minY))
        let r = rect.width / 2
        let center = CIVector(x: rect.midX, y: rect.midY)
        let mask = CIFilter.radialGradient()
        mask.center = CGPoint(x: center.x, y: center.y)
        mask.radius0 = Float(r - 1.5)
        mask.radius1 = Float(r)
        mask.color0 = .white
        mask.color1 = CIColor(red: 0, green: 0, blue: 0, alpha: 0)
        // Soft shadow under the bubble for legibility over light content.
        let shadowMask = CIFilter.radialGradient()
        shadowMask.center = CGPoint(x: rect.midX, y: rect.midY - r * 0.04)
        shadowMask.radius0 = Float(r * 0.96)
        shadowMask.radius1 = Float(r * 1.08)
        shadowMask.color0 = CIColor(red: 0, green: 0, blue: 0, alpha: 0.35)
        shadowMask.color1 = CIColor(red: 0, green: 0, blue: 0, alpha: 0)
        let withShadow = shadowMask.outputImage!.cropped(to: rect.insetBy(dx: -r * 0.2, dy: -r * 0.2)).composited(over: base)
        let blend = CIFilter.blendWithAlphaMask()
        blend.inputImage = placed
        blend.backgroundImage = withShadow
        blend.maskImage = mask.outputImage!.cropped(to: rect)
        return blend.outputImage ?? base
    }
}
