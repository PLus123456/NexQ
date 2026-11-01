//! LLM connections and task routing (NexQ Plus): the data model stored in
//! `llm-connections.json`, its validation, the request addresses of each
//! protocol, and route resolution. Pure: no I/O, no `AppHandle`.
//!
//! JSON is snake_case and every field has a default, so files written by
//! older or newer builds still load. The frontend contract is
//! `contract-llm.md` in the shared notes.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use url::Url;

use super::api::LlmKind;
use super::provider::ModelInfo;
use super::ProviderType;
use crate::net::endpoint::{
    self, AuthConfig, AuthMode, EndpointPreview, EndpointWarning, CHAT_COMPLETIONS_PATH,
    MODELS_PATH,
};

/// Version of the file layout this build writes.
pub const SCHEMA_VERSION: u32 = 1;
/// Connect timeout when a connection sets none.
pub const DEFAULT_TIMEOUT_SECS: u32 = 10;
/// Background calls (`complete_text`) per connection when it sets no limit.
pub const DEFAULT_MAX_CONCURRENCY: u32 = 4;
/// Ollama keeps the model loaded this long when the connection sets nothing.
pub const DEFAULT_KEEP_ALIVE: &str = "30m";
/// Request-body keys `extra_body` may not override.
pub const PROTECTED_BODY_KEYS: &[&str] = &["model", "messages", "stream"];
/// Display name of the Claude subscription (the call log keys on it).
pub const CLAUDE_DISPLAY_NAME: &str = "Claude (subscription)";

impl Default for LlmKind {
    fn default() -> Self {
        Self::OpenAiCompat
    }
}

// ── Data model ──────────────────────────────────────────────────────────────

/// Where the model list comes from.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelsEndpoint {
    /// The protocol's own list (`{base}/models`, `/api/tags`…).
    #[default]
    Auto,
    /// `models_url`.
    Custom,
    /// No list: only the manual models.
    Disabled,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TemperatureMode {
    #[default]
    Pass,
    Omit,
    Fixed,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MaxTokensField {
    #[default]
    MaxTokens,
    MaxCompletionTokens,
    Omit,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningMode {
    /// Reasoning text is recognised, signalled with `llm_stream_thinking` and
    /// kept out of the answer.
    #[default]
    Auto,
    /// Reasoning fields are ignored.
    Off,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WebSearch {
    /// Gemini: `google_search`; the OpenRouter template: `:online`; else none.
    #[default]
    Auto,
    None,
    OpenrouterOnline,
    GeminiGoogleSearch,
}

/// Switches for servers that differ from the protocol's reference API.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct CompatFlags {
    pub temperature: TemperatureMode,
    pub fixed_temperature: Option<f64>,
    pub max_tokens_field: MaxTokensField,
    pub reasoning: ReasoningMode,
    pub strip_think_tags: bool,
    pub stream_usage: bool,
    /// The chat address answers 404 / 405: try Ollama's `{base}/api/chat`
    /// (the old custom endpoint did this on every failure, hiding the error).
    pub ollama_fallback_on_404: bool,
    pub keep_alive: Option<String>,
    pub web_search: WebSearch,
}

impl Default for CompatFlags {
    fn default() -> Self {
        Self {
            temperature: TemperatureMode::Pass,
            fixed_temperature: None,
            max_tokens_field: MaxTokensField::MaxTokens,
            reasoning: ReasoningMode::Auto,
            strip_think_tags: true,
            stream_usage: false,
            ollama_fallback_on_404: false,
            keep_alive: None,
            web_search: WebSearch::Auto,
        }
    }
}

impl CompatFlags {
    /// Defaults for a new connection of `kind`.
    pub fn for_kind(kind: LlmKind) -> Self {
        let mut flags = Self::default();
        if kind == LlmKind::Anthropic {
            // Current Claude models reject sampling parameters with a 400.
            flags.temperature = TemperatureMode::Omit;
        }
        flags
    }
}

/// Request parameters: a connection's defaults or a route's overrides.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RouteParams {
    pub temperature: Option<f64>,
    pub max_tokens: Option<u64>,
    /// Merged into the request body (JSON Merge Patch).
    pub extra_body: Option<Map<String, Value>>,
}

impl RouteParams {
    pub fn is_empty(&self) -> bool {
        self.temperature.is_none()
            && self.max_tokens.is_none()
            && self.extra_body.as_ref().is_none_or(Map::is_empty)
    }
}

/// A custom request header. A secret value lives in the keychain
/// (`llm:<id>:h:<name>`); the file and the view keep it empty.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct LlmHeader {
    pub name: String,
    pub value: String,
    pub secret: bool,
    /// A secret value is stored in the keychain.
    pub value_saved: bool,
}

/// The last `/models` answer, kept so both windows (and offline starts) see it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ModelCache {
    pub models: Vec<ModelInfoRecord>,
    pub fetched_at_ms: i64,
    pub url: Option<String>,
    pub error: Option<String>,
}

/// `ModelInfo` as stored (every field defaulted).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ModelInfoRecord {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub context_window: Option<u64>,
}

impl From<ModelInfo> for ModelInfoRecord {
    fn from(m: ModelInfo) -> Self {
        Self { id: m.id, name: m.name, provider: m.provider, context_window: m.context_window }
    }
}

impl From<ModelInfoRecord> for ModelInfo {
    fn from(m: ModelInfoRecord) -> Self {
        Self { id: m.id, name: m.name, provider: m.provider, context_window: m.context_window }
    }
}

/// One configured LLM endpoint.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct LlmConnection {
    pub id: String,
    pub name: String,
    pub template: Option<String>,
    pub kind: LlmKind,
    pub enabled: bool,
    pub base_url: String,
    pub chat_url_override: Option<String>,
    pub models_endpoint: ModelsEndpoint,
    pub models_url: Option<String>,
    pub auth: AuthConfig,
    pub headers: Vec<LlmHeader>,
    pub default_model: Option<String>,
    pub manual_models: Vec<String>,
    pub params: RouteParams,
    pub compat: CompatFlags,
    pub timeout_secs: Option<u32>,
    pub max_concurrency: Option<u32>,
    /// Keychain account of the secret (`llm:<id>`, or a migrated old slot).
    pub secret_ref: Option<String>,
    /// `…ab12` once known.
    pub secret_hint: Option<String>,
    pub model_cache: Option<ModelCache>,
    pub verified_at_ms: Option<i64>,
    pub created_at_ms: Option<i64>,
}

