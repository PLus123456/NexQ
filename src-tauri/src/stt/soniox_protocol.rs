// NexQ Plus: Soniox real-time protocol (message parsing, sentence assembly,
// translation alignment, error classification). Pure functions, no I/O.
//
// A session sends `build_start_message` as its first text frame (the API key
// goes in the handshake header, never in that message), then 16 kHz mono
// s16le audio as binary frames, `KEEPALIVE_MESSAGE` while it has no audio to
// send, `FINALIZE_MESSAGE` when `Assembler::wants_finalize`, and an empty text
// frame `""` to end the stream. Each text frame from Soniox goes through
// `parse_server_message`: errors to `classify_error` and `Backoff`, tokens to
// the `Assembler`, which turns them into one line per sentence plus its
// translation.
//
// Token stream: each message carries its final tokens once (appended) and the
// complete non-final tail (it replaces the previous tail, even with nothing).
// With translation on, original and translation tokens share the stream: a
// stretch of original, then its translation, then more original. They are
// matched by that order (translation tokens have no timestamps). One-way
// translates everything into one language; two-way translates each sentence
// into the other language of a pair (a sentence in neither isn't translated).

use std::time::{Duration, Instant};

use serde::{Deserialize, Deserializer};
use serde_json::{json, Map, Value};

/// Audio Soniox gets: 16 kHz, mono, PCM s16le.
pub const SAMPLE_RATE: u32 = 16_000;

/// Keeps the session open while no audio is being sent.
pub const KEEPALIVE_MESSAGE: &str = r#"{"type":"keepalive"}"#;

/// Finalizes everything sent so far; Soniox answers with a `<fin>` token.
/// (Ending the stream is different: an empty text frame `""`.)
pub const FINALIZE_MESSAGE: &str = r#"{"type":"finalize"}"#;

// ── Server messages ─────────────────────────────────────────────────────────

/// One token of a Soniox result. Any field may be missing; a field of an
/// unexpected type reads as missing instead of failing the whole message.
#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(default)]
pub struct Token {
    /// Subword with its own leading space (" are"): concatenated as is.
    #[serde(deserialize_with = "de_text")]
    pub text: String,
    /// Position in the audio sent; translation tokens have none.
    #[serde(deserialize_with = "de_u64")]
    pub start_ms: Option<u64>,
    #[serde(deserialize_with = "de_u64")]
    pub end_ms: Option<u64>,
    /// 0–1.
    #[serde(deserialize_with = "de_f32")]
    pub confidence: Option<f32>,
    #[serde(deserialize_with = "de_bool")]
    pub is_final: bool,
    /// Diarization label; Soniox sends "1" or 1.
    #[serde(deserialize_with = "de_string")]
    pub speaker: Option<String>,
    #[serde(deserialize_with = "de_string")]
    pub language: Option<String>,
    /// "original" | "translation" | "none" (won't be translated); only with translation on.
    #[serde(deserialize_with = "de_string")]
    pub translation_status: Option<String>,
    /// Language of the text a translation token translates.
    #[serde(deserialize_with = "de_string")]
    pub source_language: Option<String>,
}

impl Token {
    pub fn is_translation(&self) -> bool {
        self.translation_status.as_deref() == Some("translation")
    }

    /// `<end>`: the speaker finished an utterance.
    pub fn is_endpoint(&self) -> bool {
        self.text.trim() == "<end>"
    }

    /// `<fin>`: Soniox finished a `FINALIZE_MESSAGE`.
    pub fn is_fin(&self) -> bool {
        self.text.trim() == "<fin>"
    }

    /// A final `<end>` / `<fin>` on the original side: the sentence is over.
    /// (One on the translation side, or not final, ends nothing.)
    pub fn ends_sentence(&self) -> bool {
        self.is_final && !self.is_translation() && (self.is_endpoint() || self.is_fin())
    }

    /// Soniox won't translate this token.
    fn is_untranslated(&self) -> bool {
        self.translation_status.as_deref() == Some("none")
    }
}

/// Error frame; Soniox closes the socket right after it.
#[derive(Debug, Clone, PartialEq)]
pub struct SonioxError {
    /// HTTP-style status: 401, 429, 503…
    pub code: Option<u16>,
    /// "unauthenticated", "limit_exceeded"…; decides the retry before the code does.
    pub error_type: Option<String>,
    /// Soniox's explanation (the type or the code when it sent none).
    pub message: String,
    pub request_id: Option<String>,
}

/// One text frame from Soniox.
#[derive(Debug, Clone, PartialEq)]
pub enum ServerMessage {
    /// `finished` marks the last message of the stream.
    Tokens {
        tokens: Vec<Token>,
        final_audio_proc_ms: Option<u64>,
        total_audio_proc_ms: Option<u64>,
        finished: bool,
    },
    Error(SonioxError),
}

/// Reads one text frame from Soniox. Err for text that isn't a JSON object.
pub fn parse_server_message(text: &str) -> Result<ServerMessage, String> {
    let value: Value = serde_json::from_str(text).map_err(|e| format!("not JSON: {e}"))?;
    let Value::Object(obj) = value else {
        return Err("not a JSON object".to_string());
    };
    if let Some(err) = read_error(&obj) {
        return Ok(ServerMessage::Error(err));
    }
    // A token that isn't an object is skipped rather than losing the message.
    let tokens = match obj.get("tokens") {
        Some(Value::Array(items)) => items.iter().filter_map(|t| Token::deserialize(t).ok()).collect(),
        _ => Vec::new(),
    };
    Ok(ServerMessage::Tokens {
        tokens,
        final_audio_proc_ms: obj.get("final_audio_proc_ms").and_then(read_u64),
        total_audio_proc_ms: obj.get("total_audio_proc_ms").and_then(read_u64),
        finished: obj.get("finished").and_then(Value::as_bool).unwrap_or(false),
    })
}

/// The error of a frame with an `error_code`, `error_type` or `error_message`.
fn read_error(obj: &Map<String, Value>) -> Option<SonioxError> {
    let has_code = obj.get("error_code").is_some_and(|v| !v.is_null());
    let code = obj.get("error_code").and_then(read_u64).and_then(|c| u16::try_from(c).ok());
    let error_type = obj.get("error_type").and_then(read_string).filter(|s| !s.trim().is_empty());
    let message = obj.get("error_message").and_then(read_string).filter(|s| !s.trim().is_empty());
    if !has_code && error_type.is_none() && message.is_none() {
        return None;
    }
    let message = message.or_else(|| error_type.clone()).unwrap_or_else(|| match code {
        Some(code) => format!("error {code}"),
        None => "unknown error".to_string(),
    });
    Some(SonioxError { code, error_type, message, request_id: obj.get("request_id").and_then(read_string) })
}

/// A number, or a string of digits.
fn read_u64(v: &Value) -> Option<u64> {
    match v {
        Value::Number(n) => n.as_u64().or_else(|| n.as_f64().filter(|f| *f >= 0.0).map(|f| f.round() as u64)),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

/// A string, or a number as written ("1" for 1).
fn read_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn de_text<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(read_string(&Value::deserialize(d)?).unwrap_or_default())
}

fn de_string<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(read_string(&Value::deserialize(d)?))
}

fn de_u64<'de, D: Deserializer<'de>>(d: D) -> Result<Option<u64>, D::Error> {
    Ok(read_u64(&Value::deserialize(d)?))
}

fn de_f32<'de, D: Deserializer<'de>>(d: D) -> Result<Option<f32>, D::Error> {
    Ok(Value::deserialize(d)?.as_f64().map(|f| f as f32))
}

fn de_bool<'de, D: Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    Ok(Value::deserialize(d)?.as_bool().unwrap_or(false))
}

// ── Start message ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum TranslationParams {
    /// Everything said goes into one language.
    OneWay { target_language: String },
    /// Each of two languages goes into the other.
    TwoWay { language_a: String, language_b: String },
}

/// What a session asks for in its start message.
#[derive(Debug, Clone, Default)]
pub struct StartParams {
    pub model: String,
    /// Language tags ("zh-CN", "en"); sent as unique two-letter codes.
    pub language_hints: Vec<String>,
    /// Keep the output to the hinted languages (sent only with hints).
    pub language_hints_strict: bool,
    pub enable_speaker_diarization: bool,
    /// Clamped to 500–3000 ms; None = Soniox's default.
    pub max_endpoint_delay_ms: Option<u32>,
    /// How readily a sentence ends, clamped to -1.0–1.0 (higher = sooner);
    /// None = Soniox's default (0.0). Only `stt-rt-v5` takes it.
    pub endpoint_sensitivity: Option<f32>,
    /// How much the wait before an endpoint is cut, clamped to 0–3; None =
    /// Soniox's default (0). Only `stt-rt-v5` takes it.
    pub endpoint_latency_adjustment_level: Option<u8>,
    pub translation: Option<TranslationParams>,
    /// For Soniox usage logs.
    pub client_reference_id: Option<String>,
    /// Extra fields merged in last (forward compatibility).
    pub extra: Option<Map<String, Value>>,
}

/// Fields `extra` can't set: the audio must stay what the session sends.
const AUDIO_FIELDS: [&str; 3] = ["audio_format", "sample_rate", "num_channels"];

/// Longest `client_reference_id`. Counted in bytes, so it fits however Soniox counts.
const MAX_REFERENCE_ID_BYTES: usize = 256;

