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
/// Keychain slot of the Soniox key saved before per-region keys: read as the
/// key of `SonioxConfig::region` (never moved or deleted).
pub const SONIOX_KEY_SLOT: &str = "soniox";

/// Soniox regions, in the default priority order. A key belongs to the region
/// of its Soniox project.
pub const SONIOX_REGIONS: [&str; 4] = ["us", "eu", "jp", "in"];

/// Keychain slot of a region's Soniox key (`soniox_us`, `soniox_eu`, …).
pub fn soniox_key_slot(region: &str) -> String {
    format!("soniox_{}", region)
}

/// The known region for `id` (`us` for anything else).
pub fn soniox_region(id: &str) -> &'static str {
    SONIOX_REGIONS.iter().copied().find(|r| *r == id.trim()).unwrap_or("us")
}

/// REST base URL of a region (no trailing `/`).
pub fn soniox_region_rest_base(region: &str) -> &'static str {
    match soniox_region(region) {
        "eu" => "https://api.eu.soniox.com",
        "jp" => "https://api.jp.soniox.com",
        "in" => "https://api.in.soniox.com",
        _ => "https://api.soniox.com",
    }
}

/// Real-time WebSocket URL of a region.
pub fn soniox_region_ws_url(region: &str) -> &'static str {
    match soniox_region(region) {
        "eu" => "wss://stt-rt.eu.soniox.com/transcribe-websocket",
        "jp" => "wss://stt-rt.jp.soniox.com/transcribe-websocket",
        "in" => "wss://stt-rt.in.soniox.com/transcribe-websocket",
        _ => "wss://stt-rt.soniox.com/transcribe-websocket",
    }
}

/// How a Soniox session picks its region. Unknown values read as `fixed`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SonioxRegionMode {
    /// Only `region` (what configs saved before the multi-region settings mean).
    #[default]
    Fixed,
    /// Enabled regions that have a key, fastest first (latency test); list order when unknown.
    Auto,
    /// Enabled regions that have a key, in the user's order.
    Ordered,
}

impl<'de> Deserialize<'de> for SonioxRegionMode {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(d)?;
        Ok(match value.as_str() {
            Some("auto") => Self::Auto,
            Some("ordered") => Self::Ordered,
            _ => Self::Fixed,
        })
    }
}

/// One region in the user's list; the list order is the priority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SonioxRegionSetting {
    pub id: String,
    #[serde(default)]
    pub enabled: bool,
}

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
    /// Which region a session uses. Configs without it are `fixed` (`region`).
    pub region_mode: SonioxRegionMode,
    /// The four regions in priority order, each enabled or not (`auto` / `ordered`).
    /// Missing or partial lists are completed by `region_list`.
    pub regions: Vec<SonioxRegionSetting>,
    /// When a region is full, down or refuses the key, try the next one.
    pub failover: bool,
    /// The region the key in the old `soniox` slot belongs to: the app sets
    /// it once from `region`, so the old key stays with its region when
    /// `region` changes. None: `region`.
    pub legacy_key_region: Option<String>,
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
            region_mode: SonioxRegionMode::Fixed,
            regions: Vec::new(),
            failover: true,
            legacy_key_region: None,
        }
    }
}

