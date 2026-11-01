// Sub-PRD 5: Google Gemini streamGenerateContent client
// NexQ Plus: a Gemini connection is an `http::HttpLlmClient`. The API key is
// sent in the `x-goog-api-key` header (it used to be a `?key=` query
// parameter, which error messages could carry to the screen). This file
// builds the request body, decodes the stream and reads the model list.

use serde_json::{json, Value};

use super::compat::{self, EffectiveParams, StreamEvent, ThinkStripper};
use super::connections::{CompatFlags, ReasoningMode};
use super::http::EventDecoder;
use super::provider::{LLMMessage, ModelInfo, StreamSource};
use super::stream_parser::{LineBuffer, SSEParser};

/// A Gemini provider is an HTTP connection client.
pub type GeminiClient = super::http::HttpLlmClient;

/// Output budget when the caller sets none.
const DEFAULT_MAX_OUTPUT_TOKENS: u64 = 4096;

/// Convert standard LLM messages to Gemini format.
/// Gemini uses "user" and "model" roles, with a separate systemInstruction field.
fn convert_messages(messages: &[LLMMessage]) -> (Option<String>, Vec<Value>) {
    let mut system_instruction: Option<String> = None;
    let mut contents: Vec<Value> = Vec::new();

    for msg in messages {
        match msg.role.as_str() {
            "system" => {
                system_instruction = Some(match system_instruction {
                    Some(earlier) => format!("{earlier}\n\n{}", msg.content),
                    None => msg.content.clone(),
                });
            }
            "assistant" => {
                contents.push(json!({
                    "role": "model",
                    "parts": [{"text": msg.content}]
                }));
            }
            _ => {
                // "user" or anything else maps to "user"
                contents.push(json!({
                    "role": "user",
                    "parts": [{"text": msg.content}]
                }));
            }
        }
    }

    (system_instruction, contents)
}

/// Body of a `streamGenerateContent` request. With a context cache the system
/// instruction is in the cache; `google_search` adds the grounding tool.
pub fn chat_body(
    messages: &[LLMMessage],
    params: &EffectiveParams,
    compat: &CompatFlags,
    cache_name: Option<&str>,
    google_search: bool,
) -> Value {
    let (system_instruction, contents) = convert_messages(messages);
    let mut gen_config = json!({
        "maxOutputTokens": params.max_tokens.unwrap_or(DEFAULT_MAX_OUTPUT_TOKENS)
    });
    if let Some(temp) = compat::temperature_to_send(compat, params.temperature) {
        gen_config["temperature"] = json!(temp);
    }

    let mut body = if let Some(cache_name) = cache_name {
        // Cache active: reference cached content, skip systemInstruction (it's in the cache).
        // Only dynamic contents (transcript + question) are sent fresh.
        json!({
            "cachedContent": cache_name,
            "contents": contents,
            "generationConfig": gen_config
        })
    } else {
        let mut b = json!({
            "contents": contents,
            "generationConfig": gen_config
        });
        if let Some(system) = system_instruction {
            b["systemInstruction"] = json!({
                "parts": [{"text": system}]
            });
        }
        b
    };

    if google_search {
        body["tools"] = json!([{ "google_search": {} }]);
    }
    compat::apply_extra_body(&mut body, params.extra_body.as_ref());
    body
}

