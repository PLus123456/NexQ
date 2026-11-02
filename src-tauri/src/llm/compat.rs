//! Pure helpers for LLM HTTP streams (NexQ Plus): parsing a stream into
//! events (SSE, NDJSON, or a whole JSON answer from a server that ignores
//! `stream: true`), errors reported inside a 200 stream, reasoning text kept
//! out of the answer, `<think>` stripping, request bodies, and the JSON Merge
//! Patch for `extra_body`. No I/O: everything here is unit-tested.

use serde_json::{json, Map, Value};

use super::connections::{
    CompatFlags, MaxTokensField, ReasoningMode, RouteParams, TemperatureMode, PROTECTED_BODY_KEYS,
};
use super::provider::LLMMessage;
use super::stream_parser::LineBuffer;

/// Most of an unrecognised body kept for the whole-JSON fallback.
const RAW_BODY_LIMIT: usize = 4 * 1024 * 1024;

/// One thing a stream said.
#[derive(Debug, Clone, PartialEq)]
pub enum StreamEvent {
    /// Answer text.
    Content(String),
    /// Reasoning text: signalled, never part of the answer.
    Reasoning(String),
    /// Token counts the server reported.
    Usage { prompt_tokens: u64, completion_tokens: u64 },
    /// An error the server sent inside a successful (200) response.
    Error(String),
    /// End of the stream (`[DONE]`, Ollama's `done: true`).
    Done,
}

/// The message of an `error` member (`{"error": {"message": …}}`,
/// `{"error": "…"}`); `None` when absent or null.
pub fn error_message(value: &Value) -> Option<String> {
    let error = value.get("error")?;
    match error {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Object(obj) => {
            let message = obj.get("message").and_then(Value::as_str).map(str::to_string);
            let code = obj
                .get("code")
                .or_else(|| obj.get("type"))
                .and_then(|c| c.as_str().map(str::to_string).or_else(|| c.as_i64().map(|n| n.to_string())));
            Some(match (message, code) {
                (Some(m), Some(c)) if !m.contains(&c) => format!("{m} ({c})"),
                (Some(m), _) => m,
                (None, _) => error.to_string(),
            })
        }
        other => Some(other.to_string()),
    }
}

/// Events in one JSON object of an OpenAI-compatible stream (a chunk, a
/// whole non-streamed completion, or an Ollama `/api/chat` line).
pub fn events_from_json(value: &Value, reasoning: ReasoningMode) -> Vec<StreamEvent> {
    let mut events = Vec::new();
    if let Some(message) = error_message(value) {
        events.push(StreamEvent::Error(message));
        return events;
    }
    let want_reasoning = reasoning == ReasoningMode::Auto;
    if let Some(choice) = value.get("choices").and_then(|c| c.get(0)) {
        match choice.get("delta").or_else(|| choice.get("message")) {
            Some(delta) => {
                if want_reasoning {
                    push_reasoning(&mut events, delta, &["reasoning_content", "reasoning"]);
                }
                if let Some(text) = delta.get("content").and_then(Value::as_str) {
                    push_content(&mut events, text);
                }
            }
            None => {
                if let Some(text) = choice.get("text").and_then(Value::as_str) {
                    push_content(&mut events, text);
                }
            }
        }
    } else if let Some(message) = value.get("message").filter(|m| m.is_object()) {
        // Ollama `/api/chat`.
        if want_reasoning {
            push_reasoning(&mut events, message, &["thinking"]);
        }
        if let Some(text) = message.get("content").and_then(Value::as_str) {
            push_content(&mut events, text);
        }
    }
    if let Some(usage) = value.get("usage").filter(|u| u.is_object()) {
        let prompt = usage.get("prompt_tokens").and_then(Value::as_u64);
        let completion = usage.get("completion_tokens").and_then(Value::as_u64);
        if prompt.is_some() || completion.is_some() {
            events.push(StreamEvent::Usage {
                prompt_tokens: prompt.unwrap_or(0),
                completion_tokens: completion.unwrap_or(0),
            });
        }
    }
    if value.get("done").and_then(Value::as_bool) == Some(true) {
        let prompt = value.get("prompt_eval_count").and_then(Value::as_u64);
        let completion = value.get("eval_count").and_then(Value::as_u64);
        if prompt.is_some() || completion.is_some() {
            events.push(StreamEvent::Usage {
                prompt_tokens: prompt.unwrap_or(0),
                completion_tokens: completion.unwrap_or(0),
            });
        }
        events.push(StreamEvent::Done);
    }
    events
}

