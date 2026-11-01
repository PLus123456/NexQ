// Sub-PRD 5: Shared OpenAI-compatible client
// Used by: OpenAI, Groq, OpenRouter, LM Studio, the old custom endpoint and
// every OpenAI-compatible connection (NexQ Plus). Sending, auth and errors
// live in `http.rs`; the stream format (SSE, NDJSON, whole JSON, reasoning,
// errors inside the stream) in `compat.rs`. This file reads model lists.

use serde_json::Value;

use super::provider::ModelInfo;

/// An OpenAI-compatible provider is an HTTP connection client.
pub type OpenAICompatClient = super::http::HttpLlmClient;

/// Models in a `GET {base}/models` answer: `{"data": [{"id": …}]}` (also a
/// bare array or `{"models": […]}`, which some self-hosted servers send).
pub fn parse_models(body: &Value, provider: &str) -> Vec<ModelInfo> {
    let list = body
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| body.as_array())
        .or_else(|| body.get("models").and_then(Value::as_array));
    let Some(list) = list else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|m| {
            let id = m
                .get("id")
                .or_else(|| m.get("name"))
                .or_else(|| m.get("model"))
                .and_then(Value::as_str)?
                .to_string();
            let name = m
                .get("name")
                .and_then(Value::as_str)
                .filter(|n| !n.is_empty())
                .unwrap_or(&id)
                .to_string();
            Some(ModelInfo {
                id,
                name,
                provider: provider.to_string(),
                context_window: m
                    .get("context_window")
                    .and_then(Value::as_u64)
                    .or_else(|| m.get("context_length").and_then(Value::as_u64))
                    .or_else(|| m.get("max_model_len").and_then(Value::as_u64)),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn model_lists_in_the_shapes_servers_send() {
        let ids = |body: Value| parse_models(&body, "custom").into_iter().map(|m| m.id).collect::<Vec<_>>();
        assert_eq!(ids(json!({"object": "list", "data": [{"id": "gpt-4o"}, {"id": "o3"}]})), ["gpt-4o", "o3"]);
        assert_eq!(ids(json!([{"id": "a"}])), ["a"]);
        assert_eq!(ids(json!({"models": [{"name": "qwen"}]})), ["qwen"]);
        assert!(ids(json!({"error": "x"})).is_empty());
        let vllm = parse_models(&json!({"data": [{"id": "Qwen/Qwen3-8B", "max_model_len": 32768}]}), "custom");
        assert_eq!(vllm[0].context_window, Some(32768));
        assert_eq!(vllm[0].name, "Qwen/Qwen3-8B");
    }
}
