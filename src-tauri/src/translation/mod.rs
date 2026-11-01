// src-tauri/src/translation/mod.rs
pub mod microsoft;
pub mod google;
pub mod deepl;
pub mod opus_mt;
pub mod opus_mt_registry;
pub mod opus_mt_manager;
pub mod llm_provider;
pub mod lang_map;
pub mod options;
#[cfg(test)]
mod test_http;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::collections::hash_map::DefaultHasher;
use std::sync::Arc;

// ── Error types ──

#[derive(Debug, thiserror::Error)]
pub enum TranslationError {
    #[error("HTTP request failed: {0}")]
    Http(String),
    #[error("Provider not configured: {0}")]
    NotConfigured(String),
    #[error("API key missing for provider: {0}")]
    NoApiKey(String),
    #[error("Language not supported: {0}")]
    UnsupportedLanguage(String),
    #[error("Rate limit exceeded")]
    RateLimited,
    #[error("Translation failed: {0}")]
    Failed(String),
}

impl Serialize for TranslationError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where S: serde::Serializer {
        serializer.serialize_str(&self.to_string())
    }
}

// ── Shared types ──

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TranslationProviderType {
    Microsoft,
    Google,
    Deepl,
    OpusMt,
    Llm,
}

impl std::fmt::Display for TranslationProviderType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Microsoft => write!(f, "microsoft"),
            Self::Google => write!(f, "google"),
            Self::Deepl => write!(f, "deepl"),
            Self::OpusMt => write!(f, "opus-mt"),
            Self::Llm => write!(f, "llm"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranslationResult {
    pub segment_id: Option<String>,
    pub original_text: String,
    pub translated_text: String,
    pub source_lang: String,
    pub target_lang: String,
    pub provider: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedLanguage {
    pub lang: String,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Language {
    pub code: String,
    pub name: String,
    pub native_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionStatus {
    pub connected: bool,
    pub language_count: usize,
    pub response_ms: u64,
    pub error: Option<String>,
    /// What the test sentence came back as, when the test translates one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample: Option<String>,
}

// ── Service addresses ──

pub use crate::net::endpoint::redact_url;

/// A user-entered service address as a base URL: checked like every other
/// endpoint (`net::endpoint`), with a pasted full address (one of
/// `known_paths` at the end) cut back to the base.
pub(crate) fn service_base(input: &str, known_paths: &[&str]) -> Result<String, TranslationError> {
    let normalized = crate::net::endpoint::normalize_base_url(input)
        .map_err(|e| TranslationError::NotConfigured(format!("Invalid service address: {e}")))?;
    Ok(match crate::net::endpoint::strip_endpoint_path(input, known_paths) {
        Some((base, _)) => base,
        None => normalized.base,
    })
}

/// `base` + `path`, query kept (see `net::endpoint::join_endpoint`).
pub(crate) fn endpoint_url(base: &str, path: &str) -> Result<url::Url, TranslationError> {
    crate::net::endpoint::join_endpoint(base, path)
        .map_err(|e| TranslationError::NotConfigured(format!("Invalid service address: {e}")))
}

/// HTTP client of the cloud providers: a server that accepts the connection
/// but never answers (a dead upstream behind a proxy) fails instead of
/// leaving the line on "Translating…".
pub(crate) fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// A request or response-body failure. reqwest's message carries the whole
/// URL, whose query can hold a key (`?key=`, `?token=` in a custom address):
/// it is dropped and the address added back with secrets masked.
pub(crate) fn request_error(e: reqwest::Error, url: &str) -> TranslationError {
    TranslationError::Http(format!("{} ({})", e.without_url(), redact_url(url)))
}

// ── Provider trait ──

#[async_trait]
pub trait TranslationProvider: Send + Sync {
    fn provider_name(&self) -> &str;
    fn provider_type(&self) -> TranslationProviderType;
    fn is_local(&self) -> bool;

    async fn translate(
        &self,
        text: &str,
        source: Option<&str>,
        target: &str,
    ) -> Result<String, TranslationError>;

    async fn translate_batch(
        &self,
        texts: &[String],
        source: Option<&str>,
        target: &str,
    ) -> Result<Vec<String>, TranslationError> {
        // Default: translate one by one. Providers can override with native batch.
        let mut results = Vec::with_capacity(texts.len());
        for text in texts {
            results.push(self.translate(text, source, target).await?);
        }
        Ok(results)
    }

    async fn detect_language(&self, text: &str) -> Result<DetectedLanguage, TranslationError>;

    async fn supported_languages(&self) -> Result<Vec<Language>, TranslationError>;

    async fn test_connection(&self) -> Result<ConnectionStatus, TranslationError>;
}

// ── In-memory LRU cache for ad-hoc translations ──

struct CacheEntry {
    translated_text: String,
}

pub struct TranslationCache {
    map: HashMap<(u64, String), CacheEntry>,
    order: Vec<(u64, String)>,
    max_size: usize,
}

impl TranslationCache {
    pub fn new(max_size: usize) -> Self {
        Self {
            map: HashMap::new(),
            order: Vec::new(),
            max_size,
        }
    }

    fn text_hash(text: &str) -> u64 {
        let mut hasher = DefaultHasher::new();
        text.hash(&mut hasher);
        hasher.finish()
    }

    pub fn get(&self, text: &str, target_lang: &str) -> Option<&str> {
        let key = (Self::text_hash(text), target_lang.to_string());
        self.map.get(&key).map(|e| e.translated_text.as_str())
    }

    pub fn insert(&mut self, text: &str, target_lang: &str, translated: String) {
        let key = (Self::text_hash(text), target_lang.to_string());
        if self.map.contains_key(&key) {
            return;
        }
        if self.map.len() >= self.max_size {
            if let Some(oldest) = self.order.first().cloned() {
                self.map.remove(&oldest);
                self.order.remove(0);
            }
        }
        self.order.push(key.clone());
        self.map.insert(key, CacheEntry { translated_text: translated });
    }
}

/// The cache key part besides the text: a cached translation is reused only
/// for the same target, source, provider (LLM: connection and model) and
/// settings (`options_fingerprint`), so switching any of them translates afresh.
pub fn cache_scope(target: &str, source: Option<&str>, provider: &str, options_fingerprint: u64) -> String {
    format!("{target}\u{1f}{}\u{1f}{provider}\u{1f}{options_fingerprint:x}", source.unwrap_or(""))
}

// ── Router ──

/// API keys (and the Microsoft region) as stored in the keychain; `None` = not set.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TranslationKeys {
    pub microsoft: Option<String>,
    pub microsoft_region: Option<String>,
    pub google: Option<String>,
    pub deepl: Option<String>,
}

pub struct TranslationRouter {
    active_provider: Option<Arc<dyn TranslationProvider>>,
    active_type: Option<TranslationProviderType>,
    /// Why the last `set_provider` failed (shown instead of "no provider").
    last_error: Option<String>,
    consecutive_failures: u32,
    cache: TranslationCache,
    // Cached API keys (loaded from CredentialManager)
    keys: TranslationKeys,
    // Service addresses and LLM prompts pushed by the frontend
    options: options::TranslationOptions,
    // Default target/source language — set by frontend, used as fallback
    default_target_lang: String,
    default_source_lang: Option<String>,
    // OPUS-MT models directory and active model
    opus_mt_models_dir: Option<std::path::PathBuf>,
    opus_mt_active_model_id: Option<String>,
}

impl TranslationRouter {
    pub fn new() -> Self {
        Self {
            active_provider: None,
            active_type: None,
            last_error: None,
            consecutive_failures: 0,
            cache: TranslationCache::new(1000),
            keys: TranslationKeys::default(),
            options: options::TranslationOptions::default(),
            default_target_lang: "en".to_string(),
            default_source_lang: None,
            opus_mt_models_dir: None,
            opus_mt_active_model_id: None,
        }
    }

    pub fn active_type(&self) -> Option<&TranslationProviderType> {
        self.active_type.as_ref()
    }

    /// Replaces every key at once, so a key deleted from the keychain is forgotten too.
    pub fn set_keys(&mut self, keys: TranslationKeys) {
        self.keys = keys;
    }

    pub fn keys(&self) -> &TranslationKeys {
        &self.keys
    }

    pub fn set_microsoft_credentials(&mut self, key: String, region: Option<String>) {
        self.keys.microsoft = Some(key);
        self.keys.microsoft_region = region;
    }

    pub fn set_google_credentials(&mut self, key: String) {
        self.keys.google = Some(key);
    }

    pub fn set_deepl_credentials(&mut self, key: String) {
        self.keys.deepl = Some(key);
    }

    /// Applies the frontend's service addresses / LLM prompts (missing parts kept).
    pub fn apply_options(&mut self, patch: options::TranslationOptionsPatch) {
        self.options.apply(patch);
    }

    pub fn options(&self) -> &options::TranslationOptions {
        &self.options
    }

    /// Changes whenever the service addresses or the LLM prompts change.
    pub fn options_fingerprint(&self) -> u64 {
        let mut hasher = DefaultHasher::new();
        self.options.endpoints.hash(&mut hasher);
        self.options.llm.hash(&mut hasher);
        hasher.finish()
    }

    pub fn set_default_target_lang(&mut self, lang: String) {
        self.default_target_lang = lang;
    }

    pub fn set_default_source_lang(&mut self, lang: Option<String>) {
        self.default_source_lang = lang;
    }

    pub fn default_target_lang(&self) -> &str {
        &self.default_target_lang
    }

    pub fn default_source_lang(&self) -> Option<&str> {
        self.default_source_lang.as_deref()
    }

    pub fn set_opus_mt_models_dir(&mut self, path: std::path::PathBuf) {
        self.opus_mt_models_dir = Some(path);
    }

    pub fn set_opus_mt_active_model(&mut self, model_id: Option<String>) {
        self.opus_mt_active_model_id = model_id;
    }

    /// A provider of `provider_type` built from these keys and options, without
    /// touching the active one (also used to test unsaved settings).
    pub fn build_provider(
        &self,
        provider_type: &TranslationProviderType,
        keys: &TranslationKeys,
        options: &options::TranslationOptions,
    ) -> Result<Box<dyn TranslationProvider>, TranslationError> {
        let endpoints = &options.endpoints;
        Ok(match provider_type {
            TranslationProviderType::Microsoft => {
                let region = keys.microsoft_region.clone().or_else(|| Some("global".into()));
                Box::new(microsoft::MicrosoftTranslator::new(keys.microsoft.clone(), region, endpoints.microsoft())?)
            }
            TranslationProviderType::Google => {
                Box::new(google::GoogleTranslator::new(keys.google.clone(), endpoints.google())?)
            }
            TranslationProviderType::Deepl => {
                Box::new(deepl::DeepLTranslator::new(keys.deepl.clone(), endpoints.deepl())?)
            }
            TranslationProviderType::OpusMt => {
                let mut translator = opus_mt::OpusMtTranslator::new();
                if let Some(dir) = &self.opus_mt_models_dir {
                    translator.set_models_dir(dir.clone());
                }
                // Set the active model ID — ONNX sessions load lazily on first translate()
                // to avoid panicking inside the router's Mutex lock.
                if let Some(active_id) = &self.opus_mt_active_model_id {
                    translator.set_active_model_id(Some(active_id.clone()));
                }
                Box::new(translator)
            }
            TranslationProviderType::Llm => {
                Box::new(llm_provider::LlmTranslator::new())
            }
        })
    }

    /// Makes `provider_type` the active provider. On failure there is no
    /// active provider any more (translating with the previous one would hide
    /// the problem) and the error is kept for [`get_provider`](Self::get_provider).
    pub fn set_provider(
        &mut self,
        provider_type: TranslationProviderType,
    ) -> Result<(), TranslationError> {
        let built = self.build_provider(&provider_type, &self.keys, &self.options);
        let provider = match built {
            Ok(provider) => provider,
            Err(e) => {
                self.active_provider = None;
                self.active_type = None;
                self.last_error = Some(format!("{provider_type}: {e}"));
                log::warn!("Translation provider {} not ready: {}", provider_type, e);
                return Err(e);
            }
        };

        self.active_provider = Some(Arc::from(provider));
        self.active_type = Some(provider_type.clone());
        self.last_error = None;
        self.consecutive_failures = 0;
        log::info!("Translation provider set to: {}", provider_type);
        Ok(())
    }

    /// Get an Arc clone of the active provider — safe to hold across .await.
    /// IMPORTANT: Always clone the Arc out of the lock scope before awaiting.
    pub fn get_provider(&self) -> Result<Arc<dyn TranslationProvider>, TranslationError> {
        self.active_provider.clone().ok_or_else(|| {
            TranslationError::NotConfigured(
                self.last_error.clone().unwrap_or_else(|| "No translation provider set".into()),
            )
        })
    }

    pub fn active_provider_name(&self) -> String {
        self.active_provider
            .as_ref()
            .map(|p| p.provider_name().to_string())
            .unwrap_or_default()
    }

    pub fn cache(&self) -> &TranslationCache {
        &self.cache
    }

    pub fn cache_mut(&mut self) -> &mut TranslationCache {
        &mut self.cache
    }

    /// Increment the consecutive failure counter.
    /// Returns the new count after incrementing.
    pub fn record_failure(&mut self) -> u32 {
        self.consecutive_failures += 1;
        self.consecutive_failures
    }

    /// Reset the consecutive failure counter (call on success).
    pub fn reset_failures(&mut self) {
        self.consecutive_failures = 0;
    }

    /// Get the current consecutive failure count.
    pub fn failure_count(&self) -> u32 {
        self.consecutive_failures
    }

    /// Split long text at sentence boundaries for providers with char limits.
    pub fn split_long_text(text: &str, max_chars: usize) -> Vec<String> {
        if text.len() <= max_chars {
            return vec![text.to_string()];
        }
        let mut chunks = Vec::new();
        let mut current = String::new();
        for sentence in text.split_inclusive(|c| c == '.' || c == '!' || c == '?') {
            if current.len() + sentence.len() > max_chars && !current.is_empty() {
                chunks.push(std::mem::take(&mut current));
            }
            current.push_str(sentence);
        }
        if !current.is_empty() {
            chunks.push(current);
        }
        chunks
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(deepl: Option<&str>) -> TranslationKeys {
        TranslationKeys { deepl: deepl.map(String::from), ..Default::default() }
    }

    #[test]
    fn a_failed_switch_leaves_no_provider_and_says_why() {
        let mut router = TranslationRouter::new();
        router.set_provider(TranslationProviderType::Llm).unwrap();
        assert_eq!(router.active_type(), Some(&TranslationProviderType::Llm));

        let err = router.set_provider(TranslationProviderType::Deepl).unwrap_err();
        assert!(matches!(err, TranslationError::NoApiKey(_)));
        assert_eq!(router.active_type(), None);
        let reason = router.get_provider().err().unwrap().to_string();
        assert!(reason.contains("deepl"), "{reason}");
        assert!(reason.contains("API key missing"), "{reason}");

        router.set_keys(keys(Some("k:fx")));
        router.set_provider(TranslationProviderType::Deepl).unwrap();
        assert!(router.get_provider().is_ok());
    }

    #[test]
    fn a_custom_endpoint_works_without_a_key() {
        let mut router = TranslationRouter::new();
        router.apply_options(serde_json::from_str(r#"{"endpoints": {"deepl": "http://deeplx.lan:1188/v2"}}"#).unwrap());
        router.set_provider(TranslationProviderType::Deepl).unwrap();
        assert_eq!(router.active_provider_name(), "DeepL");
    }

    #[test]
    fn keys_removed_from_the_keychain_are_forgotten() {
        let mut router = TranslationRouter::new();
        router.set_keys(keys(Some("k")));
        router.set_provider(TranslationProviderType::Deepl).unwrap();
        router.set_keys(keys(None));
        assert!(router.set_provider(TranslationProviderType::Deepl).is_err());
    }

    #[test]
    fn build_provider_does_not_change_the_active_one() {
        let mut router = TranslationRouter::new();
        router.set_provider(TranslationProviderType::Llm).unwrap();
        let options = router.options().with(Some(
            serde_json::from_str(r#"{"endpoints": {"google": "https://proxy.lan/v2"}}"#).unwrap(),
        ));
        let google = router
            .build_provider(&TranslationProviderType::Google, &TranslationKeys::default(), &options)
            .unwrap();
        assert_eq!(google.provider_name(), "Google Cloud Translation");
        assert_eq!(router.active_type(), Some(&TranslationProviderType::Llm));
        assert_eq!(router.options().endpoints.google(), None);
    }

    #[test]
    fn cached_translations_belong_to_their_provider_and_settings() {
        let mut router = TranslationRouter::new();
        let before = router.options_fingerprint();
        let deepl = cache_scope("zh-CN", None, "DeepL", before);
        router.cache_mut().insert("Hello", &deepl, "你好".into());
        assert_eq!(router.cache().get("Hello", &deepl), Some("你好"));

        // Another provider, model, source or target misses.
        for other in [
            cache_scope("zh-CN", None, "Microsoft Translator", before),
            cache_scope("zh-CN", None, "DeepSeek · deepseek-chat", before),
            cache_scope("zh-CN", Some("en"), "DeepL", before),
            cache_scope("ja", None, "DeepL", before),
        ] {
            assert_eq!(router.cache().get("Hello", &other), None, "{other}");
        }

        // So do new prompts or addresses.
        router.apply_options(serde_json::from_str(r#"{"llm": {"glossary": "Hello => 您好"}}"#).unwrap());
        let after = router.options_fingerprint();
        assert_ne!(before, after);
        assert_eq!(router.cache().get("Hello", &cache_scope("zh-CN", None, "DeepL", after)), None);
    }

    #[test]
    fn invalid_addresses_are_reported() {
        let mut router = TranslationRouter::new();
        router.apply_options(serde_json::from_str(r#"{"endpoints": {"microsoft": "api.translator.azure.cn"}}"#).unwrap());
        let err = router.set_provider(TranslationProviderType::Microsoft).unwrap_err().to_string();
        assert!(err.contains("Invalid service address"), "{err}");
    }
}
