import AppKit
import ReelCore

/// Everything remote: live segment upload while recording, the follow-up uploads (MP4,
/// thumbnail, transcript, AI summary, trimmed copy), share settings (password, expiry), view
/// counts, rename and delete. The share ID binds to the publisher before the first upload, and segments
/// stream up during capture, so the link is copied the moment recording stops and plays
/// within seconds (Loom: StartNewRecordingSession up front + live part uploads).
@MainActor
final class Publisher {
    static let shared = Publisher()
    private var model: AppModel { AppModel.shared }
    private var library: LibraryStore { model.library }
    private var uploads: [String: Task<Void, Never>] = [:]
    private var transcriptions: [String: Task<Void, Never>] = [:]
    private var deliveries: [String: Task<Void, Never>] = [:]
    private var deleting = Set<String>()
    private var accessUpdates = Set<String>()
    private var titleUpdates: [String: Task<Void, Never>] = [:]
    private var liveStarts: [String: Task<SegmentUploader?, Never>] = [:]
    private var liveFinish: [String: Task<Bool, Never>] = [:]
    /// Seconds from "stop" to the final playlist + ready meta being uploaded, per recording id.
    private(set) var stopToPlayable: [String: Double] = [:]

    static var appVersion: String {
        "Reel \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev")"
    }

    func segmentsDirectory(_ r: Recording) -> URL { library.folder(for: r).appendingPathComponent(SegmentLog.directoryName, isDirectory: true) }

    /// Backfills recordings uploaded by earlier app versions. No local-only video is listed.
    func syncCloudLibrary() async {
        guard let cloud = try? await CloudAuth.shared.validSession() else { return }
        do {
            let client = FirestoreClient(cloud: cloud)
            for r in model.recordings where r.allowsAutomaticCloudDelivery && r.upload == .uploaded {
                if try await client.ownsRoom(r.room) { try await client.upsertLibraryEntry(r) }
            }
        } catch {
            model.lastError = error.localizedDescription
            Toast.show("Online library sync failed. Reopen Reel to retry. \(error.localizedDescription)", isError: true)
        }
    }

    // MARK: Live upload

    /// Called when capture starts. Publishes a "recording" meta and returns an uploader the
    /// writer feeds; nil when live upload is off or the user isn't signed in.
    func beginLive(_ recording: Recording) -> Task<SegmentUploader?, Never> {
        let task = Task { await makeLiveUploader(recording) }
        liveStarts[recording.id] = task
        return task
    }

    func cancelLiveStart(for id: String) async {
        guard let start = liveStarts[id] else { return }
        start.cancel()
        if let uploader = await start.value { await uploader.cancel() }
        liveStarts[id] = nil
    }

    private func makeLiveUploader(_ r: Recording) async -> SegmentUploader? {
        guard r.allowsAutomaticCloudDelivery, model.settings.autoUpload, model.settings.liveUpload, let cloud = try? await CloudAuth.shared.validSession() else { return nil }
        guard !Task.isCancelled, !deleting.contains(r.id), var r = model.recording(id: r.id),
              r.allowsAutomaticCloudDelivery else { return nil }
        do { try prepareForPublication(&r, cloud: cloud) } catch {
            Log.cloud.error("Live upload disabled: \(error.localizedDescription, privacy: .public)")
            return nil
        }
        r.upload = .uploading
        model.update(r)
        let client = StorageClient(session: cloud)
        do {
            try await uploadMeta(r, status: "recording", client: client, owner: owner(cloud))
        } catch {
            Log.cloud.error("Live upload disabled: \(error.localizedDescription, privacy: .public)")
            r = model.recording(id: r.id) ?? r
            // A lost response may have left a remote copy for Discard to clean up.
            r.upload = .failed(error.localizedDescription)
            model.update(r)
            return nil
        }
        try? await FirestoreClient(cloud: cloud).ensureRoom(r.room, createdAt: r.createdAt,
            expiresAt: r.access.expiresAt, recordingNonce: r.recordingNonce)
        return SegmentUploader(shareID: r.shareID, ownerUID: cloud.userID, directory: segmentsDirectory(r), location: r.location, expiresAt: r.access.expiresAt, recordingNonce: r.recordingNonce)
    }

    /// Called right after capture stops: uploads the last segments and the final playlist and
    /// flips meta to ready, so the link plays. Returns whether the HLS copy is complete.
    @discardableResult
    func finishLive(_ recording: Recording, uploader: SegmentUploader, log: SegmentLog, stoppedAt: Date) -> Task<Bool, Never> {
        let id = recording.id
        guard recording.allowsAutomaticCloudDelivery, !deleting.contains(id) else { return Task { false } }
        let task = Task { @MainActor () -> Bool in
            defer { self.liveFinish[id] = nil }
            do {
                try await uploader.finish(log: log)
                guard !Task.isCancelled, !self.deleting.contains(id), var r = self.model.recording(id: id) else { return false }
                r.playback.hls = true
                r.durationSeconds = max(r.durationSeconds, log.totalDuration)
                self.model.update(r)
                let cloud = try await CloudAuth.shared.validSession()
                try self.requirePublisher(r, cloud: cloud)
                try await self.uploadMeta(r, status: "ready", client: StorageClient(session: cloud), owner: self.owner(cloud))
                try await FirestoreClient(cloud: cloud).upsertLibraryEntry(r)
                let elapsed = Date().timeIntervalSince(stoppedAt)
                self.stopToPlayable[id] = elapsed
                Log.cloud.info("Link playable \(elapsed, format: .fixed(precision: 2)) s after stop (\(log.segments.count) segments)")
                if self.model.settings.copyLinkOnStop { Notifier.post(title: "Video ready", body: r.title, url: r.shareURL()) }
                return true
            } catch {
                await uploader.cancel()
                Log.cloud.error("Finishing live upload failed: \(error.localizedDescription, privacy: .public)")
                return false
            }
        }
        liveFinish[id] = task
        liveStarts[id] = nil
        return task
    }

    func clearFinishedLiveStart(for id: String) {
        liveStarts[id] = nil
    }

    // MARK: Transcript + AI summary

    func cancelMeetingProcessing() {
        for r in model.recordings where r.isMeeting {
            transcriptions[r.id]?.cancel()
            deliveries[r.id]?.cancel()
        }
    }

    /// Explicit Library action; background processing never claims ownerless meeting audio.
    func transcribeByUser(_ recording: Recording) {
        Task { @MainActor in
            let id = recording.id
            guard !deleting.contains(id), transcriptions[id] == nil, deliveries[id] == nil,
                  var current = model.recording(id: id) else { return }
            if current.isMeeting {
                do {
                    let account = try await CloudAuth.shared.validSession()
                    guard !deleting.contains(id), transcriptions[id] == nil, deliveries[id] == nil,
                          model.account?.userID == account.userID, let latest = model.recording(id: id),
                          latest.meeting != nil,
                          latest.meeting?.ownerUserID == nil || latest.meeting?.ownerUserID == account.userID else { return }
                    current = latest
                    current.meeting?.ownerUserID = account.userID
                    if current.meeting?.needsContentReview == true, current.meeting?.deliveryStatus != nil {
                        current.meeting?.deliveryStatus = .pending
                        current.meeting?.deliveryRetryAt = nil
                        current.meeting?.deliveryError = nil
                    }
                    current.meeting?.summaryReviewPassed = nil
                    current.transcriptStatus = .pending
                    try model.saveRecording(current)
                } catch { Toast.show(error.localizedDescription, isError: true); return }
            } else {
                current.transcriptStatus = .pending
                model.update(current)
            }
            _ = transcribe(current)
        }
    }

    func transcribe(_ recording: Recording) -> Task<Void, Never> {
        if deleting.contains(recording.id) { return Task {} }
        if let t = transcriptions[recording.id] { return t }
        let id = recording.id
        let task = Task { @MainActor in
            defer { self.transcriptions[id] = nil }
            guard var r = self.model.recording(id: id) else { return }
            let meetingOwner = r.meeting?.ownerUserID
            let accountGeneration = self.model.accountGeneration
            var transcript: Transcript?
            do {
                let out: TranscriptionService.Output
                if let meeting = r.meeting {
                    out = try await CloudMeetingSpeech.transcribe(video: self.library.videoURL(for: r), meeting: meeting,
                                                                  title: r.title, localeIdentifier: self.model.settings.transcriptionLocaleIdentifier)
                } else {
                    out = try await TranscriptionService.transcribe(video: self.library.videoURL(for: r),
                                                                   localeIdentifier: self.model.settings.transcriptionLocaleIdentifier)
                }
                let segments = TranscriptSegmenter.segments(from: out.pieces)
                guard !Task.isCancelled, !self.deleting.contains(id), let current = self.model.recording(id: id),
                      current.meeting?.ownerUserID == meetingOwner,
                      !current.isMeeting || self.model.accountGeneration == accountGeneration else { return }
                r = current
                var t = Transcript(id: r.shareID, title: r.title, language: out.locale, engine: out.engine,
                                   createdAt: Date(), durationSeconds: r.durationSeconds, segments: segments)
                if r.isMeeting { t.timingGranularity = "chunk" }
                try self.writeTranscript(t, for: r)
                r.transcriptStatus = segments.isEmpty ? .none : .ready
                if segments.isEmpty, r.meeting?.deliveryStatus != nil { r.meeting?.deliveryStatus = .noSpeech }
                if r.isMeeting { r.summary = nil; r.summaryEngine = nil; r.meeting?.summaryReviewPassed = nil }
                transcript = t
                Log.speech.info("Transcript: \(segments.count) segments via \(out.engine, privacy: .public)")
            } catch {
                Log.speech.error("Transcription failed")
                guard !Task.isCancelled, !self.deleting.contains(id), let current = self.model.recording(id: id),
                      current.meeting?.ownerUserID == meetingOwner,
                      !current.isMeeting || self.model.accountGeneration == accountGeneration else { return }
                r = current
                r.transcriptStatus = .failed
                if r.isMeeting { Toast.show("Meeting transcription failed: \(error.localizedDescription)", isError: true) }
            }
            self.model.update(r)
            if let transcript, !transcript.segments.isEmpty, (r.isMeeting || self.model.settings.aiSummary) {
                await self.summarize(id: id, transcript: transcript)
            }
            guard !Task.isCancelled, !self.deleting.contains(id), let latest = self.model.recording(id: id),
                  latest.meeting?.ownerUserID == meetingOwner,
                  !latest.isMeeting || self.model.accountGeneration == accountGeneration else { return }
            if latest.isMeeting {
                Task { _ = await MeetingPortalIndex.publish(latest) }
            }
            if latest.meeting?.mayAutomaticallyProcess == true,
               latest.transcriptStatus == .ready, latest.summaryEngine == "OpenAI gpt-6.1-sol" {
                await self.deliverMeeting(latest).value
            }
        }
        transcriptions[id] = task
        return task
    }

    /// Only new recordings or an explicit delivery action enter the automatic queue.
    func resumeMeetingProcessing() {
        guard let owner = model.account?.userID else { return }
        for r in model.recordings where r.canResumeMeetingProcessing(owner: owner) {
            guard transcriptions[r.id] == nil, deliveries[r.id] == nil, !deleting.contains(r.id) else { continue }
            if r.transcriptStatus == .ready {
                deliverMeeting(r)
            } else {
                var next = r
                next.meeting?.deliveryRetryAt = Date().addingTimeInterval(300)
                model.update(next)
                transcribe(next)
            }
        }
    }

    @discardableResult
    func deliverMeeting(_ recording: Recording) -> Task<Void, Never> {
        let id = recording.id
        if let task = deliveries[id] { return task }
        guard !deleting.contains(id), let meeting = model.recording(id: id)?.meeting,
              meeting.deliveryStatus != nil, !meeting.needsContentReview else { return Task {} }
        let task = Task { @MainActor in
            defer { self.deliveries[id] = nil }
            guard let owner = self.model.recording(id: id)?.meeting?.ownerUserID,
                  self.model.account?.userID == owner else { return }
            let generation = self.model.accountGeneration
            @MainActor func current() -> Bool {
                !Task.isCancelled && !self.deleting.contains(id) && self.model.account?.userID == owner &&
                    self.model.accountGeneration == generation &&
                    self.model.recording(id: id)?.meeting?.ownerUserID == owner
            }
            do {
                guard var r = self.model.recording(id: id), current(), r.transcriptStatus == .ready else { return }
                r.meeting?.deliveryStatus = .pending; r.meeting?.deliveryError = nil
                r.meeting?.deliveryRetryAt = Date().addingTimeInterval(300)
                self.model.update(r)
                let transcript = try ReelJSON.decoder.decode(Transcript.self, from: Data(contentsOf: self.library.transcriptJSONURL(for: r)))
                if r.summaryEngine != "OpenAI gpt-6.1-sol" || r.summary == nil || r.meeting?.permitsReviewedDelivery != true {
                    await self.summarize(id: id, transcript: transcript)
                }
                guard current(), var latest = self.model.recording(id: id) else { return }
                guard latest.meeting?.deliveryStatus != .reviewRequired else { return }
                if latest.meeting?.deliveryEnvelope == nil {
                    let envelope = try MeetingDeliveryService.envelope(latest, transcript: transcript)
                    latest.meeting?.deliveryEnvelope = envelope
                    latest.meeting?.recordEnvelopeReview(for: envelope)
                    try self.library.save(latest)
                    self.model.update(latest)
                } else if latest.meeting?.deliveryReceipt == nil && latest.meeting?.deliveryEnvelopePassedReview != true {
                    let reviewedBody = try await MeetingDeliveryService.reviewSavedEnvelope(latest)
                    guard current(), var refreshed = self.model.recording(id: id),
                          refreshed.meeting?.recordEnvelopeReview(for: reviewedBody) == true else { return }
                    try self.library.save(refreshed)
                    self.model.update(refreshed)
                    latest = refreshed
                }
                let receipt = try await MeetingDeliveryService.deliver(latest, transcript: transcript, stillCurrent: current)
                guard current(), var latest = self.model.recording(id: id) else { return }
                latest.meeting?.deliveryReceipt = receipt
                latest.meeting?.deliveryStatus = .confirmed; latest.meeting?.deliveryError = nil
                latest.meeting?.deliveryRetryAt = nil
                self.model.update(latest)
                Toast.show("Notes verified in Notion; recap delivered to \(receipt.recipients.count) internal invitees.")
            } catch {
                guard current(), var latest = self.model.recording(id: id) else { return }
                if error is MeetingSummaryReviewError {
                    self.holdMeetingForReview(&latest)
                    return
                }
                let requiresCalendarSelection = error is MeetingDeliveryService.CalendarSelectionRequired
                latest.meeting?.deliveryStatus = .failed
                latest.meeting?.deliveryError = error.localizedDescription
                latest.meeting?.deliveryRetryAt = requiresCalendarSelection ? .distantFuture : Date().addingTimeInterval(300)
                self.model.update(latest)
                Toast.show(requiresCalendarSelection ? error.localizedDescription : "Meeting delivery needs attention. Your transcript and video are saved.", isError: true)
            }
        }
        deliveries[id] = task
        return task
    }

    func deliverMeetingByUser(_ recording: Recording) {
        if model.recording(id: recording.id)?.meeting?.needsContentReview == true {
            transcribeByUser(recording)
            return
        }
        Task { @MainActor in
            do {
                let account = try await CloudAuth.shared.validSession()
                guard !deleting.contains(recording.id), var r = model.recording(id: recording.id),
                      r.isMeeting, r.meeting?.deliveryStatus != nil, model.account?.userID == account.userID,
                      r.meeting?.ownerUserID == nil || r.meeting?.ownerUserID == account.userID else { return }
                r.meeting?.ownerUserID = account.userID
                r.meeting?.deliveryStatus = .pending; r.meeting?.deliveryRetryAt = nil
                try model.saveRecording(r)
                await deliverMeeting(r).value
            } catch { Toast.show(error.localizedDescription, isError: true) }
        }
    }

    private func writeTranscript(_ t: Transcript, for r: Recording) throws {
        try t.encoded().write(to: library.transcriptJSONURL(for: r), options: .atomic)
        try Data(t.plainText().utf8).write(to: library.transcriptTextURL(for: r), options: .atomic)
    }

    /// Title (unless the user renamed it), summary and chapters from the transcript.
    func summarize(id: String, transcript: Transcript) async {
        guard !Task.isCancelled, !deleting.contains(id), let r0 = model.recording(id: id) else { return }
        let generation = model.accountGeneration
        let ai: AISummary
        if let meeting = r0.meeting {
            do {
                ai = try await CloudMeetingSpeech.summarize(transcript: transcript, meeting: meeting, title: r0.title)
            } catch {
                guard !Task.isCancelled, !deleting.contains(id), model.accountGeneration == generation,
                      var current = model.recording(id: id), current.meeting?.ownerUserID == meeting.ownerUserID else { return }
                if error is MeetingSummaryReviewError {
                    holdMeetingForReview(&current)
                    return
                }
                Toast.show("Meeting summary failed: \(error.localizedDescription)", isError: true)
                return
            }
        } else {
            ai = await SummaryService.summarize(transcript: transcript, duration: r0.durationSeconds)
        }
        guard !Task.isCancelled, !deleting.contains(id), var r = model.recording(id: id),
              r.meeting?.ownerUserID == r0.meeting?.ownerUserID,
              !r.isMeeting || model.accountGeneration == generation else { return }
        if !r.titleIsCustom, let title = ai.title, let clean = Recording.cleanTitle(title) {
            r.title = clean
            var t = transcript
            t.title = clean
            try? writeTranscript(t, for: r)
        }
        r.summary = ai.summary
        r.chapters = ai.chapters.isEmpty ? nil : ai.chapters
        r.summaryEngine = ai.engine
        if r.isMeeting { r.meeting?.summaryReviewPassed = true }
        model.update(r)
        Log.app.info("Summary via \(ai.engine, privacy: .public): \(ai.chapters.count) chapters")
    }

    private func holdMeetingForReview(_ recording: inout Recording) {
        // Retain the transcript, video and any immutable outbound body. A legacy
        // recording with no delivery opt-in must remain outside the delivery queue.
        if recording.meeting?.deliveryStatus != nil { recording.meeting?.deliveryStatus = .reviewRequired }
        recording.meeting?.summaryReviewPassed = false
        recording.meeting?.deliveryRetryAt = nil
        recording.meeting?.deliveryError = MeetingSummaryReviewError.required.localizedDescription
        recording.summary = nil; recording.summaryEngine = nil
        model.update(recording)
        Toast.show("Meeting transcript saved for review. Automatic notes delivery is paused.")
    }

    // MARK: Publish (idempotent)

    struct MeetingShareConsent {
        let ownerUID: String
        let accountGeneration: UInt64
    }

    func meetingShareConsent() -> MeetingShareConsent? {
        model.account.map { MeetingShareConsent(ownerUID: $0.userID, accountGeneration: model.accountGeneration) }
    }

    /// Uploads whatever is missing at the recording's location: finishes the HLS copy (open
    /// recordings), the MP4, thumbnail, transcript, trimmed copy, room and meta. Safe to call
    /// again to retry.
    @discardableResult
    func publish(_ recording: Recording, copyLink: Bool, meetingConsent: MeetingShareConsent? = nil) -> Task<Void, Never> {
        guard !accessUpdates.contains(recording.id) else { return Task {} }
        return startPublish(recording, copyLink: copyLink, meetingConsent: meetingConsent)
    }

    private func startPublish(_ recording: Recording, copyLink: Bool, meetingConsent: MeetingShareConsent?) -> Task<Void, Never> {
        let current = model.recording(id: recording.id) ?? recording
        guard !deleting.contains(recording.id), current.permitsPublishing(allowMeetingShare: meetingConsent != nil) else { return Task {} }
        if let t = uploads[recording.id] { return t }
        let id = recording.id
        let task = Task { @MainActor in
            defer { self.uploads[id] = nil; self.model.uploadProgress[id] = nil }
            _ = await self.liveFinish[id]?.value
            await self.titleUpdates[id]?.value
            guard var r = self.model.recording(id: id), r.permitsPublishing(allowMeetingShare: meetingConsent != nil) else { return }
            let cloud: CloudSession
            do { cloud = try await CloudAuth.shared.validSession() } catch {
                if r.isMeeting {
                    Toast.show(error.localizedDescription, isError: true)
                    return
                }
                r.upload = .localOnly
                self.model.update(r)
                if copyLink {
                    Notifier.post(title: "Recording saved", body: "Saved on this Mac. Sign in with Google in Reel Settings to get a share link.", url: nil)
                    Toast.show("Saved locally · sign in to share")
                }
                return
            }
            guard let current = self.model.recording(id: id), current.permitsPublishing(allowMeetingShare: meetingConsent != nil) else { return }
            r = current
            do {
                if r.isMeeting {
                    guard let meetingConsent, meetingConsent.ownerUID == cloud.userID,
                          await CloudAuth.shared.current?.userID == cloud.userID,
                          self.model.account?.userID == cloud.userID,
                          self.model.accountGeneration == meetingConsent.accountGeneration else {
                        throw LibraryStore.IdentityError.meetingShareConsentRequired
                    }
                }
                try self.prepareForPublication(&r, cloud: cloud, meetingConsentUID: meetingConsent?.ownerUID)
                r.upload = .uploading
                try self.model.saveRecording(r)
            } catch {
                Toast.show(error.localizedDescription, isError: true)
                return
            }
            self.model.uploadProgress[id] = 0
            do {
                try await self.sync(r, cloud: cloud, copyLink: copyLink)
                r = self.model.recording(id: id) ?? r
                r.upload = .uploaded
                self.model.update(r)
                if r.isMeeting {
                    let sharedMeeting = r
                    Task { _ = await MeetingPortalIndex.publish(sharedMeeting) }
                    if copyLink { self.copyLinkToClipboard(r, openPage: true) }
                }
                if copyLink && !r.playback.hls { Notifier.post(title: "Video ready", body: r.title, url: r.shareURL()) }
            } catch {
                Log.cloud.error("Upload failed: \(error.localizedDescription, privacy: .public)")
                r = self.model.recording(id: id) ?? r
                r.upload = .failed(error.localizedDescription)
                self.model.update(r)
                Notifier.post(title: "Upload failed", body: "\(r.title) is saved locally. Open the Library to retry. (\(error.localizedDescription))", url: nil)
            }
        }
        uploads[id] = task
        return task
    }

    private func prepareForPublication(_ recording: inout Recording, cloud: CloudSession, meetingConsentUID: String? = nil) throws {
        recording = try model.bindForPublication(recording, ownerUID: cloud.userID, meetingConsentUID: meetingConsentUID)
    }

    private func requirePublisher(_ recording: Recording, cloud: CloudSession) throws {
        guard recording.matchesPublisher(cloud.userID),
              recording.meeting?.ownerUserID == nil || recording.meeting?.ownerUserID == cloud.userID else {
            throw CloudError.permanent("Sign in with the account that owns this recording to update its web share.")
        }
    }

    private func sync(_ recording: Recording, cloud: CloudSession, copyLink: Bool) async throws {
        let id = recording.id
        var r = recording
        try requirePublisher(r, cloud: cloud)
        let client = StorageClient(session: cloud)
        let owner = owner(cloud)
        let loc = r.location
        let opts = StorageRequests.ObjectOptions(expiresAt: r.access.expiresAt, recordingNonce: r.recordingNonce)
        let playable = r.playback.hls || r.playback.mp4
        try await uploadMeta(r, status: playable ? "ready" : "processing", client: client, owner: owner)
        if copyLink { copyLinkToClipboard(r, uploading: !playable, openPage: true) }
        try? await FirestoreClient(cloud: cloud).ensureRoom(r.room, createdAt: r.createdAt, expiresAt: r.access.expiresAt, recordingNonce: r.recordingNonce)

        // HLS copy (open recordings only; protected ones are served as MP4).
        let segDir = segmentsDirectory(r)
        if !loc.isKeyed, let log = SegmentUploader.combinedLog(directory: segDir), log.hasInit, !log.segments.isEmpty,
           !(log.uploadedFinalPlaylist && log.allUploaded && log.uploadedLocation == loc) {
            let uploader = SegmentUploader(shareID: r.shareID, ownerUID: cloud.userID, directory: segDir, location: loc, expiresAt: r.access.expiresAt, recordingNonce: r.recordingNonce)
            try await uploader.finish(log: log)
            r = model.recording(id: id) ?? r
            r.playback.hls = true
            model.update(r)
            try await uploadMeta(r, status: "ready", client: client, owner: owner)
        }

        // Progressive MP4 (downloads + transcript API), always for protected recordings.
        let wantsMP4 = model.settings.uploadMP4 || loc.isKeyed || !r.playback.hls
        if wantsMP4 && !r.playback.mp4 {
            let videoURL = library.videoURL(for: r)
            guard FileManager.default.fileExists(atPath: videoURL.path) else { throw CloudError.message("video.mp4 is missing locally") }
            var mp4Opts = opts
            mp4Opts.contentDisposition = StorageRequests.attachmentDisposition(title: r.title)
            try await client.upload(fileURL: videoURL, shareID: r.shareID, file: .video, location: loc, options: mp4Opts) { p in
                Task { @MainActor in self.model.uploadProgress[id] = p }
            }
            r = model.recording(id: id) ?? r
            r.playback.mp4 = true
            model.update(r)
        }
        r = model.recording(id: id) ?? r
        if r.hasThumbnail, let thumb = try? Data(contentsOf: library.thumbnailURL(for: r)) {
            try await client.upload(data: thumb, shareID: r.shareID, file: .thumbnail, location: loc, options: opts)
        }
        try await uploadMeta(r, status: "ready", client: client, owner: owner)

        // Transcript (+ AI summary) may still be running; the viewer polls for it.
        await transcriptions[id]?.value
        r = model.recording(id: id) ?? r
        try await uploadTranscript(r, client: client)
        try await uploadTrimmedIfNeeded(id: id, client: client)
        r = model.recording(id: id) ?? r
        try await uploadMeta(r, status: "ready", client: client, owner: owner)
        try await FirestoreClient(cloud: cloud).upsertLibraryEntry(r)
    }

    private func uploadTrimmedIfNeeded(id: String, client: StorageClient) async throws {
        guard var r = model.recording(id: id), let trim = r.trim, !r.trimmedUploaded, r.playback.mp4 || r.playback.hls else { return }
        let out = library.folder(for: r).appendingPathComponent("trimmed.mp4")
        try await PostProcessor.exportTrimmed(video: library.videoURL(for: r), trim: trim, to: out)
        try await client.upload(fileURL: out, shareID: r.shareID, file: .trimmed, location: r.location,
                                options: .init(expiresAt: r.access.expiresAt,
                                               contentDisposition: StorageRequests.attachmentDisposition(title: r.title),
                                               recordingNonce: r.recordingNonce)) { _ in }
        r = model.recording(id: id) ?? r
        if r.trim == trim { r.trimmedUploaded = true }
        model.update(r)
    }

    private func uploadTranscript(_ r: Recording, client: StorageClient) async throws {
        guard r.transcriptStatus == .ready else { return }
        let opts = StorageRequests.ObjectOptions(expiresAt: r.access.expiresAt, recordingNonce: r.recordingNonce)
        if var json = try? Data(contentsOf: library.transcriptJSONURL(for: r)) {
            // A transcript produced while signed out may still contain the provisional ID.
            if r.recordingNonce != nil {
                var transcript = try ReelJSON.decoder.decode(Transcript.self, from: json)
                transcript.id = r.shareID
                json = try transcript.encoded()
            }
            try await client.upload(data: json, shareID: r.shareID, file: .transcriptJSON, location: r.location, options: opts)
        }
        if let txt = try? Data(contentsOf: library.transcriptTextURL(for: r)) {
            try await client.upload(data: txt, shareID: r.shareID, file: .transcriptText, location: r.location, options: opts)
        }
    }

    /// meta.json at the recording's location, plus the locked stub for protected recordings.
    func uploadMeta(_ r: Recording, status: String, client: StorageClient, owner: String?) async throws {
        let opts = StorageRequests.ObjectOptions(expiresAt: r.access.expiresAt, recordingNonce: r.recordingNonce)
        let meta = (try? ReelJSON.encoder.encode(RemoteMeta(recording: r, status: status, ownerName: owner, app: Self.appVersion))) ?? Data()
        try await client.upload(data: meta, shareID: r.shareID, file: .meta, location: r.location, options: opts)
        if r.location.isKeyed, let salt = r.access.passwordSalt {
            let stub = try ReelJSON.encoder.encode(LockedStub(shareID: r.shareID, salt: salt, expiresAt: r.access.expiresAt, status: status))
            try await client.upload(data: stub, shareID: r.shareID, file: .meta, location: .open, options: opts)
        }
    }

    private func owner(_ cloud: CloudSession) -> String? { cloud.displayName ?? cloud.email }

    func copyLinkToClipboard(_ r: Recording, uploading: Bool = false, openPage: Bool = false) {
        guard !deleting.contains(r.id), r.discardRequested != true, r.hasPublishableShareID, !r.isMeeting || r.upload == .uploaded else { return }
        let url = r.shareURL().absoluteString
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(url, forType: .string)
        if openPage { NSWorkspace.shared.open(r.shareURL()) }
        if uploading {
            Notifier.post(title: "Link copied", body: "\(url)\nFinishing upload of “\(r.title)”…", url: r.shareURL())
            Toast.show("Link copied · finishing upload…")
        } else {
            Toast.show("Link copied")
        }
    }

    func copyLink(_ r: Recording) { copyLinkToClipboard(r) }

    // MARK: Share settings

    enum PasswordChange: Equatable { case keep, set(String), remove }

    /// Applies a password and/or expiry change. A password change moves the recording to a new
    /// location (re-uploads it there, deletes the old copy, migrates comments); an expiry-only
    /// change patches the metadata of every object (the rules enforce it).
    func updateAccess(_ recording: Recording, password: PasswordChange, expiresAt: Date?) async throws {
        let id = recording.id
        _ = await liveFinish[id]?.value
        await uploads[id]?.value
        await titleUpdates[id]?.value
        // An older writer must finish before we replace the open metadata or remove open files.
        guard var r = model.recording(id: id), r.discardRequested != true, !deleting.contains(id),
              r.captureState == .complete || r.captureState == .recovered,
              liveStarts[id] == nil, liveFinish[id] == nil, uploads[id] == nil, titleUpdates[id] == nil,
              accessUpdates.insert(id).inserted else {
            throw CloudError.message("Wait for this recording to finish saving and try again.")
        }
        defer { accessUpdates.remove(id) }
        let oldAccess = r.access
        var newAccess = r.access
        newAccess.expiresAt = expiresAt
        switch password {
        case .keep: break
        case .remove: newAccess.location = .open; newAccess.passwordSalt = nil
        case .set(let pw):
            guard pw.count >= AccessKey.minimumPasswordLength else { throw CloudError.message("Use at least \(AccessKey.minimumPasswordLength) characters.") }
            let salt = AccessKey.newSalt()
            guard let key = AccessKey.derive(password: pw, saltHex: salt) else { throw CloudError.message("Couldn't derive a key from that password.") }
            newAccess.location = .keyed(key)
            newAccess.passwordSalt = salt
        }
        guard r.upload.mayHaveRemote else {
            r.access = newAccess
            model.update(r)
            return
        }
        let cloud = try await CloudAuth.shared.validSession()
        let meetingConsent = r.isMeeting ? MeetingShareConsent(ownerUID: cloud.userID, accountGeneration: model.accountGeneration) : nil
        if r.isMeeting { try prepareForPublication(&r, cloud: cloud, meetingConsentUID: meetingConsent?.ownerUID) }
        try requirePublisher(r, cloud: cloud)
        let client = StorageClient(session: cloud)
        if newAccess.location == oldAccess.location {
            // Expiry only.
            r.access = newAccess
            model.update(r)
            let files = remoteFiles(r, at: r.location)
            let shareID = r.shareID, location = r.location, recordingNonce = r.recordingNonce
            try await StorageClient.concurrently(files, width: 8) { f in
                try await client.setExpiry(expiresAt, shareID: shareID, file: f, location: location, recordingNonce: recordingNonce)
            }
            if r.location.isKeyed { try await client.setExpiry(expiresAt, shareID: r.shareID, file: .meta, location: .open, recordingNonce: recordingNonce) }
            try await FirestoreClient(cloud: cloud).setExpiry(r.room, expiresAt: expiresAt)
            try await uploadMeta(r, status: "ready", client: client, owner: owner(cloud))
            try await FirestoreClient(cloud: cloud).upsertLibraryEntry(r)
            return
        }
        // Move to the new location: everything is re-uploaded there from the local files.
        let oldRoom = r.room
        let oldFiles = remoteFiles(r, at: oldAccess.location)
        r.access = newAccess
        r.playback = PlaybackState()
        r.trimmedUploaded = false
        r.upload = .pending
        model.update(r)
        if newAccess.location.isKeyed {
            // Hide the old open copy first: the stub replaces the open meta.json right away.
            try await uploadMeta(r, status: "processing", client: client, owner: owner(cloud))
        }
        await startPublish(r, copyLink: false, meetingConsent: meetingConsent).value
        guard let after = model.recording(id: r.id), after.upload == .uploaded else {
            throw CloudError.message("Couldn't upload the recording with its new settings; the old link was left as it was.")
        }
        // Remove the old copy (keeping the open meta.json, which now is the stub or the new meta).
        let stale = oldFiles.filter { !(oldAccess.location == .open && $0 == .meta) }
        try await client.delete(shareID: r.shareID, files: stale, location: oldAccess.location)
        if oldAccess.location == .open {
            // The segments were deleted with the old copy; forget their upload progress.
            try? FileManager.default.removeItem(at: segmentsDirectory(r).appendingPathComponent(SegmentUploader.progressFile))
        }
        try? await FirestoreClient(cloud: cloud).migrate(from: oldRoom, to: after.room, createdAt: r.createdAt, expiresAt: expiresAt, recordingNonce: after.recordingNonce)
    }

    /// Every object a recording may have at `location` (segments only exist for open ones).
    func remoteFiles(_ r: Recording, at location: RemoteLocation) -> [RemoteFile] {
        var files = RemoteFile.fixedFiles
        if !location.isKeyed {
            let count = max(SegmentUploader.loadLog(directory: segmentsDirectory(r))?.segments.count ?? 0,
                            SegmentUploader.loadProgress(directory: segmentsDirectory(r))?.uploaded.max() ?? 0)
            if count > 0 { files += (1...count).map(RemoteFile.segment) }
        }
        return files
    }

    // MARK: Trim

    func setTrim(_ recording: Recording, start: Double, end: Double) {
        guard var r = model.recording(id: recording.id) else { return }
        let trim = TrimRange.normalized(start: start, end: end, duration: r.durationSeconds)
        guard trim != r.trim else { return }
        r.trim = trim
        r.trimmedUploaded = false
        model.update(r)
        if r.allowsAutomaticCloudDelivery && r.upload == .uploaded { publish(r, copyLink: false) }
    }

    /// Exports the trimmed range to a new local file (Library ▸ Export trimmed copy).
    func exportTrimmedCopy(_ r: Recording, to url: URL) async throws {
        guard let trim = r.trim else { throw CloudError.message("Set a trim range first.") }
        try await PostProcessor.exportTrimmed(video: library.videoURL(for: r), trim: trim, to: url)
    }

    // MARK: Views

    func refreshViews(_ r: Recording) async {
        guard r.upload == .uploaded, let cloud = try? await CloudAuth.shared.validSession(),
              let views = try? await FirestoreClient(cloud: cloud).views(r.room), var cur = model.recording(id: r.id) else { return }
        if cur.viewCount != views {
            cur.viewCount = views
            model.update(cur)
        }
    }

    // MARK: Rename / delete

    @discardableResult
    func rename(_ recording: Recording, to newTitle: String) -> Task<Void, Never> {
        let id = recording.id
        guard !deleting.contains(id), !accessUpdates.contains(id), titleUpdates[id] == nil else {
            Toast.show("Wait for this recording’s changes to save and try again.", isError: true)
            return Task {}
        }
        guard var r = model.recording(id: id), let title = Recording.cleanTitle(newTitle), title != r.title else { return Task {} }
        r.title = title
        r.titleIsCustom = true
        model.update(r)
        // Keep the local transcript's title in sync.
        if let data = try? Data(contentsOf: library.transcriptJSONURL(for: r)), var t = try? ReelJSON.decoder.decode(Transcript.self, from: data) {
            t.title = title
            try? writeTranscript(t, for: r)
        }
        guard r.upload == .uploaded else { return Task {} }
        let task = Task { @MainActor in
            defer { self.titleUpdates[id] = nil }
            do {
                let cloud = try await CloudAuth.shared.validSession()
                try self.requirePublisher(r, cloud: cloud)
                let client = StorageClient(session: cloud)
                try await self.uploadMeta(r, status: "ready", client: client, owner: self.owner(cloud))
                try await self.uploadTranscript(r, client: client)
                try await FirestoreClient(cloud: cloud).upsertLibraryEntry(r)
            } catch {
                Toast.show("Renamed locally; web title not updated: \(error.localizedDescription)", isError: true)
            }
        }
        titleUpdates[id] = task
        return task
    }

    /// Deletes the remote copy (if any: both locations, all segments, the comments room) and
    /// moves the local folder to the Trash.
    func delete(_ recording: Recording) async {
        guard !accessUpdates.contains(recording.id) else {
            Toast.show("Wait for this recording’s sharing settings to save and try again.", isError: true)
            return
        }
        guard deleting.insert(recording.id).inserted else { return }
        defer { deleting.remove(recording.id) }
        transcriptions[recording.id]?.cancel()
        deliveries[recording.id]?.cancel()
        let upload = uploads[recording.id]
        let live = liveFinish[recording.id]
        upload?.cancel()
        live?.cancel()
        await cancelLiveStart(for: recording.id)
        _ = await live?.value
        _ = await upload?.value
        await titleUpdates[recording.id]?.value
        liveFinish[recording.id] = nil
        let r = model.recording(id: recording.id) ?? recording
        if r.upload.mayHaveRemote || r.playback.hls || r.playback.mp4 {
            do {
                let cloud = try await CloudAuth.shared.validSession()
                try self.requirePublisher(r, cloud: cloud)
                let client = StorageClient(session: cloud)
                if r.location.isKeyed { try await client.delete(shareID: r.shareID, files: remoteFiles(r, at: r.location), location: r.location) }
                try await client.delete(shareID: r.shareID, files: remoteFiles(r, at: .open), location: .open)
                try await FirestoreClient(cloud: cloud).deleteLibraryEntry(r.shareID)
                try? await FirestoreClient(cloud: cloud).deleteRoom(r.room)
            } catch {
                Toast.show("Couldn't delete the web copy: \(error.localizedDescription)", isError: true)
                return
            }
        }
        do {
            try library.delete(r)
            if r.isMeeting { _ = await MeetingPortalIndex.remove(r) }
        } catch {
            Toast.show("Couldn't delete local files: \(error.localizedDescription)", isError: true)
        }
        model.reloadLibrary()
    }
}