fn push_content(events: &mut Vec<StreamEvent>, text: &str) {
    if !text.is_empty() {
        events.push(StreamEvent::Content(text.to_string()));
    }
}

fn push_reasoning(events: &mut Vec<StreamEvent>, holder: &Value, keys: &[&str]) {
    for key in keys {
        if let Some(text) = holder.get(*key).and_then(Value::as_str) {
            if !text.is_empty() {
                events.push(StreamEvent::Reasoning(text.to_string()));
                return;
            }
        }
    }
}

/// What one line of a stream is.
enum Line<'a> {
    /// Blank, comment, or an SSE field other than `data:`.
    Skip,
    Done,
    Json(Value),
    /// Not JSON (part of a pretty-printed whole answer, or garbage).
    Other(&'a str),
}

fn classify(line: &str) -> Line<'_> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with(':') {
        return Line::Skip;
    }
    let payload = if let Some(data) = trimmed.strip_prefix("data:") {
        data.trim()
    } else if ["event:", "id:", "retry:"].iter().any(|p| trimmed.starts_with(p)) {
        return Line::Skip;
    } else {
        trimmed
    };
    if payload == "[DONE]" {
        return Line::Done;
    }
    if payload.is_empty() {
        return Line::Skip;
    }
    match serde_json::from_str::<Value>(payload) {
        Ok(value) if value.is_object() => Line::Json(value),
        _ => Line::Other(line),
    }
}

/// Turns the bytes of an OpenAI-compatible (or Ollama) response into events:
/// SSE `data:` lines, NDJSON lines, or, when the server ignored
/// `stream: true`, the whole JSON answer (also pretty-printed). Content goes
/// through the `<think>` stripper; reasoning stays apart.
pub struct StreamDecoder {
    lines: LineBuffer,
    reasoning: ReasoningMode,
    think: ThinkStripper,
    /// Unrecognised lines while nothing was recognised yet.
    raw: String,
    recognised: bool,
}

impl StreamDecoder {
    pub fn new(compat: &CompatFlags) -> Self {
        Self {
            lines: LineBuffer::new(),
            reasoning: compat.reasoning,
            think: ThinkStripper::new(compat.strip_think_tags),
            raw: String::new(),
            recognised: false,
        }
    }

    /// Events in the next network chunk.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<StreamEvent> {
        let lines = self.lines.push(chunk);
        let mut events = Vec::new();
        for line in lines {
            self.line(&line, &mut events);
        }
        events
    }

    /// Events left at the end of the body.
    pub fn finish(&mut self) -> Vec<StreamEvent> {
        let mut events = Vec::new();
        if let Some(rest) = self.lines.flush() {
            self.line(&rest, &mut events);
        }
        if !self.recognised && !self.raw.trim().is_empty() {
            if let Ok(value) = serde_json::from_str::<Value>(self.raw.trim()) {
                self.recognised = true;
                let parsed = events_from_json(&value, self.reasoning);
                self.route(parsed, &mut events);
            }
        }
        events.extend(self.think.finish());
        events
    }

    /// Whether any line was understood (else the body was not a stream).
    pub fn recognised(&self) -> bool {
        self.recognised
    }

    fn line(&mut self, line: &str, events: &mut Vec<StreamEvent>) {
        match classify(line) {
            Line::Skip => {}
            Line::Done => {
                self.recognised = true;
                events.push(StreamEvent::Done);
            }
            Line::Json(value) => {
                let parsed = events_from_json(&value, self.reasoning);
                if parsed.is_empty() && !self.recognised {
                    // Maybe one line of a pretty-printed answer (`{"a": 1}` alone is valid JSON too).
                    self.keep_raw(line);
                    return;
                }
                self.recognised = true;
                self.route(parsed, events);
            }
            Line::Other(text) => {
                if !self.recognised {
                    self.keep_raw(text);
                }
            }
        }
    }

    fn keep_raw(&mut self, line: &str) {
        if self.raw.len() + line.len() < RAW_BODY_LIMIT {
            self.raw.push_str(line);
            self.raw.push('\n');
        }
    }

    fn route(&mut self, parsed: Vec<StreamEvent>, events: &mut Vec<StreamEvent>) {
        for event in parsed {
            match event {
                StreamEvent::Content(text) => events.extend(self.think.push(&text)),
                other => events.push(other),
            }
        }
    }
}

