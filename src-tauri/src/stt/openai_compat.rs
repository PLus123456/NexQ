// NexQ Plus: remote Whisper over an OpenAI-compatible /audio/transcriptions
// endpoint (faster-whisper-server / speaches, vLLM, LocalAI...).
//
// Generalized from groq_whisper.rs (Groq itself is unchanged):
//   - feed_audio only buffers PCM and cuts segments: at `segment_duration_secs`,
//     or early at a pause (`pause_split_ms` of silence after >= 0.5 s of speech).
//     Trailing silence is trimmed and a run of silence is kept only as a short
//     lead-in, so Whisper isn't handed long silences (it hallucinates on them).
//     It never waits on the network: the shared audio loop also feeds the other
//     party and the recorder.
//   - One worker per stream takes segments from a bounded queue (4 waiting;
//     when full the oldest waiting one is dropped), runs 1-2 requests at once
//     and hands the results on strictly in submission order.
//   - Every request reads the shared config, so settings apply to the next one.
//   - An utterance accumulator joins consecutive speech segments into one line
//     (interim results) and finalizes it at a pause, a silent segment, a failed
//     or empty request, a dropped segment, 30 s of line, or stop.
//   - Errors are visible: every failure goes to the Dev Log (`stt_debug`), each
//     distinct kind once per stream to `stt_connection_status`.

use std::collections::{HashSet, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, RwLock};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use futures::future::{self, BoxFuture, FutureExt};
use futures::stream::{FuturesOrdered, StreamExt};
use reqwest::StatusCode;
use serde_json::Value;
use tauri::AppHandle;
use tokio::sync::{mpsc, Notify};
use tokio::task::JoinHandle;
use url::Url;

use crate::audio::AudioChunk;
use crate::net::endpoint::{
    apply_headers, auth_headers, join_endpoint, redact_url, strip_endpoint_path, AuthConfig,
    AuthMode, EndpointError, AUDIO_TRANSCRIPTIONS_PATH, MODELS_PATH,
};
use crate::stt::deepgram::ConnectionStatusEvent;
use crate::stt::plus_config::{OpenAICompatSttConfig, SttProbeResult};
use crate::stt::provider::{STTProvider, STTProviderType, TranscriptResult};

/// The audio pipeline delivers 16 kHz mono i16 PCM.
const SAMPLE_RATE: u32 = 16_000;
const SAMPLES_PER_MS: usize = (SAMPLE_RATE / 1000) as usize;

/// RMS below which a chunk or a segment counts as silence (same as Groq).
const SILENCE_RMS_THRESHOLD: f64 = 100.0;

/// Speech needed before a pause may end a segment early, and the shortest
/// buffer flushed at stop (0.5 s).
const MIN_SPEECH_SAMPLES: usize = SAMPLE_RATE as usize / 2;

/// Silence kept in front of speech (0.3 s): softer onsets than the threshold
/// survive, long silences don't reach Whisper.
const LEAD_IN_SAMPLES: usize = 300 * SAMPLES_PER_MS;

/// Speech segments allowed to wait for the worker; the oldest waiting one is
/// dropped beyond that (M2: merge them instead).
const MAX_WAITING_SEGMENTS: usize = 4;

/// A line spanning this long is finalized even without a pause, so continuous
/// speech or noise never leaves it interim for the whole meeting.
const MAX_UTTERANCE_MS: u64 = 30_000;

/// Segment length used when the configured one isn't a number.
const DEFAULT_SEGMENT_SECS: f32 = 5.0;

/// The settings-page test's limit for `GET /models`.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// A host that doesn't accept the connection within this is unreachable.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// How much longer than the request timeout `stop_stream` waits for the
/// worker, and at most for the last line to be handed on.
const STOP_GRACE: Duration = Duration::from_secs(2);

/// Server text kept in a Dev Log error line and in a status message.
const DEBUG_BODY_CHARS: usize = 300;
const STATUS_BODY_CHARS: usize = 160;

/// `SttProbeResult::detail` limit (2 KB).
const MAX_DETAIL_BYTES: usize = 2048;

/// `stt_debug` source and `stt_connection_status` provider.
const SOURCE: &str = "openai_compat";

const CONFIDENCE: f32 = 0.95;

// ── Settings ────────────────────────────────────────────────────────────────

/// The config's numeric settings, clamped to what the engine supports.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Limits {
    /// Longest segment (1–30 s).
    segment_samples: usize,
    /// Silence that ends a segment early (300–5000 ms).
    pause_samples: usize,
    /// Per request (5–120 s).
    timeout: Duration,
    /// Requests at once (1–2).
    max_in_flight: usize,
}

impl Limits {
    fn of(cfg: &OpenAICompatSttConfig) -> Self {
        let secs = if cfg.segment_duration_secs.is_finite() {
            cfg.segment_duration_secs.clamp(1.0, 30.0)
        } else {
            DEFAULT_SEGMENT_SECS
        };
        Self {
            segment_samples: (secs * SAMPLE_RATE as f32) as usize,
            pause_samples: cfg.pause_split_ms.clamp(300, 5000) as usize * SAMPLES_PER_MS,
            timeout: Duration::from_secs(u64::from(cfg.request_timeout_secs.clamp(5, 120))),
            max_in_flight: cfg.max_in_flight.clamp(1, 2) as usize,
        }
    }
}

fn read_config(shared: &RwLock<OpenAICompatSttConfig>) -> OpenAICompatSttConfig {
    shared.read().unwrap_or_else(PoisonError::into_inner).clone()
}

fn read_limits(shared: &RwLock<OpenAICompatSttConfig>) -> Limits {
    Limits::of(&shared.read().unwrap_or_else(PoisonError::into_inner))
}

// ── Addresses ───────────────────────────────────────────────────────────────

/// Why no request URL could be built.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UrlError {
    /// `no_base_url` or `invalid_url` (an `SttProbeResult` code).
    pub code: &'static str,
    pub message: String,
}

impl UrlError {
    fn no_base_url() -> Self {
        Self {
            code: "no_base_url",
            message: "Remote Whisper has no Base URL: set it in the speech recognition settings"
                .to_string(),
        }
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self { code: "invalid_url", message: message.into() }
    }
}

impl std::fmt::Display for UrlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for UrlError {}

impl From<UrlError> for String {
    fn from(err: UrlError) -> Self {
        err.message
    }
}

/// Where audio is posted: `url_override` when set (used as typed, http/https
/// only), else `{base_url}/audio/transcriptions` by the shared endpoint rules
/// (`/v1` is never added, the query is kept, a full URL is used as is).
pub fn transcriptions_url(cfg: &OpenAICompatSttConfig) -> Result<Url, UrlError> {
    let override_url = cfg.url_override.trim();
    if !override_url.is_empty() {
        return parse_override(override_url);
    }
    match join_endpoint(&cfg.base_url, AUDIO_TRANSCRIPTIONS_PATH) {
        Ok(url) => Ok(url),
        Err(EndpointError::Empty) => Err(UrlError::no_base_url()),
        Err(err) => Err(UrlError::invalid(err.to_string())),
    }
}

fn parse_override(input: &str) -> Result<Url, UrlError> {
    let url = Url::parse(input)
        .map_err(|e| UrlError::invalid(format!("Invalid transcription URL \"{input}\": {e}")))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(UrlError::invalid(format!(
            "The transcription URL must start with http:// or https:// (got \"{input}\")"
        )));
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err(UrlError::invalid(format!("The transcription URL \"{input}\" has no host")));
    }
    Ok(url)
}

/// Where the settings-page test lists models: `{base_url}/models` (a full
/// transcription URL in the base field lists next to it). With only
/// `url_override`, the base is the override without `/audio/transcriptions`.
pub fn models_url(cfg: &OpenAICompatSttConfig) -> Result<Url, String> {
    let base = cfg.base_url.trim();
    let override_url = cfg.url_override.trim();
    let source = if base.is_empty() { override_url } else { base };
    if source.is_empty() {
        return Err(UrlError::no_base_url().message);
    }
    let stripped = strip_endpoint_path(source, &[AUDIO_TRANSCRIPTIONS_PATH]).map(|(b, _)| b);
    let models_base = match stripped {
        Some(stripped) => stripped,
        None if !base.is_empty() => base.to_string(),
        None => {
            return Err(format!(
                "Can't tell where the models are listed from {}",
                redact_url(override_url)
            ))
        }
    };
    join_endpoint(&models_base, MODELS_PATH).map_err(String::from)
}

// ── Responses and text ──────────────────────────────────────────────────────

/// The transcript in a 2xx body: `{"text": …}` (json, verbose_json),
/// `{"segments": [{"text": …}]}` (LocalAI), a bare JSON string, or the body
/// itself (`response_format=text`). None when there is no text.
pub fn parse_transcription_response(body: &str) -> Option<String> {
    let body = body.trim_start_matches('\u{feff}').trim();
    if body.is_empty() {
        return None;
    }
    let text = match serde_json::from_str::<Value>(body) {
        Ok(Value::Object(map)) => match map.get("text") {
            Some(Value::String(text)) if !text.trim().is_empty() => Some(text.clone()),
            _ => map.get("segments").and_then(Value::as_array).and_then(|s| segments_text(s)),
        },
        Ok(Value::Array(items)) => segments_text(&items),
        Ok(Value::String(text)) => Some(text),
        // Plain text that happens to be valid JSON ("42").
        Ok(Value::Number(_) | Value::Bool(_)) => Some(body.to_string()),
        Ok(Value::Null) => None,
        Err(_) => Some(body.to_string()),
    }?;
    let text = clean_text(&text);
    (!text.is_empty()).then_some(text)
}

fn segments_text(items: &[Value]) -> Option<String> {
    let mut text = String::new();
    for item in items {
        if let Some(part) = item.get("text").and_then(Value::as_str) {
            join_text(&mut text, part);
        }
    }
    (!text.is_empty()).then_some(text)
}

/// Lines trimmed and joined (`text` responses may hold one line per segment).
fn clean_text(text: &str) -> String {
    let mut out = String::new();
    for line in text.lines() {
        join_text(&mut out, line);
    }
    out
}

/// The message of a 2xx body that carries an error instead of a transcript.
fn error_in_body(body: &str) -> Option<String> {
    let value: Value = serde_json::from_str(body.trim()).ok()?;
    let error = value.get("error")?;
    Some(match error {
        Value::String(message) => message.clone(),
        other => other
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| other.to_string()),
    })
}

/// Model ids in a `/models` body: `{"data": [{"id"}]}` (OpenAI, vLLM,
/// speaches, LocalAI) or `{"models": […]}`, entries as strings or objects.
fn parse_model_ids(body: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<Value>(body.trim()) else {
        return Vec::new();
    };
    let list = match &value {
        Value::Object(map) => map.get("data").or_else(|| map.get("models")).and_then(Value::as_array),
        Value::Array(items) => Some(items),
        _ => None,
    };
    let mut ids: Vec<String> = Vec::new();
    for item in list.into_iter().flatten() {
        let id = match item {
            Value::String(id) => Some(id.as_str()),
            Value::Object(entry) => ["id", "name", "model"]
                .iter()
                .find_map(|key| entry.get(*key).and_then(Value::as_str)),
            _ => None,
        };
        if let Some(id) = id.map(str::trim).filter(|id| !id.is_empty()) {
            if !ids.iter().any(|known| known == id) {
                ids.push(id.to_string());
            }
        }
    }
    ids
}

/// Appends `next` (trimmed): after a space between Latin text, directly when
/// either side is Chinese or Japanese.
fn join_text(acc: &mut String, next: &str) {
    let next = next.trim();
    if next.is_empty() {
        return;
    }
    if let (Some(last), Some(first)) = (acc.chars().last(), next.chars().next()) {
        if !last.is_whitespace() && !is_cjk(last) && !is_cjk(first) {
            acc.push(' ');
        }
    }
    acc.push_str(next);
}

/// Han, kana, bopomofo and CJK / full-width punctuation: scripts written
/// without spaces. Hangul isn't (Korean separates words).
fn is_cjk(c: char) -> bool {
    matches!(
        u32::from(c),
        0x2E80..=0x2FDF     // radicals
            | 0x3000..=0x30FF // CJK punctuation, hiragana, katakana
            | 0x3100..=0x312F // bopomofo
            | 0x31A0..=0x31FF // bopomofo ext., strokes, katakana ext.
            | 0x3400..=0x4DBF // ext. A
            | 0x4E00..=0x9FFF // unified ideographs
            | 0xF900..=0xFAFF // compatibility ideographs
            | 0xFE30..=0xFE4F // vertical / compatibility forms
            | 0xFF00..=0xFF9F // full-width forms, half-width katakana
            | 0x20000..=0x3FFFF // ext. B and later
    )
}