/// The first text frame of a session. Always pcm_s16le at 16 kHz mono with
/// language identification and endpoint detection on. Hints become unique
/// two-letter codes in their order (strict only with hints), the endpoint delay
/// is clamped to 500–3000 ms, the v5 endpoint settings go in only when set
/// (older models answer 400 to them) and clamped to their ranges, translation
/// codes become two-letter (translation is left out when one is unusable, or
/// when a two-way pair is one language twice), the reference id is cut to 256
/// bytes on a character boundary. `extra` adds or overrides fields last
/// (`null` removes one) but never sets `api_key` nor changes the audio format.
pub fn build_start_message(p: &StartParams) -> Value {
    let mut msg = Map::new();
    msg.insert("model".into(), json!(p.model.trim()));
    msg.insert("audio_format".into(), json!("pcm_s16le"));
    msg.insert("sample_rate".into(), json!(SAMPLE_RATE));
    msg.insert("num_channels".into(), json!(1));
    msg.insert("enable_language_identification".into(), json!(true));
    msg.insert("enable_endpoint_detection".into(), json!(true));
    msg.insert("enable_speaker_diarization".into(), json!(p.enable_speaker_diarization));

    let mut hints: Vec<String> = Vec::new();
    for code in p.language_hints.iter().filter_map(|tag| iso639_1(tag)) {
        if !hints.contains(&code) {
            hints.push(code);
        }
    }
    if !hints.is_empty() {
        if p.language_hints_strict {
            msg.insert("language_hints_strict".into(), json!(true));
        }
        msg.insert("language_hints".into(), json!(hints));
    }
    if let Some(ms) = p.max_endpoint_delay_ms {
        msg.insert("max_endpoint_delay_ms".into(), json!(ms.clamp(500, 3000)));
    }
    if let Some(sensitivity) = p.endpoint_sensitivity.filter(|s| s.is_finite()) {
        msg.insert("endpoint_sensitivity".into(), json!(hundredths(sensitivity.clamp(-1.0, 1.0))));
    }
    if let Some(level) = p.endpoint_latency_adjustment_level {
        msg.insert("endpoint_latency_adjustment_level".into(), json!(level.min(3)));
    }
    if let Some(translation) = p.translation.as_ref().and_then(translation_config) {
        msg.insert("translation".into(), translation);
    }
    if let Some(id) = p.client_reference_id.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
        msg.insert("client_reference_id".into(), json!(cut_at_char_boundary(id, MAX_REFERENCE_ID_BYTES)));
    }
    for (key, value) in p.extra.iter().flatten() {
        if key.eq_ignore_ascii_case("api_key") || AUDIO_FIELDS.contains(&key.as_str()) {
            continue;
        }
        if value.is_null() {
            msg.remove(key);
        } else {
            msg.insert(key.clone(), value.clone());
        }
    }
    Value::Object(msg)
}

/// `translation` object with two-letter codes; None when a code is unusable
/// or a two-way pair names one language twice.
fn translation_config(t: &TranslationParams) -> Option<Value> {
    match t {
        TranslationParams::OneWay { target_language } => {
            let target = iso639_1(target_language)?;
            Some(json!({ "type": "one_way", "target_language": target }))
        }
        TranslationParams::TwoWay { language_a, language_b } => {
            let (a, b) = two_way_pair(language_a, language_b)?;
            Some(json!({ "type": "two_way", "language_a": a, "language_b": b }))
        }
    }
}

/// Two different two-letter codes, or None.
fn two_way_pair(a: &str, b: &str) -> Option<(String, String)> {
    let (a, b) = (iso639_1(a)?, iso639_1(b)?);
    (a != b).then_some((a, b))
}

/// An f32 setting as Soniox gets it: 0.3, not 0.30000001192092896.
fn hundredths(value: f32) -> f64 {
    (f64::from(value) * 100.0).round() / 100.0
}

/// Two-letter code of a language tag: "zh-CN" → "zh", "EN" → "en". None for
/// "auto", three-letter codes and malformed values.
fn iso639_1(tag: &str) -> Option<String> {
    let primary = tag.trim().split(['-', '_']).next().unwrap_or("");
    (primary.len() == 2 && primary.chars().all(|c| c.is_ascii_alphabetic())).then(|| primary.to_ascii_lowercase())
}

/// At most `max` bytes of `s`, cut between characters.
fn cut_at_char_boundary(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

// ── Errors and reconnects ───────────────────────────────────────────────────

/// What to do after a session ended badly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetryClass {
    /// Reconnect with backoff.
    Retry,
    /// Reconnect, waiting at least 20 s.
    RateLimited,
    /// The session reached its maximum duration: open a new one right away.
    NewSessionNow,
    /// Retrying won't help (key, balance, request): show the reason.
    Fatal,
}

/// Retry class of an error frame: by `error_type`, else by `code`. An error
/// Soniox doesn't document is retried (the backoff bounds it).
pub fn classify_error(err: &SonioxError) -> RetryClass {
    match err.error_type.as_deref() {
        Some("request_timeout" | "internal_error" | "service_unavailable") => RetryClass::Retry,
        Some("limit_exceeded" | "max_concurrent_connections_reached") => RetryClass::RateLimited,
        Some("max_duration_reached") => RetryClass::NewSessionNow,
        Some(
            "invalid_request"
            | "model_not_available"
            | "unauthenticated"
            | "organization_balance_exhausted"
            | "organization_monthly_budget_exhausted"
            | "project_monthly_budget_exhausted"
            | "permission_denied"
            | "temp_api_key_session_expired",
        ) => RetryClass::Fatal,
        _ => match err.code {
            Some(408) => RetryClass::Retry,
            Some(413) => RetryClass::NewSessionNow,
            Some(429) => RetryClass::RateLimited,
            Some(400..=499) => RetryClass::Fatal,
            _ => RetryClass::Retry,
        },
    }
}

/// Socket closed without an error frame: `code` = WebSocket close code (None = no close frame / I/O error).
/// 1000 without a preceding error frame and before we asked to stop counts as Retry too.
pub fn classify_close(code: Option<u16>) -> RetryClass {
    match code {
        // "Try again later".
        Some(1013) => RetryClass::RateLimited,
        // What we sent was refused (protocol error, unsupported or invalid
        // data, policy, too big): a new connection would send the same.
        Some(1002 | 1003 | 1007 | 1008 | 1009) => RetryClass::Fatal,
        _ => RetryClass::Retry,
    }
}

/// Reconnect attempts before giving up.
const MAX_ATTEMPTS: u32 = 5;

/// A connection up this long was healthy: the attempts start over.
const STABLE_CONNECTION: Duration = Duration::from_secs(8);

/// Shortest wait after a rate limit.
const RATE_LIMIT_WAIT: Duration = Duration::from_secs(20);

/// Delay before attempt `n` (1-based): 1.5 s × 1.5^(n−1) = 1.5, 2.25, 3.375, 5.06, 7.59 s.
fn backoff_delay(attempt: u32) -> Duration {
    let n = attempt.clamp(1, MAX_ATTEMPTS) - 1;
    Duration::from_nanos(1_500_000_000 * 3u64.pow(n) / 2u64.pow(n))
}

/// Reconnect delays for one party's session: at most 5 attempts; a connection
/// that stayed up 8 s starts the count over.
#[derive(Debug, Default)]
pub struct Backoff {
    attempts: u32,
    connected_at: Option<Instant>,
}

impl Backoff {
    pub fn new() -> Self {
        Self::default()
    }

    /// The socket is open.
    pub fn on_connected(&mut self, now: Instant) {
        self.connected_at = Some(now);
    }

    /// Delay before the next attempt, or None = give up (Fatal, or attempts used up).
    /// Rate limits wait max(20 s, backoff). A new session after `max_duration_reached`
    /// goes at once and uses no attempt; on a connection that lasted under 8 s that
    /// error can't be real, so it's retried like any other (no reconnect spin).
    pub fn next_delay(&mut self, class: RetryClass, now: Instant) -> Option<Duration> {
        let stable = self.connected_at.take().is_some_and(|at| now.saturating_duration_since(at) >= STABLE_CONNECTION);
        if stable {
            self.attempts = 0;
        }
        let class = match class {
            RetryClass::Fatal => return None,
            RetryClass::NewSessionNow if stable => return Some(Duration::ZERO),
            RetryClass::NewSessionNow => RetryClass::Retry,
            other => other,
        };
        if self.attempts >= MAX_ATTEMPTS {
            return None;
        }
        self.attempts += 1;
        let delay = backoff_delay(self.attempts);
        Some(if class == RetryClass::RateLimited { delay.max(RATE_LIMIT_WAIT) } else { delay })
    }

    /// Attempts used since the last stable connection.
    pub fn attempts(&self) -> u32 {
        self.attempts
    }
}

// ── Sentence assembly ───────────────────────────────────────────────────────

/// A finalize request goes out again after this long when no `<fin>` ended the sentence.
const REFINALIZE_AFTER: Duration = Duration::from_secs(5);

/// Confidence of a line none of whose final tokens carried one.
const DEFAULT_CONFIDENCE: f32 = 0.9;

#[derive(Debug, Clone)]
pub struct AssemblerConfig {
    /// One-way translation target (two-letter); None = translation not configured.
    pub target_language: Option<String>,
    /// Two-way translation pair (two-letter, different): each sentence goes into
    /// the other language of the pair than its own, a sentence in neither gets
    /// no translation. Takes the place of `target_language`; None = one-way.
    pub two_way: Option<(String, String)>,
    /// An archived sentence's translation is final after this long without new translation (default 3 s).
    pub translation_settle: Duration,
    /// At most one translation update per sentence per this interval (default 250 ms).
    pub translation_min_interval: Duration,
    /// Ask for a manual finalize when a sentence has run this long without an endpoint (default 30 s).
    pub finalize_after: Duration,
}

impl Default for AssemblerConfig {
    fn default() -> Self {
        Self {
            target_language: None,
            two_way: None,
            translation_settle: Duration::from_secs(3),
            translation_min_interval: Duration::from_millis(250),
            finalize_after: Duration::from_secs(30),
        }
    }
}

