pub mod anthropic;
pub mod api;
pub mod cli_agent;
pub mod compat;
pub mod connections;
pub mod custom;
pub mod gemini;
pub mod gemini_cache;
pub mod http;
pub mod ollama;
pub mod openai_compat;
pub mod openrouter_models;
pub mod persist;
pub mod provider;
pub mod registry;
pub mod stream_parser;

use provider::{
    CompletionStats, GenerationParams, LLMError, LLMMessage, LLMProvider, ModelInfo, TokenSink,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;

use api::LlmKind;
use connections::LlmConnection;

/// Provider type enum matching the frontend LLMProviderType
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderType {
    Ollama,
    LmStudio,
    Openai,
    Anthropic,
    Groq,
    Gemini,
    Openrouter,
    Custom,
    /// The local Claude Code CLI on the user's own subscription login.
    ClaudeCli,
}

impl ProviderType {
    pub fn from_str(s: &str) -> Result<Self, LLMError> {
        match s {
            "ollama" => Ok(Self::Ollama),
            "lm_studio" => Ok(Self::LmStudio),
            "openai" => Ok(Self::Openai),
            "anthropic" => Ok(Self::Anthropic),
            "groq" => Ok(Self::Groq),
            "gemini" => Ok(Self::Gemini),
            "openrouter" => Ok(Self::Openrouter),
            "custom" => Ok(Self::Custom),
            "claude_cli" => Ok(Self::ClaudeCli),
            _ => Err(LLMError::NotConfigured(format!(
                "Unknown provider type: {}",
                s
            ))),
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            Self::Ollama => "ollama",
            Self::LmStudio => "lm_studio",
            Self::Openai => "openai",
            Self::Anthropic => "anthropic",
            Self::Groq => "groq",
            Self::Gemini => "gemini",
            Self::Openrouter => "openrouter",
            Self::Custom => "custom",
            Self::ClaudeCli => "claude_cli",
        }
    }

    pub fn display_name(&self) -> &str {
        match self {
            Self::Ollama => "Ollama",
            Self::LmStudio => "LM Studio",
            Self::Openai => "OpenAI",
            Self::Anthropic => "Anthropic",
            Self::Groq => "Groq",
            Self::Gemini => "Google Gemini",
            Self::Openrouter => "OpenRouter",
            Self::Custom => "Custom",
            Self::ClaudeCli => "Claude (subscription)",
        }
    }

    pub fn default_base_url(&self) -> &str {
        match self {
            Self::Ollama => "http://localhost:11434",
            Self::LmStudio => "http://localhost:1234/v1",
            Self::Openai => "https://api.openai.com/v1",
            Self::Anthropic => "https://api.anthropic.com",
            Self::Groq => "https://api.groq.com/openai/v1",
            Self::Gemini => "https://generativelanguage.googleapis.com",
            Self::Openrouter => "https://openrouter.ai/api/v1",
            Self::Custom | Self::ClaudeCli => "",
        }
    }

    pub fn requires_api_key(&self) -> bool {
        matches!(
            self,
            Self::Openai | Self::Anthropic | Self::Groq | Self::Gemini | Self::Openrouter
        )
    }

    pub fn is_local(&self) -> bool {
        matches!(self, Self::Ollama | Self::LmStudio | Self::ClaudeCli)
    }
}

/// Provider configuration used when switching providers
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub provider_type: String,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub auth_type: Option<String>,
    pub auth_value: Option<String>,
    pub auth_header: Option<String>,
}

/// Provider info returned to the frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderInfo {
    #[serde(rename = "type")]
    pub provider_type: String,
    pub name: String,
    pub base_url: String,
    pub requires_api_key: bool,
    pub is_local: bool,
}

/// Build a provider client from a config without touching any router state.
/// Used for temporary providers (browsing models, connection tests, the RAG
/// test answer). The config is mapped to the connection that reproduces its
/// provider type (`legacy-<type>`), so it runs on the same client as every
/// connection.
pub fn create_provider(config: &ProviderConfig) -> Result<Box<dyn LLMProvider>, String> {
    let (_, conn, secret) = legacy_from_config(config)?;
    build_provider(&conn, secret.as_deref(), &HashMap::new())
}

/// The legacy connection a `ProviderConfig` describes, with its secret (the
/// API key, or the custom endpoint's auth value). Cloud types need a key and
/// the custom type a base URL, as before.
pub fn legacy_from_config(
    config: &ProviderConfig,
) -> Result<(ProviderType, LlmConnection, Option<String>), String> {
    let (provider_type, conn, secret) = legacy_from_config_lenient(config)?;
    if provider_type.requires_api_key() && secret.is_none() {
        return Err(format!("{} API key required", provider_type.display_name()));
    }
    if provider_type == ProviderType::Custom && conn.base_url.is_empty() {
        return Err("Custom endpoint base URL required".to_string());
    }
    Ok((provider_type, conn, secret))
}