// ── <think> stripping ───────────────────────────────────────────────────────

const THINK_OPEN: &str = "<think>";
const THINK_CLOSE: &str = "</think>";

#[derive(Debug, PartialEq)]
enum ThinkState {
    /// Not sure yet whether the answer opens with `<think>`.
    Start(String),
    /// Inside the think block; holds text that may be the start of `</think>`.
    Inside(String),
    /// Just after `</think>`: leading blank space is dropped.
    After,
    Passthrough,
}

/// Moves a leading `<think>…</think>` block (models such as DeepSeek-R1 or
/// QwQ served without a reasoning parser) out of the answer, even when the
/// tags arrive split across tokens.
#[derive(Debug)]
pub struct ThinkStripper {
    state: ThinkState,
}

impl ThinkStripper {
    pub fn new(enabled: bool) -> Self {
        Self { state: if enabled { ThinkState::Start(String::new()) } else { ThinkState::Passthrough } }
    }

    pub fn push(&mut self, text: &str) -> Vec<StreamEvent> {
        let mut out = Vec::new();
        self.feed(text.to_string(), &mut out);
        out
    }

    /// End of the answer: flushes what was held back.
    pub fn finish(&mut self) -> Vec<StreamEvent> {
        let mut out = Vec::new();
        match std::mem::replace(&mut self.state, ThinkState::Passthrough) {
            ThinkState::Start(pending) => push_content(&mut out, &pending),
            ThinkState::Inside(held) => {
                if !held.is_empty() {
                    out.push(StreamEvent::Reasoning(held));
                }
            }
            ThinkState::After | ThinkState::Passthrough => {}
        }
        out
    }

    fn feed(&mut self, text: String, out: &mut Vec<StreamEvent>) {
        match std::mem::replace(&mut self.state, ThinkState::Passthrough) {
            ThinkState::Passthrough => push_content(out, &text),
            ThinkState::Start(mut pending) => {
                pending.push_str(&text);
                let lead = pending.trim_start();
                if let Some(rest) = lead.strip_prefix(THINK_OPEN) {
                    let rest = rest.to_string();
                    self.state = ThinkState::Inside(String::new());
                    self.feed(rest, out);
                } else if THINK_OPEN.starts_with(lead) {
                    // Blank so far, or a prefix of `<think>`: wait for more.
                    self.state = ThinkState::Start(pending);
                } else {
                    push_content(out, &pending);
                }
            }
            ThinkState::Inside(mut held) => {
                held.push_str(&text);
                if let Some(pos) = held.find(THINK_CLOSE) {
                    let reasoning = &held[..pos];
                    if !reasoning.is_empty() {
                        out.push(StreamEvent::Reasoning(reasoning.to_string()));
                    }
                    let rest = held[pos + THINK_CLOSE.len()..].to_string();
                    self.state = ThinkState::After;
                    self.feed(rest, out);
                } else {
                    // Emit all but a possible partial `</think>` at the end.
                    let keep = partial_suffix_len(&held, THINK_CLOSE);
                    let split = held.len() - keep;
                    if split > 0 {
                        out.push(StreamEvent::Reasoning(held[..split].to_string()));
                    }
                    self.state = ThinkState::Inside(held[split..].to_string());
                }
            }
            ThinkState::After => {
                let rest = text.trim_start();
                if rest.is_empty() {
                    self.state = ThinkState::After;
                } else {
                    push_content(out, rest);
                }
            }
        }
    }
}

