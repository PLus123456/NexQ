// src-tauri/src/translation/llm_provider.rs
//! LLM translation. The model comes from the LLM settings' task routing
//! (`LlmTask::Translation` live, `LlmTask::TranslationBatch` after a meeting)
//! through `crate::llm::api`; this file builds the prompt and cleans the answer.
//! `LlmTranslator` only marks the provider type: it needs an `AppHandle`, so
//! the commands call [`translate_with_llm`] instead of `translate()`.

use super::*;
use super::lang_map;
use super::options::LlmTranslationSettings;
use crate::llm::api::{complete_text, CompleteOptions, LlmTask};
use crate::llm::provider::LLMMessage;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::AppHandle;

pub struct LlmTranslator;

impl LlmTranslator {
    pub fn new() -> Self { Self }
}

#[async_trait]
impl TranslationProvider for LlmTranslator {
    fn provider_name(&self) -> &str { "LLM Translation" }
    fn provider_type(&self) -> TranslationProviderType { TranslationProviderType::Llm }
    fn is_local(&self) -> bool { false } // depends on configured LLM

    async fn translate(
        &self,
        _text: &str,
        _source: Option<&str>,
        _target: &str,
    ) -> Result<String, TranslationError> {
        // Needs the AppHandle to reach the LLM: the commands use translate_with_llm.
        Err(TranslationError::NotConfigured(
            "LLM translation is invoked through the command layer".into()
        ))
    }

    async fn detect_language(&self, _text: &str) -> Result<DetectedLanguage, TranslationError> {
        Err(TranslationError::NotConfigured("Use cloud provider for detection".into()))
    }

    async fn supported_languages(&self) -> Result<Vec<Language>, TranslationError> {
        // LLMs support all languages — return a curated list
        Ok(vec![
            Language { code: "en".into(), name: "English".into(), native_name: Some("English".into()) },
            Language { code: "es".into(), name: "Spanish".into(), native_name: Some("Español".into()) },
            Language { code: "fr".into(), name: "French".into(), native_name: Some("Français".into()) },
            Language { code: "de".into(), name: "German".into(), native_name: Some("Deutsch".into()) },
            Language { code: "ja".into(), name: "Japanese".into(), native_name: Some("日本語".into()) },
            Language { code: "zh".into(), name: "Chinese".into(), native_name: Some("中文".into()) },
            Language { code: "ko".into(), name: "Korean".into(), native_name: Some("한국어".into()) },
            Language { code: "pt".into(), name: "Portuguese".into(), native_name: Some("Português".into()) },
            Language { code: "it".into(), name: "Italian".into(), native_name: Some("Italiano".into()) },
            Language { code: "ru".into(), name: "Russian".into(), native_name: Some("Русский".into()) },
            Language { code: "ar".into(), name: "Arabic".into(), native_name: Some("العربية".into()) },
        ])
    }

    async fn test_connection(&self) -> Result<ConnectionStatus, TranslationError> {
        // A real test needs the AppHandle: test_translation_connection translates a sentence.
        Err(TranslationError::NotConfigured(
            "LLM translation is tested through the command layer".into()
        ))
    }
}

// ── Prompt ──

/// Shared with the settings page, which shows these as the defaults.
const DEFAULTS_JSON: &str = include_str!("../../../src/lib/translation/llmDefaults.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptDefaults {
    system_prompt: String,
    user_template: String,
    glossary_heading: String,
    auto_source: String,
}

fn defaults() -> &'static PromptDefaults {
    static DEFAULTS: OnceLock<PromptDefaults> = OnceLock::new();
    DEFAULTS.get_or_init(|| serde_json::from_str(DEFAULTS_JSON).expect("llmDefaults.json is valid"))
}

/// One glossary line: `source => target` (also `->`, `→`, `⇒`). Blank lines
/// and `#` comments are skipped, as are lines without both sides.
pub fn parse_glossary(glossary: &str) -> Vec<(String, String)> {
    glossary
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(|line| {
            let (at, len) = ["=>", "->", "→", "⇒"]
                .iter()
                .filter_map(|sep| line.find(sep).map(|i| (i, sep.len())))
                .min_by_key(|&(i, _)| i)?;
            let source = line[..at].trim();
            let target = line[at + len..].trim();
            (!source.is_empty() && !target.is_empty()).then(|| (source.to_string(), target.to_string()))
        })
        .collect()
}

