#!/usr/bin/env swift
// Draws Reel's app icons (original artwork). Reel Recorder: a coral rounded square with a white
// record ring. Reel Notetaker: a teal rounded square with white note lines.
import AppKit
import Foundation

guard (2...3).contains(CommandLine.arguments.count) else {
    fputs("Usage: make-icon.swift OUTPUT.iconset [recorder|notetaker]\n", stderr)
    exit(2)
}
let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

let notetaker = CommandLine.arguments.count == 3 && CommandLine.arguments[2] == "notetaker"
let coral = notetaker ? NSColor(calibratedRed: 0.13, green: 0.60, blue: 0.50, alpha: 1) : NSColor(calibratedRed: 0.91, green: 0.33, blue: 0.24, alpha: 1)
let deep = notetaker ? NSColor(calibratedRed: 0.06, green: 0.36, blue: 0.33, alpha: 1) : NSColor(calibratedRed: 0.62, green: 0.16, blue: 0.13, alpha: 1)

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
    if notetaker {
        // Three note lines, the last one shorter, like a page of notes.
        NSColor.white.setFill()
        let height = s * 0.075, left = s * 0.29, gap = s * 0.155
        for (index, width) in [0.42, 0.42, 0.26].enumerated() {
            let line = NSRect(x: left, y: s * 0.615 - CGFloat(index) * gap, width: s * CGFloat(width), height: height)
            NSBezierPath(roundedRect: line, xRadius: height / 2, yRadius: height / 2).fill()
        }
        NSGraphicsContext.restoreGraphicsState()
        return rep.representation(using: .png, properties: [:])!
    }
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