/// Whole transcripts Whisper produces on silence or noise (compared after
/// [`hallucination_key`]): Groq's English list, whisper.cpp's marker, the
/// usual Chinese subtitle credits in both scripts, and the Japanese and
/// Korean "thanks for watching".
const HALLUCINATION_PHRASES: &[&str] = &[
    "thank you",
    "thanks",
    "thanks for watching",
    "thank you for watching",
    "you",
    "bye",
    "goodbye",
    "the end",
    "subtitle",
    "subtitles",
    "please subscribe",
    "like and subscribe",
    "thanks for listening",
    "thank you for listening",
    "[BLANK_AUDIO]",
    "字幕由Amara.org社区提供",
    "请不吝点赞 订阅 转发 打赏支持明镜与点点栏目",
    "明镜需要您的支持 欢迎订阅明镜",
    "谢谢观看",
    "感谢观看",
    "谢谢收看",
    "感谢收看",
    "谢谢大家观看",
    "谢谢大家收看",
    "感谢您的观看",
    "优优独播剧场",
    "中文字幕",
    "字幕志愿者",
    "中文字幕志愿者",
    "请订阅",
    "点赞订阅",
    "请点赞订阅",
    "点赞订阅转发",
    "字幕由Amara.org社區提供",
    "請不吝點贊 訂閱 轉發 打賞支持明鏡與點點欄目",
    "謝謝觀看",
    "感謝觀看",
    "謝謝收看",
    "感謝收看",
    "中文字幕志願者",
    "字幕志願者",
    "請訂閱",
    "點贊訂閱",
    "ご視聴ありがとうございました",
    "시청해 주셔서 감사합니다",
];

/// Distinctive pieces of the long credits: a transcript containing one is a
/// hallucination whatever surrounds it.
const HALLUCINATION_MARKERS: &[&str] = &[
    "amara.org",
    "明镜与点点",
    "明鏡與點點",
    "优优独播剧场",
    "優優獨播劇場",
    "字幕由",
    "字幕志愿者",
    "字幕志願者",
    "请不吝点赞",
    "請不吝點贊",
];

/// Lowercase letters and digits only: whitespace, ASCII and CJK punctuation
/// (`。！？，、…`) and symbols are dropped.
fn hallucination_key(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Whether `text` is something Whisper says on silence or noise rather than
/// speech: a known phrase (exact match after normalization), a long credit
/// marker anywhere, or nothing but punctuation. Ordinary short words such as
/// 谢谢 pass.
pub fn is_hallucination(text: &str) -> bool {
    let key = hallucination_key(text);
    key.is_empty()
        || HALLUCINATION_PHRASES.iter().any(|phrase| hallucination_key(phrase) == key)
        || HALLUCINATION_MARKERS
            .iter()
            .any(|marker| key.contains(&hallucination_key(marker)))
}

// ── Audio ───────────────────────────────────────────────────────────────────

fn rms(samples: &[i16]) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f64 = samples.iter().map(|&s| f64::from(s) * f64::from(s)).sum();
    (sum / samples.len() as f64).sqrt()
}

fn samples_to_ms(samples: usize) -> u64 {
    (samples / SAMPLES_PER_MS) as u64
}

/// 16 kHz mono 16-bit PCM WAV.
fn encode_wav(samples: &[i16]) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut wav = Vec::with_capacity(44 + data_len as usize);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&1u16.to_le_bytes()); // mono
    wav.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    wav.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes()); // byte rate
    wav.extend_from_slice(&2u16.to_le_bytes()); // block align
    wav.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    for sample in samples {
        wav.extend_from_slice(&sample.to_le_bytes());
    }
    wav
}

/// Audio cut from the stream, waiting to be transcribed.
#[derive(Debug)]
struct Segment {
    /// 1-based, for the Dev Log.
    seq: u64,
    samples: Vec<i16>,
    /// Capture time (epoch ms) of its first chunk.
    start_ms: u64,
}

impl Segment {
    fn duration_ms(&self) -> u64 {
        samples_to_ms(self.samples.len())
    }
}

#[derive(Debug)]
enum Cut {
    /// Speech to transcribe; `pause_after` when a pause ended it.
    Speech { segment: Segment, pause_after: bool },
    /// Below the silence threshold: not sent.
    Silent { seq: u64, rms: f64 },
}

/// Buffers PCM and decides where segments end.
#[derive(Debug, Default)]
struct Segmenter {
    buffer: Vec<i16>,
    /// Capture time (epoch ms) of `buffer[0]`.
    start_ms: u64,
    /// Silent samples at the end of `buffer` (all of it before any speech).
    trailing_silence: usize,
    cuts: u64,
}

impl Segmenter {
    /// Adds a chunk captured at `timestamp_ms`; returns the segment it completes.
    fn push(&mut self, pcm: &[i16], timestamp_ms: u64, limits: &Limits) -> Option<Cut> {
        if pcm.is_empty() {
            return None;
        }
        if self.buffer.is_empty() {
            self.start_ms = timestamp_ms;
        }
        if rms(pcm) < SILENCE_RMS_THRESHOLD {
            self.trailing_silence += pcm.len();
        } else {
            self.trailing_silence = 0;
        }
        self.buffer.extend_from_slice(pcm);

        // No speech yet: keep only the lead-in, ending with this chunk.
        if self.trailing_silence == self.buffer.len() && self.buffer.len() > LEAD_IN_SAMPLES {
            let excess = self.buffer.len() - LEAD_IN_SAMPLES;
            self.buffer.drain(..excess);
            self.trailing_silence = self.buffer.len();
            self.start_ms = (timestamp_ms + samples_to_ms(pcm.len()))
                .saturating_sub(samples_to_ms(self.buffer.len()));
        }

        let speech = self.buffer.len() - self.trailing_silence;
        let pause = self.trailing_silence >= limits.pause_samples && speech >= MIN_SPEECH_SAMPLES;
        (pause || self.buffer.len() >= limits.segment_samples).then(|| self.cut(limits))
    }

    /// At stop: what is left, if at least 0.5 s.
    fn flush(&mut self, limits: &Limits) -> Option<Cut> {
        if self.buffer.len() < MIN_SPEECH_SAMPLES {
            self.buffer.clear();
            self.trailing_silence = 0;
            return None;
        }
        Some(self.cut(limits))
    }

    fn cut(&mut self, limits: &Limits) -> Cut {
        let mut samples = std::mem::take(&mut self.buffer);
        let trailing = std::mem::take(&mut self.trailing_silence).min(samples.len());
        samples.truncate(samples.len() - trailing);
        self.cuts += 1;
        let level = rms(&samples);
        if samples.is_empty() || level < SILENCE_RMS_THRESHOLD {
            return Cut::Silent { seq: self.cuts, rms: level };
        }
        Cut::Speech {
            segment: Segment { seq: self.cuts, samples, start_ms: self.start_ms },
            pause_after: trailing >= limits.pause_samples,
        }
    }
}

// ── Queue ───────────────────────────────────────────────────────────────────

#[derive(Debug)]
enum Job {
    Transcribe(Segment),
    /// Silence, a pause or a gap: ends the current line, in order with the
    /// results around it.
    Pause,
}

#[derive(Debug, Default)]
struct QueueState {
    jobs: VecDeque<Job>,
    closed: bool,
}

impl QueueState {
    fn waiting(&self) -> usize {
        self.jobs.iter().filter(|job| matches!(job, Job::Transcribe(_))).count()
    }

    fn coalesce_pauses(&mut self) {
        let mut previous_pause = false;
        self.jobs.retain(|job| {
            let pause = matches!(job, Job::Pause);
            let keep = !(pause && previous_pause);
            previous_pause = pause;
            keep
        });
    }
}

/// What `push_segment` dropped to make room.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Dropped {
    seq: u64,
    duration_ms: u64,
}

/// Jobs between `feed_audio` (never blocks) and the worker.
#[derive(Debug, Default)]
struct SegmentQueue {
    state: Mutex<QueueState>,
    ready: Notify,
}

impl SegmentQueue {
    fn lock(&self) -> MutexGuard<'_, QueueState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Queues `segment`. With MAX_WAITING_SEGMENTS already waiting, the oldest
    /// waiting one becomes a pause (the lines around the gap aren't joined).
    fn push_segment(&self, segment: Segment) -> Option<Dropped> {
        let mut state = self.lock();
        let mut dropped = None;
        if state.waiting() >= MAX_WAITING_SEGMENTS {
            if let Some(i) = state.jobs.iter().position(|job| matches!(job, Job::Transcribe(_))) {
                if let Job::Transcribe(old) = std::mem::replace(&mut state.jobs[i], Job::Pause) {
                    dropped = Some(Dropped { seq: old.seq, duration_ms: old.duration_ms() });
                }
                state.coalesce_pauses();
            }
        }
        state.jobs.push_back(Job::Transcribe(segment));
        drop(state);
        self.ready.notify_one();
        dropped
    }

    fn push_pause(&self) {
        let mut state = self.lock();
        if !matches!(state.jobs.back(), Some(Job::Pause)) {
            state.jobs.push_back(Job::Pause);
        }
        drop(state);
        self.ready.notify_one();
    }

    /// No more jobs: the worker finishes the queued ones, then ends.
    fn close(&self) {
        self.lock().closed = true;
        self.ready.notify_one();
    }

    fn waiting(&self) -> usize {
        self.lock().waiting()
    }

    /// The next job; None once closed and empty. Cancel-safe.
    async fn pop(&self) -> Option<Job> {
        loop {
            {
                let mut state = self.lock();
                if let Some(job) = state.jobs.pop_front() {
                    return Some(job);
                }
                if state.closed {
                    return None;
                }
            }
            self.ready.notified().await;
        }
    }
}

// ── Events ──────────────────────────────────────────────────────────────────

/// What a stream reported (tests only; the app gets Tauri events).
#[cfg(test)]
#[derive(Debug, Clone, PartialEq)]
enum Notice {
    Debug { level: String, message: String },
    Status { status: String, message: Option<String> },
}

/// `stt_debug` and `stt_connection_status` for one party.
#[derive(Clone, Default)]
struct Notifier {
    app: Option<AppHandle>,
    party: String,
    #[cfg(test)]
    notices: Option<Arc<Mutex<Vec<Notice>>>>,
}

impl Notifier {
    fn debug(&self, level: &str, message: &str) {
        self.debug_keyed(level, message, None);
    }

    /// With `replace_key`, the Dev Log updates its last line with that key.
    fn debug_keyed(&self, level: &str, message: &str, replace_key: Option<&str>) {
        let message = if self.party.is_empty() {
            message.to_string()
        } else {
            format!("[{}] {message}", self.party)
        };
        #[cfg(test)]
        if let Some(notices) = &self.notices {
            notices.lock().unwrap().push(Notice::Debug {
                level: level.to_string(),
                message: message.clone(),
            });
        }
        match &self.app {
            Some(app) => super::emit_stt_debug_ex(app, level, SOURCE, &message, replace_key),
            None => match level {
                "error" => log::error!("[{SOURCE}] {message}"),
                "warn" => log::warn!("[{SOURCE}] {message}"),
                _ => log::info!("[{SOURCE}] {message}"),
            },
        }
    }

    fn status(&self, status: &str, message: Option<String>) {
        let line = match &message {
            Some(message) => format!("[{SOURCE}] [{}] {status}: {message}", self.party),
            None => format!("[{SOURCE}] [{}] {status}", self.party),
        };
        if status == "error" {
            log::warn!("{line}");
        } else {
            log::info!("{line}");
        }
        #[cfg(test)]
        if let Some(notices) = &self.notices {
            notices.lock().unwrap().push(Notice::Status {
                status: status.to_string(),
                message: message.clone(),
            });
        }
        if let Some(app) = &self.app {
            let event = ConnectionStatusEvent {
                provider: SOURCE.to_string(),
                party: self.party.clone(),
                status: status.to_string(),
                message,
            };
            if let Err(e) = tauri::Emitter::emit(app, "stt_connection_status", &event) {
                log::warn!("[{SOURCE}] Failed to emit the status event: {e}");
            }
        }
    }
}

