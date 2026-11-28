//! The HTTP client every LLM protocol shares (NexQ Plus): one connection's
//! addresses, auth and custom headers, request sending with cancellation,
//! errors that keep the server's own message (status, body, the address that
//! was called), and the stream pump that turns events into `llm_stream_*`.
//!
//! The protocol files (`openai_compat.rs`, `anthropic.rs`, `gemini.rs`,
//! `ollama.rs`) only build request bodies, decode responses and read model
//! lists; everything about sending lives here once.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use futures::StreamExt;
use serde_json::Value;
use tauri::AppHandle;

use super::api::LlmKind;
use super::compat::{self, merge_params, EffectiveParams, StreamDecoder, StreamEvent};
use super::connections::{self, LlmConnection, RouteParams, WebSearch};
use super::provider::{
    cancellable, check_cancelled, emit_end_with_stats, emit_error, emit_sources, emit_thinking,
    emit_token, is_cancelled, CompletionStats, GenerationParams, LLMError, LLMMessage, LLMProvider,
    ModelInfo, StreamSource, TokenSink,
};
use super::thinking::{self, Sent, ThinkingSetting};
use super::{anthropic, gemini, ollama, openai_compat};
use crate::net::endpoint::{self, AuthConfig, CustomHeader};

/// Most of an error body quoted in an error message.
pub const ERROR_BODY_CHARS: usize = 500;
/// Most of a raw error body returned by connection tests.
pub const ERROR_BODY_BYTES: usize = 2048;
/// Whole-request limit of non-streaming requests (model lists, tests).
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

// ── Output ──────────────────────────────────────────────────────────────────

/// Where a stream's output goes. The app's output emits `llm_stream_*`;
/// tests record it.
pub trait StreamOutput: Send + Sync {
    fn token(&self, token: &str);
    /// The model is thinking before its first words (once per request).
    fn thinking(&self);
    fn error(&self, message: &str);
}

/// [`StreamOutput`] that emits `llm_stream_token` / `thinking` / `error`
/// for `params.request_id` (or only feeds the sink when silent).
pub struct AppOutput<'a> {
    pub app: &'a AppHandle,
    pub params: &'a GenerationParams,
    pub sink: Option<&'a TokenSink>,
}

impl StreamOutput for AppOutput<'_> {
    fn token(&self, token: &str) {
        emit_token(self.app, self.params, token, self.sink);
    }

    fn thinking(&self) {
        emit_thinking(self.app, self.params);
    }

    fn error(&self, message: &str) {
        emit_error(self.app, self.params, message);
    }
}

/// Splits one protocol's response body into events.
pub trait EventDecoder: Send {
    fn push(&mut self, chunk: &[u8]) -> Vec<StreamEvent>;
    fn finish(&mut self) -> Vec<StreamEvent>;
    /// Web sources gathered along the way (Gemini grounding).
    fn sources(&mut self) -> Vec<StreamSource> {
        Vec::new()
    }
}

impl EventDecoder for StreamDecoder {
    fn push(&mut self, chunk: &[u8]) -> Vec<StreamEvent> {
        StreamDecoder::push(self, chunk)
    }

    fn finish(&mut self) -> Vec<StreamEvent> {
        StreamDecoder::finish(self)
    }
}

// ── Failures ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    /// The connection can't make this request (bad address, no model…).
    Config,
    /// No answer: DNS, refused, TLS, timeout, or the stream broke off.
    Network,
    /// 401 / 403.
    Auth,
    /// Another non-success status.
    Http,
    /// An error sent inside a successful response.
    Stream,
    Cancelled,
}

/// Why a request failed, with what the server said.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub kind: FailureKind,
    /// Readable message: status, address and the start of the body.
    pub message: String,
    /// The address called (secrets masked).
    pub url: Option<String>,
    pub status: Option<u16>,
    /// The raw error body (first [`ERROR_BODY_BYTES`]).
    pub body: Option<String>,
}

impl Failure {
    pub fn config(message: impl Into<String>) -> Self {
        Self { kind: FailureKind::Config, message: message.into(), url: None, status: None, body: None }
    }

    pub fn cancelled() -> Self {
        Self { kind: FailureKind::Cancelled, message: "Stream cancelled".to_string(), url: None, status: None, body: None }
    }

    /// `hint` code for the settings page (`contract-llm.md` §3.4).
    pub fn hint(&self) -> Option<&'static str> {
        match self.status {
            Some(404) => Some("check_version_prefix"),
            Some(401) | Some(403) => Some("auth_failed"),
            _ => None,
        }
    }
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<Failure> for LLMError {
    fn from(failure: Failure) -> Self {
        match failure.kind {
            FailureKind::Config => LLMError::NotConfigured(failure.message),
            FailureKind::Network => LLMError::ConnectionFailed(failure.message),
            FailureKind::Auth => LLMError::AuthError(failure.message),
            FailureKind::Http | FailureKind::Stream => LLMError::ProviderError(failure.message),
            FailureKind::Cancelled => LLMError::Cancelled,
        }
    }
}

impl From<LLMError> for Failure {
    fn from(err: LLMError) -> Self {
        match err {
            LLMError::Cancelled => Self::cancelled(),
            LLMError::NotConfigured(message) => Self::config(message),
            other => Self { kind: FailureKind::Network, message: other.to_string(), url: None, status: None, body: None },
        }
    }
}

/// A send error: what failed and why (the cause chain, without the URL,
/// which is given separately already masked).
pub fn network_failure(err: &reqwest::Error, url: &str, what: &str) -> Failure {
    let mut cause = err.to_string();
    let mut source = std::error::Error::source(err);
    while let Some(inner) = source {
        let text = inner.to_string();
        if !cause.contains(&text) {
            cause.push_str(": ");
            cause.push_str(&text);
        }
        source = inner.source();
    }
    // reqwest names the URL itself; ours is masked.
    let cause = cause.replace(&format!(" for url ({url})"), "");
    let url = endpoint::redact_url(url);
    let message = if err.is_timeout() {
        format!("{what} to {url} timed out ({cause})")
    } else {
        format!("{what} to {url} failed: {cause}")
    };
    Failure { kind: FailureKind::Network, message, url: Some(url), status: None, body: None }
}

/// A non-success response: status, address and the start of the body, plus
/// a hint for the common 404 (missing version prefix).
pub fn status_failure(status: reqwest::StatusCode, url: &str, body: &str, what: &str) -> Failure {
    let url = endpoint::redact_url(url);
    let trimmed = body.trim();
    let mut message = format!("{what} failed ({status}) at {url}");
    if !trimmed.is_empty() {
        message.push_str(": ");
        message.push_str(&compat::truncate_chars(trimmed, ERROR_BODY_CHARS));
    }
    if status.as_u16() == 404 {
        message.push_str(" — check the version prefix of the Base URL (for example /v1)");
    }
    let kind = if matches!(status.as_u16(), 401 | 403) { FailureKind::Auth } else { FailureKind::Http };
    Failure {
        kind,
        message,
        url: Some(url),
        status: Some(status.as_u16()),
        body: Some(truncate_bytes(trimmed, ERROR_BODY_BYTES)),
    }
}

fn truncate_bytes(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

/// Reads a failed response's body into a [`Failure`].
pub async fn response_failure(response: reqwest::Response, url: &str, what: &str) -> Failure {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    status_failure(status, url, &body, what)
}

// ── Streaming ───────────────────────────────────────────────────────────────

/// What a stream delivered.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct StreamTotals {
    /// Content tokens delivered.
    pub tokens: u64,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub saw_content: bool,
    pub thinking_signalled: bool,
    pub done: bool,
}

/// Reads `response` through `decoder`: content goes to `out`, the first
/// reasoning text signals thinking, an error inside the stream is reported
/// and returned. Stops early at the stream's end marker.
pub async fn pump(
    response: reqwest::Response,
    decoder: &mut dyn EventDecoder,
    params: &GenerationParams,
    out: &dyn StreamOutput,
    url: &str,
) -> Result<StreamTotals, Failure> {
    let mut totals = StreamTotals::default();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = cancellable(params, stream.next()).await? {
        check_cancelled(params)?;
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(e) => {
                if is_cancelled(params) {
                    return Err(Failure::cancelled());
                }
                let mut failure = network_failure(&e, url, "Reading the answer");
                failure.message = format!("The answer stream broke off: {}", failure.message);
                out.error(&failure.message);
                return Err(failure);
            }
        };
        let events = decoder.push(&chunk);
        handle_events(events, &mut totals, params, out, url)?;
        if totals.done {
            break;
        }
    }
    let events = decoder.finish();
    handle_events(events, &mut totals, params, out, url)?;
    if !totals.saw_content && !totals.done {
        check_cancelled(params)?;
        let message = "The model server closed the answer without sending text or a completion event".to_string();
        out.error(&message);
        return Err(Failure {
            kind: FailureKind::Stream,
            message,
            url: Some(endpoint::redact_url(url)),
            status: None,
            body: None,
        });
    }
    Ok(totals)
}