impl Default for LlmConnection {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            template: None,
            kind: LlmKind::OpenAiCompat,
            enabled: true,
            base_url: String::new(),
            chat_url_override: None,
            models_endpoint: ModelsEndpoint::Auto,
            models_url: None,
            auth: AuthConfig::default(),
            headers: Vec::new(),
            default_model: None,
            manual_models: Vec::new(),
            params: RouteParams::default(),
            compat: CompatFlags::default(),
            timeout_secs: None,
            max_concurrency: None,
            secret_ref: None,
            secret_hint: None,
            model_cache: None,
            verified_at_ms: None,
            created_at_ms: None,
        }
    }
}

/// A route's target: a connection and, optionally, its model.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct RouteTarget {
    pub connection_id: String,
    /// `None`: the connection's default model.
    pub model: Option<String>,
}

/// One task's route: `target: None` follows the parent task.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct TaskRoute {
    pub target: Option<RouteTarget>,
    pub params: RouteParams,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct TaskRouting {
    pub default: TaskRoute,
    pub tasks: BTreeMap<String, TaskRoute>,
}

impl TaskRouting {
    pub fn get(&self, key: &str) -> Option<&TaskRoute> {
        if key == "default" {
            Some(&self.default)
        } else {
            self.tasks.get(key)
        }
    }
}

/// Where the connections came from.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MigrationInfo {
    /// `"legacy_config"` | `"fresh"`.
    pub source: String,
    pub at_ms: i64,
    pub legacy_provider: Option<String>,
    pub legacy_model: Option<String>,
    pub connections: Vec<String>,
}

/// `llm-connections.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct LlmConfigFile {
    pub schema_version: u32,
    pub revision: u64,
    pub connections: Vec<LlmConnection>,
    pub routing: TaskRouting,
    /// `"ui"` | `"transcript"` | a language code.
    pub response_language: String,
    pub migration: Option<MigrationInfo>,
}

impl Default for LlmConfigFile {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            revision: 0,
            connections: Vec::new(),
            routing: TaskRouting::default(),
            response_language: "ui".to_string(),
            migration: None,
        }
    }
}

impl LlmConfigFile {
    pub fn connection(&self, id: &str) -> Option<&LlmConnection> {
        self.connections.iter().find(|c| c.id == id)
    }

    pub fn connection_mut(&mut self, id: &str) -> Option<&mut LlmConnection> {
        self.connections.iter_mut().find(|c| c.id == id)
    }

    /// The connection the default route points at.
    pub fn default_connection(&self) -> Option<&LlmConnection> {
        let target = self.routing.default.target.as_ref()?;
        self.connection(&target.connection_id)
    }
}

impl LlmConnection {
    /// The old provider type this connection stands for (the footer picker,
    /// the `llmProvider` mirror and the `set_llm_provider` shim use it).
    pub fn legacy_type(&self) -> &'static str {
        match self.kind {
            LlmKind::ClaudeCli => "claude_cli",
            LlmKind::Anthropic => "anthropic",
            LlmKind::Gemini => "gemini",
            LlmKind::Ollama => "ollama",
            LlmKind::OpenAiCompat => match self.template.as_deref() {
                Some("openai") => "openai",
                Some("groq") => "groq",
                Some("openrouter") => "openrouter",
                Some("lm_studio") => "lm_studio",
                _ => "custom",
            },
        }
    }

    /// Name shown in stream events and stored with answers.
    pub fn display_name(&self) -> String {
        if self.kind == LlmKind::ClaudeCli {
            return CLAUDE_DISPLAY_NAME.to_string();
        }
        let name = self.name.trim();
        if name.is_empty() {
            kind_label(self.kind).to_string()
        } else {
            name.to_string()
        }
    }

    pub fn timeout_secs(&self) -> u32 {
        self.timeout_secs.filter(|s| *s > 0).unwrap_or(DEFAULT_TIMEOUT_SECS)
    }

    pub fn max_concurrency(&self) -> usize {
        self.max_concurrency.filter(|n| *n > 0).unwrap_or(DEFAULT_MAX_CONCURRENCY) as usize
    }

    /// Keychain account of a secret header's value.
    pub fn header_secret_account(&self, header: &str) -> String {
        format!("llm:{}:h:{}", self.id, header.trim().to_ascii_lowercase())
    }

    /// Web search mechanism after resolving `auto`.
    pub fn web_search(&self) -> WebSearch {
        match self.compat.web_search {
            WebSearch::Auto => match self.kind {
                LlmKind::Gemini => WebSearch::GeminiGoogleSearch,
                LlmKind::OpenAiCompat if self.is_openrouter() => WebSearch::OpenrouterOnline,
                _ => WebSearch::None,
            },
            other => other,
        }
    }

    /// The OpenRouter template, or a base URL on openrouter.ai.
    pub fn is_openrouter(&self) -> bool {
        self.template.as_deref() == Some("openrouter")
            || Url::parse(self.base_url.trim())
                .ok()
                .and_then(|u| u.host_str().map(|h| h.ends_with("openrouter.ai")))
                .unwrap_or(false)
    }
}

/// Fallback display name of a kind.
pub fn kind_label(kind: LlmKind) -> &'static str {
    match kind {
        LlmKind::OpenAiCompat => "OpenAI-compatible",
        LlmKind::Anthropic => "Anthropic",
        LlmKind::Gemini => "Google Gemini",
        LlmKind::Ollama => "Ollama",
        LlmKind::ClaudeCli => CLAUDE_DISPLAY_NAME,
    }
}

/// Default auth of a new connection of `kind`.
pub fn auth_for_kind(kind: LlmKind) -> AuthConfig {
    match kind {
        LlmKind::OpenAiCompat => AuthConfig { mode: AuthMode::Bearer, ..Default::default() },
        LlmKind::Anthropic => header_auth("x-api-key"),
        LlmKind::Gemini => header_auth("x-goog-api-key"),
        LlmKind::Ollama | LlmKind::ClaudeCli => AuthConfig::default(),
    }
}

fn header_auth(name: &str) -> AuthConfig {
    AuthConfig { mode: AuthMode::Header, header_name: name.to_string(), prefix: String::new() }
}

/// A new connection id: `c_<8 hex>`.
pub fn new_connection_id() -> String {
    let hex = uuid::Uuid::new_v4().simple().to_string();
    format!("c_{}", &hex[..8])
}

