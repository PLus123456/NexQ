// src-tauri/src/translation/lang_map.rs
//! Language codes per translation service.
//!
//! The frontend sends BCP 47 style codes (`normalizeLanguageCode()` in
//! `src/lib/languages.ts`: "zh-CN", "zh-Hant", "en-US", "pt-BR", "ja"…), and
//! codes it doesn't know are passed through as typed. Each service wants its
//! own form: DeepL "ZH-HANS" / "EN-US" (and only the plain language as a
//! source), Microsoft "zh-Hans" / "pt-pt" / "nb", Google "zh-CN" / "zh-TW".
//! Matching is case-insensitive. LLM prompts get an English name instead.

/// Whether a code names the text's language or the language to translate into.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LangRole {
    Source,
    Target,
}

/// A code split into its language, script and region subtags (other subtags
/// are ignored). Language lower case, script title case, region upper case.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Tag {
    language: String,
    script: Option<String>,
    region: Option<String>,
}

fn parse(code: &str) -> Tag {
    let mut parts = code.trim().split(['-', '_']).filter(|p| !p.is_empty());
    let language = parts.next().unwrap_or_default().to_ascii_lowercase();
    let mut script = None;
    let mut region = None;
    for part in parts {
        if part.len() == 1 {
            break; // extension or private use: not a script or region
        }
        if part.len() == 4 && part.chars().all(|c| c.is_ascii_alphabetic()) && script.is_none() && region.is_none() {
            let lower = part.to_ascii_lowercase();
            script = Some(format!("{}{}", lower[..1].to_ascii_uppercase(), &lower[1..]));
        } else if region.is_none()
            && ((part.len() == 2 && part.chars().all(|c| c.is_ascii_alphabetic()))
                || (part.len() == 3 && part.chars().all(|c| c.is_ascii_digit())))
        {
            region = Some(part.to_ascii_uppercase());
        }
    }
    Tag { language, script, region }
}

/// Traditional characters: an explicit Hant script, or Taiwan / Hong Kong / Macao.
fn is_traditional_chinese(tag: &Tag) -> bool {
    match tag.script.as_deref() {
        Some("Hant") => true,
        Some("Hans") => false,
        _ => matches!(tag.region.as_deref(), Some("TW" | "HK" | "MO")),
    }
}

/// Retired ISO 639 codes some systems still send.
fn modern_language(language: &str) -> &str {
    match language {
        "iw" => "he",
        "in" => "id",
        "ji" => "yi",
        "jw" => "jv",
        "nn" | "no" => "nb",
        "tl" => "fil",
        other => other,
    }
}

/// DeepL (`source_lang` / `target_lang`). Sources are the plain language;
/// targets with variants get one ("EN" / "PT" / "ZH" alone are deprecated).
pub fn deepl_code(code: &str, role: LangRole) -> String {
    let tag = parse(code);
    let language = modern_language(&tag.language);
    if role == LangRole::Source {
        return language.to_ascii_uppercase();
    }
    match language {
        "zh" if is_traditional_chinese(&tag) => "ZH-HANT".to_string(),
        "zh" => "ZH-HANS".to_string(),
        "en" => match tag.region.as_deref() {
            Some("GB" | "IE" | "AU" | "NZ" | "ZA" | "IN") => "EN-GB".to_string(),
            _ => "EN-US".to_string(),
        },
        "pt" => match tag.region.as_deref() {
            Some("PT" | "AO" | "MZ") => "PT-PT".to_string(),
            _ => "PT-BR".to_string(),
        },
        other => other.to_ascii_uppercase(),
    }
}

/// Microsoft Translator (`from` / `to`): the same codes for both roles.
pub fn microsoft_code(code: &str) -> String {
    let tag = parse(code);
    let language = modern_language(&tag.language);
    match language {
        "zh" if is_traditional_chinese(&tag) => "zh-Hant".to_string(),
        "zh" => "zh-Hans".to_string(),
        "pt" if tag.region.as_deref() == Some("PT") => "pt-pt".to_string(),
        "fr" if tag.region.as_deref() == Some("CA") => "fr-ca".to_string(),
        // Written in two scripts; Microsoft has no plain code for them.
        "sr" | "mn" if tag.script.is_none() => format!("{language}-Cyrl"),
        other => match &tag.script {
            Some(script) => format!("{other}-{script}"),
            None => other.to_string(),
        },
    }
}

/// Google Cloud Translation v2 (`source` / `target`).
pub fn google_code(code: &str) -> String {
    let tag = parse(code);
    let language = modern_language(&tag.language);
    match language {
        "zh" if is_traditional_chinese(&tag) => "zh-TW".to_string(),
        "zh" => "zh-CN".to_string(),
        "pt" if tag.region.as_deref() == Some("PT") => "pt-PT".to_string(),
        "mni" if tag.script.as_deref() == Some("Mtei") => "mni-Mtei".to_string(),
        "nb" => "no".to_string(),
        "fil" => "tl".to_string(),
        "jv" => "jw".to_string(),
        other => other.to_string(),
    }
}

