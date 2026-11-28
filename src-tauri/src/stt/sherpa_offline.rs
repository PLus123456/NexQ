// Batch provider for offline models decoded through sherpa-onnx-offline.

use async_trait::async_trait;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tauri::AppHandle;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

use crate::audio::AudioChunk;
use crate::stt::provider::{STTProvider, STTProviderType, TranscriptResult};

const SAMPLE_RATE: u32 = 16_000;
const BATCH_SAMPLES: usize = 3 * SAMPLE_RATE as usize;
const BATCH_TIMEOUT: Duration = Duration::from_secs(8);
const DRAIN_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, Copy)]
pub enum OfflineModelType {
    SenseVoice,
    /// Parakeet uses the in-process decoder. Keep this for offline NeMo models.
    NemoCtc,
}

#[derive(Clone)]
struct OfflineRecognizer {
    binary_path: PathBuf,
    model_path: PathBuf,
    tokens_path: PathBuf,
    model_type: OfflineModelType,
    language: String,
}

impl OfflineRecognizer {
    fn command(&self, wav: &Path) -> Command {
        let mut cmd = Command::new(&self.binary_path);
        let model_flag = match self.model_type {
            OfflineModelType::SenseVoice => "--sense-voice-model",
            OfflineModelType::NemoCtc => "--nemo-ctc-model",
        };
        // The CLI expects separate flag/value pairs, including Windows paths.
        cmd.arg(model_flag)
            .arg(&self.model_path)
            .arg("--tokens")
            .arg(&self.tokens_path)
            .args(["--num-threads", "4", "--provider", "cpu"]);
        if matches!(self.model_type, OfflineModelType::SenseVoice) {
            let lang = crate::stt::language::sense_voice_language(&self.language);
            cmd.args([
                "--sense-voice-language",
                lang,
                "--sense-voice-use-itn",
                "true",
            ]);
        }
        if let Some(dir) = self.binary_path.parent() {
            cmd.current_dir(dir);
        }
        cmd.arg(wav)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        cmd
    }

    async fn recognize(
        &self,
        samples: Vec<i16>,
        cancel: &mut watch::Receiver<bool>,
    ) -> Result<String, String> {
        let wav = tokio::task::spawn_blocking(move || TempWav::write(&samples))
            .await
            .map_err(|e| format!("WAV writer failed: {e}"))?
            .map_err(|e| format!("Failed to write WAV: {e}"))?;
        if *cancel.borrow() {
            return Err("Recognition cancelled".into());
        }

        let mut child = self.command(&wav.0).spawn().map_err(|e| e.to_string())?;
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let output = {
            let wait =
                async { tokio::try_join!(child.wait(), read_output(stdout), read_output(stderr)) };
            tokio::select! {
                biased;
                _ = cancel.wait_for(|cancelled| *cancelled) => Err("Recognition cancelled".into()),
                result = tokio::time::timeout(BATCH_TIMEOUT, wait) => match result {
                    Ok(output) => output.map_err(|e| format!("Could not read recognizer output: {e}")),
                    Err(_) => Err("Offline recognition timed out".into()),
                },
            }
        };
        let (status, stdout, stderr) = match output {
            Ok(output) => output,
            Err(e) => {
                // Reap the process before removing the WAV, including on Windows.
                let _ = child.kill().await;
                return Err(e);
            }
        };

        let stderr = String::from_utf8_lossy(&stderr);
        if !status.success() {
            return Err(format!(
                "Offline recognizer exited with {status}: {}",
                stderr.chars().take(200).collect::<String>()
            ));
        }
        let stdout = String::from_utf8_lossy(&stdout);
        let text = stderr.lines().chain(stdout.lines()).find_map(|line| {
            let line = line.trim();
            line.strip_prefix("text:")
                .or_else(|| line.strip_prefix("text :"))
                .map(str::trim)
        });
        Ok(text.unwrap_or_default().to_owned())
    }
}

async fn read_output(mut reader: impl AsyncRead + Unpin) -> io::Result<Vec<u8>> {
    let mut output = Vec::new();
    reader.read_to_end(&mut output).await?;
    Ok(output)
}

