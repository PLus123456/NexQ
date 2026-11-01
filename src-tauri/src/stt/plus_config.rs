// NexQ Plus: settings of the remote STT (OpenAI-compatible) and Soniox engines.
//
// The frontend owns them (config.json keys `openaiCompatSttConfig` and
// `sonioxConfig`) and pushes them with `update_openai_compat_stt_config` /
// `update_soniox_config`. The backend keeps the latest copy in `SttPlusState`
// (registered with `app.manage`, not in `AppState`): a running remote STT
// engine reads it before every request, Soniox when it (re)connects.
// API keys live in the keychain (slots `openai_compat_stt`, `soniox`), never here.

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};

/// Keychain slot of the remote STT key (optional: empty = no auth header).
pub const OPENAI_COMPAT_STT_KEY_SLOT: &str = "openai_compat_stt";
/// Keychain slot of the Soniox API key.
pub const SONIOX_KEY_SLOT: &str = "soniox";

/// Remote Whisper over an OpenAI-compatible `/audio/transcriptions` endpoint
/// (faster-whisper-server / speaches, vLLM, LocalAI...). One global copy; the
/// recognition language belongs to each party.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct OpenAICompatSttConfig {
    /// Base URL with its version prefix, used as typed (`/v1` is never added).
    /// Empty = not configured.
    pub base_url: String,
    /// Full transcription URL for irregular gateways. Empty = `{base_url}/audio/transcriptions`.
    pub url_override: String,
    pub model: String,
    pub temperature: f32,
    /// `json` (default), `text` or `verbose_json`.
    pub response_format: String,
    /// Prompt guiding spelling and style. Empty = none.
    pub prompt: String,
    /// Audio per request (seconds). When the server falls behind, waiting
    /// segments are merged into requests of up to 25 s.
    pub segment_duration_secs: f32,
    /// Silence that ends a segment early (ms).
    pub pause_split_ms: u32,
    pub request_timeout_secs: u32,
    /// Requests running at once (1–2); results always come back in order.
    pub max_in_flight: u32,
}

impl Default for OpenAICompatSttConfig {
    fn default() -> Self {
        Self {
            base_url: String::new(),
            url_override: String::new(),
            model: "whisper-1".to_string(),
            temperature: 0.0,
            response_format: "json".to_string(),
            prompt: String::new(),
            segment_duration_secs: 5.0,
            pause_split_ms: 1500,
            request_timeout_secs: 30,
            max_in_flight: 1,
        }
    }
}

/// Soniox real-time engine. Region picks the REST and WebSocket hosts unless
/// the custom URLs are set.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SonioxConfig {
    /// `us` (default) | `eu` | `jp` | `in`. Unknown values fall back to `us`.
    pub region: String,
    pub model: String,
    /// 500–3000 ms (Soniox default 2000; subtitles want 1000–1500).
    pub max_endpoint_delay_ms: u32,
    /// -1.0–1.0, higher = sentences end sooner. None = Soniox's default (0.0),
    /// not sent: only `stt-rt-v5` takes it, older models answer 400.
    pub endpoint_sensitivity: Option<f32>,
    /// 0–3, higher = less wait before a sentence ends. None = Soniox's default
    /// (0), not sent: only `stt-rt-v5` takes it, older models answer 400.
    pub endpoint_latency_adjustment_level: Option<u8>,
    /// Keep the output to the hinted languages (best effort).
    pub language_hints_strict: bool,
    /// Tell remote speakers apart. Applies to the "Them" party only.
    pub enable_speaker_diarization: bool,
    /// Custom WebSocket URL (gateways). Empty = by region.
    pub ws_url: String,
    /// Custom REST base URL (gateways). Empty = by region.
    pub rest_url: String,
    /// JSON object merged into the start message (forward compatibility).
    /// `api_key` and the audio format fields are never taken from it.
    pub extra_start_params: String,
}

impl Default for SonioxConfig {
    fn default() -> Self {
        Self {
            region: "us".to_string(),
            model: "stt-rt-v5".to_string(),
            max_endpoint_delay_ms: 1500,
            endpoint_sensitivity: None,
            endpoint_latency_adjustment_level: None,
            language_hints_strict: false,
            enable_speaker_diarization: true,
            ws_url: String::new(),
            rest_url: String::new(),
            extra_start_params: String::new(),
        }
    }
}

impl SonioxConfig {
    /// REST base URL (no trailing `/`): the custom one, else the region's.
    pub fn rest_base(&self) -> String {
        let custom = self.rest_url.trim().trim_end_matches('/');
        if !custom.is_empty() {
            return custom.to_string();
        }
        match self.region.trim() {
            "eu" => "https://api.eu.soniox.com",
            "jp" => "https://api.jp.soniox.com",
            "in" => "https://api.in.soniox.com",
            _ => "https://api.soniox.com",
        }
        .to_string()
    }

