//! Optional reranking of the fused search candidates through a generic
//! `POST {base}/rerank` API: Jina, Cohere v2, SiliconFlow, Xinference and
//! vLLM take `{model, query, documents, top_n}`; Hugging Face TEI takes
//! `{query, texts}` (format "tei"). Answers are accepted as `results` /
//! `data` lists or a top-level list, scores as `relevance_score` or `score`.
//! Any failure keeps the fusion order (the caller decides), and three
//! failures in a row pause reranking for a minute.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use url::Url;

use super::config::RagConfig;
use super::embedding::{classify, retry_after, snippet, transport_error, EmbedError};
use crate::net::endpoint::{self, ResolvedConnection};

/// Documents longer than this many characters are cut before sending.
const MAX_DOC_CHARS: usize = 1500;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RerankFormat {
    Generic,
    Tei,
}

/// Everything needed to send rerank requests.
#[derive(Clone)]
pub struct RerankSettings {
    pub endpoint: Url,
    /// Auth header and custom headers; the secret is inside: never log.
    pub headers: Vec<(String, String)>,
    pub model: String,
    pub format: RerankFormat,
}

impl std::fmt::Debug for RerankSettings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RerankSettings")
            .field("endpoint", &endpoint::redact_url(self.endpoint.as_str()))
            .field("model", &self.model)
            .field("format", &self.format)
            .finish_non_exhaustive()
    }
}

impl RerankSettings {
    pub fn from_config(
        config: &RagConfig,
        secret: Option<&str>,
        connection: Option<&ResolvedConnection>,
    ) -> Result<Self, EmbedError> {
        let r = &config.rerank;
        let format = if r.format == "tei" { RerankFormat::Tei } else { RerankFormat::Generic };
        if r.model.is_empty() && format == RerankFormat::Generic {
            return Err(EmbedError::Config("No rerank model is set".to_string()));
        }
        let (base_url, headers) = match connection {
            Some(conn) => (conn.base_url.clone(), conn.headers.clone()),
            None => {
                let headers = endpoint::request_headers(&r.auth, secret, &r.headers)
                    .map_err(|e| EmbedError::Config(e.to_string()))?;
                (r.base_url.clone(), headers)
            }
        };
        if base_url.is_empty() {
            return Err(EmbedError::Config("No rerank Base URL is set".to_string()));
        }
        let endpoint = endpoint::join_endpoint(&base_url, endpoint::RERANK_PATH)
            .map_err(|e| EmbedError::Config(e.to_string()))?;
        Ok(Self { endpoint, headers, model: r.model.clone(), format })
    }
}

pub fn request_body(s: &RerankSettings, query: &str, documents: &[String], top_n: usize) -> Value {
    let docs: Vec<String> = documents.iter().map(|d| d.chars().take(MAX_DOC_CHARS).collect()).collect();
    match s.format {
        RerankFormat::Generic => json!({ "model": s.model, "query": query, "documents": docs, "top_n": top_n }),
        RerankFormat::Tei => json!({ "query": query, "texts": docs, "truncate": true }),
    }
}

/// (document index, score), best first. Indices must be in range and unique.
pub fn parse_response(text: &str, count: usize) -> Result<Vec<(usize, f64)>, EmbedError> {
    let value: Value = serde_json::from_str(text)
        .map_err(|_| EmbedError::BadResponse(format!("not JSON: {}", snippet(text))))?;
    let items = match &value {
        Value::Array(items) => items,
        Value::Object(map) => match map.get("results").or_else(|| map.get("data")) {
            Some(Value::Array(items)) => items,
            _ => return Err(EmbedError::BadResponse(format!("no \"results\" list in {}", snippet(text)))),
        },
        _ => return Err(EmbedError::BadResponse(format!("no \"results\" list in {}", snippet(text)))),
    };
    let mut seen = vec![false; count];
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let index = item.get("index").and_then(Value::as_u64).map(|i| i as usize);
        let score = item
            .get("relevance_score")
            .or_else(|| item.get("score"))
            .and_then(Value::as_f64);
        match (index, score) {
            (Some(i), Some(s)) if i < count && !seen[i] && s.is_finite() => {
                seen[i] = true;
                out.push((i, s));
            }
            _ => return Err(EmbedError::BadResponse(format!("bad result entry {}", snippet(&item.to_string())))),
        }
    }
    out.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));
    Ok(out)
}