/// `…ab12`: the last four characters of a secret (never more than half of it).
pub fn secret_hint(secret: &str) -> Option<String> {
    let chars: Vec<char> = secret.trim().chars().collect();
    if chars.is_empty() {
        return None;
    }
    let shown = (chars.len() / 2).min(4);
    let tail: String = chars[chars.len() - shown..].iter().collect();
    Some(format!("…{tail}"))
}

// ── Legacy provider types ───────────────────────────────────────────────────

/// Connection id of a legacy provider type.
pub fn legacy_id(provider_type: &str) -> String {
    format!("legacy-{provider_type}")
}

/// The connection that reproduces an old provider type exactly: its default
/// address, its auth, its keychain slot. The custom type takes `custom_base_url`
/// and `custom_auth` (`"bearer"`, `"api_key"` / `"api-key"`, else none, with
/// `auth_header` naming the header).
pub fn legacy_connection(
    provider_type: &ProviderType,
    custom_base_url: Option<&str>,
    custom_auth: Option<&str>,
    auth_header: Option<&str>,
) -> LlmConnection {
    let kind = LlmKind::from_provider_type(provider_type);
    let type_key = provider_type.as_str();
    let mut conn = LlmConnection {
        id: legacy_id(type_key),
        name: provider_type.display_name().to_string(),
        template: Some(type_key.to_string()),
        kind,
        base_url: provider_type.default_base_url().to_string(),
        auth: auth_for_kind(kind),
        compat: CompatFlags::for_kind(kind),
        ..Default::default()
    };
    match provider_type {
        ProviderType::Ollama | ProviderType::LmStudio => conn.auth = AuthConfig::default(),
        ProviderType::ClaudeCli => conn.models_endpoint = ModelsEndpoint::Disabled,
        ProviderType::Openai => conn.compat.max_tokens_field = MaxTokensField::MaxCompletionTokens,
        ProviderType::Openrouter => {
            conn.headers = vec![
                plain_header("HTTP-Referer", "https://nexq.app"),
                plain_header("X-Title", "NexQ Plus"),
            ];
        }
        ProviderType::Custom => {
            conn.base_url = custom_base_url.unwrap_or_default().trim().to_string();
            conn.auth = match custom_auth {
                Some("bearer") => AuthConfig { mode: AuthMode::Bearer, ..Default::default() },
                Some("api_key") | Some("api-key") => {
                    header_auth(auth_header.map(str::trim).filter(|h| !h.is_empty()).unwrap_or("x-api-key"))
                }
                _ => AuthConfig::default(),
            };
            // The old custom endpoint tried Ollama's API when the
            // OpenAI-compatible one failed; now only on 404 / 405.
            conn.compat.ollama_fallback_on_404 = true;
        }
        ProviderType::Anthropic | ProviderType::Groq | ProviderType::Gemini => {}
    }
    if provider_type.requires_api_key() || *provider_type == ProviderType::Custom {
        conn.secret_ref = Some(type_key.to_string());
    }
    conn
}

fn plain_header(name: &str, value: &str) -> LlmHeader {
    LlmHeader { name: name.to_string(), value: value.to_string(), ..Default::default() }
}

// ── Validation ──────────────────────────────────────────────────────────────

/// Trims and tidies a connection before it is saved: base URL normalized
/// (a pasted full endpoint is cut back to the base), blank strings dropped,
/// manual models de-duplicated.
pub fn normalize_connection(conn: &mut LlmConnection) {
    conn.name = conn.name.trim().to_string();
    conn.base_url = normalize_base_for_kind(conn.kind, &conn.base_url);
    conn.chat_url_override = trimmed(conn.chat_url_override.take());
    conn.models_url = trimmed(conn.models_url.take());
    conn.default_model = trimmed(conn.default_model.take());
    conn.template = trimmed(conn.template.take());
    let mut seen = std::collections::HashSet::new();
    conn.manual_models = std::mem::take(&mut conn.manual_models)
        .into_iter()
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty() && seen.insert(m.clone()))
        .collect();
    conn.headers.retain(|h| !h.name.trim().is_empty());
    for header in &mut conn.headers {
        header.name = header.name.trim().to_string();
        if !header.secret {
            header.value = header.value.trim().to_string();
            header.value_saved = false;
        }
    }
    conn.auth.header_name = conn.auth.header_name.trim().to_string();
    conn.auth.prefix = conn.auth.prefix.trim().to_string();
    if conn.kind == LlmKind::ClaudeCli {
        conn.base_url.clear();
        conn.models_endpoint = ModelsEndpoint::Disabled;
    }
    if let Some(extra) = conn.params.extra_body.as_ref() {
        if extra.is_empty() {
            conn.params.extra_body = None;
        }
    }
}

