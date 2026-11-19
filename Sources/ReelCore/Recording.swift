import Foundation

public enum CaptureMode: String, Codable, CaseIterable, Sendable {
    case screen, window, area, camera
    public var label: String {
        switch self {
        case .screen: "Full screen"
        case .window: "Window"
        case .area: "Area"
        case .camera: "Camera only"
        }
    }
}

public enum UploadState: Codable, Equatable, Sendable {
    case localOnly
    case pending
    case uploading
    case uploaded
    case failed(String)

    public var label: String {
        switch self {
        case .localOnly: "Local only"
        case .pending: "Waiting to upload"
        case .uploading: "Uploading…"
        case .uploaded: "Uploaded"
        case .failed(let why): "Upload failed: \(why)"
        }
    }

    /// Whether anything may exist remotely for this recording.
    public var mayHaveRemote: Bool {
        switch self {
        case .uploaded, .uploading, .failed: true
        case .pending, .localOnly: false
        }
    }
}

/// Non-destructive trim: the viewer plays only [start, end]; the original file is kept.
public struct TrimRange: Codable, Equatable, Sendable {
    public var start: Double
    public var end: Double
    public init(start: Double, end: Double) {
        self.start = start
        self.end = end
    }

    public var length: Double { end - start }

    public static let minimumLength = 0.5

    /// Clamps to [0, duration]; returns nil when the result is too short or covers (almost) the
    /// whole recording, i.e. there is nothing to trim.
    public static func normalized(start: Double, end: Double, duration: Double) -> TrimRange? {
        guard duration > 0, start.isFinite, end.isFinite else { return nil }
        let s = min(max(0, start), duration)
        let e = min(max(0, end), duration)
        guard e - s >= minimumLength else { return nil }
        if s < 0.05 && duration - e < 0.05 { return nil }
        return TrimRange(start: (s * 1000).rounded() / 1000, end: (e * 1000).rounded() / 1000)
    }

    public func contains(_ t: Double) -> Bool { t >= start && t <= end }
}

public struct Chapter: Codable, Equatable, Sendable {
    public var start: Double
    public var title: String
    public init(start: Double, title: String) {
        self.start = start
        self.title = title
    }
}

/// How a recording is shared: open (anyone with the link) or password-protected, optionally
/// expiring. Only the derived key is stored (locally), never the password.
public struct ShareAccess: Codable, Equatable, Sendable {
    public var location: RemoteLocation = .open
    /// Hex salt of the key derivation; present when `location` is keyed.
    public var passwordSalt: String?
    public var expiresAt: Date?
    public init(location: RemoteLocation = .open, passwordSalt: String? = nil, expiresAt: Date? = nil) {
        self.location = location
        self.passwordSalt = passwordSalt
        self.expiresAt = expiresAt
    }
    public var isProtected: Bool { location.isKeyed }
    public func isExpired(now: Date = Date()) -> Bool { expiresAt.map { $0 <= now } ?? false }
}

/// What is playable remotely.
public struct PlaybackState: Codable, Equatable, Sendable {
    public var hls = false
    public var mp4 = false
    public init(hls: Bool = false, mp4: Bool = false) {
        self.hls = hls
        self.mp4 = mp4
    }
}

/// Lifecycle of the local capture, for crash recovery.
public enum CaptureState: String, Codable, Sendable {
    /// Capture in progress (or the app died during it).
    case recording
    /// Capture finished; the local MP4 may still be being assembled.
    case finalizing
    case complete
    /// Rebuilt from segments after an interruption.
    case recovered
}

public enum ExpiryOption: String, CaseIterable, Sendable {
    case never, hour, day, week, month
    public var label: String {
        switch self {
        case .never: "Never"
        case .hour: "1 hour"
        case .day: "1 day"
        case .week: "7 days"
        case .month: "30 days"
        }
    }
    public func date(from now: Date = Date()) -> Date? {
        switch self {
        case .never: nil
        case .hour: now.addingTimeInterval(3600)
        case .day: now.addingTimeInterval(86_400)
        case .week: now.addingTimeInterval(7 * 86_400)
        case .month: now.addingTimeInterval(30 * 86_400)
        }
    }
}