/// `connected` after the first success (again after a reported error); each
/// distinct error kind once per stream, so a dead server isn't a toast per segment.
#[derive(Debug, Default)]
struct StatusTracker {
    connected: bool,
    reported: HashSet<String>,
}

impl StatusTracker {
    fn succeeded(&mut self, notifier: &Notifier) {
        if !self.connected {
            self.connected = true;
            notifier.status("connected", None);
        }
    }

    fn failed(&mut self, notifier: &Notifier, err: &RequestError) {
        if self.reported.insert(err.kind()) {
            self.connected = false;
            notifier.status("error", Some(err.message(STATUS_BODY_CHARS)));
        }
    }
}

// ── HTTP ────────────────────────────────────────────────────────────────────

fn http_client() -> reqwest::Client {
    let builder = reqwest::Client::builder().connect_timeout(CONNECT_TIMEOUT);
    // The tests' fake server is local: never through a system proxy.
    #[cfg(test)]
    let builder = builder.no_proxy();
    builder.build().unwrap_or_default()
}

/// The auth header, and the key itself to mask it should a server echo it.
struct Credentials {
    headers: Vec<(String, String)>,
    key: Option<String>,
}

impl Credentials {
    /// `Authorization: Bearer <key>`, or no header for an empty key.
    fn bearer(api_key: Option<&str>) -> Result<Self, String> {
        let auth = AuthConfig { mode: AuthMode::Bearer, ..AuthConfig::default() };
        let headers = auth_headers(&auth, api_key)
            .map_err(|e| format!("The API key can't be sent: {e}"))?;
        // Too short to mask without garbling ordinary text.
        let key = api_key.map(str::trim).filter(|key| key.len() >= 6).map(str::to_string);
        Ok(Self { headers, key })
    }

    fn apply(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        apply_headers(req, &self.headers)
    }

    /// Server text for logs, the key masked.
    fn mask(&self, text: &str) -> String {
        match &self.key {
            Some(key) => text.replace(key.as_str(), "***"),
            None => text.to_string(),
        }
    }
}

fn form_temperature(temperature: f32) -> String {
    let t = if temperature.is_finite() { temperature.clamp(0.0, 1.0) } else { 0.0 };
    t.to_string()
}

/// The OpenAI multipart form. `language` (ISO 639-1) only when not detecting,
/// `prompt` only when set.
fn build_form(
    cfg: &OpenAICompatSttConfig,
    language: Option<&str>,
    wav: Vec<u8>,
) -> reqwest::multipart::Form {
    let mut form = reqwest::multipart::Form::new();
    let model = cfg.model.trim();
    if !model.is_empty() {
        form = form.text("model", model.to_string());
    }
    let response_format = match cfg.response_format.trim() {
        "" => "json",
        format => format,
    };
    form = form
        .text("response_format", response_format.to_string())
        .text("temperature", form_temperature(cfg.temperature));
    if let Some(language) = language.map(str::trim).filter(|l| !l.is_empty()) {
        form = form.text("language", language.to_string());
    }
    let prompt = cfg.prompt.trim();
    if !prompt.is_empty() {
        form = form.text("prompt", prompt.to_string());
    }
    let file = reqwest::multipart::Part::bytes(wav)
        .file_name("audio.wav")
        .mime_str("audio/wav")
        .expect("audio/wav is a valid MIME type");
    form.part("file", file)
}

/// Why an exchange produced no HTTP answer.
#[derive(Debug)]
enum Failure {
    /// No complete answer within the time limit.
    Timeout,
    /// The HTTP client rejected the request (bad URL).
    Invalid(String),
    /// Connection refused, DNS, TLS, or the transfer broke off.
    Network(String),
}

/// Sends `req` and reads the whole body, within `timeout`.
async fn send(
    req: reqwest::RequestBuilder,
    timeout: Duration,
) -> Result<(StatusCode, String), Failure> {
    let exchange = async {
        let response = req.send().await?;
        let status = response.status();
        let body = response.text().await?;
        Ok::<_, reqwest::Error>((status, body))
    };
    match tokio::time::timeout(timeout, exchange).await {
        Err(_) => Err(Failure::Timeout),
        Ok(Ok(answer)) => Ok(answer),
        Ok(Err(e)) if e.is_builder() => Err(Failure::Invalid(error_chain(e))),
        Ok(Err(e)) if e.is_timeout() && !e.is_connect() => Err(Failure::Timeout),
        Ok(Err(e)) => Err(Failure::Network(error_chain(e))),
    }
}

/// The error and its causes, without the URL (it may carry a secret).
fn error_chain(err: reqwest::Error) -> String {
    let err = err.without_url();
    let mut text = err.to_string();
    let mut source = std::error::Error::source(&err);
    while let Some(cause) = source {
        let cause_text = cause.to_string();
        if !text.contains(&cause_text) {
            text.push_str(": ");
            text.push_str(&cause_text);
        }
        source = cause.source();
    }
    text
}

/// A failed transcription request.
#[derive(Debug, Clone, PartialEq)]
enum RequestError {
    Url(UrlError),
    Http { status: u16, url: String, body: String },
    Timeout { url: String, secs: u64 },
    Network { url: String, detail: String },
    /// A 2xx answer carrying an error.
    BadResponse { url: String, detail: String },
}

impl RequestError {
    /// Status reports are made once per kind and stream.
    fn kind(&self) -> String {
        match self {
            Self::Url(err) => err.code.to_string(),
            Self::Http { status, .. } => format!("http_{status}"),
            Self::Timeout { .. } => "timeout".to_string(),
            Self::Network { .. } => "network".to_string(),
            Self::BadResponse { .. } => "bad_response".to_string(),
        }
    }

    /// With at most `body_chars` of the server's answer.
    fn message(&self, body_chars: usize) -> String {
        match self {
            Self::Url(err) => err.message.clone(),
            Self::Http { status, url, body } => {
                let reason = StatusCode::from_u16(*status)
                    .ok()
                    .and_then(|s| s.canonical_reason())
                    .map(|r| format!(" {r}"))
                    .unwrap_or_default();
                let mut message = format!("HTTP {status}{reason} from {url}");
                match status {
                    404 => message.push_str(
                        " (check the version prefix of the Base URL, for example /v1)",
                    ),
                    401 => message.push_str(" (check the API key)"),
                    _ => {}
                }
                if !body.is_empty() {
                    message.push_str(": ");
                    message.push_str(&preview(body, body_chars));
                }
                message
            }
            Self::Timeout { url, secs } => format!("No answer from {url} within {secs} s"),
            Self::Network { url, detail } => format!("Can't reach {url}: {detail}"),
            Self::BadResponse { url, detail } => {
                format!("{url} answered with an error: {}", preview(detail, body_chars))
            }
        }
    }
}

/// Posts one WAV; Ok(None) when the server heard nothing.
async fn transcribe(
    client: &reqwest::Client,
    cfg: &OpenAICompatSttConfig,
    credentials: &Credentials,
    language: Option<&str>,
    wav: Vec<u8>,
) -> Result<Option<String>, RequestError> {
    let url = transcriptions_url(cfg).map_err(RequestError::Url)?;
    let shown = redact_url(url.as_str());
    let timeout = Limits::of(cfg).timeout;
    let req = credentials.apply(client.post(url).multipart(build_form(cfg, language, wav)));
    match send(req, timeout).await {
        Ok((status, body)) if status.is_success() => match parse_transcription_response(&body) {
            Some(text) => Ok(Some(text)),
            None => match error_in_body(&body) {
                Some(detail) => {
                    Err(RequestError::BadResponse { url: shown, detail: credentials.mask(&detail) })
                }
                None => Ok(None),
            },
        },
        Ok((status, body)) => Err(RequestError::Http {
            status: status.as_u16(),
            url: shown,
            body: preview(&one_line(&credentials.mask(&body)), DEBUG_BODY_CHARS),
        }),
        Err(Failure::Timeout) => Err(RequestError::Timeout { url: shown, secs: timeout.as_secs() }),
        Err(Failure::Invalid(detail)) => Err(RequestError::Url(UrlError::invalid(detail))),
        Err(Failure::Network(detail)) => Err(RequestError::Network { url: shown, detail }),
    }
}

// ── Worker and accumulator ──────────────────────────────────────────────────

/// What every request of a stream needs.
struct RequestCtx {
    client: reqwest::Client,
    shared_config: Arc<RwLock<OpenAICompatSttConfig>>,
    credentials: Credentials,
    language: Option<String>,
    notifier: Notifier,
}

enum Outcome {
    Pause,
    Done(Done),
}

struct Done {
    seq: u64,
    start_ms: u64,
    duration_ms: u64,
    latency_ms: u64,
    result: Result<Option<String>, RequestError>,
}

async fn run_request(ctx: Arc<RequestCtx>, segment: Segment) -> Outcome {
    // The settings at this moment: changes apply from the next request.
    let cfg = read_config(&ctx.shared_config);
    let wav = encode_wav(&segment.samples);
    ctx.notifier.debug(
        "info",
        &format!(
            "Sending segment #{} ({:.1} s, {} KB) to {}",
            segment.seq,
            segment.samples.len() as f32 / SAMPLE_RATE as f32,
            wav.len() / 1024,
            if cfg.model.trim().is_empty() { "the server's default model" } else { cfg.model.trim() },
        ),
    );
    let started = Instant::now();
    let result = transcribe(&ctx.client, &cfg, &ctx.credentials, ctx.language.as_deref(), wav).await;
    Outcome::Done(Done {
        seq: segment.seq,
        start_ms: segment.start_ms,
        duration_ms: segment.duration_ms(),
        latency_ms: started.elapsed().as_millis() as u64,
        result,
    })
}

/// Runs up to `max_in_flight` requests and hands the outcomes on in queue order.
async fn run_worker(
    ctx: Arc<RequestCtx>,
    queue: Arc<SegmentQueue>,
    acc_tx: mpsc::UnboundedSender<AccMsg>,
) {
    let mut status = StatusTracker::default();
    let mut pending: FuturesOrdered<BoxFuture<'static, Outcome>> = FuturesOrdered::new();
    let mut running = 0usize;
    let mut open = true;
    loop {
        let limit = read_limits(&ctx.shared_config).max_in_flight;
        tokio::select! {
            biased;
            Some(outcome) = pending.next(), if !pending.is_empty() => {
                if matches!(outcome, Outcome::Done(_)) {
                    running -= 1;
                }
                let _ = acc_tx.send(settle(outcome, &ctx.notifier, &mut status));
            }
            job = queue.pop(), if open && running < limit => match job {
                Some(Job::Pause) => pending.push_back(future::ready(Outcome::Pause).boxed()),
                Some(Job::Transcribe(segment)) => {
                    running += 1;
                    pending.push_back(run_request(ctx.clone(), segment).boxed());
                }
                None => open = false,
            },
            else => break,
        }
    }
}

/// Reports an outcome and turns it into the accumulator's next step.
fn settle(outcome: Outcome, notifier: &Notifier, status: &mut StatusTracker) -> AccMsg {
    let Outcome::Done(done) = outcome else {
        return AccMsg::Pause;
    };
    let Done { seq, start_ms, duration_ms, latency_ms, result } = done;
    match result {
        Ok(Some(text)) if !is_hallucination(&text) => {
            status.succeeded(notifier);
            notifier.debug(
                "info",
                &format!("Segment #{seq} ({latency_ms} ms): \"{}\"", preview(&text, 80)),
            );
            AccMsg::Speech { text, start_ms, duration_ms }
        }
        Ok(Some(text)) => {
            status.succeeded(notifier);
            notifier.debug("info", &format!("Segment #{seq}: filtered hallucination \"{text}\""));
            AccMsg::Pause
        }
        Ok(None) => {
            status.succeeded(notifier);
            notifier.debug("info", &format!("Segment #{seq}: no speech heard ({latency_ms} ms)"));
            AccMsg::Pause
        }
        Err(err) => {
            notifier.debug("error", &format!("Segment #{seq}: {}", err.message(DEBUG_BODY_CHARS)));
            status.failed(notifier, &err);
            AccMsg::Pause
        }
    }
}

enum AccMsg {
    Speech { text: String, start_ms: u64, duration_ms: u64 },
    Pause,
}

/// The line being built from consecutive speech segments.
#[derive(Debug, Default)]
struct Utterance {
    count: u64,
    text: String,
    start_ms: u64,
    end_ms: u64,
}

