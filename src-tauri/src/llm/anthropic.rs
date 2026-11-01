// Sub-PRD 5: Anthropic Messages API client
// NexQ Plus: an Anthropic-protocol connection (Anthropic itself, or the
// Anthropic-compatible endpoints of DeepSeek, Kimi, GLM…) is an
// `http::HttpLlmClient`. This file builds the request body, decodes the
// event stream (thinking included) and reads the model list.

use serde::Deserialize;
use serde_json::{json, Value};

use super::compat::{self, EffectiveParams, StreamEvent, ThinkStripper};
use super::connections::{CompatFlags, ReasoningMode};
use super::http::{EventDecoder, Failure, HttpLlmClient};
use super::provider::{LLMMessage, ModelInfo};
use super::stream_parser::LineBuffer;

/// `anthropic-version` sent with every request.
pub const API_VERSION: &str = "2023-06-01";

/// Output budget when the caller sets none. Current models think before they
/// answer, and thinking counts toward `max_tokens`.
const DEFAULT_MAX_TOKENS: u64 = 16_000;

/// An Anthropic provider is an HTTP connection client.
pub type AnthropicClient = HttpLlmClient;

/// One page of `GET /v1/models`.
#[derive(Deserialize)]
struct ModelPage {
    data: Vec<ApiModel>,
    #[serde(default)]
    has_more: bool,
    last_id: Option<String>,
}

#[derive(Deserialize)]
struct ApiModel {
    id: String,
    display_name: Option<String>,
    max_input_tokens: Option<u64>,
    lifecycle: Option<String>,
}

/// Models that can still be called: retired ones fail every request.
fn usable_models(models: Vec<ApiModel>, provider: &str) -> Vec<ModelInfo> {
    models
        .into_iter()
        .filter(|m| m.lifecycle.as_deref() != Some("retired"))
        .map(|m| ModelInfo {
            name: m.display_name.unwrap_or_else(|| m.id.clone()),
            id: m.id,
            provider: provider.to_string(),
            context_window: m.max_input_tokens,
        })
        .collect()
}

/// The models of one page, and the id to continue after when there are more.
pub fn parse_models(body: &Value, provider: &str) -> (Vec<ModelInfo>, Option<String>) {
    match serde_json::from_value::<ModelPage>(body.clone()) {
        Ok(page) => {
            let next = page.last_id.filter(|_| page.has_more);
            (usable_models(page.data, provider), next)
        }
        Err(_) => (super::openai_compat::parse_models(body, provider), None),
    }
}

/// Current models, for api.anthropic.com when its Models API is unreachable
/// through a proxy path.
pub fn fallback_models() -> Vec<ModelInfo> {
    [
        ("claude-opus-5-5", "Claude Opus 5.5", 1_000_000),
        ("claude-sonnet-5-5", "Claude Sonnet 5.5", 1_000_000),
        ("claude-haiku-5-5", "Claude Haiku 5.5", 1_000_000),
        ("claude-haiku-4-5", "Claude Haiku 4.5", 200_000),
    ]
    .into_iter()
    .map(|(id, name, context)| ModelInfo {
        id: id.to_string(),
        name: name.to_string(),
        provider: "anthropic".to_string(),
        context_window: Some(context),
    })
    .collect()
}

/// Every page of the model list, newest first. A 404 means the server has
/// no Models API: Anthropic's own host gets the built-in list, any other
/// (an Anthropic-compatible endpoint) an empty one — its models are typed in.
pub async fn fetch_all_models(client: &HttpLlmClient, url: &str, provider: &str) -> Result<Vec<ModelInfo>, Failure> {
    let mut models = Vec::new();
    let mut after_id: Option<String> = None;
    loop {
        let mut page_url = url::Url::parse(url).map_err(|e| Failure::config(e.to_string()))?;
        page_url.query_pairs_mut().append_pair("limit", "1000");
        if let Some(id) = &after_id {
            page_url.query_pairs_mut().append_pair("after_id", id);
        }
        let body = match client.get_json(page_url.as_str(), "Model list request").await {
            Ok(body) => body,
            Err(failure) if failure.status == Some(404) && models.is_empty() => {
                let official = page_url.host_str() == Some("api.anthropic.com");
                return Ok(if official { fallback_models() } else { Vec::new() });
            }
            Err(failure) => return Err(failure),
        };
        let (page, next) = parse_models(&body, provider);
        models.extend(page);
        match next {
            Some(next) => after_id = Some(next),
            None => return Ok(models),
        }
    }
}