fn trimmed(value: Option<String>) -> Option<String> {
    value.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// The base URL as stored: normalized, and with a pasted endpoint path
/// (`/chat/completions`, `/v1/messages`, `/api/chat`) cut off. Invalid input
/// is kept as typed (validation reports it).
pub fn normalize_base_for_kind(kind: LlmKind, input: &str) -> String {
    let Ok(normalized) = endpoint::normalize_base_url(input) else {
        return input.trim().to_string();
    };
    let paths: &[&str] = match kind {
        LlmKind::OpenAiCompat => &[CHAT_COMPLETIONS_PATH],
        LlmKind::Anthropic => &["/v1/messages"],
        LlmKind::Ollama => &["/api/chat"],
        LlmKind::Gemini | LlmKind::ClaudeCli => &[],
    };
    match endpoint::strip_endpoint_path(&normalized.base, paths) {
        Some((base, _)) => base,
        None => normalized.base,
    }
}

/// Why a connection can't be saved (English; shown inside a translated wrapper).
pub fn validate_connection(conn: &LlmConnection) -> Result<(), String> {
    if conn.kind != LlmKind::ClaudeCli && !conn.base_url.trim().is_empty() {
        endpoint::normalize_base_url(&conn.base_url).map_err(|e| e.to_string())?;
    }
    if let Some(url) = &conn.chat_url_override {
        check_full_url(&url.replace("{model}", "model"), "chat URL override")?;
    }
    if conn.models_endpoint == ModelsEndpoint::Custom {
        let url = conn.models_url.as_deref().unwrap_or_default();
        check_full_url(url, "models URL")?;
    }
    if conn.auth.mode == AuthMode::Header {
        endpoint::auth_headers(&conn.auth, Some("x")).map_err(|e| e.to_string())?;
    }
    for header in &conn.headers {
        if !endpoint::is_valid_header_name(&header.name) {
            return Err(format!("Invalid header name \"{}\"", header.name));
        }
        if header.value.bytes().any(|b| (b < 0x20 && b != b'\t') || b == 0x7f) {
            return Err(format!(
                "The value of header \"{}\" contains a line break or control character",
                header.name
            ));
        }
    }
    validate_params(&conn.params)?;
    if let Some(t) = conn.compat.fixed_temperature {
        if !t.is_finite() {
            return Err("Fixed temperature must be a number".to_string());
        }
    }
    if conn.compat.temperature == TemperatureMode::Fixed && conn.compat.fixed_temperature.is_none() {
        return Err("Fixed temperature mode needs a temperature value".to_string());
    }
    if conn.timeout_secs.is_some_and(|t| t == 0 || t > 600) {
        return Err("Timeout must be between 1 and 600 seconds".to_string());
    }
    if conn.max_concurrency.is_some_and(|n| n == 0 || n > 64) {
        return Err("Concurrency limit must be between 1 and 64".to_string());
    }
    Ok(())
}

/// Route / connection parameters: a finite temperature, and an `extra_body`
/// that leaves `model`, `messages` and `stream` alone.
pub fn validate_params(params: &RouteParams) -> Result<(), String> {
    if params.temperature.is_some_and(|t| !t.is_finite()) {
        return Err("Temperature must be a number".to_string());
    }
    if let Some(extra) = &params.extra_body {
        if let Some(key) = PROTECTED_BODY_KEYS.iter().find(|k| extra.contains_key(**k)) {
            return Err(format!("extra_body may not set \"{key}\""));
        }
    }
    Ok(())
}

fn check_full_url(url: &str, label: &str) -> Result<(), String> {
    let parsed = Url::parse(url.trim()).map_err(|e| format!("Invalid {label}: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none_or(str::is_empty) {
        return Err(format!("Invalid {label}: it must start with http:// or https://"));
    }
    Ok(())
}

/// Scheme + host + port of a base URL (the secret is bound to it).
pub fn base_origin(base_url: &str) -> Option<String> {
    let url = endpoint::normalize_base_url(base_url).ok()?.url;
    Some(url.origin().ascii_serialization())
}

fn url_origin(url: &str) -> Option<String> {
    Url::parse(url.trim())
        .ok()
        .filter(|u| matches!(u.scheme(), "http" | "https"))
        .map(|u| u.origin().ascii_serialization())
}

/// Origins (scheme + host + port) of every address `conn` sends its secret
/// to: the base URL, the chat URL override and a custom model list address.
pub fn connection_origins(conn: &LlmConnection) -> std::collections::BTreeSet<String> {
    let mut origins = std::collections::BTreeSet::new();
    origins.extend(base_origin(&conn.base_url));
    if let Some(url) = &conn.chat_url_override {
        origins.extend(url_origin(&url.replace("{model}", "m")));
    }
    if conn.models_endpoint == ModelsEndpoint::Custom {
        if let Some(url) = &conn.models_url {
            origins.extend(url_origin(url));
        }
    }
    origins
}

/// Whether a saved secret may still be sent by `next`: same kind, and no
/// address on a server the secret was not given for.
pub fn secret_stays_valid(previous: &LlmConnection, next: &LlmConnection) -> bool {
    if previous.kind != next.kind {
        return false;
    }
    if previous.kind == LlmKind::ClaudeCli {
        return true;
    }
    let trusted = connection_origins(previous);
    connection_origins(next).iter().all(|origin| trusted.contains(origin))
}

// ── Request addresses ───────────────────────────────────────────────────────

/// The addresses one connection talks to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoints {
    /// Chat address; may contain `{model}` (filled per request with [`chat_url_for`]).
    pub chat: Result<String, String>,
    /// Model list address; `None` when the list is disabled.
    pub models: Option<Result<String, String>>,
}

/// Chat and model-list addresses of `conn` (rules: `contract-llm.md` §6).
pub fn endpoints(conn: &LlmConnection) -> Endpoints {
    let previews = preview(conn);
    Endpoints {
        chat: preview_result(&previews.chat),
        models: previews.models.as_ref().map(preview_result),
    }
}

fn preview_result(preview: &EndpointPreview) -> Result<String, String> {
    match (&preview.url, &preview.error) {
        (Some(url), _) => Ok(url.clone()),
        (None, Some(err)) => Err(err.to_string()),
        (None, None) => Err("No address".to_string()),
    }
}

/// [`endpoints`] with warnings, for `llm_preview_endpoints`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EndpointsPreview {
    pub chat: EndpointPreview,
    pub models: Option<EndpointPreview>,
    pub kind_warnings: Vec<String>,
}

pub fn preview(conn: &LlmConnection) -> EndpointsPreview {
    let base = conn.base_url.as_str();
    let mut kind_warnings = Vec::new();
    let (chat, models) = match conn.kind {
        LlmKind::ClaudeCli => (fixed_preview(None), None),
        LlmKind::OpenAiCompat => {
            let chat = match &conn.chat_url_override {
                Some(url) => {
                    if !url.contains("{model}") {
                        kind_warnings.push("chat_override_no_model".to_string());
                    }
                    override_preview(url)
                }
                None => endpoint::preview_endpoint(base, CHAT_COMPLETIONS_PATH),
            };
            let models = models_preview(conn, || endpoint::preview_endpoint(base, MODELS_PATH));
            (chat, models)
        }
        LlmKind::Anthropic => {
            let chat = conn
                .chat_url_override
                .as_deref()
                .map(override_preview)
                .unwrap_or_else(|| versioned_preview(base, "/v1", "/messages"));
            let models = models_preview(conn, || versioned_preview(base, "/v1", "/models"));
            (chat, models)
        }
        LlmKind::Gemini => {
            let chat = conn.chat_url_override.as_deref().map(override_preview).unwrap_or_else(|| {
                let mut preview = versioned_preview(base, "/v1beta", "/models/{model}:streamGenerateContent");
                if let Some(url) = preview.url.as_mut() {
                    *url = add_query(&restore_model_placeholder(url), "alt", "sse");
                }
                preview
            });
            let models = models_preview(conn, || versioned_preview(base, "/v1beta", "/models"));
            (chat, models)
        }
        LlmKind::Ollama => {
            if endpoint::normalize_base_url(base)
                .map(|n| n.url.path().trim_end_matches('/').ends_with("/v1"))
                .unwrap_or(false)
            {
                kind_warnings.push("looks_openai_compat".to_string());
            }
            let chat = conn
                .chat_url_override
                .as_deref()
                .map(override_preview)
                .unwrap_or_else(|| endpoint::preview_endpoint(base, "/api/chat"));
            let models = models_preview(conn, || endpoint::preview_endpoint(base, "/api/tags"));
            (chat, models)
        }
    };
    if conn.kind != LlmKind::ClaudeCli && is_plain_http_remote(base) {
        kind_warnings.push("plain_http_remote".to_string());
    }
    EndpointsPreview { chat, models, kind_warnings }
}

