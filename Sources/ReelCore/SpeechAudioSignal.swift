/// Exact PCM checks for speech transcription.
public enum SpeechAudioSignal {
    /// Returns false only for empty or fully zero-valued PCM; no amplitude cutoff is applied.
    public static func hasNonzeroPCM16<S: Sequence>(_ samples: S) -> Bool where S.Element == Int16 {
        samples.contains { $0 != 0 }
    }
}
