import AppKit

// Command-line verification helpers run without the menu bar UI (see CLI.swift / README).
if let exitCode = CLI.handleImmediate(CommandLine.arguments) {
    exit(exitCode)
}

let app = NSApplication.shared
let delegate = MainActor.assumeIsolated { AppDelegate() }
let recordTest = CLI.parseRecordTest(CommandLine.arguments)
if CommandLine.arguments.contains("--record-test"), recordTest == nil {
    FileHandle.standardError.write(Data("Invalid --record-test arguments. See Reel --help.\n".utf8))
    exit(2)
}
MainActor.assumeIsolated { delegate.cliRecordTest = recordTest }
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