/// The glossary block for `text`: only the entries whose source term occurs
/// in it (case-insensitive), so a long glossary doesn't bloat every request.
/// Empty when nothing matches; otherwise ends with a blank line.
pub fn glossary_block(glossary: &str, text: &str) -> String {
    let haystack = text.to_lowercase();
    let entries: Vec<String> = parse_glossary(glossary)
        .into_iter()
        .filter(|(source, _)| haystack.contains(&source.to_lowercase()))
        .map(|(source, target)| format!("- {source} => {target}"))
        .collect();
    if entries.is_empty() {
        return String::new();
    }
    format!("{}\n{}\n\n", defaults().glossary_heading, entries.join("\n"))
}

fn fill(template: &str, source: &str, target: &str, glossary: &str, text: &str) -> String {
    // `{text}` last, so placeholders inside the transcript are left alone.
    template
        .replace("{source}", source)
        .replace("{target}", target)
        .replace("{glossary}", glossary)
        .replace("{text}", text)
}

/// Removes the blank lines an empty `{glossary}` leaves behind.
fn tidy(prompt: &str) -> String {
    let mut out = String::with_capacity(prompt.len());
    let mut blank_run = 0;
    for line in prompt.trim().lines() {
        if line.trim().is_empty() {
            blank_run += 1;
            if blank_run > 1 {
                continue;
            }
        } else {
            blank_run = 0;
        }
        out.push_str(line);
        out.push('\n');
    }
    out.trim_end().to_string()
}

/// The system and user messages for one translation. Empty settings use the
/// defaults. A glossary that neither template mentions goes to the end of the
/// system message so it still applies.
pub fn build_messages(
    settings: &LlmTranslationSettings,
    text: &str,
    source: Option<&str>,
    target: &str,
) -> Vec<LLMMessage> {
    let d = defaults();
    let system = if settings.system_prompt.trim().is_empty() { &d.system_prompt } else { &settings.system_prompt };
    let user = if settings.user_template.trim().is_empty() { &d.user_template } else { &settings.user_template };
    let source_name = match source {
        Some(code) => lang_map::english_source_name(code),
        None => d.auto_source.clone(),
    };
    let target_name = lang_map::english_name(target);
    let glossary = glossary_block(&settings.glossary, text);

    let mentions_glossary = system.contains("{glossary}") || user.contains("{glossary}");
    let mut system_message = tidy(&fill(system, &source_name, &target_name, &glossary, ""));
    if !mentions_glossary && !glossary.is_empty() {
        system_message.push_str("\n\n");
        system_message.push_str(glossary.trim_end());
    }
    let mut user_message = tidy(&fill(user, &source_name, &target_name, &glossary, text));
    if !user.contains("{text}") {
        // A template without the text would translate nothing.
        user_message.push_str("\n\n");
        user_message.push_str(text);
    }

    vec![
        LLMMessage { role: "system".to_string(), content: system_message },
        LLMMessage { role: "user".to_string(), content: user_message },
    ]
}

// ── Answer cleanup ──

/// Labels models put before the translation.
const LABELS: &[&str] = &[
    "here is the translation:",
    "here's the translation:",
    "translated text:",
    "translation:",
    "译文：",
    "译文:",
    "翻译：",
    "翻译:",
];

const QUOTE_PAIRS: &[(char, char)] = &[('"', '"'), ('“', '”'), ('「', '」'), ('『', '』'), ('\'', '\''), ('«', '»')];