/// One library entry, persisted in `<folder>/recording.json` next to `video.mp4`.
public struct Recording: Codable, Equatable, Identifiable, Sendable {
    public var id: String               // local UUID
    public private(set) var shareID: String
    /// Absent for legacy recordings. New captures keep this nonce through capture and publishing.
    public private(set) var recordingNonce: String?
    public var title: String
    public var createdAt: Date
    public var durationSeconds: Double
    public var width: Int
    public var height: Int
    public var mode: CaptureMode
    public var folderName: String
    public var upload: UploadState
    public var transcriptStatus: TranscriptStatus
    public var hasThumbnail: Bool
    // Added with live upload / sharing features; all decoded tolerantly.
    public var titleIsCustom: Bool = false
    public var captureState: CaptureState = .complete
    /// Stops crash recovery and upload from reviving an explicitly discarded take.
    public internal(set) var discardRequested: Bool?
    public var playback = PlaybackState()
    public var access = ShareAccess()
    public var trim: TrimRange?
    /// A trimmed copy (`trimmed.mp4`) matching `trim` has been uploaded for downloads.
    public var trimmedUploaded = false
    public var summary: String?
    public var chapters: [Chapter]?
    public var summaryEngine: String?
    public var viewCount: Int?
    /// Persisted local intent: meetings never enter automatic sharing paths.
    public var meeting: MeetingDetails?

    public var isMeeting: Bool { meeting != nil }
    public var allowsAutomaticCloudDelivery: Bool { permitsPublishing() }
    public func permitsPublishing(allowMeetingShare: Bool = false) -> Bool {
        discardRequested != true && (!isMeeting || allowMeetingShare)
    }

    public var awaitsUploadOnSignIn: Bool {
        allowsAutomaticCloudDelivery && (upload == .localOnly || upload == .pending)
            && (captureState == .complete || captureState == .recovered)
    }

    public func canResumeMeetingProcessing(owner: String, now: Date = Date()) -> Bool {
        guard let meeting, meeting.ownerUserID == owner, meeting.mayAutomaticallyProcess else { return false }
        return (captureState == .complete || captureState == .recovered) && (meeting.deliveryRetryAt ?? .distantPast) <= now
    }

    public enum TranscriptStatus: String, Codable, Sendable { case pending, ready, none, failed }

    public init(id: String = UUID().uuidString, shareID: String = ShareLinks.newShareID(), title: String, createdAt: Date, durationSeconds: Double, width: Int, height: Int, mode: CaptureMode, folderName: String, upload: UploadState = .pending, transcriptStatus: TranscriptStatus = .pending, hasThumbnail: Bool = false, meeting: MeetingDetails? = nil, recordingNonce: String? = nil) {
        self.id = id
        self.shareID = shareID
        self.recordingNonce = recordingNonce
        self.title = title
        self.createdAt = createdAt
        self.durationSeconds = durationSeconds
        self.width = width
        self.height = height
        self.mode = mode
        self.folderName = folderName
        self.upload = upload
        self.transcriptStatus = transcriptStatus
        self.hasThumbnail = hasThumbnail
        self.meeting = meeting
    }

    enum CodingKeys: String, CodingKey {
        case id, shareID, recordingNonce, title, createdAt, durationSeconds, width, height, mode, folderName, upload, transcriptStatus, hasThumbnail
        case titleIsCustom, captureState, discardRequested, playback, access, trim, trimmedUploaded, summary, chapters, summaryEngine, viewCount, meeting
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        shareID = try c.decode(String.self, forKey: .shareID)
        recordingNonce = try c.decodeIfPresent(String.self, forKey: .recordingNonce)
        title = try c.decode(String.self, forKey: .title)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        durationSeconds = (try? c.decode(Double.self, forKey: .durationSeconds)) ?? 0
        width = (try? c.decode(Int.self, forKey: .width)) ?? 0
        height = (try? c.decode(Int.self, forKey: .height)) ?? 0
        mode = (try? c.decode(CaptureMode.self, forKey: .mode)) ?? .screen
        folderName = try c.decode(String.self, forKey: .folderName)
        upload = (try? c.decode(UploadState.self, forKey: .upload)) ?? .pending
        transcriptStatus = (try? c.decode(TranscriptStatus.self, forKey: .transcriptStatus)) ?? .pending
        hasThumbnail = (try? c.decode(Bool.self, forKey: .hasThumbnail)) ?? false
        titleIsCustom = (try? c.decode(Bool.self, forKey: .titleIsCustom)) ?? false
        captureState = (try? c.decode(CaptureState.self, forKey: .captureState)) ?? .complete
        discardRequested = try c.decodeIfPresent(Bool.self, forKey: .discardRequested)
        playback = (try? c.decode(PlaybackState.self, forKey: .playback)) ?? PlaybackState()
        access = (try? c.decode(ShareAccess.self, forKey: .access)) ?? ShareAccess()
        trim = try? c.decode(TrimRange.self, forKey: .trim)
        trimmedUploaded = (try? c.decode(Bool.self, forKey: .trimmedUploaded)) ?? false
        summary = try? c.decode(String.self, forKey: .summary)
        chapters = try? c.decode([Chapter].self, forKey: .chapters)
        summaryEngine = try? c.decode(String.self, forKey: .summaryEngine)
        viewCount = try? c.decode(Int.self, forKey: .viewCount)
        // Malformed meeting context must not silently turn a private meeting into a normal recording.
        meeting = try c.decodeIfPresent(MeetingDetails.self, forKey: .meeting)
    }