/// [`legacy_from_config`] without the key / base URL checks (the old
/// `set_llm_provider` may leave the key in the keychain).
pub fn legacy_from_config_lenient(
    config: &ProviderConfig,
) -> Result<(ProviderType, LlmConnection, Option<String>), String> {
    let provider_type = ProviderType::from_str(&config.provider_type).map_err(|e| match e {
        LLMError::NotConfigured(msg) => msg,
        other => other.to_string(),
    })?;
    let mut conn = connections::legacy_connection(
        &provider_type,
        config.base_url.as_deref(),
        config.auth_type.as_deref(),
        config.auth_header.as_deref(),
    );
    // These types always honoured a base URL from the config; OpenAI, Groq
    // and OpenRouter always used their own.
    if matches!(
        provider_type,
        ProviderType::Ollama | ProviderType::LmStudio | ProviderType::Anthropic | ProviderType::Gemini
    ) {
        if let Some(base) = config.base_url.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
            conn.base_url = base.to_string();
        }
    }
    conn.base_url = connections::normalize_base_for_kind(conn.kind, &conn.base_url);
    let secret = if provider_type == ProviderType::Custom {
        config.auth_value.clone()
    } else {
        config.api_key.clone()
    }
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty());
    Ok((provider_type, conn, secret))
}

/// The client for one connection: HTTP for the four protocols, the session
/// manager for the Claude subscription (it reaches the manager through the
/// `AppHandle` passed to every `stream_completion` call).
pub fn build_provider(
    conn: &LlmConnection,
    secret: Option<&str>,
    header_secrets: &HashMap<String, String>,
) -> Result<Box<dyn LLMProvider>, String> {
    match conn.kind {
        LlmKind::ClaudeCli => Ok(Box::new(cli_agent::provider::ClaudeCliProvider::new())),
        _ => http::HttpLlmClient::new(conn, secret, header_secrets)
            .map(|client| Box::new(client) as Box<dyn LLMProvider>),
    }
}

/// A shared provider behind the old `Box<dyn LLMProvider>` type: each holder
/// gets its own lock around the same client, so nobody queues on anybody.
pub struct SharedProvider(pub Arc<dyn LLMProvider>);

#[async_trait::async_trait]
impl LLMProvider for SharedProvider {
    fn provider_name(&self) -> &str {
        self.0.provider_name()
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, LLMError> {
        self.0.list_models().await
    }

    async fn test_connection(&self) -> Result<bool, LLMError> {
        self.0.test_connection().await
    }

    async fn stream_completion(
        &self,
        messages: Vec<LLMMessage>,
        model: &str,
        params: GenerationParams,
        app_handle: tauri::AppHandle,
        sink: Option<TokenSink>,
    ) -> Result<CompletionStats, LLMError> {
        self.0.stream_completion(messages, model, params, app_handle, sink).await
    }
}

/// The default route, for callers that still use the old single-provider
/// API (`AppState.llm`). The registry (`llm::registry`) keeps it in sync
/// with `llm-connections.json`; nothing here is locked while a stream runs.
pub struct LLMRouter {
    active_provider: Option<Arc<dyn LLMProvider>>,
    active_model: String,
    active_provider_type: Option<ProviderType>,
    /// Some task is routed to the Claude subscription.
    claude_in_use: bool,
}

impl LLMRouter {
    pub fn new() -> Self {
        Self {
            active_provider: None,
            active_model: String::new(),
            active_provider_type: None,
            claude_in_use: false,
        }
    }

    /// Set the active provider, creating the appropriate client.
    pub fn set_provider(
        &mut self,
        config: ProviderConfig,
    ) -> Result<(), LLMError> {
        let provider_type = ProviderType::from_str(&config.provider_type)?;
        let provider = create_provider(&config).map_err(LLMError::NotConfigured)?;

        self.active_provider = Some(Arc::from(provider));
        self.active_provider_type = Some(provider_type);
        Ok(())
    }

    /// Point the router at an already built (shared) provider.
    pub fn set_shared_provider(
        &mut self,
        provider: Option<Arc<dyn LLMProvider>>,
        provider_type: Option<ProviderType>,
    ) {
        self.active_provider = provider;
        self.active_provider_type = provider_type;
    }

    /// The active provider behind a tokio mutex, for the old call sites.
    /// Every call returns a new lock around the same client, so concurrent
    /// requests (translation and the AI assistant) never wait for each other.
    pub fn get_provider(&self) -> Result<Arc<TokioMutex<Box<dyn LLMProvider>>>, LLMError> {
        self.active_provider
            .clone()
            .map(|p| Arc::new(TokioMutex::new(Box::new(SharedProvider(p)) as Box<dyn LLMProvider>)))
            .ok_or_else(|| LLMError::NotConfigured("No LLM provider configured".to_string()))
    }

    /// The active provider itself.
    pub fn shared_provider(&self) -> Option<Arc<dyn LLMProvider>> {
        self.active_provider.clone()
    }