impl Utterance {
    /// Adds a segment's text: the line so far as an interim result, or as a
    /// final one once it spans MAX_UTTERANCE_MS.
    fn push(&mut self, text: &str, start_ms: u64, duration_ms: u64) -> Option<TranscriptResult> {
        if text.trim().is_empty() {
            return None;
        }
        if self.text.is_empty() {
            self.count += 1;
            self.start_ms = start_ms;
            self.end_ms = start_ms;
        }
        join_text(&mut self.text, text);
        self.end_ms = self.end_ms.max(start_ms + duration_ms);
        if self.end_ms - self.start_ms >= MAX_UTTERANCE_MS {
            return self.finish();
        }
        Some(self.result(false))
    }

    /// The line as a final result, if there is one; the next push starts a new line.
    fn finish(&mut self) -> Option<TranscriptResult> {
        if self.text.is_empty() {
            return None;
        }
        let result = self.result(true);
        self.text.clear();
        Some(result)
    }

    fn result(&self, is_final: bool) -> TranscriptResult {
        TranscriptResult {
            text: self.text.clone(),
            is_final,
            confidence: CONFIDENCE,
            timestamp_ms: self.start_ms,
            speaker: None,
            language: None,
            segment_id: Some(format!("oc_utt_{}", self.count)),
            duration_ms: Some(self.end_ms - self.start_ms),
            speaker_tag: None,
        }
    }
}

async fn run_accumulator(
    mut rx: mpsc::UnboundedReceiver<AccMsg>,
    tx: mpsc::Sender<TranscriptResult>,
) {
    let mut line = Utterance::default();
    while let Some(msg) = rx.recv().await {
        let result = match msg {
            AccMsg::Speech { text, start_ms, duration_ms } => line.push(&text, start_ms, duration_ms),
            AccMsg::Pause => line.finish(),
        };
        if let Some(result) = result {
            if tx.send(result).await.is_err() {
                return; // nobody listens any more
            }
        }
    }
    // Stream over (stop, or the engine was dropped).
    if let Some(result) = line.finish() {
        let _ = tx.send(result).await;
    }
}

// ── Engine ──────────────────────────────────────────────────────────────────

/// A running stream.
struct Stream {
    queue: Arc<SegmentQueue>,
    worker: JoinHandle<()>,
    /// Dropped at stop so the accumulator finalizes the last line and ends.
    acc_tx: Option<mpsc::UnboundedSender<AccMsg>>,
    accumulator: JoinHandle<()>,
    notifier: Notifier,
    segmenter: Segmenter,
    chunks_fed: u64,
}

impl Stream {
    fn dispatch(&self, cut: Cut) {
        match cut {
            Cut::Silent { seq, rms } => {
                self.queue.push_pause();
                let key = format!("{SOURCE}_silence_{}", self.notifier.party);
                self.notifier.debug_keyed(
                    "info",
                    &format!("Segment #{seq} is silence (rms {rms:.0}), not sent"),
                    Some(&key),
                );
            }
            Cut::Speech { segment, pause_after } => {
                if let Some(dropped) = self.queue.push_segment(segment) {
                    self.notifier.debug(
                        "warn",
                        &format!(
                            "The server is falling behind: dropped segment #{} ({:.1} s of audio), {} still waiting",
                            dropped.seq,
                            dropped.duration_ms as f32 / 1000.0,
                            MAX_WAITING_SEGMENTS,
                        ),
                    );
                }
                if pause_after {
                    self.queue.push_pause();
                }
            }
        }
    }
}

impl Drop for Stream {
    /// Dropped without stop_stream: no one waits for results any more.
    fn drop(&mut self) {
        self.queue.close();
        self.worker.abort();
    }
}

pub struct OpenAICompatSTT {
    shared_config: Arc<RwLock<OpenAICompatSttConfig>>,
    api_key: Option<String>,
    /// This party's `language` field (ISO 639-1); None = detect.
    language: Option<String>,
    app_handle: Option<AppHandle>,
    party: String,
    stream: Option<Stream>,
    #[cfg(test)]
    notices: Option<Arc<Mutex<Vec<Notice>>>>,
}

impl OpenAICompatSTT {
    pub fn new(shared_config: Arc<RwLock<OpenAICompatSttConfig>>, api_key: Option<String>) -> Self {
        Self {
            shared_config,
            api_key,
            language: None,
            app_handle: None,
            party: String::new(),
            stream: None,
            #[cfg(test)]
            notices: None,
        }
    }

    pub fn set_app_handle(&mut self, handle: AppHandle) {
        self.app_handle = Some(handle);
    }

    pub fn set_party(&mut self, party: &str) {
        self.party = party.to_string();
    }

    fn notifier(&self) -> Notifier {
        Notifier {
            app: self.app_handle.clone(),
            party: self.party.clone(),
            #[cfg(test)]
            notices: self.notices.clone(),
        }
    }

    /// Records what the next stream reports.
    #[cfg(test)]
    fn record_notices(&mut self) -> Arc<Mutex<Vec<Notice>>> {
        let notices = Arc::new(Mutex::new(Vec::new()));
        self.notices = Some(notices.clone());
        notices
    }
}

#[async_trait]
impl STTProvider for OpenAICompatSTT {
    fn provider_name(&self) -> &str {
        "Remote Whisper (OpenAI-compatible)"
    }

    fn provider_type(&self) -> STTProviderType {
        STTProviderType::OpenAICompat
    }

    async fn start_stream(
        &mut self,
        result_tx: mpsc::Sender<TranscriptResult>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if self.stream.is_some() {
            return Err("Stream already active".into());
        }
        let cfg = read_config(&self.shared_config);
        let url = transcriptions_url(&cfg)?;
        let credentials = Credentials::bearer(self.api_key.as_deref())?;
        let limits = Limits::of(&cfg);
        let notifier = self.notifier();
        notifier.debug(
            "info",
            &format!(
                "Starting: {} model={} language={} segment={:.1} s pause={} ms timeout={} s in_flight={} key={}",
                redact_url(url.as_str()),
                cfg.model.trim(),
                self.language.as_deref().unwrap_or("auto"),
                limits.segment_samples as f32 / SAMPLE_RATE as f32,
                samples_to_ms(limits.pause_samples),
                limits.timeout.as_secs(),
                limits.max_in_flight,
                if credentials.headers.is_empty() { "none" } else { "set" },
            ),
        );

        let queue = Arc::new(SegmentQueue::default());
        let (acc_tx, acc_rx) = mpsc::unbounded_channel();
        let accumulator = tokio::spawn(run_accumulator(acc_rx, result_tx));
        let ctx = Arc::new(RequestCtx {
            client: http_client(),
            shared_config: self.shared_config.clone(),
            credentials,
            language: self.language.clone(),
            notifier: notifier.clone(),
        });
        let worker = tokio::spawn(run_worker(ctx, queue.clone(), acc_tx.clone()));
        self.stream = Some(Stream {
            queue,
            worker,
            acc_tx: Some(acc_tx),
            accumulator,
            notifier,
            segmenter: Segmenter::default(),
            chunks_fed: 0,
        });
        Ok(())
    }

    /// Buffers the chunk and queues the segment it completes. Never waits.
    async fn feed_audio(
        &mut self,
        chunk: AudioChunk,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(stream) = self.stream.as_mut() else {
            return Ok(());
        };
        stream.chunks_fed += 1;
        if stream.chunks_fed == 1 {
            stream.notifier.debug("info", "First audio chunk received");
        }
        let limits = read_limits(&self.shared_config);
        if let Some(cut) = stream.segmenter.push(&chunk.pcm_data, chunk.timestamp_ms, &limits) {
            stream.dispatch(cut);
        }
        Ok(())
    }

    /// Sends the rest of the buffer, waits for the queued segments (at most
    /// the request timeout + 2 s), then finalizes the last line.
    async fn stop_stream(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(mut stream) = self.stream.take() else {
            return Ok(());
        };
        let limits = read_limits(&self.shared_config);
        if let Some(cut) = stream.segmenter.flush(&limits) {
            stream.dispatch(cut);
        }
        stream.queue.close();

        let wait = limits.timeout + STOP_GRACE;
        if tokio::time::timeout(wait, &mut stream.worker).await.is_err() {
            stream.worker.abort();
            let _ = (&mut stream.worker).await;
            stream.notifier.debug(
                "warn",
                &format!(
                    "Stopped waiting for the server after {} s: the segments still in flight or queued ({} queued) were not transcribed",
                    wait.as_secs(),
                    stream.queue.waiting(),
                ),
            );
        }

        stream.acc_tx = None;
        if tokio::time::timeout(STOP_GRACE, &mut stream.accumulator).await.is_err() {
            stream.notifier.debug("warn", "The last line was not handed on in time");
        }
        stream.notifier.debug(
            "info",
            &format!(
                "Stream stopped: {} chunks, {} segments",
                stream.chunks_fed, stream.segmenter.cuts
            ),
        );
        Ok(())
    }

    async fn test_connection(&self) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        let cfg = read_config(&self.shared_config);
        let result = probe(&cfg, self.api_key.as_deref()).await;
        if !result.ok {
            log::warn!("[{SOURCE}] Connection test failed: {} {}", result.code, result.detail);
        }
        Ok(result.ok)
    }

    fn set_language(&mut self, language: &str) {
        self.language = crate::stt::language::whisper_api_language(language);
    }
}

// ── Settings-page test ──────────────────────────────────────────────────────

/// Settings-page test: lists the models (`GET {base}/models`, 10 s), else
/// (404/405, or no models address) transcribes 1 s of silence.
pub async fn probe(cfg: &OpenAICompatSttConfig, api_key: Option<&str>) -> SttProbeResult {
    let transcription = match transcriptions_url(cfg) {
        Ok(url) => url,
        Err(err) => return SttProbeResult::failure(err.code, err.message),
    };
    let credentials = match Credentials::bearer(api_key) {
        Ok(credentials) => credentials,
        Err(detail) => return SttProbeResult::failure("unauthorized", detail),
    };
    let client = http_client();

    if let Ok(models) = models_url(cfg) {
        let started = Instant::now();
        let outcome = send(credentials.apply(client.get(models.clone())), PROBE_TIMEOUT).await;
        let latency_ms = started.elapsed().as_millis() as u64;
        match outcome {
            Ok((status, body)) if status.is_success() => {
                return SttProbeResult {
                    ok: true,
                    code: "ok".to_string(),
                    url: Some(redact_url(models.as_str())),
                    status: Some(status.as_u16()),
                    latency_ms,
                    detail: String::new(),
                    models: parse_model_ids(&body),
                };
            }
            // No model list here: try a transcription instead.
            Ok((status, _)) if matches!(status.as_u16(), 404 | 405) => {}
            outcome => {
                return probe_failure(&models, outcome, latency_ms, PROBE_TIMEOUT, &credentials)
            }
        }
    }

    let timeout = Limits::of(cfg).timeout;
    let wav = encode_wav(&vec![0; SAMPLE_RATE as usize]);
    let req = credentials.apply(client.post(transcription.clone()).multipart(build_form(cfg, None, wav)));
    let started = Instant::now();
    let outcome = send(req, timeout).await;
    let latency_ms = started.elapsed().as_millis() as u64;
    match outcome {
        Ok((status, body)) if status.is_success() => SttProbeResult {
            ok: true,
            code: "ok".to_string(),
            url: Some(redact_url(transcription.as_str())),
            status: Some(status.as_u16()),
            latency_ms,
            detail: cut_bytes(credentials.mask(&body).trim(), MAX_DETAIL_BYTES),
            models: Vec::new(),
        },
        outcome => probe_failure(&transcription, outcome, latency_ms, timeout, &credentials),
    }
}

fn probe_failure(
    url: &Url,
    outcome: Result<(StatusCode, String), Failure>,
    latency_ms: u64,
    timeout: Duration,
    credentials: &Credentials,
) -> SttProbeResult {
    let shown = redact_url(url.as_str());
    let (code, status, detail) = match outcome {
        Ok((status, body)) => {
            let code = match status.as_u16() {
                401 => "unauthorized",
                403 => "forbidden",
                404 => "not_found",
                _ => "http_error",
            };
            let body = credentials.mask(body.trim());
            let detail = if status == StatusCode::NOT_FOUND {
                format!(
                    "Nothing at {shown} (HTTP 404). Check the version prefix of the Base URL (for example /v1).\n{body}"
                )
            } else {
                body
            };
            (code, Some(status.as_u16()), detail)
        }
        Err(Failure::Timeout) => {
            ("timeout", None, format!("No answer from {shown} within {} s", timeout.as_secs()))
        }
        Err(Failure::Invalid(detail)) => ("invalid_url", None, detail),
        Err(Failure::Network(detail)) => ("network", None, detail),
    };
    SttProbeResult {
        ok: false,
        code: code.to_string(),
        url: Some(shown),
        status,
        latency_ms,
        detail: cut_bytes(detail.trim(), MAX_DETAIL_BYTES),
        models: Vec::new(),
    }
}

