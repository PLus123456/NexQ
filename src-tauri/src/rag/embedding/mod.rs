//! Embedding clients: OpenAI-compatible `/embeddings` and Ollama's
//! `/api/embed`, with the shared request policy (prefixes, input caps,
//! retries, batch splitting) and response checks (order, count, size, NaN,
//! L2 normalization).

pub mod ollama;
pub mod openai_compat;
#[cfg(test)]
pub(crate) mod test_server;

use std::fmt;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tokio::sync::Notify;
use url::Url;

use super::cjk;
use super::config::{EmbeddingProvider, RagConfig};
use super::flat_index::l2_normalize;
use crate::net::endpoint::{self, ResolvedConnection};

/// Cooperative cancellation for indexing jobs and in-flight requests.
#[derive(Debug, Default)]
pub struct CancelSignal {
    flag: AtomicBool,
    notify: Notify,
}

impl CancelSignal {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    /// Resolves once cancelled (immediately if already).
    pub async fn cancelled(&self) {
        let notified = self.notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if self.is_cancelled() {
            return;
        }
        notified.await;
    }
}

/// Whether a text is a search query or a document chunk (prefixes and extra
/// bodies differ).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmbedKind {
    Query,
    Document,
}

/// Why an embedding request failed. `Display` is what the settings page and
/// the progress events show: status, the address (secrets masked) and the
/// start of the service's answer.
#[derive(Debug, Clone, PartialEq)]
pub enum EmbedError {
    /// 401 / 403.
    Auth { status: u16, url: String, body: String },
    /// 404: wrong address or unknown model.
    NotFound { url: String, body: String },
    /// The service says the batch is too large.
    BatchTooLarge(String),
    /// The service says an input is too long.
    InputTooLong(String),
    /// 429 / 503.
    RateLimited { retry_after: Option<Duration>, detail: String },
    /// 5xx, timeouts, connection errors.
    Transient(String),
    /// Another 4xx.
    BadRequest { status: u16, url: String, body: String },
    /// The answer doesn't fit the request (count, size, NaN, not JSON).
    BadResponse(String),
    /// Settings are incomplete or invalid.
    Config(String),
    Cancelled,
}

impl EmbedError {
    /// Short machine-readable kind for the UI.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Auth { .. } => "auth",
            Self::NotFound { .. } => "not_found",
            Self::BatchTooLarge(_) => "batch_too_large",
            Self::InputTooLong(_) => "input_too_long",
            Self::RateLimited { .. } => "rate_limited",
            Self::Transient(_) => "transient",
            Self::BadRequest { .. } => "bad_request",
            Self::BadResponse(_) => "bad_response",
            Self::Config(_) => "config",
            Self::Cancelled => "cancelled",
        }
    }
}

impl fmt::Display for EmbedError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Auth { status, url, body } => {
                write!(f, "HTTP {status} from {url}: the API key was rejected or lacks access")?;
                tail(f, body)
            }
            Self::NotFound { url, body } => {
                write!(f, "HTTP 404 from {url}: check the Base URL (version prefix such as /v1) and the model name")?;
                tail(f, body)
            }
            Self::BatchTooLarge(d) => write!(f, "The service rejected the batch size: {d}"),
            Self::InputTooLong(d) => write!(f, "The service rejected an input as too long: {d}"),
            Self::RateLimited { detail, .. } => write!(f, "Rate limited: {detail}"),
            Self::Transient(d) => write!(f, "{d}"),
            Self::BadRequest { status, url, body } => {
                write!(f, "HTTP {status} from {url}")?;
                tail(f, body)
            }
            Self::BadResponse(d) => write!(f, "Unexpected embedding response: {d}"),
            Self::Config(d) => write!(f, "{d}"),
            Self::Cancelled => write!(f, "Cancelled"),
        }
    }
}

fn tail(f: &mut fmt::Formatter<'_>, body: &str) -> fmt::Result {
    if body.is_empty() {
        Ok(())
    } else {
        write!(f, " — {body}")
    }
}

impl From<EmbedError> for String {
    fn from(e: EmbedError) -> Self {
        e.to_string()
    }
}

/// First 300 characters of a response body, on one line.
pub(crate) fn snippet(body: &str) -> String {
    let flat: String = body.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out: String = flat.chars().take(300).collect();
    if flat.chars().count() > 300 {
        out.push('…');
    }
    out
}

/// Classifies a non-2xx response.
pub(crate) fn classify(status: u16, url: &Url, body: &str, retry_after: Option<Duration>) -> EmbedError {
    let url = endpoint::redact_url(url.as_str());
    let body = snippet(body);
    let lower = body.to_lowercase();
    let too_long = ["context length", "too long", "input length", "maximum context", "token limit", "less than", "exceeds the max"]
        .iter()
        .any(|w| lower.contains(w))
        && !lower.contains("batch");
    let batch = ["batch", "too many input", "max input", "maximum number of", "array size", "array too long", "at most"]
        .iter()
        .any(|w| lower.contains(w));
    match status {
        401 | 403 => EmbedError::Auth { status, url, body },
        404 => EmbedError::NotFound { url, body },
        413 => EmbedError::BatchTooLarge(body),
        400 | 422 if too_long => EmbedError::InputTooLong(body),
        400 | 422 if batch => EmbedError::BatchTooLarge(body),
        429 | 503 => EmbedError::RateLimited {
            retry_after,
            detail: format!("HTTP {status} from {url}{}", if body.is_empty() { String::new() } else { format!(" — {body}") }),
        },
        500..=599 => EmbedError::Transient(format!("HTTP {status} from {url}{}", if body.is_empty() { String::new() } else { format!(" — {body}") })),
        _ => EmbedError::BadRequest { status, url, body },
    }
}

