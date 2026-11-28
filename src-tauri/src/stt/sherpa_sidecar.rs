// Sherpa-ONNX sidecar process STT provider.
//
// Spawns the sherpa-onnx streaming recognition binary as a child process,
// pipes PCM audio via stdin (little-endian i16 samples), and reads JSON-line
// results from stdout. Fully offline, true streaming transducer model.
//
// Fixes over original:
// - Uses model_discovery to find actual model file paths (epoch-based naming)
// - Captures stderr and surfaces errors to dev log
// - Sets working directory for DLL resolution

use async_trait::async_trait;
use serde::Deserialize;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::audio::AudioChunk;
use crate::stt::provider::{STTProvider, STTProviderType, TranscriptResult};

/// JSON line format emitted by sherpa-onnx-cli on stdout.
#[derive(Debug, Deserialize)]
struct SherpaJsonLine {
    text: String,
    #[serde(default)]
    is_endpoint: bool,
    #[serde(default)]
    segment_id: u64,
    #[serde(default)]
    #[allow(dead_code)]
    start_time: f64,
    #[serde(default)]
    end_time: f64,
}

/// Sherpa-ONNX sidecar STT provider.
pub struct SherpaSidecarSTT {
    /// Path to the sherpa-onnx streaming recognition binary.
    binary_path: PathBuf,
    /// Directory containing the model files (encoder, decoder, joiner, tokens).
    model_dir: PathBuf,
    /// Recognition language code.
    language: String,
    child: Option<Child>,
    stdin_tx: Option<mpsc::Sender<Vec<u8>>>,
    io_tasks: Vec<JoinHandle<()>>,
    /// Tauri app handle for emitting debug events.
    app_handle: Option<AppHandle>,
}

impl SherpaSidecarSTT {
    pub fn new(binary_path: PathBuf, model_dir: PathBuf) -> Self {
        Self {
            binary_path,
            model_dir,
            language: "en".to_string(),
            child: None,
            stdin_tx: None,
            io_tasks: Vec::new(),
            app_handle: None,
        }
    }

    pub fn set_app_handle(&mut self, handle: AppHandle) {
        self.app_handle = Some(handle);
    }

    /// Emit debug info to both Rust log and frontend dev log.
    fn debug(&self, level: &str, msg: &str) {
        match level {
            "error" => log::error!("[sherpa_sidecar] {}", msg),
            "warn" => log::warn!("[sherpa_sidecar] {}", msg),
            _ => log::info!("[sherpa_sidecar] {}", msg),
        }
        if let Some(ref handle) = self.app_handle {
            crate::stt::emit_stt_debug(handle, level, "sherpa_sidecar", msg);
        }
    }

    /// Build the argument list for the sherpa-onnx streaming recognition binary.
    /// Uses model_discovery to find actual file paths.
    fn build_args(&self) -> Result<Vec<String>, String> {
        let model_files =
            crate::stt::local_engines::model_discovery::discover_model_files(&self.model_dir)?;

        Ok(vec![
            format!("--encoder={}", model_files.encoder.display()),
            format!("--decoder={}", model_files.decoder.display()),
            format!("--joiner={}", model_files.joiner.display()),
            format!("--tokens={}", model_files.tokens.display()),
            "--provider=cpu".to_string(),
            "--num-threads=4".to_string(),
            "--sample-rate=16000".to_string(),
            "--enable-endpoint=1".to_string(),
            "--rule1-min-trailing-silence=1.2".to_string(),
            "--rule2-min-trailing-silence=2.4".to_string(),
            "--rule3-min-utterance-length=20".to_string(),
            "--input=stdin".to_string(),
            "--output-format=json".to_string(),
        ])
    }
}

impl Drop for SherpaSidecarSTT {
    fn drop(&mut self) {
        for task in self.io_tasks.drain(..) {
            task.abort();
        }
        // Tokio's kill-on-drop also handles reaping when a caller is cancelled.
        self.child.take();
    }
}

#[async_trait]
impl STTProvider for SherpaSidecarSTT {
    fn provider_name(&self) -> &str {
        "Sherpa-ONNX (Local, Streaming)"
    }

    fn provider_type(&self) -> STTProviderType {
        STTProviderType::SherpaOnnx
    }