struct OfflineWorker {
    audio_tx: Option<mpsc::Sender<AudioChunk>>,
    cancel: watch::Sender<bool>,
    task: JoinHandle<()>,
}

pub struct SherpaOfflineSTT {
    recognizer: OfflineRecognizer,
    provider_type: STTProviderType,
    app_handle: Option<AppHandle>,
    worker: Option<OfflineWorker>,
}

impl SherpaOfflineSTT {
    pub fn new(
        binary_path: PathBuf,
        model_path: PathBuf,
        tokens_path: PathBuf,
        model_type: OfflineModelType,
        provider_type: STTProviderType,
    ) -> Self {
        Self {
            recognizer: OfflineRecognizer {
                binary_path,
                model_path,
                tokens_path,
                model_type,
                language: "en".to_string(),
            },
            provider_type,
            app_handle: None,
            worker: None,
        }
    }

    pub fn set_language(&mut self, lang: &str) {
        self.recognizer.language = lang.to_string();
    }

    pub fn set_app_handle(&mut self, handle: AppHandle) {
        self.app_handle = Some(handle);
    }
}

impl Drop for SherpaOfflineSTT {
    fn drop(&mut self) {
        if let Some(worker) = self.worker.take() {
            let _ = worker.cancel.send(true);
        }
    }
}

async fn process_batches(
    recognizer: OfflineRecognizer,
    app: Option<AppHandle>,
    mut audio: mpsc::Receiver<AudioChunk>,
    mut cancel: watch::Receiver<bool>,
    results: mpsc::Sender<TranscriptResult>,
) {
    let mut buffer = Vec::with_capacity(BATCH_SAMPLES);
    let mut timestamp_ms = 0;
    let mut segment_id = 0u64;

    loop {
        let chunk = tokio::select! {
            biased;
            _ = cancel.wait_for(|cancelled| *cancelled) => return,
            _ = results.closed() => return,
            chunk = audio.recv() => chunk,
        };
        let draining = chunk.is_none();
        if let Some(chunk) = chunk {
            if buffer.is_empty() {
                let duration_ms = chunk.pcm_data.len() as u64 * 1_000 / u64::from(SAMPLE_RATE);
                timestamp_ms = chunk.timestamp_ms.saturating_sub(duration_ms);
            }
            buffer.extend(chunk.pcm_data);
        }

        if !buffer.is_empty() && (draining || buffer.len() >= BATCH_SAMPLES) {
            let batch = std::mem::take(&mut buffer);
            match recognizer.recognize(batch, &mut cancel).await {
                Ok(text) if !text.is_empty() => {
                    let result = TranscriptResult {
                        text,
                        is_final: true,
                        confidence: 1.0,
                        timestamp_ms,
                        speaker: None,
                        language: Some(recognizer.language.clone()),
                        segment_id: Some(segment_id.to_string()),
                        duration_ms: None,
                        speaker_tag: None,
                        turn: None,
                    };
                    segment_id += 1;
                    tokio::select! {
                        biased;
                        _ = cancel.wait_for(|cancelled| *cancelled) => return,
                        sent = results.send(result) => if sent.is_err() { return },
                    }
                }
                Ok(_) => {}
                Err(e) => {
                    if *cancel.borrow() {
                        return;
                    }
                    log::warn!("SherpaOfflineSTT: {e}");
                    if let Some(app) = &app {
                        crate::stt::emit_stt_debug(app, "error", "sherpa_offline", &e);
                    }
                }
            }
        }
        if draining {
            return;
        }
    }
}

#[async_trait]
impl STTProvider for SherpaOfflineSTT {
    fn provider_name(&self) -> &str {
        match self.recognizer.model_type {
            OfflineModelType::SenseVoice => "Sherpa-ONNX Offline (SenseVoice)",
            OfflineModelType::NemoCtc => "Sherpa-ONNX Offline (Parakeet TDT)",
        }
    }

    fn provider_type(&self) -> STTProviderType {
        self.provider_type.clone()
    }