/// `Retry-After` in seconds (HTTP dates are ignored).
pub(crate) fn retry_after(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    let value = headers.get(reqwest::header::RETRY_AFTER)?.to_str().ok()?;
    let secs: f64 = value.trim().parse().ok()?;
    (secs.is_finite() && secs >= 0.0).then(|| Duration::from_secs_f64(secs.min(120.0)))
}

/// A transport error as a retryable failure.
pub(crate) fn transport_error(e: &reqwest::Error, url: &Url) -> EmbedError {
    let url = endpoint::redact_url(url.as_str());
    let what = if e.is_timeout() {
        "timed out".to_string()
    } else if e.is_connect() {
        "could not connect".to_string()
    } else {
        "request failed".to_string()
    };
    EmbedError::Transient(format!("{url}: {what} ({})", endpoint::redact_url(&e.to_string())))
}

/// Everything needed to send embedding requests.
#[derive(Clone)]
pub struct EmbedderSettings {
    pub provider: EmbeddingProvider,
    /// The base URL as configured (for hints).
    pub base_url: String,
    /// The request address.
    pub endpoint: Url,
    /// Auth header and custom headers; the secret is inside: never log.
    pub headers: Vec<(String, String)>,
    pub model: String,
    pub dimensions: Option<u32>,
    pub request_dimensions: bool,
    pub base64: bool,
    pub query_prefix: String,
    pub document_prefix: String,
    pub extra_body_query: Value,
    pub extra_body_document: Value,
    pub max_input_tokens: usize,
    pub request_timeout: Duration,
}

impl fmt::Debug for EmbedderSettings {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EmbedderSettings")
            .field("provider", &self.provider)
            .field("endpoint", &endpoint::redact_url(self.endpoint.as_str()))
            .field("headers", &self.headers.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>())
            .field("model", &self.model)
            .finish_non_exhaustive()
    }
}

impl EmbedderSettings {
    /// From the RAG config and the stored key. `connection` replaces the
    /// address, key and headers when an LLM connection is reused.
    pub fn from_config(
        config: &RagConfig,
        secret: Option<&str>,
        connection: Option<&ResolvedConnection>,
    ) -> Result<Self, EmbedError> {
        let e = &config.embedding;
        if e.model.is_empty() {
            return Err(EmbedError::Config("No embedding model is set".to_string()));
        }
        let (base_url, headers) = match connection {
            Some(conn) => (conn.base_url.clone(), conn.headers.clone()),
            None => {
                let headers = endpoint::request_headers(&e.auth, secret, &e.headers)
                    .map_err(|err| EmbedError::Config(err.to_string()))?;
                (e.base_url.clone(), headers)
            }
        };
        if base_url.is_empty() {
            return Err(EmbedError::Config("No embedding Base URL is set".to_string()));
        }
        let path = match e.provider {
            EmbeddingProvider::OpenaiCompat => endpoint::EMBEDDINGS_PATH,
            EmbeddingProvider::Ollama => ollama::EMBED_PATH,
        };
        let endpoint = endpoint::join_endpoint(&base_url, path).map_err(|err| EmbedError::Config(err.to_string()))?;
        let (query_prefix, document_prefix) = config.effective_prefixes();
        Ok(Self {
            provider: e.provider,
            base_url,
            endpoint,
            headers,
            model: e.model.clone(),
            dimensions: e.dimensions,
            request_dimensions: e.request_dimensions,
            base64: e.encoding_format == "base64",
            query_prefix,
            document_prefix,
            extra_body_query: e.extra_body_query.clone(),
            extra_body_document: e.extra_body_document.clone(),
            max_input_tokens: config.effective_max_input_tokens(),
            request_timeout: Duration::from_secs(e.request_timeout_secs),
        })
    }

    fn prepare(&self, texts: &[String], kind: EmbedKind, max_tokens: usize) -> Vec<String> {
        let prefix = match kind {
            EmbedKind::Query => &self.query_prefix,
            EmbedKind::Document => &self.document_prefix,
        };
        let budget = max_tokens.saturating_sub(cjk::estimate_tokens(prefix)).max(16);
        texts
            .iter()
            .map(|t| {
                let t = t.trim();
                let t = if t.is_empty() { " " } else { cjk::truncate_to_tokens(t, budget) };
                format!("{prefix}{t}")
            })
            .collect()
    }

    fn extra_body(&self, kind: EmbedKind) -> &Value {
        match kind {
            EmbedKind::Query => &self.extra_body_query,
            EmbedKind::Document => &self.extra_body_document,
        }
    }
}

/// Retry timing (shortened in tests).
#[derive(Debug, Clone, Copy)]
pub struct RetryPolicy {
    pub base_delay: Duration,
    pub max_delay: Duration,
    /// Attempts for 5xx / network errors.
    pub transient_attempts: u32,
    /// Attempts for 429 / 503.
    pub rate_limit_attempts: u32,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            base_delay: Duration::from_secs(1),
            max_delay: Duration::from_secs(16),
            transient_attempts: 3,
            rate_limit_attempts: 5,
        }
    }
}