/// One rerank request within `timeout` (no retries: search is waiting).
pub async fn rerank(
    client: &reqwest::Client,
    s: &RerankSettings,
    query: &str,
    documents: &[String],
    top_n: usize,
    timeout: Duration,
) -> Result<Vec<(usize, f64)>, EmbedError> {
    if documents.is_empty() {
        return Ok(Vec::new());
    }
    let req = client.post(s.endpoint.clone()).timeout(timeout).json(&request_body(s, query, documents, top_n));
    let req = endpoint::apply_headers(req, &s.headers);
    let response = req.send().await.map_err(|e| transport_error(e, &s.endpoint))?;
    let status = response.status().as_u16();
    let after = retry_after(response.headers());
    let text = response.text().await.map_err(|e| transport_error(e, &s.endpoint))?;
    if !(200..300).contains(&status) {
        return Err(classify(status, &s.endpoint, &text, after));
    }
    parse_response(&text, documents.len())
}

/// Pauses reranking after repeated failures (3 in a row → 60 s).
#[derive(Debug, Default)]
pub struct Breaker {
    failures: AtomicU32,
    open_until: Mutex<Option<Instant>>,
}

impl Breaker {
    const THRESHOLD: u32 = 3;
    const PAUSE: Duration = Duration::from_secs(60);

    pub fn is_open(&self) -> bool {
        let mut until = self.open_until.lock().unwrap_or_else(|p| p.into_inner());
        match *until {
            Some(t) if Instant::now() < t => true,
            Some(_) => {
                *until = None;
                self.failures.store(0, Ordering::SeqCst);
                false
            }
            None => false,
        }
    }

    pub fn success(&self) {
        self.failures.store(0, Ordering::SeqCst);
    }

    pub fn failure(&self) {
        if self.failures.fetch_add(1, Ordering::SeqCst) + 1 >= Self::THRESHOLD {
            *self.open_until.lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now() + Self::PAUSE);
        }
    }

    pub fn reset(&self) {
        self.failures.store(0, Ordering::SeqCst);
        *self.open_until.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }
}

/// What reranking did in one search.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RerankStatus {
    /// The results are in the reranker's order.
    Applied,
    /// The request failed or timed out: the fusion order was kept.
    Failed,
    /// Skipped after repeated failures: the fusion order was kept.
    Paused,
    /// Turned on without a usable address or model: the fusion order was kept.
    Unconfigured,
}

/// Reranking in one search, for the test dialog.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RerankReport {
    pub status: RerankStatus,
    /// Candidates sent (0 when nothing was sent).
    pub candidates: usize,
    pub latency_ms: u64,
    pub error: Option<String>,
    pub error_kind: Option<String>,
}

/// Result of the settings page's rerank "Test" button.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RerankTestResult {
    pub ok: bool,
    pub url: String,
    pub latency_ms: u64,
    /// Whether the relevant test document came out on top.
    pub ranked_correctly: Option<bool>,
    pub error: Option<String>,
    pub error_kind: Option<String>,
}

