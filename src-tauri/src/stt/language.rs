// NexQ Plus: recognition language per party.
//
// Each party ("You" / "Them") has its own language: a BCP-47 code ("zh-CN",
// "en-US"), a bare code ("zh"), or "auto". Configs saved before the per-party
// setting have none and use the global STT language. Every engine maps the
// value here, so "auto" means the same thing everywhere it is supported.

/// The value stored for "detect the language".
pub const AUTO: &str = "auto";

/// Used when neither the party nor the global setting has a language.
pub const FALLBACK_LANGUAGE: &str = "en-US";

/// True for "auto" (any case) and for an empty value.
pub fn is_auto(lang: &str) -> bool {
    let t = lang.trim();
    t.is_empty() || t.eq_ignore_ascii_case(AUTO)
}

/// Primary language subtag, lowercase: "zh-CN" → "zh", "pt_BR" → "pt",
/// "yue" → "yue". None for "auto", empty or malformed values.
pub fn base_code(lang: &str) -> Option<String> {
    if is_auto(lang) {
        return None;
    }
    let primary = lang.trim().split(['-', '_']).next().unwrap_or("");
    let valid = (2..=3).contains(&primary.len()) && primary.chars().all(|c| c.is_ascii_alphabetic());
    valid.then(|| primary.to_ascii_lowercase())
}

/// The language a party recognizes in: its own setting when present
/// ("auto" included), else the global STT language, else English.
pub fn party_language(party: Option<&str>, global: &str) -> String {
    match party.map(str::trim) {
        Some(own) if !own.is_empty() => own.to_string(),
        _ if !global.trim().is_empty() => global.trim().to_string(),
        _ => FALLBACK_LANGUAGE.to_string(),
    }
}

/// `language` field for Whisper-style HTTP APIs (OpenAI, Groq, remote
/// OpenAI-compatible): ISO 639-1, or None to leave the field out and let the
/// server detect. Sending "auto" is rejected by OpenAI with HTTP 400.
pub fn whisper_api_language(lang: &str) -> Option<String> {
    base_code(lang)
}

/// whisper.cpp language: "auto" makes it detect per chunk.
pub fn whisper_cpp_language(lang: &str) -> String {
    base_code(lang).unwrap_or_else(|| AUTO.to_string())
}

/// SenseVoice `--sense-voice-language`: zh, en, ja, ko, yue or auto.
/// A language SenseVoice doesn't know is detected rather than forced to English.
pub fn sense_voice_language(lang: &str) -> &'static str {
    match base_code(lang).as_deref() {
        Some("zh") => "zh",
        Some("en") => "en",
        Some("ja") => "ja",
        Some("ko") => "ko",
        Some("yue") => "yue",
        _ => AUTO,
    }
}

/// Whether a Deepgram model can transcribe mixed / unknown languages (`language=multi`).
pub fn deepgram_supports_multi(model: &str) -> bool {
    let m = model.trim().to_ascii_lowercase();
    m.starts_with("nova-3") || m.starts_with("nova-2")
}

/// Deepgram `language` parameter. "auto" becomes `multi` on Nova 2/3 and
/// English on models that can't detect; English locales keep their region.
pub fn deepgram_language(lang: &str, model: &str) -> String {
    if is_auto(lang) {
        return if deepgram_supports_multi(model) { "multi" } else { "en" }.to_string();
    }
    let trimmed = lang.trim();
    if trimmed.eq_ignore_ascii_case("en-US") || trimmed.eq_ignore_ascii_case("en-GB") {
        return trimmed.to_string();
    }
    base_code(trimmed).unwrap_or_else(|| "en".to_string())
}

/// Language for engines that can't detect (Azure, Windows Speech): the
/// party's language, or English for "auto".
pub fn without_auto(lang: &str) -> String {
    if is_auto(lang) {
        FALLBACK_LANGUAGE.to_string()
    } else {
        lang.trim().to_string()
    }
}

/// Soniox `language_hints` for a party: its own language when set; with
/// "auto", the other party's language (the union of both); none when both
/// detect. Hints only bias recognition, they never restrict it (unless strict).
pub fn soniox_language_hints(own: &str, other: Option<&str>) -> Vec<String> {
    if let Some(code) = base_code(own) {
        return vec![code];
    }
    other.and_then(base_code).into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_and_empty_mean_detect() {
        assert!(is_auto("auto"));
        assert!(is_auto(" AUTO "));
        assert!(is_auto(""));
        assert!(!is_auto("en-US"));
    }

    #[test]
    fn base_codes() {
        assert_eq!(base_code("zh-CN").as_deref(), Some("zh"));
        assert_eq!(base_code("zh-Hans").as_deref(), Some("zh"));
        assert_eq!(base_code("pt_BR").as_deref(), Some("pt"));
        assert_eq!(base_code("EN").as_deref(), Some("en"));
        assert_eq!(base_code("yue").as_deref(), Some("yue"));
        assert_eq!(base_code("auto"), None);
        assert_eq!(base_code("x"), None);
        assert_eq!(base_code("12-AB"), None);
    }

    #[test]
    fn a_party_language_falls_back_to_the_global_one() {
        assert_eq!(party_language(Some("zh-CN"), "en-US"), "zh-CN");
        assert_eq!(party_language(Some("auto"), "en-US"), "auto");
        assert_eq!(party_language(None, "ja-JP"), "ja-JP");
        assert_eq!(party_language(Some("  "), "ja-JP"), "ja-JP");
        assert_eq!(party_language(None, ""), "en-US");
    }

    #[test]
    fn whisper_apis_leave_the_language_out_for_auto() {
        assert_eq!(whisper_api_language("auto"), None);
        assert_eq!(whisper_api_language(""), None);
        assert_eq!(whisper_api_language("es-ES").as_deref(), Some("es"));
        assert_eq!(whisper_cpp_language("auto"), "auto");
        assert_eq!(whisper_cpp_language("zh-CN"), "zh");
    }

    #[test]
    fn sense_voice_detects_what_it_cannot_force() {
        assert_eq!(sense_voice_language("zh-CN"), "zh");
        assert_eq!(sense_voice_language("yue"), "yue");
        assert_eq!(sense_voice_language("auto"), "auto");
        // Used to fall back to "en".
        assert_eq!(sense_voice_language("ru-RU"), "auto");
    }

    #[test]
    fn deepgram_maps_auto_to_multi_on_nova() {
        assert_eq!(deepgram_language("auto", "nova-3"), "multi");
        assert_eq!(deepgram_language("auto", "nova-2-meeting"), "multi");
        assert_eq!(deepgram_language("auto", "enhanced"), "en");
        assert_eq!(deepgram_language("en-GB", "nova-3"), "en-GB");
        assert_eq!(deepgram_language("zh-CN", "nova-3"), "zh");
    }

    #[test]
    fn engines_without_detection_get_english_for_auto() {
        assert_eq!(without_auto("auto"), "en-US");
        assert_eq!(without_auto("de-DE"), "de-DE");
    }

    #[test]
    fn soniox_hints_use_the_union_of_both_parties() {
        assert_eq!(soniox_language_hints("zh-CN", Some("en-US")), vec!["zh"]);
        assert_eq!(soniox_language_hints("auto", Some("en-US")), vec!["en"]);
        assert!(soniox_language_hints("auto", Some("auto")).is_empty());
        assert!(soniox_language_hints("auto", None).is_empty());
    }
}