    /// Real-time WebSocket URL: the custom one, else the region's.
    pub fn ws_endpoint(&self) -> String {
        let custom = self.ws_url.trim();
        if !custom.is_empty() {
            return custom.to_string();
        }
        match self.region.trim() {
            "eu" => "wss://stt-rt.eu.soniox.com/transcribe-websocket",
            "jp" => "wss://stt-rt.jp.soniox.com/transcribe-websocket",
            "in" => "wss://stt-rt.in.soniox.com/transcribe-websocket",
            _ => "wss://stt-rt.soniox.com/transcribe-websocket",
        }
        .to_string()
    }
}

/// Outcome of a settings-page test ("probe") of a remote STT service.
/// `code` is stable (the UI words it); `detail` is the raw server text.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SttProbeResult {
    pub ok: bool,
    /// `ok` | `no_base_url` | `invalid_url` | `no_key` | `unauthorized` |
    /// `forbidden` | `not_found` | `http_error` | `timeout` | `network` | `bad_response`
    pub code: String,
    /// The URL actually requested (secrets redacted), when there was one.
    pub url: Option<String>,
    pub status: Option<u16>,
    pub latency_ms: u64,
    /// Server response or error text, at most 2 KB.
    pub detail: String,
    /// Model ids the service listed (empty when it doesn't list them).
    pub models: Vec<String>,
}

impl SttProbeResult {
    pub fn failure(code: &str, detail: impl Into<String>) -> Self {
        Self { ok: false, code: code.to_string(), detail: detail.into(), ..Self::default() }
    }
}

/// The shared STT settings, managed by Tauri (`app.state::<SttPlusState>()`).
#[derive(Debug, Clone)]
pub struct SttPlusState {
    pub openai_compat: Arc<RwLock<OpenAICompatSttConfig>>,
    pub soniox: Arc<RwLock<SonioxConfig>>,
    /// whisper.cpp runs on the GPU (Metal on macOS) unless switched off.
    pub whisper_use_gpu: Arc<AtomicBool>,
}

impl Default for SttPlusState {
    fn default() -> Self {
        Self {
            openai_compat: Arc::default(),
            soniox: Arc::default(),
            whisper_use_gpu: Arc::new(AtomicBool::new(true)),
        }
    }
}

impl SttPlusState {
    pub fn openai_compat_snapshot(&self) -> OpenAICompatSttConfig {
        self.openai_compat.read().map(|c| c.clone()).unwrap_or_default()
    }

    pub fn soniox_snapshot(&self) -> SonioxConfig {
        self.soniox.read().map(|c| c.clone()).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configs_take_missing_fields_from_the_defaults() {
        let cfg: OpenAICompatSttConfig =
            serde_json::from_str(r#"{"base_url":"http://10.0.0.5:8000/v1"}"#).unwrap();
        assert_eq!(cfg.base_url, "http://10.0.0.5:8000/v1");
        assert_eq!(cfg.request_timeout_secs, 30);
        assert_eq!(cfg.max_in_flight, 1);

        let sx: SonioxConfig = serde_json::from_str(r#"{"region":"eu"}"#).unwrap();
        assert_eq!(sx.model, "stt-rt-v5");
        assert_eq!(sx.max_endpoint_delay_ms, 1500);
        assert_eq!((sx.endpoint_sensitivity, sx.endpoint_latency_adjustment_level), (None, None));

        // The settings page writes null for "server default".
        let sx: SonioxConfig =
            serde_json::from_str(r#"{"endpoint_sensitivity":null,"endpoint_latency_adjustment_level":2}"#).unwrap();
        assert_eq!((sx.endpoint_sensitivity, sx.endpoint_latency_adjustment_level), (None, Some(2)));
        let sx: SonioxConfig = serde_json::from_str(r#"{"endpoint_sensitivity":-0.4}"#).unwrap();
        assert_eq!(sx.endpoint_sensitivity, Some(-0.4));
    }

    #[test]
    fn soniox_hosts_follow_the_region_unless_overridden() {
        let mut sx = SonioxConfig::default();
        assert_eq!(sx.rest_base(), "https://api.soniox.com");
        assert_eq!(sx.ws_endpoint(), "wss://stt-rt.soniox.com/transcribe-websocket");
        sx.region = "jp".into();
        assert_eq!(sx.rest_base(), "https://api.jp.soniox.com");
        assert_eq!(sx.ws_endpoint(), "wss://stt-rt.jp.soniox.com/transcribe-websocket");
        sx.region = "mars".into();
        assert_eq!(sx.rest_base(), "https://api.soniox.com");
        sx.rest_url = " https://gw.example.com/soniox/ ".into();
        sx.ws_url = "ws://127.0.0.1:9000/rt".into();
        assert_eq!(sx.rest_base(), "https://gw.example.com/soniox");
        assert_eq!(sx.ws_endpoint(), "ws://127.0.0.1:9000/rt");
    }
}