/// Length of the longest suffix of `text` that is a proper prefix of `tag`.
fn partial_suffix_len(text: &str, tag: &str) -> usize {
    (1..tag.len())
        .rev()
        .find(|&n| text.len() >= n && text.is_char_boundary(text.len() - n) && tag.starts_with(&text[text.len() - n..]))
        .unwrap_or(0)
}

// ── Request bodies ──────────────────────────────────────────────────────────

/// Parameters of one request after merging connection defaults, the caller
/// and route overrides.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct EffectiveParams {
    pub json_mode: bool,
    pub temperature: Option<f64>,
    pub max_tokens: Option<u64>,
    pub extra_body: Option<Value>,
}

/// Merges parameter layers, lowest priority first: a later `Some` wins;
/// `extra_body` patches are applied in order.
pub fn merge_params<'a>(layers: impl IntoIterator<Item = &'a RouteParams>) -> EffectiveParams {
    let mut out = EffectiveParams::default();
    for layer in layers {
        if layer.temperature.is_some() {
            out.temperature = layer.temperature;
        }
        if layer.max_tokens.is_some() {
            out.max_tokens = layer.max_tokens;
        }
        if let Some(extra) = &layer.extra_body {
            let target = out.extra_body.get_or_insert_with(|| Value::Object(Map::new()));
            merge_patch(target, &Value::Object(extra.clone()));
        }
    }
    out
}

/// RFC 7396 JSON Merge Patch: objects merge recursively, `null` deletes,
/// anything else replaces.
pub fn merge_patch(target: &mut Value, patch: &Value) {
    let Value::Object(patch) = patch else {
        *target = patch.clone();
        return;
    };
    if !target.is_object() {
        *target = Value::Object(Map::new());
    }
    let Value::Object(target) = target else { return };
    for (key, value) in patch {
        if value.is_null() {
            target.remove(key);
        } else {
            merge_patch(target.entry(key.clone()).or_insert(Value::Null), value);
        }
    }
}

