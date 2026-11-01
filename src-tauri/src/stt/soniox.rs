// NexQ Plus: Soniox real-time engine (WebSocket session per party).
// Contract stub — the session is filled in by the Soniox work.

use async_trait::async_trait;
use tauri::AppHandle;
use tokio::sync::mpsc;

use crate::audio::AudioChunk;
use crate::stt::plus_config::{SonioxConfig, SttProbeResult};
use crate::stt::provider::{STTProvider, STTProviderType, TranscriptResult};

/// Per-party facts a Soniox session needs besides the global config.
#[derive(Debug, Clone, Default)]
pub struct SonioxSessionOptions {
    /// "You" or "Them".
    pub party: String,
    /// This party's language ("auto" or a code).
    pub language: String,
    /// The other party's language (hints for "auto").
    pub other_language: Option<String>,
    /// One-way translation target (two-letter); None = no translation.
    pub translation_target: Option<String>,
    /// Prefix of the transcript segment ids this party emits ("them_ab12_"),
    /// so translations carry the full id of their line.
    pub segment_id_prefix: String,
    /// `client_reference_id` for Soniox usage logs.
    pub client_reference_id: Option<String>,
    /// Ask for speaker diarization (Them only).
    pub diarize: bool,
}

pub struct SonioxSTT {
    #[allow(dead_code)]
    config: SonioxConfig,
    #[allow(dead_code)]
    api_key: Option<String>,
    #[allow(dead_code)]
    options: SonioxSessionOptions,
    #[allow(dead_code)]
    app_handle: Option<AppHandle>,
}

impl SonioxSTT {
    pub fn new(config: SonioxConfig, api_key: Option<String>, options: SonioxSessionOptions) -> Self {
        Self { config, api_key, options, app_handle: None }
    }

    pub fn set_app_handle(&mut self, handle: AppHandle) {
        self.app_handle = Some(handle);
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
        _result_tx: mpsc::Sender<TranscriptResult>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        Err("Soniox is not implemented yet".into())
    }

    async fn feed_audio(&mut self, _chunk: AudioChunk) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        Ok(())
    }

    async fn stop_stream(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        Ok(())
    }

    async fn test_connection(&self) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        Err("Soniox is not implemented yet".into())
    }

    fn set_language(&mut self, language: &str) {
        self.options.language = language.to_string();
    }
}

/// Settings-page test: `GET /v1/models` with the key.
pub async fn probe(_cfg: &SonioxConfig, _api_key: Option<&str>) -> SttProbeResult {
    SttProbeResult::failure("network", "not implemented yet")
}