/// Drops reasoning (`<think>…</think>`, or everything before a lone
/// `</think>`), a code fence around the whole answer, a leading
/// "Translation:" style label and quotes the source didn't have.
pub fn clean_output(raw: &str, source_text: &str) -> String {
    let mut text = raw.to_string();

    // Reasoning blocks (case-insensitive tags; ASCII lowering keeps byte offsets).
    loop {
        let lower = text.to_ascii_lowercase();
        if let Some(close) = lower.find("</think>") {
            let start = lower[..close].rfind("<think>").unwrap_or(0);
            text.replace_range(start..close + "</think>".len(), "");
            continue;
        }
        if let Some(open) = lower.find("<think>") {
            // Never closed: the rest is reasoning.
            text.truncate(open);
        }
        break;
    }

    let mut text = text.trim().to_string();

    // ```lang … ``` around the whole answer.
    if text.starts_with("```") && text.ends_with("```") && text.len() >= 6 {
        let inner = &text[3..text.len() - 3];
        let inner = match inner.find('\n') {
            Some(newline) if !inner[..newline].trim().contains(' ') => &inner[newline + 1..],
            _ => inner,
        };
        text = inner.trim().to_string();
    }

    let lower = text.to_ascii_lowercase();
    if let Some(label) = LABELS.iter().find(|label| lower.starts_with(*label)) {
        text = text[label.len()..].trim().to_string();
    }

    let source = source_text.trim();
    for &(open, close) in QUOTE_PAIRS {
        let mut chars = text.chars();
        let (Some(first), Some(last)) = (chars.next(), chars.next_back()) else { break };
        if first == open && last == close && !source.starts_with(open) {
            text = text[open.len_utf8()..text.len() - close.len_utf8()].trim().to_string();
            break;
        }
    }

    text
}

