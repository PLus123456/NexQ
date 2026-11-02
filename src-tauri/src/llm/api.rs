//! Stable cross-package LLM interface (NexQ Plus).
//!
//! Translation, RAG, onboarding and every other caller outside the LLM
//! package use only this module (`use crate::llm::api::*`) and never touch
//! `LLMRouter`, `ProviderType` or `create_provider`, which will go away.
//! Signatures are frozen: fields and functions may be added, never changed.
//!
//! Each task is routed to its own connection and model
//! (`llm-connections.json`, see `llm::registry`): the routes follow their
//! parent tasks up to `default`, and a task routed to an unavailable Claude
//! subscription goes to its fallback. Providers are shared and unlocked, so
//! translation and the AI assistant run at the same time.

use std::fmt;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{Mutex as TokioMutex, Semaphore};

use super::provider::{
    CancelToken, CompletionStats, GenerationParams, LLMError, LLMMessage, LLMProvider, TokenSink,
};
use super::registry::{self, ClaudeContext, LlmRegistry, RoutedProvider};
use super::{ProviderType, SharedProvider};
use crate::i18n::UiLanguage;
use crate::llm::cli_agent::routing::{self as claude_routing, AgentFallbackPayload, ClaudeHealth};
use crate::net::endpoint::{ConnectionSummary, ResolvedConnection};
use crate::state::AppState;

/// What an LLM call is for. Each task can be routed to its own connection
/// and model; `key()` is the routing key stored in the LLM config.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum LlmTask {
    Default,
    /// An AI action (`Assist`, `WhatToSay`, …, `custom_*`); empty = all actions.
    Assist(String),
    MeetingSummary,
    ActionItems,
    BookmarkSuggestions,
    /// Questions about a past meeting (`ask_meeting`).
    MeetingAsk,
    /// Live LLM translation (segments, selection, single re-translate).
    Translation,
    /// Post-meeting batch translation.
    TranslationBatch,
    /// "Test answer" in the personal knowledge base settings.
    RagAnswer,
    /// A task without a variant yet; the string is its routing key.
    Other(&'static str),
}

impl LlmTask {
    /// Maps an intelligence mode (`generate_assist`'s `mode`) to its task.
    pub fn from_mode(mode: &str) -> Self {
        match mode {
            "MeetingSummary" => Self::MeetingSummary,
            "ActionItemsExtraction" => Self::ActionItems,
            "BookmarkSuggestions" => Self::BookmarkSuggestions,
            "MeetingAsk" => Self::MeetingAsk,
            other => Self::Assist(other.to_string()),
        }
    }

    /// Routing key: `default`, `assist`, `assist:<mode>`, `meeting_summary`, …
    pub fn key(&self) -> String {
        match self {
            Self::Default => "default".to_string(),
            Self::Assist(mode) if mode.is_empty() => "assist".to_string(),
            Self::Assist(mode) => format!("assist:{mode}"),
            Self::MeetingSummary => "meeting_summary".to_string(),
            Self::ActionItems => "action_items".to_string(),
            Self::BookmarkSuggestions => "bookmark_suggestions".to_string(),
            Self::MeetingAsk => "meeting_ask".to_string(),
            Self::Translation => "translation".to_string(),
            Self::TranslationBatch => "translation_batch".to_string(),
            Self::RagAnswer => "rag_answer".to_string(),
            Self::Other(key) => key.to_string(),
        }
    }
}

/// Request protocol of a connection. JSON values match `LlmConnection.kind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum LlmKind {
    #[serde(rename = "openai_compat")]
    OpenAiCompat,
    #[serde(rename = "anthropic")]
    Anthropic,
    #[serde(rename = "gemini")]
    Gemini,
    #[serde(rename = "ollama")]
    Ollama,
    #[serde(rename = "claude_cli")]
    ClaudeCli,
}

impl LlmKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::OpenAiCompat => "openai_compat",
            Self::Anthropic => "anthropic",
            Self::Gemini => "gemini",
            Self::Ollama => "ollama",
            Self::ClaudeCli => "claude_cli",
        }
    }

    /// The protocol a legacy provider type speaks.
    pub fn from_provider_type(provider_type: &ProviderType) -> Self {
        match provider_type {
            ProviderType::Ollama => Self::Ollama,
            ProviderType::Anthropic => Self::Anthropic,
            ProviderType::Gemini => Self::Gemini,
            ProviderType::ClaudeCli => Self::ClaudeCli,
            ProviderType::LmStudio
            | ProviderType::Openai
            | ProviderType::Groq
            | ProviderType::Openrouter
            | ProviderType::Custom => Self::OpenAiCompat,
        }
    }
}