/// Applies `extra` to a request body, leaving `model`, `messages` and
/// `stream` alone.
pub fn apply_extra_body(body: &mut Value, extra: Option<&Value>) {
    let Some(Value::Object(extra)) = extra else { return };
    let allowed: Map<String, Value> = extra
        .iter()
        .filter(|(k, _)| !PROTECTED_BODY_KEYS.contains(&k.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    merge_patch(body, &Value::Object(allowed));
}

/// The temperature to send after the compat switch (`None` = omit).
pub fn temperature_to_send(compat: &CompatFlags, requested: Option<f64>) -> Option<f64> {
    match compat.temperature {
        TemperatureMode::Pass => requested,
        TemperatureMode::Omit => None,
        TemperatureMode::Fixed => compat.fixed_temperature,
    }
}

/// Body of an OpenAI-compatible `/chat/completions` stream request.
pub fn openai_chat_body(model: &str, messages: &[LLMMessage], params: &EffectiveParams, compat: &CompatFlags) -> Value {
    let msgs: Vec<Value> = messages.iter().map(|m| json!({"role": m.role, "content": m.content})).collect();
    let mut body = json!({"model": model, "messages": msgs, "stream": true});
    if let Some(t) = temperature_to_send(compat, params.temperature) {
        body["temperature"] = json!(t);
    }
    if let Some(max) = params.max_tokens {
        match compat.max_tokens_field {
            MaxTokensField::MaxTokens => body["max_tokens"] = json!(max),
            MaxTokensField::MaxCompletionTokens => body["max_completion_tokens"] = json!(max),
            MaxTokensField::Omit => {}
        }
    }
    if params.json_mode && compat.supports_json_mode {
        body["response_format"] = json!({"type": "json_object"});
    }
    if compat.stream_usage {
        body["stream_options"] = json!({"include_usage": true});
    }
    apply_extra_body(&mut body, params.extra_body.as_ref());
    body
}

/// Body of an Ollama `/api/chat` stream request.
pub fn ollama_chat_body(model: &str, messages: &[LLMMessage], params: &EffectiveParams, compat: &CompatFlags) -> Value {
    let msgs: Vec<Value> = messages.iter().map(|m| json!({"role": m.role, "content": m.content})).collect();
    let keep_alive = compat
        .keep_alive
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .unwrap_or(super::connections::DEFAULT_KEEP_ALIVE);
    // Ollama unloads idle models after 5 min by default; questions in a meeting
    // are often further apart, and reloading from disk on CPU-only machines
    // adds many seconds before the first token.
    let mut body = json!({"model": model, "messages": msgs, "stream": true, "keep_alive": keep_alive});
    if params.json_mode && compat.supports_json_mode {
        body["format"] = json!("json");
    }
    let mut options = Map::new();
    if let Some(t) = temperature_to_send(compat, params.temperature) {
        options.insert("temperature".to_string(), json!(t));
    }
    if let Some(max) = params.max_tokens {
        options.insert("num_predict".to_string(), json!(max));
    }
    if !options.is_empty() {
        body["options"] = Value::Object(options);
    }
    apply_extra_body(&mut body, params.extra_body.as_ref());
    body
}

/// The first `limit` characters of `text`, with `…` when cut.
pub fn truncate_chars(text: &str, limit: usize) -> String {
    let mut chars = text.chars();
    let head: String = chars.by_ref().take(limit).collect();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_all(compat: &CompatFlags, chunks: &[&[u8]]) -> Vec<StreamEvent> {
        let mut decoder = StreamDecoder::new(compat);
        let mut events = Vec::new();
        for chunk in chunks {
            events.extend(decoder.push(chunk));
        }
        events.extend(decoder.finish());
        events
    }

    fn content(events: &[StreamEvent]) -> String {
        events
            .iter()
            .filter_map(|e| match e {
                StreamEvent::Content(t) => Some(t.as_str()),
                _ => None,
            })
            .collect()
    }

    fn reasoning(events: &[StreamEvent]) -> String {
        events
            .iter()
            .filter_map(|e| match e {
                StreamEvent::Reasoning(t) => Some(t.as_str()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn chinese_split_across_chunks_decodes_whole() {
        let body = "data: {\"choices\":[{\"delta\":{\"content\":\"你好，世界\"}}]}\n\ndata: [DONE]\n\n";
        let bytes = body.as_bytes();
        // Every possible split point, including inside each 3-byte character.
        for cut in 1..bytes.len() {
            let events = decode_all(&CompatFlags::default(), &[&bytes[..cut], &bytes[cut..]]);
            assert_eq!(content(&events), "你好，世界", "cut at {cut}");
            assert!(!content(&events).contains('\u{FFFD}'));
        }
    }

    #[test]
    fn error_inside_a_200_stream_is_an_event() {
        let body = b"data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\ndata: {\"error\":{\"message\":\"Upstream rate limited\",\"code\":429}}\n\n";
        let events = decode_all(&CompatFlags::default(), &[body]);
        assert_eq!(content(&events), "Hi");
        assert!(events.contains(&StreamEvent::Error("Upstream rate limited (429)".to_string())));
        // Ollama's NDJSON error and a plain string error.
        let events = decode_all(&CompatFlags::default(), &[b"{\"error\":\"model 'x' not found\"}\n"]);
        assert_eq!(events, vec![StreamEvent::Error("model 'x' not found".to_string())]);
        // `"error": null` in a normal chunk is not an error.
        let events = decode_all(&CompatFlags::default(), &[b"data: {\"error\":null,\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n"]);
        assert_eq!(events, vec![StreamEvent::Content("ok".into())]);
    }

    #[test]
    fn reasoning_fields_are_kept_apart() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"Let me think\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"reasoning\":\" more\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"Answer\"}}]}\n\n",
        );
        let events = decode_all(&CompatFlags::default(), &[body.as_bytes()]);
        assert_eq!(content(&events), "Answer");
        assert_eq!(reasoning(&events), "Let me think more");
        let off = CompatFlags { reasoning: ReasoningMode::Off, ..Default::default() };
        let events = decode_all(&off, &[body.as_bytes()]);
        assert_eq!((content(&events).as_str(), reasoning(&events).as_str()), ("Answer", ""));
        // Ollama thinking.
        let events = decode_all(&CompatFlags::default(), &[b"{\"message\":{\"role\":\"assistant\",\"thinking\":\"hmm\",\"content\":\"\"}}\n{\"message\":{\"content\":\"Yes\"},\"done\":true,\"prompt_eval_count\":5,\"eval_count\":2}\n"]);
        assert_eq!((content(&events).as_str(), reasoning(&events).as_str()), ("Yes", "hmm"));
        assert!(events.contains(&StreamEvent::Usage { prompt_tokens: 5, completion_tokens: 2 }));
        assert_eq!(events.last(), Some(&StreamEvent::Done));
    }

    #[test]
    fn whole_json_answer_when_the_server_ignores_stream() {
        let compact = br#"{"id":"x","choices":[{"message":{"role":"assistant","content":"Full answer"}}],"usage":{"prompt_tokens":3,"completion_tokens":2}}"#;
        let events = decode_all(&CompatFlags::default(), &[compact]);
        assert_eq!(content(&events), "Full answer");
        assert!(events.contains(&StreamEvent::Usage { prompt_tokens: 3, completion_tokens: 2 }));
        let pretty = b"{\n  \"id\": \"x\",\n  \"choices\": [\n    {\"message\": {\"content\": \"Pretty \xe4\xbd\xa0\"}}\n  ]\n}\n";
        let events = decode_all(&CompatFlags::default(), &[&pretty[..20], &pretty[20..]]);
        assert_eq!(content(&events), "Pretty 你");
        // A pretty-printed error body.
        let events = decode_all(&CompatFlags::default(), &[b"{\n \"error\": {\"message\": \"bad\"}\n}"]);
        assert_eq!(events, vec![StreamEvent::Error("bad".into())]);
    }

    #[test]
    fn sse_noise_is_skipped() {
        let body = b": keep-alive\n\nevent: message\nid: 1\nretry: 100\ndata: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\n\ndata: [DONE]\n";
        let events = decode_all(&CompatFlags::default(), &[body]);
        assert_eq!(events, vec![StreamEvent::Content("a".into()), StreamEvent::Done]);
    }

    #[test]
    fn think_tags_are_stripped_even_when_split() {
        let tokens = ["<th", "ink>", "step 1", "</thi", "nk>", "\n\n", "Final", " answer"];
        let mut stripper = ThinkStripper::new(true);
        let mut events = Vec::new();
        for t in tokens {
            events.extend(stripper.push(t));
        }
        events.extend(stripper.finish());
        assert_eq!(content(&events), "Final answer");
        assert_eq!(reasoning(&events), "step 1");

        // Not at the start: left alone.
        let mut stripper = ThinkStripper::new(true);
        let mut events = stripper.push("Use <think> tags");
        events.extend(stripper.finish());
        assert_eq!(content(&events), "Use <think> tags");

        // Disabled.
        let mut stripper = ThinkStripper::new(false);
        assert_eq!(content(&stripper.push("<think>x</think>y")), "<think>x</think>y");

        // A short answer that only looks like the start of the tag.
        let mut stripper = ThinkStripper::new(true);
        let mut events = stripper.push("<");
        events.extend(stripper.finish());
        assert_eq!(content(&events), "<");

        // Never closed: everything was reasoning.
        let mut stripper = ThinkStripper::new(true);
        let mut events = stripper.push("<think>still thinking");
        events.extend(stripper.finish());
        assert_eq!((content(&events).as_str(), reasoning(&events).as_str()), ("", "still thinking"));

        // Multi-byte text right before a partial closing tag.
        let mut stripper = ThinkStripper::new(true);
        let mut events = stripper.push("<think>想一想</");
        events.extend(stripper.push("think>好"));
        events.extend(stripper.finish());
        assert_eq!((content(&events).as_str(), reasoning(&events).as_str()), ("好", "想一想"));
    }

    #[test]
    fn think_stripping_runs_inside_the_decoder() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"<think>\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"plan\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"</think>Done\"}}]}\n\n",
        );
        let events = decode_all(&CompatFlags::default(), &[body.as_bytes()]);
        assert_eq!((content(&events).as_str(), reasoning(&events).as_str()), ("Done", "plan"));
    }

    #[test]
    fn merge_patch_follows_rfc_7396() {
        let mut target = json!({"a": 1, "b": {"c": 2, "d": 3}, "e": [1]});
        merge_patch(&mut target, &json!({"a": null, "b": {"c": 9, "x": true}, "e": {"k": 1}}));
        assert_eq!(target, json!({"b": {"c": 9, "d": 3, "x": true}, "e": {"k": 1}}));
    }

    #[test]
    fn params_merge_from_low_to_high() {
        let conn = RouteParams { temperature: Some(0.9), max_tokens: Some(100), extra_body: Some(json!({"a": 1, "nested": {"x": 1}}).as_object().unwrap().clone()) };
        let caller = RouteParams { temperature: Some(0.3), ..Default::default() };
        let route = RouteParams { max_tokens: Some(50), extra_body: Some(json!({"nested": {"y": 2}, "a": null}).as_object().unwrap().clone()), ..Default::default() };
        let merged = merge_params([&conn, &caller, &route]);
        assert_eq!(merged.temperature, Some(0.3));
        assert_eq!(merged.max_tokens, Some(50));
        assert_eq!(merged.extra_body, Some(json!({"nested": {"x": 1, "y": 2}})));
    }

    #[test]
    fn openai_body_respects_compat_switches() {
        let messages = vec![LLMMessage { role: "user".into(), content: "hi".into() }];
        let params = EffectiveParams {
            temperature: Some(0.2),
            max_tokens: Some(64),
            extra_body: Some(json!({"model": "evil", "stream": false, "thinking": {"type": "disabled"}})),
            ..Default::default()
        };
        let body = openai_chat_body("m", &messages, &params, &CompatFlags::default());
        assert_eq!(body["model"], "m");
        assert_eq!(body["stream"], true);
        assert_eq!(body["temperature"], 0.2);
        assert_eq!(body["max_tokens"], 64);
        assert_eq!(body["thinking"], json!({"type": "disabled"}));
        assert!(body.get("stream_options").is_none());

        let compat = CompatFlags {
            temperature: TemperatureMode::Omit,
            max_tokens_field: MaxTokensField::MaxCompletionTokens,
            stream_usage: true,
            ..Default::default()
        };
        let body = openai_chat_body("m", &messages, &params, &compat);
        assert!(body.get("temperature").is_none());
        assert!(body.get("max_tokens").is_none());
        assert_eq!(body["max_completion_tokens"], 64);
        assert_eq!(body["stream_options"], json!({"include_usage": true}));

        let fixed = CompatFlags { temperature: TemperatureMode::Fixed, fixed_temperature: Some(1.0), max_tokens_field: MaxTokensField::Omit, ..Default::default() };
        let body = openai_chat_body("m", &messages, &params, &fixed);
        assert_eq!(body["temperature"], 1.0);
        assert!(body.get("max_tokens").is_none() && body.get("max_completion_tokens").is_none());
    }

    #[test]
    fn ollama_body_uses_options_and_keep_alive() {
        let messages = vec![LLMMessage { role: "user".into(), content: "hi".into() }];
        let params = EffectiveParams { temperature: Some(0.5), max_tokens: Some(10), extra_body: Some(json!({"options": {"num_ctx": 8192}, "think": false})), ..Default::default() };
        let body = ollama_chat_body("llama3", &messages, &params, &CompatFlags::default());
        assert_eq!(body["keep_alive"], "30m");
        assert_eq!(body["options"], json!({"temperature": 0.5, "num_predict": 10, "num_ctx": 8192}));
        assert_eq!(body["think"], false);
        let body = ollama_chat_body("llama3", &messages, &EffectiveParams::default(), &CompatFlags { keep_alive: Some("1h".into()), ..Default::default() });
        assert_eq!(body["keep_alive"], "1h");
        assert!(body.get("options").is_none());
    }

    #[test]
    fn truncation_counts_characters() {
        assert_eq!(truncate_chars("你好世界", 2), "你好…");
        assert_eq!(truncate_chars("abc", 3), "abc");
    }
}