/// Translates `text` with the model routed to `task`; `timeout` bounds the call.
pub async fn translate_with_llm(
    app: &AppHandle,
    task: &LlmTask,
    settings: &LlmTranslationSettings,
    text: &str,
    source: Option<&str>,
    target: &str,
    timeout: Duration,
) -> Result<String, String> {
    let messages = build_messages(settings, text, source, target);
    let options = CompleteOptions { timeout: Some(timeout), ..Default::default() };
    let answer = complete_text(app, task, messages, options)
        .await
        .map_err(|e| format!("LLM translation failed: {e}"))?;
    let cleaned = clean_output(&answer, text);
    if cleaned.is_empty() {
        return Err("LLM translation failed: the model returned no translation".to_string());
    }
    Ok(cleaned)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(system: &str, user: &str, glossary: &str) -> LlmTranslationSettings {
        LlmTranslationSettings {
            system_prompt: system.to_string(),
            user_template: user.to_string(),
            glossary: glossary.to_string(),
        }
    }

    #[test]
    fn defaults_parse() {
        let d = defaults();
        assert!(d.system_prompt.contains("{target}"));
        assert!(d.user_template.contains("{text}"));
        assert!(d.user_template.contains("{glossary}"));
    }

    #[test]
    fn default_prompt_uses_language_names() {
        let messages = build_messages(&LlmTranslationSettings::default(), "Hello there", Some("en-US"), "zh-CN");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "system");
        assert!(messages[0].content.contains("from English into Simplified Chinese"), "{}", messages[0].content);
        assert_eq!(messages[1].role, "user");
        assert_eq!(messages[1].content, "Translate from English into Simplified Chinese:\n\nHello there");
    }

    #[test]
    fn auto_source_is_described() {
        let messages = build_messages(&LlmTranslationSettings::default(), "Hola", None, "ja");
        assert_eq!(messages[1].content, "Translate from the detected language into Japanese:\n\nHola");
    }

    #[test]
    fn custom_templates_fill_every_placeholder() {
        let s = settings("Interpret {source} to {target}.", "[{source}->{target}] {text}", "");
        let messages = build_messages(&s, "Guten Tag", Some("de"), "en-GB");
        assert_eq!(messages[0].content, "Interpret German to British English.");
        assert_eq!(messages[1].content, "[German->British English] Guten Tag");
    }

    #[test]
    fn placeholders_inside_the_text_are_kept() {
        let s = settings("", "{text}", "");
        let messages = build_messages(&s, "use {target} here", Some("en"), "fr");
        assert_eq!(messages[1].content, "use {target} here");
    }

    #[test]
    fn a_template_without_text_still_sends_it() {
        let s = settings("", "Translate please.", "");
        let messages = build_messages(&s, "Bonjour", Some("fr"), "en");
        assert_eq!(messages[1].content, "Translate please.\n\nBonjour");
    }

    #[test]
    fn glossary_lines_and_separators() {
        let parsed = parse_glossary("# terms\nKubernetes => K8s\n\n  LLM -> 大模型 \nbroken line\n=> nothing\nA → B\nC ⇒ D => E");
        assert_eq!(
            parsed,
            vec![
                ("Kubernetes".to_string(), "K8s".to_string()),
                ("LLM".to_string(), "大模型".to_string()),
                ("A".to_string(), "B".to_string()),
                ("C".to_string(), "D => E".to_string()),
            ]
        );
    }

    #[test]
    fn only_matching_glossary_entries_are_sent() {
        let glossary = "NexQ => NexQ\nsprint => 冲刺\nbacklog => 待办列表";
        let block = glossary_block(glossary, "Let's plan the next Sprint.");
        assert!(block.contains("- sprint => 冲刺"));
        assert!(!block.contains("backlog"));
        assert!(!block.contains("NexQ"));
        assert!(block.ends_with("\n\n"));
        assert_eq!(glossary_block(glossary, "nothing relevant"), "");
    }

    #[test]
    fn glossary_goes_into_the_default_user_message() {
        let s = settings("", "", "sprint => 冲刺");
        let messages = build_messages(&s, "the sprint", Some("en"), "zh-CN");
        let user = &messages[1].content;
        assert!(user.starts_with("Glossary (always translate these terms this way):\n- sprint => 冲刺\n\nTranslate from English"), "{user}");
        assert!(!messages[0].content.contains("sprint"));
    }

    #[test]
    fn empty_glossary_leaves_no_blank_lines() {
        let s = settings("", "{glossary}\n\n\nTranslate:\n{glossary}\n{text}", "");
        let messages = build_messages(&s, "hi", Some("en"), "de");
        assert_eq!(messages[1].content, "Translate:\n\nhi");
    }

    #[test]
    fn glossary_without_placeholder_goes_to_the_system_message() {
        let s = settings("Translate into {target}.", "{text}", "sprint => 冲刺");
        let messages = build_messages(&s, "the sprint", None, "zh");
        assert_eq!(
            messages[0].content,
            "Translate into Simplified Chinese.\n\nGlossary (always translate these terms this way):\n- sprint => 冲刺"
        );
        assert_eq!(messages[1].content, "the sprint");
    }

    #[test]
    fn cleanup_removes_reasoning() {
        assert_eq!(clean_output("<think>hmm, formal tone</think>\n你好", "Hello"), "你好");
        assert_eq!(clean_output("<THINK>a</THINK>你好<think>b</think>", "Hello"), "你好");
        assert_eq!(clean_output("reasoning only</think>  你好 ", "Hello"), "你好");
        assert_eq!(clean_output("你好<think>trailing never closed", "Hello"), "你好");
        assert_eq!(clean_output("<think>never closed", "Hello"), "");
    }

    #[test]
    fn cleanup_removes_labels_fences_and_quotes() {
        assert_eq!(clean_output("Translation: Hola", "Hello"), "Hola");
        assert_eq!(clean_output("译文：你好", "Hello"), "你好");
        assert_eq!(clean_output("Here is the translation:\n\nBonjour", "Hello"), "Bonjour");
        assert_eq!(clean_output("```\nBonjour\n```", "Hello"), "Bonjour");
        assert_eq!(clean_output("```text\nBonjour tout le monde\n```", "Hello"), "Bonjour tout le monde");
        assert_eq!(clean_output("\"Hola\"", "Hello"), "Hola");
        assert_eq!(clean_output("“你好”", "Hello"), "你好");
        assert_eq!(clean_output("「こんにちは」", "Hello"), "こんにちは");
    }

    #[test]
    fn cleanup_keeps_quotes_the_source_had() {
        assert_eq!(clean_output("\"Hola\"", "\"Hello\""), "\"Hola\"");
        assert_eq!(clean_output("“你好”", "“Hello”"), "“你好”");
    }

    #[test]
    fn cleanup_keeps_ordinary_answers() {
        assert_eq!(clean_output("  你好，世界。 ", "Hello, world."), "你好，世界。");
        assert_eq!(clean_output("Translations are hard", "x"), "Translations are hard");
        assert_eq!(clean_output("\"", "x"), "\"");
        assert_eq!(clean_output("", "x"), "");
    }
}
