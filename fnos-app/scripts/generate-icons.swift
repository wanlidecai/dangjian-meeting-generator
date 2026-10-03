#!/usr/bin/env swift
// Render standard document paths as sRGB PNG icons; requires macOS AppKit.
import AppKit
import Foundation

let project = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
    .deletingLastPathComponent().deletingLastPathComponent()

func color(_ value: UInt32) -> NSColor {
    NSColor(srgbRed: CGFloat((value >> 16) & 255) / 255,
            green: CGFloat((value >> 8) & 255) / 255,
            blue: CGFloat(value & 255) / 255, alpha: 1)
}

func rounded(_ rect: NSRect, _ radius: CGFloat, _ value: UInt32) {
    color(value).setFill()
    NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
}

func polygon(_ points: [NSPoint], _ value: UInt32) {
    let path = NSBezierPath()
    path.move(to: points[0])
    points.dropFirst().forEach { path.line(to: $0) }
    path.close()
    color(value).setFill()
    path.fill()
}

func line(_ from: NSPoint, _ to: NSPoint, _ width: CGFloat, _ value: UInt32) {
    let path = NSBezierPath()
    path.lineWidth = width
    path.lineCapStyle = .round
    path.move(to: from)
    path.line(to: to)
    color(value).setStroke()
    path.stroke()
}

func render(_ size: Int) throws -> Data {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
                                  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                  isPlanar: false, colorSpaceName: .deviceRGB,
                                  bytesPerRow: 0, bitsPerPixel: 0)!
    bitmap.size = NSSize(width: size, height: size)
    NSGraphicsContext.saveGraphicsState()
    let context = NSGraphicsContext(bitmapImageRep: bitmap)!
    NSGraphicsContext.current = context
    context.cgContext.setShouldAntialias(true)
    context.cgContext.scaleBy(x: CGFloat(size) / 256, y: CGFloat(size) / 256)
    rounded(NSRect(x: 21, y: 19, width: 214, height: 214), 52, 0x8D1F29)
    rounded(NSRect(x: 21, y: 24, width: 214, height: 214), 52, 0xBE2E3C)
    polygon([NSPoint(x: 64, y: 51), NSPoint(x: 195, y: 51), NSPoint(x: 195, y: 174),
             NSPoint(x: 158, y: 211), NSPoint(x: 64, y: 211)], 0xFFF9EF)
    polygon([NSPoint(x: 158, y: 211), NSPoint(x: 158, y: 174), NSPoint(x: 195, y: 174)], 0xE7C398)
    var points: [NSPoint] = []
    for index in 0..<10 {
        let angle = CGFloat.pi / 2 + CGFloat(index) * CGFloat.pi / 5
        let radius: CGFloat = index % 2 == 0 ? 19 : 8
        points.append(NSPoint(x: 102 + cos(angle) * radius, y: 172 + sin(angle) * radius))
    }
    polygon(points, 0xD39A35)
    line(NSPoint(x: 132, y: 169), NSPoint(x: 149, y: 169), 8, 0xBE2E3C)
    line(NSPoint(x: 85, y: 136), NSPoint(x: 173, y: 136), 8, 0xC96460)
    line(NSPoint(x: 85, y: 111), NSPoint(x: 173, y: 111), 8, 0xC96460)
    line(NSPoint(x: 85, y: 86), NSPoint(x: 141, y: 86), 8, 0xC96460)
    NSGraphicsContext.restoreGraphicsState()
    guard let data = bitmap.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "DangjianRecorderIcons", code: 1)
    }
    return data
}

for size in [64, 256] {
    let data = try render(size)
    try data.write(to: project.appendingPathComponent(size == 64 ? "ICON.PNG" : "ICON_256.PNG"))
    let ui = project.appendingPathComponent("app/ui/images/icon_\(size).png")
    try FileManager.default.createDirectory(at: ui.deletingLastPathComponent(), withIntermediateDirectories: true)
    try data.write(to: ui)
}