impl AssemblerConfig {
    /// Translation is configured (one-way or two-way).
    fn translates(&self) -> bool {
        self.target_language.is_some() || self.two_way.is_some()
    }

    /// The language `sentence` is translated into: the one-way target, or the
    /// other language of the two-way pair than the sentence's (None while its
    /// language is unknown, and for a sentence in neither language).
    fn target_of(&self, sentence: &Sentence) -> Option<&str> {
        let Some((a, b)) = &self.two_way else {
            return self.target_language.as_deref();
        };
        let spoken = iso639_1(&sentence.source_language()?)?;
        if spoken == *a {
            Some(b)
        } else if spoken == *b {
            Some(a)
        } else {
            None
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum AssemblerEvent {
    Transcript(SentenceUpdate),
    Translation(TranslationUpdate),
}

/// One transcript line: partial updates, then one final.
#[derive(Debug, Clone, PartialEq)]
pub struct SentenceUpdate {
    /// 1, 2, 3… per assembler (per connection).
    pub seq: u64,
    pub text: String,
    pub is_final: bool,
    /// Span of its tokens in the audio sent on this connection.
    pub start_ms: Option<u64>,
    pub end_ms: Option<u64>,
    /// Mean of its final tokens (0.9 when none had one).
    pub confidence: f32,
    /// Most frequent among its tokens (a tie goes to the first seen).
    pub speaker: Option<String>,
    pub language: Option<String>,
}

/// Translation of the line with the same `seq`: partial updates (throttled),
/// then one final. A final with empty `translated_text` withdraws a partial
/// shown earlier (the translation turned out empty or an echo).
#[derive(Debug, Clone, PartialEq)]
pub struct TranslationUpdate {
    pub seq: u64,
    /// The line's final original text so far.
    pub original_text: String,
    pub translated_text: String,
    pub source_language: Option<String>,
    /// Two-letter: the one-way target, or with two-way the other language of
    /// the pair than this sentence's.
    pub target_language: String,
    pub is_final: bool,
}

/// One sentence: its original and translation tokens, and what was last shown.
#[derive(Debug, Default)]
struct Sentence {
    seq: u64,
    finals: Vec<Token>,
    tail: Vec<Token>,
    tr_finals: Vec<Token>,
    tr_tail: Vec<Token>,
    /// When its first original text arrived (finalize timer).
    started_at: Option<Instant>,
    /// When its last translation token arrived.
    translated_at: Option<Instant>,
    /// Set when archived: the final line and when it ended.
    final_text: Option<String>,
    archived_at: Option<Instant>,
    /// Text of the last partial line / translation sent.
    shown: String,
    tr_shown: String,
    tr_shown_at: Option<Instant>,
    /// Target of the last partial translation sent: its final goes there even
    /// if the sentence's language no longer picks one (two-way).
    tr_target: Option<String>,
}

impl Sentence {
    fn new(seq: u64) -> Self {
        Self { seq, ..Self::default() }
    }

    fn originals(&self) -> impl Iterator<Item = &Token> {
        self.finals.iter().chain(&self.tail)
    }

    fn translations(&self) -> impl Iterator<Item = &Token> {
        self.tr_finals.iter().chain(&self.tr_tail)
    }

    /// Finals + tail, untrimmed.
    fn text(&self) -> String {
        self.originals().map(|t| t.text.as_str()).collect()
    }

    fn has_text(&self) -> bool {
        self.originals().any(|t| !t.text.trim().is_empty())
    }

    fn translation(&self) -> String {
        self.translations().map(|t| t.text.as_str()).collect()
    }

    /// Every original token is marked "none": no translation will come.
    fn untranslated(&self) -> bool {
        self.originals().next().is_some() && self.originals().all(Token::is_untranslated)
    }

    fn language(&self) -> Option<String> {
        most_frequent(self.originals().filter_map(|t| t.language.as_deref()))
    }

    /// The language it was said in: as its translation names it, else as recognized.
    fn source_language(&self) -> Option<String> {
        most_frequent(self.translations().filter_map(|t| t.source_language.as_deref())).or_else(|| self.language())
    }

    fn update(&self, is_final: bool) -> SentenceUpdate {
        let confidences: Vec<f32> = self.finals.iter().filter_map(|t| t.confidence).collect();
        let confidence = if confidences.is_empty() {
            DEFAULT_CONFIDENCE
        } else {
            confidences.iter().sum::<f32>() / confidences.len() as f32
        };
        SentenceUpdate {
            seq: self.seq,
            text: self.text().trim().to_string(),
            is_final,
            start_ms: self.originals().filter_map(|t| t.start_ms).min(),
            end_ms: self.originals().filter_map(|t| t.end_ms).max(),
            confidence,
            speaker: most_frequent(self.originals().filter_map(|t| t.speaker.as_deref())),
            language: self.language(),
        }
    }

    fn translation_update(&self, target: &str, translated: &str, is_final: bool) -> TranslationUpdate {
        let original = || self.finals.iter().map(|t| t.text.as_str()).collect::<String>().trim().to_string();
        TranslationUpdate {
            seq: self.seq,
            original_text: self.final_text.clone().unwrap_or_else(original),
            translated_text: translated.to_string(),
            source_language: self.source_language(),
            target_language: target.to_string(),
            is_final,
        }
    }

    /// Partial translation when it changed, its line exists, the last one went
    /// out at least `min_interval` ago, and it can't be (the start of) an echo.
    fn translation_progress(
        &mut self,
        target: &str,
        min_interval: Duration,
        now: Instant,
    ) -> Option<TranslationUpdate> {
        if !self.has_text() {
            return None;
        }
        let translated = self.translation();
        let translated = translated.trim();
        if translated.is_empty() || translated == self.tr_shown {
            return None;
        }
        if self.tr_shown_at.is_some_and(|at| now.saturating_duration_since(at) < min_interval) {
            return None;
        }
        if may_be_echo(&self.text(), translated) {
            return None;
        }
        self.tr_shown = translated.to_string();
        self.tr_shown_at = Some(now);
        self.tr_target = Some(target.to_string());
        Some(self.translation_update(target, translated, false))
    }

    /// Final translation once no more can come: the text if worth showing,
    /// else an empty one when a partial went out, else nothing.
    fn settled_translation(&self, target: &str) -> Option<TranslationUpdate> {
        let translated = self.translation();
        let translated = translated.trim();
        // A sentence already in the target language with no translation falls under "empty".
        let worth_showing = self.has_text() && !translated.is_empty() && !is_echo(&self.text(), translated);
        if worth_showing {
            Some(self.translation_update(target, translated, true))
        } else if !self.tr_shown.is_empty() {
            Some(self.translation_update(target, "", true))
        } else {
            None
        }
    }
}

/// Turns token messages into sentence-level transcript and translation events.
///
/// A sentence runs until `<end>` / `<fin>`. Its translation may keep coming
/// after that (Soniox doesn't promise it arrives before the endpoint), so the
/// sentence is archived until its translation settles: when the next sentence's
/// first final original arrives (everything before it in the stream is done),
/// after `translation_settle` without translation, or at `flush`. With two-way,
/// each sentence's target follows the language it was said in.
#[derive(Debug)]
pub struct Assembler {
    cfg: AssemblerConfig,
    current: Sentence,
    /// The last ended sentence while its translation may still grow.
    archived: Option<Sentence>,
    finalize_sent_at: Option<Instant>,
}

impl Assembler {
    /// One per connection: lines are numbered from 1.
    pub fn new(mut cfg: AssemblerConfig) -> Self {
        cfg.target_language = cfg.target_language.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
        // A pair Soniox can't take translates nothing (the start message leaves it out too).
        cfg.two_way = cfg.two_way.and_then(|(a, b)| two_way_pair(&a, &b));
        Self { cfg, current: Sentence::new(1), archived: None, finalize_sent_at: None }
    }

    /// One token message: the lines it ends, the current line, then translation updates.
    pub fn on_tokens(&mut self, tokens: &[Token], now: Instant) -> Vec<AssemblerEvent> {
        let mut events = Vec::new();
        self.settle_if_quiet(now, &mut events);
        // Each message brings the complete non-final tails.
        self.current.tail.clear();
        self.current.tr_tail.clear();
        if let Some(archived) = &mut self.archived {
            archived.tr_tail.clear();
        }
        for token in tokens {
            if token.is_endpoint() || token.is_fin() {
                // Never text. One on the translation side, or not final, ends nothing.
                if token.ends_sentence() {
                    self.end_sentence(now, &mut events);
                }
            } else if token.is_translation() {
                self.push_translation(token, now);
            } else {
                self.push_original(token, now, &mut events);
            }
        }
        if !self.current.has_text() {
            self.current.started_at = None;
        }
        let text = self.current.text();
        let text = text.trim();
        if !text.is_empty() && text != self.current.shown {
            self.current.shown = text.to_string();
            events.push(AssemblerEvent::Transcript(self.current.update(false)));
        }
        self.emit_translations(now, &mut events);
        events
    }

    /// Call every ~250 ms: emits throttled translation updates and settles quiet archived sentences.
    pub fn tick(&mut self, now: Instant) -> Vec<AssemblerEvent> {
        let mut events = Vec::new();
        self.settle_if_quiet(now, &mut events);
        self.emit_translations(now, &mut events);
        events
    }

    /// True when the provider should send FINALIZE_MESSAGE now: the sentence has
    /// run `finalize_after` without an endpoint, and no finalize went out since it
    /// started (or the last one is 5 s old and the sentence still goes on).
    pub fn wants_finalize(&self, now: Instant) -> bool {
        let Some(started) = self.current.started_at else {
            return false;
        };
        if now.saturating_duration_since(started) < self.cfg.finalize_after {
            return false;
        }
        match self.finalize_sent_at {
            Some(sent) if sent >= started => now.saturating_duration_since(sent) >= REFINALIZE_AFTER,
            _ => true,
        }
    }

    /// The provider sent FINALIZE_MESSAGE.
    pub fn finalize_sent(&mut self, now: Instant) {
        self.finalize_sent_at = Some(now);
    }

    /// Stop / disconnect: final transcript for the current sentence (finals + tail) if it has text,
    /// then every pending translation as final. The assembler is empty afterwards.
    pub fn flush(&mut self, now: Instant) -> Vec<AssemblerEvent> {
        let mut events = Vec::new();
        self.end_sentence(now, &mut events);
        if let Some(last) = self.archived.take() {
            self.settle(last, &mut events);
        }
        self.finalize_sent_at = None;
        events
    }

    fn push_original(&mut self, token: &Token, now: Instant, events: &mut Vec<AssemblerEvent>) {
        let has_text = !token.text.trim().is_empty();
        if has_text && self.current.started_at.is_none() {
            self.current.started_at = Some(now);
        }
        if !token.is_final {
            self.current.tail.push(token.clone());
            return;
        }
        // The next sentence's original turned final: everything before it in
        // the stream, the archived sentence's translation included, is done.
        // (A non-final guess doesn't count: the translation may still precede it.)
        if has_text {
            if let Some(done) = self.archived.take() {
                self.settle(done, events);
            }
        }
        self.current.finals.push(token.clone());
    }

    /// A translation token belongs to the original text before it in the
    /// stream: the current sentence once it has original text (final, or a
    /// guess earlier in this message), else the archived sentence while its
    /// translation is open (late translation), else the current sentence.
    fn push_translation(&mut self, token: &Token, now: Instant) {
        if !self.cfg.translates() {
            return;
        }
        let into = match self.archived.as_mut() {
            Some(archived) if !self.current.has_text() => archived,
            _ => &mut self.current,
        };
        if token.is_final {
            into.tr_finals.push(token.clone());
        } else {
            into.tr_tail.push(token.clone());
        }
        into.translated_at = Some(now);
    }

    /// `<end>` / `<fin>`: the current sentence becomes final and gets archived
    /// for its translation; without text it just starts over (same seq).
    fn end_sentence(&mut self, now: Instant, events: &mut Vec<AssemblerEvent>) {
        if !self.current.has_text() {
            self.current = Sentence::new(self.current.seq);
            return;
        }
        let next = Sentence::new(self.current.seq + 1);
        let mut done = std::mem::replace(&mut self.current, next);
        let line = done.update(true);
        done.final_text = Some(line.text.clone());
        done.archived_at = Some(now);
        events.push(AssemblerEvent::Transcript(line));
        if let Some(older) = self.archived.take() {
            self.settle(older, events);
        }
        if self.cfg.translates() && !done.untranslated() {
            self.archived = Some(done);
        } else {
            self.settle(done, events);
        }
    }

    /// The archived sentence got no translation for `translation_settle`
    /// (counted from its endpoint or its last translation token).
    fn settle_if_quiet(&mut self, now: Instant, events: &mut Vec<AssemblerEvent>) {
        let settle = self.cfg.translation_settle;
        let quiet = self.archived.as_ref().is_some_and(|a| {
            let last = a.translated_at.max(a.archived_at).unwrap_or(now);
            now.saturating_duration_since(last) >= settle
        });
        if quiet {
            if let Some(done) = self.archived.take() {
                self.settle(done, events);
            }
        }
    }

    fn settle(&self, sentence: Sentence, events: &mut Vec<AssemblerEvent>) {
        if let Some(target) = self.cfg.target_of(&sentence).or(sentence.tr_target.as_deref()) {
            events.extend(sentence.settled_translation(target).map(AssemblerEvent::Translation));
        }
    }

    fn emit_translations(&mut self, now: Instant, events: &mut Vec<AssemblerEvent>) {
        let cfg = &self.cfg;
        for sentence in self.archived.iter_mut().chain(std::iter::once(&mut self.current)) {
            let Some(target) = cfg.target_of(sentence) else {
                continue;
            };
            if let Some(update) = sentence.translation_progress(target, cfg.translation_min_interval, now) {
                events.push(AssemblerEvent::Translation(update));
            }
        }
    }
}

/// Most frequent non-empty value; a tie goes to the one seen first.
fn most_frequent<'a>(values: impl Iterator<Item = &'a str>) -> Option<String> {
    let mut counts: Vec<(&str, usize)> = Vec::new();
    for value in values.map(str::trim).filter(|v| !v.is_empty()) {
        match counts.iter_mut().find(|(seen, _)| *seen == value) {
            Some((_, n)) => *n += 1,
            None => counts.push((value, 1)),
        }
    }
    let mut best: Option<(&str, usize)> = None;
    for (value, n) in counts {
        if best.is_none_or(|(_, top)| n > top) {
            best = Some((value, n));
        }
    }
    best.map(|(value, _)| value.to_string())
}

/// Letters and digits only, lowercase: whitespace, punctuation (CJK too) and symbols dropped.
fn echo_key(text: &str) -> String {
    text.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// The "translation" repeats the original (speech already in the target language).
fn is_echo(original: &str, translated: &str) -> bool {
    echo_key(original) == echo_key(translated)
}

/// The translation so far could still become an echo: hold it back.
fn may_be_echo(original: &str, translated: &str) -> bool {
    echo_key(original).starts_with(&echo_key(translated))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Parsing ────────────────────────────────────────────────────────────────

    fn tokens_of(text: &str) -> Vec<Token> {
        match parse_server_message(text).unwrap() {
            ServerMessage::Tokens { tokens, .. } => tokens,
            other => panic!("expected tokens, got {other:?}"),
        }
    }

    #[test]
    fn parse_reads_tokens_and_progress() {
        let text = r#"{"tokens":[
            {"text":"Hel","start_ms":600,"end_ms":720,"confidence":0.97,"is_final":true,"speaker":"1","language":"en","translation_status":"original"},
            {"text":"lo","start_ms":720,"end_ms":800,"confidence":0.5,"is_final":false}
        ],"final_audio_proc_ms":760,"total_audio_proc_ms":880}"#;
        let ServerMessage::Tokens { tokens, final_audio_proc_ms, total_audio_proc_ms, finished } =
            parse_server_message(text).unwrap()
        else {
            panic!("expected tokens");
        };
        assert_eq!(
            tokens[0],
            Token {
                text: "Hel".into(),
                start_ms: Some(600),
                end_ms: Some(720),
                confidence: Some(0.97),
                is_final: true,
                speaker: Some("1".into()),
                language: Some("en".into()),
                translation_status: Some("original".into()),
                source_language: None,
            }
        );
        assert_eq!((tokens[1].text.as_str(), tokens[1].is_final), ("lo", false));
        assert_eq!((final_audio_proc_ms, total_audio_proc_ms, finished), (Some(760), Some(880), false));
    }

    #[test]
    fn parse_reads_the_finished_flag() {
        let msg = parse_server_message(
            r#"{"tokens":[],"final_audio_proc_ms":1560,"total_audio_proc_ms":1560,"finished":true}"#,
        );
        assert_eq!(
            msg.unwrap(),
            ServerMessage::Tokens {
                tokens: vec![],
                final_audio_proc_ms: Some(1560),
                total_audio_proc_ms: Some(1560),
                finished: true
            }
        );
    }

    #[test]
    fn an_error_frame_becomes_an_error() {
        let text = r#"{"tokens":[],"error_code":401,"error_type":"unauthenticated","error_message":"Invalid API key.","more_info":"https://soniox.com/docs","request_id":"req-1"}"#;
        let ServerMessage::Error(err) = parse_server_message(text).unwrap() else {
            panic!("expected an error");
        };
        assert_eq!(
            err,
            SonioxError {
                code: Some(401),
                error_type: Some("unauthenticated".into()),
                message: "Invalid API key.".into(),
                request_id: Some("req-1".into()),
            }
        );
        // Without a message, the type (or the code) stands in.
        let ServerMessage::Error(err) =
            parse_server_message(r#"{"error_code":503,"error_type":"service_unavailable"}"#).unwrap()
        else {
            panic!("expected an error");
        };
        assert_eq!(err.message, "service_unavailable");
        let ServerMessage::Error(err) = parse_server_message(r#"{"error_code":"429"}"#).unwrap() else {
            panic!("expected an error");
        };
        assert_eq!((err.code, err.message.as_str()), (Some(429), "error 429"));
    }

    #[test]
    fn a_numeric_speaker_becomes_a_string() {
        let tokens = tokens_of(r#"{"tokens":[{"text":"a","speaker":1},{"text":"b","speaker":"2"}]}"#);
        assert_eq!(tokens[0].speaker.as_deref(), Some("1"));
        assert_eq!(tokens[1].speaker.as_deref(), Some("2"));
    }

    #[test]
    fn unknown_and_missing_fields_are_fine() {
        let text = r#"{"tokens":[{"text":" x","is_final":true,"brand_new":{"a":1}},{}],"something_else":[1,2]}"#;
        let tokens = tokens_of(text);
        assert_eq!((tokens[0].text.as_str(), tokens[0].is_final), (" x", true));
        assert_eq!(tokens[1], Token::default());
        assert_eq!(
            parse_server_message("{}").unwrap(),
            ServerMessage::Tokens {
                tokens: vec![],
                final_audio_proc_ms: None,
                total_audio_proc_ms: None,
                finished: false
            }
        );
    }

    #[test]
    fn a_malformed_field_or_token_does_not_lose_the_message() {
        let text = r#"{"tokens":[{"text":" hi","confidence":"high","start_ms":null,"is_final":true},"junk",{"text":"!","is_final":true}]}"#;
        let tokens = tokens_of(text);
        assert_eq!(tokens.len(), 2);
        assert_eq!((tokens[0].confidence, tokens[0].start_ms, tokens[0].is_final), (None, None, true));
        assert_eq!(tokens[1].text, "!");
    }

    #[test]
    fn text_that_is_not_a_json_object_is_an_error() {
        for text in ["", "hello", "[1,2]", "42", r#""tokens""#, "{\"tokens\":"] {
            assert!(parse_server_message(text).is_err(), "{text:?}");
        }
    }

    #[test]
    fn special_and_translation_tokens_are_recognized() {
        let token = |text: &str| Token { text: text.into(), ..Token::default() };
        assert!(token("<end>").is_endpoint());
        assert!(token("<fin>").is_fin());
        assert!(!token(" end").is_endpoint() && !token("<end>").is_fin());
        let status = |s: &str| Token { translation_status: Some(s.into()), ..Token::default() };
        assert!(status("translation").is_translation());
        assert!(!status("original").is_translation() && !status("none").is_translation());
    }

    // ── Start message ──────────────────────────────────────────────────────────

    fn params() -> StartParams {
        StartParams { model: "stt-rt-v5".into(), ..StartParams::default() }
    }

    #[test]
    fn the_start_message_always_has_the_audio_format_and_never_the_key() {
        assert_eq!(
            build_start_message(&params()),
            json!({
                "model": "stt-rt-v5",
                "audio_format": "pcm_s16le",
                "sample_rate": 16000,
                "num_channels": 1,
                "enable_language_identification": true,
                "enable_endpoint_detection": true,
                "enable_speaker_diarization": false,
            })
        );
        let msg = build_start_message(&StartParams { enable_speaker_diarization: true, ..params() });
        assert_eq!(msg["enable_speaker_diarization"], true);
    }

    #[test]
    fn hints_are_unique_two_letter_codes_and_strict_only_with_hints() {
        let tags = ["zh-CN", "EN", "zh", "auto", "en_US", "yue", ""].map(String::from).to_vec();
        let msg = build_start_message(&StartParams { language_hints: tags, language_hints_strict: true, ..params() });
        assert_eq!(msg["language_hints"], json!(["zh", "en"]));
        assert_eq!(msg["language_hints_strict"], true);

        let msg = build_start_message(&StartParams {
            language_hints: vec!["auto".into()],
            language_hints_strict: true,
            ..params()
        });
        assert!(msg.get("language_hints").is_none());
        assert!(msg.get("language_hints_strict").is_none(), "strict without hints would allow nothing");

        let msg = build_start_message(&StartParams { language_hints: vec!["ja".into()], ..params() });
        assert_eq!(msg["language_hints"], json!(["ja"]));
        assert!(msg.get("language_hints_strict").is_none());
    }

    #[test]
    fn the_endpoint_delay_is_clamped() {
        for (asked, sent) in [(100, 500), (1500, 1500), (9000, 3000)] {
            let msg = build_start_message(&StartParams { max_endpoint_delay_ms: Some(asked), ..params() });
            assert_eq!(msg["max_endpoint_delay_ms"], sent);
        }
        assert!(build_start_message(&params()).get("max_endpoint_delay_ms").is_none());
    }

    #[test]
    fn the_v5_endpoint_settings_go_in_only_when_set_and_within_range() {
        let msg = build_start_message(&params());
        assert!(msg.get("endpoint_sensitivity").is_none(), "older models answer 400 to it");
        assert!(msg.get("endpoint_latency_adjustment_level").is_none());

        for (asked, sent) in [(0.3, 0.3), (-0.7, -0.7), (0.0, 0.0), (1.0, 1.0), (1.5, 1.0), (-4.0, -1.0)] {
            let msg = build_start_message(&StartParams { endpoint_sensitivity: Some(asked), ..params() });
            assert_eq!(msg["endpoint_sensitivity"], json!(sent), "{asked}");
        }
        let msg = build_start_message(&StartParams { endpoint_sensitivity: Some(f32::NAN), ..params() });
        assert!(msg.get("endpoint_sensitivity").is_none());

        for (asked, sent) in [(0, 0), (2, 2), (3, 3), (9, 3)] {
            let msg = build_start_message(&StartParams { endpoint_latency_adjustment_level: Some(asked), ..params() });
            assert_eq!(msg["endpoint_latency_adjustment_level"], sent, "{asked}");
            assert!(msg.get("endpoint_sensitivity").is_none(), "each one on its own");
        }
    }

    #[test]
    fn translation_codes_are_sent_as_two_letter_codes() {
        let one_way = TranslationParams::OneWay { target_language: "zh-CN".into() };
        let msg = build_start_message(&StartParams { translation: Some(one_way), ..params() });
        assert_eq!(msg["translation"], json!({"type": "one_way", "target_language": "zh"}));

        let two_way = TranslationParams::TwoWay { language_a: "ZH".into(), language_b: "en_US".into() };
        let msg = build_start_message(&StartParams { translation: Some(two_way), ..params() });
        assert_eq!(msg["translation"], json!({"type": "two_way", "language_a": "zh", "language_b": "en"}));

        let unusable = TranslationParams::OneWay { target_language: "auto".into() };
        let msg = build_start_message(&StartParams { translation: Some(unusable), ..params() });
        assert!(msg.get("translation").is_none());

        // Two variants of Chinese are one language to Soniox: not a pair.
        let one_language = TranslationParams::TwoWay { language_a: "zh-CN".into(), language_b: "zh-TW".into() };
        let msg = build_start_message(&StartParams { translation: Some(one_language), ..params() });
        assert!(msg.get("translation").is_none());
    }

    #[test]
    fn the_reference_id_is_cut_to_256_bytes_between_characters() {
        let msg = build_start_message(&StartParams { client_reference_id: Some("x".repeat(300)), ..params() });
        assert_eq!(msg["client_reference_id"].as_str().unwrap().len(), 256);
        // 3-byte characters: the 86th would end at byte 258.
        let msg = build_start_message(&StartParams { client_reference_id: Some("会".repeat(100)), ..params() });
        assert_eq!(msg["client_reference_id"], "会".repeat(85));
        let msg = build_start_message(&StartParams { client_reference_id: Some("  ".into()), ..params() });
        assert!(msg.get("client_reference_id").is_none());
    }

    #[test]
    fn extra_fields_cannot_inject_the_key_or_change_the_audio_format() {
        let extra = json!({
            "api_key": "sk-live",
            "API_Key": "sk-2",
            "audio_format": "mp3",
            "sample_rate": 8000,
            "num_channels": 2,
            "model": "stt-rt-preview",
            "context": {"terms": ["NexQ"]},
            "enable_language_identification": null,
        });
        let msg = build_start_message(&StartParams { extra: extra.as_object().cloned(), ..params() });
        let obj = msg.as_object().unwrap();
        assert!(obj.keys().all(|k| !k.eq_ignore_ascii_case("api_key")), "{msg}");
        assert_eq!(
            (&msg["audio_format"], &msg["sample_rate"], &msg["num_channels"]),
            (&json!("pcm_s16le"), &json!(16000), &json!(1))
        );
        assert_eq!(msg["model"], "stt-rt-preview");
        assert_eq!(msg["context"], json!({"terms": ["NexQ"]}));
        assert!(obj.get("enable_language_identification").is_none(), "null removes a field");
    }

    // ── Retry classes and backoff ──────────────────────────────────────────────

    fn error(code: Option<u16>, kind: Option<&str>) -> SonioxError {
        SonioxError { code, error_type: kind.map(String::from), message: "m".into(), request_id: None }
    }

    #[test]
    fn errors_are_classified_by_type_first() {
        use RetryClass::*;
        let cases = [
            ("request_timeout", Retry),
            ("internal_error", Retry),
            ("service_unavailable", Retry),
            ("limit_exceeded", RateLimited),
            ("max_concurrent_connections_reached", RateLimited),
            ("max_duration_reached", NewSessionNow),
            ("invalid_request", Fatal),
            ("model_not_available", Fatal),
            ("unauthenticated", Fatal),
            ("organization_balance_exhausted", Fatal),
            ("organization_monthly_budget_exhausted", Fatal),
            ("project_monthly_budget_exhausted", Fatal),
            ("permission_denied", Fatal),
            ("temp_api_key_session_expired", Fatal),
        ];
        for (kind, class) in cases {
            assert_eq!(classify_error(&error(None, Some(kind))), class, "{kind}");
        }
        // The type wins over a code that says otherwise.
        assert_eq!(classify_error(&error(Some(500), Some("unauthenticated"))), Fatal);
    }

    #[test]
    fn errors_without_a_known_type_fall_back_to_the_code() {
        use RetryClass::*;
        let cases = [(408, Retry), (500, Retry), (502, Retry), (503, Retry), (429, RateLimited), (413, NewSessionNow)];
        for (code, class) in cases.into_iter().chain([400, 401, 402, 403, 404].map(|c| (c, Fatal))) {
            assert_eq!(classify_error(&error(Some(code), None)), class, "{code}");
            assert_eq!(classify_error(&error(Some(code), Some("brand_new_error"))), class, "{code}");
        }
        assert_eq!(classify_error(&error(None, None)), Retry, "unknown errors are retried, bounded by the backoff");
    }

    #[test]
    fn a_close_without_an_error_frame_is_retried() {
        use RetryClass::*;
        for code in [None, Some(1006), Some(1000), Some(1001), Some(1011), Some(1012), Some(4000)] {
            assert_eq!(classify_close(code), Retry, "{code:?}");
        }
        assert_eq!(classify_close(Some(1013)), RateLimited);
        assert_eq!(classify_close(Some(1008)), Fatal);
        assert_eq!(classify_close(Some(1007)), Fatal);
    }

    #[test]
    fn backoff_grows_by_half_and_gives_up_after_five_attempts() {
        let now = Instant::now();
        let mut b = Backoff::new();
        let delays: Vec<Duration> = (0..5).map(|_| b.next_delay(RetryClass::Retry, now).unwrap()).collect();
        let micros = [1_500_000, 2_250_000, 3_375_000, 5_062_500, 7_593_750].map(Duration::from_micros);
        assert_eq!(delays, micros);
        assert_eq!(b.attempts(), 5);
        assert_eq!(b.next_delay(RetryClass::Retry, now), None);
    }

    #[test]
    fn a_connection_that_stayed_up_8_seconds_resets_the_attempts() {
        let t0 = Instant::now();
        let at = |s: u64| t0 + Duration::from_secs(s);
        let mut b = Backoff::new();
        b.next_delay(RetryClass::Retry, at(0));
        b.next_delay(RetryClass::Retry, at(2));
        assert_eq!(b.attempts(), 2);
        // Up for 3 s only: still the same outage.
        b.on_connected(at(5));
        assert_eq!(b.next_delay(RetryClass::Retry, at(8)), Some(Duration::from_micros(3_375_000)));
        // Up for 8 s: a fresh start.
        b.on_connected(at(12));
        assert_eq!(b.next_delay(RetryClass::Retry, at(20)), Some(Duration::from_millis(1500)));
        assert_eq!(b.attempts(), 1);
    }

    #[test]
    fn rate_limits_wait_at_least_20_seconds() {
        let now = Instant::now();
        let mut b = Backoff::new();
        for _ in 0..5 {
            assert_eq!(b.next_delay(RetryClass::RateLimited, now), Some(Duration::from_secs(20)));
        }
        assert_eq!(b.next_delay(RetryClass::RateLimited, now), None);
    }

    #[test]
    fn a_new_session_starts_at_once_without_using_an_attempt() {
        let t0 = Instant::now();
        let at = |s: u64| t0 + Duration::from_secs(s);
        let mut b = Backoff::new();
        b.on_connected(at(0));
        assert_eq!(b.next_delay(RetryClass::NewSessionNow, at(3_600)), Some(Duration::ZERO));
        assert_eq!(b.attempts(), 0);
        b.on_connected(at(3_600));
        assert_eq!(b.next_delay(RetryClass::NewSessionNow, at(7_200)), Some(Duration::ZERO));
        assert_eq!(b.attempts(), 0);
        // "Maximum duration" a second after connecting: a plain retry, not a spin.
        b.on_connected(at(7_200));
        assert_eq!(b.next_delay(RetryClass::NewSessionNow, at(7_201)), Some(Duration::from_millis(1500)));
        assert_eq!(b.attempts(), 1);
    }

    #[test]
    fn a_fatal_error_gives_up_at_once() {
        let now = Instant::now();
        let mut b = Backoff::new();
        b.on_connected(now);
        assert_eq!(b.next_delay(RetryClass::Fatal, now + Duration::from_secs(60)), None);
        assert_eq!(b.attempts(), 0);
    }

    // ── Assembly ───────────────────────────────────────────────────────────────

    /// Final original token.
    fn orig(text: &str) -> Token {
        Token { text: text.into(), is_final: true, ..Token::default() }
    }

    /// Non-final original token.
    fn orig_tail(text: &str) -> Token {
        Token { text: text.into(), ..Token::default() }
    }

    /// Final translation token.
    fn trans(text: &str) -> Token {
        Token { translation_status: Some("translation".into()), ..orig(text) }
    }

    /// Non-final translation token.
    fn trans_tail(text: &str) -> Token {
        Token { translation_status: Some("translation".into()), ..orig_tail(text) }
    }

    fn end() -> Token {
        orig("<end>")
    }

    fn fin() -> Token {
        orig("<fin>")
    }

    fn to_zh() -> AssemblerConfig {
        AssemblerConfig { target_language: Some("zh".into()), ..AssemblerConfig::default() }
    }

    /// Transcript events as (seq, text, is_final).
    fn lines(events: &[AssemblerEvent]) -> Vec<(u64, &str, bool)> {
        events
            .iter()
            .filter_map(|e| match e {
                AssemblerEvent::Transcript(u) => Some((u.seq, u.text.as_str(), u.is_final)),
                _ => None,
            })
            .collect()
    }

    /// Translation events as (seq, translated text, is_final).
    fn translations(events: &[AssemblerEvent]) -> Vec<(u64, &str, bool)> {
        events
            .iter()
            .filter_map(|e| match e {
                AssemblerEvent::Translation(u) => Some((u.seq, u.translated_text.as_str(), u.is_final)),
                _ => None,
            })
            .collect()
    }

    fn clock() -> impl Fn(u64) -> Instant {
        let t0 = Instant::now();
        move |ms| t0 + Duration::from_millis(ms)
    }

    #[test]
    fn finals_append_and_the_tail_is_replaced_every_message() {
        let at = clock();
        let mut a = Assembler::new(AssemblerConfig::default());
        let ev = a.on_tokens(&[orig("How"), orig_tail(" are"), orig_tail(" you")], at(0));
        assert_eq!(lines(&ev), [(1, "How are you", false)]);
        let ev = a.on_tokens(&[orig(" are"), orig_tail(" you"), orig_tail(" doing")], at(100));
        assert_eq!(lines(&ev), [(1, "How are you doing", false)]);
        // A message without a tail takes the old one away.
        let ev = a.on_tokens(&[], at(200));
        assert_eq!(lines(&ev), [(1, "How are", false)]);
        assert!(a.on_tokens(&[], at(300)).is_empty(), "nothing changed");
    }

    #[test]
    fn a_line_spans_its_tokens() {
        let at = clock();
        let timed = |text: &str, start: u64, end: u64, is_final: bool| Token {
            text: text.into(),
            start_ms: Some(start),
            end_ms: Some(end),
            is_final,
            ..Token::default()
        };
        let mut a = Assembler::new(AssemblerConfig::default());
        let ev = a.on_tokens(&[timed("One", 1_000, 1_200, true), timed(" two", 1_200, 1_500, false)], at(0));
        let AssemblerEvent::Transcript(line) = &ev[0] else { panic!("{ev:?}") };
        assert_eq!((line.start_ms, line.end_ms), (Some(1_000), Some(1_500)));
    }

    #[test]
    fn an_endpoint_finalizes_the_line_and_starts_the_next_seq() {
        let at = clock();
        let mut a = Assembler::new(AssemblerConfig::default());
        a.on_tokens(&[orig("Hello"), orig(" world"), orig_tail(".")], at(0));
        let ev = a.on_tokens(&[orig("."), end(), orig_tail("Next")], at(100));
        assert_eq!(lines(&ev), [(1, "Hello world.", true), (2, "Next", false)]);
    }

    #[test]
    fn an_endpoint_without_text_uses_no_seq() {
        let at = clock();
        let mut a = Assembler::new(AssemblerConfig::default());
        assert!(a.on_tokens(&[end()], at(0)).is_empty());
        assert!(a.on_tokens(&[orig(" "), end()], at(100)).is_empty());
        let ev = a.on_tokens(&[orig("Hi"), end()], at(200));
        assert_eq!(lines(&ev), [(1, "Hi", true)]);
    }

    #[test]
    fn a_fin_token_ends_the_sentence_like_an_endpoint() {
        let at = clock();
        let mut a = Assembler::new(AssemblerConfig::default());
        // A non-final marker ends nothing and never shows.
        let ev = a.on_tokens(&[orig("Done"), orig_tail(" now"), orig_tail("<end>")], at(0));
        assert_eq!(lines(&ev), [(1, "Done now", false)]);
        let ev = a.on_tokens(&[orig(" now"), fin()], at(100));
        assert_eq!(lines(&ev), [(1, "Done now", true)]);
    }

    #[test]
    fn interleaved_translation_is_matched_to_its_sentence_by_order() {
        let at = clock();
        let mut a = Assembler::new(to_zh());
        let ev = a.on_tokens(
            &[
                orig("Hello"),
                orig(" there"),
                trans("你好"),
                end(),
                orig("How"),
                orig(" are"),
                orig(" you"),
                trans("你好吗"),
                end(),
            ],
            at(0),
        );
        assert_eq!(lines(&ev), [(1, "Hello there", true), (2, "How are you", true)]);
        assert_eq!(translations(&ev), [(1, "你好", true), (2, "你好吗", false)]);
        assert_eq!(translations(&a.flush(at(100))), [(2, "你好吗", true)]);
    }

    #[test]
    fn a_translation_done_before_the_endpoint_settles_when_the_next_sentence_is_final() {
        let at = clock();
        let from_en = |text: &str| Token { source_language: Some("en".into()), ..trans(text) };
        let mut a = Assembler::new(to_zh());
        a.on_tokens(&[orig("Thanks"), orig_tail(" a lot")], at(0));
        let ev = a.on_tokens(&[orig(" a lot"), from_en("非常"), from_en("感谢"), end()], at(300));
        assert_eq!(lines(&ev), [(1, "Thanks a lot", true)]);
        assert_eq!(translations(&ev), [(1, "非常感谢", false)]);
        // The next sentence's guess doesn't close it; its first final does.
        let ev = a.on_tokens(&[orig_tail("Sure")], at(600));
        assert_eq!(lines(&ev), [(2, "Sure", false)]);
        assert!(translations(&ev).is_empty());
        let ev = a.on_tokens(&[orig("Sure")], at(900));
        let [AssemblerEvent::Translation(settled)] = ev.as_slice() else { panic!("{ev:?}") };
        assert_eq!(
            *settled,
            TranslationUpdate {
                seq: 1,
                original_text: "Thanks a lot".into(),
                translated_text: "非常感谢".into(),
                source_language: Some("en".into()),
                target_language: "zh".into(),
                is_final: true,
            }
        );
    }

    #[test]
    fn a_late_translation_goes_to_the_archived_sentence() {
        let at = clock();
        let mut a = Assembler::new(to_zh());
        let ev = a.on_tokens(&[orig("See"), orig(" you"), end()], at(0));
        assert_eq!(lines(&ev), [(1, "See you", true)]);
        assert_eq!(translations(&a.on_tokens(&[trans_tail("再")], at(200))), [(1, "再", false)]);
        assert_eq!(translations(&a.on_tokens(&[trans("再见")], at(500))), [(1, "再见", false)]);
        let ev = a.on_tokens(&[orig("Bye")], at(800));
        assert_eq!(lines(&ev), [(2, "Bye", false)]);
        assert_eq!(translations(&ev), [(1, "再见", true)]);
    }

    #[test]
    fn a_late_translation_is_cut_off_once_the_next_sentence_is_final() {
        let at = clock();
        let mut a = Assembler::new(to_zh());
        a.on_tokens(&[orig("One"), end()], at(0));
        a.on_tokens(&[trans("一")], at(100));
        let ev = a.on_tokens(&[orig("Two"), trans("二")], at(400));
        assert_eq!(translations(&ev), [(1, "一", true), (2, "二", false)]);
    }

    #[test]
    fn the_next_sentences_guess_does_not_cut_off_a_late_translation() {
        let at = clock();
        let mut a = Assembler::new(to_zh());
        a.on_tokens(&[orig("One"), end()], at(0));
        a.on_tokens(&[orig_tail("Two")], at(100));
        // The translation of "One" comes before the guess of "Two" in the stream.
        let ev = a.on_tokens(&[trans("一"), orig_tail("Two")], at(400));
        assert_eq!(translations(&ev), [(1, "一", false)]);
        let ev = a.on_tokens(&[orig("Two")], at(700));
        assert_eq!(translations(&ev), [(1, "一", true)]);
    }

    #[test]
    fn a_quiet_archived_translation_settles_after_three_seconds() {
        let at = clock();
        let mut a = Assembler::new(to_zh());
        assert_eq!(translations(&a.on_tokens(&[orig("Wait"), trans("等"), end()], at(0))), [(1, "等", false)]);
        assert_eq!(translations(&a.on_tokens(&[trans("一下")], at(1_000))), [(1, "等一下", false)]);
        // Counted from the last translation token, not from the endpoint.
        assert!(a.tick(at(3_500)).is_empty());
        assert_eq!(translations(&a.tick(at(4_000))), [(1, "等一下", true)]);
        assert!(a.tick(at(9_000)).is_empty());
    }

    #[test]
    fn a_message_after_the_settle_time_finds_the_sentence_settled() {
        let at = clock();
        let mut a = Assembler::new(to_zh());
        a.on_tokens(&[orig("Wait"), trans("等"), end()], at(0));
        // No tick ran in between: the sentence settles before this token is placed.
        let ev = a.on_tokens(&[trans("一下")], at(3_200));
        assert_eq!(translations(&ev), [(1, "等", true)]);
    }

    #[test]
    fn translation_updates_are_throttled_and_tick_sends_the_latest() {
        let at = clock();
        let mut a = Assembler::new(to_zh());
        assert_eq!(translations(&a.on_tokens(&[orig("Hello"), trans_tail("你")], at(0))), [(1, "你", false)]);
        assert!(a.on_tokens(&[trans_tail("你好")], at(100)).is_empty());
        assert!(a.on_tokens(&[trans_tail("你好啊")], at(200)).is_empty());
        assert!(a.tick(at(240)).is_empty());
        assert_eq!(translations(&a.tick(at(250))), [(1, "你好啊", false)]);
        assert!(a.tick(at(500)).is_empty());
    }

    #[test]
    fn speech_in_the_target_language_gets_no_translation() {
        let at = clock();
        // Tokens marked "none": settled right at the endpoint.
        let none =
            |text: &str| Token { translation_status: Some("none".into()), language: Some("zh".into()), ..orig(text) };
        let mut a = Assembler::new(to_zh());
        let ev = a.on_tokens(&[none("我们"), none("开始"), none("吧"), end()], at(0));
        assert_eq!(lines(&ev), [(1, "我们开始吧", true)]);
        assert!(translations(&ev).is_empty());
        assert!(a.archived.is_none(), "nothing to wait for");

        // Marked "original" but no translation comes: nothing when it settles.
        let zh = |text: &str| Token {
            translation_status: Some("original".into()),
            language: Some("zh".into()),
            ..orig(text)
        };
        a.on_tokens(&[zh("好的"), end()], at(100));
        assert!(a.archived.is_some());
        assert!(a.tick(at(3_100)).is_empty());
        assert!(a.archived.is_none());
    }

    #[test]
    fn an_echo_translation_is_never_shown() {
        let at = clock();
        let zh = |text: &str| Token { language: Some("zh".into()), ..orig(text) };
        let mut a = Assembler::new(to_zh());
        let mut events = a.on_tokens(&[zh("你好"), zh("，"), trans("你好")], at(0));
        events.extend(a.on_tokens(&[zh("世界"), trans("，世界"), end()], at(300)));
        events.extend(a.on_tokens(&[orig("Next")], at(600)));
        events.extend(a.flush(at(900)));
        assert_eq!(
            lines(&events),
            [(1, "你好，", false), (1, "你好，世界", true), (2, "Next", false), (2, "Next", true)]
        );
        assert!(translations(&events).is_empty(), "{events:?}");
    }

    #[test]
    fn a_withdrawn_translation_is_cleared_when_it_settles() {
        let at = clock();
        let mut a = Assembler::new(to_zh());
        assert_eq!(translations(&a.on_tokens(&[orig("Um"), trans_tail("嗯")], at(0))), [(1, "嗯", false)]);
        // The guess is gone and never came back as final.
        a.on_tokens(&[end()], at(300));
        assert_eq!(translations(&a.flush(at(400))), [(1, "", true)]);
    }

    #[test]
    fn a_stray_translation_waits_for_a_line() {
        let at = clock();
        let mut a = Assembler::new(to_zh());
        assert!(a.on_tokens(&[trans("迟到")], at(0)).is_empty(), "no line to attach it to yet");
        let ev = a.on_tokens(&[orig("Late"), orig_tail(" again")], at(100));
        let [AssemblerEvent::Transcript(_), AssemblerEvent::Translation(update)] = ev.as_slice() else {
            panic!("{ev:?}")
        };
        assert_eq!((update.translated_text.as_str(), update.is_final), ("迟到", false));
        assert_eq!(update.original_text, "Late", "only the final original text");
    }

    #[test]
    fn chinese_text_comes_out_without_added_spaces() {
        let at = clock();
        let mut a = Assembler::new(to_zh());
        let ev = a.on_tokens(&[orig("今天"), orig("我们"), orig("讨论"), orig("预算"), orig("。"), end()], at(0));
        assert_eq!(lines(&ev), [(1, "今天我们讨论预算。", true)]);
        let ev = a.on_tokens(
            &[orig("Budget"), orig(" is"), orig(" tight"), trans("预算"), trans("很"), trans("紧"), end()],
            at(100),
        );
        assert_eq!(lines(&ev), [(2, "Budget is tight", true)]);
        assert_eq!(translations(&ev), [(2, "预算很紧", false)]);
    }

    #[test]
    fn speaker_and_language_follow_the_majority_and_confidence_the_mean() {
        let at = clock();
        let said = |text: &str, speaker: &str, language: &str, confidence: f32| Token {
            speaker: Some(speaker.into()),
            language: Some(language.into()),
            confidence: Some(confidence),
            ..orig(text)
        };
        let mut a = Assembler::new(AssemblerConfig::default());
        let ev = a.on_tokens(
            &[
                said("Hi", "1", "en", 0.8),
                said(" 你好", "2", "zh", 0.9),
                said("吗", "2", "zh", 1.0),
                said(" ok", "1", "en", 0.9),
                said("？", "2", "zh", 0.6),
                end(),
            ],
            at(0),
        );
        let AssemblerEvent::Transcript(line) = &ev[0] else { panic!("{ev:?}") };
        assert_eq!((line.speaker.as_deref(), line.language.as_deref()), (Some("2"), Some("zh")));
        assert!((line.confidence - 0.84).abs() < 1e-6, "{}", line.confidence);
        // A tie goes to the first seen.
        let ev = a.on_tokens(&[said("A", "1", "en", 0.5), said(" B", "2", "fr", 0.5), end()], at(100));
        let AssemblerEvent::Transcript(line) = &ev[0] else { panic!("{ev:?}") };
        assert_eq!((line.speaker.as_deref(), line.language.as_deref()), (Some("1"), Some("en")));
        // No confidence on any token.
        let ev = a.on_tokens(&[orig("x"), end()], at(200));
        let AssemblerEvent::Transcript(line) = &ev[0] else { panic!("{ev:?}") };
        assert_eq!((line.confidence, line.speaker.as_deref(), line.language.as_deref()), (0.9, None, None));
    }

    #[test]
    fn flush_ends_the_sentence_and_settles_every_translation() {
        let at = clock();
        let mut a = Assembler::new(to_zh());
        a.on_tokens(&[orig("First"), trans("第一"), end()], at(0));
        a.on_tokens(&[orig_tail("Second"), trans_tail("第二")], at(100));
        let ev = a.flush(at(200));
        assert_eq!(lines(&ev), [(2, "Second", true)]);
        assert_eq!(translations(&ev), [(1, "第一", true), (2, "第二", true)]);
        assert!(matches!(ev[0], AssemblerEvent::Transcript(_)), "the line comes first");
        // Empty afterwards; the next sentence gets the next seq.
        assert!(a.flush(at(300)).is_empty());
        assert_eq!(lines(&a.on_tokens(&[orig("Third"), end()], at(400))), [(3, "Third", true)]);
    }

    #[test]
    fn a_realistic_stream_gives_one_line_and_one_translation_per_sentence() {
        let at = clock();
        let mut a = Assembler::new(to_zh());
        let mut events = Vec::new();
        events.extend(a.on_tokens(&[orig("We"), orig_tail(" need")], at(0)));
        events.extend(a.on_tokens(&[orig(" need"), orig(" to"), orig_tail(" talk")], at(100)));
        events.extend(a.on_tokens(&[orig(" talk"), orig("."), trans_tail("我们")], at(200)));
        // The translation straddles the endpoint.
        events.extend(a.on_tokens(&[trans("我们需要"), end(), trans_tail("谈谈")], at(300)));
        events.extend(a.tick(at(450)));
        events.extend(a.on_tokens(&[trans("谈谈。"), orig_tail("Ok")], at(500)));
        events.extend(a.on_tokens(&[orig("Ok"), orig_tail(" then")], at(600)));
        events.extend(a.flush(at(700)));
        assert_eq!(
            lines(&events),
            [
                (1, "We need", false),
                (1, "We need to talk", false),
                (1, "We need to talk.", false),
                (1, "We need to talk.", true),
                (2, "Ok", false),
                (2, "Ok then", false),
                (2, "Ok then", true),
            ]
        );
        assert_eq!(
            translations(&events),
            [(1, "我们", false), (1, "我们需要谈谈", false), (1, "我们需要谈谈。", true)]
        );
    }

    #[test]
    fn no_translation_events_without_a_target() {
        let at = clock();
        let mut a = Assembler::new(AssemblerConfig::default());
        let mut events = a.on_tokens(&[orig("Hi"), trans("嗨"), end()], at(0));
        events.extend(a.on_tokens(&[trans("！")], at(100)));
        events.extend(a.flush(at(200)));
        assert_eq!(lines(&events), [(1, "Hi", true)]);
        assert!(translations(&events).is_empty());
    }

    // ── Two-way translation ────────────────────────────────────────────────────

    fn zh_en() -> AssemblerConfig {
        AssemblerConfig { two_way: Some(("zh".into(), "en".into())), ..AssemblerConfig::default() }
    }

    /// Final original token recognized in `language`.
    fn said(language: &str, text: &str) -> Token {
        Token { language: Some(language.into()), translation_status: Some("original".into()), ..orig(text) }
    }

    /// Final translation token from `source` into `target`.
    fn translated(source: &str, target: &str, text: &str) -> Token {
        Token { language: Some(target.into()), source_language: Some(source.into()), ..trans(text) }
    }

    /// Translation events as (seq, translated text, target, is_final).
    fn targeted(events: &[AssemblerEvent]) -> Vec<(u64, &str, &str, bool)> {
        events
            .iter()
            .filter_map(|e| match e {
                AssemblerEvent::Translation(u) => {
                    Some((u.seq, u.translated_text.as_str(), u.target_language.as_str(), u.is_final))
                }
                _ => None,
            })
            .collect()
    }

    #[test]
    fn two_way_translates_each_sentence_into_the_other_language() {
        let at = clock();
        let mut a = Assembler::new(zh_en());
        let mut events = a.on_tokens(
            &[said("zh", "我们"), said("zh", "开始吧"), translated("zh", "en", "Let's start"), end()],
            at(0),
        );
        events.extend(a.on_tokens(
            &[said("en", "Sounds"), said("en", " good"), translated("en", "zh", "听起来不错"), end()],
            at(300),
        ));
        events.extend(a.flush(at(600)));
        assert_eq!(lines(&events), [(1, "我们开始吧", true), (2, "Sounds good", true)]);
        assert_eq!(
            targeted(&events),
            [
                (1, "Let's start", "en", false),
                (1, "Let's start", "en", true),
                (2, "听起来不错", "zh", false),
                (2, "听起来不错", "zh", true),
            ]
        );
    }

    #[test]
    fn two_way_goes_by_the_source_its_translation_names_else_by_the_recognized_language() {
        let at = clock();
        let mut a = Assembler::new(zh_en());
        // Mostly English words, but translated as Chinese: the translation is English.
        let ev = a.on_tokens(
            &[
                said("en", "Kubernetes"),
                said("en", " cluster"),
                said("zh", "部署"),
                translated("zh", "en", "Deploy the Kubernetes cluster"),
                end(),
            ],
            at(0),
        );
        assert_eq!(targeted(&ev), [(1, "Deploy the Kubernetes cluster", "en", false)]);
        // No source on the translation (yet): the recognized language decides.
        let ev = a.on_tokens(&[said("en", "Budget"), trans_tail("预算")], at(300));
        assert_eq!(targeted(&ev), [(1, "Deploy the Kubernetes cluster", "en", true), (2, "预算", "zh", false)]);
        let ev = a.flush(at(600));
        let [AssemblerEvent::Transcript(_), AssemblerEvent::Translation(settled)] = ev.as_slice() else {
            panic!("{ev:?}")
        };
        assert_eq!(
            (settled.translated_text.as_str(), settled.source_language.as_deref(), settled.target_language.as_str()),
            ("预算", Some("en"), "zh")
        );
    }

    #[test]
    fn two_way_gives_a_sentence_in_neither_language_no_translation() {
        let at = clock();
        let none = |text: &str| Token { translation_status: Some("none".into()), ..said("ja", text) };
        let mut a = Assembler::new(zh_en());
        let ev = a.on_tokens(&[none("よろしく"), none("お願いします"), end()], at(0));
        assert_eq!(lines(&ev), [(1, "よろしくお願いします", true)]);
        assert!(targeted(&ev).is_empty());
        assert!(a.archived.is_none(), "nothing to wait for");

        // Not marked "none" and a translation turns up anyway: Japanese still has no other side.
        let mut events = a.on_tokens(&[said("ja", "はい"), translated("ja", "en", "Yes"), end()], at(100));
        events.extend(a.tick(at(3_200)));
        events.extend(a.flush(at(3_300)));
        assert_eq!(lines(&events), [(2, "はい", true)]);
        assert!(targeted(&events).is_empty(), "{events:?}");
    }

    #[test]
    fn two_way_still_hides_an_echo() {
        let at = clock();
        let mut a = Assembler::new(zh_en());
        let mut events = a.on_tokens(&[said("zh", "你好"), said("zh", "，"), translated("zh", "en", "你好")], at(0));
        events.extend(a.on_tokens(&[said("zh", "世界"), translated("zh", "en", "，世界"), end()], at(300)));
        events.extend(a.on_tokens(&[said("en", "Next")], at(600)));
        events.extend(a.flush(at(900)));
        assert_eq!(
            lines(&events),
            [(1, "你好，", false), (1, "你好，世界", true), (2, "Next", false), (2, "Next", true)]
        );
        assert!(targeted(&events).is_empty(), "{events:?}");
    }

    #[test]
    fn two_way_withdraws_a_partial_even_when_its_language_is_gone() {
        let at = clock();
        let mut a = Assembler::new(zh_en());
        let guess = Token { language: Some("en".into()), source_language: Some("zh".into()), ..trans_tail("OK") };
        assert_eq!(targeted(&a.on_tokens(&[orig_tail("好的"), guess], at(0))), [(1, "OK", "en", false)]);
        // The guess is gone and nothing says the line is Chinese any more.
        a.on_tokens(&[orig("好的"), end()], at(300));
        assert_eq!(targeted(&a.flush(at(400))), [(1, "", "en", true)]);
    }

    #[test]
    fn a_two_way_pair_soniox_cannot_take_translates_nothing() {
        let at = clock();
        for (a, b) in [("zh-CN", "zh-TW"), ("auto", "en"), ("zh", "")] {
            let cfg = AssemblerConfig { two_way: Some((a.into(), b.into())), ..AssemblerConfig::default() };
            let mut assembler = Assembler::new(cfg);
            let mut events = assembler.on_tokens(&[said("zh", "好"), translated("zh", "en", "Good"), end()], at(0));
            events.extend(assembler.flush(at(100)));
            assert_eq!(lines(&events), [(1, "好", true)]);
            assert!(targeted(&events).is_empty(), "{a} {b}: {events:?}");
        }
        // Settings-style codes are fine.
        let cfg = AssemblerConfig { two_way: Some(("ZH-cn".into(), "en_US".into())), ..AssemblerConfig::default() };
        let mut assembler = Assembler::new(cfg);
        let ev = assembler.on_tokens(&[said("zh", "好"), translated("zh", "en", "Good"), end()], at(0));
        assert_eq!(targeted(&ev), [(1, "Good", "en", false)]);
    }

    #[test]
    fn finalize_is_wanted_after_30_seconds_and_not_again_right_after_sending() {
        let at = clock();
        let mut a = Assembler::new(AssemblerConfig::default());
        assert!(!a.wants_finalize(at(60_000)), "nothing said yet");
        a.on_tokens(&[orig_tail("so")], at(0));
        assert!(!a.wants_finalize(at(29_999)));
        assert!(a.wants_finalize(at(30_000)));
        a.finalize_sent(at(30_000));
        assert!(!a.wants_finalize(at(31_000)));
        assert!(a.wants_finalize(at(35_000)), "asked again: no <fin> came");
        a.finalize_sent(at(35_000));
        a.on_tokens(&[orig("so"), fin()], at(35_500));
        a.on_tokens(&[orig_tail("then")], at(36_000));
        assert!(!a.wants_finalize(at(40_000)), "a new sentence");
        assert!(a.wants_finalize(at(66_000)));
    }
}
