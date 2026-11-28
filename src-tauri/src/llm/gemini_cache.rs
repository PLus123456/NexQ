use std::sync::Mutex;
use std::time::Duration;

use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::net::endpoint;

#[derive(Clone)]
pub struct GeminiCacheClient {
    client: Client,
    /// Auth (the API key as `x-goog-api-key`) and custom headers.
    headers: Vec<(String, String)>,
    /// `{base}/v1beta`.
    api_root: Url,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedContent {
    /// Full resource name, e.g. "cachedContents/abc123xyz"
    pub name: String,
    pub model: String,
    pub expire_time: String,
    pub total_token_count: u64,
    /// The LLM connection the cache was made on (NexQ Plus); `None` for one
    /// made with the old Gemini key on Google's API.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
}

impl CachedContent {
    fn is_expired(&self) -> bool {
        chrono::DateTime::parse_from_rfc3339(&self.expire_time)
            .is_ok_and(|time| time <= chrono::Utc::now())
    }
}

#[derive(Clone)]
struct ActiveCache {
    info: CachedContent,
    client: GeminiCacheClient,
}

/// Serializes remote mutations across windows. Readers can still use the
/// last committed cache while a request is in flight.
#[derive(Default)]
pub struct GeminiCache {
    updates: tokio::sync::Mutex<()>,
    active: Mutex<Option<ActiveCache>>,
}

impl GeminiCache {
    pub fn status(&self) -> Result<Option<CachedContent>, String> {
        let slot = self.active.lock().map_err(|_| "Gemini cache state lock poisoned")?;
        Ok(slot.as_ref().filter(|cache| !cache.info.is_expired()).map(|cache| cache.info.clone()))
    }

    pub async fn create(
        &self,
        client: GeminiCacheClient,
        connection_id: Option<String>,
        model: &str,
        system_prompt: Option<&str>,
        context: &str,
        ttl_secs: u64,
    ) -> Result<CachedContent, String> {
        let _update = self.updates.lock().await;
        if self.status()?.is_some() {
            return Err("Clear the active Gemini context cache before creating another.".to_string());
        }
        let mut info = client.create(model, system_prompt, context, ttl_secs).await?;
        info.connection_id = connection_id;
        let mut slot = self.active.lock().map_err(|_| "Gemini cache state lock poisoned")?;
        *slot = Some(ActiveCache { info: info.clone(), client });
        Ok(info)
    }