impl SonioxConfig {
    /// The fixed region (`region`, `us` when unknown).
    pub fn fixed_region(&self) -> &'static str {
        soniox_region(&self.region)
    }

    /// The region the old `soniox` slot's key counts for (`legacy_key_region`, else `region`).
    pub fn legacy_region(&self) -> &'static str {
        soniox_region(self.legacy_key_region.as_deref().unwrap_or(&self.region))
    }

    /// A gateway is configured: its URLs are used as they are, without regions.
    pub fn uses_custom_endpoint(&self) -> bool {
        !self.ws_url.trim().is_empty() || !self.rest_url.trim().is_empty()
    }

    /// All four regions in the user's order: known ids from `regions` (first
    /// occurrence wins), then the missing ones. An empty list means a config
    /// from before the setting: `region` first and enabled, the others off.
    pub fn region_list(&self) -> Vec<SonioxRegionSetting> {
        let mut list: Vec<SonioxRegionSetting> = Vec::new();
        for entry in &self.regions {
            let id = entry.id.trim();
            if SONIOX_REGIONS.contains(&id) && !list.iter().any(|e| e.id == id) {
                list.push(SonioxRegionSetting { id: id.to_string(), enabled: entry.enabled });
            }
        }
        if list.is_empty() {
            let fixed = self.fixed_region();
            list.push(SonioxRegionSetting { id: fixed.to_string(), enabled: true });
        }
        for region in SONIOX_REGIONS {
            if !list.iter().any(|e| e.id == region) {
                list.push(SonioxRegionSetting { id: region.to_string(), enabled: false });
            }
        }
        list
    }

    /// The regions a session may use, before keys and latency: `region` for
    /// `fixed`, else the enabled ones in list order.
    pub fn allowed_regions(&self) -> Vec<&'static str> {
        match self.region_mode {
            SonioxRegionMode::Fixed => vec![self.fixed_region()],
            SonioxRegionMode::Auto | SonioxRegionMode::Ordered => self
                .region_list()
                .into_iter()
                .filter(|e| e.enabled)
                .map(|e| soniox_region(&e.id))
                .collect(),
        }
    }

    /// REST base URL (no trailing `/`): the custom one, else the region's.
    pub fn rest_base(&self) -> String {
        let custom = self.rest_url.trim().trim_end_matches('/');
        if !custom.is_empty() {
            return custom.to_string();
        }
        soniox_region_rest_base(&self.region).to_string()
    }

    /// Real-time WebSocket URL: the custom one, else the region's.
    pub fn ws_endpoint(&self) -> String {
        let custom = self.ws_url.trim();
        if !custom.is_empty() {
            return custom.to_string();
        }
        soniox_region_ws_url(&self.region).to_string()
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
    fn a_config_from_before_regions_reads_as_fixed_on_its_region() {
        let old: SonioxConfig = serde_json::from_str(r#"{"region":"jp","model":"stt-rt-v5"}"#).unwrap();
        assert_eq!(old.region_mode, SonioxRegionMode::Fixed);
        assert!(old.failover);
        let ids: Vec<(String, bool)> = old.region_list().into_iter().map(|e| (e.id, e.enabled)).collect();
        assert_eq!(
            ids,
            vec![("jp".into(), true), ("us".into(), false), ("eu".into(), false), ("in".into(), false)]
        );
        assert_eq!(old.allowed_regions(), vec!["jp"]);
        // The old key is `region`'s until the app pins it, then it stays put.
        assert_eq!(old.legacy_region(), "jp");
        let moved: SonioxConfig = serde_json::from_str(r#"{"region":"eu","legacy_key_region":"jp"}"#).unwrap();
        assert_eq!((moved.fixed_region(), moved.legacy_region()), ("eu", "jp"));
        // An unknown mode never fails the whole config.
        let odd: SonioxConfig = serde_json::from_str(r#"{"region_mode":"fastest","failover":false}"#).unwrap();
        assert_eq!(odd.region_mode, SonioxRegionMode::Fixed);
        assert!(!odd.failover);
    }

    #[test]
    fn the_region_list_keeps_the_users_order_and_completes_itself() {
        let cfg: SonioxConfig = serde_json::from_str(
            r#"{"region_mode":"ordered","regions":[{"id":"in","enabled":true},{"id":"xx","enabled":true},
                {"id":"eu"},{"id":"in","enabled":false},{"id":"jp","enabled":true}]}"#,
        )
        .unwrap();
        let ids: Vec<(String, bool)> = cfg.region_list().into_iter().map(|e| (e.id, e.enabled)).collect();
        assert_eq!(
            ids,
            vec![("in".into(), true), ("eu".into(), false), ("jp".into(), true), ("us".into(), false)]
        );
        assert_eq!(cfg.allowed_regions(), vec!["in", "jp"]);
        assert_eq!(soniox_key_slot("jp"), "soniox_jp");
        assert_eq!(soniox_region_ws_url("in"), "wss://stt-rt.in.soniox.com/transcribe-websocket");
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