/// Body of a `/v1/messages` stream request. System messages become `system`
/// (joined when there are several); the temperature follows the compat
/// switch (not sent by default: current Claude models reject it).
pub fn chat_body(model: &str, messages: &[LLMMessage], params: &EffectiveParams, compat: &CompatFlags) -> Value {
    let mut system_parts: Vec<&str> = Vec::new();
    let mut api_messages: Vec<Value> = Vec::new();
    for msg in messages {
        if msg.role == "system" {
            system_parts.push(&msg.content);
        } else {
            api_messages.push(json!({"role": msg.role, "content": msg.content}));
        }
    }
    let max_tokens = params.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS);
    let mut body = json!({
        "model": model,
        "max_tokens": max_tokens,
        "messages": api_messages,
        "stream": true
    });
    if !system_parts.is_empty() {
        body["system"] = json!(system_parts.join("\n\n"));
    }
    if let Some(t) = compat::temperature_to_send(compat, params.temperature) {
        body["temperature"] = json!(t);
    }
    compat::apply_extra_body(&mut body, params.extra_body.as_ref());
    body
}

/// Decodes Anthropic's event stream: `event:` lines name the event the next
/// `data:` line belongs to (the data's `type` says it too).
pub struct AnthropicDecoder {
    lines: LineBuffer,
    event_type: Option<String>,
    reasoning: ReasoningMode,
    think: ThinkStripper,
    input_tokens: u64,
}

impl AnthropicDecoder {
    pub fn new(compat: &CompatFlags) -> Self {
        Self {
            lines: LineBuffer::new(),
            event_type: None,
            reasoning: compat.reasoning,
            think: ThinkStripper::new(compat.strip_think_tags),
            input_tokens: 0,
        }
    }

    fn line(&mut self, line: &str, out: &mut Vec<StreamEvent>) {
        let line = line.trim();
        if line.is_empty() {
            self.event_type = None;
            return;
        }
        if let Some(event_type) = line.strip_prefix("event:") {
            self.event_type = Some(event_type.trim().to_string());
            return;
        }
        let payload = match line.strip_prefix("data:") {
            Some(data) => data.trim(),
            // A plain JSON error body served as the stream.
            None if line.starts_with('{') => line,
            None => return,
        };
        let Ok(data) = serde_json::from_str::<Value>(payload) else {
            return;
        };
        let event_type = self
            .event_type
            .take()
            .or_else(|| data.get("type").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_default();
        match event_type.as_str() {
            "message_start" => {
                if let Some(it) = data.pointer("/message/usage/input_tokens").and_then(Value::as_u64) {
                    self.input_tokens = it;
                    out.push(StreamEvent::Usage { prompt_tokens: it, completion_tokens: 0 });
                }
            }
            "content_block_delta" => {
                let delta = data.get("delta");
                let delta_type = delta.and_then(|d| d.get("type")).and_then(Value::as_str).unwrap_or("text_delta");
                match delta_type {
                    "thinking_delta" => {
                        if self.reasoning == ReasoningMode::Auto {
                            if let Some(text) = delta.and_then(|d| d.get("thinking")).and_then(Value::as_str) {
                                if !text.is_empty() {
                                    out.push(StreamEvent::Reasoning(text.to_string()));
                                }
                            }
                        }
                    }
                    _ => {
                        if let Some(text) = delta.and_then(|d| d.get("text")).and_then(Value::as_str) {
                            out.extend(self.think.push(text));
                        }
                    }
                }
            }
            "message_delta" => {
                if let Some(ot) = data.pointer("/usage/output_tokens").and_then(Value::as_u64) {
                    out.push(StreamEvent::Usage { prompt_tokens: self.input_tokens, completion_tokens: ot });
                }
            }
            "message_stop" => out.push(StreamEvent::Done),
            "error" => {
                let message = compat::error_message(&data).unwrap_or_else(|| "Unknown Anthropic error".to_string());
                out.push(StreamEvent::Error(message));
            }
            _ => {
                if let Some(message) = compat::error_message(&data) {
                    out.push(StreamEvent::Error(message));
                }
            }
        }
    }
}

impl EventDecoder for AnthropicDecoder {
    fn push(&mut self, chunk: &[u8]) -> Vec<StreamEvent> {
        let mut out = Vec::new();
        for line in self.lines.push(chunk) {
            self.line(&line, &mut out);
        }
        out
    }