    public var hasPublishableShareID: Bool {
        recordingNonce == nil || ShareLinks.isOwnerBoundShareID(shareID)
    }

    public func matchesPublisher(_ ownerUID: String) -> Bool {
        guard let recordingNonce else { return true }
        return ShareLinks.ownerBoundShareID(ownerUID: ownerUID, recordingNonce: recordingNonce) == shareID
    }

    /// Signed-out captures have a provisional local ID. Once bound, the share ID is immutable.
    @discardableResult
    public mutating func bindToPublisher(_ ownerUID: String) -> Bool {
        guard let recordingNonce else { return true }
        guard let boundID = ShareLinks.ownerBoundShareID(ownerUID: ownerUID, recordingNonce: recordingNonce) else { return false }
        if hasPublishableShareID { return shareID == boundID }
        shareID = boundID
        return true
    }

    /// Merge only immutable identity fields into a stale local snapshot before writing it.
    mutating func preserveIdentity(from stored: Recording) throws {
        guard id == stored.id, recordingNonce == stored.recordingNonce, isMeeting == stored.isMeeting else {
            throw LibraryStore.IdentityError.recordingConflict
        }
        if shareID != stored.shareID {
            guard !hasPublishableShareID, stored.hasPublishableShareID else {
                throw LibraryStore.IdentityError.recordingConflict
            }
            shareID = stored.shareID
            upload = stored.upload
            playback = stored.playback
        }
        if let storedOwner = stored.meeting?.ownerUserID {
            guard meeting?.ownerUserID == nil || meeting?.ownerUserID == storedOwner else {
                throw LibraryStore.IdentityError.publisherConflict
            }
            meeting?.ownerUserID = storedOwner
        }
    }

    func validateMeetingPublisher() throws {
        if let ownerUID = meeting?.ownerUserID, hasPublishableShareID, !matchesPublisher(ownerUID) {
            throw LibraryStore.IdentityError.publisherConflict
        }
    }

    public func shareURL(config: CloudConfig = .default) -> URL { ShareLinks.viewerURL(shareID: shareID, config: config) }

    public var location: RemoteLocation { access.location }
    public var room: String { access.location.room(shareID: shareID) }

    /// Default title, Loom-style: "Recording – 21 Oct 2026, 14:03".
    public static func defaultTitle(for date: Date, locale: Locale = Locale(identifier: "en_GB"), timeZone: TimeZone = .current) -> String {
        let f = DateFormatter()
        f.locale = locale
        f.timeZone = timeZone
        f.dateFormat = "d MMM yyyy, HH:mm"
        return "Recording – \(f.string(from: date))"
    }

    /// Folder under ~/Movies/Reel, sortable and unique: "2026-10-21 140322 <shareID prefix>".
    public static func folderName(for date: Date, shareID: String, timeZone: TimeZone = .current) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = timeZone
        f.dateFormat = "yyyy-MM-dd HHmmss"
        return "\(f.string(from: date)) \(shareID.prefix(6))"
    }

    public static func cleanTitle(_ raw: String) -> String? {
        let t = raw.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return nil }
        return String(t.prefix(200))
    }

    /// File a viewer's Download button should fetch.
    public var downloadFile: RemoteFile? {
        if trim != nil { return trimmedUploaded ? .trimmed : (playback.mp4 ? .video : nil) }
        return playback.mp4 ? .video : nil
    }
}

