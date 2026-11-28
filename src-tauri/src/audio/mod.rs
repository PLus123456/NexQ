pub mod device_default;
pub mod capture_common;
pub mod capture_supervisor;
pub mod device_manager;
pub mod echo_cancel;
pub mod encoder;
pub mod mic_capture;
pub mod recorder;
pub mod recording_mixer;
pub mod resampler;
pub mod session_monitor;
pub mod side_swap;
pub mod system_capture;
pub mod vad;
pub mod waveform;

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;

use crate::audio::capture_supervisor::{
    CaptureCounters, CaptureKind, SideHandle, SideSpec, StatusSink, SystemClock, START_TIMEOUT,
};
use crate::audio::recorder::{CaptureRecorder, FinishedRecording};
use crate::audio::vad::VoiceActivityDetector;

#[cfg(target_os = "windows")]
pub struct DeviceMonitor {
    pub running: Arc<AtomicBool>,
    pub thread: std::thread::JoinHandle<()>,
}

// ── Two-Party Model Types ──

/// Which side of the meeting this party represents.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum PartyRole {
    You,
    Them,
}

/// Per-party audio + STT configuration.
/// Each party independently selects an audio device and an STT provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PartyAudioConfig {
    pub role: PartyRole,
    pub device_id: String,
    pub is_input_device: bool,
    /// "web_speech" | "whisper_cpp" | "deepgram" | "whisper_api" | "azure_speech" | "groq_whisper"
    /// | "cartesia" | "openai_compat" | "soniox" | ...
    pub stt_provider: String,
    /// Model ID for local STT engines (e.g., "base", "small", "medium").
    /// Only used when stt_provider is a local engine like "whisper_cpp".
    #[serde(default)]
    pub local_model_id: Option<String>,
    /// Transcription language for this side only (e.g. "es-ES", or "auto").
    /// None or empty means the shared transcription language. Configs saved by
    /// older versions don't have it, hence the default.
    /// (NexQ Plus had this same field before upstream added it: one field.)
    #[serde(default)]
    pub language: Option<String>,
    /// NexQ Plus: translation done by the STT engine itself (Soniox). None = off.
    #[serde(default)]
    pub native_translation: Option<NativeTranslationConfig>,
}

impl PartyAudioConfig {
    /// The language this side is transcribed in: its own when it has one,
    /// otherwise the shared transcription language.
    pub fn effective_language(&self, shared: &str) -> String {
        self.own_language().unwrap_or(shared).to_string()
    }

    /// The language picked for this side alone, if any.
    pub fn own_language(&self) -> Option<&str> {
        self.language.as_deref().map(str::trim).filter(|own| !own.is_empty())
    }
}

/// NexQ Plus: per-party engine-side translation (`PartyAudioConfig.native_translation`).
/// An empty `target_language` follows the translation settings' target.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct NativeTranslationConfig {
    /// "off" | "one_way" | "two_way". Anything else counts as "off".
    pub mode: String,
    pub target_language: Option<String>,
    pub language_a: Option<String>,
    pub language_b: Option<String>,
}

impl NativeTranslationConfig {
    pub fn is_one_way(&self) -> bool {
        self.mode == "one_way"
    }
}

/// Information about an active audio session on the system (per-app awareness).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioSessionInfo {
    pub pid: u32,
    pub process_name: String,
    pub display_name: String,
    pub device_name: String,
    pub is_active: bool,
}

/// Coordinates mic + system capture threads and manages audio lifecycle.
pub struct AudioCaptureManager {
    pub is_capturing: bool,
    pub recording_enabled: bool,
    /// One thread per capture side, each owning its stream and reopening it
    /// when its device goes away (see `capture_supervisor`).
    sides: Vec<SideHandle>,
    /// Xruns and rebuilds of "You" and "Them" in this capture, for the stats line.
    counters: (Arc<CaptureCounters>, Arc<CaptureCounters>),
    /// What didn't start as chosen (a missing device replaced by the default,
    /// or one side not captured at all). Taken by the caller to warn the user.
    warnings: Vec<String>,
    /// Recording state shared with every audio consumer for this meeting.
    recorder: CaptureRecorder,
    /// Current meeting ID for recording file naming
    meeting_id: Option<String>,
    /// The meeting whose final stop already won over any in-flight settings update.
    stopped_meeting_id: Option<String>,
    /// VAD for mic audio
    mic_vad: VoiceActivityDetector,
    /// VAD for system audio
    system_vad: VoiceActivityDetector,
    /// Recent mic audio level (for UI)
    mic_level: f32,
    /// Recent mic peak level
    mic_peak: f32,
    /// Recent system audio level (for UI)
    system_level: f32,
    /// Recent system peak level
    system_peak: f32,
    // -- Audio test state --
    /// Temporary test stream for mic device testing
    pub test_stream: Option<cpal::Stream>,
    /// Temporary test thread for system audio (WASAPI loopback) testing
    pub test_system_thread: Option<std::thread::JoinHandle<()>>,
    /// Stop flag for system audio test thread
    pub test_stop_flag: Arc<AtomicBool>,
    /// Whether any non-silent audio was detected during test
    pub test_audio_detected: Arc<AtomicBool>,
}