fn models_preview(conn: &LlmConnection, auto: impl FnOnce() -> EndpointPreview) -> Option<EndpointPreview> {
    match conn.models_endpoint {
        ModelsEndpoint::Disabled => None,
        ModelsEndpoint::Custom => Some(override_preview(conn.models_url.as_deref().unwrap_or_default())),
        ModelsEndpoint::Auto => Some(auto()),
    }
}

/// `{base}{version}{path}`, without repeating `version` when the base already
/// ends with it.
fn versioned_preview(base: &str, version: &str, path: &str) -> EndpointPreview {
    let ends_with_version = endpoint::normalize_base_url(base)
        .map(|n| n.url.path().trim_end_matches('/').ends_with(version))
        .unwrap_or(false);
    let suffix = if ends_with_version { path.to_string() } else { format!("{version}{path}") };
    let mut preview = endpoint::preview_endpoint(base, &suffix);
    // A host-only base is normal for these protocols (the version is fixed).
    preview.warnings.retain(|w| *w != EndpointWarning::NoVersionPrefix);
    preview
}

/// A full URL typed by the user (override fields), checked like a base URL.
fn override_preview(url: &str) -> EndpointPreview {
    let mut preview = endpoint::preview_endpoint(url, "");
    preview.warnings.clear();
    if let Some(url) = preview.url.as_mut() {
        *url = restore_model_placeholder(url);
    }
    preview
}

/// The URL parser percent-encodes `{model}` in paths; put the placeholder back.
fn restore_model_placeholder(url: &str) -> String {
    url.replace("%7Bmodel%7D", "{model}").replace("%7bmodel%7d", "{model}")
}

fn fixed_preview(url: Option<String>) -> EndpointPreview {
    EndpointPreview { url, warnings: Vec::new(), error: None }
}

fn add_query(url: &str, key: &str, value: &str) -> String {
    match Url::parse(url) {
        Ok(mut parsed) => {
            parsed.query_pairs_mut().append_pair(key, value);
            restore_model_placeholder(parsed.as_str())
        }
        Err(_) => url.to_string(),
    }
}

fn is_plain_http_remote(base: &str) -> bool {
    let Ok(normalized) = endpoint::normalize_base_url(base) else {
        return false;
    };
    let url = normalized.url;
    if url.scheme() != "http" {
        return false;
    }
    match url.host() {
        Some(url::Host::Domain(host)) => {
            let host = host.to_ascii_lowercase();
            !(host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local"))
        }
        Some(url::Host::Ipv4(ip)) => !(ip.is_loopback() || ip.is_private() || ip.is_link_local()),
        Some(url::Host::Ipv6(ip)) => !ip.is_loopback(),
        None => false,
    }
}

/// The chat address for `model`: `{model}` replaced by the URL-encoded name.
pub fn chat_url_for(chat_url: &str, model: &str) -> String {
    if !chat_url.contains("{model}") {
        return chat_url.to_string();
    }
    let encoded: String = url::form_urlencoded::byte_serialize(model.as_bytes())
        .collect::<String>()
        .replace('+', "%20");
    chat_url.replace("{model}", &encoded)
}

// ── Task routing ────────────────────────────────────────────────────────────

/// Routing keys with their parent, in display order (`contract-llm.md` §5).
pub const KNOWN_TASKS: &[(&str, Option<&str>)] = &[
    ("default", None),
    ("assist", Some("default")),
    ("meeting_summary", Some("default")),
    ("action_items", Some("default")),
    ("bookmark_suggestions", Some("default")),
    ("meeting_ask", Some("default")),
    ("translation", Some("default")),
    ("translation_batch", Some("translation")),
    ("rag_answer", Some("default")),
    ("claude_fallback", Some("default")),
];

/// The task a key falls back to: `assist:<mode>` → `assist`, the known keys
/// per [`KNOWN_TASKS`], anything else → `default`.
pub fn task_parent(key: &str) -> Option<&'static str> {
    if key == "default" {
        return None;
    }
    if key.starts_with("assist:") {
        return Some("assist");
    }
    KNOWN_TASKS
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, parent)| *parent)
        .unwrap_or(Some("default"))
}

/// Whether `key` may be routed (`default`, a known key, `assist:<mode>`, or
/// another lowercase key reserved for later tasks).
pub fn is_valid_task_key(key: &str) -> bool {
    if let Some(mode) = key.strip_prefix("assist:") {
        return !mode.is_empty() && mode.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    }
    !key.is_empty() && key.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// Why a task has no usable target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteError {
    NotConfigured,
    /// Nothing resolved and a route on the way pointed at a deleted connection.
    ConnectionMissing,
    ConnectionDisabled,
    NoModel,
    BaseUrlMissing,
}

impl RouteError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotConfigured => "not_configured",
            Self::ConnectionMissing => "connection_missing",
            Self::ConnectionDisabled => "connection_disabled",
            Self::NoModel => "no_model",
            Self::BaseUrlMissing => "base_url_missing",
        }
    }
}

/// A task resolved to a connection (no Claude fallback applied yet).
#[derive(Debug, Clone, PartialEq)]
pub struct RouteResolution {
    /// Key of the route whose target applies.
    pub source: String,
    pub connection: LlmConnection,
    /// `None` for the Claude subscription (its settings pick the model).
    pub model: Option<String>,
    /// Route parameter overrides, farthest first (the source route) to the
    /// task's own route last.
    pub overrides: Vec<RouteParams>,
}