pub async fn test_connection(client: &reqwest::Client, s: &RerankSettings) -> RerankTestResult {
    let docs = [
        "今天的天气很好，适合出去散步。".to_string(),
        "向量检索把文本转换成向量，再按相似度查找相关内容。".to_string(),
        "The cafeteria opens at eight.".to_string(),
    ];
    let started = Instant::now();
    let result = rerank(client, s, "什么是向量检索？", &docs, docs.len(), Duration::from_secs(15)).await;
    let latency_ms = started.elapsed().as_millis() as u64;
    let url = endpoint::redact_url(s.endpoint.as_str());
    match result {
        Ok(ranked) => RerankTestResult {
            ok: true,
            url,
            latency_ms,
            ranked_correctly: ranked.first().map(|(i, _)| *i == 1),
            error: None,
            error_kind: None,
        },
        Err(e) => RerankTestResult {
            ok: false,
            url,
            latency_ms,
            ranked_correctly: None,
            error_kind: Some(e.kind().to_string()),
            error: Some(e.to_string()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::super::embedding::test_server::{FakeServer, Reply};
    use super::*;

    fn settings(base: &str, format: &str) -> RerankSettings {
        let mut config = RagConfig::default();
        config.rerank.base_url = base.to_string();
        config.rerank.model = "rr".into();
        config.rerank.format = format.into();
        RerankSettings::from_config(&config, Some("rk-1"), None).unwrap()
    }

    #[test]
    fn parses_every_answer_shape() {
        let jina = r#"{"results":[{"index":1,"relevance_score":0.9},{"index":0,"relevance_score":0.2}]}"#;
        assert_eq!(parse_response(jina, 2).unwrap(), vec![(1, 0.9), (0, 0.2)]);
        let data = r#"{"data":[{"index":0,"score":0.1},{"index":1,"score":0.7}]}"#;
        assert_eq!(parse_response(data, 2).unwrap(), vec![(1, 0.7), (0, 0.1)]);
        let tei = r#"[{"index":2,"score":3.5},{"index":0,"score":-1.0},{"index":1,"score":0.0}]"#;
        assert_eq!(parse_response(tei, 3).unwrap(), vec![(2, 3.5), (1, 0.0), (0, -1.0)]);
        // A partial list (top_n) is fine.
        assert_eq!(parse_response(r#"{"results":[{"index":4,"relevance_score":1}]}"#, 5).unwrap(), vec![(4, 1.0)]);
        for bad in [r#"{"results":[{"index":9,"relevance_score":1}]}"#, r#"{"results":[{"index":0}]}"#, r#"{"x":1}"#, "oops", r#"[{"index":0,"score":1},{"index":0,"score":2}]"#] {
            assert_eq!(parse_response(bad, 3).unwrap_err().kind(), "bad_response", "{bad}");
        }
    }

    #[test]
    fn request_bodies_follow_the_format_and_cut_long_documents() {
        let long = "字".repeat(MAX_DOC_CHARS + 50);
        let generic = request_body(&settings("http://h/v1", "generic"), "q", &[long.clone()], 1);
        assert_eq!(generic["model"], "rr");
        assert_eq!(generic["top_n"], 1);
        assert_eq!(generic["documents"][0].as_str().unwrap().chars().count(), MAX_DOC_CHARS);
        let tei = request_body(&settings("http://h", "tei"), "q", &["a".into()], 1);
        assert!(tei.get("documents").is_none() && tei.get("model").is_none());
        assert_eq!(tei["texts"][0], "a");
    }

    #[tokio::test]
    async fn sends_to_rerank_with_the_key_and_reports_the_order() {
        let server = FakeServer::start(|req| {
            assert_eq!(req.path, "/v1/rerank");
            assert_eq!(req.header("authorization").as_deref(), Some("Bearer rk-1"));
            let body = req.json();
            assert_eq!(body["query"], "什么是向量检索？");
            Reply::json(200, json!({"results": [{"index": 1, "relevance_score": 0.95}, {"index": 0, "relevance_score": 0.1}, {"index": 2, "relevance_score": 0.05}]}))
        })
        .await;
        let s = settings(&format!("{}/v1", server.base()), "generic");
        let r = test_connection(&reqwest::Client::new(), &s).await;
        assert!(r.ok, "{r:?}");
        assert_eq!(r.ranked_correctly, Some(true));
        assert!(r.url.ends_with("/v1/rerank"));
    }

    #[tokio::test]
    async fn errors_and_timeouts_are_reported() {
        let server = FakeServer::start(|_| Reply::text(401, "no").delayed(Duration::from_millis(0))).await;
        let s = settings(&server.base(), "generic");
        let err = rerank(&reqwest::Client::new(), &s, "q", &["a".into()], 1, Duration::from_secs(5)).await.unwrap_err();
        assert_eq!(err.kind(), "auth");
        let slow = FakeServer::start(|_| Reply::json(200, json!([])).delayed(Duration::from_millis(300))).await;
        let s = settings(&slow.base(), "generic");
        let err = rerank(&reqwest::Client::new(), &s, "q", &["a".into()], 1, Duration::from_millis(50)).await.unwrap_err();
        assert_eq!(err.kind(), "transient");
    }

    #[test]
    fn the_breaker_opens_after_three_failures_in_a_row() {
        let b = Breaker::default();
        b.failure();
        b.failure();
        b.success();
        b.failure();
        b.failure();
        assert!(!b.is_open());
        b.failure();
        assert!(b.is_open());
        b.reset();
        assert!(!b.is_open());
    }

    #[test]
    fn settings_need_an_address_and_a_model() {
        let mut config = RagConfig::default();
        assert_eq!(RerankSettings::from_config(&config, None, None).unwrap_err().kind(), "config");
        config.rerank.model = "m".into();
        assert_eq!(RerankSettings::from_config(&config, None, None).unwrap_err().kind(), "config");
        config.rerank.base_url = "https://api.siliconflow.cn/v1".into();
        let s = RerankSettings::from_config(&config, Some("k"), None).unwrap();
        assert_eq!(s.endpoint.as_str(), "https://api.siliconflow.cn/v1/rerank");
        // TEI needs no model.
        config.rerank.model = String::new();
        config.rerank.format = "tei".into();
        assert!(RerankSettings::from_config(&config, None, None).is_ok());
    }
}