fn handle_events(
    events: Vec<StreamEvent>,
    totals: &mut StreamTotals,
    params: &GenerationParams,
    out: &dyn StreamOutput,
    url: &str,
) -> Result<(), Failure> {
    for event in events {
        match event {
            StreamEvent::Content(text) => {
                check_cancelled(params)?;
                totals.tokens += 1;
                totals.saw_content = true;
                out.token(&text);
            }
            StreamEvent::Reasoning(_) => {
                if !totals.thinking_signalled && !totals.saw_content {
                    totals.thinking_signalled = true;
                    out.thinking();
                }
            }
            StreamEvent::Usage { prompt_tokens, completion_tokens } => {
                totals.prompt_tokens = prompt_tokens;
                totals.completion_tokens = completion_tokens;
            }
            StreamEvent::Error(message) => {
                check_cancelled(params)?;
                let message = format!("The model server reported an error: {message}");
                out.error(&message);
                return Err(Failure {
                    kind: FailureKind::Stream,
                    message,
                    url: Some(endpoint::redact_url(url)),
                    status: None,
                    body: None,
                });
            }
            StreamEvent::Done => totals.done = true,
        }
    }
    Ok(())
}

/// Sends `request`, giving up when the stream is cancelled.
pub async fn send(
    request: reqwest::RequestBuilder,
    params: &GenerationParams,
    url: &str,
    what: &str,
) -> Result<reqwest::Response, Failure> {
    match cancellable(params, request.send()).await? {
        Ok(response) => Ok(response),
        Err(_) if is_cancelled(params) => Err(Failure::cancelled()),
        Err(e) => Err(network_failure(&e, url, what)),
    }
}

// ── The client ──────────────────────────────────────────────────────────────

/// Request protocol of an HTTP connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protocol {
    OpenAi,
    Anthropic,
    Gemini,
    Ollama,
}

impl Protocol {
    pub fn of(kind: LlmKind) -> Option<Self> {
        match kind {
            LlmKind::OpenAiCompat => Some(Self::OpenAi),
            LlmKind::Anthropic => Some(Self::Anthropic),
            LlmKind::Gemini => Some(Self::Gemini),
            LlmKind::Ollama => Some(Self::Ollama),
            LlmKind::ClaudeCli => None,
        }
    }

    /// The name under which `thinking` remembers, with the address called and
    /// the model, that a server refused the thinking parameter.
    fn label(self) -> &'static str {
        match self {
            Self::OpenAi => "openai_compat",
            Self::Anthropic => "anthropic",
            Self::Gemini => "gemini",
            Self::Ollama => "ollama",
        }
    }
}

/// What `setting` adds to a request body of `protocol` for `model`, as fields
/// to merge into it. The mapping itself is `llm::thinking`'s, one function
/// per API. `None`: Auto, or a model whose API has no parameter for it.
/// `openrouter` selects OpenRouter's own `reasoning` object.
pub fn thinking_fields(protocol: Protocol, openrouter: bool, model: &str, setting: ThinkingSetting) -> Option<Value> {
    let mut fields = serde_json::json!({});
    let added = match protocol {
        Protocol::OpenAi => {
            let provider = if openrouter { "openrouter" } else { protocol.label() };
            thinking::apply_openai_compat(&mut fields, provider, model, setting)
        }
        Protocol::Anthropic => thinking::apply_anthropic(&mut fields, model, setting),
        Protocol::Gemini => {
            let mut generation_config = serde_json::json!({});
            let added = thinking::apply_gemini(&mut generation_config, model, setting);
            fields["generationConfig"] = generation_config;
            added
        }
        Protocol::Ollama => match thinking::ollama_think(model, setting) {
            Some(think) => {
                fields["think"] = think;
                true
            }
            None => false,
        },
    };
    added.then_some(fields)
}

/// One answered stream.
#[derive(Debug, Clone)]
pub struct StreamResult {
    pub stats: CompletionStats,
    pub sources: Vec<StreamSource>,
    pub totals: StreamTotals,
}

/// An LLM connection over HTTP. Stateless apart from the `reqwest::Client`,
/// so one instance serves any number of concurrent requests.
pub struct HttpLlmClient {
    conn: LlmConnection,
    protocol: Protocol,
    chat_url: Result<String, String>,
    models_url: Option<Result<String, String>>,
    auth: AuthConfig,
    secret: Option<String>,
    custom: Vec<CustomHeader>,
    client: reqwest::Client,
}

