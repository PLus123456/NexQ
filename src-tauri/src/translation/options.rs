// src-tauri/src/translation/options.rs
//! Translation settings the frontend pushes with `set_translation_provider`:
//! custom service addresses and the LLM translation prompts.
//!
//! JSON (camelCase, every field optional):
//! `{"endpoints": {"deepl": "", "microsoft": "", "google": ""},
//!   "llm": {"systemPrompt": "", "userTemplate": "", "glossary": ""}}`.
//! An empty string means "the default"; a missing `endpoints` / `llm` keeps
//! what the router already has.

use serde::{Deserialize, Serialize};

/// Custom service addresses; empty = the provider's official endpoint.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProviderEndpoints {
    /// DeepL API prefix ending in `/v2` (also DeepL-compatible services such as DeepLX).
    pub deepl: String,
    /// Microsoft Translator base: a resource endpoint
    /// (`https://<resource>.cognitiveservices.azure.com/translator/text/v3.0`)
    /// or a regional cloud (`https://api.translator.azure.cn`).
    pub microsoft: String,
    /// Google Cloud Translation v2 base (`…/language/translate/v2`), e.g. through a proxy.
    pub google: String,
}

impl ProviderEndpoints {
    pub fn deepl(&self) -> Option<&str> {
        non_empty(&self.deepl)
    }

    pub fn microsoft(&self) -> Option<&str> {
        non_empty(&self.microsoft)
    }

    pub fn google(&self) -> Option<&str> {
        non_empty(&self.google)
    }
}

/// How LLM translation prompts the model. Empty prompts use the defaults
/// (`src/lib/translation/llmDefaults.json`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LlmTranslationSettings {
    /// System message; `{source}`, `{target}`, `{glossary}` are filled in.
    pub system_prompt: String,
    /// User message; `{source}`, `{target}`, `{glossary}`, `{text}` are filled in.
    pub user_template: String,
    /// One entry per line: `source term => translation`.
    pub glossary: String,
}

/// The `options` argument of `set_translation_provider` / `test_translation_connection`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TranslationOptionsPatch {
    pub endpoints: Option<ProviderEndpoints>,
    pub llm: Option<LlmTranslationSettings>,
}

/// What the router keeps between calls.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TranslationOptions {
    pub endpoints: ProviderEndpoints,
    pub llm: LlmTranslationSettings,
}

impl TranslationOptions {
    /// Replaces the parts the patch carries, keeps the others.
    pub fn apply(&mut self, patch: TranslationOptionsPatch) {
        if let Some(endpoints) = patch.endpoints {
            self.endpoints = endpoints;
        }
        if let Some(llm) = patch.llm {
            self.llm = llm;
        }
    }

    /// A copy with the patch applied (for testing settings that aren't saved yet).
    pub fn with(&self, patch: Option<TranslationOptionsPatch>) -> Self {
        let mut options = self.clone();
        if let Some(patch) = patch {
            options.apply(patch);
        }
        options
    }
}

fn non_empty(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then_some(trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patch_parses_camel_case_and_partial_objects() {
        let patch: TranslationOptionsPatch = serde_json::from_str(
            r#"{"endpoints": {"deepl": "http://localhost:1188/v2"}, "llm": {"systemPrompt": "S", "glossary": "a => b"}}"#,
        )
        .unwrap();
        let endpoints = patch.endpoints.as_ref().unwrap();
        assert_eq!(endpoints.deepl(), Some("http://localhost:1188/v2"));
        assert_eq!(endpoints.microsoft(), None);
        let llm = patch.llm.as_ref().unwrap();
        assert_eq!(llm.system_prompt, "S");
        assert_eq!(llm.user_template, "");
        assert_eq!(llm.glossary, "a => b");
    }

    #[test]
    fn missing_parts_keep_the_stored_ones() {
        let mut options = TranslationOptions::default();
        options.apply(serde_json::from_str(r#"{"endpoints": {"google": "https://proxy/v2"}}"#).unwrap());
        options.apply(serde_json::from_str(r#"{"llm": {"glossary": "x => y"}}"#).unwrap());
        assert_eq!(options.endpoints.google(), Some("https://proxy/v2"));
        assert_eq!(options.llm.glossary, "x => y");

        options.apply(serde_json::from_str("{}").unwrap());
        assert_eq!(options.endpoints.google(), Some("https://proxy/v2"));

        // A part that is sent replaces the old one entirely.
        options.apply(serde_json::from_str(r#"{"endpoints": {}}"#).unwrap());
        assert_eq!(options.endpoints.google(), None);
    }

    #[test]
    fn blank_endpoints_count_as_default() {
        let endpoints = ProviderEndpoints { deepl: "   ".into(), microsoft: " https://x.cn ".into(), google: String::new() };
        assert_eq!(endpoints.deepl(), None);
        assert_eq!(endpoints.microsoft(), Some("https://x.cn"));
        assert_eq!(endpoints.google(), None);
    }

    #[test]
    fn with_leaves_the_original_untouched() {
        let stored = TranslationOptions::default();
        let tested = stored.with(Some(serde_json::from_str(r#"{"endpoints": {"deepl": "http://h/v2"}}"#).unwrap()));
        assert_eq!(tested.endpoints.deepl(), Some("http://h/v2"));
        assert_eq!(stored.endpoints.deepl(), None);
        assert_eq!(stored.with(None), stored);
    }
}
