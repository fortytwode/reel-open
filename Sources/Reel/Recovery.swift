import Foundation
import ReelCore

/// Crash recovery (Loom: RecordingManifest + RecoveryManager). A recording's manifest says
/// `captureState: recording` until capture ends, and every finished 4 s segment is already on
/// disk (and usually uploaded), so after a crash, force quit or power loss the next launch
/// rebuilds video.mp4 from the segments (losing at most the last few seconds), then finishes the
/// transcript and the upload as if the recording had been stopped normally.
@MainActor
enum Recovery {
    struct Outcome: Sendable {
        var recovered: [String] = []     // recording ids rebuilt or finished
        var discarded: [String] = []
        var failed: [String: String] = [:]
    }

    static func run() async -> Outcome {
        let model = AppModel.shared
        model.reloadLibrary()
        var outcome = Outcome()
        for r in model.recordings where r.discardRequested == true || r.captureState == .recording || r.captureState == .finalizing {
            // Each app recovers only its own kind, and never a recording another
            // Reel process is still capturing.
            guard ProductOwnership.owns(r), !model.library.isCaptureLive(r.id) else { continue }
            if r.discardRequested == true {
                await Publisher.shared.delete(r)
                if model.recording(id: r.id) == nil { outcome.discarded.append(r.id) }
                continue
            }
            let folder = model.library.folder(for: r)
            let segDir = folder.appendingPathComponent(SegmentLog.directoryName, isDirectory: true)
            let files = (try? FileManager.default.contentsOfDirectory(atPath: segDir.path)) ?? []
            var log = SegmentUploader.combinedLog(directory: segDir) ?? SegmentLog()
            log.hasInit = log.hasInit || files.contains(RemoteFile.initSegment.rawValue)
            log.adopt(segmentFileNames: files, fallbackDuration: SegmentedWriter.segmentInterval)
            let hasVideo = FileManager.default.fileExists(atPath: model.library.videoURL(for: r).path)
            let plan = RecoveryPlan.decide(captureState: r.captureState, hasVideo: hasVideo, hasInitSegment: log.hasInit, segmentCount: log.segments.count)
            Log.app.info("Recovery of \(r.folderName, privacy: .public): \(String(describing: plan), privacy: .public)")
            switch plan {
            case .none:
                continue
            case .discard:
                await Publisher.shared.delete(r)
                outcome.discarded.append(r.id)
            case .rebuildFromSegments, .finishProcessing:
                do {
                    if plan == .rebuildFromSegments {
                        log.ended = true
                        if let data = try? JSONEncoder().encode(log) { try? data.write(to: segDir.appendingPathComponent(SegmentLog.fileName), options: .atomic) }
                        try await RecorderController.shared.finalizeLocal(r, log: log, segments: segDir, recovered: true)
                    } else {
                        let video = model.library.videoURL(for: r)
                        let duration = await PostProcessor.duration(of: video)
                        guard duration.isFinite, duration > 0 else {
                            throw CocoaError(.fileReadCorruptFile)
                        }
                        let hasThumbnail = r.hasThumbnail ? true : await PostProcessor.makeThumbnail(
                            video: video, to: model.library.thumbnailURL(for: r))
                        try model.updateCapture(r, state: .recovered, duration: duration, hasThumbnail: hasThumbnail)
                    }
                    guard var saved = model.recording(id: r.id) else { continue }
                    if saved.transcriptStatus == .pending || saved.transcriptStatus == .failed {
                        saved.transcriptStatus = .pending
                        model.update(saved)
                        _ = Publisher.shared.transcribe(saved)
                    }
                    if saved.allowsAutomaticCloudDelivery, model.settings.autoUpload, saved.upload != .localOnly {
                        Publisher.shared.publish(saved, copyLink: false)
                    }
                    outcome.recovered.append(r.id)
                } catch {
                    outcome.failed[r.id] = error.localizedDescription
                    model.captureSaveErrors[r.id] = error.localizedDescription
                    Log.app.error("Recovery failed for \(r.folderName, privacy: .public): \(error.localizedDescription, privacy: .public)")
                }
            }
        }
        model.recoveredCount = outcome.recovered.count
        if !outcome.recovered.isEmpty {
            Notifier.post(title: "Recording recovered", body: "Reel rebuilt \(outcome.recovered.count) recording\(outcome.recovered.count == 1 ? "" : "s") that didn't finish. It's in the Library.", url: nil)
            Toast.show("Recovered \(outcome.recovered.count) interrupted recording\(outcome.recovered.count == 1 ? "" : "s")")
        }
        return outcome
    }
}
