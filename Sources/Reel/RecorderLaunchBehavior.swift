import AppKit
import Carbon

enum RecorderLaunchBehavior {
    static func opensRecorder(for event: NSAppleEventDescriptor?, arguments: [String]) -> Bool {
        if arguments.contains("--background") || event?.eventID == AEEventID(kAEGetURL) { return false }
        if event?.eventID == AEEventID(kAEOpenApplication) {
            let reason = event?.paramDescriptor(forKeyword: AEKeyword(keyAEPropData))?.enumCodeValue
            if reason == OSType(keyAELaunchedAsLogInItem) || reason == OSType(keyAELaunchedAsServiceItem) { return false }
        }
        return true
    }
}
