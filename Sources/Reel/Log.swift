import os

enum Log {
    static let subsystem = "com.rocketshiphq.reel"
    static let app = Logger(subsystem: subsystem, category: "app")
    static let capture = Logger(subsystem: subsystem, category: "capture")
    static let writer = Logger(subsystem: subsystem, category: "writer")
    static let speech = Logger(subsystem: subsystem, category: "speech")
    static let cloud = Logger(subsystem: subsystem, category: "cloud")
}