impl AudioCaptureManager {
    pub fn new() -> Self {
        Self {
            is_capturing: false,
            recording_enabled: false,
            sides: Vec::new(),
            counters: Default::default(),
            warnings: Vec::new(),
            recorder: CaptureRecorder::default(),
            meeting_id: None,
            stopped_meeting_id: None,
            mic_vad: VoiceActivityDetector::new(),
            system_vad: VoiceActivityDetector::new(),
            mic_level: 0.0,
            mic_peak: 0.0,
            system_level: 0.0,
            system_peak: 0.0,
            test_stream: None,
            test_system_thread: None,
            test_stop_flag: Arc::new(AtomicBool::new(false)),
            test_audio_detected: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Start capturing audio from both mic and system sources.
    ///
    /// `tx` is the channel where AudioChunks (with VAD applied) will be sent.
    /// The caller (typically the STT module) receives chunks from this channel.
    ///
    /// When `system_is_input` is true, the system device is an input device
    /// (e.g. a virtual cable like AudienceMix) — capture it via standard
    /// mic capture tagged as AudioSource::System instead of WASAPI loopback.
    ///
    /// Each side runs on its own thread, which reconnects it on its own when
    /// its device goes away and reports that through `on_status`.
    pub fn start_capture(
        &mut self,
        mic_device_id: &str,
        system_device_id: &str,
        system_is_input: bool,
        tx: mpsc::Sender<AudioChunk>,
        on_status: StatusSink,
    ) -> Result<(), String> {
        if self.is_capturing {
            return Err("Capture already in progress".to_string());
        }

        log::info!("Starting audio capture pipeline");
        self.warnings.clear();
        self.counters = Default::default();
        if let Err(err) = self.recorder.set_enabled(self.recording_enabled, self.meeting_id.as_deref()) {
            log::error!("Failed to start recording: {err}");
            self.warnings.push(format!("Couldn't start the recording: {err}"));
        }
        // Why "You" isn't captured, if the mic (and the default mic) failed.
        let mut mic_error: Option<String> = None;
        // Why "Them" isn't captured, if their device failed.
        let mut system_error: Option<String> = None;

        // Same-device optimization: when both parties use the same input device,
        // open ONE capture and duplicate chunks with both Mic + System tags.
        // This avoids two cpal streams contending for the same 256-slot channel.
        let same_device = system_is_input
            && !system_device_id.is_empty()
            && system_device_id != "default"
            && mic_device_id == system_device_id;

        if same_device {
            log::info!(
                "Same input device for mic & system ('{}') — single capture with dual tagging",
                mic_device_id
            );
            // Single capture that produces both Mic and System chunks
            let (side, _) = self
                .spawn_input(CaptureKind::Dual, mic_device_id, mic_capture::InputTags::Both, &tx, &on_status)
                .map_err(|errors| format!("Dual capture failed: {}", errors.join("; ")))?;
            self.sides.push(side);
            // One stream serves both sides: its xruns and rebuilds show on both stats lines.
            self.counters.1 = Arc::clone(&self.counters.0);
            log::info!("Dual-tagged capture started on shared device");
        } else {
            // Standard: separate mic capture, or the default mic when the chosen one fails.
            match self.spawn_input(
                CaptureKind::Mic,
                mic_device_id,
                mic_capture::InputTags::One(AudioSource::Mic),
                &tx,
                &on_status,
            ) {
                Ok((side, replaced)) => {
                    self.sides.push(side);
                    if replaced {
                        self.warnings.push(crate::i18n::messages::mic_fallback(
                            crate::i18n::current_ui_language(),
                            mic_device_id,
                        ));
                    }
                    log::info!("Mic capture started");
                }
                Err(errors) => {
                    // Keep going: the other side may still be captured.
                    let e = match errors.as_slice() {
                        [chosen, default] => format!("{chosen}; the default microphone failed too: {default}"),
                        _ => errors.join("; "),
                    };
                    log::error!("Failed to start mic capture: {e}");
                    mic_error = Some(e);
                }
            }
        }

        // Start system audio capture (only if not already handled by same-device path)
        if same_device {
            // Already handled above — both Mic and System chunks from single stream
        } else if system_is_input {
            // "Them" is a different input device — capture tagged as System
            match self.spawn_input(
                CaptureKind::InputThem,
                system_device_id,
                mic_capture::InputTags::One(AudioSource::System),
                &tx,
                &on_status,
            ) {
                Ok((side, _)) => {
                    self.sides.push(side);
                    log::info!("System audio capture started via input device (tagged as System)");
                }
                Err(errors) => {
                    // Keep "You" running; the caller warns about the other side.
                    let e = errors.join("; ");
                    log::error!("System input capture failed: {e}. The other party won't be captured.");
                    system_error = Some(e);
                }
            }
        } else {
            // A chosen output that isn't connected falls back to the default output.
            let (messages_tx, messages_rx) = capture_supervisor::side_channel();
            let opener = system_capture::OutputOpener { tx: tx.clone(), errors: messages_tx.clone() };
            match capture_supervisor::spawn_side(
                SideSpec {
                    kind: CaptureKind::Output,
                    device_id: system_device_id.to_string(),
                    opener,
                    clock: SystemClock,
                    counters: Arc::clone(&self.counters.1),
                    sink: Arc::clone(&on_status),
                    start_timeout: START_TIMEOUT,
                },
                (messages_tx, messages_rx),
            ) {
                Ok((side, started)) => {
                    self.sides.push(side);
                    if let Some(reason) = started.and_then(|s| s.replaced) {
                        log::warn!("Output '{system_device_id}' failed ({reason}); capturing the default output instead");
                        self.warnings.push(crate::i18n::messages::output_fallback(
                            crate::i18n::current_ui_language(),
                            system_device_id,
                        ));
                    }
                    log::info!("System output audio capture started");
                }
                Err(errors) => {
                    // Keep "You" running; the caller warns about the other side.
                    // The last error is the last device tried (the default output).
                    let e = errors.last().cloned().unwrap_or_default();
                    log::error!("System output capture failed: {e}. The other party won't be captured.");
                    system_error = Some(e);
                }
            }
        }

        match (mic_error, system_error) {
            (Some(mic), Some(system)) => {
                self.stop_sides();
                return Err(format!("Couldn't capture any audio. Microphone: {mic}. Other side: {system}"));
            }
            (Some(mic), None) => self.warnings.push(format!(
                "Couldn't capture your microphone ({mic}). The other side is still transcribed."
            )),
            (None, Some(system)) => self.warnings.push(format!(
                "Couldn't capture the other side ({system}). Your microphone is still transcribed."
            )),
            (None, None) => {}
        }

        self.is_capturing = true;
        log::info!("Audio capture pipeline started");
        Ok(())
    }

    /// Start a supervised input-device side. Ok: its handle, and whether the
    /// default device stands in for the chosen one. Err: each device's error.
    fn spawn_input(
        &self,
        kind: CaptureKind,
        device_id: &str,
        tags: mic_capture::InputTags,
        tx: &mpsc::Sender<AudioChunk>,
        on_status: &StatusSink,
    ) -> Result<(SideHandle, bool), Vec<String>> {
        let (messages_tx, messages_rx) = capture_supervisor::side_channel();
        let opener = mic_capture::InputOpener {
            tx: tx.clone(),
            tags,
            side: kind.side(),
            errors: messages_tx.clone(),
        };
        let counters = match kind.side() {
            capture_supervisor::CaptureSide::You => &self.counters.0,
            capture_supervisor::CaptureSide::Them => &self.counters.1,
        };
        let (side, started) = capture_supervisor::spawn_side(
            SideSpec {
                kind,
                device_id: device_id.to_string(),
                opener,
                clock: SystemClock,
                counters: Arc::clone(counters),
                sink: Arc::clone(on_status),
                start_timeout: START_TIMEOUT,
            },
            (messages_tx, messages_rx),
        )?;
        if let Some(reason) = started.as_ref().and_then(|s| s.replaced.as_ref()) {
            log::warn!("Input '{device_id}' failed ({reason}); using the default input instead");
        }
        let replaced = started.is_some_and(|s| s.replaced.is_some());
        Ok((side, replaced))
    }

    /// What didn't start as chosen, once (see `warnings`).
    pub fn take_warnings(&mut self) -> Vec<String> {
        std::mem::take(&mut self.warnings)
    }

    /// Xruns and rebuilds per side ("You", "Them") for the current capture.
    pub fn capture_counters(&self) -> (Arc<CaptureCounters>, Arc<CaptureCounters>) {
        (Arc::clone(&self.counters.0), Arc::clone(&self.counters.1))
    }

    /// Stop all audio capture.
    /// Returns the WAV with its originating meeting if a recording was active.
    ///
    /// `keep_recording` (a device change mid-meeting): the recorder stays
    /// open and the next `start_capture` keeps writing to it.
    pub fn stop_capture(&mut self, keep_recording: bool) -> Option<FinishedRecording> {
        if self.is_capturing {
            self.stop_streams();
        }
        if keep_recording {
            return None;
        }
        // Also when the restart after a device change failed: the recording
        // kept open for it is finalized here.
        self.meeting_id = None;
        self.recorder.stop()
    }

    fn stop_streams(&mut self) {
        log::info!("Stopping audio capture pipeline");

        // Each side drops its stream and cancels any pending reconnect.
        self.stop_sides();

        // Reset VADs
        self.mic_vad.reset();
        self.system_vad.reset();

        self.is_capturing = false;
        log::info!("Audio capture pipeline stopped");
    }

    /// Stop every side's thread (all asked first, then joined).
    fn stop_sides(&mut self) {
        for side in &self.sides {
            side.request_stop();
        }
        for side in self.sides.drain(..) {
            side.join();
        }
    }

    /// Check if capture is active.
    pub fn is_capturing(&self) -> bool {
        self.is_capturing
    }

    /// Enable or disable recording to file.
    pub fn set_recording_enabled(&mut self, enabled: bool) -> Result<(), String> {
        let meeting = self.meeting_id.as_deref().filter(|_| self.is_capturing);
        self.recorder.set_enabled(enabled, meeting)?;
        self.recording_enabled = enabled;
        log::info!("Recording {}", if enabled { "enabled" } else { "disabled" });
        Ok(())
    }

    /// Set the meeting ID for file naming.
    pub fn set_meeting_id(&mut self, meeting_id: Option<String>) {
        self.meeting_id = meeting_id;
    }

    pub fn note_stopped_meeting(&mut self, meeting_id: Option<String>) {
        self.stopped_meeting_id = meeting_id;
    }

    pub fn stopped_meeting(&self, id: &str) -> bool {
        self.stopped_meeting_id.as_deref() == Some(id)
    }

    /// Process an audio chunk through VAD and optionally record it.
    /// Returns a new chunk with `is_speech` set correctly.
    pub fn process_chunk(&mut self, mut chunk: AudioChunk) -> AudioChunk {
        match chunk.source {
            AudioSource::Mic => {
                let vad_result = self.mic_vad.process_chunk(&chunk.pcm_data);
                chunk.is_speech = vad_result.is_speech;
                self.mic_level = vad_result.energy;
                self.mic_peak = vad::calculate_peak(&chunk.pcm_data);
            }
            AudioSource::System => {
                let vad_result = self.system_vad.process_chunk(&chunk.pcm_data);
                chunk.is_speech = vad_result.is_speech;
                self.system_level = vad_result.energy;
                self.system_peak = vad::calculate_peak(&chunk.pcm_data);
            }
            AudioSource::Room => {
                // In-person mode: Room audio uses the mic VAD pipeline but
                // reports levels as both mic and system (since it's a single shared source).
                let vad_result = self.mic_vad.process_chunk(&chunk.pcm_data);
                chunk.is_speech = vad_result.is_speech;
                self.mic_level = vad_result.energy;
                self.mic_peak = vad::calculate_peak(&chunk.pcm_data);
                // Mirror to system level so UI shows activity on both meters
                self.system_level = vad_result.energy;
                self.system_peak = self.mic_peak;
            }
        }

        // Note: Recording is handled by the processing loops in audio_commands.rs
        // (with proper mic/system mixing). process_chunk only handles VAD + levels.

        chunk
    }

    /// Flush the mic/system mix buffers to the recorder.
    /// When `force` is true, flush all remaining samples (used at recording end).
    /// Otherwise, only flush when both buffers have samples.
    /// Get the current audio levels for UI display.
    pub fn get_audio_levels(&self) -> (AudioLevel, AudioLevel) {
        (
            AudioLevel {
                source: AudioSource::Mic,
                level: self.mic_level,
                peak: self.mic_peak,
            },
            AudioLevel {
                source: AudioSource::System,
                level: self.system_level,
                peak: self.system_peak,
            },
        )
    }

    /// Get a clone of the shared recorder (for use in audio processing pipeline).
    pub fn get_recorder(&self) -> CaptureRecorder {
        self.recorder.clone()
    }

    /// Start a device test capture. Returns a channel receiver for audio chunks.
    /// For input devices: opens a mic capture stream.
    /// For output devices: starts WASAPI loopback capture.
    pub fn start_test(
        &mut self,
        device_id: &str,
        is_input: bool,
    ) -> Result<mpsc::Receiver<AudioChunk>, String> {
        // Stop any existing test first
        self.stop_test();

        let (tx, rx) = mpsc::channel::<AudioChunk>(64);
        self.test_audio_detected.store(false, Ordering::SeqCst);

        if is_input {
            let stream = mic_capture::start_mic_capture(device_id, tx, AudioSource::Mic)?;
            self.test_stream = Some(stream);
            log::info!("Audio test started for input device: {}", device_id);
        } else {
            // For output devices, use WASAPI loopback on the selected device
            self.test_stop_flag.store(false, Ordering::SeqCst);
            let stop_flag = Arc::clone(&self.test_stop_flag);
            let dev_name = if device_id.is_empty() || device_id == "default" {
                None
            } else {
                Some(device_id.to_string())
            };
            match system_capture::start_system_capture_device(tx, stop_flag, dev_name) {
                Ok(handle) => {
                    self.test_system_thread = Some(handle);
                    log::info!("Audio test started for output device: {}", device_id);
                }
                Err(e) => {
                    return Err(format!("System audio test failed: {}", e));
                }
            }
        }

        Ok(rx)
    }

    /// Stop a running device test and return whether audio was detected.
    pub fn stop_test(&mut self) -> bool {
        // Stop mic test stream
        self.test_stream.take();

        // Stop system audio test thread
        self.test_stop_flag.store(true, Ordering::SeqCst);
        if let Some(thread) = self.test_system_thread.take() {
            let _ = thread.join();
        }

        let detected = self.test_audio_detected.load(Ordering::SeqCst);
        log::info!(
            "Audio test stopped, audio detected: {}",
            detected
        );
        detected
    }

}

impl Drop for AudioCaptureManager {
    fn drop(&mut self) {
        self.stop_capture(false);
    }
}

/// The output contract consumed by STT (Sub-PRD 4).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioChunk {
    pub pcm_data: Vec<i16>,
    pub source: AudioSource,
    /// Unix epoch milliseconds of the last sample in this chunk.
    pub timestamp_ms: u64,
    pub is_speech: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum AudioSource {
    Mic,
    System,
    /// In-person meeting mode: single shared microphone capturing the room.
    Room,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub is_input: bool,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioDeviceList {
    pub inputs: Vec<AudioDevice>,
    pub outputs: Vec<AudioDevice>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioLevel {
    pub source: AudioSource,
    pub level: f32,
    pub peak: f32,
}

/// Post-meeting recording pipeline.
///
/// Steps:
/// Archive a finalized WAV and publish the paths once the meeting row owns them.
pub async fn process_recording(
    wav_path: std::path::PathBuf,
    meeting_id: String,
    recording_offset_ms: i64,
    db: Arc<std::sync::Mutex<crate::db::DatabaseManager>>,
    app: tauri::AppHandle,
) {
    use tauri::Emitter;

    let result = tokio::task::spawn_blocking(move || {
        archive_recording(&wav_path, &meeting_id, recording_offset_ms, &db)
    }).await;
    match result {
        Ok(Ok(Some(payload))) => {
            if let Err(err) = app.emit("recording_ready", payload) {
                log::error!("Failed to emit recording_ready: {err}");
            }
        }
        Ok(Ok(None)) => {}
        Ok(Err(err)) => log::error!("Could not archive recording: {err}"),
        Err(err) => log::error!("Recording archive task failed: {err}"),
    }
}

fn archive_recording(
    wav_path: &std::path::Path,
    meeting_id: &str,
    offset: i64,
    db: &std::sync::Mutex<crate::db::DatabaseManager>,
) -> Result<Option<serde_json::Value>, String> {
    let wav_path_text = wav_path.to_string_lossy();
    {
        let guard = db.lock().map_err(|_| "Database lock poisoned")?;
        if !recording_path_matches(guard.connection(), meeting_id, &wav_path_text)? {
            return Ok(None);
        }
    }
    let original_size = std::fs::metadata(wav_path).map_err(|err| err.to_string())?.len();
    let reader = hound::WavReader::open(wav_path)
        .map_err(|err| format!("Couldn't open recording for meeting {meeting_id}: {err}"))?;
    let empty = reader.duration() == 0;
    drop(reader);
    if empty {
        let guard = db.lock().map_err(|_| "Database lock poisoned")?;
        let conn = guard.connection();
        if recording_path_matches(conn, meeting_id, &wav_path_text)? {
            crate::db::meetings::delete_recording(conn, meeting_id)
                .map_err(|error| error.to_string())?;
            crate::commands::recording_commands::complete_recording_file_deletion(conn, meeting_id)?;
        }
        return Ok(None);
    }
    let waveform_file = wav_path.with_extension("waveform.json");
    let waveform = match waveform::extract_peaks(wav_path)
        .and_then(|data| waveform::write_waveform_json(&data, &waveform_file))
    {
        Ok(()) => Some(waveform_file.to_string_lossy().into_owned()),
        Err(err) => {
            remove_archive_file(&waveform_file);
            log::warn!("Waveform unavailable for meeting {meeting_id}: {err}");
            None
        }
    };

    let opus_path = wav_path.with_extension("ogg");
    let (recording_file, size) = match encoder::encode_wav_to_opus(wav_path, &opus_path) {
        Ok(size) => (opus_path.as_path(), size),
        Err(err) => {
            remove_archive_file(&opus_path);
            log::warn!("Opus encoding failed for meeting {meeting_id}, keeping WAV: {err}");
            (wav_path, original_size)
        }
    };
    let recording_path = recording_file.to_string_lossy();
    let attached = {
        let guard = db.lock().map_err(|_| "Database lock poisoned");
        guard.map_err(str::to_string).and_then(|guard| {
            let conn = guard.connection();
            if !recording_path_matches(conn, meeting_id, &wav_path_text)? {
                return Ok(0);
            }
            crate::db::meetings::update_meeting_recording(
                conn, meeting_id, &recording_path, size as i64, waveform.as_deref(), offset,
            ).map_err(|err| err.to_string())
        })
    };
    match attached {
        Ok(0) => {
            // History can delete the recording or its meeting during conversion.
            remove_archive_file(wav_path);
            remove_archive_file(&opus_path);
            remove_archive_file(&waveform_file);
            Ok(None)
        }
        Ok(_) => {
            if recording_file != wav_path {
                remove_archive_file(wav_path);
            }
            Ok(Some(serde_json::json!({
                "meeting_id": meeting_id,
                "recording_path": recording_path,
                "recording_size": size,
                "waveform_path": waveform,
                "recording_offset_ms": offset,
            })))
        }
        Err(err) => {
            // The raw recording is recoverable even if the database write fails.
            remove_archive_file(&opus_path);
            remove_archive_file(&waveform_file);
            Err(err)
        }
    }
}

fn recording_path_matches(
    conn: &rusqlite::Connection,
    meeting_id: &str,
    path: &str,
) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM meetings WHERE id = ?1 AND recording_path = ?2)",
        [meeting_id, path],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

fn remove_archive_file(path: &std::path::Path) {
    if let Err(error) = std::fs::remove_file(path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            log::warn!("Couldn't remove {}: {error}", path.display());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_wav(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("nexq-rec-{}-{}", name, std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("meeting.wav")
    }

    #[test]
    fn archive_can_attach_valid_opus_with_no_waveform() {
        let wav = temp_wav("optional-waveform");
        let directory = wav.parent().unwrap();
        let waveform = wav.with_extension("waveform.json");
        let opus = wav.with_extension("ogg");
        std::fs::create_dir(&waveform).unwrap(); // The waveform write will fail.
        let writer = recorder::start_recording_at(wav.clone()).unwrap();
        writer.write_samples(&[100; 1600]);
        writer.stop().unwrap();

        let database = crate::db::DatabaseManager::new(directory.to_path_buf()).unwrap();
        let meeting = crate::db::meetings::create_meeting(database.connection(), "Recorded").unwrap();
        crate::db::meetings::update_meeting_recording(
            database.connection(), &meeting.id, wav.to_str().unwrap(), 0, None, 10,
        ).unwrap();
        let database = std::sync::Mutex::new(database);
        assert!(archive_recording(&wav, &meeting.id, 10, &database).unwrap().is_some());
        let saved = crate::db::meetings::get_meeting(database.lock().unwrap().connection(), &meeting.id).unwrap();
        assert_eq!(saved.recording_path.as_deref(), opus.to_str());
        assert_eq!(saved.waveform_path, None);
        assert!(encoder::opus_duration_ms(&opus).unwrap() >= 100);
        assert!(!wav.exists());
        drop(database);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn queued_archive_skips_a_recording_deleted_before_it_starts() {
        let wav = temp_wav("deleted-before-archive");
        let directory = wav.parent().unwrap();
        let writer = recorder::start_recording_at(wav.clone()).unwrap();
        writer.write_samples(&[100; 1600]);
        writer.stop().unwrap();

        let database = crate::db::DatabaseManager::new(directory.to_path_buf()).unwrap();
        let conn = database.connection();
        let meeting = crate::db::meetings::create_meeting(conn, "Recorded").unwrap();
        crate::db::meetings::update_meeting_recording(conn, &meeting.id, wav.to_str().unwrap(), 0, None, 0).unwrap();
        crate::db::meetings::delete_recording(conn, &meeting.id).unwrap();
        // Cleanup may have to retry and the old WAV may temporarily remain.
        assert!(wav.exists());
        let database = std::sync::Mutex::new(database);
        assert!(archive_recording(&wav, &meeting.id, 0, &database).unwrap().is_none());
        assert!(!wav.with_extension("ogg").exists());
        assert!(!wav.with_extension("waveform.json").exists());
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    /// A device change mid-meeting must not replace the recording: the
    /// recorder stays open and the gap becomes silence.
    #[test]
    fn a_device_change_keeps_the_recording() {
        let path = temp_wav("keep");
        let mut mgr = AudioCaptureManager::new();
        mgr.recording_enabled = true;
        use recording_mixer::MixSide;
        let (rec, started) = CaptureRecorder::for_test("meeting", path.clone());
        rec.push(MixSide::Mic, &[100; 16_000], started + 1000);
        mgr.recorder = rec.clone();

        assert!(mgr.stop_capture(true).is_none(), "nothing to process yet");
        rec.push(MixSide::Mic, &[100; 16_000], started + 2200);

        let saved = mgr.stop_capture(false).expect("recording info at End");
        assert_eq!(saved.wav_path, path);
        assert_eq!(saved.start_time_ms, started);
        assert_eq!(saved.meeting_id, "meeting");
        let reader = hound::WavReader::open(&path).unwrap();
        let samples: Vec<i16> = reader.into_samples::<i16>().map(Result::unwrap).collect();
        assert_eq!(samples.len(), 35_200, "both parts and the capture gap");
        assert_eq!(samples[0], 400);
        assert_eq!(samples[16_000], 0, "the gap is silence");
        assert_eq!(samples[19_200], 400);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// The restart after a device change failed: End still finalizes the recording.
    #[test]
    fn end_finalizes_a_kept_recording_without_capture() {
        let path = temp_wav("end");
        let mut mgr = AudioCaptureManager::new();
        let (rec, start) = CaptureRecorder::for_test("meeting", path.clone());
        rec.push(recording_mixer::MixSide::Mic, &[100; 160], start + 10);
        mgr.recorder = rec;
        mgr.stop_capture(true);
        assert!(mgr.stop_capture(false).is_some());
        assert!(mgr.stop_capture(false).is_none());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    use capture_supervisor::tests::Rig;
    use capture_supervisor::{side_channel, spawn_side, SideSpec, CaptureSide, SideMessage};

    /// A side on a fake device, as `start_capture` would add it. Returns the
    /// sender its stream's error callback would use.
    fn fake_side(
        mgr: &mut AudioCaptureManager,
        rig: &Rig,
        kind: CaptureKind,
        device: &str,
    ) -> std::sync::mpsc::SyncSender<SideMessage> {
        let (tx, rx) = side_channel();
        let errors = tx.clone();
        let (side, started) = spawn_side(
            SideSpec {
                kind,
                device_id: device.to_string(),
                opener: rig.opener(kind.side(), device),
                clock: SystemClock,
                counters: Arc::clone(&rig.counters),
                sink: rig.sink(),
                start_timeout: START_TIMEOUT,
            },
            (tx, rx),
        )
        .unwrap();
        assert!(started.is_some());
        mgr.sides.push(side);
        mgr.is_capturing = true;
        errors
    }

    fn invalidated(side: CaptureSide) -> SideMessage {
        // A device id that is a single choice opens once at start: generation 1.
        SideMessage::StreamError { side, generation: 1, error: cpal::Error::new(cpal::ErrorKind::StreamInvalidated) }
    }

    fn wait_until(what: impl Fn() -> bool) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !what() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }

    /// (h) A side reconnecting mid-meeting never finalizes or replaces the recording.
    #[test]
    fn a_rebuild_keeps_the_recording_open() {
        let path = temp_wav("rebuild");
        let mut mgr = AudioCaptureManager::new();
        use recording_mixer::MixSide;
        let (rec, start) = CaptureRecorder::for_test("meeting", path.clone());
        mgr.recorder = rec.clone();
        let rig = Rig::new(&["Mic"]);
        let errors = fake_side(&mut mgr, &rig, CaptureKind::Mic, "Mic");

        rec.push(MixSide::Mic, &[100; 16_000], start + 1000);
        errors.send(invalidated(CaptureSide::You)).unwrap();
        wait_until(|| rig.attempts(CaptureSide::You) == 2);
        assert_eq!(rig.attempts(CaptureSide::You), 2, "the mic was reopened");
        assert_eq!(rig.live(CaptureSide::You), 1);
        rec.push(MixSide::Mic, &[100; 16_000], start + 2000);

        let saved = mgr.stop_capture(false).expect("one recording at End");
        assert_eq!(saved.wav_path, path);
        let reader = hound::WavReader::open(&path).unwrap();
        let samples: Vec<i16> = reader.into_samples::<i16>().map(Result::unwrap).collect();
        assert_eq!(samples.len(), 32_000, "before and after the rebuild, in one file");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// (i) A Settings hot-swap while a rebuild is pending: the old sides stop
    /// without reopening, the new ones start, one stream per side.
    #[test]
    fn a_hot_swap_cancels_pending_rebuilds() {
        let mut mgr = AudioCaptureManager::new();
        let rig = Rig::new(&["Mic", "Speakers"]);
        let you = fake_side(&mut mgr, &rig, CaptureKind::Mic, "Mic");
        let them = fake_side(&mut mgr, &rig, CaptureKind::Output, "Speakers");
        you.send(invalidated(CaptureSide::You)).unwrap();
        them.send(invalidated(CaptureSide::Them)).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50)); // both rebuilds pending

        mgr.stop_capture(true);
        assert_eq!((rig.live(CaptureSide::You), rig.live(CaptureSide::Them)), (0, 0));
        fake_side(&mut mgr, &rig, CaptureKind::Mic, "Mic");
        fake_side(&mut mgr, &rig, CaptureKind::Output, "Speakers");
        std::thread::sleep(std::time::Duration::from_millis(800)); // past the debounce

        assert_eq!((rig.live(CaptureSide::You), rig.live(CaptureSide::Them)), (1, 1));
        assert_eq!(rig.attempts(CaptureSide::You), 2, "two starts, no rebuild");
        assert_eq!(rig.attempts(CaptureSide::Them), 2, "two starts, no rebuild");
        assert!(!rig.states().contains(&capture_supervisor::CaptureState::Recovered));
        mgr.stop_capture(false);
        assert_eq!((rig.live(CaptureSide::You), rig.live(CaptureSide::Them)), (0, 0));
    }

    /// Samples per source over `secs` of real capture through `start_capture`
    /// on the default devices, while a silent output stream keeps the
    /// loopback fed (Windows loopback sends nothing while nothing plays).
    fn capture_default_devices(secs: u64) -> (usize, usize, Vec<String>) {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
        let output = cpal::default_host().default_output_device().expect("a default output");
        let config = output.default_output_config().expect("an output config");
        let silence = output
            .build_output_stream_raw(
                config.config(),
                config.sample_format(),
                |data: &mut cpal::Data, _: &cpal::OutputCallbackInfo| data.bytes_mut().fill(0),
                |e| log::warn!("silence stream: {e}"),
                None,
            )
            .expect("a silent output stream");
        silence.play().unwrap();

        let (tx, mut rx) = mpsc::channel::<AudioChunk>(4096);
        let mut mgr = AudioCaptureManager::new();
        let statuses = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink_statuses = Arc::clone(&statuses);
        mgr.start_capture(
            "default",
            "default",
            false,
            tx,
            Arc::new(move |s: capture_supervisor::CaptureStatus| sink_statuses.lock().unwrap().push(s.message)),
        )
        .expect("capture starts");
        let warnings = mgr.take_warnings();
        let (mut mic, mut system) = (0, 0);
        let end = std::time::Instant::now() + std::time::Duration::from_secs(secs);
        while std::time::Instant::now() < end {
            while let Ok(chunk) = rx.try_recv() {
                match chunk.source {
                    AudioSource::Mic => mic += chunk.pcm_data.len(),
                    AudioSource::System => system += chunk.pcm_data.len(),
                    AudioSource::Room => {}
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        mgr.stop_capture(false);
        drop(silence);
        let mut notes = warnings;
        notes.extend(statuses.lock().unwrap().iter().cloned());
        (mic, system, notes)
    }

    /// Hardware probe: the default mic delivers 16 kHz through the supervised side.
    /// `cargo test --lib -- --ignored hardware_default_mic`
    #[test]
    #[ignore = "needs a microphone"]
    fn hardware_default_mic_delivers_16k() {
        let (mic, _, notes) = capture_default_devices(3);
        assert!(mic >= 3 * 14_000, "mic: {mic} samples in 3 s ({notes:?})");
    }

    /// Hardware probe: default-output loopback delivers 16 kHz through the supervised side.
    /// `cargo test --lib -- --ignored hardware_default_output_loopback`
    #[test]
    #[ignore = "needs an output device"]
    fn hardware_default_output_loopback_delivers_16k() {
        let (_, system, notes) = capture_default_devices(3);
        assert!(system >= 3 * 14_000, "loopback: {system} samples in 3 s ({notes:?})");
    }

    /// Hardware probe: a real mic stream dropped and reopened by its side after
    /// a StreamInvalidated keeps delivering on the same channel.
    /// `cargo test --lib -- --ignored hardware_default_mic_reopens`
    #[test]
    #[ignore = "needs a microphone"]
    fn hardware_default_mic_reopens_after_stream_invalidated() {
        let (tx, mut rx) = mpsc::channel::<AudioChunk>(4096);
        let (side_tx, side_rx) = side_channel();
        let errors = side_tx.clone();
        let opener = mic_capture::InputOpener {
            tx,
            tags: mic_capture::InputTags::One(AudioSource::Mic),
            side: CaptureSide::You,
            errors: side_tx.clone(),
        };
        let statuses = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink_statuses = Arc::clone(&statuses);
        let counters = Arc::new(CaptureCounters::default());
        let (side, _) = spawn_side(
            SideSpec {
                kind: CaptureKind::Mic,
                device_id: "default".to_string(),
                opener,
                clock: SystemClock,
                counters: Arc::clone(&counters),
                sink: Arc::new(move |s: capture_supervisor::CaptureStatus| sink_statuses.lock().unwrap().push(s.state)),
                start_timeout: START_TIMEOUT,
            },
            (side_tx, side_rx),
        )
        .expect("the default mic opens");
        let count = |rx: &mut mpsc::Receiver<AudioChunk>, secs: u64| {
            let mut n = 0;
            let end = std::time::Instant::now() + std::time::Duration::from_secs(secs);
            while std::time::Instant::now() < end {
                while let Ok(chunk) = rx.try_recv() {
                    n += chunk.pcm_data.len();
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            n
        };
        let before = count(&mut rx, 2);
        errors.send(invalidated(CaptureSide::You)).unwrap();
        let _ = count(&mut rx, 1); // debounce + reopen
        let after = count(&mut rx, 2);
        side.join();
        assert_eq!(
            *statuses.lock().unwrap(),
            vec![capture_supervisor::CaptureState::Recovering, capture_supervisor::CaptureState::Recovered]
        );
        assert_eq!(counters.rebuilds(), 1);
        assert!(before >= 2 * 14_000 && after >= 2 * 14_000, "before {before}, after {after}");
    }

    #[test]
    fn a_config_saved_before_per_side_languages_still_loads() {
        // Exactly what an older version stored: no `language`, no `local_model_id`.
        let old = r#"{"role":"Them","device_id":"default","is_input_device":false,"stt_provider":"deepgram"}"#;
        let config: PartyAudioConfig = serde_json::from_str(old).unwrap();
        assert_eq!(config.language, None);
        assert_eq!(config.effective_language("fr-FR"), "fr-FR");
    }

    #[test]
    fn a_side_language_wins_over_the_shared_one() {
        let json = |language: &str| {
            format!(
                r#"{{"role":"You","device_id":"d","is_input_device":true,"stt_provider":"deepgram","language":{language}}}"#
            )
        };
        let own: PartyAudioConfig = serde_json::from_str(&json(r#""es-ES""#)).unwrap();
        assert_eq!(own.effective_language("en-US"), "es-ES");
        let auto: PartyAudioConfig = serde_json::from_str(&json(r#""auto""#)).unwrap();
        assert_eq!(auto.effective_language("en-US"), "auto");
        // null, empty and blank all mean "same as the shared language".
        for same in ["null", r#""""#, r#""  ""#] {
            let config: PartyAudioConfig = serde_json::from_str(&json(same)).unwrap();
            assert_eq!(config.effective_language("de-DE"), "de-DE", "{same}");
        }
        // The shared language can itself be Auto-detect.
        let none: PartyAudioConfig = serde_json::from_str(&json("null")).unwrap();
        assert_eq!(none.effective_language("auto"), "auto");
    }
}