/// Resolves `key` along its parent chain (see `contract-llm.md` §5). Targets
/// pointing at a deleted connection are skipped like an unset target.
pub fn resolve_route(cfg: &LlmConfigFile, key: &str) -> Result<RouteResolution, (RouteError, Option<LlmConnection>)> {
    let mut overrides = Vec::new();
    let mut current = Some(key.to_string());
    let mut guard = 0;
    let mut saw_missing = false;
    while let Some(task) = current {
        guard += 1;
        if guard > 8 {
            break;
        }
        if let Some(route) = cfg.routing.get(&task) {
            if !route.params.is_empty() {
                overrides.push(route.params.clone());
            }
            if let Some(target) = &route.target {
                if let Some(conn) = cfg.connection(&target.connection_id) {
                    overrides.reverse();
                    return finish_resolution(task, conn, target, overrides);
                }
                saw_missing = true;
            }
        }
        current = task_parent(&task).map(str::to_string);
    }
    let error = if saw_missing { RouteError::ConnectionMissing } else { RouteError::NotConfigured };
    Err((error, None))
}

fn finish_resolution(
    source: String,
    conn: &LlmConnection,
    target: &RouteTarget,
    overrides: Vec<RouteParams>,
) -> Result<RouteResolution, (RouteError, Option<LlmConnection>)> {
    if !conn.enabled {
        return Err((RouteError::ConnectionDisabled, Some(conn.clone())));
    }
    if conn.kind != LlmKind::ClaudeCli && conn.base_url.trim().is_empty() && conn.chat_url_override.is_none() {
        return Err((RouteError::BaseUrlMissing, Some(conn.clone())));
    }
    let model = if conn.kind == LlmKind::ClaudeCli {
        None
    } else {
        let model = target
            .model
            .as_deref()
            .map(str::trim)
            .filter(|m| !m.is_empty())
            .map(str::to_string)
            .or_else(|| conn.default_model.clone().filter(|m| !m.trim().is_empty()));
        match model {
            Some(model) => Some(model),
            None => return Err((RouteError::NoModel, Some(conn.clone()))),
        }
    };
    Ok(RouteResolution { source, connection: conn.clone(), model, overrides })
}

