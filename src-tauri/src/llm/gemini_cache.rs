use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::Duration;

pub struct GeminiCacheClient {
    client: Client,
    /// Auth (the API key as `x-goog-api-key`) and custom headers.
    headers: Vec<(String, String)>,
    /// `{base}/v1beta`.
    api_root: String,
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
    pub fn new(api_key: &str, base_url: Option<&str>) -> Self {
        // The key goes in a header: a URL (and so any error naming it) never carries it.
        Self::for_connection(
            base_url.unwrap_or("https://generativelanguage.googleapis.com"),
            vec![("x-goog-api-key".to_string(), api_key.to_string())],
        )
    }

    /// A client on a Gemini connection: its base URL (the host, or a base
    /// already ending in `/v1beta`) and its request headers.
    pub fn for_connection(base_url: &str, headers: Vec<(String, String)>) -> Self {
        Self { client: Client::new(), headers, api_root: api_root(base_url) }
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
        let url = format!("{}/cachedContents", self.api_root);

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

        let request = crate::net::endpoint::apply_headers(self.client.post(&url), &self.headers);
        let response = request
            .header("Content-Type", "application/json")
            .json(&body)
            .timeout(Duration::from_secs(60))
            .send()
            .await
            .map_err(|e| format!("Gemini cache create request failed: {}", e))?;

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
            .map_err(|e| format!("Failed to parse cache create response: {}", e))?;

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
        let url = format!("{}/{}", self.api_root, name);

        let response = crate::net::endpoint::apply_headers(self.client.delete(&url), &self.headers)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| format!("Gemini cache delete request failed: {}", e))?;

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
fn api_root(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    if base.ends_with("/v1beta") {
        base.to_string()
    } else {
        format!("{base}/v1beta")
    }
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

    #[test]
    fn api_root_does_not_repeat_the_version() {
        assert_eq!(api_root("https://generativelanguage.googleapis.com/"), "https://generativelanguage.googleapis.com/v1beta");
        assert_eq!(api_root("https://proxy.example.com/gemini/v1beta"), "https://proxy.example.com/gemini/v1beta");
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