impl HttpLlmClient {
    /// A client for `conn` with its secret and the values of its secret
    /// headers (by header name, lowercase).
    pub fn new(conn: &LlmConnection, secret: Option<&str>, header_secrets: &HashMap<String, String>) -> Result<Self, String> {
        let protocol = Protocol::of(conn.kind).ok_or_else(|| "The Claude subscription is not an HTTP connection".to_string())?;
        let custom: Vec<CustomHeader> = conn
            .headers
            .iter()
            .filter_map(|h| {
                let value = if h.secret {
                    header_secrets.get(&h.name.trim().to_ascii_lowercase())?.clone()
                } else {
                    h.value.clone()
                };
                Some(CustomHeader { name: h.name.clone(), value })
            })
            .collect();
        let secret = secret.map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
        // Fail early on a bad header instead of on every request.
        endpoint::request_headers(&conn.auth, secret.as_deref(), &custom).map_err(|e| e.to_string())?;
        let endpoints = connections::endpoints(conn);
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(conn.timeout_secs() as u64))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Ok(Self {
            conn: conn.clone(),
            protocol,
            chat_url: endpoints.chat,
            models_url: endpoints.models,
            auth: conn.auth.clone(),
            secret,
            custom,
            client,
        })
    }

    pub fn connection(&self) -> &LlmConnection {
        &self.conn
    }

    /// Auth header and custom headers, as sent.
    pub fn headers(&self) -> Vec<(String, String)> {
        endpoint::request_headers(&self.auth, self.secret.as_deref(), &self.custom).unwrap_or_default()
    }

    fn with_headers(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        let request = endpoint::apply_auth(request, &self.auth, self.secret.as_deref(), &self.custom)
            .unwrap_or_else(|_| unreachable_request());
        match self.protocol {
            Protocol::Anthropic => request.header("anthropic-version", anthropic::API_VERSION),
            _ => request,
        }
    }

    /// The parameters of one request: connection defaults, then the
    /// caller's (route overrides were already applied to them).
    fn effective_params(&self, params: &GenerationParams) -> EffectiveParams {
        let caller = RouteParams {
            temperature: params.temperature,
            max_tokens: params.max_tokens,
            extra_body: params.extra_body.as_ref().and_then(|v| v.as_object().cloned()),
            ..Default::default()
        };
        EffectiveParams {
            json_mode: params.json_mode,
            ..merge_params([&self.conn.params, &caller])
        }
    }

    /// How much the model thinks on one request (`thinking::resolve`): the
    /// request's own choice (made in code, or by the task's route), then
    /// this connection's setting, then Off for a background JSON task, else
    /// Auto. Auto too when `extra_body` sets thinking by hand: that JSON has
    /// the last word, and NexQ adds nothing next to it.
    fn thinking_setting(&self, params: &GenerationParams, eff: &EffectiveParams) -> ThinkingSetting {
        if compat::sets_thinking(eff.extra_body.as_ref()) {
            return ThinkingSetting::Auto;
        }
        thinking::resolve(params, self.conn.params.thinking)
    }

    /// The thinking parameter `setting` adds to a body of `protocol`.
    fn thinking_fields(&self, protocol: Protocol, model: &str, setting: ThinkingSetting) -> Option<Value> {
        thinking_fields(protocol, self.conn.is_openrouter(), model, setting)
    }

    /// Body of one chat request of `protocol`, with its thinking parameter
    /// (`thinking`, from [`Self::thinking_fields`]).
    fn chat_body(
        &self,
        protocol: Protocol,
        messages: &[LLMMessage],
        model: &str,
        params: &GenerationParams,
        eff: &EffectiveParams,
        thinking: Option<Value>,
    ) -> Value {
        let eff = &EffectiveParams { thinking, ..eff.clone() };
        let compat = &self.conn.compat;
        let web_search = params.enable_web_search.then(|| self.conn.web_search()).unwrap_or(WebSearch::None);
        match protocol {
            Protocol::OpenAi => {
                // OpenRouter: ":online" enables web search grounding for any model.
                let model_id = if web_search == WebSearch::OpenrouterOnline && !model.ends_with(":online") {
                    format!("{model}:online")
                } else {
                    model.to_string()
                };
                compat::openai_chat_body(&model_id, messages, eff, compat)
            }
            Protocol::Anthropic => anthropic::chat_body(model, messages, eff, compat),
            Protocol::Gemini => gemini::chat_body(
                messages,
                eff,
                compat,
                params.cache_name.as_deref(),
                web_search == WebSearch::GeminiGoogleSearch,
            ),
            Protocol::Ollama => compat::ollama_chat_body(model, messages, eff, compat),
        }
    }

    /// `messages` as sent: with thinking Off, a Qwen3 hybrid model behind an
    /// OpenAI-compatible server or Ollama also gets Qwen's `/no_think` switch
    /// in the prompt (`thinking::apply_prompt_hint`).
    fn with_prompt_hint<'m>(
        &self,
        messages: &'m [LLMMessage],
        model: &str,
        setting: ThinkingSetting,
    ) -> std::borrow::Cow<'m, [LLMMessage]> {
        let hinted = matches!(self.protocol, Protocol::OpenAi | Protocol::Ollama)
            && setting == ThinkingSetting::Off
            && thinking::is_qwen3_hybrid(model);
        if !hinted {
            return std::borrow::Cow::Borrowed(messages);
        }
        let mut messages = messages.to_vec();
        thinking::apply_prompt_hint(&mut messages, model, setting);
        std::borrow::Cow::Owned(messages)
    }

    /// Chat address and body of one request as first sent (`with_thinking`
    /// false: as sent again after the server refused the thinking parameter).
    #[cfg(test)]
    fn chat_request(
        &self,
        messages: &[LLMMessage],
        model: &str,
        params: &GenerationParams,
        with_thinking: bool,
    ) -> Result<(String, Value), Failure> {
        let chat_url = self.chat_url.as_ref().map_err(|e| Failure::config(e.clone()))?;
        let url = connections::chat_url_for(chat_url, model);
        let eff = self.effective_params(params);
        let setting = self.thinking_setting(params, &eff);
        let messages = self.with_prompt_hint(messages, model, setting);
        let thinking = with_thinking.then(|| self.thinking_fields(self.protocol, model, setting)).flatten();
        Ok((url, self.chat_body(self.protocol, &messages, model, params, &eff, thinking)))
    }

    /// Sends one chat request of `protocol` to `url`. The thinking parameter
    /// goes along unless this address already refused it for `model`; a 400
    /// that refuses it is answered by one more request without it and
    /// remembered for the session (`thinking::send_with_fallback`).
    /// `Ok(Err(_))` is the server's error answer, `Err(_)` a request that got
    /// none.
    #[allow(clippy::too_many_arguments)]
    async fn post_chat(
        &self,
        protocol: Protocol,
        url: &str,
        what: &str,
        messages: &[LLMMessage],
        model: &str,
        params: &GenerationParams,
        eff: &EffectiveParams,
        setting: ThinkingSetting,
    ) -> Result<Result<reqwest::Response, Failure>, Failure> {
        let label = protocol.label();
        let thinking = thinking::should_send(label, url, model, setting)
            .then(|| self.thinking_fields(protocol, model, setting))
            .flatten();
        // Why a request got no answer, as `send` tells it (the address, the
        // cause): `send_with_fallback` passes errors on as `LLMError`, which
        // keeps less.
        let unanswered: std::sync::Mutex<Option<Failure>> = std::sync::Mutex::new(None);
        let sent = thinking::send_with_fallback(label, url, model, thinking.is_some(), params, |with_thinking| {
            let fields = if with_thinking { thinking.clone() } else { None };
            let body = self.chat_body(protocol, messages, model, params, eff, fields);
            let request = self.with_headers(self.client.post(url)).json(&body);
            let unanswered = &unanswered;
            async move {
                send(request, params, url, what).await.map_err(|failure| {
                    let error = LLMError::from(failure.clone());
                    if let Ok(mut slot) = unanswered.lock() {
                        *slot = Some(failure);
                    }
                    error
                })
            }
        })
        .await;
        match sent {
            Ok(Sent::Ok(response)) => Ok(Ok(response)),
            Ok(Sent::Failed { status, body }) => Ok(Err(status_failure(status, url, &body, what))),
            Err(error) => Err(unanswered
                .lock()
                .ok()
                .and_then(|mut slot| slot.take())
                .unwrap_or_else(|| Failure::from(error))),
        }
    }

    fn decoder(&self, protocol: Protocol, collect_sources: bool) -> Box<dyn EventDecoder> {
        let compat = &self.conn.compat;
        match protocol {
            Protocol::OpenAi | Protocol::Ollama => Box::new(StreamDecoder::new(compat)),
            Protocol::Anthropic => Box::new(anthropic::AnthropicDecoder::new(compat)),
            Protocol::Gemini => Box::new(gemini::GeminiDecoder::new(compat, collect_sources)),
        }
    }

    /// Streams one answer to `out`. Errors are reported to `out` before they
    /// are returned (a cancelled stream reports nothing).
    pub async fn stream_with(
        &self,
        messages: &[LLMMessage],
        model: &str,
        params: &GenerationParams,
        out: &dyn StreamOutput,
    ) -> Result<StreamResult, Failure> {
        let start = Instant::now();
        let result = self.stream_inner(messages, model, params, out, start).await;
        if let Err(failure) = &result {
            // Failures before the body was read were not reported yet.
            if matches!(failure.kind, FailureKind::Config | FailureKind::Network | FailureKind::Auth | FailureKind::Http)
                && !failure.message.starts_with("The answer stream broke off")
                && !is_cancelled(params)
            {
                out.error(&failure.message);
            }
        }
        result
    }

    async fn stream_inner(
        &self,
        messages: &[LLMMessage],
        model: &str,
        params: &GenerationParams,
        out: &dyn StreamOutput,
        start: Instant,
    ) -> Result<StreamResult, Failure> {
        let chat_url = self.chat_url.as_ref().map_err(|e| Failure::config(e.clone()))?;
        let url = connections::chat_url_for(chat_url, model);
        let eff = self.effective_params(params);
        let setting = self.thinking_setting(params, &eff);
        let messages = self.with_prompt_hint(messages, model, setting);
        let messages: &[LLMMessage] = &messages;
        let first = self
            .post_chat(self.protocol, &url, "Chat request", messages, model, params, &eff, setting)
            .await?;
        let (response, protocol, used_url) = match first {
            Ok(response) => (response, self.protocol, url),
            Err(failure) => {
                check_cancelled(params)?;
                if !(self.protocol == Protocol::OpenAi
                    && self.conn.compat.ollama_fallback_on_404
                    && matches!(failure.status, Some(404) | Some(405)))
                {
                    return Err(failure);
                }
                // The old custom endpoint also spoke Ollama's API: try it, and
                // show both errors if that fails too.
                let fallback_url = endpoint::join_endpoint(&self.conn.base_url, "/api/chat")
                    .map(String::from)
                    .map_err(|_| failure.clone())?;
                let second = self
                    .post_chat(
                        Protocol::Ollama,
                        &fallback_url,
                        "Ollama chat request",
                        messages,
                        model,
                        params,
                        &eff,
                        setting,
                    )
                    .await;
                match second {
                    Ok(Ok(response)) => (response, Protocol::Ollama, fallback_url),
                    Ok(Err(second)) | Err(second) if second.kind == FailureKind::Cancelled => return Err(second),
                    Ok(Err(second)) | Err(second) => {
                        return Err(Failure {
                            message: format!("{}; the Ollama fallback failed too: {}", failure.message, second.message),
                            ..failure
                        })
                    }
                }
            }
        };

        let mut decoder = self.decoder(protocol, params.enable_web_search);
        let totals = pump(response, decoder.as_mut(), params, out, &used_url).await?;
        let completion = if totals.completion_tokens > 0 { totals.completion_tokens } else { totals.tokens };
        let stats = CompletionStats {
            prompt_tokens: totals.prompt_tokens,
            completion_tokens: completion,
            total_tokens: totals.prompt_tokens + completion,
            latency_ms: start.elapsed().as_millis() as u64,
        };
        Ok(StreamResult { stats, sources: decoder.sources(), totals })
    }

    /// The model list address (`None`: disabled).
    pub fn models_url(&self) -> Option<Result<String, String>> {
        self.models_url.clone()
    }

    /// The chat address for `model`.
    pub fn chat_url(&self, model: &str) -> Result<String, String> {
        self.chat_url.as_ref().map(|url| connections::chat_url_for(url, model)).map_err(Clone::clone)
    }

    /// Lists the models (one request; Anthropic pages). Disabled lists give
    /// an empty list.
    pub async fn fetch_models(&self) -> Result<(String, Vec<ModelInfo>), Failure> {
        let Some(url) = self.models_url.clone() else {
            return Ok((String::new(), Vec::new()));
        };
        let url = url.map_err(Failure::config)?;
        let provider = self.conn.legacy_type();
        match self.protocol {
            Protocol::Anthropic => {
                let models = anthropic::fetch_all_models(self, &url, provider).await?;
                Ok((url, models))
            }
            _ => match self.get_json(&url, "Model list request").await {
                Ok(body) => Ok((url, self.parse_models(self.protocol, &body, provider))),
                Err(failure)
                    if self.protocol == Protocol::OpenAi
                        && self.conn.compat.ollama_fallback_on_404
                        && matches!(failure.status, Some(404) | Some(405)) =>
                {
                    let tags = endpoint::join_endpoint(&self.conn.base_url, "/api/tags")
                        .map(String::from)
                        .map_err(|_| failure.clone())?;
                    match self.get_json(&tags, "Ollama model list request").await {
                        Ok(body) => Ok((tags, ollama::parse_models(&body, provider))),
                        Err(second) => Err(Failure {
                            message: format!("{}; the Ollama fallback failed too: {}", failure.message, second.message),
                            ..failure
                        }),
                    }
                }
                Err(failure) => Err(failure),
            },
        }
    }

    fn parse_models(&self, protocol: Protocol, body: &Value, provider: &str) -> Vec<ModelInfo> {
        match protocol {
            Protocol::OpenAi => openai_compat::parse_models(body, provider),
            Protocol::Gemini => gemini::parse_models(body, provider),
            Protocol::Ollama => ollama::parse_models(body, provider),
            Protocol::Anthropic => anthropic::parse_models(body, provider).0,
        }
    }

    /// GET `url` with this connection's headers; the JSON body on success.
    pub async fn get_json(&self, url: &str, what: &str) -> Result<Value, Failure> {
        let request = self.with_headers(self.client.get(url)).timeout(REQUEST_TIMEOUT);
        let response = request.send().await.map_err(|e| network_failure(&e, url, what))?;
        if !response.status().is_success() {
            return Err(response_failure(response, url, what).await);
        }
        let text = response.text().await.map_err(|e| network_failure(&e, url, what))?;
        serde_json::from_str(&text).map_err(|e| Failure {
            kind: FailureKind::Http,
            message: format!("{what} to {} returned something that is not JSON ({e}): {}", endpoint::redact_url(url), compat::truncate_chars(text.trim(), ERROR_BODY_CHARS)),
            url: Some(endpoint::redact_url(url)),
            status: Some(200),
            body: Some(truncate_bytes(text.trim(), ERROR_BODY_BYTES)),
        })
    }

    /// Checks the connection without spending tokens: the model list (or
    /// OpenRouter's key endpoint, since its model list is public).
    pub async fn check(&self) -> Result<String, Failure> {
        let url = if self.protocol == Protocol::OpenAi && self.conn.is_openrouter() {
            endpoint::join_endpoint(&self.conn.base_url, "/auth/key").map(String::from).map_err(|e| Failure::config(e.to_string()))?
        } else {
            match self.models_url.clone() {
                Some(url) => url.map_err(Failure::config)?,
                None => return Err(Failure::config("This connection has no model list to check; test it with a chat request")),
            }
        };
        self.get_json(&url, "Connection check").await.map(|_| url)
    }
}

