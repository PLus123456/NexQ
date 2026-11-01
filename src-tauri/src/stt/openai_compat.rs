// NexQ Plus: remote Whisper over an OpenAI-compatible /audio/transcriptions
// endpoint. Contract stub — the engine is filled in by the remote-STT work.

use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use tauri::AppHandle;
use tokio::sync::mpsc;

use crate::audio::AudioChunk;
use crate::stt::plus_config::{OpenAICompatSttConfig, SttProbeResult};
use crate::stt::provider::{STTProvider, STTProviderType, TranscriptResult};

pub struct OpenAICompatSTT {
    #[allow(dead_code)]
    shared_config: Arc<RwLock<OpenAICompatSttConfig>>,
    #[allow(dead_code)]
    api_key: Option<String>,
    #[allow(dead_code)]
    language: Option<String>,
    #[allow(dead_code)]
    app_handle: Option<AppHandle>,
    #[allow(dead_code)]
    party: String,
}

impl OpenAICompatSTT {
    pub fn new(shared_config: Arc<RwLock<OpenAICompatSttConfig>>, api_key: Option<String>) -> Self {
        Self { shared_config, api_key, language: None, app_handle: None, party: String::new() }
    }

    pub fn set_app_handle(&mut self, handle: AppHandle) {
        self.app_handle = Some(handle);
    }

    pub fn set_party(&mut self, party: &str) {
        self.party = party.to_string();
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
        _result_tx: mpsc::Sender<TranscriptResult>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        Err("remote STT is not implemented yet".into())
    }

    async fn feed_audio(&mut self, _chunk: AudioChunk) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        Ok(())
    }

    async fn stop_stream(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        Ok(())
    }

    async fn test_connection(&self) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        Err("remote STT is not implemented yet".into())
    }

    fn set_language(&mut self, language: &str) {
        self.language = crate::stt::language::whisper_api_language(language);
    }
}

/// Settings-page test: lists the models, else transcribes 1 s of silence.
pub async fn probe(_cfg: &OpenAICompatSttConfig, _api_key: Option<&str>) -> SttProbeResult {
    SttProbeResult::failure("network", "not implemented yet")
}
