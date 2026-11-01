//! Stable cross-package LLM interface (NexQ Plus).
//!
//! Translation, RAG, onboarding and every other caller outside the LLM
//! package use only this module (`use crate::llm::api::*`) and never touch
//! `LLMRouter`, `ProviderType` or `create_provider`, which will go away.
//! Signatures are frozen: fields and functions may be added, never changed.
//!
//! This is the P0 stub. It ignores the task and serves every call from the
//! global `LLMRouter` provider and model, locking the provider for each call
//! exactly like the code it replaces. The LLM package (P1) swaps the function
//! bodies for connection-based task routing without changing the signatures.

use std::fmt;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex as TokioMutex;

use super::provider::{
    CancelToken, CompletionStats, GenerationParams, LLMError, LLMMessage, LLMProvider, ModelInfo,
    TokenSink,
};
use super::ProviderType;
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

/// Resolves `task` to a provider and model.
pub async fn resolve_for_task(app: &AppHandle, _task: &LlmTask) -> Result<ResolvedLlm, LlmCallError> {
    let state = app.state::<AppState>();
    let llm = state
        .llm
        .as_ref()
        .ok_or_else(|| LlmCallError::NotConfigured("LLM router not initialized".to_string()))?;
    let router = llm
        .lock()
        .map_err(|_| LlmCallError::Other("LLM router lock poisoned".to_string()))?;

    let inner = router
        .get_provider()
        .map_err(|e| LlmCallError::NotConfigured(e.to_string()))?;
    let model = router.active_model().to_string();
    if model.is_empty() {
        return Err(LlmCallError::NotConfigured("No active model selected".to_string()));
    }
    let provider_type = router.active_provider_type().cloned();
    let (type_key, display_name, kind) = match &provider_type {
        Some(pt) => (pt.as_str().to_string(), pt.display_name().to_string(), LlmKind::from_provider_type(pt)),
        None => ("unknown".to_string(), "Unknown".to_string(), LlmKind::OpenAiCompat),
    };

    Ok(ResolvedLlm {
        provider: Arc::new(LockedProvider { inner, name: type_key.clone() }),
        model,
        connection_id: format!("legacy-{type_key}"),
        display_name,
        kind,
    })
}

/// Runs a silent stream and returns the whole answer: no `llm_stream_*`
/// events, a per-call timeout, cancellation. (Per-connection concurrency
/// limits and the Claude fallback arrive with the LLM package.)
pub async fn complete_text(
    app: &AppHandle,
    task: &LlmTask,
    messages: Vec<LLMMessage>,
    opts: CompleteOptions,
) -> Result<String, LlmCallError> {
    let resolved = resolve_for_task(app, task).await?;
    let app = app.clone();
    collect_text(&opts, move |params, sink| async move {
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
pub fn resolve_connection(_app: &AppHandle, id: &str) -> Result<ResolvedConnection, LlmCallError> {
    Err(LlmCallError::NotConfigured(format!(
        "LLM connection '{id}' not found (connections arrive with the LLM settings update)"
    )))
}

/// Every LLM connection, without secrets.
pub fn list_connections(_app: &AppHandle) -> Vec<ConnectionSummary> {
    Vec::new()
}

/// Drives one silent stream: `start` gets the request's params and a sink and
/// runs the provider; the sink's tokens are the answer. Kept free of
/// `AppHandle` so it can be tested with a fake provider.
async fn collect_text<F, Fut>(opts: &CompleteOptions, start: F) -> Result<String, LlmCallError>
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
        request_id: Some(uuid::Uuid::new_v4().to_string()),
        silent: true,
        cancel: Some(cancel.clone()),
        ..Default::default()
    };

    let run = start(params, sink);
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

/// The router's current provider, locked for the duration of each call (as
/// every caller did before this module existed).
struct LockedProvider {
    inner: Arc<TokioMutex<Box<dyn LLMProvider>>>,
    /// Provider type key; read without taking the lock.
    name: String,
}

#[async_trait::async_trait]
impl LLMProvider for LockedProvider {
    fn provider_name(&self) -> &str {
        &self.name
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, LLMError> {
        self.inner.lock().await.list_models().await
    }

    async fn test_connection(&self) -> Result<bool, LLMError> {
        self.inner.lock().await.test_connection().await
    }

    async fn stream_completion(
        &self,
        messages: Vec<LLMMessage>,
        model: &str,
        params: GenerationParams,
        app_handle: AppHandle,
        sink: Option<TokenSink>,
    ) -> Result<CompletionStats, LLMError> {
        self.inner
            .lock()
            .await
            .stream_completion(messages, model, params, app_handle, sink)
            .await
    }
}

/// A shared provider behind the old `Box<dyn LLMProvider>` type.
struct SharedProvider(Arc<dyn LLMProvider>);

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
        app_handle: AppHandle,
        sink: Option<TokenSink>,
    ) -> Result<CompletionStats, LLMError> {
        self.0.stream_completion(messages, model, params, app_handle, sink).await
    }
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
        let opts = CompleteOptions { temperature: Some(0.2), max_tokens: Some(64), ..Default::default() };

        let (result, params) = complete_with(&fake, opts).await;

        assert_eq!(result, Ok("你好，world".to_string()));
        let params = params.expect("provider was called");
        assert!(params.silent, "complete_text must not emit llm_stream_* events");
        assert!(params.request_id.is_some());
        assert_eq!(params.temperature, Some(0.2));
        assert_eq!(params.max_tokens, Some(64));
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

    #[test]
    fn errors_convert_to_strings_for_tauri_commands() {
        let message: String = LlmCallError::Http { status: 429, body: "slow down".to_string() }.into();
        assert_eq!(message, "HTTP 429: slow down");
    }
}