/// Headers were checked when the client was built, so applying them cannot
/// fail; should it ever, the request goes out without them and the server's
/// 401 says why.
fn unreachable_request() -> reqwest::RequestBuilder {
    reqwest::Client::new().get("http://invalid.invalid")
}

#[async_trait::async_trait]
impl LLMProvider for HttpLlmClient {
    fn provider_name(&self) -> &str {
        self.conn.legacy_type()
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, LLMError> {
        Ok(self.fetch_models().await?.1)
    }

    async fn test_connection(&self) -> Result<bool, LLMError> {
        self.check().await.map(|_| true).map_err(LLMError::from)
    }

    async fn stream_completion(
        &self,
        messages: Vec<LLMMessage>,
        model: &str,
        params: GenerationParams,
        app_handle: AppHandle,
        sink: Option<TokenSink>,
    ) -> Result<CompletionStats, LLMError> {
        // NOTE: llm_stream_start is emitted by the caller with the correct mode.
        let out = AppOutput { app: &app_handle, params: &params, sink: sink.as_ref() };
        let result = self.stream_with(&messages, model, &params, &out).await?;
        check_cancelled(&params)?;
        if !result.sources.is_empty() {
            emit_sources(&app_handle, &params, result.sources);
        }
        emit_end_with_stats(&app_handle, &params, &result.stats);
        Ok(result.stats)
    }
}

#[cfg(test)]
pub mod test_support {
    //! A tiny local HTTP server and a recording output, for protocol tests
    //! that run real requests without the network.

    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::StreamOutput;

    /// One canned response; `chunks` are written with a pause between them so
    /// the client reads them separately.
    #[derive(Clone)]
    pub struct Canned {
        pub status: u16,
        pub content_type: &'static str,
        pub chunks: Vec<Vec<u8>>,
    }

    impl Canned {
        pub fn new(status: u16, content_type: &'static str, chunks: Vec<Vec<u8>>) -> Self {
            Self { status, content_type, chunks }
        }

        pub fn json(status: u16, body: &str) -> Self {
            Self::new(status, "application/json", vec![body.as_bytes().to_vec()])
        }

        pub fn sse(chunks: &[&str]) -> Self {
            Self::new(200, "text/event-stream", chunks.iter().map(|c| c.as_bytes().to_vec()).collect())
        }
    }

    #[derive(Debug, Clone)]
    pub struct Recorded {
        pub method: String,
        pub path: String,
        pub headers: Vec<(String, String)>,
        pub body: String,
    }

    impl Recorded {
        pub fn header(&self, name: &str) -> Option<&str> {
            self.headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
        }

        pub fn json(&self) -> serde_json::Value {
            serde_json::from_str(&self.body).unwrap_or(serde_json::Value::Null)
        }
    }

