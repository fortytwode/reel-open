#!/usr/bin/env swift
// Draws Reel's app icon (original artwork: a coral rounded square with a white record ring).
import AppKit
import Foundation

guard CommandLine.arguments.count == 2 else {
    fputs("Usage: make-icon.swift OUTPUT.iconset\n", stderr)
    exit(2)
}
let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

let coral = NSColor(calibratedRed: 0.91, green: 0.33, blue: 0.24, alpha: 1)
let deep = NSColor(calibratedRed: 0.62, green: 0.16, blue: 0.13, alpha: 1)

func makeIcon(_ pixels: Int) -> Data {
    let s = CGFloat(pixels)
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let inset = s * 0.09
    let body = NSRect(x: inset, y: inset, width: s - 2 * inset, height: s - 2 * inset)
    let path = NSBezierPath(roundedRect: body, xRadius: s * 0.2, yRadius: s * 0.2)
    NSGradient(starting: coral, ending: deep)!.draw(in: path, angle: -90)
    let ring = s * 0.46
    let ringRect = NSRect(x: (s - ring) / 2, y: (s - ring) / 2, width: ring, height: ring)
    NSColor.white.setStroke()
    let ringPath = NSBezierPath(ovalIn: ringRect)
    ringPath.lineWidth = s * 0.055
    ringPath.stroke()
    let dot = s * 0.22
    NSColor.white.setFill()
    NSBezierPath(ovalIn: NSRect(x: (s - dot) / 2, y: (s - dot) / 2, width: dot, height: dot)).fill()
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

for base in [16, 32, 128, 256, 512] {
    try makeIcon(base).write(to: output.appendingPathComponent("icon_\(base)x\(base).png"))
    try makeIcon(base * 2).write(to: output.appendingPathComponent("icon_\(base)x\(base)@2x.png"))
}