impl RetryPolicy {
    /// No retries (connection tests, live queries).
    pub fn once() -> Self {
        Self { transient_attempts: 1, rate_limit_attempts: 1, ..Self::default() }
    }

    fn delay(&self, attempt: u32, retry_after: Option<Duration>) -> Duration {
        if let Some(d) = retry_after {
            return d.min(Duration::from_secs(120));
        }
        let exp = self.base_delay.saturating_mul(1u32 << attempt.min(10));
        let jitter = 0.8 + 0.4 * jitter_unit();
        exp.min(self.max_delay).mul_f64(jitter)
    }
}

/// A number in [0, 1) without a random crate.
fn jitter_unit() -> f64 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    (nanos % 1000) as f64 / 1000.0
}

/// An embedding client for one configuration.
pub struct Embedder {
    settings: EmbedderSettings,
    client: reqwest::Client,
    retry: RetryPolicy,
    /// Largest batch the service accepted after a "batch too large" answer.
    batch_cap: AtomicUsize,
}

impl Embedder {
    pub fn new(settings: EmbedderSettings, client: reqwest::Client) -> Self {
        Self { settings, client, retry: RetryPolicy::default(), batch_cap: AtomicUsize::new(usize::MAX) }
    }

    pub fn with_retry(mut self, retry: RetryPolicy) -> Self {
        self.retry = retry;
        self
    }

    pub fn settings(&self) -> &EmbedderSettings {
        &self.settings
    }

    /// Learned batch limit (`usize::MAX` until the service complains).
    pub fn batch_cap(&self) -> usize {
        self.batch_cap.load(Ordering::Relaxed)
    }

    /// Embeds `texts` (non-empty), returning unit vectors in input order.
    /// Retries rate limits and transient errors, halves the batch when the
    /// service says it is too large and shortens inputs when they are too long.
    pub async fn embed(
        &self,
        texts: &[String],
        kind: EmbedKind,
        cancel: Option<&CancelSignal>,
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let cap = self.batch_cap().max(1);
        if texts.len() > cap {
            let mut out = Vec::with_capacity(texts.len());
            for part in texts.chunks(cap) {
                out.extend(Box::pin(self.embed(part, kind, cancel)).await?);
            }
            return Ok(out);
        }
        let mut max_tokens = self.settings.max_input_tokens;
        let mut shortened = 0u32;
        loop {
            match self.embed_with_retries(texts, kind, max_tokens, cancel).await {
                Err(EmbedError::BatchTooLarge(detail)) if texts.len() > 1 => {
                    let half = texts.len().div_ceil(2);
                    self.batch_cap.fetch_min(half, Ordering::Relaxed);
                    log::warn!("Embedding batch of {} rejected ({detail}); retrying with {half}", texts.len());
                    let mut out = Vec::with_capacity(texts.len());
                    for part in texts.chunks(half) {
                        out.extend(Box::pin(self.embed(part, kind, cancel)).await?);
                    }
                    return Ok(out);
                }
                Err(EmbedError::InputTooLong(detail)) if shortened < 4 && max_tokens > 64 => {
                    shortened += 1;
                    max_tokens = (max_tokens / 2).max(64);
                    log::warn!("Embedding input too long ({detail}); retrying cut to {max_tokens} tokens");
                }
                other => return other,
            }
        }
    }

    async fn embed_with_retries(
        &self,
        texts: &[String],
        kind: EmbedKind,
        max_tokens: usize,
        cancel: Option<&CancelSignal>,
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        let inputs = self.settings.prepare(texts, kind, max_tokens);
        // Rate limits and transient errors have separate budgets.
        let (mut rate_tries, mut transient_tries) = (0u32, 0u32);
        loop {
            if cancel.is_some_and(CancelSignal::is_cancelled) {
                return Err(EmbedError::Cancelled);
            }
            let result = match cancel {
                Some(c) => tokio::select! {
                    r = self.request(&inputs, kind) => r,
                    _ = c.cancelled() => Err(EmbedError::Cancelled),
                },
                None => self.request(&inputs, kind).await,
            };
            let (tries, limit, after) = match &result {
                Err(EmbedError::RateLimited { retry_after, .. }) => {
                    rate_tries += 1;
                    (rate_tries, self.retry.rate_limit_attempts, *retry_after)
                }
                Err(EmbedError::Transient(_)) => {
                    transient_tries += 1;
                    (transient_tries, self.retry.transient_attempts, None)
                }
                _ => return result,
            };
            if tries >= limit {
                return result;
            }
            let wait = self.retry.delay(tries - 1, after);
            log::warn!(
                "Embedding request failed ({}), retry {tries}/{} in {wait:?}",
                result.as_ref().err().map(|e| e.to_string()).unwrap_or_default(),
                limit - 1
            );
            match cancel {
                Some(c) => tokio::select! {
                    _ = tokio::time::sleep(wait) => {},
                    _ = c.cancelled() => return Err(EmbedError::Cancelled),
                },
                None => tokio::time::sleep(wait).await,
            }
        }
    }