    /// Serves `responses` in order (one per connection; the last repeats).
    /// Returns the base URL (`http://127.0.0.1:<port>`) and the requests seen.
    pub async fn serve(responses: Vec<Canned>) -> (String, Arc<Mutex<Vec<Recorded>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            let mut index = 0usize;
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { return };
                let canned = responses[index.min(responses.len() - 1)].clone();
                index += 1;
                let log = log.clone();
                tokio::spawn(async move {
                    let Some(request) = read_request(&mut socket).await else { return };
                    log.lock().unwrap().push(request);
                    let head = format!(
                        "HTTP/1.1 {} X\r\nContent-Type: {}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
                        canned.status, canned.content_type
                    );
                    if socket.write_all(head.as_bytes()).await.is_err() {
                        return;
                    }
                    for chunk in canned.chunks {
                        let frame = [format!("{:x}\r\n", chunk.len()).into_bytes(), chunk, b"\r\n".to_vec()].concat();
                        if socket.write_all(&frame).await.is_err() {
                            return;
                        }
                        let _ = socket.flush().await;
                        tokio::time::sleep(Duration::from_millis(15)).await;
                    }
                    let _ = socket.write_all(b"0\r\n\r\n").await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        (format!("http://{addr}"), seen)
    }

    async fn read_request(socket: &mut tokio::net::TcpStream) -> Option<Recorded> {
        let mut data = Vec::new();
        let mut buf = [0u8; 4096];
        let head_end = loop {
            let n = socket.read(&mut buf).await.ok()?;
            if n == 0 {
                return None;
            }
            data.extend_from_slice(&buf[..n]);
            if let Some(pos) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                break pos;
            }
        };
        let head = String::from_utf8_lossy(&data[..head_end]).to_string();
        let mut lines = head.split("\r\n");
        let mut first = lines.next()?.split(' ');
        let method = first.next()?.to_string();
        let path = first.next()?.to_string();
        let headers: Vec<(String, String)> = lines
            .filter_map(|l| l.split_once(':').map(|(n, v)| (n.trim().to_ascii_lowercase(), v.trim().to_string())))
            .collect();
        let length: usize = headers.iter().find(|(n, _)| n == "content-length").and_then(|(_, v)| v.parse().ok()).unwrap_or(0);
        let mut body = data[head_end + 4..].to_vec();
        while body.len() < length {
            let n = socket.read(&mut buf).await.ok()?;
            if n == 0 {
                break;
            }
            body.extend_from_slice(&buf[..n]);
        }
        Some(Recorded { method, path, headers, body: String::from_utf8_lossy(&body).to_string() })
    }

    /// Records what a stream delivered.
    #[derive(Default)]
    pub struct RecordingOutput {
        pub tokens: Mutex<Vec<String>>,
        pub thinking: Mutex<u32>,
        pub errors: Mutex<Vec<String>>,
    }

    impl RecordingOutput {
        pub fn text(&self) -> String {
            self.tokens.lock().unwrap().concat()
        }
    }

    impl StreamOutput for RecordingOutput {
        fn token(&self, token: &str) {
            self.tokens.lock().unwrap().push(token.to_string());
        }

        fn thinking(&self) {
            *self.thinking.lock().unwrap() += 1;
        }

        fn error(&self, message: &str) {
            self.errors.lock().unwrap().push(message.to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{serve, Canned, RecordingOutput};
    use super::*;
    use crate::llm::connections::{LlmHeader, ModelsEndpoint};
    use crate::net::endpoint::AuthMode;
    use serde_json::json;

    fn messages() -> Vec<LLMMessage> {
        vec![
            LLMMessage { role: "system".into(), content: "Be brief.".into() },
            LLMMessage { role: "user".into(), content: "你好".into() },
        ]
    }

    fn compat_conn(base: &str) -> LlmConnection {
        LlmConnection {
            id: "c_test".into(),
            name: "Test".into(),
            kind: LlmKind::OpenAiCompat,
            base_url: base.to_string(),
            auth: AuthConfig { mode: AuthMode::Bearer, ..Default::default() },
            ..Default::default()
        }
    }

    #[test]
    fn native_json_mode_needs_both_caller_request_and_connection_support() {
        for (kind, base, field, value) in [
            (LlmKind::OpenAiCompat, "http://localhost:8000/custom-prefix", "/response_format", json!({"type": "json_object"})),
            (LlmKind::Ollama, "http://localhost:11434", "/format", json!("json")),
            (LlmKind::Gemini, "https://generativelanguage.googleapis.com", "/generationConfig/responseMimeType", json!("application/json")),
        ] {
            let mut conn = compat_conn(base);
            conn.kind = kind;
            conn.auth = AuthConfig { mode: AuthMode::None, ..Default::default() };
            for supported in [false, true] {
                conn.compat.supports_json_mode = supported;
                let client = HttpLlmClient::new(&conn, None, &HashMap::new()).unwrap();
                for requested in [false, true] {
                    let params = GenerationParams { json_mode: requested, ..Default::default() };
                    let (_, body) = client.chat_request(&messages(), "small-model", &params, true).unwrap();
                    assert_eq!(body.pointer(field), (supported && requested).then_some(&value), "{kind:?}, supported={supported}, requested={requested}");
                }
            }
        }
    }

    #[test]
    fn json_mode_keeps_explicit_body_overrides_and_custom_endpoint() {
        let mut conn = compat_conn("http://localhost:8000/my/llm");
        conn.compat.supports_json_mode = true;
        conn.params.extra_body = Some(json!({"response_format": {"type": "json_schema", "json_schema": {"name": "answer"}}}).as_object().unwrap().clone());
        let client = HttpLlmClient::new(&conn, None, &HashMap::new()).unwrap();
        let params = GenerationParams { json_mode: true, ..Default::default() };
        let (url, body) = client.chat_request(&messages(), "m", &params, true).unwrap();
        assert_eq!(url, "http://localhost:8000/my/llm/chat/completions");
        assert_eq!(body["response_format"]["type"], "json_schema");
        let params = GenerationParams { extra_body: Some(json!({"response_format": {"type": "text"}})), ..params };
        let (_, body) = client.chat_request(&messages(), "m", &params, true).unwrap();
        assert_eq!(body["response_format"]["type"], "text");
    }

    // ── Thinking (upstream #126 on connections) ─────────────────────────────

    use crate::llm::thinking::ThinkingSetting::{Auto, High, Low, Off};

    fn conn_of(kind: LlmKind, base: &str, thinking: ThinkingSetting) -> LlmConnection {
        let mut conn = compat_conn(base);
        conn.kind = kind;
        conn.auth = AuthConfig { mode: AuthMode::None, ..Default::default() };
        conn.params.thinking = thinking;
        conn
    }

    /// The first body a connection of `kind` with `thinking` sends for `model`.
    fn first_body(kind: LlmKind, model: &str, thinking: ThinkingSetting, params: &GenerationParams) -> Value {
        let base = if kind == LlmKind::Ollama { "http://localhost:11434" } else { "http://localhost:8000/v1" };
        let client = HttpLlmClient::new(&conn_of(kind, base, thinking), None, &HashMap::new()).unwrap();
        client.chat_request(&messages(), model, params, true).unwrap().1
    }

    #[test]
    fn auto_sends_no_thinking_parameter_on_any_protocol() {
        let params = GenerationParams { temperature: Some(0.3), max_tokens: Some(50), ..Default::default() };
        for kind in [LlmKind::OpenAiCompat, LlmKind::Anthropic, LlmKind::Gemini, LlmKind::Ollama] {
            let body = first_body(kind, "claude-sonnet-5-5", Auto, &params);
            for key in ["reasoning_effort", "reasoning", "thinking", "output_config", "think"] {
                assert!(body.get(key).is_none(), "{kind:?} {key}");
            }
            assert!(body.pointer("/generationConfig/thinkingConfig").is_none(), "{kind:?}");
        }
        // Everything else is what it always was.
        let body = first_body(LlmKind::OpenAiCompat, "m", Auto, &params);
        assert_eq!(body, json!({"model": "m", "messages": [{"role": "system", "content": "Be brief."}, {"role": "user", "content": "你好"}], "stream": true, "temperature": 0.3, "max_tokens": 50}));
    }

    #[test]
    fn off_low_high_use_each_apis_own_parameter() {
        let plain = GenerationParams::default();
        // OpenAI-compatible: reasoning_effort.
        assert_eq!(first_body(LlmKind::OpenAiCompat, "gpt-5.1", Off, &plain)["reasoning_effort"], "none");
        assert_eq!(first_body(LlmKind::OpenAiCompat, "gpt-5-mini", Off, &plain)["reasoning_effort"], "minimal");
        assert_eq!(first_body(LlmKind::OpenAiCompat, "doubao-seed-1-6", Low, &plain)["reasoning_effort"], "low");
        assert_eq!(first_body(LlmKind::OpenAiCompat, "gpt-5", High, &plain)["reasoning_effort"], "high");
        // Anthropic: adaptive thinking and effort, only on the models that take them.
        assert_eq!(first_body(LlmKind::Anthropic, "claude-opus-4-8", Off, &plain)["thinking"], json!({"type": "disabled"}));
        let high = first_body(LlmKind::Anthropic, "claude-sonnet-5-5", High, &plain);
        assert_eq!((&high["thinking"], &high["output_config"]), (&json!({"type": "adaptive"}), &json!({"effort": "high"})));
        assert!(first_body(LlmKind::Anthropic, "claude-haiku-4-5", High, &plain).get("thinking").is_none());
        // Gemini: thinkingConfig inside generationConfig, next to what was there.
        let flash = first_body(LlmKind::Gemini, "gemini-2.5-flash", Off, &plain);
        assert_eq!(flash["generationConfig"], json!({"maxOutputTokens": 4096, "thinkingConfig": {"thinkingBudget": 0}}));
        let pro = first_body(LlmKind::Gemini, "gemini-3-pro-preview", High, &plain);
        assert_eq!(pro["generationConfig"]["thinkingConfig"], json!({"thinkingLevel": "high"}));
        let cached = GenerationParams { cache_name: Some("cachedContents/abc".into()), ..Default::default() };
        let with_cache = first_body(LlmKind::Gemini, "gemini-2.5-flash", Off, &cached);
        assert_eq!(with_cache["cachedContent"], "cachedContents/abc");
        assert_eq!(with_cache["generationConfig"]["thinkingConfig"]["thinkingBudget"], 0);
        // Ollama: think.
        assert_eq!(first_body(LlmKind::Ollama, "llama3.2", Off, &plain)["think"], false);
        assert_eq!(first_body(LlmKind::Ollama, "llama3.2", High, &plain)["think"], true);
        assert_eq!(first_body(LlmKind::Ollama, "gpt-oss:20b", High, &plain)["think"], "high");
    }

    #[test]
    fn openrouter_uses_its_reasoning_object_and_keeps_the_online_suffix() {
        let mut conn = conn_of(LlmKind::OpenAiCompat, "https://openrouter.ai/api/v1", Off);
        conn.template = Some("openrouter".into());
        let client = HttpLlmClient::new(&conn, None, &HashMap::new()).unwrap();
        let params = GenerationParams { enable_web_search: true, ..Default::default() };
        let (_, body) = client.chat_request(&messages(), "m", &params, true).unwrap();
        assert_eq!(body["reasoning"], json!({"enabled": false}));
        assert!(body.get("reasoning_effort").is_none());
        assert_eq!(body["model"], "m:online");
    }

    #[test]
    fn the_retry_body_has_no_thinking_parameter() {
        for (kind, model) in [
            (LlmKind::OpenAiCompat, "gpt-5.1"),
            (LlmKind::Anthropic, "claude-sonnet-5-5"),
            (LlmKind::Gemini, "gemini-2.5-flash"),
            (LlmKind::Ollama, "llama3.2"),
        ] {
            let client = HttpLlmClient::new(&conn_of(kind, "http://localhost:8000/v1", High), None, &HashMap::new()).unwrap();
            let (_, with) = client.chat_request(&messages(), model, &GenerationParams::default(), true).unwrap();
            let (_, without) = client.chat_request(&messages(), model, &GenerationParams::default(), false).unwrap();
            assert_ne!(with, without, "{kind:?}");
            let auto = HttpLlmClient::new(&conn_of(kind, "http://localhost:8000/v1", Auto), None, &HashMap::new()).unwrap();
            let (_, plain) = auto.chat_request(&messages(), model, &GenerationParams::default(), true).unwrap();
            assert_eq!(without, plain, "{kind:?}: the retry is the Auto body");
        }
    }

    #[test]
    fn the_request_beats_the_connection_and_background_tasks_default_to_off() {
        let effort = |connection, params: &GenerationParams| {
            first_body(LlmKind::OpenAiCompat, "gpt-5.1", connection, params).get("reasoning_effort").cloned()
        };
        let plain = GenerationParams::default();
        let background = GenerationParams { thinking_auto_off: true, ..Default::default() };
        let explicit = GenerationParams { thinking: Low, thinking_auto_off: true, ..Default::default() };
        assert_eq!(effort(Auto, &plain), None);
        assert_eq!(effort(High, &plain), Some(json!("high")));
        // A background JSON task: Off, unless the user set something.
        assert_eq!(effort(Auto, &background), Some(json!("none")));
        assert_eq!(effort(High, &background), Some(json!("high")));
        // The request's own choice (code, or the task's route) wins.
        assert_eq!(effort(High, &explicit), Some(json!("low")));
    }

    #[test]
    fn a_thinking_key_in_extra_body_has_the_last_word() {
        // The connection says High; its extra_body sets thinking by hand.
        let mut conn = conn_of(LlmKind::Anthropic, "https://api.anthropic.com", High);
        conn.params.extra_body = Some(json!({"thinking": {"type": "disabled"}}).as_object().unwrap().clone());
        let client = HttpLlmClient::new(&conn, None, &HashMap::new()).unwrap();
        let (_, body) = client.chat_request(&messages(), "claude-sonnet-5-5", &GenerationParams::default(), true).unwrap();
        assert_eq!(body["thinking"], json!({"type": "disabled"}));
        assert!(body.get("output_config").is_none(), "nothing of NexQ's own next to it");

        // A route's extra_body counts the same (a provider that takes `thinking`, not `reasoning_effort`).
        let conn = conn_of(LlmKind::OpenAiCompat, "https://ark.example.com/api/v3", Off);
        let client = HttpLlmClient::new(&conn, None, &HashMap::new()).unwrap();
        let routed = GenerationParams { extra_body: Some(json!({"thinking": {"type": "enabled"}})), ..Default::default() };
        let (_, body) = client.chat_request(&messages(), "doubao-seed-1-6", &routed, true).unwrap();
        assert_eq!(body["thinking"], json!({"type": "enabled"}));
        assert!(body.get("reasoning_effort").is_none());

        // Gemini's nested thinkingConfig is replaced, not mixed.
        let mut conn = conn_of(LlmKind::Gemini, "https://generativelanguage.googleapis.com", Off);
        conn.params.extra_body = Some(json!({"generationConfig": {"thinkingConfig": {"thinkingLevel": "high"}}}).as_object().unwrap().clone());
        let client = HttpLlmClient::new(&conn, None, &HashMap::new()).unwrap();
        let (_, body) = client.chat_request(&messages(), "gemini-3-pro-preview", &GenerationParams::default(), true).unwrap();
        assert_eq!(body["generationConfig"]["thinkingConfig"], json!({"thinkingLevel": "high"}));

        // Other extra_body keys leave the setting alone.
        let mut conn = conn_of(LlmKind::Ollama, "http://localhost:11434", Off);
        conn.params.extra_body = Some(json!({"options": {"num_ctx": 8192}}).as_object().unwrap().clone());
        let client = HttpLlmClient::new(&conn, None, &HashMap::new()).unwrap();
        let params = GenerationParams { temperature: Some(0.3), ..Default::default() };
        let (_, body) = client.chat_request(&messages(), "llama3.2", &params, true).unwrap();
        assert_eq!(body["think"], false);
        assert_eq!(body["options"], json!({"temperature": 0.3, "num_ctx": 8192}));
    }

    #[test]
    fn qwen3_gets_the_no_think_switch_only_when_off_and_only_where_it_works() {
        let system = |kind, model: &str, thinking| {
            let body = first_body(kind, model, thinking, &GenerationParams::default());
            body["messages"][0]["content"].as_str().unwrap_or_default().to_string()
        };
        assert_eq!(system(LlmKind::OpenAiCompat, "Qwen/Qwen3-32B", Off), "Be brief.\n/no_think");
        assert_eq!(system(LlmKind::Ollama, "qwen3:8b", Off), "Be brief.\n/no_think");
        assert_eq!(system(LlmKind::Ollama, "qwen3:8b", High), "Be brief.");
        assert_eq!(system(LlmKind::Ollama, "qwen3:8b", Auto), "Be brief.");
        assert_eq!(system(LlmKind::Ollama, "llama3.2", Off), "Be brief.");
        // The caller's own messages are never changed.
        let body = first_body(LlmKind::Anthropic, "qwen3-coder", Off, &GenerationParams::default());
        assert_eq!(body["system"], "Be brief.");
    }

    #[tokio::test]
    async fn a_refused_thinking_parameter_is_retried_once_then_remembered() {
        let refusal = r#"{"error":{"message":"Unrecognized request argument supplied: reasoning_effort"}}"#;
        let answer = "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n";
        let (base, seen) = serve(vec![Canned::json(400, refusal), Canned::sse(&[answer])]).await;
        let client = HttpLlmClient::new(&conn_of(LlmKind::OpenAiCompat, &format!("{base}/v1"), Off), None, &HashMap::new()).unwrap();
        let url = format!("{base}/v1/chat/completions");

        let out = RecordingOutput::default();
        client.stream_with(&messages(), "retry-model", &GenerationParams::default(), &out).await.unwrap();
        assert_eq!(out.text(), "ok");
        assert!(out.errors.lock().unwrap().is_empty(), "the refusal is not shown");
        let bodies: Vec<Value> = seen.lock().unwrap().iter().map(|r| r.json()).collect();
        assert_eq!(bodies.len(), 2, "one try with the parameter, one without");
        assert_eq!(bodies[0]["reasoning_effort"], "none");
        assert!(bodies[1].get("reasoning_effort").is_none());
        assert!(thinking::is_known_unsupported("openai_compat", &url, "retry-model"));

        // The next request does not try the parameter again.
        client.stream_with(&messages(), "retry-model", &GenerationParams::default(), &RecordingOutput::default()).await.unwrap();
        let bodies: Vec<Value> = seen.lock().unwrap().iter().map(|r| r.json()).collect();
        assert_eq!(bodies.len(), 3);
        assert!(bodies[2].get("reasoning_effort").is_none());
        // Another model on the same server still gets it.
        assert!(thinking::should_send("openai_compat", &url, "another-model", Off));
    }

    #[tokio::test]
    async fn an_unrelated_400_and_an_auto_request_are_not_retried() {
        let (base, seen) = serve(vec![Canned::json(400, r#"{"error":"context length exceeded"}"#)]).await;
        let client = HttpLlmClient::new(&conn_of(LlmKind::OpenAiCompat, &format!("{base}/v1"), Off), None, &HashMap::new()).unwrap();
        let failure = client.stream_with(&messages(), "strict-model", &GenerationParams::default(), &RecordingOutput::default()).await.unwrap_err();
        assert_eq!(failure.status, Some(400));
        assert!(failure.message.contains("context length exceeded"));
        assert_eq!(seen.lock().unwrap().len(), 1);
        assert!(!thinking::is_known_unsupported("openai_compat", &format!("{base}/v1/chat/completions"), "strict-model"));

        // Auto sent no parameter, so a 400 that names one is the server's own business.
        let (base, seen) = serve(vec![Canned::json(400, r#"{"error":"reasoning_effort bad"}"#)]).await;
        let client = HttpLlmClient::new(&conn_of(LlmKind::OpenAiCompat, &format!("{base}/v1"), Auto), None, &HashMap::new()).unwrap();
        let failure = client.stream_with(&messages(), "auto-model", &GenerationParams::default(), &RecordingOutput::default()).await.unwrap_err();
        assert_eq!(failure.status, Some(400));
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn the_ollama_fallback_retries_without_a_refused_think_parameter() {
        // /chat/completions is missing (404); Ollama's /api/chat refuses `think`, then answers.
        let ollama = "{\"message\":{\"content\":\"from ollama\"}}\n{\"done\":true}\n";
        let (base, seen) = serve(vec![
            Canned::json(404, "nope"),
            Canned::json(400, r#"{"error":"\"m\" does not support thinking"}"#),
            Canned::new(200, "application/x-ndjson", vec![ollama.as_bytes().to_vec()]),
        ])
        .await;
        let mut conn = conn_of(LlmKind::OpenAiCompat, &base, Off);
        conn.compat.ollama_fallback_on_404 = true;
        let client = HttpLlmClient::new(&conn, None, &HashMap::new()).unwrap();
        let out = RecordingOutput::default();
        client.stream_with(&messages(), "native-retry-model", &GenerationParams::default(), &out).await.unwrap();
        assert_eq!(out.text(), "from ollama");
        let requests = seen.lock().unwrap().clone();
        assert_eq!(requests.iter().map(|r| r.path.as_str()).collect::<Vec<_>>(), ["/chat/completions", "/api/chat", "/api/chat"]);
        assert_eq!(requests[0].json()["reasoning_effort"], "none");
        assert_eq!(requests[1].json()["think"], false);
        assert!(requests[2].json().get("think").is_none());
        // Each address has its own memory: /chat/completions never refused the parameter.
        assert!(thinking::is_known_unsupported("ollama", &format!("{base}/api/chat"), "native-retry-model"));
        assert!(!thinking::is_known_unsupported("openai_compat", &format!("{base}/chat/completions"), "native-retry-model"));
    }

    #[tokio::test]
    async fn a_new_base_url_is_not_treated_as_refusing() {
        let (old_base, _) = serve(vec![Canned::json(400, r#"{"error":"unknown field reasoning_effort"}"#)]).await;
        let client = HttpLlmClient::new(&conn_of(LlmKind::OpenAiCompat, &format!("{old_base}/v1"), Off), None, &HashMap::new()).unwrap();
        let _ = client.stream_with(&messages(), "shared-model", &GenerationParams::default(), &RecordingOutput::default()).await;
        assert!(thinking::is_known_unsupported("openai_compat", &format!("{old_base}/v1/chat/completions"), "shared-model"));

        let (new_base, seen) = serve(vec![Canned::sse(&["data: [DONE]\n\n"])]).await;
        let client = HttpLlmClient::new(&conn_of(LlmKind::OpenAiCompat, &format!("{new_base}/v1"), Off), None, &HashMap::new()).unwrap();
        client.stream_with(&messages(), "shared-model", &GenerationParams::default(), &RecordingOutput::default()).await.unwrap();
        let requests = seen.lock().unwrap().clone();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].json()["reasoning_effort"], "none");
    }

    #[tokio::test]
    async fn openai_stream_with_split_chinese_custom_path_and_headers() {
        let first = "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"，世";
        let rest = "界\"}}]}\n\ndata: [DONE]\n\n";
        // Cut inside 世 (3 bytes) to force a split character.
        let mut bytes = first.as_bytes().to_vec();
        let tail = "界".as_bytes();
        bytes.extend_from_slice(&tail[..1]);
        let second = [&tail[1..], &rest.as_bytes()["界".len()..]].concat();
        let (base, seen) = serve(vec![Canned::new(200, "text/event-stream", vec![bytes, second])]).await;
        let mut conn = compat_conn(&format!("{base}/api/paas/v4"));
        conn.headers = vec![LlmHeader { name: "X-Team".into(), value: "nexq".into(), ..Default::default() }];
        let client = HttpLlmClient::new(&conn, Some("sk-test"), &HashMap::new()).unwrap();
        let out = RecordingOutput::default();
        let params = GenerationParams { temperature: Some(0.2), ..Default::default() };

        let result = client.stream_with(&messages(), "glm-4", &params, &out).await.unwrap();

        assert_eq!(out.text(), "你好，世界");
        assert!(!out.text().contains('\u{FFFD}'));
        assert_eq!(result.stats.completion_tokens, 2, "two content chunks");
        let request = seen.lock().unwrap()[0].clone();
        assert_eq!(request.path, "/api/paas/v4/chat/completions", "the typed path is kept, no /v1 added");
        assert_eq!(request.header("authorization"), Some("Bearer sk-test"));
        assert_eq!(request.header("x-team"), Some("nexq"));
        let body = request.json();
        assert_eq!((body["model"].as_str(), body["stream"].as_bool()), (Some("glm-4"), Some(true)));
        assert_eq!(body["temperature"], 0.2);
    }

    #[tokio::test]
    async fn http_errors_keep_status_body_and_address() {
        let (base, _) = serve(vec![Canned::json(401, r#"{"error":{"message":"Invalid API key"}}"#)]).await;
        let client = HttpLlmClient::new(&compat_conn(&format!("{base}/v1")), Some("bad"), &HashMap::new()).unwrap();
        let out = RecordingOutput::default();
        let failure = client.stream_with(&messages(), "m", &GenerationParams::default(), &out).await.unwrap_err();
        assert_eq!((failure.kind, failure.status), (FailureKind::Auth, Some(401)));
        assert!(failure.message.contains("401"), "{}", failure.message);
        assert!(failure.message.contains("Invalid API key"));
        assert!(failure.message.contains(&format!("{base}/v1/chat/completions")));
        assert_eq!(failure.hint(), Some("auth_failed"));
        assert_eq!(out.errors.lock().unwrap().as_slice(), [failure.message.clone()]);
        assert!(matches!(LLMError::from(failure), LLMError::AuthError(_)));
    }

    #[tokio::test]
    async fn a_404_is_not_silently_sent_to_ollama() {
        let (base, seen) = serve(vec![Canned::json(404, "Not Found")]).await;
        let client = HttpLlmClient::new(&compat_conn(&base), None, &HashMap::new()).unwrap();
        let out = RecordingOutput::default();
        let failure = client.stream_with(&messages(), "m", &GenerationParams::default(), &out).await.unwrap_err();
        assert_eq!(failure.status, Some(404));
        assert_eq!(failure.hint(), Some("check_version_prefix"));
        assert!(failure.message.contains("version prefix"));
        assert_eq!(seen.lock().unwrap().len(), 1, "no fallback request");
    }

    #[tokio::test]
    async fn legacy_custom_falls_back_to_ollama_only_on_404() {
        let ollama = "{\"message\":{\"content\":\"from ollama\"}}\n{\"done\":true,\"prompt_eval_count\":4,\"eval_count\":2}\n";
        let (base, seen) = serve(vec![Canned::json(404, "nope"), Canned::new(200, "application/x-ndjson", vec![ollama.as_bytes().to_vec()])]).await;
        let mut conn = compat_conn(&base);
        conn.compat.ollama_fallback_on_404 = true;
        let client = HttpLlmClient::new(&conn, None, &HashMap::new()).unwrap();
        let out = RecordingOutput::default();
        let result = client.stream_with(&messages(), "llama3", &GenerationParams::default(), &out).await.unwrap();
        assert_eq!(out.text(), "from ollama");
        assert_eq!((result.stats.prompt_tokens, result.stats.completion_tokens), (4, 2));
        let paths: Vec<String> = seen.lock().unwrap().iter().map(|r| r.path.clone()).collect();
        assert_eq!(paths, vec!["/chat/completions", "/api/chat"]);

        // Both failing: both errors are shown.
        let (base, _) = serve(vec![Canned::json(404, "first"), Canned::json(500, "second")]).await;
        let mut conn = compat_conn(&base);
        conn.compat.ollama_fallback_on_404 = true;
        let client = HttpLlmClient::new(&conn, None, &HashMap::new()).unwrap();
        let failure = client.stream_with(&messages(), "m", &GenerationParams::default(), &RecordingOutput::default()).await.unwrap_err();
        assert!(failure.message.contains("first") && failure.message.contains("second"), "{}", failure.message);

        // A 500 is reported as is, no fallback.
        let (base, seen) = serve(vec![Canned::json(500, "boom")]).await;
        let mut conn = compat_conn(&base);
        conn.compat.ollama_fallback_on_404 = true;
        let client = HttpLlmClient::new(&conn, None, &HashMap::new()).unwrap();
        let failure = client.stream_with(&messages(), "m", &GenerationParams::default(), &RecordingOutput::default()).await.unwrap_err();
        assert_eq!(failure.status, Some(500));
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn an_error_inside_a_200_stream_is_reported() {
        let (base, _) = serve(vec![Canned::sse(&[
            "data: {\"choices\":[{\"delta\":{\"content\":\"Par\"}}]}\n\n",
            "data: {\"error\":{\"message\":\"Provider returned error\",\"code\":502}}\n\n",
        ])])
        .await;
        let client = HttpLlmClient::new(&compat_conn(&base), None, &HashMap::new()).unwrap();
        let out = RecordingOutput::default();
        let failure = client.stream_with(&messages(), "m", &GenerationParams::default(), &out).await.unwrap_err();
        assert_eq!(failure.kind, FailureKind::Stream);
        assert!(failure.message.contains("Provider returned error"));
        assert_eq!(out.text(), "Par");
        assert_eq!(out.errors.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_body_without_text_or_completion_fails_the_stream() {
        let (base, _) = serve(vec![Canned::json(200, "{}")]).await;
        let client = HttpLlmClient::new(&compat_conn(&base), None, &HashMap::new()).unwrap();
        let out = RecordingOutput::default();
        let failure = client.stream_with(&messages(), "m", &GenerationParams::default(), &out).await.unwrap_err();
        assert_eq!(failure.kind, FailureKind::Stream);
        assert!(out.text().is_empty());
        assert_eq!(out.errors.lock().unwrap().as_slice(), &[failure.message]);
    }

    #[tokio::test]
    async fn reasoning_signals_thinking_and_stays_out_of_the_answer() {
        let (base, _) = serve(vec![Canned::sse(&[
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"思考\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"<think>x</think>答案\"}}]}\n\n",
            "data: [DONE]\n\n",
        ])])
        .await;
        let client = HttpLlmClient::new(&compat_conn(&base), None, &HashMap::new()).unwrap();
        let out = RecordingOutput::default();
        client.stream_with(&messages(), "m", &GenerationParams::default(), &out).await.unwrap();
        assert_eq!(out.text(), "答案");
        assert_eq!(*out.thinking.lock().unwrap(), 1);
    }

    #[tokio::test]
    async fn a_whole_json_answer_is_read() {
        let (base, _) = serve(vec![Canned::json(200, r#"{"choices":[{"message":{"content":"整段回答"}}],"usage":{"prompt_tokens":7,"completion_tokens":3}}"#)]).await;
        let client = HttpLlmClient::new(&compat_conn(&base), None, &HashMap::new()).unwrap();
        let out = RecordingOutput::default();
        let result = client.stream_with(&messages(), "m", &GenerationParams::default(), &out).await.unwrap();
        assert_eq!(out.text(), "整段回答");
        assert_eq!(result.stats.prompt_tokens, 7);
    }

    #[tokio::test]
    async fn two_streams_on_one_client_run_at_the_same_time() {
        // Each answer takes ~10 chunks × 15 ms; sharing one client, two of
        // them finish in about the time of one (nothing is locked).
        let chunks: Vec<String> = (0..10).map(|i| format!("data: {{\"choices\":[{{\"delta\":{{\"content\":\"{i}\"}}}}]}}\n\n")).collect();
        let refs: Vec<&str> = chunks.iter().map(String::as_str).collect();
        let (base, _) = serve(vec![Canned::sse(&refs)]).await;
        let client = std::sync::Arc::new(HttpLlmClient::new(&compat_conn(&base), None, &HashMap::new()).unwrap());
        let (a, b) = (RecordingOutput::default(), RecordingOutput::default());
        let params = GenerationParams::default();
        let prompt = messages();
        let start = Instant::now();
        let (ra, rb) = tokio::join!(
            client.stream_with(&prompt, "m", &params, &a),
            client.stream_with(&prompt, "m", &params, &b)
        );
        let both = start.elapsed();
        ra.unwrap();
        rb.unwrap();
        assert_eq!((a.text(), b.text()), ("0123456789".to_string(), "0123456789".to_string()));
        let start = Instant::now();
        client.stream_with(&prompt, "m", &params, &RecordingOutput::default()).await.unwrap();
        let one = start.elapsed();
        assert!(both < one * 2, "concurrent: {both:?}, one alone: {one:?}");
    }

    #[tokio::test]
    async fn network_errors_name_the_address() {
        // Nothing listens on port 9 of localhost.
        let client = HttpLlmClient::new(&compat_conn("http://127.0.0.1:9/v1"), None, &HashMap::new()).unwrap();
        let failure = client.stream_with(&messages(), "m", &GenerationParams::default(), &RecordingOutput::default()).await.unwrap_err();
        assert_eq!(failure.kind, FailureKind::Network);
        assert!(failure.message.contains("http://127.0.0.1:9/v1/chat/completions"), "{}", failure.message);
    }

    #[tokio::test]
    async fn models_and_check_requests() {
        let (base, seen) = serve(vec![Canned::json(200, r#"{"data":[{"id":"a"},{"id":"b","context_length":8192}]}"#)]).await;
        let client = HttpLlmClient::new(&compat_conn(&format!("{base}/v1")), Some("k"), &HashMap::new()).unwrap();
        let (url, models) = client.fetch_models().await.unwrap();
        assert_eq!(url, format!("{base}/v1/models"));
        assert_eq!(models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["a", "b"]);
        assert_eq!(models[1].context_window, Some(8192));
        assert_eq!(seen.lock().unwrap()[0].header("authorization"), Some("Bearer k"));

        let mut conn = compat_conn(&base);
        conn.models_endpoint = ModelsEndpoint::Disabled;
        let client = HttpLlmClient::new(&conn, None, &HashMap::new()).unwrap();
        assert!(client.fetch_models().await.unwrap().1.is_empty());
        assert_eq!(client.check().await.unwrap_err().kind, FailureKind::Config);
    }

    #[tokio::test]
    async fn secret_headers_use_their_keychain_values() {
        let (base, seen) = serve(vec![Canned::json(200, r#"{"data":[]}"#)]).await;
        let mut conn = compat_conn(&base);
        conn.auth = AuthConfig::default();
        conn.headers = vec![LlmHeader { name: "X-Api-Token".into(), value: String::new(), secret: true, value_saved: true }];
        let secrets = HashMap::from([("x-api-token".to_string(), "t0p".to_string())]);
        let client = HttpLlmClient::new(&conn, None, &secrets).unwrap();
        client.fetch_models().await.unwrap();
        assert_eq!(seen.lock().unwrap()[0].header("x-api-token"), Some("t0p"));
        // Without the value the header is left out.
        let client = HttpLlmClient::new(&conn, None, &HashMap::new()).unwrap();
        assert!(client.headers().is_empty());
    }

    #[test]
    fn status_failures_mask_secret_query_values() {
        let failure = status_failure(reqwest::StatusCode::BAD_REQUEST, "https://h/x?key=SECRET&alt=sse", "bad", "Chat request");
        assert!(!failure.message.contains("SECRET"));
        assert_eq!(failure.status, Some(400));
        assert!(failure.message.contains("(400 Bad Request)"));
        let long = "x".repeat(3000);
        let failure = status_failure(reqwest::StatusCode::INTERNAL_SERVER_ERROR, "https://h", &long, "Chat request");
        assert_eq!(failure.body.as_ref().unwrap().len(), ERROR_BODY_BYTES);
        assert!(failure.message.len() < 700);
    }
}