/// A task resolved to a provider and model. Cheap to clone; the provider can
/// be used from several tasks at once.
#[derive(Clone)]
pub struct ResolvedLlm {
    pub provider: Arc<dyn LLMProvider>,
    pub model: String,
    /// Connection id (`legacy-<type>` for connections migrated from the old settings).
    pub connection_id: String,
    /// Fills `llm_stream_start.provider` and the stored meeting metadata.
    pub display_name: String,
    pub kind: LlmKind,
}

impl fmt::Debug for ResolvedLlm {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ResolvedLlm")
            .field("model", &self.model)
            .field("connection_id", &self.connection_id)
            .field("display_name", &self.display_name)
            .field("kind", &self.kind)
            .finish_non_exhaustive()
    }
}

/// Per-call options. Callers always write `..Default::default()`.
#[derive(Clone, Default)]
pub struct CompleteOptions {
    pub temperature: Option<f64>,
    pub max_tokens: Option<u64>,
    /// Request native JSON output when the connection declares support.
    pub json_mode: bool,
    /// Whole-call limit; `None` = no limit.
    pub timeout: Option<Duration>,
    pub cancel: Option<Arc<CancelToken>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LlmCallError {
    /// No connection / model for this task, or the connection is disabled.
    NotConfigured(String),
    Auth(String),
    /// Non-success HTTP status; `body` is the server's message.
    Http { status: u16, body: String },
    Network(String),
    Timeout,
    Cancelled,
    /// The model answered with no text.
    Empty,
    Other(String),
}

impl fmt::Display for LlmCallError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotConfigured(msg) => write!(f, "LLM not configured: {msg}"),
            Self::Auth(msg) => write!(f, "Authentication failed: {msg}"),
            Self::Http { status, body } => write!(f, "HTTP {status}: {body}"),
            Self::Network(msg) => write!(f, "Network error: {msg}"),
            Self::Timeout => write!(f, "The LLM request timed out"),
            Self::Cancelled => write!(f, "The LLM request was cancelled"),
            Self::Empty => write!(f, "The LLM returned an empty response"),
            Self::Other(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for LlmCallError {}

impl From<LlmCallError> for String {
    fn from(err: LlmCallError) -> Self {
        err.to_string()
    }
}

impl From<LLMError> for LlmCallError {
    fn from(err: LLMError) -> Self {
        match err {
            LLMError::NotConfigured(msg) => Self::NotConfigured(msg),
            LLMError::AuthError(msg) => Self::Auth(msg),
            LLMError::Cancelled => Self::Cancelled,
            LLMError::ConnectionFailed(msg) => Self::Network(msg),
            LLMError::HttpError(e) if e.is_timeout() => Self::Timeout,
            LLMError::HttpError(e) => match e.status() {
                Some(status) => Self::Http { status: status.as_u16(), body: e.to_string() },
                None => Self::Network(e.to_string()),
            },
            LLMError::ProviderError(msg) => match status_in(&msg) {
                Some(status) => Self::Http { status, body: msg },
                None => Self::Other(msg),
            },
            LLMError::JsonError(e) => Self::Other(e.to_string()),
            LLMError::InvalidResponse(msg) => Self::Other(msg),
        }
    }
}

/// The HTTP status providers embed in their messages, as in
/// `"Completion request failed (404 Not Found): …"`.
fn status_in(message: &str) -> Option<u16> {
    message.match_indices('(').find_map(|(i, _)| {
        let digits = message.get(i + 1..i + 4)?;
        let after = message[i + 4..].chars().next();
        let code: u16 = digits.parse().ok()?;
        ((100..600).contains(&code) && digits.bytes().all(|b| b.is_ascii_digit())
            && matches!(after, Some(' ') | Some(')')))
        .then_some(code)
    })
}

/// Resolves `task` to a provider and model: the task's route (or the
/// nearest parent's), the Claude fallback when Claude is unavailable
/// (announced once per outage with `agent_fallback`).
pub async fn resolve_for_task(app: &AppHandle, task: &LlmTask) -> Result<ResolvedLlm, LlmCallError> {
    let registry = registry_of(app)?;
    let claude = registry::claude_context(app);
    let (resolved, via_fallback) = resolve_with(&registry, &task.key(), &claude).await?;
    if via_fallback {
        announce_fallback(app, &resolved.display_name);
    }
    Ok(resolved)
}

fn registry_of(app: &AppHandle) -> Result<LlmRegistry, LlmCallError> {
    app.try_state::<LlmRegistry>()
        .map(|r| r.inner().clone())
        .ok_or_else(|| LlmCallError::NotConfigured("LLM settings not loaded".to_string()))
}

/// [`resolve_for_task`] without the app: the route, the shared client, the
/// model (a fallback without one gets its first listed model, as before).
async fn resolve_with(registry: &LlmRegistry, key: &str, claude: &ClaudeContext) -> Result<(ResolvedLlm, bool), LlmCallError> {
    let config = registry.config();
    let resolved = registry::resolve_task(&config, key, claude)
        .map_err(|(e, conn)| LlmCallError::NotConfigured(registry::route_error_message(key, e, conn.as_ref())))?;
    let conn = &resolved.connection;
    let provider = registry.provider_for(conn).map_err(LlmCallError::NotConfigured)?;
    let model = match resolved.model.clone() {
        Some(model) => model,
        None if conn.kind == LlmKind::ClaudeCli => claude.fast_model.clone(),
        None => provider
            .list_models()
            .await
            .ok()
            .and_then(|models| models.into_iter().next())
            .map(|m| m.id)
            .ok_or_else(|| LlmCallError::NotConfigured(format!("Fallback provider {} has no model to use", conn.display_name())))?,
    };
    let provider: Arc<dyn LLMProvider> = if resolved.overrides.is_empty() {
        provider
    } else {
        Arc::new(RoutedProvider { inner: provider, overrides: resolved.overrides.clone() })
    };
    let out = ResolvedLlm {
        provider,
        model,
        connection_id: conn.id.clone(),
        display_name: conn.display_name(),
        kind: conn.kind,
    };
    Ok((out, resolved.via_fallback))
}

/// First fallback request of an outage: tell the UI who took over.
fn announce_fallback(app: &AppHandle, provider: &str) {
    let Some(state) = app.try_state::<AppState>() else { return };
    if state.claude_health.take_fallback_notice() {
        let reason = match state.claude_health.get() {
            ClaudeHealth::Unavailable(kind) => claude_routing::reason_label(kind),
            ClaudeHealth::Healthy => "unavailable",
        };
        let _ = app.emit(
            claude_routing::FALLBACK_EVENT,
            AgentFallbackPayload { reason: reason.to_string(), provider: provider.to_string() },
        );
    }
}

/// Runs a silent stream and returns the whole answer: no `llm_stream_*`
/// events, a per-call timeout, cancellation, at most the connection's
/// concurrency limit of such calls at once, the Claude fallback.
pub async fn complete_text(
    app: &AppHandle,
    task: &LlmTask,
    messages: Vec<LLMMessage>,
    opts: CompleteOptions,
) -> Result<String, LlmCallError> {
    let resolved = resolve_for_task(app, task).await?;
    let gate = registry_of(app).ok().map(|registry| {
        let config = registry.config();
        match config.connection(&resolved.connection_id) {
            Some(conn) => registry.semaphore_for(conn),
            None => registry.semaphore_for(&super::connections::LlmConnection { id: resolved.connection_id.clone(), ..Default::default() }),
        }
    });
    let app = app.clone();
    collect_text_gated(&opts, gate, move |params, sink| async move {
        resolved
            .provider
            .stream_completion(messages, &resolved.model, params, app, Some(sink))
            .await
    })
    .await
}

/// The old provider handle (`IntelligenceEngine::generate_assist` still takes
/// one). Each call returns a new lock, so holders never queue on each other.
pub fn legacy_handle(r: &ResolvedLlm) -> Arc<TokioMutex<Box<dyn LLMProvider>>> {
    Arc::new(TokioMutex::new(Box::new(SharedProvider(r.provider.clone()))))
}

/// A connection's address and auth headers, for the RAG package to call
/// embeddings / rerank with an LLM connection. The secret is already read
/// from the keychain: mask the headers before logging anything.
pub fn resolve_connection(app: &AppHandle, id: &str) -> Result<ResolvedConnection, LlmCallError> {
    let registry = registry_of(app)?;
    let config = registry.config();
    let conn = config
        .connection(id)
        .ok_or_else(|| LlmCallError::NotConfigured(format!("LLM connection '{id}' not found")))?;
    if !conn.enabled {
        return Err(LlmCallError::NotConfigured(format!("LLM connection '{}' is turned off", conn.display_name())));
    }
    if conn.kind == LlmKind::ClaudeCli {
        return Err(LlmCallError::NotConfigured("The Claude subscription has no HTTP endpoint".to_string()));
    }
    let headers = registry.request_headers(conn).map_err(LlmCallError::Other)?;
    Ok(ResolvedConnection {
        id: conn.id.clone(),
        kind: conn.kind,
        base_url: conn.base_url.clone(),
        headers,
        timeout: Some(Duration::from_secs(conn.timeout_secs() as u64)),
    })
}

/// Every LLM connection, without secrets.
pub fn list_connections(app: &AppHandle) -> Vec<ConnectionSummary> {
    let Ok(registry) = registry_of(app) else {
        return Vec::new();
    };
    registry
        .config()
        .connections
        .iter()
        .map(|c| ConnectionSummary { id: c.id.clone(), name: c.display_name(), kind: c.kind, base_url: c.base_url.clone() })
        .collect()
}

/// The instruction appended to AI prompts for the answer language
/// (`response_language`: the UI language by default, nothing for
/// `"transcript"`). Translation never uses it.
pub fn answer_language_instruction(app: &AppHandle) -> Option<String> {
    let setting = registry_of(app)
        .map(|r| r.config().response_language)
        .unwrap_or_else(|_| "ui".to_string());
    language_instruction(&setting, crate::i18n::current_ui_language())
}

/// `prompt` with the answer-language instruction appended (unchanged when
/// there is none).
pub fn with_answer_language(prompt: &str, app: &AppHandle) -> String {
    match answer_language_instruction(app) {
        Some(instruction) if !prompt.contains(&instruction) => {
            if prompt.trim().is_empty() {
                instruction
            } else {
                format!("{prompt}\n\n{instruction}")
            }
        }
        _ => prompt.to_string(),
    }
}

/// The instruction for a `response_language` setting.
pub fn language_instruction(setting: &str, ui: UiLanguage) -> Option<String> {
    let code = match setting.trim() {
        "" | "transcript" => return None,
        "ui" => ui.code().to_string(),
        other => other.to_string(),
    };
    let name = language_name(&code);
    Some(format!(
        "Respond in {name}. If the task asks for a specific output format (such as JSON), keep that format exactly and write only its human-readable text in {name}."
    ))
}

/// English name (and native name) of a language code, for prompts.
fn language_name(code: &str) -> String {
    let lower = code.trim().to_ascii_lowercase().replace('_', "-");
    let base = lower.split('-').next().unwrap_or_default();
    if base == "zh" {
        let traditional = ["tw", "hk", "mo", "hant"].iter().any(|t| lower.split('-').skip(1).any(|p| p == *t));
        return if traditional { "Traditional Chinese (繁體中文)" } else { "Simplified Chinese (简体中文)" }.to_string();
    }
    let name = match base {
        "en" => "English",
        "ja" => "Japanese (日本語)",
        "ko" => "Korean (한국어)",
        "fr" => "French (français)",
        "de" => "German (Deutsch)",
        "es" => "Spanish (español)",
        "pt" => "Portuguese (português)",
        "it" => "Italian (italiano)",
        "ru" => "Russian (русский)",
        "uk" => "Ukrainian (українська)",
        "pl" => "Polish (polski)",
        "nl" => "Dutch (Nederlands)",
        "tr" => "Turkish (Türkçe)",
        "ar" => "Arabic (العربية)",
        "he" => "Hebrew (עברית)",
        "hi" => "Hindi (हिन्दी)",
        "th" => "Thai (ไทย)",
        "vi" => "Vietnamese (Tiếng Việt)",
        "id" => "Indonesian (Bahasa Indonesia)",
        "ms" => "Malay (Bahasa Melayu)",
        "sv" => "Swedish (svenska)",
        "da" => "Danish (dansk)",
        "fi" => "Finnish (suomi)",
        "no" | "nb" => "Norwegian (norsk)",
        "cs" => "Czech (čeština)",
        "el" => "Greek (Ελληνικά)",
        "hu" => "Hungarian (magyar)",
        "ro" => "Romanian (română)",
        "fa" => "Persian (فارسی)",
        _ => return format!("the language with the code \"{code}\""),
    };
    name.to_string()
}

/// Drives one silent stream: `start` gets the request's params and a sink and
/// runs the provider; the sink's tokens are the answer. Kept free of
/// `AppHandle` so it can be tested with a fake provider.
#[cfg(test)]
async fn collect_text<F, Fut>(opts: &CompleteOptions, start: F) -> Result<String, LlmCallError>
where
    F: FnOnce(GenerationParams, TokenSink) -> Fut,
    Fut: Future<Output = Result<CompletionStats, LLMError>>,
{
    collect_text_gated(opts, None, start).await
}

/// [`collect_text`] waiting first for a permit of `gate` (the connection's
/// concurrency limit); the wait counts toward the timeout and stops on cancel.
async fn collect_text_gated<F, Fut>(opts: &CompleteOptions, gate: Option<Arc<Semaphore>>, start: F) -> Result<String, LlmCallError>
where
    F: FnOnce(GenerationParams, TokenSink) -> Fut,
    Fut: Future<Output = Result<CompletionStats, LLMError>>,
{
    let buffer = Arc::new(Mutex::new(String::new()));
    let target = buffer.clone();
    let sink: TokenSink = Arc::new(move |token: &str| {
        if let Ok(mut text) = target.lock() {
            text.push_str(token);
        }
    });
    let cancel = opts.cancel.clone().unwrap_or_else(|| Arc::new(CancelToken::new()));
    let params = GenerationParams {
        temperature: opts.temperature,
        max_tokens: opts.max_tokens,
        json_mode: opts.json_mode,
        request_id: Some(uuid::Uuid::new_v4().to_string()),
        silent: true,
        cancel: Some(cancel.clone()),
        ..Default::default()
    };

    let waiter = cancel.clone();
    let run = async move {
        let _permit = match gate {
            Some(gate) => tokio::select! {
                biased;
                _ = waiter.cancelled() => return Err(LLMError::Cancelled),
                permit = gate.acquire_owned() => Some(permit.map_err(|_| LLMError::Cancelled)?),
            },
            None => None,
        };
        start(params, sink).await
    };
    let result = match opts.timeout {
        Some(limit) => match tokio::time::timeout(limit, run).await {
            Ok(result) => result,
            Err(_) => {
                // Stop the provider's stream too, in case it outlives this call.
                cancel.cancel();
                return Err(LlmCallError::Timeout);
            }
        },
        None => run.await,
    };
    result.map_err(LlmCallError::from)?;
    if cancel.is_cancelled() {
        return Err(LlmCallError::Cancelled);
    }

    let text = buffer
        .lock()
        .map_err(|_| LlmCallError::Other("Response buffer lock poisoned".to_string()))?
        .clone();
    if text.trim().is_empty() {
        return Err(LlmCallError::Empty);
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::provider::{check_cancelled, is_cancelled};

    /// Streams like a real provider: tokens go to the sink (the stream is
    /// silent), cancellation is honoured between tokens.
    struct FakeProvider {
        tokens: Vec<&'static str>,
        delay: Duration,
        fail: Option<fn() -> LLMError>,
    }

    impl FakeProvider {
        fn answering(tokens: &[&'static str]) -> Self {
            Self { tokens: tokens.to_vec(), delay: Duration::ZERO, fail: None }
        }

        async fn stream(
            &self,
            seen: Arc<Mutex<Option<GenerationParams>>>,
            params: GenerationParams,
            sink: TokenSink,
        ) -> Result<CompletionStats, LLMError> {
            *seen.lock().unwrap() = Some(params.clone());
            if let Some(fail) = self.fail {
                return Err(fail());
            }
            for token in &self.tokens {
                if !self.delay.is_zero() {
                    tokio::time::sleep(self.delay).await;
                }
                check_cancelled(&params)?;
                sink(token);
            }
            Ok(CompletionStats {
                prompt_tokens: 1,
                completion_tokens: self.tokens.len() as u64,
                total_tokens: 1 + self.tokens.len() as u64,
                latency_ms: 0,
            })
        }
    }

    async fn complete_with(fake: &FakeProvider, opts: CompleteOptions) -> (Result<String, LlmCallError>, Option<GenerationParams>) {
        let seen = Arc::new(Mutex::new(None));
        let seen_by_fake = seen.clone();
        let result = collect_text(&opts, |params, sink| fake.stream(seen_by_fake, params, sink)).await;
        let params = seen.lock().unwrap().take();
        (result, params)
    }

    #[tokio::test]
    async fn complete_text_collects_a_silent_stream_from_a_fake_provider() {
        let fake = FakeProvider::answering(&["你好", "，", "world"]);
        let opts = CompleteOptions { temperature: Some(0.2), max_tokens: Some(64), json_mode: true, ..Default::default() };

        let (result, params) = complete_with(&fake, opts).await;

        assert_eq!(result, Ok("你好，world".to_string()));
        let params = params.expect("provider was called");
        assert!(params.silent, "complete_text must not emit llm_stream_* events");
        assert!(params.request_id.is_some());
        assert_eq!(params.temperature, Some(0.2));
        assert_eq!(params.max_tokens, Some(64));
        assert!(params.json_mode);
        assert!(params.cancel.is_some());
    }

    #[tokio::test]
    async fn complete_text_reports_an_empty_answer() {
        let fake = FakeProvider::answering(&["  ", "\n"]);
        let (result, _) = complete_with(&fake, CompleteOptions::default()).await;
        assert_eq!(result, Err(LlmCallError::Empty));
    }

    #[tokio::test]
    async fn complete_text_maps_provider_errors() {
        let mut fake = FakeProvider::answering(&[]);
        fake.fail = Some(|| LLMError::AuthError("bad key".to_string()));
        assert_eq!(complete_with(&fake, CompleteOptions::default()).await.0, Err(LlmCallError::Auth("bad key".to_string())));

        fake.fail = Some(|| LLMError::ProviderError("Completion request failed (404 Not Found): no route".to_string()));
        assert_eq!(
            complete_with(&fake, CompleteOptions::default()).await.0,
            Err(LlmCallError::Http {
                status: 404,
                body: "Completion request failed (404 Not Found): no route".to_string()
            })
        );
    }

    #[tokio::test]
    async fn complete_text_times_out_and_cancels_the_stream() {
        let fake = FakeProvider { delay: Duration::from_millis(500), ..FakeProvider::answering(&["slow"]) };
        let opts = CompleteOptions { timeout: Some(Duration::from_millis(20)), ..Default::default() };

        let (result, params) = complete_with(&fake, opts).await;

        assert_eq!(result, Err(LlmCallError::Timeout));
        assert!(is_cancelled(&params.unwrap()), "the provider's stream is told to stop");
    }

    #[tokio::test]
    async fn complete_text_honours_the_callers_cancel_token() {
        let token = Arc::new(CancelToken::new());
        token.cancel();
        let fake = FakeProvider::answering(&["never"]);
        let opts = CompleteOptions { cancel: Some(token), ..Default::default() };

        assert_eq!(complete_with(&fake, opts).await.0, Err(LlmCallError::Cancelled));
    }

    #[test]
    fn modes_map_to_task_keys() {
        assert_eq!(LlmTask::from_mode("MeetingSummary").key(), "meeting_summary");
        assert_eq!(LlmTask::from_mode("ActionItemsExtraction").key(), "action_items");
        assert_eq!(LlmTask::from_mode("BookmarkSuggestions").key(), "bookmark_suggestions");
        assert_eq!(LlmTask::from_mode("MeetingAsk").key(), "meeting_ask");
        assert_eq!(LlmTask::from_mode("WhatToSay").key(), "assist:WhatToSay");
        assert_eq!(LlmTask::from_mode("custom_abc").key(), "assist:custom_abc");
        assert_eq!(LlmTask::Assist(String::new()).key(), "assist");
        assert_eq!(LlmTask::Default.key(), "default");
        assert_eq!(LlmTask::Translation.key(), "translation");
        assert_eq!(LlmTask::TranslationBatch.key(), "translation_batch");
        assert_eq!(LlmTask::RagAnswer.key(), "rag_answer");
        assert_eq!(LlmTask::Other("topic_detection").key(), "topic_detection");
    }

    #[test]
    fn kind_serializes_like_the_connection_config() {
        assert_eq!(serde_json::to_string(&LlmKind::OpenAiCompat).unwrap(), "\"openai_compat\"");
        assert_eq!(serde_json::to_string(&LlmKind::ClaudeCli).unwrap(), "\"claude_cli\"");
        assert_eq!(LlmKind::from_provider_type(&ProviderType::Groq), LlmKind::OpenAiCompat);
        assert_eq!(LlmKind::from_provider_type(&ProviderType::Ollama), LlmKind::Ollama);
    }

    #[test]
    fn status_is_read_from_provider_messages() {
        assert_eq!(status_in("Failed to list models (401 Unauthorized): x"), Some(401));
        assert_eq!(status_in("Gemini error (503): busy"), Some(503));
        assert_eq!(status_in("no status (abc) here"), None);
        assert_eq!(status_in("version (2024-10-21)"), None);
    }

    /// Tauri commands await these, so their futures must be `Send` (compile-time check).
    #[allow(dead_code)]
    fn futures_are_send(app: &AppHandle) {
        fn assert_send<T: Send>(_: &T) {}
        assert_send(&resolve_for_task(app, &LlmTask::Translation));
        assert_send(&complete_text(app, &LlmTask::Translation, Vec::new(), CompleteOptions::default()));
    }

    #[tokio::test]
    async fn tasks_resolve_to_their_route_with_a_shared_client() {
        use crate::llm::connections::{LlmConfigFile, LlmConnection, RouteParams, RouteTarget, TaskRoute};
        use crate::llm::persist::Loaded;
        use crate::llm::registry::MemorySecrets;

        let mut config = LlmConfigFile::default();
        config.connections = vec![
            LlmConnection { id: "c_big".into(), name: "Big".into(), base_url: "https://big.example/v1".into(), default_model: Some("big-1".into()), ..Default::default() },
            LlmConnection { id: "c_fast".into(), name: "Fast".into(), base_url: "https://fast.example/v4".into(), default_model: Some("fast-1".into()), ..Default::default() },
        ];
        config.routing.default.target = Some(RouteTarget { connection_id: "c_big".into(), model: None });
        config.routing.tasks.insert(
            "translation".into(),
            TaskRoute {
                target: Some(RouteTarget { connection_id: "c_fast".into(), model: Some("glm-4-flash".into()) }),
                params: RouteParams { temperature: Some(0.2), ..Default::default() },
            },
        );
        let loaded = Loaded { config, read_only: false, warning: None, needs_save: false };
        let registry = LlmRegistry::new(loaded, None, Arc::new(MemorySecrets::default()));
        let claude = ClaudeContext::default();

        let (summary, _) = resolve_with(&registry, &LlmTask::MeetingSummary.key(), &claude).await.unwrap();
        assert_eq!((summary.connection_id.as_str(), summary.model.as_str(), summary.display_name.as_str()), ("c_big", "big-1", "Big"));
        let (translation, via_fallback) = resolve_with(&registry, &LlmTask::Translation.key(), &claude).await.unwrap();
        assert_eq!((translation.connection_id.as_str(), translation.model.as_str(), via_fallback), ("c_fast", "glm-4-flash", false));
        assert_eq!(translation.kind, LlmKind::OpenAiCompat);
        // Batch translation follows translation.
        let (batch, _) = resolve_with(&registry, &LlmTask::TranslationBatch.key(), &claude).await.unwrap();
        assert_eq!(batch.connection_id, "c_fast");
        // The same task twice: one shared client underneath.
        let (again, _) = resolve_with(&registry, &LlmTask::MeetingSummary.key(), &claude).await.unwrap();
        assert!(Arc::ptr_eq(&summary.provider, &again.provider));
        // Two old-style handles never queue on each other.
        let a = legacy_handle(&summary);
        let b = legacy_handle(&summary);
        let _held = a.try_lock().unwrap();
        assert!(b.try_lock().is_ok());
    }

    #[tokio::test]
    async fn a_fallback_without_a_model_takes_its_first_listed_model() {
        use crate::llm::connections::{legacy_connection, LlmConfigFile, RouteTarget};
        use crate::llm::http::test_support::{serve, Canned};
        use crate::llm::persist::Loaded;
        use crate::llm::registry::MemorySecrets;

        let (base, _) = serve(vec![Canned::json(200, r#"{"models":[{"name":"qwen3:8b"},{"name":"llama3"}]}"#)]).await;
        let claude = legacy_connection(&ProviderType::ClaudeCli, None, None, None);
        let mut ollama = legacy_connection(&ProviderType::Ollama, None, None, None);
        ollama.base_url = base;
        let mut config = LlmConfigFile::default();
        config.routing.default.target = Some(RouteTarget { connection_id: claude.id.clone(), model: None });
        config.connections = vec![claude, ollama];
        let loaded = Loaded { config, read_only: false, warning: None, needs_save: false };
        let registry = LlmRegistry::new(loaded, None, Arc::new(MemorySecrets::default()));
        let down = ClaudeContext { available: false, legacy_fallback: Some(("ollama".into(), None)), fast_model: "haiku".into() };

        let (resolved, via_fallback) = resolve_with(&registry, "assist:Assist", &down).await.unwrap();
        assert!(via_fallback);
        assert_eq!((resolved.connection_id.as_str(), resolved.model.as_str()), ("legacy-ollama", "qwen3:8b"));
        // Claude itself while healthy: its Fast model fills the slot.
        let (resolved, _) = resolve_with(&registry, "assist:Assist", &ClaudeContext::default()).await.unwrap();
        assert_eq!((resolved.kind, resolved.model.as_str(), resolved.display_name.as_str()), (LlmKind::ClaudeCli, "haiku", "Claude (subscription)"));
    }

    #[tokio::test]
    async fn unrouted_tasks_explain_what_to_set_up() {
        use crate::llm::persist::Loaded;
        use crate::llm::registry::MemorySecrets;
        let loaded = Loaded { config: Default::default(), read_only: false, warning: None, needs_save: false };
        let registry = LlmRegistry::new(loaded, None, Arc::new(MemorySecrets::default()));
        let err = resolve_with(&registry, "translation", &ClaudeContext::default()).await.unwrap_err();
        assert!(matches!(&err, LlmCallError::NotConfigured(m) if m.contains("translation")), "{err:?}");
    }

    #[tokio::test]
    async fn the_concurrency_limit_queues_background_calls() {
        let gate = Arc::new(Semaphore::new(1));
        let held = gate.clone().acquire_owned().await.unwrap();
        let fake = FakeProvider::answering(&["ok"]);
        // While the only permit is taken, the call waits and times out.
        let opts = CompleteOptions { timeout: Some(Duration::from_millis(30)), ..Default::default() };
        let seen = Arc::new(Mutex::new(None));
        let result = collect_text_gated(&opts, Some(gate.clone()), |params, sink| fake.stream(seen.clone(), params, sink)).await;
        assert_eq!(result, Err(LlmCallError::Timeout));
        assert!(seen.lock().unwrap().is_none(), "the provider was never called");
        drop(held);
        let result = collect_text_gated(&CompleteOptions::default(), Some(gate), |params, sink| fake.stream(seen.clone(), params, sink)).await;
        assert_eq!(result, Ok("ok".to_string()));
    }

    #[test]
    fn answer_language_follows_the_setting() {
        let zh = language_instruction("ui", UiLanguage::ZhCn).unwrap();
        assert!(zh.starts_with("Respond in Simplified Chinese (简体中文)."), "{zh}");
        assert!(zh.contains("JSON"));
        assert!(language_instruction("ui", UiLanguage::En).unwrap().starts_with("Respond in English."));
        assert_eq!(language_instruction("transcript", UiLanguage::ZhCn), None);
        assert!(language_instruction("zh-TW", UiLanguage::En).unwrap().contains("Traditional Chinese"));
        assert!(language_instruction("ja", UiLanguage::ZhCn).unwrap().contains("Japanese"));
        assert!(language_instruction("xx-YY", UiLanguage::En).unwrap().contains("\"xx-YY\""));
    }

    #[test]
    fn errors_convert_to_strings_for_tauri_commands() {
        let message: String = LlmCallError::Http { status: 429, body: "slow down".to_string() }.into();
        assert_eq!(message, "HTTP 429: slow down");
    }
}