    /// One HTTP round trip.
    async fn request(&self, inputs: &[String], kind: EmbedKind) -> Result<Vec<Vec<f32>>, EmbedError> {
        let s = &self.settings;
        let body = match s.provider {
            EmbeddingProvider::OpenaiCompat => openai_compat::request_body(s, inputs, kind),
            EmbeddingProvider::Ollama => ollama::request_body(s, inputs, kind),
        };
        let req = self.client.post(s.endpoint.clone()).timeout(s.request_timeout).json(&body);
        let req = endpoint::apply_headers(req, &s.headers);
        let response = req.send().await.map_err(|e| transport_error(&e, &s.endpoint))?;
        let status = response.status().as_u16();
        let after = retry_after(response.headers());
        let text = response.text().await.map_err(|e| transport_error(&e, &s.endpoint))?;
        if !(200..300).contains(&status) {
            return Err(classify(status, &s.endpoint, &text, after));
        }
        let vectors = match s.provider {
            EmbeddingProvider::OpenaiCompat => openai_compat::parse_response(&text, inputs.len())?,
            EmbeddingProvider::Ollama => ollama::parse_response(&text, inputs.len())?,
        };
        finish_vectors(vectors, s.dimensions)
    }

    /// Embeds one query within `budget` (no retries: a live search falls
    /// back to keywords instead of waiting).
    pub async fn embed_query(&self, text: &str, budget: Duration) -> Result<Vec<f32>, EmbedError> {
        let texts = [text.to_string()];
        let inputs = self.settings.prepare(&texts, EmbedKind::Query, self.settings.max_input_tokens);
        let vectors = tokio::time::timeout(budget, self.request(&inputs, EmbedKind::Query))
            .await
            .map_err(|_| EmbedError::Transient(format!("query embedding took longer than {} ms", budget.as_millis())))??;
        vectors.into_iter().next().ok_or_else(|| EmbedError::BadResponse("no vector returned".to_string()))
    }
}

/// Checks sizes and values, then L2-normalizes.
pub(crate) fn finish_vectors(mut vectors: Vec<Vec<f32>>, declared: Option<u32>) -> Result<Vec<Vec<f32>>, EmbedError> {
    let Some(first) = vectors.first() else {
        return Ok(vectors);
    };
    let dims = first.len();
    if dims == 0 {
        return Err(EmbedError::BadResponse("empty vector".to_string()));
    }
    if let Some(declared) = declared {
        if dims != declared as usize {
            return Err(EmbedError::BadResponse(format!(
                "the model returned {dims}-dimensional vectors but the settings say {declared}"
            )));
        }
    }
    for (i, v) in vectors.iter_mut().enumerate() {
        if v.len() != dims {
            return Err(EmbedError::BadResponse(format!("vector {i} has {} dimensions, the first has {dims}", v.len())));
        }
        if !l2_normalize(v) {
            return Err(EmbedError::BadResponse(format!("vector {i} is zero or contains NaN/infinity")));
        }
    }
    Ok(vectors)
}

/// Decodes a base64 string of little-endian f32 values.
pub(crate) fn decode_base64_f32(s: &str) -> Result<Vec<f32>, EmbedError> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .map_err(|e| EmbedError::BadResponse(format!("invalid base64 embedding: {e}")))?;
    if bytes.len() % 4 != 0 {
        return Err(EmbedError::BadResponse(format!("base64 embedding of {} bytes is not a list of f32", bytes.len())));
    }
    Ok(bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect())
}

/// Result of the settings page's "Test" button.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct EmbedTestResult {
    pub ok: bool,
    pub url: String,
    pub latency_ms: u64,
    pub dims: Option<usize>,
    /// When `dimensions` is sent: whether the vectors have that size.
    pub dimensions_respected: Option<bool>,
    pub error: Option<String>,
    pub error_kind: Option<String>,
    /// e.g. "add_v1": the same address with `/v1` answered.
    pub hint: Option<String>,
}

/// Sends one small request (no retries) and reports what happened. On a
/// 404 from an OpenAI-compatible base URL without `/v1`, also tries
/// `{base}/v1/embeddings` and reports whether that one answers (the
/// settings are never changed automatically).
pub async fn test_connection(settings: &EmbedderSettings, client: &reqwest::Client) -> EmbedTestResult {
    let mut probe = settings.clone();
    probe.dimensions = None; // report a size mismatch as data, not as an error
    let embedder = Embedder::new(probe, client.clone()).with_retry(RetryPolicy::once());
    let texts = ["NexQ Plus embedding test".to_string(), "向量化连接测试".to_string()];
    let started = Instant::now();
    let result = embedder.embed_with_retries(&texts, EmbedKind::Document, settings.max_input_tokens, None).await;
    let latency_ms = started.elapsed().as_millis() as u64;
    let url = endpoint::redact_url(settings.endpoint.as_str());
    match result {
        Ok(vectors) => {
            let dims = vectors.first().map(Vec::len);
            let respected = match (settings.request_dimensions, settings.dimensions, dims) {
                (true, Some(want), Some(got)) => Some(want as usize == got),
                _ => None,
            };
            let mismatch = match (settings.dimensions, dims) {
                (Some(want), Some(got)) if want as usize != got => Some(format!(
                    "The model returned {got}-dimensional vectors but the settings say {want}"
                )),
                _ => None,
            };
            EmbedTestResult {
                ok: mismatch.is_none(),
                url,
                latency_ms,
                dims,
                dimensions_respected: respected,
                error_kind: mismatch.as_ref().map(|_| "dimension_mismatch".to_string()),
                error: mismatch,
                hint: None,
            }
        }
        Err(e) => {
            let hint = match (&e, settings.provider) {
                (EmbedError::NotFound { .. }, EmbeddingProvider::OpenaiCompat) => v1_hint(settings, client).await,
                _ => None,
            };
            EmbedTestResult {
                ok: false,
                url,
                latency_ms,
                dims: None,
                dimensions_respected: None,
                error_kind: Some(e.kind().to_string()),
                error: Some(e.to_string()),
                hint,
            }
        }
    }
}

