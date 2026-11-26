// Language codes supported by the pinned Transformers.js 3.0.0 Whisper runtime
// and present in the pinned multilingual tokenizer. Transformers.js 3.0.0
// currently omits the tokenizer's `yue` token from its language mapping.
export const WHISPER_LANGUAGE_CODES = Object.freeze([
  "en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr", "pl", "ca", "nl", "ar", "sv", "it", "id", "hi", "fi", "vi", "he", "uk", "el", "ms", "cs", "ro", "da", "hu", "ta", "no", "th", "ur", "hr", "bg", "lt", "la", "mi", "ml", "cy", "sk", "te", "fa", "lv", "bn", "sr", "az", "sl", "kn", "et", "mk", "br", "eu", "is", "hy", "ne", "mn", "bs", "kk", "sq", "sw", "gl", "mr", "pa", "si", "km", "sn", "yo", "so", "af", "oc", "ka", "be", "tg", "sd", "gu", "am", "yi", "lo", "uz", "fo", "ht", "ps", "tk", "nn", "mt", "sa", "lb", "my", "bo", "tl", "mg", "as", "tt", "haw", "ln", "ha", "ba", "jw", "su",
]);

const LANGUAGE_CODE_SET = new Set(WHISPER_LANGUAGE_CODES);

export function normalizeWhisperLanguage(value) {
  return LANGUAGE_CODE_SET.has(value) ? value : "en";
}

export function whisperLanguageOptions(displayLocale = "en") {
  const names = new Intl.DisplayNames([displayLocale], { type: "language" });
  return WHISPER_LANGUAGE_CODES.map((code) => {
    let label;
    try { label = names.of(code); } catch {}
    if (!label || label === code) label = code;
    return { code, label };
  }).sort((a, b) => a.label.localeCompare(b.label, displayLocale));
}