/// English name of a text's language for prompts: [`english_name`] without
/// the region (only Chinese keeps its Simplified / Traditional choice).
pub fn english_source_name(code: &str) -> String {
    let tag = parse(code);
    if tag.language == "zh" {
        return english_name(code);
    }
    match base_name(modern_language(&tag.language)) {
        Some(name) => name.to_string(),
        None => code.trim().to_string(),
    }
}

/// English name for prompts ("zh-CN" → "Simplified Chinese", "pt-BR" →
/// "Brazilian Portuguese"); unknown codes come back as typed. Plain "zh" means
/// Simplified Chinese, as the translation language list always had it.
pub fn english_name(code: &str) -> String {
    let trimmed = code.trim();
    let tag = parse(trimmed);
    let language = modern_language(&tag.language);
    let region = tag.region.as_deref();
    let special = match (language, region) {
        ("zh", _) if is_traditional_chinese(&tag) => Some("Traditional Chinese"),
        ("zh", _) => Some("Simplified Chinese"),
        ("en", Some("US")) => Some("American English"),
        ("en", Some("GB")) => Some("British English"),
        ("pt", Some("BR")) => Some("Brazilian Portuguese"),
        ("pt", Some("PT")) => Some("European Portuguese"),
        ("fr", Some("CA")) => Some("Canadian French"),
        ("es", Some("419")) => Some("Latin American Spanish"),
        _ => None,
    };
    if let Some(name) = special {
        return name.to_string();
    }
    match base_name(language) {
        Some(name) => match region {
            Some(region) => format!("{name} ({region})"),
            None => name.to_string(),
        },
        None => trimmed.to_string(),
    }
}