/// Removes every route that targets `id`; returns their task keys.
pub fn clear_routes_to(routing: &mut TaskRouting, id: &str) -> Vec<String> {
    let mut cleared = Vec::new();
    if routing.default.target.as_ref().is_some_and(|t| t.connection_id == id) {
        routing.default.target = None;
        cleared.push("default".to_string());
    }
    for (key, route) in routing.tasks.iter_mut() {
        if route.target.as_ref().is_some_and(|t| t.connection_id == id) {
            route.target = None;
            cleared.push(key.clone());
        }
    }
    routing.tasks.retain(|_, route| route.target.is_some() || !route.params.is_empty());
    cleared
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn conn(id: &str, kind: LlmKind, base: &str) -> LlmConnection {
        LlmConnection {
            id: id.to_string(),
            name: id.to_string(),
            kind,
            base_url: base.to_string(),
            default_model: Some(format!("{id}-model")),
            ..Default::default()
        }
    }

    fn target(id: &str, model: Option<&str>) -> Option<RouteTarget> {
        Some(RouteTarget { connection_id: id.to_string(), model: model.map(str::to_string) })
    }

    fn chat(conn: &LlmConnection) -> String {
        endpoints(conn).chat.unwrap()
    }

    fn models(conn: &LlmConnection) -> Option<String> {
        endpoints(conn).models.map(|m| m.unwrap())
    }

    #[test]
    fn openai_compat_addresses_keep_the_typed_version_prefix() {
        let c = conn("a", LlmKind::OpenAiCompat, "https://open.bigmodel.cn/api/paas/v4/");
        assert_eq!(chat(&c), "https://open.bigmodel.cn/api/paas/v4/chat/completions");
        assert_eq!(models(&c).unwrap(), "https://open.bigmodel.cn/api/paas/v4/models");
        let c = conn("a", LlmKind::OpenAiCompat, "https://ark.cn-beijing.volces.com/api/v3");
        assert_eq!(chat(&c), "https://ark.cn-beijing.volces.com/api/v3/chat/completions");
        let c = conn("a", LlmKind::OpenAiCompat, "https://x.openai.azure.com/openai/deployments/gpt4o?api-version=2024-10-21");
        assert_eq!(chat(&c), "https://x.openai.azure.com/openai/deployments/gpt4o/chat/completions?api-version=2024-10-21");
        // Host only: nothing is added, the preview warns.
        let c = conn("a", LlmKind::OpenAiCompat, "http://192.168.1.10:8000");
        assert_eq!(chat(&c), "http://192.168.1.10:8000/chat/completions");
        assert_eq!(preview(&c).chat.warnings, vec![EndpointWarning::NoVersionPrefix]);
    }

    #[test]
    fn overrides_and_disabled_model_lists() {
        let mut c = conn("a", LlmKind::OpenAiCompat, "https://gw.example.com/llm");
        c.chat_url_override = Some("https://gw.example.com/deploy/{model}/chat?v=2".to_string());
        assert_eq!(chat_url_for(&chat(&c), "gpt 4o/mini"), "https://gw.example.com/deploy/gpt%204o%2Fmini/chat?v=2");
        c.models_endpoint = ModelsEndpoint::Disabled;
        assert_eq!(models(&c), None);
        c.models_endpoint = ModelsEndpoint::Custom;
        c.models_url = Some("https://gw.example.com/list".to_string());
        assert_eq!(models(&c).unwrap(), "https://gw.example.com/list");
        c.chat_url_override = Some("https://gw.example.com/fixed".to_string());
        assert_eq!(preview(&c).kind_warnings, vec!["chat_override_no_model".to_string()]);
    }

    #[test]
    fn anthropic_gemini_and_ollama_addresses() {
        let c = conn("a", LlmKind::Anthropic, "https://api.anthropic.com");
        assert_eq!(chat(&c), "https://api.anthropic.com/v1/messages");
        assert_eq!(models(&c).unwrap(), "https://api.anthropic.com/v1/models");
        let c = conn("a", LlmKind::Anthropic, "https://api.deepseek.com/anthropic");
        assert_eq!(chat(&c), "https://api.deepseek.com/anthropic/v1/messages");
        let c = conn("a", LlmKind::Anthropic, "https://proxy.example.com/v1");
        assert_eq!(chat(&c), "https://proxy.example.com/v1/messages");
        assert_eq!(models(&c).unwrap(), "https://proxy.example.com/v1/models");
        assert!(preview(&c).chat.warnings.is_empty());

        let c = conn("a", LlmKind::Gemini, "https://generativelanguage.googleapis.com");
        assert_eq!(
            chat_url_for(&chat(&c), "gemini-2.5-flash"),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse"
        );
        assert_eq!(models(&c).unwrap(), "https://generativelanguage.googleapis.com/v1beta/models");
        assert!(!chat(&c).contains("key="));
        let c = conn("a", LlmKind::Gemini, "https://proxy.example.com/v1beta");
        assert_eq!(chat_url_for(&chat(&c), "g"), "https://proxy.example.com/v1beta/models/g:streamGenerateContent?alt=sse");

        let c = conn("a", LlmKind::Ollama, "http://192.168.1.10:11434");
        assert_eq!(chat(&c), "http://192.168.1.10:11434/api/chat");
        assert_eq!(models(&c).unwrap(), "http://192.168.1.10:11434/api/tags");
        assert!(preview(&c).kind_warnings.is_empty(), "a LAN address is not a remote plain-http host");
        let c = conn("a", LlmKind::Ollama, "http://localhost:11434/v1");
        assert!(preview(&c).kind_warnings.contains(&"looks_openai_compat".to_string()));
        let c = conn("a", LlmKind::OpenAiCompat, "http://example.com/v1");
        assert!(preview(&c).kind_warnings.contains(&"plain_http_remote".to_string()));
    }

    #[test]
    fn pasted_endpoints_are_cut_back_to_the_base() {
        assert_eq!(
            normalize_base_for_kind(LlmKind::OpenAiCompat, " https://gw.example.com/llm/chat/completions/ "),
            "https://gw.example.com/llm"
        );
        assert_eq!(normalize_base_for_kind(LlmKind::Anthropic, "https://api.anthropic.com/v1/messages"), "https://api.anthropic.com");
        assert_eq!(normalize_base_for_kind(LlmKind::Ollama, "http://h:11434/api/chat"), "http://h:11434");
        assert_eq!(normalize_base_for_kind(LlmKind::OpenAiCompat, "https://api.openai.com/v1/"), "https://api.openai.com/v1");
        assert_eq!(normalize_base_for_kind(LlmKind::OpenAiCompat, "not a url"), "not a url");
    }

    #[test]
    fn validation_rejects_bad_input_and_protected_extra_body_keys() {
        let mut c = conn("a", LlmKind::OpenAiCompat, "api.example.com/v1");
        assert!(validate_connection(&c).unwrap_err().contains("http://"));
        c.base_url = "https://api.example.com/v1".into();
        assert!(validate_connection(&c).is_ok());
        c.params.extra_body = Some(json!({"model": "x"}).as_object().unwrap().clone());
        assert!(validate_connection(&c).unwrap_err().contains("model"));
        c.params.extra_body = Some(json!({"thinking": {"type": "disabled"}}).as_object().unwrap().clone());
        assert!(validate_connection(&c).is_ok());
        c.headers = vec![LlmHeader { name: "bad name".into(), value: "v".into(), ..Default::default() }];
        assert!(validate_connection(&c).is_err());
        c.headers = vec![LlmHeader { name: "X-Ok".into(), value: "a\nb".into(), ..Default::default() }];
        assert!(validate_connection(&c).is_err());
        c.headers.clear();
        c.auth = AuthConfig { mode: AuthMode::Header, header_name: String::new(), prefix: String::new() };
        assert!(validate_connection(&c).is_err());
        c.auth = header_auth("api-key");
        c.compat.temperature = TemperatureMode::Fixed;
        assert!(validate_connection(&c).is_err());
        c.compat.fixed_temperature = Some(1.0);
        assert!(validate_connection(&c).is_ok());
        c.timeout_secs = Some(0);
        assert!(validate_connection(&c).is_err());
    }

    #[test]
    fn normalization_tidies_lists_and_strings() {
        let mut c = LlmConnection {
            name: "  DeepSeek ".into(),
            base_url: "https://api.deepseek.com/".into(),
            manual_models: vec![" a ".into(), "a".into(), "".into(), "b".into()],
            default_model: Some("  ".into()),
            headers: vec![
                LlmHeader { name: " ".into(), value: "x".into(), ..Default::default() },
                LlmHeader { name: " X-T ".into(), value: " v ".into(), value_saved: true, ..Default::default() },
            ],
            ..Default::default()
        };
        normalize_connection(&mut c);
        assert_eq!(c.name, "DeepSeek");
        assert_eq!(c.base_url, "https://api.deepseek.com");
        assert_eq!(c.manual_models, vec!["a", "b"]);
        assert_eq!(c.default_model, None);
        assert_eq!(c.headers, vec![LlmHeader { name: "X-T".into(), value: "v".into(), ..Default::default() }]);
    }

    #[test]
    fn secrets_follow_kind_and_origin() {
        let a = conn("a", LlmKind::OpenAiCompat, "https://api.example.com/v1");
        let mut b = a.clone();
        b.base_url = "https://api.example.com/v2".into();
        assert!(secret_stays_valid(&a, &b), "same origin");
        b.base_url = "https://evil.example.net/v1".into();
        assert!(!secret_stays_valid(&a, &b));
        b.base_url = a.base_url.clone();
        b.kind = LlmKind::Anthropic;
        assert!(!secret_stays_valid(&a, &b));
        // Every address counts: an override or a model list on another server too.
        let mut c = a.clone();
        c.chat_url_override = Some("https://evil.example.net/{model}/chat".into());
        assert!(!secret_stays_valid(&a, &c));
        c.chat_url_override = Some("https://api.example.com/deploy/{model}".into());
        assert!(secret_stays_valid(&a, &c), "same server");
        let mut d = a.clone();
        d.models_endpoint = ModelsEndpoint::Custom;
        d.models_url = Some("https://list.example.org/models".into());
        assert!(!secret_stays_valid(&a, &d));
        // Dropping an address the key was given for is fine.
        let mut with_override = a.clone();
        with_override.chat_url_override = Some("https://gw.example.org/chat".into());
        assert!(secret_stays_valid(&with_override, &a));
        assert_eq!(secret_hint("sk-1234567890abcd").as_deref(), Some("…abcd"));
        assert_eq!(secret_hint("abc").as_deref(), Some("…c"));
        assert_eq!(secret_hint("  "), None);
    }

    #[test]
    fn legacy_connections_reproduce_the_old_providers() {
        let openai = legacy_connection(&ProviderType::Openai, None, None, None);
        assert_eq!(openai.id, "legacy-openai");
        assert_eq!(openai.legacy_type(), "openai");
        assert_eq!(openai.secret_ref.as_deref(), Some("openai"));
        assert_eq!(chat(&openai), "https://api.openai.com/v1/chat/completions");
        assert_eq!(openai.auth.mode, AuthMode::Bearer);

        let custom = legacy_connection(&ProviderType::Custom, Some("http://h:8000/v1"), Some("api_key"), None);
        assert_eq!(custom.legacy_type(), "custom");
        assert_eq!(custom.auth, header_auth("x-api-key"));
        assert!(custom.compat.ollama_fallback_on_404);
        assert_eq!(custom.secret_ref.as_deref(), Some("custom"));

        let ollama = legacy_connection(&ProviderType::Ollama, None, None, None);
        assert_eq!((ollama.kind, ollama.secret_ref.clone()), (LlmKind::Ollama, None));
        let gemini = legacy_connection(&ProviderType::Gemini, None, None, None);
        assert_eq!(gemini.auth, header_auth("x-goog-api-key"));
        assert_eq!(gemini.web_search(), WebSearch::GeminiGoogleSearch);
        let router = legacy_connection(&ProviderType::Openrouter, None, None, None);
        assert_eq!(router.web_search(), WebSearch::OpenrouterOnline);
        let claude = legacy_connection(&ProviderType::ClaudeCli, None, None, None);
        assert_eq!(claude.display_name(), CLAUDE_DISPLAY_NAME);
        assert_eq!(endpoints(&claude).models, None);
        let anthropic = legacy_connection(&ProviderType::Anthropic, None, None, None);
        assert_eq!(anthropic.compat.temperature, TemperatureMode::Omit);
    }

    #[test]
    fn routes_follow_their_parents() {
        let mut cfg = LlmConfigFile::default();
        cfg.connections = vec![conn("a", LlmKind::OpenAiCompat, "https://a/v1"), conn("b", LlmKind::OpenAiCompat, "https://b/v1")];
        assert_eq!(resolve_route(&cfg, "translation").unwrap_err().0, RouteError::NotConfigured);

        cfg.routing.default = TaskRoute { target: target("a", Some("big")), params: RouteParams { temperature: Some(0.7), ..Default::default() } };
        let r = resolve_route(&cfg, "translation_batch").unwrap();
        assert_eq!((r.source.as_str(), r.connection.id.as_str(), r.model.as_deref()), ("default", "a", Some("big")));
        assert_eq!(r.overrides.len(), 1);

        // translation: own target and params; the batch task follows it and adds its own params.
        cfg.routing.tasks.insert("translation".into(), TaskRoute { target: target("b", None), params: RouteParams { temperature: Some(0.2), ..Default::default() } });
        cfg.routing.tasks.insert("translation_batch".into(), TaskRoute { target: None, params: RouteParams { max_tokens: Some(99), ..Default::default() } });
        let r = resolve_route(&cfg, "translation_batch").unwrap();
        assert_eq!((r.source.as_str(), r.connection.id.as_str(), r.model.as_deref()), ("translation", "b", Some("b-model")));
        assert_eq!(r.overrides.iter().map(|p| (p.temperature, p.max_tokens)).collect::<Vec<_>>(), vec![(Some(0.2), None), (None, Some(99))]);

        // assist:<mode> → assist → default; a deleted target is skipped.
        cfg.routing.tasks.insert("assist".into(), TaskRoute { target: target("gone", None), ..Default::default() });
        let r = resolve_route(&cfg, "assist:WhatToSay").unwrap();
        assert_eq!(r.connection.id, "a");

        // A disabled connection is an error, not a silent switch.
        cfg.connections[1].enabled = false;
        assert_eq!(resolve_route(&cfg, "translation").unwrap_err().0, RouteError::ConnectionDisabled);
        // No model anywhere.
        cfg.connections[1].enabled = true;
        cfg.connections[1].default_model = None;
        assert_eq!(resolve_route(&cfg, "translation").unwrap_err().0, RouteError::NoModel);
    }

    #[test]
    fn clearing_routes_of_a_deleted_connection() {
        let mut routing = TaskRouting::default();
        routing.default.target = target("a", None);
        routing.tasks.insert("translation".into(), TaskRoute { target: target("a", None), params: RouteParams { temperature: Some(0.1), ..Default::default() } });
        routing.tasks.insert("assist".into(), TaskRoute { target: target("a", None), ..Default::default() });
        routing.tasks.insert("meeting_ask".into(), TaskRoute { target: target("b", None), ..Default::default() });
        let mut cleared = clear_routes_to(&mut routing, "a");
        cleared.sort();
        assert_eq!(cleared, vec!["assist", "default", "translation"]);
        assert!(routing.tasks.contains_key("translation"), "its params stay");
        assert!(!routing.tasks.contains_key("assist"), "an empty route goes away");
        assert!(routing.tasks.contains_key("meeting_ask"));
    }

    #[test]
    fn task_keys_and_parents() {
        assert_eq!(task_parent("assist:custom_1"), Some("assist"));
        assert_eq!(task_parent("translation_batch"), Some("translation"));
        assert_eq!(task_parent("topic_detection"), Some("default"));
        assert_eq!(task_parent("default"), None);
        assert!(is_valid_task_key("assist:custom_ab-1"));
        assert!(!is_valid_task_key("assist:"));
        assert!(!is_valid_task_key("Bad Key"));
        assert!(is_valid_task_key("claude_fallback"));
    }

    #[test]
    fn files_load_with_missing_and_unknown_fields() {
        let cfg: LlmConfigFile = serde_json::from_value(json!({
            "schema_version": 1,
            "connections": [{"id": "c_1", "kind": "ollama", "future_field": 1}],
            "routing": {"default": {"target": {"connection_id": "c_1"}}},
            "something_new": true
        }))
        .unwrap();
        assert_eq!(cfg.response_language, "ui");
        let c = &cfg.connections[0];
        assert!(c.enabled && c.compat.strip_think_tags);
        assert_eq!(c.kind, LlmKind::Ollama);
        assert_eq!(cfg.routing.default.target.as_ref().unwrap().model, None);
    }
}
