// NexQ Plus: Soniox real-time engine — one WebSocket session per party.
//
// Audio (16 kHz mono s16le) goes out in ~100 ms binary frames; the start
// message carries the party's language hints and, when its
// `native_translation` is on, a one-way translation (everything into one
// language) or a two-way one (each language of a pair into the other, for
// in-person meetings). Soniox segments the speech itself (`<end>`), so each
// sentence is one transcript line (`sx{connection}_{sentence}`, the party's
// emitter adds `them_<session>_`) and its translation goes out as
// `translation_result` for exactly that line, then into the meeting's
// translations table. Protocol rules (parsing, sentence assembly, translation
// alignment, retry classes) live in `soniox_protocol.rs`; this file only does
// the I/O.
//
// Lifecycle:
// - the key goes in the handshake (`Authorization: Bearer`, marked sensitive),
//   never in the start message;
// - `feed_audio` only queues the chunk (never waits on the network): the
//   session task sends, reconnects (backoff from the protocol layer, audio
//   kept for up to 10 s) and sends keepalive while the party is muted;
// - Soniox ends a stream at 300 minutes: after 290 the connection hands over
//   to a new one at the next sentence end (at most a minute later). It ends
//   like a stop while the audio waits for the next connection, which opens
//   at once and gets that audio first;
// - stop: empty text frame, wait ≤ 5 s for `finished`, settle the last
//   sentence and its translation.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use futures::stream::SplitSink;
use futures::{SinkExt, StreamExt};
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{header::AUTHORIZATION, HeaderValue};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::audio::AudioChunk;
use crate::stt::plus_config::{SonioxConfig, SonioxRegionMode, SttProbeResult};
use crate::stt::soniox_regions::{
    self as regions, ConnectFailure, Cooldowns, LatencyTable, RegionAction, RegionKeys, RegionRouter, Step, SwitchReason,
};
use crate::stt::provider::{STTProvider, STTProviderType, TranscriptResult};
use crate::stt::soniox_protocol::{
    self as protocol, Assembler, AssemblerConfig, AssemblerEvent, Backoff, RetryClass, SentenceUpdate,
    ServerMessage, StartParams, Token, TranslationParams, TranslationUpdate,
};

type SonioxSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

const SAMPLE_RATE: u64 = 16_000;
/// Samples per audio frame sent (100 ms).
const FRAME_SAMPLES: usize = (SAMPLE_RATE / 10) as usize;
/// Audio kept while (re)connecting, sent right after the start message (10 s).
const PENDING_MAX_FRAMES: usize = 100;
/// Chunks queued between the audio loop and the session task (~20 s of 10 ms chunks).
const AUDIO_QUEUE: usize = 2048;
/// A frame whose audio starts this long after the previous one ends is a gap (mute).
const GAP_MS: u64 = 200;
/// Keepalive when no audio went out for this long (Soniox closes after 20 s).
const KEEPALIVE_AFTER: Duration = Duration::from_secs(8);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// How long stop waits for Soniox's last results (`finished`).
const FINISH_WAIT: Duration = Duration::from_secs(5);
/// stop_stream gives the session this long in all before aborting it.
const STOP_WAIT: Duration = Duration::from_secs(8);
/// Retry interval once the backoff attempts are used up (network outages).
const LONG_RETRY: Duration = Duration::from_secs(30);
const TICK: Duration = Duration::from_millis(250);
/// A connection up this long (or that delivered results) held: its later
/// failures reconnect to the same region first.
const HELD_AFTER: Duration = Duration::from_secs(3);
/// A connection up this long hands over to a new one at its next sentence end
/// (Soniox ends a stream at 300 min with `max_duration_reached`).
const ROTATE_AFTER: Duration = Duration::from_secs(290 * 60);
/// How long a due connection waits for a sentence end before it hands over anyway.
const ROTATE_WAIT_MAX: Duration = Duration::from_secs(60);

/// `NEXQ_SONIOX_TRACE=1` logs every message Soniox sends (transcript text
/// included, so it is off by default): for checking the protocol's open
/// questions with a real key (when translations arrive, how speech already in
/// the target language is marked).
fn trace_enabled() -> bool {
    static TRACE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *TRACE.get_or_init(|| std::env::var_os("NEXQ_SONIOX_TRACE").is_some_and(|v| !v.is_empty() && v != "0"))
}

/// Per-party facts a Soniox session needs besides the global config.
#[derive(Debug, Clone, Default)]
pub struct SonioxSessionOptions {
    /// "You" or "Them".
    pub party: String,
    /// This party's language ("auto" or a code).
    pub language: String,
    /// The other party's language (hints for "auto").
    pub other_language: Option<String>,
    /// What Soniox translates this party into.
    pub translation: SonioxTranslation,
    /// Prefix of the transcript segment ids this party emits ("them_ab12_"),
    /// so translations carry the full id of their line.
    pub segment_id_prefix: String,
    /// `client_reference_id` for Soniox usage logs.
    pub client_reference_id: Option<String>,
    /// Ask for speaker diarization (Them only).
    pub diarize: bool,
}

/// A party's translation by Soniox. Each language comes twice: as the
/// translation settings name it ("zh-CN": the `target_lang` of the
/// translations sent and saved, so the meeting's other translations, same
/// code, match them) and as Soniox takes it (two-letter, "zh").
#[derive(Debug, Clone, Default, PartialEq)]
pub enum SonioxTranslation {
    #[default]
    Off,
    /// Everything said goes into one language.
    OneWay { code: String, soniox: String },
    /// Each language of the pair goes into the other (the two-letter codes
    /// differ); speech in any other language is only transcribed.
    TwoWay { a_code: String, a: String, b_code: String, b: String },
}

impl SonioxTranslation {
    /// The start message's `translation`.
    fn params(&self) -> Option<TranslationParams> {
        match self {
            Self::Off => None,
            Self::OneWay { soniox, .. } => Some(TranslationParams::OneWay { target_language: soniox.clone() }),
            Self::TwoWay { a, b, .. } => {
                Some(TranslationParams::TwoWay { language_a: a.clone(), language_b: b.clone() })
            }
        }
    }

    /// Sentence assembly of one connection.
    fn assembler_config(&self) -> AssemblerConfig {
        match self {
            Self::Off => AssemblerConfig::default(),
            Self::OneWay { soniox, .. } => {
                AssemblerConfig { target_language: Some(soniox.clone()), ..AssemblerConfig::default() }
            }
            Self::TwoWay { a, b, .. } => {
                AssemblerConfig { two_way: Some((a.clone(), b.clone())), ..AssemblerConfig::default() }
            }
        }
    }

    /// The settings' code of the language a sentence was translated into
    /// (`target`, two-letter); `target` itself when none names it.
    fn target_code(&self, target: &str) -> String {
        let code = match self {
            Self::Off => None,
            Self::OneWay { code, .. } => Some(code),
            Self::TwoWay { a_code, a, b_code, b } => {
                if target.eq_ignore_ascii_case(a.trim()) {
                    Some(a_code)
                } else if target.eq_ignore_ascii_case(b.trim()) {
                    Some(b_code)
                } else {
                    None
                }
            }
        };
        code.map(|c| c.trim()).filter(|c| !c.is_empty()).unwrap_or(target).to_string()
    }
}

/// For the log: "off", "zh" (one-way), "zh↔en" (two-way).
impl std::fmt::Display for SonioxTranslation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Off => f.write_str("off"),
            Self::OneWay { soniox, .. } => f.write_str(soniox),
            Self::TwoWay { a, b, .. } => write!(f, "{}↔{}", a, b),
        }
    }
}

pub struct SonioxSTT {
    config: SonioxConfig,
    api_key: Option<String>,
    options: SonioxSessionOptions,
    app_handle: Option<AppHandle>,
    /// Sink override for tests (else built from the app handle).
    sink: Option<Arc<dyn SessionSink>>,
    /// `ROTATE_AFTER` and `ROTATE_WAIT_MAX`; tests use milliseconds.
    rotate_after: Duration,
    rotate_wait_max: Duration,
    /// Tests: the keys (else read from the keychain), the regions' WebSocket
    /// URLs, the latency table and the cooldowns (else the app-wide ones).
    region_keys: Option<RegionKeys>,
    region_ws_urls: Option<std::collections::HashMap<String, String>>,
    latency_override: Option<LatencyTable>,
    cooldowns: Option<&'static std::sync::Mutex<Cooldowns>>,
    audio_tx: Option<mpsc::Sender<AudioChunk>>,
    session: Option<tokio::task::JoinHandle<()>>,
    dropped_chunks: u64,
}

impl SonioxSTT {
    pub fn new(config: SonioxConfig, api_key: Option<String>, options: SonioxSessionOptions) -> Self {
        Self {
            config,
            api_key,
            options,
            app_handle: None,
            sink: None,
            rotate_after: ROTATE_AFTER,
            rotate_wait_max: ROTATE_WAIT_MAX,
            region_keys: None,
            region_ws_urls: None,
            latency_override: None,
            cooldowns: None,
            audio_tx: None,
            session: None,
            dropped_chunks: 0,
        }
    }

    pub fn set_app_handle(&mut self, handle: AppHandle) {
        self.app_handle = Some(handle);
    }

    /// The keys of the regions this config may use: their own keychain slots,
    /// plus the old `soniox` key (given to `new`) for `region`.
    fn read_region_keys(&self) -> RegionKeys {
        if let Some(keys) = &self.region_keys {
            return keys.clone();
        }
        let mut per_region = std::collections::HashMap::new();
        let credentials = self
            .app_handle
            .as_ref()
            .and_then(|app| app.try_state::<crate::state::AppState>())
            .and_then(|state| state.credentials.clone());
        if let Some(credentials) = credentials {
            if let Ok(cred) = credentials.lock() {
                for (region, slot) in RegionKeys::slots_needed(&self.config) {
                    if let Ok(Some(key)) = cred.get_key(&slot) {
                        per_region.insert(region.to_string(), key);
                    }
                }
            }
        }
        RegionKeys {
            per_region,
            legacy: self.api_key.clone(),
            legacy_region: self.config.fixed_region().to_string(),
        }
    }

    /// The start message for this party (also validates the extra parameters).
    fn start_message(&self) -> Result<String, String> {
        let extra = match self.config.extra_start_params.trim() {
            "" => None,
            text => match serde_json::from_str::<serde_json::Value>(text) {
                Ok(serde_json::Value::Object(map)) => Some(map),
                _ => return Err("Soniox extra start parameters must be a JSON object".to_string()),
            },
        };
        let mut hints = crate::stt::language::soniox_language_hints(&self.options.language, self.options.other_language.as_deref());
        // Two-way: both languages are expected (strict hints would cut one off otherwise).
        if let SonioxTranslation::TwoWay { a, b, .. } = &self.options.translation {
            hints.extend([a.clone(), b.clone()]);
        }
        let params = StartParams {
            model: self.config.model.trim().to_string(),
            language_hints: hints,
            language_hints_strict: self.config.language_hints_strict,
            enable_speaker_diarization: self.options.diarize,
            max_endpoint_delay_ms: Some(self.config.max_endpoint_delay_ms),
            endpoint_sensitivity: self.config.endpoint_sensitivity,
            endpoint_latency_adjustment_level: self.config.endpoint_latency_adjustment_level,
            translation: self.options.translation.params(),
            client_reference_id: self.options.client_reference_id.clone(),
            extra,
        };
        Ok(protocol::build_start_message(&params).to_string())
    }
}

