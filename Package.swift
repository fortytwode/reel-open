// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Reel",
    platforms: [.macOS(.v15)],
    products: [
        .executable(name: "Reel", targets: ["Reel"]),
        .library(name: "ReelCore", targets: ["ReelCore"]),
    ],
    dependencies: [
        // In-app auto-updates (Sparkle 2, EdDSA-signed appcast). See docs/RELEASING.md.
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.7.0"),
    ],
    targets: [
        // Pure logic (no AppKit/AVFoundation): models, share links, Storage requests,
        // transcript formatting, device defaults, pause time-shift, geometry. Unit-tested.
        .target(name: "ReelCore", path: "Sources/ReelCore"),
        // The menu bar app: ScreenCaptureKit + AVFoundation capture, compositing,
        // encoding, transcription, upload, windows.
        .executableTarget(
            name: "Reel",
            dependencies: [
                "ReelCore",
                .product(name: "Sparkle", package: "Sparkle"),
            ],
            path: "Sources/Reel",
            linkerSettings: [
                // scripts/build-app.sh embeds Sparkle.framework in Contents/Frameworks.
                .unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"]),
                // On-device AI summaries; weak so the app still launches on macOS 15.
                .unsafeFlags(["-Xlinker", "-weak_framework", "-Xlinker", "FoundationModels"]),
                .linkedFramework("Vision"),
                .linkedFramework("AVKit"),
                .linkedFramework("AppKit"),
                .linkedFramework("EventKit"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("CoreImage"),
                .linkedFramework("Speech"),
                .linkedFramework("Carbon"),
                .linkedFramework("UserNotifications"),
                .linkedFramework("AuthenticationServices"),
                .linkedFramework("Security"),
                .linkedFramework("ServiceManagement"),
            ]
        ),
        .testTarget(name: "ReelCoreTests", dependencies: ["ReelCore"], path: "Tests/ReelCoreTests"),
    ],
    swiftLanguageModes: [.v5]
)