    async fn start_stream(
        &mut self,
        result_tx: mpsc::Sender<TranscriptResult>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if self.worker.is_some() {
            return Err("Stream already active".into());
        }
        for path in [
            &self.recognizer.binary_path,
            &self.recognizer.model_path,
            &self.recognizer.tokens_path,
        ] {
            if !path.is_file() {
                return Err(
                    format!("Offline recognizer file not found: {}", path.display()).into(),
                );
            }
        }

        let (audio_tx, audio) = mpsc::channel(256);
        let (cancel, cancellation) = watch::channel(false);
        self.worker = Some(OfflineWorker {
            audio_tx: Some(audio_tx),
            cancel,
            task: tokio::spawn(process_batches(
                self.recognizer.clone(),
                self.app_handle.clone(),
                audio,
                cancellation,
                result_tx,
            )),
        });
        Ok(())
    }

    async fn feed_audio(
        &mut self,
        chunk: AudioChunk,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if let Some(audio_tx) = self
            .worker
            .as_ref()
            .and_then(|worker| worker.audio_tx.as_ref())
        {
            audio_tx
                .send(chunk)
                .await
                .map_err(|_| "Offline recognizer stopped")?;
        }
        Ok(())
    }

    async fn test_connection(&self) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        Ok(self.recognizer.binary_path.is_file())
    }

    async fn stop_stream(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(worker) = &mut self.worker else {
            return Ok(());
        };
        // Channel closure is the end-of-stream marker: Tokio first delivers all
        // buffered chunks, and the same recognizer handles the last short batch.
        worker.audio_tx.take();
        let result = match tokio::time::timeout(DRAIN_TIMEOUT, &mut worker.task).await {
            Ok(result) => result.map_err(|e| e.to_string()),
            Err(_) => {
                let _ = worker.cancel.send(true);
                let _ = (&mut worker.task).await;
                Err("Timed out draining offline recognition".into())
            }
        };
        self.worker = None;
        result.map_err(Into::into)
    }

    fn set_language(&mut self, lang: &str) {
        SherpaOfflineSTT::set_language(self, lang);
    }
}

struct TempWav(PathBuf);