    fn finish(&mut self) -> Vec<StreamEvent> {
        let mut out = Vec::new();
        if let Some(rest) = self.lines.flush() {
            self.line(&rest, &mut out);
        }
        out.extend(self.think.finish());
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::api::LlmKind;
    use crate::llm::connections::LlmConnection;
    use crate::llm::http::test_support::{serve, Canned, RecordingOutput};
    use crate::llm::provider::GenerationParams;
    use crate::net::endpoint::{AuthConfig, AuthMode};
    use std::collections::HashMap;

    #[test]
    fn model_page_lists_callable_models_with_their_names() {
        let body = json!({
            "data": [
                {"type": "model", "id": "claude-opus-5-5", "display_name": "Claude Opus 5.5",
                 "max_input_tokens": 1000000, "lifecycle": "active"},
                {"type": "model", "id": "claude-old", "display_name": "Old", "lifecycle": "retired"},
                {"type": "model", "id": "claude-haiku-4-5-20251001", "lifecycle": "deprecated"}
            ],
            "has_more": false, "first_id": "claude-opus-5-5", "last_id": "claude-haiku-4-5-20251001"
        });
        let (models, next) = parse_models(&body, "anthropic");
        assert_eq!(next, None);
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["claude-opus-5-5", "claude-haiku-4-5-20251001"]);
        assert_eq!(models[0].name, "Claude Opus 5.5");
        assert_eq!(models[0].context_window, Some(1_000_000));
        assert_eq!(models[1].name, "claude-haiku-4-5-20251001"); // no display name
    }

    #[test]
    fn fallback_lists_only_current_models() {
        let ids: Vec<String> = fallback_models().into_iter().map(|m| m.id).collect();
        assert!(ids.contains(&"claude-opus-5-5".to_string()));
        assert!(ids.iter().all(|id| !id.starts_with("claude-3")));
    }

    #[test]
    fn body_keeps_system_apart_and_omits_temperature_by_default() {
        let messages = vec![
            LLMMessage { role: "system".into(), content: "A".into() },
            LLMMessage { role: "system".into(), content: "B".into() },
            LLMMessage { role: "user".into(), content: "hi".into() },
        ];
        let params = EffectiveParams { temperature: Some(0.3), ..Default::default() };
        let body = chat_body("claude", &messages, &params, &CompatFlags::for_kind(LlmKind::Anthropic));
        assert_eq!(body["system"], "A\n\nB");
        assert_eq!(body["max_tokens"], DEFAULT_MAX_TOKENS);
        assert!(body.get("temperature").is_none());
        assert_eq!(body["messages"].as_array().unwrap().len(), 1);
        let body = chat_body("claude", &messages, &params, &CompatFlags::default());
        assert_eq!(body["temperature"], 0.3);
    }

    #[test]
    fn decoder_reads_text_thinking_usage_and_errors() {
        let mut decoder = AnthropicDecoder::new(&CompatFlags::default());
        let stream = concat!(
            "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":12}}}\n\n",
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"hm\"}}\n\n",
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"你好\"}}\n\n",
            "event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":5}}\n\n",
            "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
        );
        let bytes = stream.as_bytes();
        let cut = stream.find("你").unwrap() + 2;
        let mut events = decoder.push(&bytes[..cut]);
        events.extend(decoder.push(&bytes[cut..]));
        events.extend(decoder.finish());
        assert!(events.contains(&StreamEvent::Reasoning("hm".into())));
        assert!(events.contains(&StreamEvent::Content("你好".into())));
        assert!(events.contains(&StreamEvent::Usage { prompt_tokens: 12, completion_tokens: 5 }));
        assert_eq!(events.last(), Some(&StreamEvent::Done));

        let mut decoder = AnthropicDecoder::new(&CompatFlags::default());
        let events = decoder.push(b"event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\n\n");
        assert_eq!(events, vec![StreamEvent::Error("Overloaded (overloaded_error)".into())]);
    }

    #[tokio::test]
    async fn requests_go_to_v1_messages_with_the_key_header() {
        let (base, seen) = serve(vec![Canned::sse(&[
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"ok\"}}\n\n",
            "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
        ])])
        .await;
        let conn = LlmConnection {
            kind: LlmKind::Anthropic,
            base_url: format!("{base}/anthropic"),
            auth: AuthConfig { mode: AuthMode::Header, header_name: "x-api-key".into(), prefix: String::new() },
            ..Default::default()
        };
        let client = HttpLlmClient::new(&conn, Some("sk-ant"), &HashMap::new()).unwrap();
        let out = RecordingOutput::default();
        let messages = vec![LLMMessage { role: "user".into(), content: "hi".into() }];
        client.stream_with(&messages, "deepseek-chat", &GenerationParams::default(), &out).await.unwrap();
        assert_eq!(out.text(), "ok");
        let request = seen.lock().unwrap()[0].clone();
        assert_eq!(request.path, "/anthropic/v1/messages");
        assert_eq!(request.header("x-api-key"), Some("sk-ant"));
        assert_eq!(request.header("anthropic-version"), Some(API_VERSION));
    }

    #[tokio::test]
    async fn a_proxy_without_a_models_api_lists_nothing() {
        let (base, _) = serve(vec![Canned::json(404, "{}")]).await;
        let conn = LlmConnection { kind: LlmKind::Anthropic, base_url: base, ..Default::default() };
        let client = HttpLlmClient::new(&conn, Some("k"), &HashMap::new()).unwrap();
        assert!(client.fetch_models().await.unwrap().1.is_empty());
    }
}
