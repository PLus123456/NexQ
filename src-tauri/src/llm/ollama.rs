// Sub-PRD 5: Ollama NDJSON streaming client
// NexQ Plus: an Ollama connection (any host, optional auth headers for a
// reverse proxy) is an `http::HttpLlmClient`; its NDJSON stream, including
// `message.thinking`, is decoded by `compat::StreamDecoder`. This file reads
// the model list.

use serde_json::Value;

use super::provider::ModelInfo;

/// An Ollama provider is an HTTP connection client.
pub type OllamaClient = super::http::HttpLlmClient;

/// Models in a `GET /api/tags` answer, with a context length (reported, or
/// estimated from the model family).
pub fn parse_models(body: &Value, provider: &str) -> Vec<ModelInfo> {
    body.get("models")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    let name = m.get("name")?.as_str()?.to_string();
                    let model_name = m
                        .get("model")
                        .and_then(Value::as_str)
                        .unwrap_or(&name)
                        .to_string();
                    let context_window = m
                        .get("details")
                        .and_then(|d| d.get("context_length"))
                        .and_then(Value::as_u64)
                        .or_else(|| Some(estimated_context(&name)));
                    Some(ModelInfo {
                        id: name,
                        name: model_name,
                        provider: provider.to_string(),
                        context_window,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Fallback: estimate the context length from the model name.
fn estimated_context(name: &str) -> u64 {
    let name_lower = name.to_lowercase();
    if name_lower.contains("llama3") {
        8192
    } else if name_lower.contains("mistral") || name_lower.contains("mixtral") {
        32768
    } else if name_lower.contains("gemma") {
        8192
    } else if name_lower.contains("phi") {
        4096
    } else if name_lower.contains("qwen") {
        32768
    } else {
        4096 // Safe default
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tags_list_models_with_context() {
        let models = parse_models(
            &json!({"models": [
                {"name": "llama3.1:8b", "model": "llama3.1:8b"},
                {"name": "qwen3:4b", "details": {"context_length": 40960}}
            ]}),
            "ollama",
        );
        assert_eq!(models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["llama3.1:8b", "qwen3:4b"]);
        assert_eq!(models[0].context_window, Some(8192));
        assert_eq!(models[1].context_window, Some(40960));
        assert_eq!(models[1].provider, "ollama");
    }
}