    pub async fn delete(&self, expected: Option<(&str, Option<&str>)>) -> Result<(), String> {
        let _update = self.updates.lock().await;
        let active = self.active.lock().map_err(|_| "Gemini cache state lock poisoned")?.clone();
        let Some(active) = active else {
            return Ok(());
        };
        if expected.is_some_and(|(name, connection)| {
            active.info.name != name || active.info.connection_id.as_deref() != connection
        }) {
            return Err("The active Gemini cache changed. Try again with the current cache.".to_string());
        }
        // Use the endpoint and credentials that created this resource.
        if !active.info.is_expired() {
            active.client.delete(&active.info.name).await?;
        }
        *self.active.lock().map_err(|_| "Gemini cache state lock poisoned")? = None;
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
struct CreateResponse {
    name: String,
    model: String,
    #[serde(rename = "expireTime", default)]
    expire_time: String,
    #[serde(rename = "usageMetadata", default)]
    usage_metadata: UsageMetadata,
}

#[derive(Debug, Default, Deserialize)]
struct UsageMetadata {
    #[serde(rename = "totalTokenCount", default)]
    total_token_count: u64,
}

impl GeminiCacheClient {
    pub fn new(api_key: &str, base_url: Option<&str>) -> Result<Self, String> {
        // The key goes in a header: a URL (and so any error naming it) never carries it.
        Self::for_connection(
            base_url.unwrap_or("https://generativelanguage.googleapis.com"),
            vec![("x-goog-api-key".to_string(), api_key.to_string())],
        )
    }

    /// A client on a Gemini connection: its base URL (the host, or a base
    /// already ending in `/v1beta`) and its request headers.
    pub fn for_connection(base_url: &str, headers: Vec<(String, String)>) -> Result<Self, String> {
        Ok(Self { client: Client::new(), headers, api_root: api_root(base_url)? })
    }

    fn resource_url(&self, id: Option<&str>) -> Url {
        let mut url = self.api_root.clone();
        {
            let mut path = url.path_segments_mut().expect("validated HTTP URL");
            path.push("cachedContents");
            if let Some(id) = id {
                path.push(id);
            }
        }
        url
    }

    /// Create a cached content entry on Gemini servers.
    ///
    /// `model` — full model ID with "models/" prefix (e.g. "models/gemini-2.0-flash-001").
    /// `system_instruction` — optional system prompt to bake into the cache.
    /// `context_text` — the large document/reference text to cache.
    /// `ttl_secs` — cache lifetime in seconds (min 60, max 172800).
    pub async fn create(
        &self,
        model: &str,
        system_instruction: Option<&str>,
        context_text: &str,
        ttl_secs: u64,
    ) -> Result<CachedContent, String> {
        let url = self.resource_url(None);

        // Ensure model has the "models/" prefix
        let model_id = if model.starts_with("models/") {
            model.to_string()
        } else {
            format!("models/{}", model)
        };

        let ttl_clamped = ttl_secs.clamp(60, 172_800);

        let mut body = json!({
            "model": model_id,
            "displayName": "NexQ Meeting Context",
            "contents": [
                {
                    "role": "user",
                    "parts": [{"text": context_text}]
                }
            ],
            "ttl": format!("{}s", ttl_clamped)
        });

        if let Some(sys) = system_instruction {
            if !sys.is_empty() {
                body["systemInstruction"] = json!({
                    "parts": [{"text": sys}]
                });
            }
        }

        let request = endpoint::apply_headers(self.client.post(url), &self.headers);
        let response = request
            .header("Content-Type", "application/json")
            .json(&body)
            .timeout(Duration::from_secs(60))
            .send()
            .await
            .map_err(|e| format!("Gemini cache create request failed: {}", e.without_url()))?;

        if !response.status().is_success() {
            let status = response.status();
            let body_text = response.text().await.unwrap_or_default();
            return Err(format!(
                "Gemini cache create failed ({}): {}",
                status, body_text
            ));
        }

        let resp: CreateResponse = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse cache create response: {}", e.without_url()))?;
        cache_id(&resp.name)?;

        Ok(CachedContent {
            name: resp.name,
            model: resp.model,
            expire_time: resp.expire_time,
            total_token_count: resp.usage_metadata.total_token_count,
            connection_id: None,
        })
    }

    /// Delete a cached content entry by its full resource name.
    pub async fn delete(&self, name: &str) -> Result<(), String> {
        let url = self.resource_url(Some(cache_id(name)?));

        let response = endpoint::apply_headers(self.client.delete(url), &self.headers)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| format!("Gemini cache delete request failed: {}", e.without_url()))?;

        if !response.status().is_success() && response.status().as_u16() != 404 {
            let status = response.status();
            let body_text = response.text().await.unwrap_or_default();
            return Err(format!(
                "Gemini cache delete failed ({}): {}",
                status, body_text
            ));
        }

        Ok(())
    }
}

/// `{base}/v1beta`, without repeating `/v1beta` when the base has it.
fn api_root(base_url: &str) -> Result<Url, String> {
    let base = endpoint::normalize_base_url(base_url).map_err(|error| match error {
        endpoint::EndpointError::MissingScheme { .. } =>
            "Gemini base URL must start with http:// or https://".to_string(),
        other => other.to_string(),
    })?;
    if base.url.path().ends_with("/v1beta") {
        Ok(base.url)
    } else {
        Ok(endpoint::join_endpoint(&base.base, "/v1beta")?)
    }
}

fn cache_id(name: &str) -> Result<&str, String> {
    name.strip_prefix("cachedContents/")
        .filter(|id| !matches!(*id, "" | "." | "..") && !id.contains('/'))
        .ok_or_else(|| "Gemini returned an invalid context cache name".to_string())
}

/// Model names as Gemini compares them (`models/gemini-2.5-flash` and
/// `gemini-2.5-flash` are the same model).
pub fn same_model(a: &str, b: &str) -> bool {
    let bare = |m: &str| m.trim().trim_start_matches("models/").to_string();
    bare(a) == bare(b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::http::test_support::{serve, Canned};

    #[test]
    fn api_root_does_not_repeat_the_version() {
        assert_eq!(api_root("https://generativelanguage.googleapis.com/").unwrap().as_str(), "https://generativelanguage.googleapis.com/v1beta");
        assert_eq!(api_root("https://proxy.example.com/gemini/v1beta").unwrap().as_str(), "https://proxy.example.com/gemini/v1beta");
    }

    #[test]
    fn cache_resource_urls_keep_the_proxy_query_separate() {
        for base in [
            "https://proxy.example/gemini/?region=sg&key=sample",
            "https://proxy.example/gemini/v1beta?region=sg&key=sample",
        ] {
            let client = GeminiCacheClient::for_connection(base, Vec::new()).unwrap();
            assert_eq!(client.resource_url(None).as_str(), "https://proxy.example/gemini/v1beta/cachedContents?region=sg&key=sample");
            assert_eq!(client.resource_url(Some("test")).as_str(), "https://proxy.example/gemini/v1beta/cachedContents/test?region=sg&key=sample");
        }
    }

    #[tokio::test]
    async fn concurrent_updates_keep_the_current_remote_cache() {
        let first_response = r#"{"name":"cachedContents/first","model":"models/gemini-test"}"#;
        let next_response = r#"{"name":"cachedContents/next","model":"models/gemini-test"}"#;
        let (base, seen) = serve(vec![
            Canned::json(200, first_response),
            Canned::new(204, "application/json", Vec::new()),
            Canned::json(200, next_response),
        ]).await;
        let connection = Some("gemini-selected".to_string());
        let client = GeminiCacheClient::new("test-key", Some(&format!("{base}/proxy?region=sg"))).unwrap();
        let cache = GeminiCache::default();
        let create = || cache.create(client.clone(), connection.clone(), "gemini-test", None, "test context", 3600);
        let (first, duplicate) = tokio::join!(create(), create());
        let first = first.unwrap();
        assert!(duplicate.is_err());
        assert_eq!(seen.lock().unwrap().len(), 1);

        let old_target = Some((first.name.as_str(), first.connection_id.as_deref()));
        let (deleted, next) = tokio::join!(cache.delete(old_target), create());
        deleted.unwrap();
        let next = next.unwrap();
        assert!(cache.delete(old_target).await.is_err());
        assert_eq!(cache.status().unwrap().unwrap().name, next.name);
        assert_eq!(next.connection_id, connection);
        let requests = seen.lock().unwrap();
        assert_eq!(requests.iter().map(|r| (r.method.as_str(), r.path.as_str())).collect::<Vec<_>>(), [
            ("POST", "/proxy/v1beta/cachedContents?region=sg"),
            ("DELETE", "/proxy/v1beta/cachedContents/first?region=sg"),
            ("POST", "/proxy/v1beta/cachedContents?region=sg"),
        ]);
    }

    #[tokio::test]
    async fn failed_deletes_keep_the_cache_for_retry() {
        let (base, _) = serve(vec![
            Canned::json(200, r#"{"name":"cachedContents/test","model":"models/gemini-test"}"#),
            Canned::json(503, r#"{"error":"try again"}"#),
            Canned::new(204, "application/json", Vec::new()),
        ]).await;
        let client = GeminiCacheClient::new("test-key", Some(&base)).unwrap();
        let cache = GeminiCache::default();
        let active = cache.create(client, None, "gemini-test", None, "test context", 3600).await.unwrap();
        assert!(cache.delete(None).await.is_err());
        assert_eq!(cache.status().unwrap().unwrap().name, active.name);
        cache.delete(None).await.unwrap();
        assert!(cache.status().unwrap().is_none());
    }

    #[tokio::test]
    async fn cache_transport_errors_do_not_echo_the_proxy_query() {
        let server = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = server.local_addr().unwrap();
        tokio::spawn(async move { let _ = server.accept().await; });
        let client = GeminiCacheClient::for_connection(
            &format!("http://{addr}/proxy?token=private-test-value"),
            Vec::new(),
        ).unwrap();
        let error = client.create("gemini-test", None, "test context", 3600).await.unwrap_err();
        assert!(error.contains("cache create request failed"));
        assert!(!error.contains("private-test-value"));
    }

    #[test]
    fn models_compare_without_the_prefix() {
        assert!(same_model("models/gemini-2.5-flash", "gemini-2.5-flash"));
        assert!(!same_model("models/gemini-2.5-flash", "gemini-2.5-pro"));
    }

    #[test]
    fn the_connection_id_is_left_out_when_unknown() {
        let cache = CachedContent { name: "cachedContents/1".into(), model: "m".into(), expire_time: String::new(), total_token_count: 3, connection_id: None };
        assert!(serde_json::to_value(&cache).unwrap().get("connection_id").is_none());
        let old: CachedContent = serde_json::from_str(r#"{"name":"n","model":"m","expire_time":"","total_token_count":1}"#).unwrap();
        assert_eq!(old.connection_id, None);
    }
}