async fn v1_hint(settings: &EmbedderSettings, client: &reqwest::Client) -> Option<String> {
    let base = endpoint::normalize_base_url(&settings.base_url).ok()?;
    if base.url.path().trim_end_matches('/').ends_with("/v1") {
        return None;
    }
    let with_v1 = endpoint::add_version_prefix(&settings.base_url, "/v1");
    let mut probe = settings.clone();
    probe.endpoint = endpoint::join_endpoint(&with_v1, endpoint::EMBEDDINGS_PATH).ok()?;
    probe.dimensions = None;
    let embedder = Embedder::new(probe, client.clone()).with_retry(RetryPolicy::once());
    // Any answer other than "not found" or no answer means that address exists.
    match embedder.embed_with_retries(&["test".to_string()], EmbedKind::Document, 64, None).await {
        Err(EmbedError::NotFound { .. } | EmbedError::Transient(_) | EmbedError::Config(_) | EmbedError::Cancelled) => None,
        _ => Some("add_v1".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::test_server::{FakeServer, Reply};
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    fn settings(provider: EmbeddingProvider, base: &str) -> EmbedderSettings {
        let mut config = RagConfig::default();
        config.embedding.provider = provider;
        config.embedding.base_url = base.to_string();
        config.embedding.model = "test-model".into();
        config.normalize();
        EmbedderSettings::from_config(&config, Some("sk-test-1234"), None).unwrap()
    }

    fn fast() -> RetryPolicy {
        RetryPolicy {
            base_delay: Duration::from_millis(1),
            max_delay: Duration::from_millis(4),
            transient_attempts: 3,
            rate_limit_attempts: 5,
        }
    }

    fn openai_reply(vectors: &[Vec<f32>]) -> Reply {
        let data: Vec<Value> = vectors
            .iter()
            .enumerate()
            .map(|(i, v)| json!({"object": "embedding", "index": i, "embedding": v}))
            .collect();
        Reply::json(200, json!({"object": "list", "data": data, "model": "test-model"}))
    }

    #[tokio::test]
    async fn openai_compat_request_and_normalized_response() {
        let server = FakeServer::start(|req| {
            assert_eq!(req.method, "POST");
            assert_eq!(req.path, "/api/paas/v4/embeddings");
            assert_eq!(req.query, None);
            assert_eq!(req.header("authorization").as_deref(), Some("Bearer sk-test-1234"));
            let body = req.json();
            assert_eq!(body["model"], "test-model");
            assert!(body.get("dimensions").is_none(), "dimensions only when asked");
            assert_eq!(body["input"], json!(["passage one", "第二段"]));
            openai_reply(&[vec![3.0, 4.0], vec![0.0, 2.0]])
        })
        .await;
        let s = settings(EmbeddingProvider::OpenaiCompat, &format!("{}/api/paas/v4", server.base()));
        let e = Embedder::new(s, reqwest::Client::new());
        let v = e.embed(&["passage one".into(), "第二段".into()], EmbedKind::Document, None).await.unwrap();
        assert_eq!(v, vec![vec![0.6, 0.8], vec![0.0, 1.0]]);
        assert_eq!(server.hits(), 1);
    }

    #[tokio::test]
    async fn query_strings_are_kept_and_header_auth_is_used() {
        let server = FakeServer::start(|req| {
            assert_eq!(req.path, "/openai/deployments/emb/embeddings");
            assert_eq!(req.query.as_deref(), Some("api-version=2024-10-21"));
            assert_eq!(req.header("api-key").as_deref(), Some("azure-key"));
            assert!(req.header("authorization").is_none());
            assert_eq!(req.header("x-tenant").as_deref(), Some("t1"));
            openai_reply(&[vec![1.0]])
        })
        .await;
        let mut config = RagConfig::default();
        config.embedding.base_url = format!("{}/openai/deployments/emb?api-version=2024-10-21", server.base());
        config.embedding.model = "emb".into();
        config.embedding.auth = crate::net::endpoint::AuthConfig {
            mode: crate::net::endpoint::AuthMode::Header,
            header_name: "api-key".into(),
            prefix: String::new(),
        };
        config.embedding.headers = vec![crate::net::endpoint::CustomHeader { name: "X-Tenant".into(), value: "t1".into() }];
        let s = EmbedderSettings::from_config(&config, Some("azure-key"), None).unwrap();
        Embedder::new(s, reqwest::Client::new()).embed(&["a".into()], EmbedKind::Document, None).await.unwrap();
    }

    #[tokio::test]
    async fn out_of_order_and_base64_responses_are_aligned() {
        use base64::Engine as _;
        let b64 = |v: &[f32]| {
            let bytes: Vec<u8> = v.iter().flat_map(|f| f.to_le_bytes()).collect();
            base64::engine::general_purpose::STANDARD.encode(bytes)
        };
        let server = FakeServer::start(move |req| {
            let body: Value = serde_json::from_slice(&req.body).unwrap();
            assert_eq!(body["encoding_format"], "base64");
            Reply::json(200, json!({"data": [
                {"index": 2, "embedding": b64(&[0.0, 0.0, 5.0])},
                {"index": 0, "embedding": b64(&[2.0, 0.0, 0.0])},
                {"index": 1, "embedding": b64(&[0.0, 7.0, 0.0])},
            ]}))
        })
        .await;
        let mut s = settings(EmbeddingProvider::OpenaiCompat, &server.base());
        s.base64 = true;
        let e = Embedder::new(s, reqwest::Client::new());
        let v = e.embed(&["a".into(), "b".into(), "c".into()], EmbedKind::Document, None).await.unwrap();
        assert_eq!(v, vec![vec![1.0, 0.0, 0.0], vec![0.0, 1.0, 0.0], vec![0.0, 0.0, 1.0]]);
    }

    #[tokio::test]
    async fn bad_responses_are_rejected() {
        for (reply, needle) in [
            (json!({"data": [{"index": 0, "embedding": [1.0, 0.0]}]}), "1 vectors for 2 inputs"),
            (json!({"data": [{"index": 0, "embedding": [1.0, 0.0]}, {"index": 1, "embedding": [1.0]}]}), "dimensions"),
            (json!({"data": [{"index": 0, "embedding": [0.0, 0.0]}, {"index": 1, "embedding": [1.0, 0.0]}]}), "zero"),
            (json!({"data": [{"index": 0, "embedding": [1.0, 0.0]}, {"index": 0, "embedding": [1.0, 0.0]}]}), "index"),
            (json!({"nothing": true}), "data"),
        ] {
            let server = FakeServer::start(move |_| Reply::json(200, reply.clone())).await;
            let e = Embedder::new(settings(EmbeddingProvider::OpenaiCompat, &server.base()), reqwest::Client::new());
            let err = e.embed(&["a".into(), "b".into()], EmbedKind::Document, None).await.unwrap_err();
            assert!(matches!(err, EmbedError::BadResponse(_)), "{err:?}");
            assert!(err.to_string().contains(needle), "{err} should mention {needle}");
        }
        // NaN can't be written as JSON, but a NaN in base64 can be sent.
        use base64::Engine as _;
        let nan: Vec<u8> = [f32::NAN, 1.0].iter().flat_map(|f| f.to_le_bytes()).collect();
        let enc = base64::engine::general_purpose::STANDARD.encode(nan);
        let server = FakeServer::start(move |_| Reply::json(200, json!({"data": [{"index": 0, "embedding": enc}]}))).await;
        let e = Embedder::new(settings(EmbeddingProvider::OpenaiCompat, &server.base()), reqwest::Client::new());
        let err = e.embed(&["a".into()], EmbedKind::Document, None).await.unwrap_err();
        assert!(err.to_string().contains("NaN"), "{err}");
    }

    #[tokio::test]
    async fn declared_dimensions_are_sent_when_asked_and_checked() {
        let server = FakeServer::start(|req| {
            let body: Value = serde_json::from_slice(&req.body).unwrap();
            assert_eq!(body["dimensions"], 3);
            openai_reply(&[vec![1.0, 0.0]])
        })
        .await;
        let mut s = settings(EmbeddingProvider::OpenaiCompat, &server.base());
        s.dimensions = Some(3);
        s.request_dimensions = true;
        let err = Embedder::new(s, reqwest::Client::new()).embed(&["a".into()], EmbedKind::Document, None).await.unwrap_err();
        assert!(err.to_string().contains("say 3"), "{err}");
    }

    #[tokio::test]
    async fn errors_are_classified_and_fatal_ones_not_retried() {
        let cases: Vec<(u16, &str, &str)> = vec![
            (401, r#"{"error":{"message":"Incorrect API key"}}"#, "auth"),
            (403, "forbidden", "auth"),
            (404, "no route", "not_found"),
            (400, r#"{"error":"This model's maximum context length is 512 tokens"}"#, "input_too_long"),
            (422, "Input validation error: `inputs` must have less than 512 tokens", "input_too_long"),
            (400, "batch size is invalid, it should not be larger than 10", "batch_too_large"),
            (413, "payload too large", "batch_too_large"),
            (400, r#"{"error":"unknown field: dimensions"}"#, "bad_request"),
        ];
        for (status, body, kind) in cases {
            let err = classify(status, &Url::parse("https://x.example/v1/embeddings?key=abc").unwrap(), body, None);
            assert_eq!(err.kind(), kind, "{status} {body}");
            assert!(!err.to_string().contains("abc"), "secret query value masked: {err}");
        }
        let server = FakeServer::start(|_| Reply::text(401, "bad key")).await;
        let e = Embedder::new(settings(EmbeddingProvider::OpenaiCompat, &server.base()), reqwest::Client::new()).with_retry(fast());
        let err = e.embed(&["a".into()], EmbedKind::Document, None).await.unwrap_err();
        assert_eq!(err.kind(), "auth");
        assert!(err.to_string().contains("bad key") && err.to_string().contains("401"), "{err}");
        assert_eq!(server.hits(), 1, "auth errors are not retried");
    }

    #[tokio::test]
    async fn rate_limits_and_server_errors_are_retried_then_succeed() {
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        let server = FakeServer::start(move |_| match c.fetch_add(1, Ordering::SeqCst) {
            0 => Reply::text(429, "slow down").with_header("Retry-After", "0"),
            1 => Reply::text(503, "busy"),
            2 => Reply::text(502, "bad gateway"),
            _ => openai_reply(&[vec![1.0, 1.0]]),
        })
        .await;
        let e = Embedder::new(settings(EmbeddingProvider::OpenaiCompat, &server.base()), reqwest::Client::new()).with_retry(fast());
        let v = e.embed(&["a".into()], EmbedKind::Document, None).await.unwrap();
        assert_eq!(v.len(), 1);
        assert_eq!(server.hits(), 4);
    }

    #[tokio::test]
    async fn transient_errors_give_up_after_the_limit() {
        let server = FakeServer::start(|_| Reply::text(500, "boom")).await;
        let e = Embedder::new(settings(EmbeddingProvider::OpenaiCompat, &server.base()), reqwest::Client::new()).with_retry(fast());
        let err = e.embed(&["a".into()], EmbedKind::Document, None).await.unwrap_err();
        assert_eq!(err.kind(), "transient");
        assert_eq!(server.hits(), 3);
    }

    #[tokio::test]
    async fn batches_are_halved_and_the_limit_remembered() {
        let server = FakeServer::start(|req| {
            let body: Value = serde_json::from_slice(&req.body).unwrap();
            let n = body["input"].as_array().unwrap().len();
            if n > 3 {
                Reply::text(400, "batch size is invalid, it should not be larger than 3")
            } else {
                openai_reply(&vec![vec![1.0, 0.0]; n])
            }
        })
        .await;
        let e = Embedder::new(settings(EmbeddingProvider::OpenaiCompat, &server.base()), reqwest::Client::new()).with_retry(fast());
        let texts: Vec<String> = (0..10).map(|i| format!("t{i}")).collect();
        let v = e.embed(&texts, EmbedKind::Document, None).await.unwrap();
        assert_eq!(v.len(), 10);
        assert!(e.batch_cap() <= 3, "learned cap {}", e.batch_cap());
        let before = server.hits();
        e.embed(&texts, EmbedKind::Document, None).await.unwrap();
        assert_eq!(server.hits() - before, 4, "10 inputs in batches of ≤3 without new rejections");
    }

    #[tokio::test]
    async fn long_inputs_are_cut_after_a_too_long_answer() {
        let server = FakeServer::start(|req| {
            let body: Value = serde_json::from_slice(&req.body).unwrap();
            let text = body["input"][0].as_str().unwrap().to_string();
            if cjk::estimate_tokens(&text) > 100 {
                Reply::text(400, "input length exceeds the context length")
            } else {
                openai_reply(&[vec![1.0, 0.0]])
            }
        })
        .await;
        let mut s = settings(EmbeddingProvider::OpenaiCompat, &server.base());
        s.max_input_tokens = 400;
        let e = Embedder::new(s, reqwest::Client::new()).with_retry(fast());
        let v = e.embed(&["字".repeat(1000)], EmbedKind::Document, None).await.unwrap();
        assert_eq!(v.len(), 1);
        assert_eq!(server.hits(), 3, "400 → 200 → 100 tokens");
    }

    #[tokio::test]
    async fn prefixes_extra_bodies_and_caps_are_applied() {
        let server = FakeServer::start(|req| {
            let body: Value = serde_json::from_slice(&req.body).unwrap();
            let input = body["input"][0].as_str().unwrap();
            if body["task"] == "retrieval.query" {
                assert_eq!(input, "Q: 问题");
                assert_eq!(body["model"], "test-model", "extra body can't override the model");
            } else {
                assert_eq!(body["task"], "retrieval.passage");
                assert!(input.starts_with("D: "));
                assert_eq!(cjk::estimate_tokens(&input[3..]), 20);
            }
            openai_reply(&[vec![1.0]])
        })
        .await;
        let mut s = settings(EmbeddingProvider::OpenaiCompat, &server.base());
        s.query_prefix = "Q: ".into();
        s.document_prefix = "D: ".into();
        s.extra_body_query = json!({"task": "retrieval.query", "model": "evil"});
        s.extra_body_document = json!({"task": "retrieval.passage"});
        s.max_input_tokens = 21; // the prefix costs 1
        let e = Embedder::new(s, reqwest::Client::new());
        e.embed(&["字".repeat(50)], EmbedKind::Document, None).await.unwrap();
        e.embed_query("问题", Duration::from_secs(5)).await.unwrap();
    }

    #[tokio::test]
    async fn ollama_native_api() {
        let server = FakeServer::start(|req| {
            assert_eq!(req.path, "/api/embed");
            assert!(req.header("authorization").is_none(), "no key for a local Ollama");
            let body: Value = serde_json::from_slice(&req.body).unwrap();
            assert_eq!(body["model"], "test-model");
            assert_eq!(body["truncate"], true);
            assert_eq!(body["input"], json!(["a", "b"]));
            Reply::json(200, json!({"model": "test-model", "embeddings": [[1.0, 0.0], [0.0, 3.0]]}))
        })
        .await;
        let mut config = RagConfig::default();
        config.embedding.provider = EmbeddingProvider::Ollama;
        config.embedding.base_url = server.base();
        config.embedding.model = "test-model".into();
        config.embedding.auth = Default::default();
        let s = EmbedderSettings::from_config(&config, None, None).unwrap();
        let v = Embedder::new(s, reqwest::Client::new()).embed(&["a".into(), "b".into()], EmbedKind::Document, None).await.unwrap();
        assert_eq!(v, vec![vec![1.0, 0.0], vec![0.0, 1.0]]);

        let server = FakeServer::start(|_| Reply::text(404, r#"{"error":"model \"test-model\" not found, try pulling it first"}"#)).await;
        config.embedding.base_url = server.base();
        let s = EmbedderSettings::from_config(&config, None, None).unwrap();
        let err = Embedder::new(s, reqwest::Client::new()).embed(&["a".into()], EmbedKind::Document, None).await.unwrap_err();
        assert_eq!(err.kind(), "not_found");
        assert!(err.to_string().contains("try pulling"), "{err}");
    }

    #[tokio::test]
    async fn query_budget_and_cancellation() {
        let server = FakeServer::start(|_| Reply::json(200, json!({"data": []})).delayed(Duration::from_millis(400))).await;
        let e = Embedder::new(settings(EmbeddingProvider::OpenaiCompat, &server.base()), reqwest::Client::new()).with_retry(fast());
        let err = e.embed_query("q", Duration::from_millis(50)).await.unwrap_err();
        assert_eq!(err.kind(), "transient");

        let cancel = Arc::new(CancelSignal::new());
        let c = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            c.cancel();
        });
        let started = Instant::now();
        let err = e.embed(&["a".into()], EmbedKind::Document, Some(&cancel)).await.unwrap_err();
        assert_eq!(err, EmbedError::Cancelled);
        assert!(started.elapsed() < Duration::from_millis(350));
    }

    #[tokio::test]
    async fn connection_errors_are_transient_with_the_address() {
        // Nothing listens on a port that was just freed.
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let s = settings(EmbeddingProvider::OpenaiCompat, &format!("http://127.0.0.1:{port}/v1"));
        let err = Embedder::new(s, reqwest::Client::new()).with_retry(fast()).embed(&["a".into()], EmbedKind::Document, None).await.unwrap_err();
        assert_eq!(err.kind(), "transient");
        assert!(err.to_string().contains(&format!("127.0.0.1:{port}/v1/embeddings")), "{err}");
    }

    #[tokio::test]
    async fn test_connection_reports_dims_and_suggests_v1() {
        let server = FakeServer::start(|req| {
            if req.path == "/v1/embeddings" {
                openai_reply(&[vec![1.0, 0.0, 0.0], vec![0.0, 1.0, 0.0]])
            } else {
                Reply::text(404, "not found")
            }
        })
        .await;
        let s = settings(EmbeddingProvider::OpenaiCompat, &server.base());
        let r = test_connection(&s, &reqwest::Client::new()).await;
        assert!(!r.ok);
        assert_eq!(r.error_kind.as_deref(), Some("not_found"));
        assert_eq!(r.hint.as_deref(), Some("add_v1"));
        assert!(r.url.ends_with("/embeddings"));

        let mut s = settings(EmbeddingProvider::OpenaiCompat, &format!("{}/v1", server.base()));
        s.dimensions = Some(1024);
        let r = test_connection(&s, &reqwest::Client::new()).await;
        assert_eq!(r.dims, Some(3));
        assert!(!r.ok, "declared 1024 but got 3");
        assert_eq!(r.error_kind.as_deref(), Some("dimension_mismatch"));
        s.dimensions = None;
        let r = test_connection(&s, &reqwest::Client::new()).await;
        assert!(r.ok && r.error.is_none());
    }

    #[test]
    fn settings_need_a_model_and_a_valid_address() {
        let mut config = RagConfig::default();
        assert_eq!(EmbedderSettings::from_config(&config, None, None).unwrap_err().kind(), "config");
        config.embedding.model = "m".into();
        assert_eq!(EmbedderSettings::from_config(&config, None, None).unwrap_err().kind(), "config");
        config.embedding.base_url = "localhost:8000/v1".into();
        let err = EmbedderSettings::from_config(&config, None, None).unwrap_err();
        assert!(err.to_string().contains("http://"), "{err}");
        config.embedding.base_url = "https://dashscope.aliyuncs.com/compatible-mode/v1".into();
        let s = EmbedderSettings::from_config(&config, Some("k"), None).unwrap();
        assert_eq!(s.endpoint.as_str(), "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings");
        assert!(!format!("{s:?}").contains(" k"), "Debug hides the key");
        // A reused LLM connection supplies the address and headers.
        let conn = ResolvedConnection {
            id: "c_1".into(),
            kind: crate::llm::api::LlmKind::OpenAiCompat,
            base_url: "http://10.0.0.5:8000/v1".into(),
            headers: vec![("Authorization".into(), "Bearer conn".into())],
            timeout: None,
        };
        let s = EmbedderSettings::from_config(&config, Some("ignored"), Some(&conn)).unwrap();
        assert_eq!(s.endpoint.as_str(), "http://10.0.0.5:8000/v1/embeddings");
        assert_eq!(s.headers, vec![("Authorization".to_string(), "Bearer conn".to_string())]);
    }
}