// ── Text helpers ────────────────────────────────────────────────────────────

/// At most `max` characters, ending in "..." when cut (never inside a
/// multi-byte character).
fn preview(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let kept: String = text.chars().take(max.saturating_sub(3)).collect();
    format!("{kept}...")
}

/// Whitespace runs (newlines included) as single spaces.
fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// At most `max` bytes, cut on a character boundary.
fn cut_bytes(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::AudioSource;
    use std::net::SocketAddr;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::Semaphore;

    /// Capture clock of the first chunk fed (epoch ms).
    const T0: u64 = 1_750_000_000_000;

    // ── A tiny HTTP/1.1 server that records requests ──

    #[derive(Debug, Clone)]
    struct Recorded {
        method: String,
        /// Path and query.
        target: String,
        /// Names lowercased.
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    }

    #[derive(Debug, Clone)]
    struct FormPart {
        name: String,
        filename: Option<String>,
        content_type: Option<String>,
        data: Vec<u8>,
    }

    impl Recorded {
        fn header(&self, name: &str) -> Option<&str> {
            self.headers
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.as_str())
        }

        fn path(&self) -> &str {
            self.target.split('?').next().unwrap_or_default()
        }

        fn form(&self) -> Vec<FormPart> {
            parse_multipart(self.header("content-type").unwrap_or_default(), &self.body)
        }

        fn field(&self, name: &str) -> Option<String> {
            self.form()
                .into_iter()
                .find(|part| part.name == name)
                .map(|part| String::from_utf8_lossy(&part.data).into_owned())
        }

        fn wav_samples(&self) -> Vec<i16> {
            let file = self.form().into_iter().find(|part| part.name == "file").expect("a file part");
            let pcm = &file.data[44..];
            (0..pcm.len() / 2).map(|i| i16::from_le_bytes([pcm[2 * i], pcm[2 * i + 1]])).collect()
        }

        /// Loudest sample of the posted audio: tells the test segments apart.
        fn peak(&self) -> i16 {
            self.wav_samples().iter().map(|s| s.saturating_abs()).max().unwrap_or(0)
        }
    }

    struct Reply {
        status: u16,
        body: String,
        content_type: &'static str,
        /// Held until the test adds a permit.
        gate: Option<Arc<Semaphore>>,
    }

    impl Reply {
        fn json(body: &str) -> Self {
            Self { status: 200, body: body.to_string(), content_type: "application/json", gate: None }
        }

        fn text(body: &str) -> Self {
            Self { content_type: "text/plain; charset=utf-8", ..Self::json(body) }
        }

        fn status(status: u16, body: &str) -> Self {
            Self { status, ..Self::json(body) }
        }

        fn gated(mut self, gate: &Arc<Semaphore>) -> Self {
            self.gate = Some(gate.clone());
            self
        }
    }

    type Handler = Arc<dyn Fn(&Recorded) -> Reply + Send + Sync>;

    struct FakeServer {
        addr: SocketAddr,
        requests: Arc<Mutex<Vec<Recorded>>>,
        accept: JoinHandle<()>,
    }

    impl FakeServer {
        async fn start(handler: impl Fn(&Recorded) -> Reply + Send + Sync + 'static) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let requests = Arc::new(Mutex::new(Vec::new()));
            let handler: Handler = Arc::new(handler);
            let recorded = requests.clone();
            let accept = tokio::spawn(async move {
                while let Ok((socket, _)) = listener.accept().await {
                    tokio::spawn(serve(socket, handler.clone(), recorded.clone()));
                }
            });
            Self { addr, requests, accept }
        }

        fn url(&self, path: &str) -> String {
            format!("http://{}{path}", self.addr)
        }

        fn requests(&self) -> Vec<Recorded> {
            self.requests.lock().unwrap().clone()
        }

        fn transcriptions(&self) -> Vec<Recorded> {
            self.requests()
                .into_iter()
                .filter(|r| r.path().ends_with(AUDIO_TRANSCRIPTIONS_PATH))
                .collect()
        }

        /// Until `count` requests arrived (answered or not).
        async fn wait_for(&self, count: usize) {
            let deadline = Instant::now() + Duration::from_secs(10);
            while self.requests().len() < count {
                assert!(
                    Instant::now() < deadline,
                    "the server got {} of {count} requests",
                    self.requests().len()
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
    }

    impl Drop for FakeServer {
        fn drop(&mut self) {
            self.accept.abort();
        }
    }

    /// One request per connection (`Connection: close`).
    async fn serve(mut socket: TcpStream, handler: Handler, requests: Arc<Mutex<Vec<Recorded>>>) {
        let Some(request) = read_request(&mut socket).await else {
            return;
        };
        requests.lock().unwrap().push(request.clone());
        let reply = handler(&request);
        if let Some(gate) = &reply.gate {
            let _permit = gate.acquire().await;
        }
        let reason = match reply.status {
            200 => "OK",
            401 => "Unauthorized",
            404 => "Not Found",
            _ => "Status",
        };
        let head = format!(
            "HTTP/1.1 {} {reason}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            reply.status,
            reply.content_type,
            reply.body.len()
        );
        let _ = socket.write_all(head.as_bytes()).await;
        let _ = socket.write_all(reply.body.as_bytes()).await;
        let _ = socket.shutdown().await;
    }

    async fn read_request(socket: &mut TcpStream) -> Option<Recorded> {
        let mut raw = Vec::new();
        let head_end = loop {
            if let Some(i) = find(&raw, b"\r\n\r\n") {
                break i;
            }
            read_more(socket, &mut raw).await?;
        };
        let head = String::from_utf8_lossy(&raw[..head_end]).into_owned();
        let mut lines = head.split("\r\n");
        let mut request_line = lines.next()?.split(' ');
        let method = request_line.next()?.to_string();
        let target = request_line.next()?.to_string();
        let headers: Vec<(String, String)> = lines
            .filter_map(|line| line.split_once(':'))
            .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
            .collect();
        let header = |name: &str| headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone());
        let content_length = header("content-length").and_then(|v| v.parse::<usize>().ok());
        let chunked = header("transfer-encoding").is_some_and(|v| v.eq_ignore_ascii_case("chunked"));
        let mut rest = raw.split_off(head_end + 4);
        let body = if let Some(len) = content_length {
            while rest.len() < len {
                read_more(socket, &mut rest).await?;
            }
            rest.truncate(len);
            rest
        } else if chunked {
            read_chunked(socket, rest).await?
        } else {
            Vec::new()
        };
        Some(Recorded { method, target, headers, body })
    }

    async fn read_more(socket: &mut TcpStream, buf: &mut Vec<u8>) -> Option<()> {
        let mut chunk = [0u8; 16 * 1024];
        let n = socket.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        Some(())
    }

    async fn read_chunked(socket: &mut TcpStream, mut raw: Vec<u8>) -> Option<Vec<u8>> {
        let mut body = Vec::new();
        let mut pos = 0;
        loop {
            let line_end = loop {
                if let Some(i) = find(&raw[pos..], b"\r\n") {
                    break pos + i;
                }
                read_more(socket, &mut raw).await?;
            };
            let size_line = String::from_utf8_lossy(&raw[pos..line_end]).into_owned();
            let size = usize::from_str_radix(size_line.split(';').next()?.trim(), 16).ok()?;
            pos = line_end + 2;
            if size == 0 {
                return Some(body);
            }
            while raw.len() < pos + size + 2 {
                read_more(socket, &mut raw).await?;
            }
            body.extend_from_slice(&raw[pos..pos + size]);
            pos += size + 2;
        }
    }

    fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack.windows(needle.len()).position(|window| window == needle)
    }

    fn parse_multipart(content_type: &str, body: &[u8]) -> Vec<FormPart> {
        let Some(boundary) = content_type
            .split(';')
            .find_map(|param| param.trim().strip_prefix("boundary="))
        else {
            return Vec::new();
        };
        let delimiter = format!("--{}", boundary.trim_matches('"'));
        let delimiter = delimiter.as_bytes();
        let mut parts = Vec::new();
        let Some(first) = find(body, delimiter) else {
            return parts;
        };
        let mut rest = &body[first + delimiter.len()..];
        while !rest.starts_with(b"--") {
            rest = rest.strip_prefix(b"\r\n").unwrap_or(rest);
            let Some(end) = find(rest, delimiter) else {
                break;
            };
            let part = &rest[..end];
            let part = part.strip_suffix(b"\r\n").unwrap_or(part);
            if let Some(split) = find(part, b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&part[..split]).into_owned();
                let mut form_part = FormPart {
                    name: String::new(),
                    filename: None,
                    content_type: None,
                    data: part[split + 4..].to_vec(),
                };
                for line in head.split("\r\n") {
                    let Some((key, value)) = line.split_once(':') else {
                        continue;
                    };
                    if key.eq_ignore_ascii_case("content-disposition") {
                        for attr in value.split(';').map(str::trim) {
                            if let Some(v) = attr.strip_prefix("name=") {
                                form_part.name = v.trim_matches('"').to_string();
                            }
                            if let Some(v) = attr.strip_prefix("filename=") {
                                form_part.filename = Some(v.trim_matches('"').to_string());
                            }
                        }
                    } else if key.eq_ignore_ascii_case("content-type") {
                        form_part.content_type = Some(value.trim().to_string());
                    }
                }
                parts.push(form_part);
            }
            rest = &rest[end + delimiter.len()..];
        }
        parts
    }

    // ── Audio and engine helpers ──

    /// A square wave: RMS and peak are both `amplitude`.
    fn speech(ms: usize, amplitude: i16) -> Vec<i16> {
        (0..ms * SAMPLES_PER_MS).map(|i| if i % 2 == 0 { amplitude } else { -amplitude }).collect()
    }

    fn silence(ms: usize) -> Vec<i16> {
        vec![0; ms * SAMPLES_PER_MS]
    }

    fn config(base_url: &str) -> OpenAICompatSttConfig {
        OpenAICompatSttConfig {
            base_url: base_url.to_string(),
            model: "whisper-test".to_string(),
            pause_split_ms: 300,
            request_timeout_secs: 10,
            ..OpenAICompatSttConfig::default()
        }
    }

    struct Running {
        stt: OpenAICompatSTT,
        config: Arc<RwLock<OpenAICompatSttConfig>>,
        results: mpsc::Receiver<TranscriptResult>,
        notices: Arc<Mutex<Vec<Notice>>>,
        /// Capture clock of the next chunk.
        clock_ms: u64,
    }

    async fn start(cfg: OpenAICompatSttConfig, api_key: Option<&str>, language: &str) -> Running {
        let config = Arc::new(RwLock::new(cfg));
        let mut stt = OpenAICompatSTT::new(config.clone(), api_key.map(str::to_string));
        stt.set_language(language);
        stt.set_party("Them");
        let notices = stt.record_notices();
        let (tx, results) = mpsc::channel(256);
        stt.start_stream(tx).await.unwrap();
        Running { stt, config, results, notices, clock_ms: T0 }
    }

    impl Running {
        /// Feeds `pcm` in 100 ms chunks.
        async fn feed(&mut self, pcm: &[i16]) {
            for chunk in pcm.chunks(1600) {
                let timestamp_ms = self.clock_ms;
                self.clock_ms += samples_to_ms(chunk.len());
                let chunk = AudioChunk {
                    pcm_data: chunk.to_vec(),
                    source: AudioSource::System,
                    timestamp_ms,
                    is_speech: false,
                };
                self.stt.feed_audio(chunk).await.unwrap();
            }
        }

        /// 0.6 s of speech and a 0.3 s pause: one segment (pause_split_ms = 300).
        async fn phrase(&mut self, amplitude: i16) {
            self.feed(&[speech(600, amplitude), silence(300)].concat()).await;
        }

        /// Stops the stream; every result it produced and what it reported.
        async fn stop(mut self) -> (Vec<TranscriptResult>, Vec<Notice>) {
            self.stt.stop_stream().await.unwrap();
            let mut results = Vec::new();
            while let Ok(Some(result)) =
                tokio::time::timeout(Duration::from_secs(5), self.results.recv()).await
            {
                results.push(result);
            }
            let notices = self.notices.lock().unwrap().clone();
            (results, notices)
        }
    }

    fn finals(results: &[TranscriptResult]) -> Vec<String> {
        results.iter().filter(|r| r.is_final).map(|r| r.text.clone()).collect()
    }

    fn statuses(notices: &[Notice]) -> Vec<(String, Option<String>)> {
        notices
            .iter()
            .filter_map(|notice| match notice {
                Notice::Status { status, message } => Some((status.clone(), message.clone())),
                Notice::Debug { .. } => None,
            })
            .collect()
    }

    fn debug_lines(notices: &[Notice], wanted: &str) -> Vec<String> {
        notices
            .iter()
            .filter_map(|notice| match notice {
                Notice::Debug { level, message } if level == wanted => Some(message.clone()),
                _ => None,
            })
            .collect()
    }

    // ── Addresses ──

    fn with_urls(base_url: &str, url_override: &str) -> OpenAICompatSttConfig {
        OpenAICompatSttConfig {
            base_url: base_url.to_string(),
            url_override: url_override.to_string(),
            ..OpenAICompatSttConfig::default()
        }
    }

    #[test]
    fn transcription_urls_follow_the_endpoint_rules() {
        let url = |base: &str| String::from(transcriptions_url(&with_urls(base, "")).unwrap());
        assert_eq!(url("http://10.0.0.5:8000/v1"), "http://10.0.0.5:8000/v1/audio/transcriptions");
        assert_eq!(url(" http://10.0.0.5:8000/v1/ "), "http://10.0.0.5:8000/v1/audio/transcriptions");
        // The version prefix is used as typed, never added.
        assert_eq!(url("http://10.0.0.5:8000"), "http://10.0.0.5:8000/audio/transcriptions");
        assert_eq!(
            url("https://ark.cn-beijing.volces.com/api/v3"),
            "https://ark.cn-beijing.volces.com/api/v3/audio/transcriptions"
        );
        // A full transcription URL pasted as the base is used as is.
        assert_eq!(
            url("http://gpu.lan:8000/v1/audio/transcriptions"),
            "http://gpu.lan:8000/v1/audio/transcriptions"
        );
        // The query is kept.
        assert_eq!(
            url("https://gw.example.com/stt/v1?api-version=2024"),
            "https://gw.example.com/stt/v1/audio/transcriptions?api-version=2024"
        );
    }

    #[test]
    fn the_override_is_used_as_typed() {
        let cfg = with_urls("http://ignored:1/v1", " https://gw.example.com/whisper/transcribe/?token=abc ");
        assert_eq!(
            transcriptions_url(&cfg).unwrap().as_str(),
            "https://gw.example.com/whisper/transcribe/?token=abc"
        );
        assert_eq!(transcriptions_url(&with_urls("", "ftp://h/x")).unwrap_err().code, "invalid_url");
        assert_eq!(transcriptions_url(&with_urls("", "localhost:9000/x")).unwrap_err().code, "invalid_url");
    }

    #[test]
    fn bad_addresses_are_named() {
        assert_eq!(transcriptions_url(&with_urls("", "")).unwrap_err().code, "no_base_url");
        assert_eq!(transcriptions_url(&with_urls("   ", "  ")).unwrap_err().code, "no_base_url");
        let err = transcriptions_url(&with_urls("192.168.1.10:8000/v1", "")).unwrap_err();
        assert_eq!(err.code, "invalid_url");
        assert!(err.message.contains("http://192.168.1.10:8000/v1"), "{}", err.message);
        assert_eq!(transcriptions_url(&with_urls("ftp://h/v1", "")).unwrap_err().code, "invalid_url");
    }

    #[test]
    fn models_are_listed_next_to_the_transcriptions() {
        let models = |base: &str, over: &str| models_url(&with_urls(base, over)).map(String::from);
        assert_eq!(models("http://10.0.0.5:8000/v1", "").unwrap(), "http://10.0.0.5:8000/v1/models");
        assert_eq!(
            models("http://10.0.0.5:8000/v1/audio/transcriptions", "").unwrap(),
            "http://10.0.0.5:8000/v1/models"
        );
        assert_eq!(
            models("https://gw.example.com/stt/v1?api-version=2024", "").unwrap(),
            "https://gw.example.com/stt/v1/models?api-version=2024"
        );
        assert_eq!(models("", "http://h:9000/v1/audio/transcriptions").unwrap(), "http://h:9000/v1/models");
        assert_eq!(
            models("http://a:1/v1", "http://b:2/x/audio/transcriptions").unwrap(),
            "http://a:1/v1/models"
        );
        assert!(models("", "https://gw.example.com/whisper/transcribe").is_err());
        assert!(models("", "").is_err());
    }

    // ── Responses and text ──

    #[test]
    fn transcripts_are_read_from_every_response_shape() {
        let parse = parse_transcription_response;
        assert_eq!(parse(r#"{"text":" Hello world. "}"#).as_deref(), Some("Hello world."));
        assert_eq!(
            parse(r#"{"task":"transcribe","language":"zh","duration":1.5,"text":"你好","segments":[{"text":"你好"}]}"#)
                .as_deref(),
            Some("你好")
        );
        // LocalAI
        assert_eq!(
            parse(r#"{"segments":[{"id":0,"text":" Hello"},{"id":1,"text":" world"}]}"#).as_deref(),
            Some("Hello world")
        );
        assert_eq!(
            parse(r#"{"text":"","segments":[{"text":"你好"},{"text":"世界"}]}"#).as_deref(),
            Some("你好世界")
        );
        assert_eq!(parse(r#""a bare string""#).as_deref(), Some("a bare string"));
        // response_format=text
        assert_eq!(parse("Plain text answer\n").as_deref(), Some("Plain text answer"));
        assert_eq!(parse("first line\nsecond line").as_deref(), Some("first line second line"));
        assert_eq!(parse("42").as_deref(), Some("42"));
        assert_eq!(parse("\u{feff}{\"text\":\"BOM\"}").as_deref(), Some("BOM"));
        assert_eq!(parse(r#"{"text":""}"#), None);
        assert_eq!(parse(r#"{"text":"   "}"#), None);
        assert_eq!(parse(r#"{"error":{"message":"model not loaded"}}"#), None);
        assert_eq!(parse("  \n"), None);
        assert_eq!(parse("null"), None);

        assert_eq!(
            error_in_body(r#"{"error":{"message":"model not loaded"}}"#).as_deref(),
            Some("model not loaded")
        );
        assert_eq!(error_in_body(r#"{"error":"boom"}"#).as_deref(), Some("boom"));
        assert_eq!(error_in_body(r#"{"text":""}"#), None);
    }

    #[test]
    fn model_lists_come_in_several_shapes() {
        assert_eq!(
            parse_model_ids(r#"{"object":"list","data":[{"id":"whisper-1"},{"id":"Systran/faster-whisper-small"}]}"#),
            ["whisper-1", "Systran/faster-whisper-small"]
        );
        assert_eq!(parse_model_ids(r#"{"models":["a",{"id":"b"},{"name":"c"},"a",""]}"#), ["a", "b", "c"]);
        assert!(parse_model_ids("<html>hi</html>").is_empty());
        assert!(parse_model_ids(r#"{"data":"nope"}"#).is_empty());
    }

    #[test]
    fn whisper_hallucinations_are_filtered_in_english_and_chinese() {
        for text in [
            "Thank you.",
            "thanks for watching!",
            " you ",
            "Bye!",
            "[BLANK_AUDIO]",
            "Subtitles by the Amara.org community",
            "...",
            "♪♪",
            "字幕由Amara.org社区提供",
            "请不吝点赞 订阅 转发 打赏支持明镜与点点栏目",
            "請不吝點贊 訂閱 轉發 打賞支持明鏡與點點欄目",
            "谢谢观看。",
            "感谢收看！",
            "谢谢 收看",
            "優優獨播劇場——YoYo Television Series Exclusive",
            "中文字幕",
            "字幕志愿者 李宗盛",
            "请订阅",
            "点赞订阅",
            "ご視聴ありがとうございました。",
            "시청해주셔서 감사합니다.",
        ] {
            assert!(is_hallucination(text), "should be filtered: {text}");
        }
        for text in [
            "谢谢",
            "谢谢！",
            "好的，谢谢大家",
            "Thank you for the update on the budget.",
            "我们看一下字幕的问题",
            "订阅制的收入怎么样？",
            "OK",
        ] {
            assert!(!is_hallucination(text), "should be kept: {text}");
        }
    }

    #[test]
    fn lines_join_latin_with_a_space_and_cjk_without() {
        let joined = |a: &str, b: &str| {
            let mut text = a.to_string();
            join_text(&mut text, b);
            text
        };
        assert_eq!(joined("Hello", " world "), "Hello world");
        assert_eq!(joined("你好", "世界"), "你好世界");
        assert_eq!(joined("我们用", "Rust"), "我们用Rust");
        assert_eq!(joined("OK", "我们开始"), "OK我们开始");
        assert_eq!(joined("你好。", "Hello"), "你好。Hello");
        assert_eq!(joined("好的，", "next"), "好的，next");
        assert_eq!(joined("こんにちは", "世界"), "こんにちは世界");
        assert_eq!(joined("안녕하세요", "반갑습니다"), "안녕하세요 반갑습니다");
        assert_eq!(joined("", "Hello"), "Hello");
        assert_eq!(joined("Hello", "  "), "Hello");
    }

    #[test]
    fn an_utterance_collects_segments_until_finished() {
        let mut line = Utterance::default();
        let first = line.push("Hello", T0, 1000).unwrap();
        assert!(!first.is_final);
        assert_eq!(first.text, "Hello");
        assert_eq!(first.segment_id.as_deref(), Some("oc_utt_1"));
        assert_eq!(line.push("world.", T0 + 1000, 1000).unwrap().text, "Hello world.");
        let done = line.finish().unwrap();
        assert!(done.is_final);
        assert_eq!(done.text, "Hello world.");
        assert_eq!(done.timestamp_ms, T0);
        assert_eq!(done.duration_ms, Some(2000));
        assert_eq!(done.confidence, CONFIDENCE);
        assert!(line.finish().is_none());

        let next = line.push("我们", T0 + 5000, 1000).unwrap();
        assert_eq!(next.segment_id.as_deref(), Some("oc_utt_2"));
        assert_eq!(next.timestamp_ms, T0 + 5000);
        assert_eq!(line.push("开始吧。", T0 + 6000, 800).unwrap().text, "我们开始吧。");
        assert_eq!(line.finish().unwrap().duration_ms, Some(1800));
        assert!(line.push("  ", T0, 10).is_none());
    }

    #[test]
    fn a_long_utterance_is_finalized_without_a_pause() {
        let mut line = Utterance::default();
        for i in 0..5 {
            assert!(!line.push("word", T0 + i * 5000, 5000).unwrap().is_final);
        }
        let capped = line.push("word", T0 + 25_000, 5000).unwrap();
        assert!(capped.is_final);
        assert_eq!(capped.duration_ms, Some(MAX_UTTERANCE_MS));
        assert!(line.finish().is_none());
    }

    // ── Segmentation and queue ──

    fn limits(segment_secs: f32, pause_ms: u32) -> Limits {
        Limits::of(&OpenAICompatSttConfig {
            segment_duration_secs: segment_secs,
            pause_split_ms: pause_ms,
            ..OpenAICompatSttConfig::default()
        })
    }

    fn push_all(segmenter: &mut Segmenter, pcm: &[i16], clock: &mut u64, limits: &Limits) -> Vec<Cut> {
        let mut cuts = Vec::new();
        for chunk in pcm.chunks(1600) {
            cuts.extend(segmenter.push(chunk, *clock, limits));
            *clock += samples_to_ms(chunk.len());
        }
        cuts
    }

    #[test]
    fn settings_are_clamped() {
        let cfg = OpenAICompatSttConfig {
            segment_duration_secs: 90.0,
            pause_split_ms: 10,
            request_timeout_secs: 1,
            max_in_flight: 9,
            ..OpenAICompatSttConfig::default()
        };
        assert_eq!(
            Limits::of(&cfg),
            Limits {
                segment_samples: 30 * SAMPLE_RATE as usize,
                pause_samples: 300 * SAMPLES_PER_MS,
                timeout: Duration::from_secs(5),
                max_in_flight: 2,
            }
        );
        let odd = OpenAICompatSttConfig {
            segment_duration_secs: f32::NAN,
            pause_split_ms: 60_000,
            request_timeout_secs: 999,
            max_in_flight: 0,
            ..OpenAICompatSttConfig::default()
        };
        let limits = Limits::of(&odd);
        assert_eq!(limits.segment_samples, 5 * SAMPLE_RATE as usize);
        assert_eq!(limits.pause_samples, 5000 * SAMPLES_PER_MS);
        assert_eq!(limits.timeout, Duration::from_secs(120));
        assert_eq!(limits.max_in_flight, 1);
    }

    #[test]
    fn a_pause_ends_a_segment_and_silence_is_kept_only_as_a_lead_in() {
        let limits = limits(5.0, 300);
        let mut segmenter = Segmenter::default();
        let mut clock = T0;
        let pcm = [silence(1000), speech(600, 1000), silence(300)].concat();
        let cuts = push_all(&mut segmenter, &pcm, &mut clock, &limits);
        let [Cut::Speech { segment, pause_after }] = cuts.as_slice() else {
            panic!("one speech segment expected: {cuts:?}");
        };
        assert!(*pause_after);
        // 0.3 s lead-in + 0.6 s of speech; the pause is trimmed.
        assert_eq!(segment.samples.len(), 900 * SAMPLES_PER_MS);
        assert_eq!(segment.start_ms, T0 + 700);
        assert_eq!(segment.duration_ms(), 900);

        // Silence alone never becomes a segment.
        assert!(push_all(&mut segmenter, &silence(10_000), &mut clock, &limits).is_empty());
        assert!(segmenter.flush(&limits).is_none());
    }

    #[test]
    fn continuous_speech_is_cut_at_the_segment_length() {
        let limits = limits(1.0, 1500);
        let mut segmenter = Segmenter::default();
        let mut clock = T0;
        let cuts = push_all(&mut segmenter, &speech(2500, 1000), &mut clock, &limits);
        assert_eq!(cuts.len(), 2);
        for (i, cut) in cuts.iter().enumerate() {
            let Cut::Speech { segment, pause_after } = cut else { panic!("{cut:?}") };
            assert!(!pause_after);
            assert_eq!(segment.seq, i as u64 + 1);
            assert_eq!(segment.samples.len(), SAMPLE_RATE as usize);
            assert_eq!(segment.start_ms, T0 + 1000 * i as u64);
        }
        let Some(Cut::Speech { segment, .. }) = segmenter.flush(&limits) else {
            panic!("the last 0.5 s is flushed");
        };
        assert_eq!(segment.duration_ms(), 500);
        assert_eq!(segment.start_ms, T0 + 2000);
    }

    #[test]
    fn short_or_quiet_audio_is_handled() {
        // 0.3 s is too short to split at the pause: sent when the buffer is full.
        let limits = limits(1.0, 300);
        let mut segmenter = Segmenter::default();
        let mut clock = T0;
        let pcm = [speech(300, 1000), silence(2000)].concat();
        let cuts = push_all(&mut segmenter, &pcm, &mut clock, &limits);
        let [Cut::Speech { segment, pause_after: true }] = cuts.as_slice() else {
            panic!("{cuts:?}");
        };
        assert_eq!(segment.duration_ms(), 300);

        // Below the threshold throughout: never sent.
        assert!(push_all(&mut segmenter, &speech(3000, 50), &mut clock, &limits).is_empty());
        assert!(segmenter.flush(&limits).is_none());

        // Loud chunks but a quiet segment overall: cut, not sent.
        let pcm: Vec<i16> = (0..5).flat_map(|_| [speech(100, 120), silence(100)].concat()).collect();
        let cuts = push_all(&mut segmenter, &pcm, &mut clock, &limits);
        assert!(matches!(cuts.as_slice(), [Cut::Silent { .. }]), "{cuts:?}");
    }

    #[test]
    fn a_full_queue_turns_its_oldest_waiting_segment_into_a_pause() {
        let queue = SegmentQueue::default();
        let segment = |seq| Segment { seq, samples: vec![1000; 16_000], start_ms: T0 };
        for seq in 1..=4 {
            assert_eq!(queue.push_segment(segment(seq)), None);
            queue.push_pause();
        }
        assert_eq!(queue.push_segment(segment(5)), Some(Dropped { seq: 1, duration_ms: 1000 }));
        queue.push_pause();
        assert_eq!(queue.push_segment(segment(6)), Some(Dropped { seq: 2, duration_ms: 1000 }));
        let jobs: Vec<String> = queue
            .lock()
            .jobs
            .iter()
            .map(|job| match job {
                Job::Transcribe(segment) => segment.seq.to_string(),
                Job::Pause => "pause".to_string(),
            })
            .collect();
        assert_eq!(jobs, ["pause", "3", "pause", "4", "pause", "5", "pause", "6"]);
        assert_eq!(queue.waiting(), 4);
    }

    // ── The stream against a fake server ──

    #[tokio::test]
    async fn requests_carry_the_party_language_and_no_auth_without_a_key() {
        let server = FakeServer::start(|_| Reply::json(r#"{"text":"你好"}"#)).await;
        let mut cfg = config(&server.url("/v1"));
        cfg.model = "Systran/faster-whisper-small".to_string();
        cfg.prompt = "NexQ 会议".to_string();
        cfg.temperature = 0.2;
        let mut run = start(cfg, None, "zh-CN").await;
        run.phrase(1000).await;
        let (results, _) = run.stop().await;
        assert_eq!(finals(&results), ["你好"]);

        let requests = server.transcriptions();
        assert_eq!(requests.len(), 1);
        let request = &requests[0];
        assert_eq!(request.method, "POST");
        assert_eq!(request.target, "/v1/audio/transcriptions");
        assert_eq!(request.header("authorization"), None);
        assert_eq!(request.field("model").as_deref(), Some("Systran/faster-whisper-small"));
        assert_eq!(request.field("language").as_deref(), Some("zh"));
        assert_eq!(request.field("response_format").as_deref(), Some("json"));
        assert_eq!(request.field("temperature").as_deref(), Some("0.2"));
        assert_eq!(request.field("prompt").as_deref(), Some("NexQ 会议"));
        let file = request.form().into_iter().find(|part| part.name == "file").unwrap();
        assert_eq!(file.filename.as_deref(), Some("audio.wav"));
        assert_eq!(file.content_type.as_deref(), Some("audio/wav"));
        assert!(file.data.starts_with(b"RIFF"));
        assert_eq!(u32::from_le_bytes(file.data[24..28].try_into().unwrap()), SAMPLE_RATE);
        // 0.6 s of speech, the pause trimmed.
        assert_eq!(request.wav_samples().len(), 600 * SAMPLES_PER_MS);
    }

    #[tokio::test]
    async fn auto_detect_leaves_the_language_out_and_a_key_is_sent_as_bearer() {
        let server = FakeServer::start(|_| Reply::text("Hello there\n")).await;
        let mut cfg = config(&server.url("/v1"));
        cfg.response_format = "text".to_string();
        let mut run = start(cfg, Some("sk-local"), "auto").await;
        run.phrase(1000).await;
        let (results, _) = run.stop().await;
        assert_eq!(finals(&results), ["Hello there"]);

        let request = &server.transcriptions()[0];
        assert_eq!(request.header("authorization"), Some("Bearer sk-local"));
        assert_eq!(request.field("language"), None);
        assert_eq!(request.field("prompt"), None);
        assert_eq!(request.field("response_format").as_deref(), Some("text"));
        assert_eq!(request.field("model").as_deref(), Some("whisper-test"));
    }

    #[tokio::test]
    async fn results_keep_submission_order_with_two_requests_in_flight() {
        let gate = Arc::new(Semaphore::new(0));
        let first_gate = gate.clone();
        let server = FakeServer::start(move |request| match request.peak() {
            1000 => Reply::json(r#"{"text":"first"}"#).gated(&first_gate),
            _ => Reply::json(r#"{"text":"second"}"#),
        })
        .await;
        let mut cfg = config(&server.url("/v1"));
        cfg.max_in_flight = 2;
        let mut run = start(cfg, None, "en-US").await;
        run.phrase(1000).await;
        run.phrase(2000).await;
        // Both requests reach the server while the first one is held, so the
        // second one is answered first.
        server.wait_for(2).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        gate.add_permits(1);
        let (results, notices) = run.stop().await;

        let shown: Vec<(&str, bool)> = results.iter().map(|r| (r.text.as_str(), r.is_final)).collect();
        assert_eq!(shown, [("first", false), ("first", true), ("second", false), ("second", true)]);
        assert_eq!(results[1].timestamp_ms, T0);
        assert_eq!(results[1].duration_ms, Some(600));
        assert_eq!(results[3].timestamp_ms, T0 + 900);
        assert_eq!(results[3].segment_id.as_deref(), Some("oc_utt_2"));
        assert_eq!(statuses(&notices), [("connected".to_string(), None)]);
    }

    #[tokio::test]
    async fn an_overflowing_queue_drops_the_oldest_waiting_segment() {
        let gate = Arc::new(Semaphore::new(0));
        let first_gate = gate.clone();
        let server = FakeServer::start(move |request| {
            let peak = request.peak();
            let reply = Reply::json(&format!(r#"{{"text":"s{}"}}"#, peak / 1000));
            if peak == 1000 { reply.gated(&first_gate) } else { reply }
        })
        .await;
        let mut run = start(config(&server.url("/v1")), None, "en-US").await;
        run.phrase(1000).await;
        server.wait_for(1).await;
        // Six more while #1 is held: #2 and #3 have to go.
        for amplitude in [2000, 3000, 4000, 5000, 6000, 7000] {
            run.phrase(amplitude).await;
        }
        gate.add_permits(1);
        let (results, notices) = run.stop().await;

        let peaks: Vec<i16> = server.transcriptions().iter().map(Recorded::peak).collect();
        assert_eq!(peaks, [1000, 4000, 5000, 6000, 7000]);
        assert_eq!(finals(&results), ["s1", "s4", "s5", "s6", "s7"]);
        let warnings = debug_lines(&notices, "warn");
        assert_eq!(warnings.len(), 2, "{warnings:?}");
        assert!(warnings[0].contains("dropped segment #2"), "{}", warnings[0]);
        assert!(warnings[1].contains("dropped segment #3"), "{}", warnings[1]);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn feed_audio_never_waits_for_a_stalled_server() {
        let gate = Arc::new(Semaphore::new(0));
        let server_gate = gate.clone();
        let server = FakeServer::start(move |_| Reply::json(r#"{"text":"ok"}"#).gated(&server_gate)).await;
        let mut run = start(config(&server.url("/v1")), None, "en-US").await;
        run.phrase(1000).await;
        server.wait_for(1).await;

        let phrase = [speech(600, 1000), silence(300)].concat();
        let mut slowest = Duration::ZERO;
        let started = Instant::now();
        for _ in 0..40 {
            for chunk in phrase.chunks(1600) {
                let timestamp_ms = run.clock_ms;
                run.clock_ms += 100;
                let chunk = AudioChunk {
                    pcm_data: chunk.to_vec(),
                    source: AudioSource::Mic,
                    timestamp_ms,
                    is_speech: true,
                };
                let call = Instant::now();
                run.stt.feed_audio(chunk).await.unwrap();
                slowest = slowest.max(call.elapsed());
            }
        }
        let total = started.elapsed();
        assert!(slowest < Duration::from_millis(50), "slowest feed_audio: {slowest:?}");
        assert!(total < Duration::from_secs(1), "40 segments took {total:?}");
        assert_eq!(server.requests().len(), 1, "still stalled on the first request");

        gate.add_permits(1000);
        let (results, notices) = run.stop().await;
        // The held one plus the 4 newest waiting ones.
        assert_eq!(server.transcriptions().len(), 5);
        assert_eq!(finals(&results).len(), 5);
        assert_eq!(debug_lines(&notices, "warn").len(), 36);
    }

    #[tokio::test]
    async fn stop_gives_up_on_a_server_that_never_answers() {
        let gate = Arc::new(Semaphore::new(0));
        let server_gate = gate.clone();
        let server = FakeServer::start(move |_| Reply::json(r#"{"text":"late"}"#).gated(&server_gate)).await;
        let mut cfg = config(&server.url("/v1"));
        cfg.request_timeout_secs = 5;
        let mut run = start(cfg, None, "en-US").await;
        for amplitude in [1000, 2000, 3000] {
            run.phrase(amplitude).await;
        }
        server.wait_for(1).await;
        let started = Instant::now();
        let (results, notices) = run.stop().await;
        let elapsed = started.elapsed();
        // The request timeout (5 s) + 2 s, though two segments were still pending.
        assert!(elapsed >= Duration::from_secs(6), "{elapsed:?}");
        assert!(elapsed < Duration::from_secs(9), "{elapsed:?}");
        assert!(results.is_empty());
        let statuses = statuses(&notices);
        assert_eq!(statuses.len(), 1, "{statuses:?}");
        assert!(statuses[0].1.as_deref().unwrap().contains("No answer from"), "{statuses:?}");
        let warnings = debug_lines(&notices, "warn");
        assert!(
            warnings.iter().any(|w| w.contains("Stopped waiting for the server after 7 s")),
            "{warnings:?}"
        );
    }

    #[tokio::test]
    async fn http_errors_reach_the_dev_log_every_time_and_the_status_once() {
        let server = FakeServer::start(|_| Reply::status(404, r#"{"detail":"Not Found"}"#)).await;
        let mut run = start(config(&server.url("/v1")), None, "en-US").await;
        for amplitude in [1000, 2000, 3000] {
            run.phrase(amplitude).await;
        }
        let (results, notices) = run.stop().await;
        assert!(results.is_empty());

        let url = server.url("/v1/audio/transcriptions");
        let errors = debug_lines(&notices, "error");
        assert_eq!(errors.len(), 3, "{errors:?}");
        for error in &errors {
            assert!(error.starts_with("[Them] Segment #"), "{error}");
            assert!(error.contains("HTTP 404 Not Found") && error.contains(&url), "{error}");
            assert!(error.contains(r#"{"detail":"Not Found"}"#), "{error}");
        }
        let statuses = statuses(&notices);
        assert_eq!(statuses.len(), 1, "{statuses:?}");
        assert_eq!(statuses[0].0, "error");
        let message = statuses[0].1.as_deref().unwrap();
        assert!(message.contains("check the version prefix of the Base URL"), "{message}");
        assert!(message.contains(&url), "{message}");
    }

    #[tokio::test]
    async fn consecutive_segments_form_one_line_until_stop() {
        let server = FakeServer::start(|request| {
            Reply::json(match request.peak() {
                1000 => r#"{"text":"我们"}"#,
                2000 => r#"{"text":"今天"}"#,
                _ => r#"{"text":"开会。"}"#,
            })
        })
        .await;
        let mut cfg = config(&server.url("/v1"));
        cfg.segment_duration_secs = 1.0;
        let mut run = start(cfg, None, "zh-CN").await;
        run.feed(&[speech(1000, 1000), speech(1000, 2000), speech(500, 3000)].concat()).await;
        let (results, _) = run.stop().await;

        let shown: Vec<(&str, bool)> = results.iter().map(|r| (r.text.as_str(), r.is_final)).collect();
        assert_eq!(
            shown,
            [("我们", false), ("我们今天", false), ("我们今天开会。", false), ("我们今天开会。", true)]
        );
        let last = results.last().unwrap();
        assert_eq!(last.timestamp_ms, T0);
        assert_eq!(last.duration_ms, Some(2500));
        assert!(results.iter().all(|r| r.segment_id.as_deref() == Some("oc_utt_1")));
    }

    #[tokio::test]
    async fn hallucinations_and_empty_answers_end_the_line() {
        let server = FakeServer::start(|request| {
            Reply::json(match request.peak() {
                1000 => r#"{"text":" Hello"}"#,
                2000 => r#"{"text":"谢谢观看！"}"#,
                3000 => r#"{"text":""}"#,
                _ => r#"{"text":"谢谢"}"#,
            })
        })
        .await;
        let mut cfg = config(&server.url("/v1"));
        cfg.segment_duration_secs = 1.0;
        let mut run = start(cfg, None, "auto").await;
        let pcm = [speech(1000, 1000), speech(1000, 2000), speech(1000, 3000), speech(1000, 4000)].concat();
        run.feed(&pcm).await;
        let (results, notices) = run.stop().await;
        assert_eq!(finals(&results), ["Hello", "谢谢"]);
        let info = debug_lines(&notices, "info");
        assert!(info.iter().any(|m| m.contains("filtered hallucination \"谢谢观看！\"")), "{info:?}");
        assert!(info.iter().any(|m| m.contains("no speech heard")), "{info:?}");
    }

    #[tokio::test]
    async fn settings_apply_from_the_next_request() {
        let server = FakeServer::start(|_| Reply::json(r#"{"text":"ok"}"#)).await;
        let mut run = start(config(&server.url("/v1")), None, "en-US").await;
        run.phrase(1000).await;
        server.wait_for(1).await;
        run.config.write().unwrap().model = "large-v3".to_string();
        run.phrase(2000).await;
        let _ = run.stop().await;
        let models: Vec<String> = server.transcriptions().iter().filter_map(|r| r.field("model")).collect();
        assert_eq!(models, ["whisper-test", "large-v3"]);
    }

    #[tokio::test]
    async fn a_stream_without_a_base_url_does_not_start() {
        let mut stt = OpenAICompatSTT::new(Arc::new(RwLock::new(OpenAICompatSttConfig::default())), None);
        let (tx, _rx) = mpsc::channel(8);
        let err = stt.start_stream(tx).await.unwrap_err();
        assert!(err.to_string().contains("Base URL"), "{err}");
        // Feeding or stopping a stream that never started does nothing.
        let chunk = AudioChunk {
            pcm_data: speech(100, 1000),
            source: AudioSource::Mic,
            timestamp_ms: T0,
            is_speech: true,
        };
        stt.feed_audio(chunk).await.unwrap();
        stt.stop_stream().await.unwrap();
    }

    // ── Probe ──

    #[tokio::test]
    async fn probe_lists_the_models() {
        let server = FakeServer::start(|request| match request.path() {
            "/v1/models" => Reply::json(
                r#"{"object":"list","data":[{"id":"Systran/faster-whisper-small"},{"id":"whisper-1"}]}"#,
            ),
            _ => Reply::status(500, "unexpected"),
        })
        .await;
        let cfg = config(&server.url("/v1"));
        let result = probe(&cfg, Some("sk-local")).await;
        assert!(result.ok, "{result:?}");
        assert_eq!(result.code, "ok");
        assert_eq!(result.status, Some(200));
        assert_eq!(result.url, Some(server.url("/v1/models")));
        assert_eq!(result.models, ["Systran/faster-whisper-small", "whisper-1"]);
        let requests = server.requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].method, "GET");
        assert_eq!(requests[0].header("authorization"), Some("Bearer sk-local"));

        // The engine's test_connection is the probe.
        let stt = OpenAICompatSTT::new(Arc::new(RwLock::new(cfg)), None);
        assert!(stt.test_connection().await.unwrap());
    }

    #[tokio::test]
    async fn probe_transcribes_silence_when_the_server_lists_no_models() {
        let server = FakeServer::start(|request| match (request.method.as_str(), request.path()) {
            ("GET", "/v1/models") => Reply::status(404, r#"{"detail":"Not Found"}"#),
            ("POST", "/v1/audio/transcriptions") => Reply::json(r#"{"text":""}"#),
            _ => Reply::status(500, "unexpected"),
        })
        .await;
        let result = probe(&config(&server.url("/v1")), None).await;
        assert!(result.ok, "{result:?}");
        assert_eq!(result.code, "ok");
        assert_eq!(result.status, Some(200));
        assert_eq!(result.url, Some(server.url("/v1/audio/transcriptions")));
        assert!(result.models.is_empty());
        assert_eq!(result.detail, r#"{"text":""}"#);
        let requests = server.requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[1].wav_samples(), vec![0; SAMPLE_RATE as usize]);
        assert!(requests.iter().all(|r| r.header("authorization").is_none()));
    }

    #[tokio::test]
    async fn probe_accepts_an_unreadable_model_list() {
        let server = FakeServer::start(|_| Reply::text("<html>speaches</html>")).await;
        let result = probe(&config(&server.url("/v1")), None).await;
        assert!(result.ok, "{result:?}");
        assert!(result.models.is_empty());
        assert_eq!(server.requests().len(), 1);
    }

    #[tokio::test]
    async fn probe_reports_a_rejected_key_without_echoing_it() {
        let server =
            FakeServer::start(|_| Reply::status(401, r#"{"error":"Invalid API key sk-wrong-123"}"#)).await;
        let result = probe(&config(&server.url("/v1")), Some("sk-wrong-123")).await;
        assert!(!result.ok);
        assert_eq!(result.code, "unauthorized");
        assert_eq!(result.status, Some(401));
        assert_eq!(result.url, Some(server.url("/v1/models")));
        assert!(result.detail.contains("Invalid API key ***"), "{result:?}");
        assert!(!result.detail.contains("sk-wrong-123"), "{result:?}");
    }

    #[tokio::test]
    async fn a_key_echoed_in_an_error_is_masked_in_the_dev_log() {
        let server =
            FakeServer::start(|_| Reply::status(401, r#"{"error":"bad key sk-secret-456"}"#)).await;
        let mut run = start(config(&server.url("/v1")), Some("sk-secret-456"), "en-US").await;
        run.phrase(1000).await;
        let (_, notices) = run.stop().await;
        let errors = debug_lines(&notices, "error");
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert!(errors[0].contains("HTTP 401 Unauthorized") && errors[0].contains("check the API key"));
        assert!(errors[0].contains("bad key ***"), "{}", errors[0]);
        assert!(notices.iter().all(|n| !format!("{n:?}").contains("sk-secret-456")), "{notices:?}");
    }

    #[tokio::test]
    async fn probe_names_the_url_and_the_version_prefix_on_404() {
        let server = FakeServer::start(|_| Reply::status(404, "404 page not found")).await;
        // Host only: /models and /audio/transcriptions both miss the /v1.
        let result = probe(&config(&server.url("")), None).await;
        assert!(!result.ok);
        assert_eq!(result.code, "not_found");
        assert_eq!(result.status, Some(404));
        let url = server.url("/audio/transcriptions");
        assert_eq!(result.url.as_deref(), Some(url.as_str()));
        assert!(result.detail.contains(&url), "{}", result.detail);
        assert!(result.detail.contains("version prefix"), "{}", result.detail);
        let paths: Vec<String> = server.requests().iter().map(|r| r.path().to_string()).collect();
        assert_eq!(paths, ["/models", "/audio/transcriptions"]);
    }

    #[tokio::test]
    async fn probe_reports_an_unreachable_server() {
        // A port nothing listens on any more.
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let result = probe(&config(&format!("http://127.0.0.1:{port}/v1")), None).await;
        assert!(!result.ok);
        assert_eq!(result.code, "network", "{result:?}");
        assert_eq!(result.status, None);
        assert_eq!(result.url, Some(format!("http://127.0.0.1:{port}/v1/models")));
        assert!(!result.detail.is_empty());
    }

    #[tokio::test]
    async fn probe_checks_the_address_first() {
        let result = probe(&with_urls("", ""), None).await;
        assert_eq!((result.ok, result.code.as_str()), (false, "no_base_url"));
        let result = probe(&with_urls("localhost:8000/v1", ""), None).await;
        assert_eq!((result.ok, result.code.as_str()), (false, "invalid_url"));
        assert!(result.detail.contains("http://localhost:8000/v1"), "{}", result.detail);
    }

    #[test]
    fn helpers_cut_on_character_boundaries() {
        let text = format!("{}раз два", "a".repeat(76));
        assert_eq!(preview(&text, 80).chars().count(), 80);
        assert_eq!(preview("short", 80), "short");
        assert_eq!(cut_bytes("你好", 4), "你");
        assert_eq!(cut_bytes("abc", 10), "abc");
        assert_eq!(one_line("a\n  b\tc "), "a b c");
        assert_eq!(form_temperature(0.2), "0.2");
        assert_eq!(form_temperature(f32::NAN), "0");
        assert_eq!(form_temperature(3.0), "1");
    }
}