/// Public `meta.json` the viewer page reads (schemaVersion 2; see README "Remote layout").
/// For an open recording it sits at `reel/v/<id>/meta.json`; for a protected one at
/// `reel/v/<id>/k/<key>/meta.json`, with a `LockedStub` at the open path.
public struct RemoteMeta: Codable, Equatable, Sendable {
    public var schemaVersion: Int = 2
    public var id: String
    public var title: String
    public var createdAt: Date
    public var durationSeconds: Double
    public var width: Int
    public var height: Int
    /// "recording" (capture in progress) | "processing" (finishing upload) | "ready" (playable)
    public var status: String
    public var transcriptStatus: String
    public var hasThumbnail: Bool
    public var ownerName: String?
    public var app: String
    public var playback: PlaybackState
    public var trim: TrimRange?
    public var download: String?
    public var summary: String?
    public var chapters: [Chapter]?
    public var expiresAt: Date?
    public var locked: Bool
    public var room: String
    /// Omitted for older metadata and recordings whose details must stay out of link previews.
    public var linkPreviewAllowed: Bool?

    public init(recording: Recording, status: String, ownerName: String?, app: String) {
        self.id = recording.shareID
        self.title = recording.title
        self.createdAt = recording.createdAt
        self.durationSeconds = recording.durationSeconds
        self.width = recording.width
        self.height = recording.height
        self.status = status
        self.transcriptStatus = recording.transcriptStatus.rawValue
        self.hasThumbnail = recording.hasThumbnail
        self.ownerName = ownerName
        self.app = app
        self.playback = recording.playback
        self.trim = recording.trim
        self.download = recording.downloadFile?.rawValue
        self.summary = recording.summary
        self.chapters = recording.chapters
        self.expiresAt = recording.access.expiresAt
        self.locked = recording.access.isProtected
        self.room = recording.room
        if !recording.isMeeting, !locked, expiresAt == nil, status == "ready", playback.hls || playback.mp4 {
            self.linkPreviewAllowed = true
        }
    }

    // Encode optionals as explicit nulls so the viewer sees every key.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(schemaVersion, forKey: .schemaVersion)
        try c.encode(id, forKey: .id)
        try c.encode(title, forKey: .title)
        try c.encode(createdAt, forKey: .createdAt)
        try c.encode(durationSeconds, forKey: .durationSeconds)
        try c.encode(width, forKey: .width)
        try c.encode(height, forKey: .height)
        try c.encode(status, forKey: .status)
        try c.encode(transcriptStatus, forKey: .transcriptStatus)
        try c.encode(hasThumbnail, forKey: .hasThumbnail)
        try c.encode(ownerName, forKey: .ownerName)
        try c.encode(app, forKey: .app)
        try c.encode(playback, forKey: .playback)
        try c.encode(trim, forKey: .trim)
        try c.encode(download, forKey: .download)
        try c.encode(summary, forKey: .summary)
        try c.encode(chapters, forKey: .chapters)
        try c.encode(expiresAt, forKey: .expiresAt)
        try c.encode(locked, forKey: .locked)
        try c.encode(room, forKey: .room)
        try c.encodeIfPresent(linkPreviewAllowed, forKey: .linkPreviewAllowed)
    }
}

/// `reel/v/<id>/meta.json` of a password-protected recording: just enough for the viewer to
/// ask for the password and derive the key (no title, no file names).
public struct LockedStub: Codable, Equatable, Sendable {
    public struct KDF: Codable, Equatable, Sendable {
        public var name = "PBKDF2"
        public var hash = "SHA-256"
        public var iterations: Int
        public var salt: String
        public var keyBytes: Int
    }
    public var schemaVersion = 2
    public var id: String
    public var locked = true
    public var kdf: KDF
    public var expiresAt: Date?
    public var status: String

    public init(shareID: String, salt: String, expiresAt: Date?, status: String) {
        self.id = shareID
        self.kdf = KDF(iterations: AccessKey.iterations, salt: salt, keyBytes: AccessKey.keyBytes)
        self.expiresAt = expiresAt
        self.status = status
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(schemaVersion, forKey: .schemaVersion)
        try c.encode(id, forKey: .id)
        try c.encode(locked, forKey: .locked)
        try c.encode(kdf, forKey: .kdf)
        try c.encode(expiresAt, forKey: .expiresAt)
        try c.encode(status, forKey: .status)
    }
}