fn base_name(language: &str) -> Option<&'static str> {
    Some(match language {
        "af" => "Afrikaans",
        "am" => "Amharic",
        "ar" => "Arabic",
        "az" => "Azerbaijani",
        "be" => "Belarusian",
        "bg" => "Bulgarian",
        "bn" => "Bengali",
        "bs" => "Bosnian",
        "ca" => "Catalan",
        "cs" => "Czech",
        "cy" => "Welsh",
        "da" => "Danish",
        "de" => "German",
        "el" => "Greek",
        "en" => "English",
        "es" => "Spanish",
        "et" => "Estonian",
        "eu" => "Basque",
        "fa" => "Persian",
        "fi" => "Finnish",
        "fil" => "Filipino",
        "fr" => "French",
        "ga" => "Irish",
        "gl" => "Galician",
        "gu" => "Gujarati",
        "he" => "Hebrew",
        "hi" => "Hindi",
        "hr" => "Croatian",
        "hu" => "Hungarian",
        "hy" => "Armenian",
        "id" => "Indonesian",
        "is" => "Icelandic",
        "it" => "Italian",
        "ja" => "Japanese",
        "jv" => "Javanese",
        "ka" => "Georgian",
        "kk" => "Kazakh",
        "km" => "Khmer",
        "kn" => "Kannada",
        "ko" => "Korean",
        "lo" => "Lao",
        "lt" => "Lithuanian",
        "lv" => "Latvian",
        "mk" => "Macedonian",
        "ml" => "Malayalam",
        "mn" => "Mongolian",
        "mr" => "Marathi",
        "ms" => "Malay",
        "my" => "Burmese",
        "nb" => "Norwegian",
        "ne" => "Nepali",
        "nl" => "Dutch",
        "pa" => "Punjabi",
        "pl" => "Polish",
        "ps" => "Pashto",
        "pt" => "Portuguese",
        "ro" => "Romanian",
        "ru" => "Russian",
        "si" => "Sinhala",
        "sk" => "Slovak",
        "sl" => "Slovenian",
        "sq" => "Albanian",
        "sr" => "Serbian",
        "sv" => "Swedish",
        "sw" => "Swahili",
        "ta" => "Tamil",
        "te" => "Telugu",
        "th" => "Thai",
        "tr" => "Turkish",
        "uk" => "Ukrainian",
        "ur" => "Urdu",
        "uz" => "Uzbek",
        "vi" => "Vietnamese",
        "yue" => "Cantonese",
        "zu" => "Zulu",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use LangRole::{Source, Target};

    #[test]
    fn parses_language_script_and_region() {
        assert_eq!(
            parse("ZH_hant_tw"),
            Tag { language: "zh".into(), script: Some("Hant".into()), region: Some("TW".into()) }
        );
        assert_eq!(parse("es-419"), Tag { language: "es".into(), script: None, region: Some("419".into()) });
        assert_eq!(parse("en-x-custom"), Tag { language: "en".into(), script: None, region: None });
        assert_eq!(parse(""), Tag { language: String::new(), script: None, region: None });
    }

    #[test]
    fn deepl_targets_get_a_variant_and_sources_stay_plain() {
        let cases = [
            ("zh", "ZH-HANS"),
            ("zh-CN", "ZH-HANS"),
            ("zh-Hans", "ZH-HANS"),
            ("zh-TW", "ZH-HANT"),
            ("zh-HK", "ZH-HANT"),
            ("zh-Hant", "ZH-HANT"),
            ("en", "EN-US"),
            ("en-US", "EN-US"),
            ("en-GB", "EN-GB"),
            ("en-AU", "EN-GB"),
            ("pt", "PT-BR"),
            ("pt-BR", "PT-BR"),
            ("pt-PT", "PT-PT"),
            ("no", "NB"),
            ("nb", "NB"),
            ("ja", "JA"),
            ("de-DE", "DE"),
            ("es-MX", "ES"),
        ];
        for (code, expected) in cases {
            assert_eq!(deepl_code(code, Target), expected, "target {code}");
        }
        for (code, expected) in [("zh-TW", "ZH"), ("en-US", "EN"), ("pt-BR", "PT"), ("no", "NB"), ("ja-JP", "JA")] {
            assert_eq!(deepl_code(code, Source), expected, "source {code}");
        }
    }

    #[test]
    fn microsoft_uses_scripts_for_chinese_and_its_own_variants() {
        let cases = [
            ("zh", "zh-Hans"),
            ("zh-CN", "zh-Hans"),
            ("ZH-HANS", "zh-Hans"),
            ("zh-TW", "zh-Hant"),
            ("zh-MO", "zh-Hant"),
            ("en-US", "en"),
            ("pt-BR", "pt"),
            ("pt-PT", "pt-pt"),
            ("fr-CA", "fr-ca"),
            ("fr-FR", "fr"),
            ("no", "nb"),
            ("tl", "fil"),
            ("iw", "he"),
            ("sr", "sr-Cyrl"),
            ("sr-Latn", "sr-Latn"),
            ("mn", "mn-Cyrl"),
            ("mn-Mong", "mn-Mong"),
            ("ja", "ja"),
            ("yue", "yue"),
        ];
        for (code, expected) in cases {
            assert_eq!(microsoft_code(code), expected, "{code}");
        }
    }

    #[test]
    fn google_uses_regions_for_chinese() {
        let cases = [
            ("zh", "zh-CN"),
            ("zh-Hans", "zh-CN"),
            ("zh-SG", "zh-CN"),
            ("zh-TW", "zh-TW"),
            ("zh-Hant", "zh-TW"),
            ("zh-HK", "zh-TW"),
            ("en-GB", "en"),
            ("pt-PT", "pt-PT"),
            ("pt-BR", "pt"),
            ("nb", "no"),
            ("no", "no"),
            ("fil", "tl"),
            ("he", "he"),
            ("jv", "jw"),
            ("ko-KR", "ko"),
        ];
        for (code, expected) in cases {
            assert_eq!(google_code(code), expected, "{code}");
        }
    }

    #[test]
    fn unknown_codes_pass_through() {
        assert_eq!(deepl_code("xx-YY", Target), "XX");
        assert_eq!(microsoft_code("tlh-Latn"), "tlh-Latn");
        assert_eq!(microsoft_code("qq-ZZ"), "qq");
        assert_eq!(google_code("haw"), "haw");
        assert_eq!(english_name("x-klingon"), "x-klingon");
        assert_eq!(english_name("qq"), "qq");
    }

    #[test]
    fn english_names_for_prompts() {
        let cases = [
            ("zh", "Simplified Chinese"),
            ("zh-CN", "Simplified Chinese"),
            ("zh-TW", "Traditional Chinese"),
            ("zh-Hant", "Traditional Chinese"),
            ("en", "English"),
            ("en-US", "American English"),
            ("en-GB", "British English"),
            ("pt-BR", "Brazilian Portuguese"),
            ("ja", "Japanese"),
            ("ja-JP", "Japanese (JP)"),
            ("es-MX", "Spanish (MX)"),
            ("fr-CA", "Canadian French"),
            ("no", "Norwegian"),
            ("yue", "Cantonese"),
            (" ko ", "Korean"),
        ];
        for (code, expected) in cases {
            assert_eq!(english_name(code), expected, "{code}");
        }
    }

    #[test]
    fn source_names_drop_the_region() {
        assert_eq!(english_source_name("en-US"), "English");
        assert_eq!(english_source_name("ja-JP"), "Japanese");
        assert_eq!(english_source_name("zh-TW"), "Traditional Chinese");
        assert_eq!(english_source_name("zh-CN"), "Simplified Chinese");
        assert_eq!(english_source_name("iw"), "Hebrew");
        assert_eq!(english_source_name("xx-YY"), "xx-YY");
    }
}