    /// Get the active model name.
    pub fn active_model(&self) -> &str {
        &self.active_model
    }

    /// Set the active model.
    pub fn set_active_model(&mut self, model: String) {
        self.active_model = model;
    }

    /// Get the active provider type.
    pub fn active_provider_type(&self) -> Option<&ProviderType> {
        self.active_provider_type.as_ref()
    }

    /// Whether any task is routed to the Claude subscription.
    pub fn claude_in_use(&self) -> bool {
        self.claude_in_use
    }

    pub fn set_claude_in_use(&mut self, in_use: bool) {
        self.claude_in_use = in_use;
    }

    /// Get information about all available providers.
    pub fn get_all_providers() -> Vec<ProviderInfo> {
        let all_types = [
            ProviderType::Ollama,
            ProviderType::LmStudio,
            ProviderType::Openai,
            ProviderType::Anthropic,
            ProviderType::Groq,
            ProviderType::Gemini,
            ProviderType::Openrouter,
            ProviderType::Custom,
            ProviderType::ClaudeCli,
        ];

        all_types
            .iter()
            .map(|pt| ProviderInfo {
                provider_type: pt.as_str().to_string(),
                name: pt.display_name().to_string(),
                base_url: pt.default_base_url().to_string(),
                requires_api_key: pt.requires_api_key(),
                is_local: pt.is_local(),
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(provider_type: &str, api_key: Option<&str>, base_url: Option<&str>) -> ProviderConfig {
        ProviderConfig {
            provider_type: provider_type.to_string(),
            api_key: api_key.map(String::from),
            base_url: base_url.map(String::from),
            auth_type: None,
            auth_value: None,
            auth_header: None,
        }
    }

    #[test]
    fn create_provider_does_not_touch_router() {
        let mut router = LLMRouter::new();
        router.set_provider(cfg("ollama", None, None)).unwrap();

        let temp = create_provider(&cfg("openai", Some("sk-test"), None));
        assert!(temp.is_ok());
        assert_eq!(router.active_provider_type(), Some(&ProviderType::Ollama));

        let err = create_provider(&cfg("custom", None, None)).err();
        assert!(err.is_some(), "custom without base_url must fail");
        assert_eq!(router.active_provider_type(), Some(&ProviderType::Ollama));
    }

    #[test]
    fn claude_cli_provider_type_roundtrip() {
        let pt = ProviderType::from_str("claude_cli").unwrap();
        assert_eq!(pt, ProviderType::ClaudeCli);
        assert_eq!(pt.as_str(), "claude_cli");
        assert_eq!(ProviderType::from_str(pt.as_str()).unwrap(), pt);
        assert_eq!(serde_json::to_string(&pt).unwrap(), "\"claude_cli\"");
        assert_eq!(pt.display_name(), "Claude (subscription)");
    }

    #[test]
    fn claude_cli_requires_no_key() {
        assert!(!ProviderType::ClaudeCli.requires_api_key());
        assert!(ProviderType::ClaudeCli.is_local());
        assert!(create_provider(&cfg("claude_cli", None, None)).is_ok());
        assert!(LLMRouter::get_all_providers()
            .iter()
            .any(|p| p.provider_type == "claude_cli" && !p.requires_api_key && p.is_local));
    }

    #[test]
    fn create_provider_rejects_missing_key_and_unknown_type() {
        assert!(create_provider(&cfg("openai", None, None)).is_err());
        assert!(create_provider(&cfg("nope", None, None)).is_err());
    }

    #[test]
    fn every_get_provider_call_returns_a_free_lock() {
        let mut router = LLMRouter::new();
        router.set_provider(cfg("ollama", None, None)).unwrap();
        let first = router.get_provider().unwrap();
        let second = router.get_provider().unwrap();
        // A stream holding the first lock no longer blocks the second caller.
        let _held = first.try_lock().expect("first lock is free");
        assert!(second.try_lock().is_ok(), "the second caller does not queue");
        assert!(first.try_lock().is_err(), "each lock still guards its own holder");
    }

    #[test]
    fn legacy_configs_keep_their_addresses_and_secrets() {
        let mut config = cfg("custom", None, Some(" http://h:8000/v1/ "));
        config.auth_type = Some("bearer".into());
        config.auth_value = Some(" tok ".into());
        let (pt, conn, secret) = legacy_from_config(&config).unwrap();
        assert_eq!(pt, ProviderType::Custom);
        assert_eq!(conn.base_url, "http://h:8000/v1");
        assert_eq!(secret.as_deref(), Some("tok"));
        let (_, conn, _) = legacy_from_config(&cfg("ollama", None, Some("http://10.0.0.2:11434"))).unwrap();
        assert_eq!(conn.base_url, "http://10.0.0.2:11434");
        // OpenAI ignored a base URL before; it still does.
        let (_, conn, _) = legacy_from_config(&cfg("openai", Some("k"), Some("http://evil"))).unwrap();
        assert_eq!(conn.base_url, "https://api.openai.com/v1");
    }
}