/// Models in a `GET /v1beta/models` answer that can generate content.
pub fn parse_models(body: &Value, provider: &str) -> Vec<ModelInfo> {
    body.get("models")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    let name = m.get("name")?.as_str()?.to_string();
                    let display_name = m
                        .get("displayName")
                        .and_then(Value::as_str)
                        .unwrap_or(&name)
                        .to_string();

                    // Filter to only generateContent-supporting models
                    let supported = m
                        .get("supportedGenerationMethods")
                        .and_then(Value::as_array)
                        .map(|methods| {
                            methods.iter().any(|method| {
                                method.as_str() == Some("generateContent")
                                    || method.as_str() == Some("streamGenerateContent")
                            })
                        })
                        .unwrap_or(false);
                    if !supported {
                        return None;
                    }

                    // Extract model ID from "models/gemini-pro" -> "gemini-pro"
                    let id = name.strip_prefix("models/").unwrap_or(&name).to_string();
                    Some(ModelInfo {
                        id,
                        name: display_name,
                        provider: provider.to_string(),
                        context_window: m.get("inputTokenLimit").and_then(Value::as_u64),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Decodes Gemini's SSE stream (or the JSON array it sends without
/// `alt=sse`): text parts, thought parts (reasoning), usage, errors and
/// grounding sources.
pub struct GeminiDecoder {
    lines: LineBuffer,
    reasoning: ReasoningMode,
    think: ThinkStripper,
    collect_sources: bool,
    sources: Vec<(String, String)>,
    raw: String,
    recognised: bool,
}

impl GeminiDecoder {
    pub fn new(compat: &CompatFlags, collect_sources: bool) -> Self {
        Self {
            lines: LineBuffer::new(),
            reasoning: compat.reasoning,
            think: ThinkStripper::new(compat.strip_think_tags),
            collect_sources,
            sources: Vec::new(),
            raw: String::new(),
            recognised: false,
        }
    }

    fn data(&mut self, data: &Value, out: &mut Vec<StreamEvent>) {
        if let Some(message) = compat::error_message(data) {
            out.push(StreamEvent::Error(message));
            return;
        }
        let parts = data
            .pointer("/candidates/0/content/parts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for part in parts {
            let Some(text) = part.get("text").and_then(Value::as_str) else { continue };
            if text.is_empty() {
                continue;
            }
            if part.get("thought").and_then(Value::as_bool) == Some(true) {
                if self.reasoning == ReasoningMode::Auto {
                    out.push(StreamEvent::Reasoning(text.to_string()));
                }
            } else {
                out.extend(self.think.push(text));
            }
        }
        if self.collect_sources {
            self.sources.extend(SSEParser::extract_gemini_grounding(data));
        }
        if let Some(usage) = data.get("usageMetadata") {
            let prompt = usage.get("promptTokenCount").and_then(Value::as_u64);
            let completion = usage.get("candidatesTokenCount").and_then(Value::as_u64);
            if prompt.is_some() || completion.is_some() {
                out.push(StreamEvent::Usage {
                    prompt_tokens: prompt.unwrap_or(0),
                    completion_tokens: completion.unwrap_or(0),
                });
            }
        }
    }

    fn line(&mut self, line: &str, out: &mut Vec<StreamEvent>) {
        let trimmed = line.trim();
        match trimmed.strip_prefix("data:").map(str::trim) {
            Some(payload) => {
                if let Ok(data) = serde_json::from_str::<Value>(payload) {
                    self.recognised = true;
                    self.data(&data, out);
                }
            }
            None => {
                if !self.recognised && !trimmed.is_empty() && self.raw.len() < 4 * 1024 * 1024 {
                    self.raw.push_str(line);
                    self.raw.push('\n');
                }
            }
        }
    }
}

impl EventDecoder for GeminiDecoder {
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
        if !self.recognised && !self.raw.trim().is_empty() {
            match serde_json::from_str::<Value>(self.raw.trim()) {
                Ok(Value::Array(items)) => {
                    for item in items {
                        self.data(&item, &mut out);
                    }
                }
                Ok(item) => self.data(&item, &mut out),
                Err(_) => {}
            }
        }
        out.extend(self.think.finish());
        out
    }

    fn sources(&mut self) -> Vec<StreamSource> {
        let mut seen = std::collections::HashSet::new();
        std::mem::take(&mut self.sources)
            .into_iter()
            .filter(|(_, url)| seen.insert(url.clone()))
            .map(|(title, url)| StreamSource { title, url })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::api::LlmKind;
    use crate::llm::connections::{auth_for_kind, LlmConnection};
    use crate::llm::http::test_support::{serve, Canned, RecordingOutput};
    use crate::llm::http::HttpLlmClient;
    use crate::llm::provider::GenerationParams;
    use std::collections::HashMap;

    #[test]
    fn body_has_system_instruction_cache_and_search() {
        let messages = vec![
            LLMMessage { role: "system".into(), content: "S".into() },
            LLMMessage { role: "assistant".into(), content: "A".into() },
            LLMMessage { role: "user".into(), content: "U".into() },
        ];
        let params = EffectiveParams { temperature: Some(0.4), ..Default::default() };
        let body = chat_body(&messages, &params, &CompatFlags::default(), None, true);
        assert_eq!(body["systemInstruction"]["parts"][0]["text"], "S");
        assert_eq!(body["contents"][0]["role"], "model");
        assert_eq!(body["generationConfig"], json!({"maxOutputTokens": 4096, "temperature": 0.4}));
        assert_eq!(body["tools"], json!([{"google_search": {}}]));
        let cached = chat_body(&messages, &params, &CompatFlags::default(), Some("cachedContents/1"), false);
        assert_eq!(cached["cachedContent"], "cachedContents/1");
        assert!(cached.get("systemInstruction").is_none() && cached.get("tools").is_none());
    }

    #[test]
    fn decoder_reads_parts_thoughts_usage_sources_and_errors() {
        let mut decoder = GeminiDecoder::new(&CompatFlags::default(), true);
        let stream = concat!(
            "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"plan\",\"thought\":true},{\"text\":\"你好\"}]},",
            "\"groundingMetadata\":{\"groundingChunks\":[{\"web\":{\"uri\":\"https://a\",\"title\":\"A\"}},{\"web\":{\"uri\":\"https://a\"}}]}}],",
            "\"usageMetadata\":{\"promptTokenCount\":9,\"candidatesTokenCount\":2}}\n\n",
        );
        let events: Vec<StreamEvent> = decoder.push(stream.as_bytes()).into_iter().chain(decoder.finish()).collect();
        assert!(events.contains(&StreamEvent::Reasoning("plan".into())));
        assert!(events.contains(&StreamEvent::Content("你好".into())));
        assert!(events.contains(&StreamEvent::Usage { prompt_tokens: 9, completion_tokens: 2 }));
        let sources = decoder.sources();
        assert_eq!(sources.len(), 1);
        assert_eq!((sources[0].title.as_str(), sources[0].url.as_str()), ("A", "https://a"));

        let mut decoder = GeminiDecoder::new(&CompatFlags::default(), false);
        let events = decoder.push(b"data: {\"error\":{\"code\":400,\"message\":\"API key not valid\",\"status\":\"INVALID_ARGUMENT\"}}\n\n");
        assert_eq!(events, vec![StreamEvent::Error("API key not valid (400)".into())]);

        // Without alt=sse: a JSON array of responses.
        let mut decoder = GeminiDecoder::new(&CompatFlags::default(), false);
        let mut events = decoder.push(b"[{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"a\"}]}}]},\n{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"b\"}]}}]}]");
        events.extend(decoder.finish());
        assert_eq!(events, vec![StreamEvent::Content("a".into()), StreamEvent::Content("b".into())]);
    }

    #[test]
    fn models_that_generate_content() {
        let models = parse_models(
            &json!({"models": [
                {"name": "models/gemini-2.5-flash", "displayName": "Gemini 2.5 Flash", "inputTokenLimit": 1048576,
                 "supportedGenerationMethods": ["generateContent", "countTokens"]},
                {"name": "models/text-embedding-004", "supportedGenerationMethods": ["embedContent"]}
            ]}),
            "gemini",
        );
        assert_eq!(models.len(), 1);
        assert_eq!((models[0].id.as_str(), models[0].context_window), ("gemini-2.5-flash", Some(1048576)));
    }

    #[tokio::test]
    async fn the_key_goes_in_a_header_not_the_url() {
        let (base, seen) = serve(vec![Canned::sse(&["data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"hi\"}]}}]}\n\n"])]).await;
        let conn = LlmConnection { kind: LlmKind::Gemini, base_url: base, auth: auth_for_kind(LlmKind::Gemini), ..Default::default() };
        let client = HttpLlmClient::new(&conn, Some("AIza-secret"), &HashMap::new()).unwrap();
        let out = RecordingOutput::default();
        let messages = vec![LLMMessage { role: "user".into(), content: "hi".into() }];
        client.stream_with(&messages, "gemini-2.5-flash", &GenerationParams::default(), &out).await.unwrap();
        assert_eq!(out.text(), "hi");
        let request = seen.lock().unwrap()[0].clone();
        assert_eq!(request.path, "/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse");
        assert!(!request.path.contains("AIza"));
        assert_eq!(request.header("x-goog-api-key"), Some("AIza-secret"));
    }
}