#[async_trait]
impl STTProvider for SonioxSTT {
    fn provider_name(&self) -> &str {
        "Soniox"
    }

    fn provider_type(&self) -> STTProviderType {
        STTProviderType::Soniox
    }

    async fn start_stream(
        &mut self,
        result_tx: mpsc::Sender<TranscriptResult>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if self.session.is_some() {
            return Err("Stream already active".into());
        }
        let keys = self.read_region_keys();
        let usable = if self.config.uses_custom_endpoint() {
            keys.key_for(self.config.fixed_region()).is_some()
        } else {
            self.config.allowed_regions().iter().any(|r| keys.key_for(r).is_some())
        };
        if !usable {
            return Err("No Soniox key for the regions this setup may use — add one in Settings → STT → Soniox".into());
        }
        if self.config.model.trim().is_empty() {
            return Err("No Soniox model selected".into());
        }
        let start_message = self.start_message()?;
        let sink: Arc<dyn SessionSink> = match (&self.sink, &self.app_handle) {
            (Some(sink), _) => sink.clone(),
            (None, Some(app)) => Arc::new(AppSink::new(app.clone(), &self.options.party)),
            (None, None) => Arc::new(LogSink(self.options.party.clone())),
        };

        let (audio_tx, audio_rx) = mpsc::channel::<AudioChunk>(AUDIO_QUEUE);
        let session = Session {
            config: self.config.clone(),
            keys,
            ws_urls: self.region_ws_urls.clone(),
            latency_override: self.latency_override.clone(),
            cooldowns: self.cooldowns.unwrap_or_else(regions::cooldowns),
            start_message,
            segment_id_prefix: self.options.segment_id_prefix.clone(),
            diarize: self.options.diarize,
            translation: self.options.translation.clone(),
            rotate_after: self.rotate_after,
            rotate_wait_max: self.rotate_wait_max,
            sink,
            result_tx,
            seen_speakers: Default::default(),
        };
        self.audio_tx = Some(audio_tx);
        self.dropped_chunks = 0;
        self.session = Some(tokio::spawn(session.run(audio_rx)));
        Ok(())
    }

    async fn feed_audio(&mut self, chunk: AudioChunk) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(tx) = self.audio_tx.as_ref() else { return Ok(()) };
        match tx.try_send(chunk) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(_)) => {
                // The session is stuck (half-open socket): it reconnects; never block the audio loop.
                self.dropped_chunks += 1;
                if self.dropped_chunks == 1 || self.dropped_chunks % 500 == 0 {
                    log::warn!("SonioxSTT[{}]: audio queue full, {} chunk(s) dropped", self.options.party, self.dropped_chunks);
                }
            }
            // The session gave up (fatal error, already reported): nothing to do.
            Err(mpsc::error::TrySendError::Closed(_)) => {}
        }
        Ok(())
    }

    async fn stop_stream(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // Closing the queue makes the session finish the stream gracefully.
        self.audio_tx = None;
        if let Some(mut session) = self.session.take() {
            if tokio::time::timeout(STOP_WAIT, &mut session).await.is_err() {
                log::warn!("SonioxSTT[{}]: session didn't finish within {:?}, aborting", self.options.party, STOP_WAIT);
                session.abort();
            }
        }
        Ok(())
    }

    async fn test_connection(&self) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        let result = probe(&self.config, self.api_key.as_deref()).await;
        if result.ok {
            Ok(true)
        } else {
            Err(format!("{}: {}", result.code, result.detail).into())
        }
    }

    fn set_language(&mut self, language: &str) {
        self.options.language = language.to_string();
    }
}

// ── Where the session's output goes ─────────────────────────────────────────

/// Status, debug lines and translations of a session. The app sink emits
/// Tauri events and saves final translations; tests collect them.
trait SessionSink: Send + Sync {
    /// `stt_connection_status`: connecting | connected | reconnecting | error | disconnected.
    fn status(&self, status: &str, message: Option<String>);
    fn debug(&self, level: &str, message: &str);
    fn translation(&self, translation: &TranslationEvent);
    /// A diarized speaker seen for the first time ("speaker_0"), as Deepgram
    /// reports it: in-person meetings add them as speakers.
    fn speaker_detected(&self, speaker_id: &str);
    /// The region the session connects to now (status events carry it).
    fn region(&self, region: &str);
    /// The session left `from` for `to` (`soniox_region_switch`).
    fn region_switched(&self, from: &str, to: &str, reason: SwitchReason);
}

/// A `translation_result` payload (same fields as the frontend's TranslationResult).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
struct TranslationEvent {
    segment_id: String,
    original_text: String,
    translated_text: String,
    source_lang: String,
    target_lang: String,
    provider: &'static str,
    /// Later updates of the same segment replace earlier ones; the final one is
    /// saved. A final with an empty `translated_text` withdraws the partials.
    is_final: bool,
}

struct AppSink {
    app: AppHandle,
    party: String,
    region: std::sync::Mutex<Option<String>>,
}

impl AppSink {
    fn new(app: AppHandle, party: &str) -> Self {
        Self { app, party: party.to_string(), region: Default::default() }
    }

    /// Save a final translation for the running meeting (none outside a meeting).
    fn save(&self, t: &TranslationEvent) {
        let Some(state) = self.app.try_state::<crate::state::AppState>() else { return };
        let Some(meeting_id) = state.live_meeting.lock().ok().and_then(|m| m.as_ref().map(|m| m.id.clone())) else {
            return;
        };
        let Some(db) = state.database.as_ref() else { return };
        let Ok(db) = db.lock() else { return };
        if let Err(e) = crate::db::translation::save_translation(
            db.connection(),
            &t.segment_id,
            &meeting_id,
            &t.source_lang,
            &t.target_lang,
            &t.original_text,
            &t.translated_text,
            t.provider,
        ) {
            log::warn!("SonioxSTT[{}]: couldn't save a translation: {}", self.party, e);
        }
    }
}

impl SessionSink for AppSink {
    fn status(&self, status: &str, message: Option<String>) {
        let region = self.region.lock().ok().and_then(|r| r.clone());
        let _ = self.app.emit(
            "stt_connection_status",
            serde_json::json!({
                "provider": "soniox", "party": self.party, "status": status, "message": message, "region": region,
            }),
        );
    }

    fn region(&self, region: &str) {
        if let Ok(mut current) = self.region.lock() {
            *current = Some(region.to_string());
        }
    }

    fn region_switched(&self, from: &str, to: &str, reason: SwitchReason) {
        log::warn!("SonioxSTT[{}]: region {} → {} ({:?})", self.party, from, to, reason);
        crate::stt::emit_stt_debug(&self.app, "warn", "soniox",
            &format!("[{}] region {} unusable ({:?}), switching to {}", self.party, from, reason, to));
        let _ = self.app.emit(
            "soniox_region_switch",
            serde_json::json!({ "party": self.party, "from": from, "to": to, "reason": reason }),
        );
    }

    fn debug(&self, level: &str, message: &str) {
        crate::stt::emit_stt_debug(&self.app, level, "soniox", &format!("[{}] {}", self.party, message));
    }

    fn speaker_detected(&self, speaker_id: &str) {
        let _ = self.app.emit("speaker_detected", serde_json::json!({ "speaker_id": speaker_id, "meeting_id": "" }));
        log::info!("SonioxSTT[{}]: new speaker detected via diarization: {}", self.party, speaker_id);
    }

    fn translation(&self, translation: &TranslationEvent) {
        let _ = self.app.emit("translation_result", translation);
        // An empty final withdraws a partial that turned out to be no
        // translation (speech already in the target language): nothing to keep.
        if translation.is_final && !translation.translated_text.trim().is_empty() {
            self.save(translation);
        }
    }
}

/// Without an app (never in the app itself): log only.
struct LogSink(String);

impl SessionSink for LogSink {
    fn status(&self, status: &str, message: Option<String>) {
        log::info!("SonioxSTT[{}]: {} {}", self.0, status, message.unwrap_or_default());
    }

    fn debug(&self, level: &str, message: &str) {
        log::info!("SonioxSTT[{}] {}: {}", self.0, level, message);
    }

    fn translation(&self, _translation: &TranslationEvent) {}

    fn speaker_detected(&self, _speaker_id: &str) {}

    fn region(&self, region: &str) {
        log::info!("SonioxSTT[{}]: region {}", self.0, region);
    }

    fn region_switched(&self, from: &str, to: &str, reason: SwitchReason) {
        log::warn!("SonioxSTT[{}]: region {} → {} ({:?})", self.0, from, to, reason);
    }
}

// ── Audio frames and Soniox's clock ─────────────────────────────────────────

/// ~100 ms of audio, little-endian s16, with the capture time it ends at.
#[derive(Clone)]
struct Frame {
    bytes: Vec<u8>,
    samples: u64,
    captured_end_ms: u64,
}

/// Cuts incoming chunks into ~100 ms frames; a gap in capture time (mute)
/// closes the frame being built so a frame never spans it.
#[derive(Default)]
struct Framer {
    samples: Vec<i16>,
    end_ms: u64,
}

impl Framer {
    fn push(&mut self, chunk: &AudioChunk) -> Vec<Frame> {
        let mut out = Vec::new();
        let chunk_ms = chunk.pcm_data.len() as u64 * 1000 / SAMPLE_RATE;
        let chunk_start = chunk.timestamp_ms.saturating_sub(chunk_ms);
        if !self.samples.is_empty() && chunk_start > self.end_ms + GAP_MS {
            out.extend(self.take());
        }
        self.samples.extend_from_slice(&chunk.pcm_data);
        self.end_ms = chunk.timestamp_ms;
        while self.samples.len() >= FRAME_SAMPLES {
            let rest = self.samples.split_off(FRAME_SAMPLES);
            let frame_samples = std::mem::replace(&mut self.samples, rest);
            let rest_ms = self.samples.len() as u64 * 1000 / SAMPLE_RATE;
            out.push(frame(&frame_samples, self.end_ms.saturating_sub(rest_ms)));
        }
        out
    }

    /// The partial frame (at stop, or before a gap).
    fn take(&mut self) -> Option<Frame> {
        if self.samples.is_empty() {
            return None;
        }
        let samples = std::mem::take(&mut self.samples);
        Some(frame(&samples, self.end_ms))
    }
}