    async fn start_stream(
        &mut self,
        result_tx: mpsc::Sender<TranscriptResult>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if self.child.is_some() {
            return Err("Stream already active".into());
        }

        // Verify the binary exists
        if !self.binary_path.exists() {
            return Err(format!(
                "Sherpa-ONNX binary not found at: {}",
                self.binary_path.display()
            )
            .into());
        }

        let args = self
            .build_args()
            .map_err(|e| format!("Failed to discover model files: {}", e))?;

        self.debug(
            "info",
            &format!(
                "Spawning {} with {} args",
                self.binary_path.display(),
                args.len()
            ),
        );

        // Set working directory to binary's parent so companion DLLs are found
        let working_dir = self
            .binary_path
            .parent()
            .unwrap_or(&self.binary_path)
            .to_path_buf();

        // Spawn the child process with piped stdin/stdout/stderr
        let mut child = Command::new(&self.binary_path)
            .args(&args)
            .current_dir(&working_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| {
                format!(
                    "Failed to spawn sherpa-onnx at {}: {}",
                    self.binary_path.display(),
                    e
                )
            })?;

        // Take ownership of stdin, stdout, stderr
        let child_stdin = child
            .stdin
            .take()
            .ok_or("Failed to open stdin pipe to sherpa-onnx")?;
        let child_stdout = child
            .stdout
            .take()
            .ok_or("Failed to open stdout pipe from sherpa-onnx")?;
        let child_stderr = child
            .stderr
            .take()
            .ok_or("Failed to open stderr pipe from sherpa-onnx")?;

        let (stdin_tx, mut stdin_rx) = mpsc::channel::<Vec<u8>>(256);
        let stdin_task = tokio::spawn(async move {
            let mut writer = child_stdin;
            while let Some(bytes) = stdin_rx.recv().await {
                if let Err(e) = writer.write_all(&bytes).await {
                    log::warn!("SherpaSidecarSTT: stdin write error: {e}");
                    break;
                }
            }
        });

        let language = self.language.clone();
        let process_start_epoch_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let stdout_task = tokio::spawn(async move {
            let mut lines = BufReader::new(child_stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let parsed = match serde_json::from_str::<SherpaJsonLine>(trimmed) {
                    Ok(parsed) => parsed,
                    Err(e) => {
                        log::warn!("SherpaSidecarSTT: invalid JSON: {e}");
                        continue;
                    }
                };

                let text = parsed.text.trim().to_owned();
                if text.is_empty() {
                    continue;
                }
                let timestamp_ms =
                    process_start_epoch_ms.saturating_add((parsed.end_time * 1000.0) as u64);
                let result = TranscriptResult {
                    text,
                    is_final: parsed.is_endpoint,
                    confidence: if parsed.is_endpoint { 0.92 } else { 0.80 },
                    timestamp_ms,
                    speaker: None,
                    language: Some(language.clone()),
                    segment_id: Some(format!("sherpa_seg_{}", parsed.segment_id)),
                    duration_ms: None,
                    speaker_tag: None,
                    turn: None,
                };
                if result_tx.send(result).await.is_err() {
                    break;
                }
            }
        });

        let stderr_app_handle = self.app_handle.clone();
        let stderr_task = tokio::spawn(async move {
            let mut lines = BufReader::new(child_stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.trim().is_empty() {
                    log::info!("[sherpa-onnx stderr] {}", line.trim());
                    if let Some(ref handle) = stderr_app_handle {
                        crate::stt::emit_stt_debug(handle, "info", "sherpa_binary", line.trim());
                    }
                }
            }
        });

        self.child = Some(child);
        self.stdin_tx = Some(stdin_tx);
        self.io_tasks.extend([stdin_task, stdout_task, stderr_task]);

        self.debug("info", "Stream started");
        Ok(())
    }

    async fn feed_audio(
        &mut self,
        chunk: AudioChunk,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let stdin_tx = self.stdin_tx.as_ref().ok_or("Stream not active")?;

        // Convert i16 PCM samples to little-endian bytes
        let mut bytes = Vec::with_capacity(chunk.pcm_data.len() * 2);
        for sample in &chunk.pcm_data {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }

        stdin_tx.send(bytes).await.map_err(|e| {
            format!(
                "SherpaSidecarSTT: Failed to send audio to stdin channel: {}",
                e
            )
        })?;

        Ok(())
    }

    async fn stop_stream(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.stdin_tx.take();
        let mut exit = Ok(());
        if let Some(child) = &mut self.child {
            exit = match tokio::time::timeout(Duration::from_secs(2), child.wait()).await {
                Ok(Ok(status)) if status.success() => Ok(()),
                Ok(Ok(status)) => Err(format!("Sherpa sidecar exited with {status}")),
                Ok(Err(e)) => {
                    let _ = child.kill().await;
                    Err(format!("Sherpa sidecar wait failed: {e}"))
                }
                Err(_) => {
                    let _ = child.kill().await;
                    Err("Sherpa sidecar did not exit after closing stdin".into())
                }
            };
            self.child.take();
        }

        let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
        while let Some(mut task) = self.io_tasks.pop() {
            if tokio::time::timeout_at(deadline, &mut task).await.is_err() {
                task.abort();
                let _ = task.await;
                if exit.is_ok() {
                    exit = Err("Timed out draining Sherpa sidecar output".into());
                }
            }
        }
        exit?;

        self.debug("info", "Stream stopped");
        Ok(())
    }

    async fn test_connection(&self) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        if !self.binary_path.exists() {
            return Err(format!("Binary not found: {}", self.binary_path.display()).into());
        }
        // Also verify model files exist
        match crate::stt::local_engines::model_discovery::discover_model_files(&self.model_dir) {
            Ok(_) => Ok(true),
            Err(e) => Err(format!("Model files not found: {}", e).into()),
        }
    }

    fn set_language(&mut self, language: &str) {
        self.language = language.split('-').next().unwrap_or(language).to_string();
        log::info!("SherpaSidecarSTT: Language set to {}", self.language);
    }
}
