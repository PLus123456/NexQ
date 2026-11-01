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
        };
        merge_params([&self.conn.params, &caller])
    }

    /// Chat address and body for one request.
    fn chat_request(&self, messages: &[LLMMessage], model: &str, params: &GenerationParams) -> Result<(String, Value), Failure> {
        let chat_url = self.chat_url.as_ref().map_err(|e| Failure::config(e.clone()))?;
        let url = connections::chat_url_for(chat_url, model);
        let eff = self.effective_params(params);
        let compat = &self.conn.compat;
        let web_search = params.enable_web_search.then(|| self.conn.web_search()).unwrap_or(WebSearch::None);
        let body = match self.protocol {
            Protocol::OpenAi => {
                // OpenRouter: ":online" enables web search grounding for any model.
                let model_id = if web_search == WebSearch::OpenrouterOnline && !model.ends_with(":online") {
                    format!("{model}:online")
                } else {
                    model.to_string()
                };
                compat::openai_chat_body(&model_id, messages, &eff, compat)
            }
            Protocol::Anthropic => anthropic::chat_body(model, messages, &eff, compat),
            Protocol::Gemini => gemini::chat_body(
                messages,
                &eff,
                compat,
                params.cache_name.as_deref(),
                web_search == WebSearch::GeminiGoogleSearch,
            ),
            Protocol::Ollama => compat::ollama_chat_body(model, messages, &eff, compat),
        };
        Ok((url, body))
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
        let (url, body) = self.chat_request(messages, model, params)?;
        let request = self.with_headers(self.client.post(&url)).json(&body);
        let response = send(request, params, &url, "Chat request").await?;
        let mut protocol = self.protocol;
        let mut used_url = url.clone();
        let response = if response.status().is_success() {
            response
        } else {
            let failure = response_failure(response, &url, "Chat request").await;
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
            let eff = self.effective_params(params);
            let body = compat::ollama_chat_body(model, messages, &eff, &self.conn.compat);
            let request = self.with_headers(self.client.post(&fallback_url)).json(&body);
            let second = match send(request, params, &fallback_url, "Ollama chat request").await {
                Ok(response) if response.status().is_success() => Ok(response),
                Ok(response) => Err(response_failure(response, &fallback_url, "Ollama chat request").await),
                Err(e) => Err(e),
            };
            match second {
                Ok(response) => {
                    protocol = Protocol::Ollama;
                    used_url = fallback_url;
                    response
                }
                Err(second) if second.kind == FailureKind::Cancelled => return Err(second),
                Err(second) => {
                    return Err(Failure {
                        message: format!("{}; the Ollama fallback failed too: {}", failure.message, second.message),
                        ..failure
                    })
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