fn frame(samples: &[i16], captured_end_ms: u64) -> Frame {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for s in samples {
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    Frame { bytes, samples: samples.len() as u64, captured_end_ms }
}

/// Maps Soniox's clock (audio received on this connection, ms) to capture
/// time (epoch ms). Each point where sending resumes after a gap (a mute, or
/// the replay after a reconnect) records where that audio was captured.
#[derive(Default)]
struct Timeline {
    sent_samples: u64,
    /// (audio ms on Soniox's clock, epoch ms of that audio), ascending.
    resumes: Vec<(u64, u64)>,
    last_end_ms: Option<u64>,
}

impl Timeline {
    const MAX_RESUMES: usize = 1024;

    fn sent(&mut self, samples: u64, captured_end_ms: u64) {
        let start_ms = captured_end_ms.saturating_sub(samples * 1000 / SAMPLE_RATE);
        let gap = self.last_end_ms.is_none_or(|end| start_ms.abs_diff(end) > GAP_MS);
        if gap {
            self.resumes.push((self.sent_samples * 1000 / SAMPLE_RATE, start_ms));
            if self.resumes.len() > Self::MAX_RESUMES {
                self.resumes.drain(..Self::MAX_RESUMES / 2);
            }
        }
        self.last_end_ms = Some(captured_end_ms);
        self.sent_samples += samples;
    }

    fn epoch_at(&self, offset_ms: u64) -> Option<u64> {
        let &(audio_ms, epoch_ms) = self.resumes.iter().rev().find(|(audio_ms, _)| *audio_ms <= offset_ms)?;
        Some(epoch_ms + (offset_ms - audio_ms))
    }
}

fn epoch_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ── The session task ────────────────────────────────────────────────────────

struct Session {
    config: SonioxConfig,
    keys: RegionKeys,
    ws_urls: Option<std::collections::HashMap<String, String>>,
    latency_override: Option<LatencyTable>,
    cooldowns: &'static std::sync::Mutex<Cooldowns>,
    start_message: String,
    segment_id_prefix: String,
    diarize: bool,
    translation: SonioxTranslation,
    /// A connection up this long hands over to a new one at its next sentence
    /// end (`ROTATE_AFTER`), or once it waited this much longer (`ROTATE_WAIT_MAX`).
    rotate_after: Duration,
    rotate_wait_max: Duration,
    sink: Arc<dyn SessionSink>,
    result_tx: mpsc::Sender<TranscriptResult>,
    /// Diarized speakers already announced for this party.
    seen_speakers: std::sync::Mutex<std::collections::HashSet<String>>,
}

/// Why a connection ended.
enum Ended {
    /// We stopped and Soniox finished (or the wait ran out).
    Stopped,
    /// Handed over before Soniox's time limit: the next connection goes at once.
    Rotated,
    /// Lost or refused: what it means for the region, why (for the user), and
    /// whether the connection had held (`HELD_AFTER`, or results came).
    Lost(RegionAction, String, bool),
}

/// A transport failure (no error frame) as a region action: reconnect to the
/// same region, unless the socket closed for a protocol violation.
fn transport(class: RetryClass) -> RegionAction {
    match class {
        RetryClass::Fatal => RegionAction::Stop,
        class => RegionAction::SameRegion { class },
    }
}

impl Session {
    /// Where to connect, best first: the gateway, `region`, or the enabled
    /// regions with a key (`auto` waits up to `SESSION_LATENCY_BUDGET` for a
    /// stale latency test).
    async fn plan(&self) -> RegionRouter {
        let auto = self.config.region_mode == SonioxRegionMode::Auto && !self.config.uses_custom_endpoint();
        let latency = match (&self.latency_override, auto) {
            (Some(table), _) => table.clone(),
            (None, true) => regions::latency_for_session(regions::SESSION_LATENCY_BUDGET).await,
            (None, false) => LatencyTable::default(),
        };
        let cooldowns = self.cooldowns.lock().unwrap_or_else(|e| e.into_inner());
        RegionRouter::new(regions::candidates(
            &self.config,
            &self.keys,
            &latency,
            &cooldowns,
            Instant::now(),
            self.ws_urls.as_ref(),
        ))
    }

    async fn run(self, mut audio_rx: mpsc::Receiver<AudioChunk>) {
        let mut backoff = Backoff::new();
        let mut framer = Framer::default();
        let mut pending: VecDeque<Frame> = VecDeque::new();
        let mut audio_open = true;
        let mut connection = 0u32;
        // The last connection handed over: this one is planned, not a reconnect.
        let mut rotated = false;
        // Frames sent on the current connection before it held (see `remember`).
        let mut replay: VecDeque<Frame> = VecDeque::new();
        // `auto`: the latency cache stays fresh while the session runs.
        let _auto = (self.config.region_mode == SonioxRegionMode::Auto && !self.config.uses_custom_endpoint()
            && self.latency_override.is_none())
            .then(regions::auto_session_started);
        let mut router = self.plan().await;
        if router.current().is_none() {
            self.sink.status("error", Some("No Soniox key for the regions this setup may use".to_string()));
            return;
        }
        self.sink.debug("info", &format!("regions: {}", router.regions().join(" → ")));

        loop {
            connection += 1;
            let Some(target) = router.current().cloned() else {
                self.sink.status("error", Some("No Soniox region left to try".to_string()));
                return;
            };
            self.sink.region(&target.region);
            if !rotated {
                self.sink.status(if connection == 1 { "connecting" } else { "reconnecting" }, None);
            }
            let connecting = tokio::time::timeout(CONNECT_TIMEOUT, connect(&target.ws_url, &target.key));
            tokio::pin!(connecting);
            let connected = loop {
                tokio::select! {
                    result = &mut connecting => {
                        break result.unwrap_or_else(|_| Err((ConnectFailure::Network, "connection timed out".to_string())));
                    }
                    _ = drain_until_closed(&mut audio_rx, &mut framer, &mut pending, &mut audio_open), if audio_open => {
                        // A planned hand-over still owes the queued audio a final
                        // connection, including when stop arrives during its handshake.
                        if !rotated || (pending.is_empty() && framer.samples.is_empty()) {
                            break Err((ConnectFailure::Invalid, String::new()));
                        }
                    }
                }
            };
            let ended = match connected {
                Ok(ws) => {
                    backoff.on_connected(Instant::now());
                    self.connection(ws, connection, &mut audio_rx, &mut framer, &mut pending, &mut replay, &mut audio_open)
                        .await
                }
                Err((_, reason)) if !audio_open && reason.is_empty() => Ended::Stopped,
                Err((failure, reason)) => Ended::Lost(regions::action_for_connect(&failure), reason, false),
            };

            let (action, reason) = match ended {
                Ended::Stopped => break,
                // No backoff and no attempt used: the audio waiting in `pending` goes first.
                Ended::Rotated => {
                    rotated = true;
                    continue;
                }
                Ended::Lost(action, reason, held) => {
                    if held {
                        router.on_established();
                        replay.clear();
                    } else {
                        restore(&mut pending, &mut replay);
                    }
                    (action, reason)
                }
            };
            replay.clear();
            rotated = false;
            if !audio_open {
                // Stopped while the connection was failing: don't reconnect.
                self.sink.status("error", Some(reason));
                break;
            }
            let step = {
                let mut cooldowns = self.cooldowns.lock().unwrap_or_else(|e| e.into_inner());
                router.on_failure(action, &mut cooldowns, Instant::now())
            };
            let class = match step {
                Step::GiveUp => {
                    self.sink.debug("error", &format!("giving up: {}", reason));
                    self.sink.status("error", Some(reason));
                    return;
                }
                // Another region (or the same one once more) right away: no backoff.
                Step::Now { switched } => {
                    if let (Some((from, why)), Some(to)) = (switched, router.current()) {
                        self.sink.region_switched(&from, &to.region, why);
                    }
                    self.sink.debug("warn", &format!("{} — trying {} now", reason,
                        router.current().map_or("nothing", |t| t.region.as_str())));
                    continue;
                }
                Step::Backoff { class } => class,
            };
            let delay = match backoff.next_delay(class, Instant::now()) {
                Some(delay) => delay,
                None if class == RetryClass::Fatal => {
                    self.sink.debug("error", &format!("giving up: {}", reason));
                    self.sink.status("error", Some(reason));
                    return;
                }
                None => {
                    self.sink.status("error", Some(format!("{} — retrying every {} s", reason, LONG_RETRY.as_secs())));
                    LONG_RETRY
                }
            };
            self.sink.debug("warn", &format!("connection lost ({}), reconnecting in {:.1} s", reason, delay.as_secs_f32()));
            self.sink.status("reconnecting", Some(reason));
            let wait = tokio::time::sleep(delay);
            tokio::pin!(wait);
            loop {
                tokio::select! {
                    _ = &mut wait => break,
                    open = next_audio(&mut audio_rx, &mut framer, &mut pending, &mut audio_open), if audio_open => {
                        if !open {
                            break;
                        }
                    }
                }
            }
            if !audio_open {
                break;
            }
        }
        self.sink.status("disconnected", None);
    }

    /// One connection, from the start message to its end.
    async fn connection(
        &self,
        ws: SonioxSocket,
        connection: u32,
        audio_rx: &mut mpsc::Receiver<AudioChunk>,
        framer: &mut Framer,
        pending: &mut VecDeque<Frame>,
        replay: &mut VecDeque<Frame>,
        audio_open: &mut bool,
    ) -> Ended {
        let (mut write, mut read) = ws.split();
        if let Err(e) = write.send(Message::Text(self.start_message.clone().into())).await {
            return Ended::Lost(transport(RetryClass::Retry), format!("couldn't send the start message: {}", e), false);
        }
        let connected_at = Instant::now();
        // Results came: the connection works (failures after it reconnect to the same region).
        let mut got_results = false;
        let held = |got_results: bool| got_results || connected_at.elapsed() >= HELD_AFTER;
        self.sink.status("connected", None);
        self.sink.debug("info", &format!("connected (connection {})", connection));

        let mut assembler = Assembler::new(self.translation.assembler_config());
        let mut timeline = Timeline::default();
        let mut last_sent = Instant::now();
        let mut finishing_since: Option<Instant> = None;
        // Finishing to hand over to the next connection (not to stop).
        let mut rotating = false;

        // Audio captured while connecting goes out first (Soniox accepts a short burst).
        while let Some(frame) = pending.pop_front() {
            let samples = frame.samples;
            let end_ms = frame.captured_end_ms;
            remember(replay, &frame);
            if let Err(e) = write.send(Message::Binary(frame.bytes.into())).await {
                return self.lost(&mut assembler, connection, &timeline, transport(RetryClass::Retry),
                    format!("write failed: {}", e), held(got_results)).await;
            }
            timeline.sent(samples, end_ms);
            last_sent = Instant::now();
        }
        if !*audio_open {
            finishing_since = Some(Instant::now());
            if let Some(frame) = framer.take() {
                let samples = frame.samples;
                let end_ms = frame.captured_end_ms;
                if write.send(Message::Binary(frame.bytes.into())).await.is_ok() {
                    timeline.sent(samples, end_ms);
                }
            }
            let _ = write.send(Message::Text("".into())).await;
        }

        let mut tick = tokio::time::interval(TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        loop {
            // Held: what it was sent is safe, no need to keep copies.
            if !replay.is_empty() && held(got_results) {
                replay.clear();
            }
            tokio::select! {
                message = read.next() => {
                    let now = Instant::now();
                    match message {
                        Some(Ok(Message::Text(text))) => match {
                            if trace_enabled() {
                                log::info!("[soniox trace] {}sx{}: {}", self.segment_id_prefix, connection, text.as_str());
                            }
                            protocol::parse_server_message(text.as_str())
                        } {
                            Ok(ServerMessage::Tokens { tokens, finished, .. }) => {
                                got_results = true;
                                let events = assembler.on_tokens(&tokens, now);
                                self.emit(events, connection, &timeline).await;
                                if finished {
                                    if finishing_since.is_some() {
                                        self.emit(assembler.flush(now), connection, &timeline).await;
                                        return finished_as(rotating, *audio_open || !pending.is_empty() || !framer.samples.is_empty());
                                    }
                                    return self.lost(&mut assembler, connection, &timeline, transport(RetryClass::Retry),
                                        "Soniox ended the stream".to_string(), held(got_results)).await;
                                }
                                // Due for a new connection: right after a sentence ended.
                                let up = now.duration_since(connected_at);
                                if finishing_since.is_none() && up >= self.rotate_after && tokens.iter().any(Token::ends_sentence) {
                                    self.hand_over(&mut write, connection, up, "at a sentence end").await;
                                    finishing_since = Some(now);
                                    rotating = true;
                                }
                            }
                            Ok(ServerMessage::Error(err)) => {
                                // Early (right after the handshake): the region's answer decides
                                // (full, down, key refused…). Later: reconnect there first.
                                let action = regions::action_for_error(&err);
                                let held = held(got_results);
                                let action = if held { regions::mid_session(action) } else { action };
                                let reason = format!(
                                    "Soniox {}{}: {}",
                                    err.code.map(|c| c.to_string()).unwrap_or_default(),
                                    err.error_type.as_deref().map(|t| format!(" {}", t)).unwrap_or_default(),
                                    err.message
                                );
                                self.sink.debug("error", &reason);
                                if finishing_since.is_some() {
                                    self.emit(assembler.flush(now), connection, &timeline).await;
                                    return finished_as(rotating, *audio_open || !pending.is_empty() || !framer.samples.is_empty());
                                }
                                return self.lost(&mut assembler, connection, &timeline, action, reason, held).await;
                            }
                            Err(e) => self.sink.debug("warn", &format!("unreadable message: {}", e)),
                        },
                        Some(Ok(Message::Close(frame))) => {
                            if finishing_since.is_some() {
                                self.emit(assembler.flush(now), connection, &timeline).await;
                                return finished_as(rotating, *audio_open || !pending.is_empty() || !framer.samples.is_empty());
                            }
                            let code = frame.as_ref().map(|f| u16::from(f.code));
                            let reason = match frame {
                                Some(f) if !f.reason.is_empty() => format!("closed by Soniox ({}): {}", u16::from(f.code), f.reason.as_str()),
                                Some(f) => format!("closed by Soniox ({})", u16::from(f.code)),
                                None => "closed by Soniox".to_string(),
                            };
                            return self.lost(&mut assembler, connection, &timeline, transport(protocol::classify_close(code)),
                                reason, held(got_results)).await;
                        }
                        Some(Ok(_)) => {}
                        Some(Err(e)) => {
                            if finishing_since.is_some() {
                                self.emit(assembler.flush(now), connection, &timeline).await;
                                return finished_as(rotating, *audio_open || !pending.is_empty() || !framer.samples.is_empty());
                            }
                            return self.lost(&mut assembler, connection, &timeline, transport(protocol::classify_close(None)),
                                format!("connection error: {}", e), held(got_results)).await;
                        }
                        None => {
                            if finishing_since.is_some() {
                                self.emit(assembler.flush(now), connection, &timeline).await;
                                return finished_as(rotating, *audio_open || !pending.is_empty() || !framer.samples.is_empty());
                            }
                            return self.lost(&mut assembler, connection, &timeline, transport(protocol::classify_close(None)),
                                "connection dropped".to_string(), held(got_results)).await;
                        }
                    }
                }
                chunk = audio_rx.recv(), if *audio_open => {
                    match chunk {
                        // Handing over: the next connection sends it first.
                        Some(chunk) if rotating => queue_frames(pending, framer.push(&chunk)),
                        Some(chunk) => {
                            for frame in framer.push(&chunk) {
                                let samples = frame.samples;
                                let end_ms = frame.captured_end_ms;
                                if !held(got_results) {
                                    remember(replay, &frame);
                                }
                                if let Err(e) = write.send(Message::Binary(frame.bytes.into())).await {
                                    return self.lost(&mut assembler, connection, &timeline, transport(RetryClass::Retry),
                                        format!("write failed: {}", e), held(got_results)).await;
                                }
                                timeline.sent(samples, end_ms);
                                last_sent = Instant::now();
                            }
                        }
                        // Stop while handing over: the end of the stream already went out.
                        None if rotating => *audio_open = false,
                        None => {
                            // Stop: last audio, then the empty text frame; results until `finished`.
                            *audio_open = false;
                            finishing_since = Some(Instant::now());
                            if let Some(frame) = framer.take() {
                                let samples = frame.samples;
                                let end_ms = frame.captured_end_ms;
                                if write.send(Message::Binary(frame.bytes.into())).await.is_ok() {
                                    timeline.sent(samples, end_ms);
                                }
                            }
                            let _ = write.send(Message::Text("".into())).await;
                        }
                    }
                }
                _ = tick.tick() => {
                    let now = Instant::now();
                    let events = assembler.tick(now);
                    self.emit(events, connection, &timeline).await;
                    if let Some(since) = finishing_since {
                        if now.duration_since(since) >= FINISH_WAIT {
                            self.sink.debug("warn", "no `finished` from Soniox within 5 s; last results may be missing");
                            self.emit(assembler.flush(now), connection, &timeline).await;
                            let _ = write.send(Message::Close(None)).await;
                            return finished_as(rotating, *audio_open || !pending.is_empty() || !framer.samples.is_empty());
                        }
                        continue;
                    }
                    // Due and no sentence end for a minute: hand over anyway.
                    let up = now.duration_since(connected_at);
                    if up >= self.rotate_after.saturating_add(self.rotate_wait_max) {
                        self.hand_over(&mut write, connection, up, "without waiting longer for a sentence end").await;
                        finishing_since = Some(now);
                        rotating = true;
                        continue;
                    }
                    if assembler.wants_finalize(now) {
                        if write.send(Message::Text(protocol::FINALIZE_MESSAGE.into())).await.is_ok() {
                            assembler.finalize_sent(now);
                        }
                    }
                    // Muted (no audio fed) or a quiet source: keep the session alive.
                    if now.duration_since(last_sent) >= KEEPALIVE_AFTER {
                        if let Err(e) = write.send(Message::Text(protocol::KEEPALIVE_MESSAGE.into())).await {
                            return self.lost(&mut assembler, connection, &timeline, transport(RetryClass::Retry),
                                format!("keepalive failed: {}", e), held(got_results)).await;
                        }
                        last_sent = now;
                    }
                }
            }
        }
    }

    /// Start handing over to a new connection: Soniox gets the end of this
    /// stream (the sentence in progress and its translation come back before
    /// `finished`); the audio from here on waits for the next connection.
    async fn hand_over(&self, write: &mut SplitSink<SonioxSocket, Message>, connection: u32, up: Duration, how: &str) {
        self.sink.debug(
            "info",
            &format!(
                "connection {} up {} min, moving to a new one {} (Soniox ends a stream at 300 min)",
                connection,
                up.as_secs() / 60,
                how
            ),
        );
        let _ = write.send(Message::Text("".into())).await;
    }

    /// The connection ended unexpectedly: settle what it produced, then report.
    async fn lost(
        &self,
        assembler: &mut Assembler,
        connection: u32,
        timeline: &Timeline,
        action: RegionAction,
        reason: String,
        held: bool,
    ) -> Ended {
        self.emit(assembler.flush(Instant::now()), connection, timeline).await;
        Ended::Lost(action, reason, held)
    }

    async fn emit(&self, events: Vec<AssemblerEvent>, connection: u32, timeline: &Timeline) {
        for event in events {
            match event {
                AssemblerEvent::Transcript(sentence) => {
                    let result = self.transcript_result(sentence, connection, timeline);
                    self.announce_speaker(result.speaker_tag.as_deref());
                    if self.result_tx.send(result).await.is_err() {
                        return;
                    }
                }
                AssemblerEvent::Translation(update) => self.sink.translation(&self.translation_event(update, connection)),
            }
        }
    }

    /// `speaker_detected` the first time a diarization tag shows up.
    fn announce_speaker(&self, tag: Option<&str>) {
        let Some(speaker_id) = tag.and_then(crate::stt::provider::diarized_speaker_id) else { return };
        let new = self.seen_speakers.lock().map(|mut seen| seen.insert(speaker_id.clone())).unwrap_or(false);
        if new {
            self.sink.speaker_detected(&speaker_id);
        }
    }

    fn transcript_result(&self, s: SentenceUpdate, connection: u32, timeline: &Timeline) -> TranscriptResult {
        let timestamp_ms = s.start_ms.and_then(|ms| timeline.epoch_at(ms)).unwrap_or_else(epoch_now_ms);
        let duration_ms = match (s.start_ms, s.end_ms) {
            (Some(start), Some(end)) if end >= start => Some(end - start),
            _ => None,
        };
        TranscriptResult {
            text: s.text,
            is_final: s.is_final,
            confidence: s.confidence,
            timestamp_ms,
            speaker: None,
            language: s.language,
            segment_id: Some(sentence_id(connection, s.seq)),
            duration_ms,
            speaker_tag: if self.diarize { s.speaker.map(|n| format!("S{}", n)) } else { None },
        }
    }

    fn translation_event(&self, t: TranslationUpdate, connection: u32) -> TranslationEvent {
        TranslationEvent {
            segment_id: format!("{}{}", self.segment_id_prefix, sentence_id(connection, t.seq)),
            original_text: t.original_text,
            translated_text: t.translated_text,
            source_lang: t.source_language.unwrap_or_else(|| "auto".to_string()),
            // Two-way: per sentence, language A's or B's code.
            target_lang: self.translation.target_code(&t.target_language),
            provider: "soniox",
            is_final: t.is_final,
        }
    }
}

/// Segment id of a sentence within the party's session (`sx{connection}_{sentence}`).
fn sentence_id(connection: u32, seq: u64) -> String {
    format!("sx{}_{}", connection, seq)
}

/// How a connection that was finishing ends: handed over (the next one goes
/// at once), else stopped. A stopped hand-over still opens one final connection
/// if it has buffered audio to drain; the provider's STOP_WAIT bounds it all.
fn finished_as(rotating: bool, has_audio: bool) -> Ended {
    if rotating && has_audio {
        Ended::Rotated
    } else {
        Ended::Stopped
    }
}

/// Keep frames for the next connection (the oldest audio goes past 10 s).
/// Keep a copy of a frame sent on a connection that hasn't held yet: if it
/// fails early (region full, key refused…), the next connection gets it again.
fn remember(replay: &mut VecDeque<Frame>, frame: &Frame) {
    replay.push_back(frame.clone());
    if replay.len() > PENDING_MAX_FRAMES {
        replay.pop_front();
    }
}

/// An early failure: the frames the failed connection got go out again first.
fn restore(pending: &mut VecDeque<Frame>, replay: &mut VecDeque<Frame>) {
    let mut frames: VecDeque<Frame> = replay.drain(..).collect();
    frames.extend(pending.drain(..));
    while frames.len() > PENDING_MAX_FRAMES {
        frames.pop_front();
    }
    *pending = frames;
}

fn queue_frames(pending: &mut VecDeque<Frame>, frames: Vec<Frame>) {
    for frame in frames {
        pending.push_back(frame);
        if pending.len() > PENDING_MAX_FRAMES {
            pending.pop_front();
        }
    }
}

/// Queue one chunk while not connected. Returns false once the audio queue
/// closed (stop).
async fn next_audio(
    audio_rx: &mut mpsc::Receiver<AudioChunk>,
    framer: &mut Framer,
    pending: &mut VecDeque<Frame>,
    audio_open: &mut bool,
) -> bool {
    match audio_rx.recv().await {
        Some(chunk) => {
            queue_frames(pending, framer.push(&chunk));
            true
        }
        None => {
            *audio_open = false;
            false
        }
    }
}

/// Keep queueing audio until the queue closes (runs alongside a connect).
async fn drain_until_closed(
    audio_rx: &mut mpsc::Receiver<AudioChunk>,
    framer: &mut Framer,
    pending: &mut VecDeque<Frame>,
    audio_open: &mut bool,
) {
    while next_audio(audio_rx, framer, pending, audio_open).await {}
}

/// Open the WebSocket with the key in the handshake (marked sensitive, so it
/// never shows up in logs). Handshake refusals are classified by HTTP status.
async fn connect(url: &str, api_key: &str) -> Result<SonioxSocket, (ConnectFailure, String)> {
    let mut request = url
        .into_client_request()
        .map_err(|e| (ConnectFailure::Invalid, format!("invalid Soniox WebSocket URL: {}", e)))?;
    let mut auth = HeaderValue::from_str(&format!("Bearer {}", api_key))
        .map_err(|_| (ConnectFailure::Invalid, "the Soniox API key contains invalid characters".to_string()))?;
    auth.set_sensitive(true);
    request.headers_mut().insert(AUTHORIZATION, auth);
    match tokio_tungstenite::connect_async(request).await {
        Ok((ws, _response)) => Ok(ws),
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            let status = response.status().as_u16();
            Err((ConnectFailure::Http(status), format!("Soniox refused the connection (HTTP {})", status)))
        }
        Err(e) => Err((ConnectFailure::Network, format!("couldn't connect to Soniox: {}", e))),
    }
}

// ── Settings-page test ──────────────────────────────────────────────────────

/// `GET {rest}/v1/models` with the key: 200 = key works (real-time models
/// listed), 401 = invalid key, 403 = valid key without the "model listing"
/// permission (real-time transcription may still work).
pub async fn probe(cfg: &SonioxConfig, api_key: Option<&str>) -> SttProbeResult {
    let Some(key) = api_key.map(str::trim).filter(|k| !k.is_empty()) else {
        return SttProbeResult::failure("no_key", "No Soniox API key saved");
    };
    let raw = format!("{}/v1/models", cfg.rest_base());
    let url = match url::Url::parse(&raw) {
        Ok(url) if matches!(url.scheme(), "http" | "https") => url,
        _ => return SttProbeResult { url: Some(raw), ..SttProbeResult::failure("invalid_url", "Not a valid http(s) address") },
    };
    let shown_url = crate::net::endpoint::redact_url(url.as_str());
    let client = match reqwest::Client::builder().timeout(CONNECT_TIMEOUT).build() {
        Ok(client) => client,
        Err(e) => return SttProbeResult::failure("network", e.to_string()),
    };
    let started = Instant::now();
    let response = client.get(url).bearer_auth(key).send().await;
    let latency_ms = started.elapsed().as_millis() as u64;
    let response = match response {
        Ok(response) => response,
        Err(e) => {
            let code = if e.is_timeout() { "timeout" } else { "network" };
            return SttProbeResult { url: Some(shown_url), latency_ms, ..SttProbeResult::failure(code, e.to_string()) };
        }
    };
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    let (ok, code) = match status {
        200..=299 => (true, "ok"),
        401 => (false, "unauthorized"),
        403 => (false, "forbidden"),
        404 => (false, "not_found"),
        _ => (false, "http_error"),
    };
    SttProbeResult {
        ok,
        code: code.to_string(),
        url: Some(shown_url),
        status: Some(status),
        latency_ms,
        models: if ok { realtime_models(&body) } else { Vec::new() },
        detail: truncate(&body, 2048),
    }
}

/// Real-time model ids from `/v1/models` (`{"models":[{id, transcription_mode, aliased_model_id}]}`),
/// actual models first, then aliases.
fn realtime_models(body: &str) -> Vec<String> {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(body) else { return Vec::new() };
    let Some(models) = json.get("models").and_then(|m| m.as_array()) else { return Vec::new() };
    let mut real = Vec::new();
    let mut aliases = Vec::new();
    for model in models {
        let Some(id) = model.get("id").and_then(|v| v.as_str()) else { continue };
        let mode = model.get("transcription_mode").and_then(|v| v.as_str()).unwrap_or("real_time");
        if mode != "real_time" {
            continue;
        }
        if model.get("aliased_model_id").is_some_and(|v| !v.is_null()) {
            aliases.push(id.to_string());
        } else {
            real.push(id.to_string());
        }
    }
    real.extend(aliases);
    real
}

/// At most `max` bytes, cut on a character boundary.
fn truncate(text: &str, max: usize) -> String {
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
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;
    use tokio::net::TcpListener;

    #[derive(Default)]
    struct TestSink {
        statuses: Mutex<Vec<(String, Option<String>)>>,
        debugs: Mutex<Vec<String>>,
        translations: Mutex<Vec<TranslationEvent>>,
        speakers: Mutex<Vec<String>>,
        regions: Mutex<Vec<String>>,
        switches: Mutex<Vec<(String, String, SwitchReason)>>,
    }

    impl TestSink {
        fn status_names(&self) -> Vec<String> {
            self.statuses.lock().unwrap().iter().map(|(s, _)| s.clone()).collect()
        }
    }

    impl SessionSink for TestSink {
        fn status(&self, status: &str, message: Option<String>) {
            self.statuses.lock().unwrap().push((status.to_string(), message));
        }
        fn debug(&self, _level: &str, message: &str) {
            self.debugs.lock().unwrap().push(message.to_string());
        }
        fn translation(&self, translation: &TranslationEvent) {
            self.translations.lock().unwrap().push(translation.clone());
        }
        fn speaker_detected(&self, speaker_id: &str) {
            self.speakers.lock().unwrap().push(speaker_id.to_string());
        }
        fn region(&self, region: &str) {
            self.regions.lock().unwrap().push(region.to_string());
        }
        fn region_switched(&self, from: &str, to: &str, reason: SwitchReason) {
            self.switches.lock().unwrap().push((from.to_string(), to.to_string(), reason));
        }
    }

    fn chunk(value: i16, samples: usize, ts: u64) -> AudioChunk {
        AudioChunk { pcm_data: vec![value; samples], source: crate::audio::AudioSource::System, timestamp_ms: ts, is_speech: true }
    }

    /// One-way into `target` ("zh", named "zh-CN" by the settings), or no translation.
    fn options(target: Option<&str>) -> SonioxSessionOptions {
        let translation = match target {
            Some(t) => SonioxTranslation::OneWay { code: format!("{}-CN", t), soniox: t.to_string() },
            None => SonioxTranslation::Off,
        };
        SonioxSessionOptions {
            party: "Them".into(),
            language: "auto".into(),
            other_language: Some("zh-CN".into()),
            translation,
            segment_id_prefix: "them_ab12_".into(),
            client_reference_id: Some("nexq:m1:them".into()),
            diarize: true,
        }
    }

    /// Two-way between Chinese ("zh-CN") and English ("en-US").
    fn zh_en() -> SonioxTranslation {
        SonioxTranslation::TwoWay { a_code: "zh-CN".into(), a: "zh".into(), b_code: "en-US".into(), b: "en".into() }
    }

    fn provider(ws_url: &str, target: Option<&str>, sink: Arc<TestSink>) -> SonioxSTT {
        provider_with(ws_url, options(target), sink)
    }

    fn provider_with(ws_url: &str, options: SonioxSessionOptions, sink: Arc<TestSink>) -> SonioxSTT {
        let config = SonioxConfig { ws_url: ws_url.to_string(), ..SonioxConfig::default() };
        let mut p = SonioxSTT::new(config, Some("test-key".into()), options);
        p.sink = Some(sink);
        p
    }

    #[test]
    fn frames_are_100_ms_and_never_span_a_gap() {
        let mut framer = Framer::default();
        // 16 chunks of 10 ms → one 100 ms frame + 60 ms left.
        let mut frames = Vec::new();
        for i in 0..16u64 {
            frames.extend(framer.push(&chunk(1, 160, 1_000 + (i + 1) * 10)));
        }
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].samples, 1600);
        assert_eq!(frames[0].bytes.len(), 3200);
        assert_eq!(frames[0].captured_end_ms, 1_100);
        // A chunk 5 s later (unmuted): the 60 ms tail goes out on its own first.
        let after_gap = framer.push(&chunk(1, 160, 6_170));
        assert_eq!(after_gap.len(), 1);
        assert_eq!(after_gap[0].samples, 960);
        assert_eq!(framer.take().map(|f| f.samples), Some(160));
        assert!(framer.take().is_none());
    }

    #[test]
    fn soniox_times_map_back_to_capture_times_across_a_mute() {
        let mut timeline = Timeline::default();
        timeline.sent(1600, 10_100); // audio 0–100 ms, captured 10 000–10 100
        timeline.sent(1600, 10_200);
        timeline.sent(1600, 20_100); // after a 10 s mute: Soniox's 200 ms is capture 20 000
        assert_eq!(timeline.epoch_at(50), Some(10_050));
        assert_eq!(timeline.epoch_at(150), Some(10_150));
        assert_eq!(timeline.epoch_at(250), Some(20_050));
    }

    #[test]
    fn the_start_message_has_hints_translation_and_no_key() {
        let p = SonioxSTT::new(SonioxConfig::default(), Some("secret".into()), options(Some("zh")));
        let msg = p.start_message().unwrap();
        assert!(!msg.contains("secret"));
        assert!(!msg.contains("api_key"));
        let json: serde_json::Value = serde_json::from_str(&msg).unwrap();
        assert_eq!(json["model"], "stt-rt-v5");
        assert_eq!(json["audio_format"], "pcm_s16le");
        assert_eq!(json["language_hints"], serde_json::json!(["zh"]));
        assert_eq!(json["translation"]["target_language"], "zh");
        assert_eq!(json["enable_speaker_diarization"], true);
        assert_eq!(json["client_reference_id"], "nexq:m1:them");

        let bad = SonioxSTT::new(
            SonioxConfig { extra_start_params: "[1]".into(), ..SonioxConfig::default() },
            Some("k".into()),
            options(None),
        );
        assert!(bad.start_message().is_err());
    }

    #[test]
    fn the_start_message_has_a_two_way_pair_and_the_v5_endpoint_settings_only_when_set() {
        let config = SonioxConfig {
            endpoint_sensitivity: Some(0.4),
            endpoint_latency_adjustment_level: Some(1),
            ..SonioxConfig::default()
        };
        let two_way = SonioxSessionOptions { translation: zh_en(), ..options(None) };
        let msg = SonioxSTT::new(config, Some("k".into()), two_way).start_message().unwrap();
        let json: serde_json::Value = serde_json::from_str(&msg).unwrap();
        assert_eq!(json["translation"], serde_json::json!({"type": "two_way", "language_a": "zh", "language_b": "en"}));
        // Both languages of the pair are hinted, once each (the other party's "zh-CN" was already there).
        assert_eq!(json["language_hints"], serde_json::json!(["zh", "en"]));
        assert_eq!(json["endpoint_sensitivity"], 0.4);
        assert_eq!(json["endpoint_latency_adjustment_level"], 1);

        // Server defaults: neither goes out (models before v5 refuse them).
        let msg = SonioxSTT::new(SonioxConfig::default(), Some("k".into()), options(None)).start_message().unwrap();
        assert!(!msg.contains("endpoint_sensitivity") && !msg.contains("endpoint_latency_adjustment_level"), "{msg}");
        assert!(!msg.contains("translation"), "{msg}");
    }

    #[test]
    fn translations_are_tagged_with_the_settings_code_of_their_target() {
        assert_eq!(zh_en().target_code("en"), "en-US");
        assert_eq!(zh_en().target_code("zh"), "zh-CN");
        assert_eq!(zh_en().target_code("ja"), "ja", "a language the pair doesn't name stays as Soniox put it");
        let one_way = SonioxTranslation::OneWay { code: "zh-CN".into(), soniox: "zh".into() };
        assert_eq!(one_way.target_code("zh"), "zh-CN");
        let unnamed = SonioxTranslation::OneWay { code: " ".into(), soniox: "zh".into() };
        assert_eq!(unnamed.target_code("zh"), "zh");
        // As the Dev Log shows them.
        assert_eq!(zh_en().to_string(), "zh↔en");
        assert_eq!(one_way.to_string(), "zh");
        assert_eq!(SonioxTranslation::Off.to_string(), "off");
    }

    #[test]
    fn lists_real_time_models_first_then_aliases() {
        let body = r#"{"models":[
            {"id":"stt-async-v5","transcription_mode":"async","aliased_model_id":null},
            {"id":"stt-rt-v4","transcription_mode":"real_time","aliased_model_id":"stt-rt-v5"},
            {"id":"stt-rt-v5","transcription_mode":"real_time","aliased_model_id":null}]}"#;
        assert_eq!(realtime_models(body), vec!["stt-rt-v5", "stt-rt-v4"]);
        assert!(realtime_models("not json").is_empty());
    }

    /// A one-connection fake Soniox: checks the handshake key and the start
    /// message, replies with `replies` after the first audio frame, then
    /// waits for the empty text frame and answers `finished`.
    async fn fake_soniox(replies: Vec<String>) -> (String, tokio::task::JoinHandle<(Option<String>, serde_json::Value, usize)>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let auth = Arc::new(Mutex::new(None));
            let seen = auth.clone();
            use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
            let callback = move |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
                *seen.lock().unwrap() = req.headers().get("authorization").map(|v| v.to_str().unwrap().to_string());
                Ok(resp)
            };
            let mut ws = tokio_tungstenite::accept_hdr_async(stream, callback).await.unwrap();
            let start = match ws.next().await.unwrap().unwrap() {
                Message::Text(t) => serde_json::from_str::<serde_json::Value>(t.as_str()).unwrap(),
                other => panic!("first message not text: {:?}", other),
            };
            let mut binary_frames = 0usize;
            let mut replied = false;
            while let Some(Ok(msg)) = ws.next().await {
                match msg {
                    Message::Binary(_) => {
                        binary_frames += 1;
                        if !replied {
                            replied = true;
                            for r in &replies {
                                ws.send(Message::Text(r.clone().into())).await.unwrap();
                            }
                        }
                    }
                    Message::Text(t) if t.as_str().is_empty() => {
                        ws.send(Message::Text(r#"{"tokens":[],"finished":true}"#.into())).await.unwrap();
                        let _ = ws.close(None).await;
                        break;
                    }
                    _ => {}
                }
            }
            let auth = auth.lock().unwrap().clone();
            (auth, start, binary_frames)
        });
        (url, server)
    }

    /// A region that refuses every connection with `error` right after the
    /// start message; counts the connections it got.
    async fn refusing_region(error: &'static str) -> (String, Arc<std::sync::atomic::AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = count.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await else { continue };
                let _ = ws.next().await; // start message
                let _ = ws.send(Message::Text(error.into())).await;
                let _ = ws.close(None).await;
            }
        });
        (url, count)
    }

    /// An ordered two-region session ("us" then "eu") on local servers, with its own cooldowns.
    fn two_regions(us: &str, eu: &str, sink: Arc<TestSink>) -> (SonioxSTT, &'static Mutex<Cooldowns>) {
        let config: SonioxConfig = serde_json::from_value(serde_json::json!({
            "region_mode": "ordered",
            "regions": [{"id": "us", "enabled": true}, {"id": "eu", "enabled": true}],
        }))
        .unwrap();
        let mut p = SonioxSTT::new(config, None, options(None));
        p.sink = Some(sink);
        p.region_keys = Some(RegionKeys {
            per_region: [("us".to_string(), "key-us".to_string()), ("eu".to_string(), "key-eu".to_string())].into(),
            legacy: None,
            legacy_region: "us".into(),
        });
        p.region_ws_urls = Some([("us".to_string(), us.to_string()), ("eu".to_string(), eu.to_string())].into());
        p.latency_override = Some(LatencyTable::default());
        let cooldowns: &'static Mutex<Cooldowns> = Box::leak(Box::new(Mutex::new(Cooldowns::default())));
        p.cooldowns = Some(cooldowns);
        (p, cooldowns)
    }

    const HELLO: &str = r#"{"tokens":[{"text":"Hello","start_ms":0,"end_ms":300,"is_final":true},{"text":"<end>","is_final":true}]}"#;

    async fn first_final(rx: &mut mpsc::Receiver<TranscriptResult>) -> TranscriptResult {
        loop {
            let r = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.expect("a result").expect("open");
            if r.is_final {
                return r;
            }
        }
    }

    #[tokio::test]
    async fn a_full_region_hands_the_session_to_the_next_one() {
        let (us, us_hits) = refusing_region(
            r#"{"tokens":[],"error_code":429,"error_type":"max_concurrent_connections_reached","error_message":"Project concurrency limit reached"}"#,
        )
        .await;
        let (eu, eu_server) = fake_soniox(vec![HELLO.to_string()]).await;
        let sink = Arc::new(TestSink::default());
        let (mut p, cooldowns) = two_regions(&us, &eu, sink.clone());
        let (tx, mut rx) = mpsc::channel(32);
        p.start_stream(tx).await.unwrap();
        for i in 0..20u64 {
            p.feed_audio(chunk(100, 160, 70_000 + (i + 1) * 10)).await.unwrap();
        }
        let line = first_final(&mut rx).await;
        assert_eq!(line.text, "Hello");
        p.stop_stream().await.unwrap();

        assert_eq!(*sink.switches.lock().unwrap(), vec![("us".to_string(), "eu".to_string(), SwitchReason::Concurrency)]);
        assert_eq!(*sink.regions.lock().unwrap(), vec!["us".to_string(), "eu".to_string()]);
        assert_eq!(us_hits.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(cooldowns.lock().unwrap().is_cooling("us", Instant::now()));
        let (auth, _, _) = eu_server.await.unwrap();
        assert_eq!(auth.as_deref(), Some("Bearer key-eu"));
    }

    #[tokio::test]
    async fn an_organization_limit_waits_instead_of_trying_another_region() {
        let (us, us_hits) = refusing_region(
            r#"{"tokens":[],"error_code":429,"error_type":"limit_exceeded","error_message":"Organization request limit exceeded"}"#,
        )
        .await;
        let (eu, eu_hits) = refusing_region(r#"{"tokens":[],"error_code":500,"error_type":"internal_error","error_message":""}"#).await;
        let sink = Arc::new(TestSink::default());
        let (mut p, cooldowns) = two_regions(&us, &eu, sink.clone());
        let (tx, _rx) = mpsc::channel(32);
        p.start_stream(tx).await.unwrap();
        for i in 0..20u64 {
            p.feed_audio(chunk(100, 160, 80_000 + (i + 1) * 10)).await.unwrap();
        }
        tokio::time::sleep(Duration::from_millis(1200)).await;
        // Backing off (≥ 20 s): no other region, no switch notice, no cooldown.
        assert_eq!(eu_hits.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert_eq!(us_hits.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(sink.switches.lock().unwrap().is_empty());
        assert!(!cooldowns.lock().unwrap().is_cooling("us", Instant::now()));
        let reconnecting = sink.statuses.lock().unwrap().iter().any(|(s, m)| {
            s == "reconnecting" && m.as_deref().is_some_and(|m| m.contains("Organization request limit"))
        });
        assert!(reconnecting, "{:?}", sink.statuses.lock().unwrap());
        // Stopping during the wait ends the session at once.
        tokio::time::timeout(Duration::from_secs(2), p.stop_stream()).await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn a_refused_key_skips_its_region() {
        let (us, us_hits) = refusing_region(
            r#"{"tokens":[],"error_code":401,"error_type":"unauthenticated","error_message":"Invalid API key"}"#,
        )
        .await;
        let (eu, _eu_server) = fake_soniox(vec![HELLO.to_string()]).await;
        let sink = Arc::new(TestSink::default());
        let (mut p, cooldowns) = two_regions(&us, &eu, sink.clone());
        let (tx, mut rx) = mpsc::channel(32);
        p.start_stream(tx).await.unwrap();
        for i in 0..20u64 {
            p.feed_audio(chunk(100, 160, 90_000 + (i + 1) * 10)).await.unwrap();
        }
        assert_eq!(first_final(&mut rx).await.text, "Hello");
        p.stop_stream().await.unwrap();
        assert_eq!(*sink.switches.lock().unwrap(), vec![("us".to_string(), "eu".to_string(), SwitchReason::KeyRejected)]);
        assert_eq!(us_hits.load(std::sync::atomic::Ordering::SeqCst), 1);
        // Not a full region: no cooldown for it.
        assert!(!cooldowns.lock().unwrap().is_cooling("us", Instant::now()));
    }

    #[tokio::test]
    async fn no_key_for_the_allowed_regions_fails_to_start() {
        let config: SonioxConfig = serde_json::from_value(serde_json::json!({
            "region_mode": "ordered",
            "regions": [{"id": "jp", "enabled": true}, {"id": "us", "enabled": false}],
        }))
        .unwrap();
        let mut p = SonioxSTT::new(config, None, options(None));
        p.region_keys = Some(RegionKeys {
            per_region: [("us".to_string(), "key-us".to_string())].into(),
            legacy: Some("old".into()),
            legacy_region: "us".into(),
        });
        let (tx, _rx) = mpsc::channel(32);
        let err = p.start_stream(tx).await.unwrap_err().to_string();
        assert!(err.contains("No Soniox key"), "{}", err);
    }

    #[tokio::test]
    async fn streams_audio_and_turns_sentences_and_translations_into_events() {
        let replies = vec![
            r#"{"tokens":[{"text":"Hello","start_ms":0,"end_ms":300,"is_final":true,"language":"en","translation_status":"original","speaker":"1"},{"text":" world","start_ms":300,"end_ms":600,"is_final":false,"language":"en","translation_status":"original","speaker":"1"}]}"#.to_string(),
            r#"{"tokens":[{"text":" world","start_ms":300,"end_ms":600,"is_final":true,"language":"en","translation_status":"original","speaker":"1"},{"text":"你好世界","is_final":true,"language":"zh","translation_status":"translation","source_language":"en"},{"text":"<end>","is_final":true}]}"#.to_string(),
        ];
        let (url, server) = fake_soniox(replies).await;
        let sink = Arc::new(TestSink::default());
        let mut p = provider(&url, Some("zh"), sink.clone());
        let (tx, mut rx) = mpsc::channel(32);
        p.start_stream(tx).await.unwrap();

        for i in 0..30u64 {
            p.feed_audio(chunk(100, 160, 50_000 + (i + 1) * 10)).await.unwrap();
        }
        // Results arrive while the meeting runs.
        let first = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.unwrap().unwrap();
        assert_eq!(first.segment_id.as_deref(), Some("sx1_1"));
        assert!(!first.is_final);
        p.stop_stream().await.unwrap();

        let mut results = vec![first];
        while let Ok(r) = rx.try_recv() {
            results.push(r);
        }
        let last = results.last().unwrap();
        assert!(last.is_final);
        assert_eq!(last.text, "Hello world");
        assert_eq!(last.segment_id.as_deref(), Some("sx1_1"));
        assert_eq!(last.speaker_tag.as_deref(), Some("S1"));
        assert_eq!(last.language.as_deref(), Some("en"));
        // Soniox's 0 ms is the capture time of the first audio sent.
        assert_eq!(last.timestamp_ms, 50_000);
        assert_eq!(last.duration_ms, Some(600));

        let translations = sink.translations.lock().unwrap().clone();
        let settled = translations.iter().find(|t| t.is_final).expect("a final translation");
        assert_eq!(settled.segment_id, "them_ab12_sx1_1");
        assert_eq!(settled.translated_text, "你好世界");
        assert_eq!(settled.original_text, "Hello world");
        // The settings' code ("zh-CN"), not the two-letter one sent to Soniox.
        assert_eq!(settled.target_lang, "zh-CN");
        assert_eq!(settled.provider, "soniox");

        let (auth, start, frames) = server.await.unwrap();
        assert_eq!(auth.as_deref(), Some("Bearer test-key"));
        assert!(start.get("api_key").is_none());
        assert_eq!(start["sample_rate"], 16000);
        assert_eq!(frames, 3); // 300 ms of audio in 100 ms frames
        // Speaker "1" announced once, as in-person mode expects ("S1" → "speaker_0").
        assert_eq!(*sink.speakers.lock().unwrap(), vec!["speaker_0".to_string()]);
        let statuses: Vec<String> = sink.statuses.lock().unwrap().iter().map(|(s, _)| s.clone()).collect();
        assert_eq!(statuses.first().map(String::as_str), Some("connecting"));
        assert!(statuses.contains(&"connected".to_string()));
        assert_eq!(statuses.last().map(String::as_str), Some("disconnected"));
    }

    #[tokio::test]
    async fn two_way_translations_go_out_under_language_a_or_b_by_sentence() {
        let replies = vec![
            r#"{"tokens":[{"text":"我们开始吧","is_final":true,"language":"zh","translation_status":"original"},{"text":"Let's start","is_final":true,"language":"en","translation_status":"translation","source_language":"zh"},{"text":"<end>","is_final":true}]}"#.to_string(),
            r#"{"tokens":[{"text":"Sounds good","is_final":true,"language":"en","translation_status":"original"},{"text":"听起来不错","is_final":true,"language":"zh","translation_status":"translation","source_language":"en"},{"text":"<end>","is_final":true}]}"#.to_string(),
        ];
        let (url, server) = fake_soniox(replies).await;
        let sink = Arc::new(TestSink::default());
        let mut p = provider_with(&url, SonioxSessionOptions { translation: zh_en(), ..options(None) }, sink.clone());
        let (tx, mut rx) = mpsc::channel(32);
        p.start_stream(tx).await.unwrap();
        for i in 0..30u64 {
            p.feed_audio(chunk(100, 160, 50_000 + (i + 1) * 10)).await.unwrap();
        }
        // Stop once connected (a stop while connecting ends the session at once).
        let first = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.unwrap().unwrap();
        p.stop_stream().await.unwrap();

        let mut lines = Vec::new();
        let mut results = vec![first];
        while let Ok(r) = rx.try_recv() {
            results.push(r);
        }
        for r in results.into_iter().filter(|r| r.is_final) {
            lines.push((r.segment_id.unwrap(), r.text));
        }
        let pair = |a: &str, b: &str| (a.to_string(), b.to_string());
        assert_eq!(lines, [pair("sx1_1", "我们开始吧"), pair("sx1_2", "Sounds good")]);

        let translations = sink.translations.lock().unwrap().clone();
        let settled: Vec<_> = translations
            .iter()
            .filter(|t| t.is_final)
            .map(|t| (t.segment_id.as_str(), t.translated_text.as_str(), t.source_lang.as_str(), t.target_lang.as_str()))
            .collect();
        // The settings' codes of A and B, not the two-letter ones sent to Soniox.
        assert_eq!(
            settled,
            [("them_ab12_sx1_1", "Let's start", "zh", "en-US"), ("them_ab12_sx1_2", "听起来不错", "en", "zh-CN")]
        );
        // Partials too: each carries its own sentence's target.
        for t in &translations {
            let target = if t.segment_id.ends_with("sx1_1") { "en-US" } else { "zh-CN" };
            assert_eq!(t.target_lang, target, "{t:?}");
        }
        let (_, start, _) = server.await.unwrap();
        assert_eq!(start["translation"], serde_json::json!({"type": "two_way", "language_a": "zh", "language_b": "en"}));
    }

    /// What a fake Soniox connection got: its start message, audio frames and audio bytes.
    struct Received {
        start: serde_json::Value,
        frames: usize,
        bytes: usize,
    }

    /// A fake Soniox serving one connection per script, one after the other.
    /// A script's replies go out 100 ms after its first audio frame (the
    /// connection is that much older by then), its last message (with
    /// `finished`) 100 ms after the end of the stream, while audio keeps
    /// coming. `started` counts the start messages received.
    async fn fake_soniox_connections(
        scripts: Vec<(Vec<String>, String)>,
    ) -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<Vec<Received>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let started = Arc::new(AtomicUsize::new(0));
        let count = started.clone();
        let server = tokio::spawn(async move {
            let mut received = Vec::new();
            for (replies, last) in scripts {
                let (stream, _) = listener.accept().await.unwrap();
                let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
                let start = match ws.next().await.unwrap().unwrap() {
                    Message::Text(t) => serde_json::from_str::<serde_json::Value>(t.as_str()).unwrap(),
                    other => panic!("first message not text: {:?}", other),
                };
                count.fetch_add(1, Ordering::SeqCst);
                let (mut frames, mut bytes) = (0, 0);
                while let Some(Ok(msg)) = ws.next().await {
                    match msg {
                        Message::Binary(audio) => {
                            frames += 1;
                            bytes += audio.len();
                            if frames == 1 {
                                tokio::time::sleep(Duration::from_millis(100)).await;
                                for r in &replies {
                                    ws.send(Message::Text(r.clone().into())).await.unwrap();
                                }
                            }
                        }
                        Message::Text(t) if t.as_str().is_empty() => {
                            tokio::time::sleep(Duration::from_millis(100)).await;
                            ws.send(Message::Text(last.clone().into())).await.unwrap();
                            let _ = ws.close(None).await;
                            break;
                        }
                        _ => {}
                    }
                }
                received.push(Received { start, frames, bytes });
            }
            received
        });
        (url, started, server)
    }

    /// Feeds 10 ms chunks at about 5× real time until `connections` start
    /// messages arrived, then `more` chunks at once. Returns the chunks fed.
    async fn feed_until_connection(p: &mut SonioxSTT, started: &AtomicUsize, connections: usize, more: u64) -> u64 {
        let mut fed = 0u64;
        let give_up = Instant::now() + Duration::from_secs(10);
        while started.load(Ordering::SeqCst) < connections {
            assert!(Instant::now() < give_up, "connection {} never started", connections);
            fed += 1;
            p.feed_audio(chunk(7, 160, 10_000 + fed * 10)).await.unwrap();
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        for _ in 0..more {
            fed += 1;
            p.feed_audio(chunk(7, 160, 10_000 + fed * 10)).await.unwrap();
        }
        fed
    }

    /// Every sample fed went out exactly once, in 100 ms frames (the very last one partial).
    fn assert_no_audio_lost(received: &[Received], fed: u64) {
        assert!(received.iter().all(|c| c.frames > 0), "every connection got audio");
        assert_eq!(received.iter().map(|c| c.bytes as u64).sum::<u64>(), fed * 160 * 2);
        assert_eq!(received.iter().map(|c| c.frames as u64).sum::<u64>(), fed.div_ceil(10));
    }

    #[tokio::test]
    async fn a_connection_hands_over_at_a_sentence_end_without_losing_audio() {
        let scripts = vec![
            (
                vec![r#"{"tokens":[{"text":"Hello","is_final":true},{"text":"<end>","is_final":true},{"text":"Still","is_final":false}]}"#.to_string()],
                r#"{"tokens":[{"text":"Still","is_final":true},{"text":" here","is_final":true}],"finished":true}"#.to_string(),
            ),
            (vec![r#"{"tokens":[{"text":"Again","is_final":true}]}"#.to_string()], r#"{"tokens":[],"finished":true}"#.to_string()),
        ];
        let (url, started, server) = fake_soniox_connections(scripts).await;
        let sink = Arc::new(TestSink::default());
        let mut p = provider(&url, None, sink.clone());
        // Due 50 ms in: the `<end>` of the first reply (100 ms in) is where it hands over.
        p.rotate_after = Duration::from_millis(50);
        let (tx, mut rx) = mpsc::channel(64);
        p.start_stream(tx).await.unwrap();
        let fed = feed_until_connection(&mut p, &started, 2, 45).await;
        p.stop_stream().await.unwrap();

        let received = server.await.unwrap();
        assert_eq!(received.len(), 2);
        assert_eq!(received[1].start, received[0].start);
        assert_no_audio_lost(&received, fed);

        let mut ids = Vec::new();
        let mut finals = Vec::new();
        while let Ok(r) = rx.try_recv() {
            let id = r.segment_id.clone().unwrap();
            if r.is_final {
                finals.push((id.clone(), r.text));
            }
            ids.push(id);
        }
        let line = |id: &str, text: &str| (id.to_string(), text.to_string());
        // The sentence in progress ends on the old connection; the new one numbers from 1.
        assert_eq!(finals, [line("sx1_1", "Hello"), line("sx1_2", "Still here"), line("sx2_1", "Again")]);
        let first_new = ids.iter().position(|id| id.starts_with("sx2_")).unwrap();
        assert!(ids[..first_new].iter().all(|id| id.starts_with("sx1_")), "{ids:?}");
        assert!(ids[first_new..].iter().all(|id| id.starts_with("sx2_")), "{ids:?}");

        // Planned: no "reconnecting" for the user, no backoff.
        assert_eq!(sink.status_names(), ["connecting", "connected", "connected", "disconnected"]);
        assert!(sink.debugs.lock().unwrap().iter().any(|m| m.contains("moving to a new one at a sentence end")));
    }

    #[tokio::test]
    async fn stop_during_handover_drains_full_and_partial_frames_on_a_last_connection() {
        use tokio::sync::oneshot;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let (handover_tx, handover_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut first = tokio_tungstenite::accept_async(stream).await.unwrap();
            let _ = first.next().await.unwrap().unwrap(); // start config
            let mut bytes = 0;
            while let Some(Ok(msg)) = first.next().await {
                match msg {
                    Message::Binary(audio) => {
                        bytes += audio.len();
                        first.send(Message::Text(r#"{"tokens":[{"text":"Hi","is_final":true},{"text":"<end>","is_final":true}]}"#.into())).await.unwrap();
                    }
                    Message::Text(t) if t.is_empty() => break,
                    _ => {}
                }
            }
            handover_tx.send(()).unwrap();
            release_rx.await.unwrap();
            first.send(Message::Text(r#"{"tokens":[],"finished":true}"#.into())).await.unwrap();
            let (stream, _) = listener.accept().await.unwrap();
            let mut last = tokio_tungstenite::accept_async(stream).await.unwrap();
            let _ = last.next().await.unwrap().unwrap();
            while let Some(Ok(msg)) = last.next().await {
                match msg {
                    Message::Binary(audio) => bytes += audio.len(),
                    Message::Text(t) if t.is_empty() => {
                        last.send(Message::Text(r#"{"tokens":[{"text":"Tail","is_final":true,"start_ms":0,"end_ms":150}],"finished":true}"#.into())).await.unwrap();
                        break;
                    }
                    _ => {}
                }
            }
            bytes
        });
        let mut p = provider(&url, None, Arc::new(TestSink::default()));
        p.rotate_after = Duration::ZERO;
        let (tx, mut rx) = mpsc::channel(32);
        p.start_stream(tx).await.unwrap();
        p.feed_audio(chunk(7, 1600, 10_100)).await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), handover_rx).await.unwrap().unwrap();
        // 150 ms while the old stream is finishing: a full and a partial frame.
        p.feed_audio(chunk(9, 2400, 10_250)).await.unwrap();
        // Exercise the actual stop path while the first stream has not finished yet.
        let stopping = tokio::spawn(async move { p.stop_stream().await.unwrap(); });
        tokio::time::sleep(Duration::from_millis(30)).await;
        release_tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(3), stopping).await.unwrap().unwrap();
        assert_eq!(tokio::time::timeout(Duration::from_secs(2), server).await.unwrap().unwrap(), 8000);
        let mut tail = None;
        while let Ok(result) = rx.try_recv() {
            if result.is_final && result.text == "Tail" { tail = Some(result); }
        }
        let tail = tail.expect("the final hand-over connection transcribes its queued audio");
        assert_eq!(tail.timestamp_ms, 10_100);
    }

    #[tokio::test]
    async fn a_connection_hands_over_anyway_when_no_sentence_ends() {
        let scripts = vec![
            (
                vec![r#"{"tokens":[{"text":"Long","is_final":true},{"text":" talk","is_final":false}]}"#.to_string()],
                r#"{"tokens":[{"text":" talk","is_final":true}],"finished":true}"#.to_string(),
            ),
            (vec![], r#"{"tokens":[],"finished":true}"#.to_string()),
        ];
        let (url, started, server) = fake_soniox_connections(scripts).await;
        let sink = Arc::new(TestSink::default());
        let mut p = provider(&url, None, sink.clone());
        // Due at once, but no `<end>` comes: it waits 500 ms at most.
        p.rotate_after = Duration::ZERO;
        p.rotate_wait_max = Duration::from_millis(500);
        let (tx, mut rx) = mpsc::channel(64);
        p.start_stream(tx).await.unwrap();
        let fed = feed_until_connection(&mut p, &started, 2, 45).await;
        p.stop_stream().await.unwrap();

        let received = server.await.unwrap();
        assert_eq!(received.len(), 2);
        assert_no_audio_lost(&received, fed);
        let mut finals = Vec::new();
        while let Ok(r) = rx.try_recv() {
            if r.is_final {
                finals.push((r.segment_id.unwrap(), r.text));
            }
        }
        assert_eq!(finals, [("sx1_1".to_string(), "Long talk".to_string())]);
        assert_eq!(sink.status_names(), ["connecting", "connected", "connected", "disconnected"]);
        assert!(sink.debugs.lock().unwrap().iter().any(|m| m.contains("without waiting longer for a sentence end")));
    }

    #[tokio::test]
    async fn a_fatal_error_frame_is_reported_and_not_retried() {
        let replies = vec![r#"{"tokens":[],"error_code":401,"error_type":"unauthenticated","error_message":"Invalid API key"}"#.to_string()];
        let (url, server) = fake_soniox(replies).await;
        let sink = Arc::new(TestSink::default());
        let mut p = provider(&url, None, sink.clone());
        let (tx, _rx) = mpsc::channel(32);
        p.start_stream(tx).await.unwrap();
        for i in 0..12u64 {
            p.feed_audio(chunk(100, 160, 1_000 + i * 10)).await.unwrap();
        }
        let session = p.session.take().unwrap();
        tokio::time::timeout(Duration::from_secs(5), session).await.expect("the session gives up").unwrap();
        let statuses = sink.statuses.lock().unwrap().clone();
        let (status, message) = statuses.last().unwrap();
        assert_eq!(status, "error");
        assert!(message.as_deref().unwrap().contains("Invalid API key"), "{:?}", message);
        assert_eq!(statuses.iter().filter(|(s, _)| s == "connecting" || s == "reconnecting").count(), 1);
        // Feeding after the session ended never fails or blocks.
        p.feed_audio(chunk(1, 160, 2_000)).await.unwrap();
        server.abort();
    }

    #[tokio::test]
    async fn feed_audio_never_waits_when_the_session_is_stuck() {
        // Nothing listens on this port's connect timeout path: use a listener that never accepts.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let sink = Arc::new(TestSink::default());
        let mut p = provider(&url, None, sink);
        let (tx, _rx) = mpsc::channel(32);
        p.start_stream(tx).await.unwrap();
        let started = Instant::now();
        for i in 0..(AUDIO_QUEUE as u64 + 200) {
            p.feed_audio(chunk(1, 160, 1_000 + i * 10)).await.unwrap();
        }
        assert!(started.elapsed() < Duration::from_secs(1));
        p.session.take().unwrap().abort();
        drop(listener);
    }

    #[tokio::test]
    async fn probe_reports_key_status_and_models() {
        async fn serve(status: &'static str, body: &'static str) -> String {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            tokio::spawn(async move {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let (mut s, _) = listener.accept().await.unwrap();
                let mut buf = vec![0u8; 4096];
                let n = s.read(&mut buf).await.unwrap();
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                assert!(req.starts_with("GET /v1/models"), "{}", req);
                assert!(req.to_lowercase().contains("authorization: bearer k-123"), "{}", req);
                let resp = format!("HTTP/1.1 {}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}", status, body.len(), body);
                s.write_all(resp.as_bytes()).await.unwrap();
            });
            format!("http://{}", addr)
        }
        let ok_url = serve("200 OK", r#"{"models":[{"id":"stt-rt-v5","transcription_mode":"real_time","aliased_model_id":null}]}"#).await;
        let cfg = SonioxConfig { rest_url: ok_url, ..SonioxConfig::default() };
        let r = probe(&cfg, Some("k-123")).await;
        assert!(r.ok, "{:?}", r);
        assert_eq!(r.models, vec!["stt-rt-v5"]);
        assert_eq!(r.status, Some(200));

        let denied = SonioxConfig { rest_url: serve("401 Unauthorized", r#"{"error_message":"Invalid API key"}"#).await, ..SonioxConfig::default() };
        let r = probe(&denied, Some("k-123")).await;
        assert_eq!((r.ok, r.code.as_str()), (false, "unauthorized"));
        assert!(r.detail.contains("Invalid API key"));

        let limited = SonioxConfig { rest_url: serve("403 Forbidden", "{}").await, ..SonioxConfig::default() };
        assert_eq!(probe(&limited, Some("k-123")).await.code, "forbidden");

        assert_eq!(probe(&SonioxConfig::default(), None).await.code, "no_key");
    }
}