impl TempWav {
    fn write(samples: &[i16]) -> io::Result<Self> {
        let path =
            std::env::temp_dir().join(format!("nexq_offline_stt_{}.wav", uuid::Uuid::new_v4()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(&path)?;
        let wav = Self(path);
        let bytes = (samples.len() * 2) as u32;
        let mut writer = io::BufWriter::new(file);
        writer.write_all(b"RIFF")?;
        writer.write_all(&(36 + bytes).to_le_bytes())?;
        writer.write_all(b"WAVEfmt ")?;
        writer.write_all(&16u32.to_le_bytes())?;
        writer.write_all(&1u16.to_le_bytes())?; // PCM
        writer.write_all(&1u16.to_le_bytes())?; // mono
        writer.write_all(&SAMPLE_RATE.to_le_bytes())?;
        writer.write_all(&(SAMPLE_RATE * 2).to_le_bytes())?;
        writer.write_all(&2u16.to_le_bytes())?;
        writer.write_all(&16u16.to_le_bytes())?;
        writer.write_all(b"data")?;
        writer.write_all(&bytes.to_le_bytes())?;
        for sample in samples {
            writer.write_all(&sample.to_le_bytes())?;
        }
        writer.flush()?;
        Ok(wav)
    }
}

impl Drop for TempWav {
    fn drop(&mut self) {
        if let Err(e) = std::fs::remove_file(&self.0) {
            log::warn!("Could not clean up Sherpa WAV: {e}");
        }
    }
}

/// The sherpa-onnx offline program's file name on this platform.
pub const OFFLINE_BINARY: &str = if cfg!(windows) {
    "sherpa-onnx-offline.exe"
} else {
    "sherpa-onnx-offline"
};

/// Why a SenseVoice model can't start, for the Dev Log. NexQ doesn't
/// download the program those models run through.
pub fn missing_binary_message(models_base_dir: &std::path::Path) -> String {
    format!(
        "This model runs through the sherpa-onnx offline program ({OFFLINE_BINARY}), which NexQ doesn't download. \
         Use Parakeet TDT 0.6B v3, which runs inside NexQ, or place {OFFLINE_BINARY} in {}",
        models_base_dir.join("sherpa_onnx").join("sherpa-onnx-v<version>").join("bin").display()
    )
}

/// Find the sherpa-onnx offline program in the sherpa_onnx models directory:
/// `sherpa-onnx-v*/bin/` + [`OFFLINE_BINARY`] under the models base dir.
pub fn find_offline_binary(models_base_dir: &std::path::Path) -> Option<PathBuf> {
    let sherpa_dir = models_base_dir.join("sherpa_onnx");
    if !sherpa_dir.is_dir() {
        return None;
    }

    if let Ok(entries) = std::fs::read_dir(&sherpa_dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("sherpa-onnx-v") && entry.path().is_dir() {
                let binary = entry.path().join("bin").join(OFFLINE_BINARY);
                if binary.exists() {
                    return Some(binary);
                }
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn stop_drains_queued_batches_and_uses_distinct_wavs_for_both_parties() {
        use std::os::unix::fs::PermissionsExt;

        let root = std::env::temp_dir().join(format!("nexq-sherpa-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let binary = root.join("recognizer");
        let model = root.join("model.onnx");
        let tokens = root.join("tokens.txt");
        std::fs::write(
            &binary,
            br#"#!/bin/sh
for wav in "$@"; do :; done
test -s "$wav" || exit 1
printf 'text: %s\n' "$wav"
"#,
        )
        .unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(&model, [1]).unwrap();
        std::fs::write(&tokens, "Test 0").unwrap();

        let mut parties = Vec::new();
        let capture_start = 1_800_000_000_000;
        for source in [
            crate::audio::AudioSource::Mic,
            crate::audio::AudioSource::System,
        ] {
            let mut stt = SherpaOfflineSTT::new(
                binary.clone(),
                model.clone(),
                tokens.clone(),
                OfflineModelType::SenseVoice,
                STTProviderType::SherpaOnnx,
            );
            let (output, rx) = mpsc::channel(8);
            stt.start_stream(output).await.unwrap();
            for (samples, end_ms) in [(BATCH_SAMPLES, 3_000), (1_600, 3_100)] {
                stt.feed_audio(AudioChunk {
                    pcm_data: vec![1_000; samples],
                    source: source.clone(),
                    timestamp_ms: capture_start + end_ms,
                    is_speech: true,
                })
                .await
                .unwrap();
            }
            parties.push((stt, rx));
        }

        let [(mut you, mut you_rx), (mut them, mut them_rx)] = parties.try_into().ok().unwrap();
        let (you, them) = tokio::join!(you.stop_stream(), them.stop_stream());
        you.unwrap();
        them.unwrap();
        let mut paths = std::collections::HashSet::new();
        for rx in [&mut you_rx, &mut them_rx] {
            for time in [capture_start, capture_start + 3_000] {
                let transcript = rx.try_recv().unwrap();
                assert_eq!(transcript.timestamp_ms, time);
                assert!(transcript.is_final);
                let path = Path::new(&transcript.text);
                assert!(
                    !path.exists(),
                    "temporary audio file still exists: {path:?}"
                );
                assert!(
                    paths.insert(path.to_path_buf()),
                    "two batches shared {path:?}"
                );
            }
            assert!(rx.recv().await.is_none());
        }
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn finds_the_offline_program_under_its_platform_name() {
        let models =
            std::env::temp_dir().join(format!("nexq-sherpa-offline-{}", std::process::id()));
        let bin = models
            .join("sherpa_onnx")
            .join("sherpa-onnx-v1.12.0")
            .join("bin");
        let _ = std::fs::remove_dir_all(&models);
        std::fs::create_dir_all(&bin).unwrap();
        assert_eq!(find_offline_binary(&models), None);
        std::fs::write(bin.join(OFFLINE_BINARY), b"").unwrap();
        assert_eq!(find_offline_binary(&models), Some(bin.join(OFFLINE_BINARY)));
        assert_eq!(OFFLINE_BINARY.ends_with(".exe"), cfg!(windows));
        assert!(missing_binary_message(&models).contains("Parakeet TDT 0.6B v3"));
        let _ = std::fs::remove_dir_all(&models);
    }
}
