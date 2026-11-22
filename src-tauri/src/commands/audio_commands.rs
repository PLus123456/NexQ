use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{command, AppHandle, Emitter, Manager};
use tokio::sync::mpsc;

use crate::audio::capture_supervisor::{CaptureCounters, CaptureStatus, StatusSink};
use crate::audio::device_manager;
use crate::audio::recording_mixer::{wall_clock_ms, CaptureTimes, MixSide, RecordingMixer};
use crate::audio::session_monitor;
use crate::audio::vad::{calculate_peak, calculate_rms, VoiceActivityDetector};
use crate::audio::side_swap::{self, Side, SideSwapMsg, SwapSignal, Tagged};
use crate::audio::{AudioCaptureManager, AudioLevel, AudioSource};
use crate::stt::provider::STTProvider;
use crate::stt::segment_accumulator::AccumulatorOutput;
use crate::state::AppState;

/// The `segment` of a `transcript_update` / `transcript_final` payload for an
/// accumulator output, under `id` and labelled `speaker`. A diarized line
/// also carries `speaker_tag` ("S1") and, for in-person mode, the matching
/// `speaker_id` ("speaker_0").
/// Counts a party's STT results for the log (no text): the first one, and a
/// summary when the meeting's stream ends. "Audio flowing, no transcript"
/// shows up as a missing "first transcript" line.
struct TranscriptTally {
    party: &'static str,
    provider: String,
    results: u64,
    finals: u64,
}

impl TranscriptTally {
    fn new(party: &'static str, provider: &str) -> Self {
        Self { party, provider: provider.to_string(), results: 0, finals: 0 }
    }

    fn record(&mut self, is_final: bool) {
        self.results += 1;
        if is_final {
            self.finals += 1;
        }
        if self.results == 1 {
            log::info!("First '{}' transcript result from {}", self.party, self.provider);
        }
    }
}

impl Drop for TranscriptTally {
    fn drop(&mut self) {
        if self.results == 0 {
            log::warn!("'{}' STT ({}) ended without producing any transcript", self.party, self.provider);
        } else {
            log::info!(
                "'{}' STT ({}) ended: {} results, {} final",
                self.party, self.provider, self.results, self.finals
            );
        }
    }
}

fn accumulator_segment_json(id: &str, speaker: &str, output: &AccumulatorOutput) -> serde_json::Value {
    let mut seg = serde_json::json!({
        "id": id,
        "text": output.text,
        "speaker": speaker,
        "timestamp_ms": output.timestamp_ms,
        "is_final": output.is_final,
        "confidence": output.confidence
    });
    if let Some(ref tag) = output.speaker_tag {
        seg["speaker_tag"] = serde_json::json!(tag);
        if let Some(speaker_id) = crate::stt::provider::diarized_speaker_id(tag) {
            seg["speaker_id"] = serde_json::json!(speaker_id);
        }
    }
    with_turn(seg, output.turn)
}

/// A line straight from a provider that segments on its own (whisper.cpp,
/// Soniox), without the accumulator. A diarized line (Soniox) carries
/// `speaker_tag` and `speaker_id` like an accumulated one.
fn result_segment_json(id: &str, speaker: &str, result: &crate::stt::provider::TranscriptResult) -> serde_json::Value {
    let mut seg = serde_json::json!({
        "id": id,
        "text": result.text,
        "speaker": speaker,
        "timestamp_ms": result.timestamp_ms,
        "is_final": result.is_final,
        "confidence": result.confidence
    });
    if let Some(ref tag) = result.speaker_tag {
        seg["speaker_tag"] = serde_json::json!(tag);
        if let Some(speaker_id) = crate::stt::provider::diarized_speaker_id(tag) {
            seg["speaker_id"] = serde_json::json!(speaker_id);
        }
    }
    with_turn(seg, result.turn)
}

/// Adds the provider's turn signal ("eager_end", "resumed", "end"), if any.
fn with_turn(mut seg: serde_json::Value, turn: Option<crate::stt::provider::TurnSignal>) -> serde_json::Value {
    if let Some(turn) = turn {
        seg["turn"] = serde_json::json!(turn.as_str());
    }
    seg
}

// ── NexQ Plus: one transcript pipeline for both sides ───────────────

/// A side's label in the fork's own engines, their status events and the logs.
/// Always "You" or "Them": the room of an in-person meeting is "Them" here
/// (upstream's engines are told "Room", see `start_capture_per_party`).
fn side_label(side: Side) -> &'static str {
    match side {
        Side::You => "You",
        Side::Them => "Them",
    }
}

/// Speaker of a side's transcript lines.
fn side_speaker(side: Side) -> &'static str {
    match side {
        Side::You => "User",
        Side::Them => "Them",
    }
}

/// Start of a side's segment ids, e.g. "them_ab12_". `session_prefix` is the
/// capture's prefix, with the provider's generation once the side's provider
/// was swapped (`side_swap::generation_prefix`: "them_ab12s1_").
fn segment_prefix(side: Side, session_prefix: &str) -> String {
    match side {
        Side::You => format!("you_{}_", session_prefix),
        Side::Them => format!("them_{}_", session_prefix),
    }
}

/// Engines that cut their own lines, bypassing the SegmentAccumulator:
/// whisper.cpp's dual pass manages its line breaks, and Soniox emits one line
/// per endpoint so that each of its translations matches exactly one line.
fn self_segmenting(provider: &str) -> bool {
    matches!(provider, "whisper_cpp" | "soniox")
}

/// The id a line straight from an engine goes out under: the side's prefix,
/// then the engine's own segment id, else a line counter (`counter`: the finals
/// so far). A swapped provider's ids carry its generation, so they can't reuse
/// the old one's; Soniox is given the same prefix for its translations
/// (`create_stt_provider_for_party`, `swap_plan`).
fn direct_line_id(
    side: Side,
    session_prefix: &str,
    generation: u32,
    result: &crate::stt::provider::TranscriptResult,
    counter: &mut u64,
) -> String {
    let id_prefix = segment_prefix(side, &side_swap::generation_prefix(session_prefix, generation));
    match result.segment_id {
        Some(ref custom_id) => format!("{}{}", id_prefix, custom_id),
        None if result.is_final => {
            *counter += 1;
            format!("{}{}", id_prefix, counter)
        }
        None => format!("{}{}", id_prefix, *counter + 1),
    }
}

/// Tell the intelligence engine about a line from Them, interim or final: a
/// new line that reads as a question replaces the question detected before
/// (`IntelligenceEngine::note_them_line`). `line_id` is the id the line goes
/// out under. Called before the line's final is ingested.
fn note_them_line(app: &AppHandle, line_id: &str, text: &str, is_final: bool) {
    if let Some(intel) = app.state::<AppState>().intelligence.as_ref() {
        if let Ok(mut engine) = intel.lock() {
            engine.note_them_line(line_id, text, is_final);
        }
    }
}

/// A transcript line on its way out of `pump_party_lines`.
struct TranscriptLine {
    /// The id it goes out under ("them_ab12_acc_3", "them_ab12_sx1_7").
    id: String,
    /// The `segment` of its `transcript_update` / `transcript_final` event.
    segment: serde_json::Value,
    text: String,
    timestamp_ms: u64,
    is_final: bool,
}

/// Turn a side's STT results into transcript lines until the side's result
/// channel closes. Engines that cut their own lines go out as they come, under
/// the engine's segment ids; the others' results are merged into paragraphs by
/// the SegmentAccumulator (pause threshold read live). When the side's
/// provider is swapped for a language change (`audio::side_swap`), the line it
/// left open is ended first and the new provider starts lines of its own.
async fn pump_party_lines(
    side: Side,
    provider: &str,
    session_prefix: &str,
    rx: &mut mpsc::Receiver<Tagged>,
    signal: &SwapSignal,
    pause_threshold: &std::sync::atomic::AtomicU64,
    mut on_line: impl FnMut(TranscriptLine),
) {
    let speaker = side_speaker(side);
    let mut tally = TranscriptTally::new(side_label(side), provider);

    if !self_segmenting(provider) {
        // Accumulator path: merge same-speaker segments
        let id_prefix = segment_prefix(side, session_prefix);
        let line = |output: AccumulatorOutput| {
            let id = format!("{}{}", id_prefix, output.id);
            TranscriptLine {
                segment: accumulator_segment_json(&id, speaker, &output),
                id,
                is_final: output.is_final,
                timestamp_ms: output.timestamp_ms,
                text: output.text,
            }
        };
        let mut accumulator = crate::stt::segment_accumulator::SegmentAccumulator::new(
            pause_threshold.load(Ordering::Relaxed),
        );
        side_swap::pump_accumulated(
            rx,
            signal,
            &mut accumulator,
            pause_threshold,
            |result| tally.record(result.is_final),
            |output| on_line(line(output)),
        )
        .await;

        // Flush remaining accumulated segment on meeting end (a final)
        if let Some(output) = accumulator.flush() {
            on_line(line(output));
        }
    } else {
        // Direct path: the engine's own segment ids, else a line counter
        let mut counter = 0u64;
        side_swap::pump_direct(
            rx,
            signal,
            |result| tally.record(result.is_final),
            |generation, result| {
                let id = direct_line_id(side, session_prefix, generation, &result, &mut counter);
                on_line(TranscriptLine {
                    segment: result_segment_json(&id, speaker, &result),
                    id,
                    is_final: result.is_final,
                    timestamp_ms: result.timestamp_ms,
                    text: result.text,
                });
            },
        )
        .await;
    }
}

/// Forward a side's STT results as `transcript_update` / `transcript_final`
/// until the side's result channel closes (`pump_party_lines`).
///
/// Every line of Them is noted by the intelligence engine, then finals of both
/// sides go to it and to the question services (`intelligence::ingest_transcript`).
fn spawn_party_emitter(
    app: &AppHandle,
    side: Side,
    provider: &str,
    session_prefix: &str,
    mut rx: mpsc::Receiver<Tagged>,
    signal: Arc<SwapSignal>,
) -> tokio::task::JoinHandle<()> {
    let app = app.clone();
    let provider = provider.to_string();
    let session_prefix = session_prefix.to_string();
    let pause_threshold = app.state::<AppState>().pause_threshold_ms.clone();

    tokio::spawn(async move {
        pump_party_lines(side, &provider, &session_prefix, &mut rx, &signal, &pause_threshold, |line| {
            let event_name = if line.is_final { "transcript_final" } else { "transcript_update" };
            let _ = app.emit(event_name, &serde_json::json!({ "segment": line.segment }));
            // A new line from Them replaces the old detected question.
            if side == Side::Them {
                note_them_line(&app, &line.id, &line.text, line.is_final);
            }
            if line.is_final {
                crate::intelligence::ingest_transcript(
                    &app, line.text, side_speaker(side).to_string(), line.timestamp_ms, true,
                );
            }
        })
        .await;
    })
}

/// List all available audio input and output devices.
#[command]
pub async fn list_audio_devices() -> Result<String, String> {
    let device_list = device_manager::enumerate_devices()?;
    serde_json::to_string(&device_list).map_err(|e| format!("Failed to serialize devices: {}", e))
}

/// Start dual audio capture (mic + system).
#[command]
pub async fn start_capture(
    app: AppHandle,
    mic_device_id: String,
    system_device_id: String,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut tasks = state.audio_tasks.lock().await;

    // The legacy single-provider route also uses browser Web Speech for the
    // microphone and may use providers/models that cannot honor `auto`.
    // Require per-party configuration before changing capture state.
    let auto_language_selected = state.stt.as_ref().is_some_and(|stt| {
        stt.lock()
            .map(|router| router.language.eq_ignore_ascii_case("auto"))
            .unwrap_or(false)
    });
    if auto_language_selected {
        return Err(
            "Auto-detect needs You and Them to be set up separately. Open Audio & Devices, choose a speech-to-text provider for each side, then start again.".to_string(),
        );
    }

    // Check if already capturing
    {
        let guard = state
            .audio
            .lock()
            .map_err(|_| "Audio state lock poisoned".to_string())?;
        if let Some(ref mgr) = *guard {
            if mgr.is_capturing() {
                return Err("Capture already in progress".to_string());
            }
        }
    }

    // Create the audio chunk channel
    let (tx, mut rx) = mpsc::channel::<crate::audio::AudioChunk>(256);

    // Initialize and start the manager
    {
        let mut guard = state
            .audio
            .lock()
            .map_err(|_| "Audio state lock poisoned".to_string())?;
        let mgr = guard.get_or_insert_with(AudioCaptureManager::new);
        mgr.start_capture(&mic_device_id, &system_device_id, false, tx, capture_status_sink(&app))?;
        for warning in mgr.take_warnings() {
            let _ = app.emit("capture_warning", warning);
        }
    }

    // ---- System Audio STT (for remote party in calls) ----
    // Mic transcription is handled by Web Speech API in the frontend.
    // System audio (WASAPI loopback = other party in Zoom/Meet) needs a
    // cloud STT provider (Deepgram/Whisper/Azure/Groq) configured in Settings.
    // If no cloud provider is configured, system audio won't be transcribed.
    let system_stt: Option<Box<dyn STTProvider>> = {
        let stt_config = state.stt.as_ref().and_then(|stt_arc| {
            let router = stt_arc.lock().ok()?;
            let provider_type = router.active_provider_type()?.clone();
            use crate::stt::provider::STTProviderType;
            if provider_type == STTProviderType::WindowsNative {
                return None; // WindowsNative can't transcribe system audio
            }
            Some((
                provider_type,
                router.deepgram_api_key.clone(),
                router.deepgram_config.clone(),
                router.whisper_api_key.clone(),
                router.azure_speech_key.clone(),
                router.azure_speech_region.clone(),
                router.groq_whisper_api_key.clone(),
                router.cartesia_api_key.clone(),
                router.language.clone(),
            ))
        });

        match stt_config {
            Some((pt, dk, dg_cfg, wk, ak, ar, gk, ck, lang)) => {
                use crate::stt::provider::STTProviderType;
                let p: Box<dyn STTProvider> = match pt {
                    STTProviderType::Deepgram => {
                        let mut p = match dk.as_deref() {
                            Some(k) => crate::stt::deepgram::DeepgramSTT::with_api_key(k),
                            None => crate::stt::deepgram::DeepgramSTT::new(),
                        };
                        p.set_language(&lang);
                        p.set_config(dg_cfg);
                        Box::new(p)
                    }
                    STTProviderType::WhisperApi => {
                        let mut p = match wk.as_deref() {
                            Some(k) => crate::stt::whisper_api::WhisperApiSTT::with_api_key(k),
                            None => crate::stt::whisper_api::WhisperApiSTT::new(),
                        };
                        p.set_language(&lang);
                        Box::new(p)
                    }
                    STTProviderType::AzureSpeech => {
                        let mut p = match (ak.as_deref(), ar.as_deref()) {
                            (Some(k), Some(r)) => crate::stt::azure_speech::AzureSpeechSTT::with_config(k, r),
                            _ => crate::stt::azure_speech::AzureSpeechSTT::new(),
                        };
                        p.set_language(&lang);
                        Box::new(p)
                    }
                    STTProviderType::GroqWhisper => {
                        let mut p = match gk.as_deref() {
                            Some(k) => crate::stt::groq_whisper::GroqWhisperSTT::with_api_key(k),
                            None => crate::stt::groq_whisper::GroqWhisperSTT::new(),
                        };
                        p.set_language(&lang);
                        Box::new(p)
                    }
                    STTProviderType::Cartesia => {
                        let mut p = match ck.as_deref() {
                            Some(k) => crate::stt::cartesia::CartesiaSTT::with_api_key(k),
                            None => crate::stt::cartesia::CartesiaSTT::new(),
                        };
                        p.set_language(&lang);
                        p.set_app_handle(app.clone());
                        Box::new(p)
                    }
                    _ => return Ok(()), // shouldn't reach
                };
                Some(p)
            }
            None => {
                log::info!(
                    "No cloud STT configured — system audio (remote party) won't be transcribed. \
                     Set up Deepgram/Whisper/Azure/Groq in Settings → STT."
                );
                None
            }
        }
    };

    // Start system STT if available
    let (sys_stt_tx, mut sys_stt_rx) =
        mpsc::channel::<crate::stt::provider::TranscriptResult>(256);
    let mut system_stt_provider = system_stt;
    let has_system_stt = if let Some(ref mut provider) = system_stt_provider {
        match provider.start_stream(sys_stt_tx).await {
            Ok(()) => {
                log::info!("System audio STT started (remote party transcription)");
                true
            }
            Err(e) => {
                log::warn!("Failed to start system STT: {}", e);
                system_stt_provider = None;
                false
            }
        }
    } else {
        false
    };

    // Emit transcript events from system audio STT (speaker = "Them")
    // Uses the SegmentAccumulator to merge consecutive segments within a
    // configurable pause threshold, producing longer, more readable lines.
    if has_system_stt {
        let stt_app = app.clone();
        let pause_threshold = app.state::<AppState>().pause_threshold_ms.clone();
        tasks.push(tokio::spawn(async move {
            use std::sync::atomic::Ordering;
            let threshold = pause_threshold.load(Ordering::Relaxed);
            let mut accumulator =
                crate::stt::segment_accumulator::SegmentAccumulator::new(threshold);

            while let Some(result) = sys_stt_rx.recv().await {
                // Check for runtime threshold changes
                let current_threshold = pause_threshold.load(Ordering::Relaxed);
                accumulator.set_pause_threshold(current_threshold);

                let outputs = accumulator.feed_result(result);
                for output in outputs {
                    let event_name = if output.is_final {
                        "transcript_final"
                    } else {
                        "transcript_update"
                    };
                    let payload = serde_json::json!({
                        "segment": accumulator_segment_json(&output.id, &output.speaker, &output)
                    });
                    let _ = stt_app.emit(event_name, &payload);

                    // A new line from Them replaces the old detected question.
                    note_them_line(&stt_app, &output.id, &output.text, output.is_final);

                    // Push final segments to the intelligence engine's
                    // transcript buffer so the AI has access to what "Them" said
                    // (and to the question services).
                    if output.is_final {
                        crate::intelligence::ingest_transcript(
                            &stt_app, output.text.clone(), "Them".to_string(), output.timestamp_ms, true,
                        );
                    }
                }
            }
        }));
    }

    // Grab the recorder handle for WAV recording (with mic/system mixing)
    let recorder = {
        let guard = state.audio.lock().map_err(|_| "lock poisoned".to_string())?;
        guard.as_ref().and_then(|mgr| mgr.get_recorder())
    };

    // Audio processing task: levels + recording + system STT feed
    // (Mic STT is handled by Web Speech API in the frontend)
    let app_handle = app.clone();
    tasks.push(tokio::spawn(async move {
        let mut vad = VoiceActivityDetector::new();
        let mut mic_emit_counter: u32 = 0;
        let mut system_emit_counter: u32 = 0;
        // Mixer for proper two-source recording: places mic and system on the
        // wall clock so a stalled side cannot shift the other.
        let mut recording_mixer = RecordingMixer::new();
        // While no audio arrives, time still passes: the mixer pads a side that
        // went quiet as it happens, not all at once when it comes back.
        let mut mixer_tick = tokio::time::interval(MIXER_TICK_INTERVAL);
        mixer_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        loop {
            // Audio first: the tick only runs once the queue is empty, so a
            // backlog is never mistaken for silence.
            let mut chunk = tokio::select! {
                biased;
                received = rx.recv() => match received {
                    Some(chunk) => chunk,
                    None => break,
                },
                _ = mixer_tick.tick() => {
                    if let Some(ref rec) = recorder {
                        recording_mixer.tick(wall_clock_ms(), &mut |b| rec.write_samples(b));
                    }
                    continue;
                }
            };
            let vad_result = vad.process_chunk(&chunk.pcm_data);
            chunk.is_speech = vad_result.is_speech;

            // Emit audio levels — separate counters per source for independent update rates
            let should_emit = match chunk.source {
                AudioSource::Mic | AudioSource::Room => {
                    mic_emit_counter += 1;
                    mic_emit_counter % 3 == 0
                }
                AudioSource::System => {
                    system_emit_counter += 1;
                    system_emit_counter % 3 == 0
                }
            };
            if should_emit {
                let rms = calculate_rms(&chunk.pcm_data);
                let peak = calculate_peak(&chunk.pcm_data);
                let level = AudioLevel {
                    source: chunk.source.clone(),
                    level: (rms / 3000.0).min(1.0),
                    peak,
                };
                let _ = app_handle.emit("audio_level", &level);
            }

            // Recording with mic/system mixing
            if let Some(ref rec) = recorder {
                // Placed by when it was captured, not when it was dequeued.
                let sink = &mut |b: &[i16]| rec.write_samples(b);
                match chunk.source {
                    AudioSource::Mic => recording_mixer.push(
                        MixSide::Mic,
                        &chunk.pcm_data,
                        chunk.timestamp_ms,
                        sink,
                    ),
                    AudioSource::System => recording_mixer.push(
                        MixSide::System,
                        &chunk.pcm_data,
                        chunk.timestamp_ms,
                        sink,
                    ),
                    AudioSource::Room => rec.write_samples(&chunk.pcm_data),
                }
            }

            // Feed ONLY system audio to the cloud STT provider
            if chunk.source == AudioSource::System {
                if let Some(ref mut provider) = system_stt_provider {
                    let _ = provider.feed_audio(chunk).await;
                }
            }
        }

        // Flush remaining mix buffers on loop exit
        if let Some(ref rec) = recorder {
            recording_mixer.finish(&mut |b| rec.write_samples(b));
        }

        // Clean shutdown
        if let Some(ref mut provider) = system_stt_provider {
            let _ = provider.stop_stream().await;
        }
        log::info!("Audio processing task exiting");
    }));

    log::info!("Audio capture started via command");
    Ok(())
}

/// Wait for producers and transcript forwarders together under one deadline.
/// The native audio mutex is never held here. Aborting and joining on timeout
/// prevents late events from an old meeting leaking into the next one.
async fn finish_capture_tasks(tasks: &mut Vec<tokio::task::JoinHandle<()>>, budget: std::time::Duration) -> bool {
    let deadline = tokio::time::Instant::now() + budget;
    let mut complete = true;
    while let Some(mut task) = tasks.pop() {
        if tokio::time::timeout_at(deadline, &mut task).await.is_err() {
            complete = false;
            task.abort();
            let _ = task.await;
        }
    }
    complete
}

fn capture_meeting_matches(state: &AppState, expected: Option<&str>) -> Result<bool, String> {
    let Some(expected) = expected else { return Ok(true) };
    let meeting = state.live_meeting.lock().map_err(|_| "Live meeting lock poisoned".to_string())?;
    Ok(meeting.as_ref().is_some_and(|meeting| meeting.id == expected))
}

/// Stop all audio capture. `keep_recording` (a device change mid-meeting)
/// keeps the meeting's recording open for the capture that follows.
/// `expected_meeting_id`: stop only while that meeting is still the live one.
#[command]
pub async fn stop_capture(app: AppHandle, keep_recording: Option<bool>, expected_meeting_id: Option<String>) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut tasks = state.audio_tasks.lock().await;
    // An old hot-swap must never stop a newer meeting's capture.
    if !capture_meeting_matches(&state, expected_meeting_id.as_deref())? { return Ok(()); }
    let keep_recording = keep_recording.unwrap_or(false);

    // Restore original default capture device if IPolicyConfig override was active
    restore_default_device_if_overridden(&state, &app);

    {
        let mut guard = state
            .audio
            .lock()
            .map_err(|_| "Audio state lock poisoned".to_string())?;

        match guard.as_mut() {
            Some(mgr) => {
                // The recorder stays open for now: the tasks drained below still
                // write the last audio into it.
                mgr.stop_capture(true);
                log::info!("Audio capture stopped via command; draining final results");
                // `keep_recording` means the meeting goes on (a device change), so the
                // sides running without speech-to-text stay remembered; a real stop forgets them.
                if !keep_recording {
                    if let Ok(mut refusals) = state.auto_refusals.lock() {
                        *refusals = [None, None];
                    }
                }
            }
            None => return Err("No audio manager initialized".to_string()),
        }
    };
    // No side is left to restart for a language change.
    set_running_capture(None);

    // Every side's thread has stopped: the windows drop what they showed about reconnecting.
    let _ = app.emit("audio_capture_stopped", ());

    if !finish_capture_tasks(&mut tasks, std::time::Duration::from_secs(10)).await {
        crate::stt::emit_stt_debug(&app, "warn", "audio", "Timed out draining audio/STT; unfinished tasks were stopped");
    }
    let recording_info = state.audio.lock()
        .map_err(|_| "Audio state lock poisoned".to_string())?
        .as_mut().and_then(|mgr| mgr.stop_capture(keep_recording));

    // Store recording info for end_meeting to pick up.
    // The frontend calls stopCapture() then endMeeting() in sequence, so
    // we park the info here and end_meeting consumes it.
    if let Some((wav_path, start_time_ms)) = recording_info {
        let mut pending = state
            .pending_recording
            .lock()
            .map_err(|_| "Pending recording lock poisoned".to_string())?;
        *pending = Some(crate::state::PendingRecording {
            wav_path,
            start_time_ms,
        });
        log::info!("Recording info stored for post-meeting pipeline");
    }

    Ok(())
}

/// Get current audio levels for UI meters.
#[command]
pub async fn get_audio_level(app: AppHandle) -> Result<String, String> {
    let state = app.state::<AppState>();
    let guard = state
        .audio
        .lock()
        .map_err(|_| "Audio state lock poisoned".to_string())?;

    match guard.as_ref() {
        Some(mgr) => {
            let (mic_level, _system_level) = mgr.get_audio_levels();
            serde_json::to_string(&mic_level)
                .map_err(|e| format!("Failed to serialize audio level: {}", e))
        }
        None => Ok(r#"{"source":"Mic","level":0.0,"peak":0.0}"#.to_string()),
    }
}

/// Start a real audio test on a device — opens a capture stream and emits
/// audio_level events so the frontend level meter shows live data.
/// For input (mic): opens cpal input stream.
/// For output (system): starts WASAPI loopback capture.
#[command]
pub async fn start_audio_test(
    app: AppHandle,
    device_id: String,
    is_input: bool,
) -> Result<(), String> {
    let state = app.state::<AppState>();

    // Start test capture and get the audio chunk receiver
    let (mut rx, detected_flag) = {
        let mut guard = state
            .audio
            .lock()
            .map_err(|_| "Audio state lock poisoned".to_string())?;
        let mgr = guard.get_or_insert_with(AudioCaptureManager::new);
        let rx = mgr.start_test(&device_id, is_input)?;
        let detected = Arc::clone(&mgr.test_audio_detected);
        (rx, detected)
    };

    // Spawn a tokio task that reads audio chunks from the test stream
    // and emits audio_level events to the frontend for the level meter.
    let app_clone = app.clone();
    tokio::spawn(async move {
        while let Some(chunk) = rx.recv().await {
            let rms = calculate_rms(&chunk.pcm_data);
            let peak = calculate_peak(&chunk.pcm_data);

            // Mark audio as detected if we get any meaningful signal
            if rms > 100.0 {
                detected_flag.store(true, Ordering::SeqCst);
            }

            let level = AudioLevel {
                source: if is_input {
                    AudioSource::Mic
                } else {
                    AudioSource::System
                },
                level: (rms / 3000.0).min(1.0),
                peak,
            };
            let _ = app_clone.emit("audio_level", &level);
        }
        log::info!("Audio test processing task exiting");
    });

    Ok(())
}

/// Stop an active audio test and return whether audio was detected.
#[command]
pub async fn stop_audio_test(app: AppHandle) -> Result<bool, String> {
    let state = app.state::<AppState>();
    let mut guard = state
        .audio
        .lock()
        .map_err(|_| "Audio state lock poisoned".to_string())?;

    match guard.as_mut() {
        Some(mgr) => Ok(mgr.stop_test()),
        None => Ok(false),
    }
}

/// Test whether a specific audio device can be opened (legacy quick check).
#[command]
pub async fn test_audio_device(device_id: String) -> Result<bool, String> {
    device_manager::test_device(&device_id)
}

/// Enable or disable audio recording to file.
#[command]
pub async fn set_recording_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut guard = state
        .audio
        .lock()
        .map_err(|_| "Audio state lock poisoned".to_string())?;

    match guard.as_mut() {
        Some(mgr) => {
            mgr.set_recording_enabled(enabled);
            Ok(())
        }
        None => {
            log::info!(
                "Recording {} (will take effect when capture starts)",
                if enabled { "enabled" } else { "disabled" }
            );
            Ok(())
        }
    }
}

/// Peak level entry returned by get_audio_peak_levels.
#[derive(serde::Serialize, Clone)]
pub struct DevicePeakLevel {
    pub device_id: String,
    pub level: f32,
}

/// Return the current peak audio level (0.0–1.0) for every active audio
/// endpoint simultaneously, without opening any capture streams.
///
/// Uses Win32 IAudioMeterInformation — the same mechanism Windows uses in
/// Sound Control Panel. Works for both input (mic) and output (speaker/loopback)
/// devices. All devices are read in one synchronous pass (~1–3 ms).
#[command]
pub async fn get_audio_peak_levels() -> Result<Vec<DevicePeakLevel>, String> {
    #[cfg(target_os = "windows")]
    {
        tokio::task::spawn_blocking(get_all_peak_levels_win)
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(vec![])
    }
}

#[cfg(target_os = "windows")]
fn get_all_peak_levels_win() -> Result<Vec<DevicePeakLevel>, String> {
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
    unsafe {
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        // S_FALSE (0x1) means already initialized on this thread — that's fine
        if hr.is_err() && hr.0 != 1 {
            return Err(format!("COM init failed: {:?}", hr));
        }
        let results = read_all_peaks_raw();
        CoUninitialize();
        Ok(results)
    }
}

/// Read peak levels for all active audio endpoints.
/// Caller must have already called CoInitializeEx on this thread.
#[cfg(target_os = "windows")]
fn read_all_peaks_raw() -> Vec<DevicePeakLevel> {
    use windows::Win32::Media::Audio::{
        Endpoints::IAudioMeterInformation,
        IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            match CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) {
                Ok(e) => e,
                Err(_) => return vec![],
            };
        // EDataFlow::eAll = 2 — enumerate both render and capture endpoints
        let e_all = windows::Win32::Media::Audio::EDataFlow(2);
        let collection = match enumerator.EnumAudioEndpoints(e_all, DEVICE_STATE_ACTIVE) {
            Ok(c) => c,
            Err(_) => return vec![],
        };
        let count = collection.GetCount().unwrap_or(0);
        let mut results = Vec::with_capacity(count as usize);
        for i in 0..count {
            let device = match collection.Item(i) {
                Ok(d) => d,
                Err(_) => continue,
            };
            // Use the friendly name as device_id so it matches cpal's name-based IDs
            // used by the frontend device list (device_manager::enumerate_devices).
            let name = match get_device_friendly_name(&device) {
                Some(n) => n,
                None => continue,
            };
            let meter: IAudioMeterInformation = match device.Activate(CLSCTX_ALL, None) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let peak = meter.GetPeakValue().unwrap_or(0.0);
            results.push(DevicePeakLevel { device_id: name, level: peak });
        }
        results
    }
}

/// Extract the friendly name from a Windows audio endpoint device,
/// matching the format that cpal uses for device names.
#[cfg(target_os = "windows")]
fn get_device_friendly_name(device: &windows::Win32::Media::Audio::IMMDevice) -> Option<String> {
    use windows::Win32::Foundation::PROPERTYKEY;
    use windows::core::GUID;
    unsafe {
        // PKEY_Device_FriendlyName = {a45c254e-df1c-4efd-8020-67d146a850e0}, 14
        let pkey = PROPERTYKEY {
            fmtid: GUID::from_values(
                0xa45c254e,
                0xdf1c,
                0x4efd,
                [0x80, 0x20, 0x67, 0xd1, 0x46, 0xa8, 0x50, 0xe0],
            ),
            pid: 14,
        };
        let store = device.OpenPropertyStore(windows::Win32::System::Com::STGM(0)).ok()?;
        let prop = store.GetValue(&pkey).ok()?;
        let s = format!("{}", prop);
        if s.is_empty() || s == "VT_EMPTY" {
            return None;
        }
        Some(s)
    }
}

/// Holds a WASAPI capture client opened on an input endpoint.
/// Keeping this alive activates the audio engine's peak metering for the device.
/// Without an active capture client, IAudioMeterInformation returns 0 for input devices.
#[cfg(target_os = "windows")]
struct InputPeakActivator {
    client: windows::Win32::Media::Audio::IAudioClient,
    capture: windows::Win32::Media::Audio::IAudioCaptureClient,
}

#[cfg(target_os = "windows")]
impl InputPeakActivator {
    /// Drain any accumulated capture buffers so they don't overflow.
    unsafe fn drain(&self) {
        loop {
            let size = self.capture.GetNextPacketSize().unwrap_or(0);
            if size == 0 {
                break;
            }
            let mut buf = std::ptr::null_mut();
            let mut frames = 0u32;
            let mut flags = 0u32;
            if self.capture
                .GetBuffer(&mut buf, &mut frames, &mut flags, None, None)
                .is_ok()
            {
                let _ = self.capture.ReleaseBuffer(frames);
            } else {
                break;
            }
        }
    }
}

/// Open shared-mode WASAPI capture streams on all active input endpoints.
/// This activates the audio engine's peak metering for capture devices.
#[cfg(target_os = "windows")]
fn activate_input_peak_meters() -> Vec<InputPeakActivator> {
    use windows::Win32::Media::Audio::*;
    use windows::Win32::System::Com::*;

    let mut activators = Vec::new();
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            match CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) {
                Ok(e) => e,
                Err(_) => return vec![],
            };

        // eCapture = 1 — only input endpoints
        let collection = match enumerator.EnumAudioEndpoints(EDataFlow(1), DEVICE_STATE_ACTIVE) {
            Ok(c) => c,
            Err(_) => return vec![],
        };

        let count = collection.GetCount().unwrap_or(0);
        for i in 0..count {
            let device = match collection.Item(i) {
                Ok(d) => d,
                Err(_) => continue,
            };
            let client: IAudioClient = match device.Activate(CLSCTX_ALL, None) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let format_ptr = match client.GetMixFormat() {
                Ok(f) => f,
                Err(_) => continue,
            };

            // Initialize shared-mode with 200ms buffer
            let init_ok = client
                .Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    0,
                    2_000_000, // 200ms in 100-nanosecond units
                    0,
                    format_ptr,
                    None,
                )
                .is_ok();
            CoTaskMemFree(Some(format_ptr as *const _));
            if !init_ok {
                continue;
            }

            let capture: IAudioCaptureClient = match client.GetService() {
                Ok(c) => c,
                Err(_) => continue,
            };
            if client.Start().is_err() {
                continue;
            }
            activators.push(InputPeakActivator { client, capture });
        }
    }
    log::info!(
        "Device monitor: activated peak metering on {} input endpoints",
        activators.len()
    );
    activators
}

/// Dedicated monitor thread: initializes COM once, reads all peak levels at ~60 fps,
/// and emits a `device_levels` Tauri event after each read.
/// Opens capture streams on input devices to activate their peak meters.
/// Exits when `stop` flips to false.
#[cfg(target_os = "windows")]
fn run_device_monitor_loop(app: tauri::AppHandle, stop: Arc<AtomicBool>) {
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
    unsafe {
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        if hr.is_err() && hr.0 != 1 {
            return;
        }

        // Open capture streams on input devices to enable peak metering
        let input_activators = activate_input_peak_meters();

        while stop.load(Ordering::SeqCst) {
            // Drain capture buffers to prevent overflow
            for a in &input_activators {
                a.drain();
            }

            let levels = read_all_peaks_raw();
            if !levels.is_empty() {
                let _ = app.emit("device_levels", &levels);
            }
            std::thread::sleep(std::time::Duration::from_millis(16));
        }

        // Clean up capture streams
        for a in &input_activators {
            let _ = a.client.Stop();
        }

        CoUninitialize();
    }
}

/// Start the Live Monitor background thread.
/// Idempotent — stops any running monitor first, waits for it to exit, then starts fresh.
#[command]
pub async fn start_device_monitor(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let state = app.state::<crate::state::AppState>();

        // Signal any existing thread to stop
        state.device_monitor_running.store(false, Ordering::SeqCst);
        // Wait long enough for the old thread to see the flag (loop sleeps 16ms)
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;

        // Start fresh
        state.device_monitor_running.store(true, Ordering::SeqCst);
        let stop_flag = Arc::clone(&state.device_monitor_running);
        let app_clone = app.clone();
        std::thread::spawn(move || {
            run_device_monitor_loop(app_clone, stop_flag);
            // Don't reset the flag here — only start/stop commands manage it.
            // This prevents a race where an exiting thread resets the flag
            // after a new thread has already been started.
        });
    }
    Ok(())
}

/// Stop the Live Monitor background thread.
#[command]
pub async fn stop_device_monitor(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let state = app.state::<crate::state::AppState>();
        state.device_monitor_running.store(false, Ordering::SeqCst);
    }
    Ok(())
}

/// Enumerate active audio sessions (per-app audio awareness).
/// Returns JSON array of AudioSessionInfo.
#[command]
pub async fn get_audio_sessions() -> Result<String, String> {
    let sessions = session_monitor::enumerate_audio_sessions()?;
    serde_json::to_string(&sessions)
        .map_err(|e| format!("Failed to serialize audio sessions: {}", e))
}

/// Whether a party's STT needs the OS default mic switched to its device (IPolicyConfig).
/// Web Speech and Windows Speech only hear the default recording device; every
/// other provider reads NexQ's own capture of the chosen device. A party whose
/// STT is skipped needs no switch.
fn needs_default_mic_override(config: &crate::audio::PartyAudioConfig, stt_skipped: bool) -> bool {
    let provider = config.stt_provider.as_str();
    !stt_skipped
        && (provider == "web_speech" || provider == "windows_native")
        && config.is_input_device
        && config.device_id != "default"
}

/// How often the audio loop re-checks the mute flags when no audio arrives (200 ms).
const MUTE_CHECK_INTERVAL: std::time::Duration = std::time::Duration::from_millis(200);
/// How often the recording mixer is ticked while no audio arrives.
const MIXER_TICK_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);

/// Where a capture side's reconnect statuses go: the log, the debug panel and
/// the `audio_capture_status` event (the toast decides what to show).
fn capture_status_sink(app: &AppHandle) -> StatusSink {
    let app = app.clone();
    Arc::new(move |status: CaptureStatus| {
        let line = format!(
            "{:?} capture {:?} on '{}'{}",
            status.side,
            status.state,
            status.device,
            if status.message.is_empty() { String::new() } else { format!(": {}", status.message) }
        );
        let level = match status.state {
            crate::audio::capture_supervisor::CaptureState::Lost => "warn",
            _ => "info",
        };
        crate::stt::emit_stt_debug(&app, level, "audio", &line);
        let _ = app.emit("audio_capture_status", &status);
    })
}

/// The stats line's xrun and rebuild counts for one side.
fn capture_counts(counters: &CaptureCounters) -> String {
    format!(", xruns: {}, rebuilds: {}", counters.xruns(), counters.rebuilds())
}

/// Pass a party's mute flag on to its provider when it changed.
fn sync_mute(provider: &mut Option<Box<dyn STTProvider>>, applied: &mut bool, flag: &AtomicBool) {
    if crate::stt::provider::mute_changed(applied, flag.load(Ordering::Relaxed)) {
        if let Some(p) = provider.as_mut() {
            p.set_muted(*applied);
        }
    }
}

/// Start per-party audio capture with independent STT pipelines.
///
/// Each party (You / Them) independently selects:
///   - An audio device (mic or output/loopback)
///   - An STT provider (web_speech, windows_native, deepgram, etc.)
///
/// If STT = "web_speech", Rust skips STT for that party (frontend handles it).
/// `skip_you_stt` (in-person meetings, where the room mic is "Them") starts no
/// "You" provider at all, so a cloud provider isn't billed for a muted mic.
/// Audio is still captured for levels, recording, and (optionally) the other party's STT.
/// `expected_meeting_id`: (re)start only while that meeting is still the live one.
#[command]
pub async fn start_capture_per_party(
    app: AppHandle,
    you_config: String,
    them_config: String,
    expected_meeting_id: Option<String>,
    skip_you_stt: Option<bool>,
) -> Result<(), String> {
    use crate::audio::PartyAudioConfig;

    let you: PartyAudioConfig =
        serde_json::from_str(&you_config).map_err(|e| format!("Invalid you_config: {}", e))?;
    let them: PartyAudioConfig =
        serde_json::from_str(&them_config).map_err(|e| format!("Invalid them_config: {}", e))?;
    let skip_you_stt = skip_you_stt.unwrap_or(false);

    let state = app.state::<AppState>();
    let mut tasks = state.audio_tasks.lock().await;
    if !capture_meeting_matches(&state, expected_meeting_id.as_deref())? {
        return Err("The meeting ended before capture could restart".to_string());
    }

    // Unique session prefix to avoid segment ID collisions across mid-meeting restarts.
    // Each restart of start_capture_per_party gets a distinct prefix, so segment IDs
    // like "you_a3_1" won't collide with "you_b7_1" from a previous session.
    // Computed before the providers exist: Soniox tags its translations with
    // the full id of the line they belong to.
    let session_prefix = format!("{:x}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() % 0xFFFF);

    // Validate provider/model combinations before stopping an existing meeting,
    // switching the default microphone, or starting new audio capture.
    //
    // A side that can't detect the language goes without STT instead of
    // blocking a meeting that is just starting, and the user is told once
    // capture is up. While a capture runs (a swap), a refusal the side already
    // runs under is tolerated silently; a new one is returned as an error and
    // the running capture is left alone (see `resolve_sides`).
    let was_capturing = state
        .audio
        .lock()
        .map(|guard| guard.as_ref().is_some_and(|mgr| mgr.is_capturing()))
        .unwrap_or(false);
    let you_result = if skip_you_stt {
        crate::stt::emit_stt_debug(&app, "info", "stt", "'You' STT skipped (in-person meeting)");
        Ok(None)
    } else {
        create_stt_provider_for_party(&you, &them, &state, &app, Side::You, "You", &session_prefix).await
    };
    let them_role = if skip_you_stt { "Room" } else { "Them" };
    let them_result =
        create_stt_provider_for_party(&them, &you, &state, &app, Side::Them, them_role, &session_prefix).await;
    let running_refusals = state
        .auto_refusals
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default();
    // Web Speech runs in the frontend, which stops it by itself when its language becomes Auto-detect.
    let frontend_stt = [
        !skip_you_stt && uses_frontend_stt(&you),
        uses_frontend_stt(&them),
    ];
    let (you_side, them_side) =
        resolve_sides(you_result, them_result, was_capturing, &running_refusals, frontend_stt)?;
    let you_refused = you_side.refusal.is_some();
    let them_refused = them_side.refusal.is_some();
    let sides_refusals = [you_side.refusal.clone(), them_side.refusal.clone()];
    let refusals = start_warnings(&[
        ("You", you_side.announce.then(|| you_side.refusal.clone()).flatten()),
        (them_role, them_side.announce.then(|| them_side.refusal.clone()).flatten()),
    ]);
    let you_stt = you_side.provider;
    let them_stt = them_side.provider;

    // If already capturing, stop first (allows mid-meeting hot-swap).
    let mut stopped_existing_capture = false;
    {
        // Restore any previous IPolicyConfig override before hot-swap
        restore_default_device_if_overridden(&state, &app);

        let mut guard = state
            .audio
            .lock()
            .map_err(|_| "Audio state lock poisoned".to_string())?;
        if let Some(ref mut mgr) = *guard {
            if mgr.is_capturing() {
                stopped_existing_capture = true;
                log::info!("start_capture_per_party: stopping existing capture for hot-swap");
                crate::stt::emit_stt_debug(&app, "info", "stt",
                    "Hot-swap: stopping existing audio capture + STT providers");
                mgr.stop_capture(true);
            }
        }
    }
    if stopped_existing_capture {
        // The old sides can't be restarted for a language change any more.
        set_running_capture(None);
        // The old sides have stopped; the new capture starts with a clean slate.
        let _ = app.emit("audio_capture_stopped", ());
        // Give WASAPI time to release the previous stream before reopening the devices.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }

    // The old capture's tasks send their last results and stop their providers
    // before the new one starts (they share the meeting's transcript and recording).
    if !finish_capture_tasks(&mut tasks, std::time::Duration::from_secs(10)).await {
        crate::stt::emit_stt_debug(&app, "warn", "audio", "Timed out draining the previous audio/STT session");
    }

    log::info!(
        "Starting per-party capture: You={{device='{}', input={}, stt={}, skipped={}}}, Them={{device='{}', input={}, stt={}}}",
        you.device_id,
        you.is_input_device,
        you.stt_provider,
        skip_you_stt,
        them.device_id,
        them.is_input_device,
        them.stt_provider
    );

    // Create the audio chunk channel
    let (tx, mut rx) = mpsc::channel::<crate::audio::AudioChunk>(256);

    // Use the existing AudioCaptureManager for the physical capture
    // Map "You" → mic device, "Them" → system device (backward compat with existing manager)
    let mic_device = if you.is_input_device {
        you.device_id.clone()
    } else {
        "default".to_string()
    };
    // Always use the user's selected device for "Them" — the AudioCaptureManager
    // will choose the right capture method (loopback vs input) based on system_is_input.
    let system_device = them.device_id.clone();
    let system_is_input = them.is_input_device;

    // ── IPolicyConfig: override system default mic BEFORE starting capture ──
    // Web Speech and Windows Speech always use the OS default recording device.
    // The override must happen before capture starts so that Web Speech API
    // picks up the correct device when recognition.start() is called.
    {
        let you_needs_override = needs_default_mic_override(&you, skip_you_stt || you_refused);
        let them_needs_override = needs_default_mic_override(&them, them_refused);
        log::info!(
            "IPolicyConfig check: You needs_override={} (provider='{}', stt_skipped={}), Them needs_override={} (provider='{}')",
            you_needs_override, you.stt_provider, skip_you_stt, them_needs_override, them.stt_provider
        );

        if you_needs_override || them_needs_override {
            // Pick the device that needs the override (prefer "You" if both need it)
            let target_device = if you_needs_override {
                &you.device_id
            } else {
                &them.device_id
            };

            crate::stt::emit_stt_debug(&app, "info", "audio",
                &format!("IPolicyConfig: overriding default capture → '{}'", target_device));

            match crate::audio::device_default::override_default_capture_device(target_device) {
                Ok(Some(original)) => {
                    // Store original so we can restore it on stop
                    if let Ok(mut guard) = state.original_default_device.lock() {
                        *guard = Some(original.clone());
                    }
                    // Also store the resolved target endpoint for ensure_ipolicy_override
                    match crate::audio::device_default::find_capture_endpoint_id_by_name(target_device) {
                        Ok(target_ep) => {
                            if let Ok(mut guard) = state.ipolicy_target_endpoint.lock() {
                                *guard = Some(target_ep.clone());
                            }
                            crate::stt::emit_stt_debug(&app, "info", "ipolicy",
                                &format!("IPolicyConfig: stored target endpoint '{}'", target_ep));
                        }
                        Err(e) => {
                            crate::stt::emit_stt_debug(&app, "warn", "ipolicy",
                                &format!("IPolicyConfig: could not resolve target endpoint: {}", e));
                        }
                    }
                    crate::stt::emit_stt_debug(&app, "info", "audio",
                        &format!("IPolicyConfig: saved original default '{}', override active", original));

                    // Verify the override took effect by reading back the current default
                    match crate::audio::device_default::get_default_capture_endpoint_id() {
                        Ok(current) => {
                            crate::stt::emit_stt_debug(&app, "info", "ipolicy",
                                &format!("Current default after override: '{}'", current));
                        }
                        Err(e) => {
                            crate::stt::emit_stt_debug(&app, "warn", "ipolicy",
                                &format!("Could not verify override: {}", e));
                        }
                    }
                }
                Ok(None) => {
                    // Target was already the default — no override applied
                    crate::stt::emit_stt_debug(&app, "info", "audio",
                        "IPolicyConfig: selected device is already the default — no override needed");
                    // Still store the target endpoint — it IS the current default
                    match crate::audio::device_default::get_default_capture_endpoint_id() {
                        Ok(ep) => {
                            if let Ok(mut guard) = state.ipolicy_target_endpoint.lock() {
                                *guard = Some(ep);
                            }
                        }
                        Err(_) => {}
                    }
                }
                Err(e) => {
                    crate::stt::emit_stt_debug(&app, "warn", "audio",
                        &format!("IPolicyConfig: override failed ({}). STT will use OS default mic.", e));
                }
            }
        } else {
            crate::stt::emit_stt_debug(&app, "info", "ipolicy",
                "IPolicyConfig: no override needed (neither party uses web_speech/windows_native with non-default input)");
        }

        // Emit IPolicyConfig status event for frontend synchronization
        let override_applied = you_needs_override || them_needs_override;
        let _ = app.emit("ipolicy_status", serde_json::json!({
            "applied": override_applied,
            "target_device": if you_needs_override { &you.device_id } else { &them.device_id },
        }));
    }

    if !capture_meeting_matches(&state, expected_meeting_id.as_deref())? {
        return Err("The meeting ended before capture could restart".to_string());
    }
    {
        let mut guard = state
            .audio
            .lock()
            .map_err(|_| "Audio state lock poisoned".to_string())?;
        let mgr = guard.get_or_insert_with(AudioCaptureManager::new);
        log::info!(
            "AudioCaptureManager::start_capture mic='{}', system='{}'",
            mic_device, system_device
        );
        mgr.start_capture(&mic_device, &system_device, system_is_input, tx, capture_status_sink(&app))?;
        for warning in mgr.take_warnings() {
            let _ = app.emit("capture_warning", warning);
        }
    }

    // Start STT streams
    // Each side's results arrive tagged with the generation of the provider that made
    // them (a side's provider can be swapped alone, see audio::side_swap).
    let (you_stt_tx, you_stt_rx) = mpsc::channel::<Tagged>(256);
    let (them_stt_tx, them_stt_rx) = mpsc::channel::<Tagged>(256);
    let you_signal = Arc::new(SwapSignal::default());
    let them_signal = Arc::new(SwapSignal::default());

    let mut you_stt_provider = you_stt;
    let mut them_stt_provider = them_stt;

    // A party that's already muted (hot-swap, in-person) starts muted, so a
    // provider that bills for an open stream doesn't connect until unmute.
    let you_muted_at_start = state.you_muted.load(Ordering::Relaxed);
    let them_muted_at_start = state.them_muted.load(Ordering::Relaxed);

    if let Some(ref mut provider) = you_stt_provider {
        crate::stt::emit_stt_debug(&app, "info", "stt",
            &format!("Starting 'You' STT ({})", you.stt_provider));
        provider.set_muted(you_muted_at_start);
        match provider.start_stream(you_signal.attach(&you_stt_tx)).await {
            Ok(()) => {
                log::info!("'You' party STT started ({})", you.stt_provider);
                crate::stt::emit_stt_debug(&app, "info", "stt",
                    &format!("'You' STT started: {}", you.stt_provider));
            }
            Err(e) => {
                log::warn!("Failed to start 'You' STT: {}", e);
                crate::stt::emit_stt_debug(&app, "error", "stt",
                    &format!("'You' STT failed to start: {}", e));
                let _ = app.emit("stt_connection_status", serde_json::json!({
                    "provider": you.stt_provider,
                    "party": "You",
                    "status": "error",
                    "message": format!("Failed to start STT: {}", e)
                }));
                you_stt_provider = None;
            }
        }
    }

    if let Some(ref mut provider) = them_stt_provider {
        crate::stt::emit_stt_debug(&app, "info", "stt",
            &format!("Starting 'Them' STT ({})", them.stt_provider));
        provider.set_muted(them_muted_at_start);
        match provider.start_stream(them_signal.attach(&them_stt_tx)).await {
            Ok(()) => {
                log::info!("'Them' party STT started ({})", them.stt_provider);
                crate::stt::emit_stt_debug(&app, "info", "stt",
                    &format!("'Them' STT started: {}", them.stt_provider));
            }
            Err(e) => {
                log::warn!("Failed to start 'Them' STT: {}", e);
                crate::stt::emit_stt_debug(&app, "error", "stt",
                    &format!("'Them' STT failed to start: {}", e));
                let _ = app.emit("stt_connection_status", serde_json::json!({
                    "provider": them.stt_provider,
                    "party": "Them",
                    "status": "error",
                    "message": format!("Failed to start STT: {}", e)
                }));
                them_stt_provider = None;
            }
        }
    }

    // Transcript events: "You" lines are spoken by "User", "Them" lines by "Them".
    // Each side's task also ends the open line when the side's provider is swapped.
    if you_stt_provider.is_some() {
        tasks.push(spawn_party_emitter(
            &app, Side::You, &you.stt_provider, &session_prefix, you_stt_rx, you_signal.clone(),
        ));
    }
    if them_stt_provider.is_some() {
        tasks.push(spawn_party_emitter(
            &app, Side::Them, &them.stt_provider, &session_prefix, them_stt_rx, them_signal.clone(),
        ));
    }

    // Grab the recorder handle for WAV recording (with mic/system mixing), and
    // each side's xrun/rebuild counts for the stats line.
    let (recorder, (you_counters, them_counters)) = {
        let guard = state.audio.lock().map_err(|_| "lock poisoned".to_string())?;
        let mgr = guard.as_ref().ok_or("No audio manager initialized")?;
        (mgr.get_recorder(), mgr.capture_counters())
    };

    // Grab mute flags so the audio loop can check them lock-free
    let you_muted_flag = state.you_muted.clone();
    let them_muted_flag = state.them_muted.clone();

    // Echo cancellation: what "Them" plays on the speakers is the reference
    // for the mic. Only for an output: an input "Them" (a second mic, the
    // same mic, a room mic) also carries the user's own voice.
    let echo_flag = state.echo_cancellation.clone();
    let echo_reference = !system_is_input;
    if echo_reference {
        log::info!(
            "Echo cancellation available: the output is the mic's reference (currently {})",
            if echo_flag.load(Ordering::Relaxed) { "on" } else { "off" }
        );
    }

    // A language change for one side reaches the loop here (set_party_language).
    let (swap_tx, mut swap_rx) =
        mpsc::unbounded_channel::<SideSwapMsg<Box<dyn STTProvider>>>();
    if let Ok(mut slot) = state.side_swap.lock() {
        *slot = Some(swap_tx);
    }
    // The loop keeps each side's result channel for the provider swapped in.
    let you_stt_tx = Some(you_stt_tx);
    let them_stt_tx = Some(them_stt_tx);
    // What a side's replacement engine is built from (set_party_language).
    let shared_language = get_stt_language(&state);
    let running = RunningCapture {
        session_prefix: session_prefix.clone(),
        languages: [you.effective_language(&shared_language), them.effective_language(&shared_language)],
        parties: [you.clone(), them.clone()],
        signals: [you_signal.clone(), them_signal.clone()],
    };

    // Audio processing task: levels + recording + STT feed per party
    let app_handle = app.clone();
    tasks.push(tokio::spawn(async move {
        // Separate VAD instances per audio source — sharing one VAD across
        // interleaved mic + system chunks corrupts smoothed_energy state.
        let mut mic_vad = VoiceActivityDetector::new();
        let mut sys_vad = VoiceActivityDetector::new();
        let mut mic_emit_ctr: u32 = 0;
        let mut sys_emit_ctr: u32 = 0;
        let mut mic_chunk_count: u64 = 0;
        let mut system_chunk_count: u64 = 0;

        // Time-based stats — emit only every 120s to reduce dev log noise
        let mut last_mic_stats = std::time::Instant::now();
        let mut last_sys_stats = std::time::Instant::now();
        let stats_interval = std::time::Duration::from_secs(120);

        // Mixer for proper two-source recording: places mic and system on the
        // wall clock so a stalled side cannot shift the other.
        let mut recording_mixer = RecordingMixer::new();
        // Capture times of the mic audio as it passes the echo stage, which
        // holds some back: the recording places each sample by when it was
        // captured, not by when the stage let it go.
        let mut mic_times = CaptureTimes::new();
        let mut mic_pieces: Vec<(usize, u64)> = Vec::new();

        // Track feed_audio errors per provider (emit once, not every chunk)
        let mut you_feed_error_emitted = false;
        let mut them_feed_error_emitted = false;

        let mut echo = crate::audio::echo_cancel::MicEchoFilter::new();

        // Mute state last passed to each provider. Checked on every chunk and on
        // a timer: Windows loopback sends no chunks while nothing plays, and a
        // mute then must still reach the provider.
        let mut you_muted_applied = you_muted_at_start;
        let mut them_muted_applied = them_muted_at_start;
        let mut mute_check = tokio::time::interval(MUTE_CHECK_INTERVAL);
        mute_check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        loop {
            // Audio first: the timer only runs once the queue is empty, so a
            // backlog is never mistaken for silence by the recording mixer.
            let mut chunk = tokio::select! {
                biased;
                received = rx.recv() => match received {
                    Some(chunk) => chunk,
                    None => break,
                },
                _ = mute_check.tick() => {
                    sync_mute(&mut you_stt_provider, &mut you_muted_applied, &you_muted_flag);
                    sync_mute(&mut them_stt_provider, &mut them_muted_applied, &them_muted_flag);
                    // Time passes while no audio arrives: the recording pads
                    // a side that went quiet as it happens.
                    if let Some(ref rec) = recorder {
                        recording_mixer.tick(wall_clock_ms(), &mut |b| rec.write_samples(b));
                    }
                    continue;
                }
                // One side's provider is being swapped for a new language; the other side,
                // the audio and the recording carry on.
                Some(msg) = swap_rx.recv() => {
                    match msg {
                        SideSwapMsg::Take { side: Side::You, reply } => side_swap::handle_take(
                            &mut you_stt_provider, you_stt_tx.as_ref(), &you_signal, reply),
                        SideSwapMsg::Take { side: Side::Them, reply } => side_swap::handle_take(
                            &mut them_stt_provider, them_stt_tx.as_ref(), &them_signal, reply),
                        SideSwapMsg::Put { side: Side::You, provider, muted } => side_swap::handle_put(
                            &mut you_stt_provider, &mut you_muted_applied, provider, muted),
                        SideSwapMsg::Put { side: Side::Them, provider, muted } => side_swap::handle_put(
                            &mut them_stt_provider, &mut them_muted_applied, provider, muted),
                    }
                    continue;
                }
            };
            sync_mute(&mut you_stt_provider, &mut you_muted_applied, &you_muted_flag);
            sync_mute(&mut them_stt_provider, &mut them_muted_applied, &them_muted_flag);

            // Echo cancellation comes first: levels, recording and STT all
            // get the cleaned mic.
            let cancel_echo = echo_reference && echo_flag.load(Ordering::Relaxed);
            match chunk.source {
                AudioSource::System => echo.reference(cancel_echo, &chunk.pcm_data),
                AudioSource::Mic => {
                    mic_times.input(chunk.pcm_data.len(), chunk.timestamp_ms);
                    chunk.pcm_data = echo.mic(cancel_echo, std::mem::take(&mut chunk.pcm_data));
                    mic_pieces = mic_times.output(chunk.pcm_data.len());
                    if chunk.pcm_data.is_empty() {
                        continue; // held back until the reference catches up
                    }
                }
                AudioSource::Room => {}
            }

            // Apply VAD from the correct per-source instance
            let vad_result = match chunk.source {
                AudioSource::Mic | AudioSource::Room => mic_vad.process_chunk(&chunk.pcm_data),
                AudioSource::System => sys_vad.process_chunk(&chunk.pcm_data),
            };
            chunk.is_speech = vad_result.is_speech;

            // Track chunk counts for diagnostics (time-based stats)
            match chunk.source {
                AudioSource::Mic | AudioSource::Room => {
                    mic_chunk_count += 1;
                    if mic_chunk_count == 1 {
                        let label = if chunk.source == AudioSource::Room { "room" } else { "mic" };
                        log::info!("First {} audio chunk received", label);
                        crate::stt::emit_stt_debug(&app_handle, "info", "audio",
                            &format!("First {} chunk received — audio pipeline active", label));
                    }
                    if last_mic_stats.elapsed() >= stats_interval {
                        let rms = calculate_rms(&chunk.pcm_data);
                        let label = if chunk.source == AudioSource::Room { "Room" } else { "Mic" };
                        let echo_queue = match (chunk.source == AudioSource::Mic, echo.queue_stats()) {
                            (true, Some((refills, trims))) => {
                                format!(", echo queue: {} refills, {} trims", refills, trims)
                            }
                            _ => String::new(),
                        };
                        crate::stt::emit_stt_debug_ex(&app_handle, "info", "audio",
                            &format!(
                                "{}: {} chunks, speech={}, rms={:.0}{}{}",
                                label, mic_chunk_count, chunk.is_speech, rms, echo_queue, capture_counts(&you_counters)
                            ),
                            Some("audio_mic_stats"));
                        last_mic_stats = std::time::Instant::now();
                    }
                }
                AudioSource::System => {
                    system_chunk_count += 1;
                    if system_chunk_count == 1 {
                        log::info!("First system audio chunk received — 'Them' capture is active");
                        crate::stt::emit_stt_debug(&app_handle, "info", "audio",
                            "First system chunk received — system audio capture active");
                    }
                    if last_sys_stats.elapsed() >= stats_interval {
                        let rms = calculate_rms(&chunk.pcm_data);
                        crate::stt::emit_stt_debug_ex(&app_handle, "info", "audio",
                            &format!(
                                "System: {} chunks, speech={}, rms={:.0}{}",
                                system_chunk_count, chunk.is_speech, rms, capture_counts(&them_counters)
                            ),
                            Some("audio_sys_stats"));
                        last_sys_stats = std::time::Instant::now();
                    }
                }
            }

            // Emit audio levels — separate counters per source for independent update rates
            let should_emit = match chunk.source {
                AudioSource::Mic | AudioSource::Room => {
                    mic_emit_ctr += 1;
                    mic_emit_ctr % 3 == 0
                }
                AudioSource::System => {
                    sys_emit_ctr += 1;
                    sys_emit_ctr % 3 == 0
                }
            };
            if should_emit {
                let rms = calculate_rms(&chunk.pcm_data);
                let peak = calculate_peak(&chunk.pcm_data);
                let level = AudioLevel {
                    source: chunk.source.clone(),
                    level: (rms / 3000.0).min(1.0),
                    peak,
                };
                let _ = app_handle.emit("audio_level", &level);
            }

            // Recording with mic/system mixing
            if let Some(ref rec) = recorder {
                // Placed by when it was captured, not when it was dequeued.
                let sink = &mut |b: &[i16]| rec.write_samples(b);
                match chunk.source {
                    AudioSource::Mic => {
                        let mut off = 0;
                        for &(n, end_ms) in &mic_pieces {
                            recording_mixer.push(
                                MixSide::Mic,
                                &chunk.pcm_data[off..off + n],
                                end_ms,
                                sink,
                            );
                            off += n;
                        }
                    }
                    AudioSource::System => recording_mixer.push(
                        MixSide::System,
                        &chunk.pcm_data,
                        chunk.timestamp_ms,
                        sink,
                    ),
                    AudioSource::Room => rec.write_samples(&chunk.pcm_data),
                }
            }

            // Route to the correct party's STT provider (surface errors once).
            // Mute gate: when a party is muted, skip feed_audio entirely —
            // audio levels + recording still flow, only STT is silenced.
            match chunk.source {
                AudioSource::Mic => {
                    if !you_muted_flag.load(Ordering::Relaxed) {
                        if let Some(ref mut provider) = you_stt_provider {
                            if let Err(e) = provider.feed_audio(chunk).await {
                                if !you_feed_error_emitted {
                                    crate::stt::emit_stt_debug(&app_handle, "error", "stt",
                                        &format!("'You' feed_audio error: {}", e));
                                    you_feed_error_emitted = true;
                                }
                            }
                        }
                    }
                }
                AudioSource::System => {
                    if !them_muted_flag.load(Ordering::Relaxed) {
                        if let Some(ref mut provider) = them_stt_provider {
                            if let Err(e) = provider.feed_audio(chunk).await {
                                if !them_feed_error_emitted {
                                    crate::stt::emit_stt_debug(&app_handle, "error", "stt",
                                        &format!("'Them' feed_audio error: {}", e));
                                    them_feed_error_emitted = true;
                                }
                            }
                        }
                    }
                }
                AudioSource::Room => {
                    // In-person mode: room audio routes to the "Them" provider
                    // (which handles diarization). Use the same mute gate.
                    if !them_muted_flag.load(Ordering::Relaxed) {
                        if let Some(ref mut provider) = them_stt_provider {
                            if let Err(e) = provider.feed_audio(chunk).await {
                                if !them_feed_error_emitted {
                                    crate::stt::emit_stt_debug(&app_handle, "error", "stt",
                                        &format!("'Room' feed_audio error: {}", e));
                                    them_feed_error_emitted = true;
                                }
                            }
                        }
                    }
                }
            }
        }

        // Flush remaining mix buffers
        if let Some(ref rec) = recorder {
            recording_mixer.finish(&mut |b| rec.write_samples(b));
        }

        // Clean shutdown, both parties at once: a cloud provider waits for its
        // last results here (Deepgram up to a few seconds).
        tokio::join!(
            async {
                if let Some(ref mut provider) = you_stt_provider {
                    let _ = provider.stop_stream().await;
                }
            },
            async {
                if let Some(ref mut provider) = them_stt_provider {
                    let _ = provider.stop_stream().await;
                }
            },
        );
        // The transcript tasks end (and flush) once no result channel is left open.
        drop(you_stt_tx);
        drop(them_stt_tx);

        // Restore IPolicyConfig override if active (crash recovery for async task exit)
        {
            let original = app_handle
                .try_state::<AppState>()
                .and_then(|s| s.original_default_device.lock().ok()?.take());
            if let Some(ref original_id) = original {
                let _ = crate::audio::device_default::restore_default_capture_device(original_id);
                log::info!("IPolicyConfig: restored default device on audio task exit");
            }
        }

        log::info!("Per-party audio processing task exiting");
    }));

    log::info!("Per-party audio capture started");
    set_running_capture(Some(running));
    // Remember what each side now runs under, so the next swap can tell news from old.
    if let Ok(mut stored) = state.auto_refusals.lock() {
        *stored = sides_refusals;
    }
    if let Some(warning) = refusals {
        let _ = app.emit("capture_warning", warning);
    }
    Ok(())
}

/// Create an STT provider for a party based on their config.
/// Returns None if the party uses web_speech (frontend-only).
///
/// API keys are read directly from the credential store (not the STTRouter)
/// because per-party mode never calls set_stt_provider(), so the router's
/// cached keys are always None.
///
/// `party_role` is what the side is called ("You", "Them", or "Room" for Them
/// in an in-person meeting). `other` is the other side's config (Soniox takes
/// its language as a hint) and `session_prefix` the prefix of this provider's
/// segment ids (Soniox tags its translations with the full id of their line).
async fn create_stt_provider_for_party(
    config: &crate::audio::PartyAudioConfig,
    other: &crate::audio::PartyAudioConfig,
    state: &AppState,
    app: &AppHandle,
    side: Side,
    party_role: &str,
    session_prefix: &str,
) -> Result<Option<Box<dyn STTProvider>>, String> {
    use crate::stt::provider::STTProviderType;

    let stt_type = STTProviderType::from_str(&config.stt_provider)
        .ok_or_else(|| format!("Unknown STT provider: {}", config.stt_provider))?;
    // This side's own language when it has one, else the shared transcription language.
    let shared_language = get_stt_language(state);
    let stt_language = config.effective_language(&shared_language);
    let deepgram_config = matches!(&stt_type, STTProviderType::Deepgram)
        .then(|| get_deepgram_config(state));

    check_auto_language(
        &stt_language,
        &stt_type,
        config.local_model_id.as_deref(),
        deepgram_config.as_ref().map(|dg| dg.model.as_str()),
        party_role,
    )?;

    crate::stt::emit_stt_debug(app, "info", "stt",
        &format!("[{}] Creating provider: {} (lang: {}, model: {})",
            party_role, config.stt_provider,
            stt_language,
            config.local_model_id.as_deref().unwrap_or("n/a")));

    match stt_type {
        STTProviderType::WebSpeech => Ok(None), // Frontend handles this
        STTProviderType::WhisperCpp => {
            let model_id = config.local_model_id.as_deref().unwrap_or("base");
            let model_result = get_local_model_path(state, "whisper_cpp", model_id)
                .or_else(|_| find_any_downloaded_model(state, "whisper_cpp"));
            match model_result {
                Ok(model_path) => {
                    if stt_language.eq_ignore_ascii_case("auto") {
                        let resolved_model = model_path
                            .file_name()
                            .and_then(|name| name.to_str())
                            .unwrap_or_default();
                        if !is_multilingual_whisper_model(resolved_model) {
                            return Err(whisper_auto_refusal(resolved_model, party_role));
                        }
                    }
                    let lang = stt_language.clone();
                    let whisper_config = state.whisper_config.clone();
                    let mut p = crate::stt::whisper_cpp::WhisperCppSTT::new(model_path, whisper_config);
                    p.set_language(&lang);
                    // NexQ Plus: on the GPU (Metal on macOS) unless switched off.
                    let use_gpu = app
                        .state::<crate::stt::plus_config::SttPlusState>()
                        .whisper_use_gpu
                        .load(std::sync::atomic::Ordering::Relaxed);
                    p.set_use_gpu(use_gpu);
                    Ok(Some(Box::new(p)))
                }
                Err(e) => {
                    log::warn!(
                        "WhisperCpp: {} — no transcription for this party. \
                         Download the model in Settings.",
                        e
                    );
                    Ok(None)
                }
            }
        }
        #[cfg(not(target_os = "windows"))]
        STTProviderType::WindowsNative => {
            // Only an energy detector off Windows ("[speech: N s]" placeholders): no engine.
            crate::stt::emit_stt_debug(app, "error", "stt",
                &format!("[{}] Windows Speech only works on Windows — choose another engine in Settings.", party_role));
            Ok(None)
        }
        #[cfg(target_os = "windows")]
        STTProviderType::WindowsNative => {
            use crate::stt::windows_native::WindowsNativeSTT;
            let lang = stt_language.clone();
            let mut provider = if config.is_input_device {
                // IPolicyConfig already overrides system default to the selected device,
                // so DirectMic mode correctly captures from non-default devices too
                WindowsNativeSTT::for_mic()
            } else {
                // System audio: feed PCM from pipeline
                WindowsNativeSTT::for_custom_stream()
            };
            provider.set_language(&lang);
            provider.set_app_handle(app.clone());
            provider.set_party(party_role);
            Ok(Some(Box::new(provider)))
        }
        STTProviderType::Deepgram => {
            let lang = stt_language.clone();
            let key = get_credential_key(state, "deepgram");
            log::info!("Deepgram key for '{}': {}", party_role, if key.is_some() { "present" } else { "MISSING" });
            let dg_config = deepgram_config.unwrap_or_default();
            let mut p = match key.as_deref() {
                Some(k) => crate::stt::deepgram::DeepgramSTT::with_api_key(k),
                None => crate::stt::deepgram::DeepgramSTT::new(),
            };
            p.set_language(&lang);
            p.set_config(dg_config);
            p.set_app_handle(app.clone());
            p.set_party(party_role);
            Ok(Some(Box::new(p)))
        }
        STTProviderType::WhisperApi => {
            let lang = stt_language.clone();
            let key = get_credential_key(state, "whisper_api");
            log::info!("WhisperApi key for '{}': {}", party_role, if key.is_some() { "present" } else { "MISSING" });
            let mut p = match key.as_deref() {
                Some(k) => crate::stt::whisper_api::WhisperApiSTT::with_api_key(k),
                None => crate::stt::whisper_api::WhisperApiSTT::new(),
            };
            p.set_language(&lang);
            Ok(Some(Box::new(p)))
        }
        STTProviderType::AzureSpeech => {
            let lang = stt_language.clone();
            let key = get_credential_key(state, "azure_speech");
            let region = get_credential_key(state, "azure_speech_region");
            log::info!("Azure key for '{}': {}, region: {}", party_role,
                if key.is_some() { "present" } else { "MISSING" },
                if region.is_some() { "present" } else { "MISSING" });
            let mut p = match (key.as_deref(), region.as_deref()) {
                (Some(k), Some(r)) => crate::stt::azure_speech::AzureSpeechSTT::with_config(k, r),
                _ => crate::stt::azure_speech::AzureSpeechSTT::new(),
            };
            p.set_language(&lang);
            Ok(Some(Box::new(p)))
        }
        STTProviderType::GroqWhisper => {
            let lang = stt_language.clone();
            let key = get_credential_key(state, "groq_whisper");
            log::info!("Groq key for '{}': {}", party_role, if key.is_some() { "present" } else { "MISSING" });
            let mut p = match key.as_deref() {
                Some(k) => crate::stt::groq_whisper::GroqWhisperSTT::with_api_key(k),
                None => crate::stt::groq_whisper::GroqWhisperSTT::new(),
            };
            p.set_language(&lang);
            if let Some(own) = config.own_language() {
                p.pin_language(own);
            }
            // Use shared config Arc — provider reads latest config on each API call,
            // so settings changes take effect immediately without restarting.
            // A side with its own language keeps it (pinned above); the others follow the shared one.
            p.set_shared_config(state.shared_groq_config.clone());
            p.set_app_handle(app.clone());
            p.set_party(party_role);
            Ok(Some(Box::new(p)))
        }
        STTProviderType::Cartesia => {
            let lang = stt_language.clone();
            let key = get_credential_key(state, "cartesia");
            log::info!("Cartesia key for '{}': {}", party_role, if key.is_some() { "present" } else { "MISSING" });
            let mut p = match key.as_deref() {
                Some(k) => crate::stt::cartesia::CartesiaSTT::with_api_key(k),
                None => crate::stt::cartesia::CartesiaSTT::new(),
            };
            p.set_language(&lang);
            p.set_app_handle(app.clone());
            p.set_party(party_role);
            Ok(Some(Box::new(p)))
        }
        STTProviderType::SherpaOnnx => {
            // Guard: ignore model_id from a different engine (e.g., parakeet model)
            let raw_model_id = config.local_model_id.as_deref();
            let model_id = match raw_model_id {
                Some(id) if id.contains("parakeet") || id.contains("nemo") => {
                    log::warn!("SherpaOnnx: ignoring cross-engine model_id '{}', using default", id);
                    "streaming-zipformer-en-20M"
                }
                Some(id) => id,
                None => "streaming-zipformer-en-20M",
            };
            let model_result = get_local_model_path(state, "sherpa_onnx", model_id);
            match model_result {
                Ok(model_dir) => {
                    let lang = stt_language.clone();
                    // Check if this is a non-transducer model (SenseVoice, etc.)
                    // by trying offline discovery first.
                    let offline_files = crate::stt::local_engines::model_discovery::discover_offline_model_files(&model_dir);
                    if let Ok(offline) = offline_files {
                        // Non-transducer model → use the sherpa-onnx offline program
                        let binary = find_offline_binary_for_state(state);
                        match binary {
                            Some(binary_path) => {
                                crate::stt::emit_stt_debug(app, "info", "stt",
                                    &format!("[{}] SherpaOnnx offline model '{}' from {} (lang={})",
                                        party_role, model_id, model_dir.display(), lang));
                                // Detect model type from model_id
                                let model_type = if model_id.contains("sense-voice") {
                                    crate::stt::sherpa_offline::OfflineModelType::SenseVoice
                                } else {
                                    crate::stt::sherpa_offline::OfflineModelType::NemoCtc
                                };
                                let mut p = crate::stt::sherpa_offline::SherpaOfflineSTT::new(
                                    binary_path,
                                    offline.model,
                                    offline.tokens,
                                    model_type,
                                    STTProviderType::SherpaOnnx,
                                );
                                p.set_language(&lang);
                                p.set_app_handle(app.clone());
                                Ok(Some(Box::new(p)))
                            }
                            None => {
                                crate::stt::emit_stt_debug(app, "error", "stt",
                                    &format!("[{}] {}", party_role, missing_offline_binary(state)));
                                Ok(None)
                            }
                        }
                    } else {
                        // Transducer model → use in-process ORT engine
                        crate::stt::emit_stt_debug(app, "info", "stt",
                            &format!("[{}] SherpaOnnx loading model '{}' from {} (lang={})",
                                party_role, model_id, model_dir.display(), lang));
                        let mut p = crate::stt::ort_streaming::OrtStreamingSTT::new(model_dir);
                        p.set_language(&lang);
                        p.set_app_handle(app.clone());
                        Ok(Some(Box::new(p)))
                    }
                }
                Err(e) => {
                    crate::stt::emit_stt_debug(app, "error", "stt",
                        &format!("[{}] SherpaOnnx model '{}' not found: {}. Download in Settings.",
                            party_role, model_id, e));
                    Ok(None)
                }
            }
        }
        STTProviderType::OrtStreaming => {
            let model_id = config.local_model_id.as_deref().unwrap_or("zipformer-en-20M");
            let model_result = get_local_model_path(state, "ort_streaming", model_id);
            match model_result {
                Ok(model_dir) => {
                    let lang = stt_language.clone();
                    crate::stt::emit_stt_debug(app, "info", "stt",
                        &format!("[{}] ORT loading model '{}' from {} (lang={})",
                            party_role, model_id, model_dir.display(), lang));
                    let mut p = crate::stt::ort_streaming::OrtStreamingSTT::new(model_dir);
                    p.set_language(&lang);
                    p.set_app_handle(app.clone());
                    Ok(Some(Box::new(p)))
                }
                Err(e) => {
                    crate::stt::emit_stt_debug(app, "error", "stt",
                        &format!("[{}] ORT model '{}' not found: {}. Download in Settings.",
                            party_role, model_id, e));
                    Ok(None)
                }
            }
        }
        STTProviderType::ParakeetTdt => {
            // Guard: ignore model_id from a different engine (e.g., sense-voice-small from sherpa_onnx)
            let model_id = config
                .local_model_id
                .as_deref()
                .map(resolve_parakeet_model_id)
                .unwrap_or_else(|| "parakeet-tdt-0.6b-v3-int8".to_string());
            if config
                .local_model_id
                .as_deref()
                .is_some_and(|id| id != model_id && !id.contains("parakeet") && !id.contains("nemo"))
            {
                log::warn!(
                    "ParakeetTdt: ignoring cross-engine model_id, using default '{}'",
                    model_id
                );
            }
            crate::stt::emit_stt_debug(app, "info", "stt",
                &format!("[{}] Parakeet TDT: looking for model '{}' (local_model_id={:?})",
                    party_role, model_id, config.local_model_id));
            let model_result = get_local_model_path(state, "parakeet_tdt", &model_id)
                .or_else(|_| find_any_downloaded_model(state, "parakeet_tdt"));
            match model_result {
                Ok(model_dir) => {
                    // OrtStreamingSTT discovers the layout itself at start_stream
                    // time: transducer (encoder/decoder/joiner, e.g. 0.6B v3) or
                    // a single-file CTC encoder (e.g. 110M) — both run natively,
                    // no external sherpa-onnx-offline program needed.
                    let lang = stt_language.clone();
                    // Auto-detect needs the multilingual transducer: a CTC folder can't do it,
                    // even when TDT v3 was asked for but only CTC is downloaded.
                    if stt_language.eq_ignore_ascii_case("auto")
                        && crate::stt::local_engines::model_discovery::discover_model_files(&model_dir).is_err()
                    {
                        return Err(parakeet_ctc_auto_refusal(party_role));
                    }
                    crate::stt::emit_stt_debug(app, "info", "stt",
                        &format!("[{}] Parakeet model from {} (lang={})",
                            party_role, model_dir.display(), lang));
                    let mut p = crate::stt::ort_streaming::OrtStreamingSTT::new(model_dir);
                    p.set_language(&lang);
                    p.set_app_handle(app.clone());
                    Ok(Some(Box::new(p)))
                }
                Err(e) => {
                    crate::stt::emit_stt_debug(app, "error", "stt",
                        &format!("[{}] Parakeet model '{}' not found: {}. Download in Settings.",
                            party_role, model_id, e));
                    Ok(None)
                }
            }
        }
        // NexQ Plus engines. Their status events name the side "You" or "Them"
        // (never "Room"): the fork's status and region displays are keyed by that.
        STTProviderType::OpenAICompat => {
            use crate::stt::plus_config::{SttPlusState, OPENAI_COMPAT_STT_KEY_SLOT};
            let key = get_credential_key(state, OPENAI_COMPAT_STT_KEY_SLOT);
            let shared = app.state::<SttPlusState>().openai_compat.clone();
            let mut p = crate::stt::openai_compat::OpenAICompatSTT::new(shared, key);
            // "auto" leaves the request's language out: the server detects it.
            p.set_language(&stt_language);
            p.set_app_handle(app.clone());
            p.set_party(side_label(side));
            Ok(Some(Box::new(p)))
        }
        STTProviderType::Soniox => {
            use crate::stt::plus_config::{SttPlusState, SONIOX_KEY_SLOT};
            let key = get_credential_key(state, SONIOX_KEY_SLOT);
            let cfg = app.state::<SttPlusState>().soniox_snapshot();
            let party_label = side_label(side);
            let meeting_ref = state
                .live_meeting
                .lock()
                .ok()
                .and_then(|m| m.as_ref().map(|m| m.id.clone()))
                .unwrap_or_else(|| session_prefix.to_string());
            let options = crate::stt::soniox::SonioxSessionOptions {
                party: party_label.to_string(),
                // The side's language, or "auto": its language hints, with the
                // other side's language when this one detects.
                language: stt_language.clone(),
                other_language: Some(other.effective_language(&shared_language)),
                translation: soniox_translation(config, state),
                segment_id_prefix: segment_prefix(side, session_prefix),
                client_reference_id: Some(format!("nexq:{}:{}", meeting_ref, party_label.to_lowercase())),
                diarize: side == Side::Them && cfg.enable_speaker_diarization,
            };
            crate::stt::emit_stt_debug(app, "info", "soniox",
                &format!("[{}] model={}, region={}, translation={}", party_role, cfg.model, cfg.region,
                    options.translation));
            let mut p = crate::stt::soniox::SonioxSTT::new(cfg, key, options);
            p.set_app_handle(app.clone());
            Ok(Some(Box::new(p)))
        }
    }
}

/// Find the sherpa-onnx offline program from the ModelManager's models directory.
fn find_offline_binary_for_state(state: &AppState) -> Option<std::path::PathBuf> {
    let model_mgr = state.model_manager.as_ref()?;
    let mgr = model_mgr.lock().ok()?;
    crate::stt::sherpa_offline::find_offline_binary(mgr.models_dir())
}

/// Dev Log message for a model whose offline program is missing.
fn missing_offline_binary(state: &AppState) -> String {
    let models_dir = state
        .model_manager
        .as_ref()
        .and_then(|m| m.lock().ok().map(|mgr| mgr.models_dir().to_path_buf()))
        .unwrap_or_default();
    crate::stt::sherpa_offline::missing_binary_message(&models_dir)
}

/// Find any downloaded model for an engine (fallback when requested model isn't available).
fn find_any_downloaded_model(
    state: &AppState,
    engine: &str,
) -> Result<std::path::PathBuf, String> {
    let model_mgr = state
        .model_manager
        .as_ref()
        .ok_or("Model manager not initialized")?;
    let mgr = model_mgr
        .lock()
        .map_err(|_| "Model manager lock poisoned".to_string())?;
    let engines = mgr.list_engines_with_status();
    for eng in &engines {
        if eng.engine == engine {
            for m in &eng.models {
                if m.is_downloaded {
                    if let Some(path) = mgr.get_model_path(engine, m.definition.model_id) {
                        log::info!(
                            "WhisperCpp: using fallback model '{}' (requested model unavailable)",
                            m.definition.model_id
                        );
                        return Ok(path);
                    }
                }
            }
        }
    }
    Err(format!("No {} models downloaded", engine))
}

/// Get the model path for a local STT engine from the ModelManager.
fn get_local_model_path(
    state: &AppState,
    engine: &str,
    model_id: &str,
) -> Result<std::path::PathBuf, String> {
    let model_mgr = state
        .model_manager
        .as_ref()
        .ok_or("Model manager not initialized")?;
    let mgr = model_mgr
        .lock()
        .map_err(|_| "Model manager lock poisoned".to_string())?;
    mgr.get_model_path(engine, model_id)
        .ok_or_else(|| format!("Model {}:{} not downloaded", engine, model_id))
}

/// Get the current STT language from the router.
fn get_stt_language(state: &AppState) -> String {
    state
        .stt
        .as_ref()
        .and_then(|stt| stt.lock().ok().map(|r| r.language.clone()))
        .unwrap_or_else(|| "en-US".to_string())
}

/// What Soniox translates a party into, per its `native_translation`:
/// one-way into its own target, else the translation settings'; two-way
/// between its languages A and B (both set, two different two-letter codes;
/// else nothing). Codes come as the settings name them ("zh-CN", used for the
/// translations it produces) and as Soniox takes them ("zh").
fn soniox_translation(
    config: &crate::audio::PartyAudioConfig,
    state: &AppState,
) -> crate::stt::soniox::SonioxTranslation {
    use crate::stt::language::base_code;
    use crate::stt::soniox::SonioxTranslation;
    let Some(translation) = config.native_translation.as_ref() else {
        return SonioxTranslation::Off;
    };
    let chosen = match translation.mode.as_str() {
        "one_way" => translation
            .target_language
            .clone()
            .filter(|t| !t.trim().is_empty())
            .or_else(|| {
                state
                    .translation
                    .as_ref()
                    .and_then(|tr| tr.lock().ok().map(|router| router.default_target_lang().to_string()))
            })
            .and_then(|target| {
                let code = target.trim().to_string();
                let soniox = base_code(&code)?;
                Some(SonioxTranslation::OneWay { code, soniox })
            }),
        "two_way" => {
            let side = |code: Option<&String>| {
                let code = code?.trim();
                let soniox = base_code(code).filter(|c| c.len() == 2)?;
                Some((code.to_string(), soniox))
            };
            match (side(translation.language_a.as_ref()), side(translation.language_b.as_ref())) {
                (Some((a_code, a)), Some((b_code, b))) if a != b => {
                    Some(SonioxTranslation::TwoWay { a_code, a, b_code, b })
                }
                _ => None,
            }
        }
        _ => None,
    };
    chosen.unwrap_or_default()
}

/// The Auto-detect check of one side: nothing unless `language` is Auto-detect,
/// else a refusal when the side's provider and model can't detect the language.
/// `local_model_id` is the side's own model, `deepgram_model` the shared Deepgram one.
fn check_auto_language(
    language: &str,
    provider: &crate::stt::provider::STTProviderType,
    local_model_id: Option<&str>,
    deepgram_model: Option<&str>,
    party_role: &str,
) -> Result<(), String> {
    use crate::stt::provider::STTProviderType;

    if !language.eq_ignore_ascii_case("auto") {
        return Ok(());
    }
    let model = match provider {
        STTProviderType::Deepgram => deepgram_model.unwrap_or_default().to_string(),
        STTProviderType::WhisperCpp => local_model_id.unwrap_or("base").to_string(),
        STTProviderType::ParakeetTdt => local_model_id
            .map(resolve_parakeet_model_id)
            .unwrap_or_else(|| "parakeet-tdt-0.6b-v3-int8".to_string()),
        // NexQ Plus: among the Sherpa-ONNX models, SenseVoice detects the language.
        STTProviderType::SherpaOnnx => local_model_id.unwrap_or_default().to_string(),
        // The other providers don't depend on a model for Auto-detect.
        _ => String::new(),
    };
    validate_auto_language_provider(provider, &model, party_role)
}

/// Whether `provider` + `model` can detect the spoken language on its own.
/// Mirrors `supportsSTTAutoDetection` in `src/lib/sttLanguages.ts`; both sides
/// check the same table (`src/lib/autoDetectCases.json`, tested on both sides).
///
/// NexQ Plus adds what that table doesn't list: its own engines (Soniox, the
/// remote OpenAI-compatible Whisper) and SenseVoice among the Sherpa-ONNX models.
fn supports_auto_language(provider: &crate::stt::provider::STTProviderType, model: &str) -> bool {
    use crate::stt::provider::STTProviderType;

    match provider {
        STTProviderType::Deepgram => {
            matches!(model, "nova-3" | "nova-3-general" | "flux-general-multi")
        }
        STTProviderType::WhisperCpp => is_multilingual_whisper_model(model),
        STTProviderType::GroqWhisper | STTProviderType::WhisperApi | STTProviderType::Cartesia => true,
        STTProviderType::ParakeetTdt => model.starts_with("parakeet-tdt-0.6b-v3"),
        // SenseVoice is told "auto" (`stt::language::sense_voice_language`); the
        // streaming transducers can't detect.
        STTProviderType::SherpaOnnx => model.contains("sense-voice"),
        // Soniox detects (the languages it is given are only hints); a remote
        // Whisper detects when the request leaves the language out.
        STTProviderType::Soniox | STTProviderType::OpenAICompat => true,
        _ => false,
    }
}

/// Refuse Auto-detect for a side whose provider or model can't do it, in words
/// a user can act on. `party_role` is "You", "Them" or "Room" (Them in an in-person meeting).
fn validate_auto_language_provider(
    provider: &crate::stt::provider::STTProviderType,
    model: &str,
    party_role: &str,
) -> Result<(), String> {
    use crate::stt::provider::STTProviderType;

    if supports_auto_language(provider, model) {
        return Ok(());
    }

    Err(match provider {
        STTProviderType::WhisperCpp => whisper_auto_refusal(model, party_role),
        STTProviderType::ParakeetTdt => parakeet_ctc_auto_refusal(party_role),
        STTProviderType::Deepgram => {
            auto_refusal(&format!("Deepgram {}", deepgram_model_label(model)), party_role, AUTO_DETECT_ADVICE)
        }
        STTProviderType::WebSpeech => auto_refusal("Web Speech", party_role, AUTO_DETECT_ADVICE),
        STTProviderType::WindowsNative => auto_refusal("Windows Speech", party_role, AUTO_DETECT_ADVICE),
        STTProviderType::AzureSpeech => auto_refusal("Azure Speech", party_role, AUTO_DETECT_ADVICE),
        STTProviderType::SherpaOnnx => auto_refusal("Sherpa-ONNX", party_role, AUTO_DETECT_ADVICE),
        STTProviderType::OrtStreaming => auto_refusal("ORT Streaming", party_role, AUTO_DETECT_ADVICE),
        _ => auto_refusal("this speech-to-text provider", party_role, AUTO_DETECT_ADVICE),
    })
}

/// Start of every message that refuses Auto-detect for one side. The frontend
/// recognises it (`AUTO_DETECT_REFUSAL_PREFIX` in sttLanguages.ts).
const AUTO_DETECT_REFUSAL: &str = "Auto-detect doesn't work with";
const AUTO_DETECT_ADVICE: &str =
    "Choose Deepgram Nova-3, Parakeet TDT 0.6B v3, Groq Whisper or Whisper API for that side, or pick a language.";
const AUTO_DETECT_WHISPER_ADVICE: &str =
    "Choose a multilingual Whisper model (Tiny, Base, Small, Medium or Large v3 Turbo), or pick a language.";

fn auto_refusal(name: &str, party_role: &str, advice: &str) -> String {
    format!("{AUTO_DETECT_REFUSAL} {name}, used for {party_role}. {advice}")
}

/// A Whisper.cpp model that can't detect the language ("ggml-base.en.bin", "distil-large-v3").
fn whisper_auto_refusal(model: &str, party_role: &str) -> String {
    let id = model.trim_start_matches("ggml-").trim_end_matches(".bin");
    auto_refusal(&format!("the {} Whisper model", whisper_model_label(id)), party_role, AUTO_DETECT_WHISPER_ADVICE)
}

fn parakeet_ctc_auto_refusal(party_role: &str) -> String {
    auto_refusal("Parakeet CTC 110M", party_role, AUTO_DETECT_ADVICE)
}

/// The Deepgram model's name as the STT Providers picker shows it.
fn deepgram_model_label(model: &str) -> &str {
    match model {
        "nova-3" | "nova-3-general" => "Nova 3",
        "flux-general-en" => "Flux",
        "flux-general-multi" => "Flux Multilingual",
        "nova-2" => "Nova 2",
        "nova" => "Nova",
        "enhanced" => "Enhanced",
        "base" => "Base",
        other => other,
    }
}

/// A Whisper.cpp model's name as people know it; other models show their id.
fn whisper_model_label(model: &str) -> &str {
    match model {
        "distil-large-v3" => "Distil Large v3",
        other => other,
    }
}

/// What becomes of one side when its STT provider is created.
struct SideOutcome<T> {
    provider: Option<T>,
    /// Set when the side goes without STT because it can't detect the language.
    refusal: Option<String>,
    /// Whether the user hasn't been told about `refusal` yet.
    announce: bool,
}

/// Whether the frontend, not Rust, transcribes this side (Web Speech on a microphone).
fn uses_frontend_stt(config: &crate::audio::PartyAudioConfig) -> bool {
    config.stt_provider == "web_speech" && config.is_input_device
}

/// A side that can't detect the language goes without speech-to-text instead
/// of blocking the meeting:
/// - at a start, the refusal is announced;
/// - during a swap, the refusal the side already runs under (`running_refusal`)
///   is tolerated silently, and so is one for a `frontend_stt` side: the
///   frontend has already stopped it and told the user, and refusing here
///   would block every later swap. Any other new refusal is an error that
///   keeps the running capture untouched.
///
/// Any other error is an error.
fn resolve_side<T>(
    result: Result<Option<T>, String>,
    was_capturing: bool,
    running_refusal: Option<&str>,
    frontend_stt: bool,
) -> Result<SideOutcome<T>, String> {
    match result {
        Ok(provider) => Ok(SideOutcome { provider, refusal: None, announce: false }),
        Err(message) if message.starts_with(AUTO_DETECT_REFUSAL) => {
            if !was_capturing {
                Ok(SideOutcome { provider: None, refusal: Some(message), announce: true })
            } else if frontend_stt || running_refusal == Some(message.as_str()) {
                Ok(SideOutcome { provider: None, refusal: Some(message), announce: false })
            } else {
                Err(message)
            }
        }
        Err(message) => Err(message),
    }
}

/// Both sides at once. A swap refused for both says so for both (the side the
/// user just changed may not be the one named first); a real error wins over a refusal.
fn resolve_sides<T, U>(
    you: Result<Option<T>, String>,
    them: Result<Option<U>, String>,
    was_capturing: bool,
    running_refusals: &[Option<String>; 2],
    frontend_stt: [bool; 2],
) -> Result<(SideOutcome<T>, SideOutcome<U>), String> {
    match (
        resolve_side(you, was_capturing, running_refusals[0].as_deref(), frontend_stt[0]),
        resolve_side(them, was_capturing, running_refusals[1].as_deref(), frontend_stt[1]),
    ) {
        (Ok(you), Ok(them)) => Ok((you, them)),
        (Err(a), Err(b)) => {
            let (a_refusal, b_refusal) = (a.starts_with(AUTO_DETECT_REFUSAL), b.starts_with(AUTO_DETECT_REFUSAL));
            Err(match (a_refusal, b_refusal) {
                (true, true) => format!("{a} {b}"),
                (true, false) => b,
                _ => a,
            })
        }
        (Err(message), _) | (_, Err(message)) => Err(message),
    }
}

/// What a language change for one running side comes to, by the same rules as a
/// full swap (`resolve_side`, while capturing):
/// - `Ok(Some(provider))`: restart that side's speech-to-text with it;
/// - `Ok(None)`: the side has no provider of its own (Web Speech, a refusal it already
///   runs under, no model): nothing for Rust to restart, so the caller falls back to a full swap;
/// - `Err`: a new Auto-detect refusal or another error, before anything was stopped.
fn resolve_language_swap<T>(
    result: Result<Option<T>, String>,
    running_refusal: Option<&str>,
    frontend_stt: bool,
) -> Result<Option<T>, String> {
    resolve_side(result, true, running_refusal, frontend_stt).map(|side| side.provider)
}

/// The provider a refusal names: "Auto-detect doesn't work with <name>, used for <side>. ..."
fn refusal_provider_name(refusal: &str) -> Option<&str> {
    refusal
        .strip_prefix(AUTO_DETECT_REFUSAL)?
        .trim_start()
        .split_once(", used for ")
        .map(|(name, _)| name)
}

/// The one toast for sides that start without speech-to-text, a sentence per
/// side. `sides` is (label, refusal to announce); None when there is nothing to say.
fn start_warnings(sides: &[(&str, Option<String>)]) -> Option<String> {
    let sentences: Vec<String> = sides
        .iter()
        .filter_map(|(label, refusal)| {
            let name = refusal_provider_name(refusal.as_deref()?)?;
            Some(format!(
                "{label} won't be transcribed: {name} can't detect the language. Change it in Audio & Devices or pick a language."
            ))
        })
        .collect();
    (!sentences.is_empty()).then(|| sentences.join(" "))
}

fn resolve_parakeet_model_id(model: &str) -> String {
    if model.contains("parakeet") || model.contains("nemo") {
        model.to_string()
    } else {
        "parakeet-tdt-0.6b-v3-int8".to_string()
    }
}

fn is_multilingual_whisper_model(model: &str) -> bool {
    matches!(
        model,
        "tiny" | "base" | "small" | "medium" | "large-v3-turbo"
            | "ggml-tiny.bin" | "ggml-base.bin" | "ggml-small.bin" | "ggml-medium.bin"
            | "ggml-large-v3-turbo.bin"
    )
}

/// Read an API key directly from the credential store (Windows Credential Manager).
/// This bypasses the STTRouter, which only has keys when set_stt_provider() was called.
/// Per-party mode never calls set_stt_provider(), so we read credentials directly.
fn get_credential_key(state: &AppState, provider: &str) -> Option<String> {
    state.credentials.as_ref()
        .and_then(|cred_arc| cred_arc.lock().ok())
        .and_then(|cred| cred.get_key(provider).ok().flatten())
}

/// Get the current Deepgram config from the STT router.
fn get_deepgram_config(state: &AppState) -> crate::stt::deepgram::DeepgramConfig {
    state
        .stt
        .as_ref()
        .and_then(|stt| stt.lock().ok().map(|r| r.deepgram_config.clone()))
        .unwrap_or_default()
}

// ── IPolicyConfig verification for Web Speech restart ───────────────

/// Verify the OS default capture device still matches the IPolicy target.
/// If Windows has reset the default (drift), re-apply the override.
/// Called by the frontend before each Web Speech restart.
/// Non-destructive: only reads original_default_device and ipolicy_target_endpoint.
#[command]
pub async fn ensure_ipolicy_override(app: AppHandle) -> Result<String, String> {
    let state = app.state::<AppState>();

    // 1. Check if an override is active (peek, not take)
    let original = match state.original_default_device.lock() {
        Ok(guard) => guard.clone(),
        Err(_) => return Err("State lock poisoned".to_string()),
    };
    if original.is_none() {
        return serde_json::to_string(&serde_json::json!({
            "active": false,
            "was_drifted": false
        })).map_err(|e| e.to_string());
    }

    // 2. Get the target endpoint (peek, not take)
    let target = match state.ipolicy_target_endpoint.lock() {
        Ok(guard) => guard.clone(),
        Err(_) => return Err("State lock poisoned".to_string()),
    };
    let target = match target {
        Some(t) => t,
        None => {
            log::warn!("IPolicyConfig: override active but no target endpoint stored");
            return serde_json::to_string(&serde_json::json!({
                "active": true,
                "was_drifted": false,
                "current_device": ""
            })).map_err(|e| e.to_string());
        }
    };

    // 3. Read current OS default (handles COM init internally)
    log::info!("IPolicyConfig: verifying default capture device...");

    #[cfg(target_os = "windows")]
    {
        use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

        let result = unsafe {
            let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
            let we_initialized = hr.0 == 0;
            if hr.is_err() && hr.0 as u32 != 0x80010106 {
                return Err(format!("CoInitializeEx failed: 0x{:08X}", hr.0));
            }

            let res = (|| -> Result<String, String> {
                let current = crate::audio::device_default::get_default_capture_endpoint_id()?;
                log::debug!("IPolicyConfig verify: current='{}', target='{}'", current, target);

                let was_drifted = current != target;
                if was_drifted {
                    log::warn!(
                        "IPolicyConfig: drift detected! current='{}' != target='{}', re-applying...",
                        current, target
                    );
                    crate::audio::device_default::set_default_capture_endpoint(&target)?;
                    crate::stt::emit_stt_debug(&app, "warn", "ipolicy",
                        &format!("IPolicyConfig drift corrected: '{}' → '{}'", current, target));
                } else {
                    log::info!("IPolicyConfig: no drift — default is still correct");
                }

                serde_json::to_string(&serde_json::json!({
                    "active": true,
                    "was_drifted": was_drifted,
                    "current_device": target
                })).map_err(|e| e.to_string())
            })();

            if we_initialized {
                CoUninitialize();
            }
            res
        };
        result
    }

    #[cfg(not(target_os = "windows"))]
    {
        serde_json::to_string(&serde_json::json!({
            "active": false,
            "was_drifted": false
        })).map_err(|e| e.to_string())
    }
}

// ── IPolicyConfig restore helper ────────────────────────────────────

/// Restore the original default capture device if an IPolicyConfig override is active.
/// Safe to call even if no override was applied (no-op in that case).
/// Uses `take()` to atomically remove the stored value, preventing TOCTOU races
/// where a concurrent hot-swap could lose a newly-stored override.
fn restore_default_device_if_overridden(state: &AppState, app: &tauri::AppHandle) {
    // Atomically take the value — if another thread races, only one gets Some
    let original = match state.original_default_device.lock() {
        Ok(mut guard) => guard.take(),
        Err(_) => return,
    };

    // Also clear the target endpoint
    if let Ok(mut target_guard) = state.ipolicy_target_endpoint.lock() {
        target_guard.take();
    }

    if let Some(ref original_id) = original {
        crate::stt::emit_stt_debug(app, "info", "audio",
            &format!("IPolicyConfig: restoring default capture → '{}'", original_id));

        match crate::audio::device_default::restore_default_capture_device(original_id) {
            Ok(()) => {
                crate::stt::emit_stt_debug(app, "info", "audio",
                    "IPolicyConfig: default capture device restored");
            }
            Err(e) => {
                crate::stt::emit_stt_debug(app, "error", "audio",
                    &format!("IPolicyConfig: restore failed: {}", e));
            }
        }
    }
}

// ── Echo cancellation ───────────────────────────────────────────────

/// Turn echo cancellation for "You" on or off; applies mid-meeting.
#[command]
pub async fn set_echo_cancellation(app: AppHandle, enabled: bool) -> Result<(), String> {
    let state = app.state::<AppState>();
    state.echo_cancellation.store(enabled, Ordering::Relaxed);
    log::info!("Echo cancellation {}", if enabled { "on" } else { "off" });
    Ok(())
}

// ── Per-party mute control ──────────────────────────────────────────

/// Mute or unmute a specific audio source.
/// When muted, audio is still captured (levels + recording) but NOT forwarded to STT.
///
/// `source` must be "you" or "them".
#[command]
pub async fn set_source_muted(
    app: AppHandle,
    source: String,
    muted: bool,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    match source.as_str() {
        "you" => {
            state.you_muted.store(muted, Ordering::Relaxed);
            log::info!("'You' audio source {}", if muted { "muted" } else { "unmuted" });
        }
        "them" => {
            state.them_muted.store(muted, Ordering::Relaxed);
            log::info!("'Them' audio source {}", if muted { "muted" } else { "unmuted" });
        }
        _ => return Err(format!("Unknown source: '{}' (expected 'you' or 'them')", source)),
    }
    Ok(())
}

// ── NexQ Plus: what a one-side restart takes from the running capture ──

/// The per-party capture that runs now, as `start_capture_per_party` set it
/// up. `set_party_language` builds one side's replacement engine from it, the
/// way the first one was built.
struct RunningCapture {
    /// Prefix of the capture's segment ids ("ab12").
    session_prefix: String,
    /// Each side's config as it runs now (You, Them).
    parties: [crate::audio::PartyAudioConfig; 2],
    /// The language each side's engine was started with (its own, else the shared one).
    languages: [String; 2],
    /// Each side's swap signal: how many times its provider was replaced.
    signals: [Arc<SwapSignal>; 2],
}

/// Set once a per-party capture is up, cleared when it stops. Capture changes
/// run one at a time (they hold `AppState::audio_tasks`), so what a change
/// reads here stays true until it is done.
static RUNNING_CAPTURE: std::sync::Mutex<Option<RunningCapture>> = std::sync::Mutex::new(None);

fn set_running_capture(capture: Option<RunningCapture>) {
    if let Ok(mut slot) = RUNNING_CAPTURE.lock() {
        *slot = capture;
    }
}

/// What a language change for one side takes from the running capture.
struct SwapPlan {
    /// The other side's config (Soniox takes its language as a hint).
    other: crate::audio::PartyAudioConfig,
    /// Prefix of the replacement's segment ids: the capture's, with the
    /// generation the replacement will have ("ab12s1"). The side's transcript
    /// task forwards its lines under the same prefix.
    session_prefix: String,
}

/// How a language change for `side` goes about it, or None when only a restart
/// of the whole capture will do:
/// - `config` differs from the running side in more than its language (another
///   engine or device: the side's transcript task and its capture were set up
///   for the running ones);
/// - the other side's engine was started with this side's language and now
///   gets another one (`hints_other_side`): both sides restart.
///
/// `other_transcribed`: whether the other side runs an engine at all (in an
/// in-person meeting "You" doesn't).
fn swap_plan(
    running: &RunningCapture,
    side: Side,
    config: &crate::audio::PartyAudioConfig,
    shared_language: &str,
    other_transcribed: bool,
) -> Option<SwapPlan> {
    let here = side.index();
    let there = 1 - here;
    let current = &running.parties[here];
    let other = &running.parties[there];
    if current.stt_provider != config.stt_provider
        || current.device_id != config.device_id
        || current.is_input_device != config.is_input_device
    {
        return None;
    }
    let language = config.effective_language(shared_language);
    if other_transcribed
        && hints_other_side(&other.stt_provider, &running.languages[there], &running.languages[here], &language)
    {
        return None;
    }
    // The replacement is the side's next provider.
    let generation = running.signals[here].generation() + 1;
    Some(SwapPlan {
        other: other.clone(),
        session_prefix: side_swap::generation_prefix(&running.session_prefix, generation),
    })
}

/// Whether the other side's engine (`other_provider`, started with
/// `other_language`) was given this side's language, and a change of it from
/// `was` to `now` gives it another one. That is Soniox on Auto-detect: the
/// language it is hinted is then the other party's
/// (`stt::language::soniox_language_hints`).
fn hints_other_side(other_provider: &str, other_language: &str, was: &str, now: &str) -> bool {
    use crate::stt::language::{base_code, is_auto};
    other_provider == "soniox" && is_auto(other_language) && base_code(was) != base_code(now)
}

/// A side's engine was replaced: the capture now runs with `config` on it.
fn note_swapped_side(side: Side, config: &crate::audio::PartyAudioConfig, shared_language: &str) {
    if let Ok(mut slot) = RUNNING_CAPTURE.lock() {
        if let Some(running) = slot.as_mut() {
            running.languages[side.index()] = config.effective_language(shared_language);
            running.parties[side.index()] = config.clone();
        }
    }
}

/// Change one side's transcription language mid-meeting by restarting only that
/// side's speech-to-text. The other side's capture and STT, the audio levels and
/// the recording keep running (see `audio::side_swap`).
///
/// `config` is the side's whole `PartyAudioConfig` with the new language;
/// `party` is "you" or "them" ("Room" in an in-person meeting is "them").
/// Returns `true` when the side was restarted, `false` when nothing was done and
/// the caller has to do a full `start_capture_per_party` (no capture running, the
/// side has no Rust provider, the loop is gone, or more than this side's engine
/// has to restart, see `swap_plan`). A new Auto-detect refusal is
/// an error that starts with "Auto-detect doesn't work with", before anything is stopped;
/// a new provider that fails to start is another error, after the side's old one has
/// stopped, and the caller restarts the whole capture.
#[command]
pub async fn set_party_language(
    app: AppHandle,
    party: String,
    config: String,
    skip_you_stt: Option<bool>,
) -> Result<bool, String> {
    let side = Side::parse(&party)
        .ok_or_else(|| format!("Unknown party: '{}' (expected 'you' or 'them')", party))?;
    let config: crate::audio::PartyAudioConfig =
        serde_json::from_str(&config).map_err(|e| format!("Invalid party config: {}", e))?;
    let skip_you_stt = skip_you_stt.unwrap_or(false);
    let state = app.state::<AppState>();
    // NexQ Plus: capture changes run one at a time. A restart or a stop of the
    // capture waits for this swap, so the capture it belongs to stays the running one.
    let _capture_change = state.audio_tasks.lock().await;

    let capturing = state
        .audio
        .lock()
        .map(|guard| guard.as_ref().is_some_and(|mgr| mgr.is_capturing()))
        .unwrap_or(false);
    // An in-person meeting runs no "You" provider; Web Speech runs in the frontend.
    if !capturing || (side == Side::You && skip_you_stt) || uses_frontend_stt(&config) {
        return Ok(false);
    }
    let (role, label) = match side {
        Side::You => ("You", "You"),
        Side::Them => (if skip_you_stt { "Room" } else { "Them" }, "Them"),
    };

    // NexQ Plus: the replacement is built from what the capture runs with (the
    // other side's language, the ids its lines continue under).
    let shared_language = get_stt_language(&state);
    let other_transcribed = !(side == Side::Them && skip_you_stt);
    let plan = RUNNING_CAPTURE.lock().ok().and_then(|running| {
        swap_plan(running.as_ref()?, side, &config, &shared_language, other_transcribed)
    });
    let Some(plan) = plan else {
        return Ok(false);
    };

    let created = create_stt_provider_for_party(
        &config, &plan.other, &state, &app, side, role, &plan.session_prefix,
    )
    .await;
    let running_refusal = state
        .auto_refusals
        .lock()
        .ok()
        .and_then(|refusals| refusals[side.index()].clone());
    let Some(provider) = resolve_language_swap(created, running_refusal.as_deref(), false)? else {
        return Ok(false);
    };
    let Some(sender) = state.side_swap.lock().ok().and_then(|slot| slot.clone()) else {
        return Ok(false);
    };
    let muted_flag = match side {
        Side::You => state.you_muted.clone(),
        Side::Them => state.them_muted.clone(),
    };

    crate::stt::emit_stt_debug(&app, "info", "stt", &format!(
        "[{}] Language change: restarting only this side's STT ({})",
        role, config.stt_provider
    ));
    let answer = side_swap::swap_side_provider(&sender, side, provider, &muted_flag)
        .await
        .into_answer();
    match &answer {
        Ok(true) => {
            log::info!("'{}' STT restarted for a language change", label);
            crate::stt::emit_stt_debug(&app, "info", "stt",
                &format!("'{}' STT restarted: {}", label, config.stt_provider));
            note_swapped_side(side, &config, &shared_language);
            // The overlay's language picker waits for a status of this side. Not every
            // provider reports one when it starts (the batch ones don't), so say it here.
            let _ = app.emit(
                "stt_connection_status",
                swap_status_event(&config.stt_provider, label, muted_flag.load(Ordering::Relaxed)),
            );
        }
        // The side has no STT now: the caller restarts the whole capture.
        Err(e) => {
            log::warn!("Failed to restart '{}' STT: {}", label, e);
            crate::stt::emit_stt_debug(&app, "error", "stt",
                &format!("'{}' STT failed to restart ({}): restarting the capture", label, e));
        }
        Ok(false) => {}
    }
    answer
}

/// The `stt_connection_status` event for a side whose provider was just swapped:
/// connected, or paused while the side is muted (a muted provider holds no stream).
/// `label` is "You" or "Them" ("Them" is the room in an in-person meeting).
fn swap_status_event(provider: &str, label: &str, muted: bool) -> serde_json::Value {
    serde_json::json!({
        "provider": provider,
        "party": label,
        "status": if muted { "paused" } else { "connected" },
        "message": "Restarted for a language change",
    })
}

/// Get the current mute status for both sources.
#[command]
pub async fn get_mute_status(app: AppHandle) -> Result<String, String> {
    let state = app.state::<AppState>();
    let status = serde_json::json!({
        "you": state.you_muted.load(Ordering::Relaxed),
        "them": state.them_muted.load(Ordering::Relaxed),
    });
    serde_json::to_string(&status).map_err(|e| format!("Failed to serialize: {}", e))
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::{NativeTranslationConfig, PartyAudioConfig, PartyRole};
    use crate::stt::provider::{TranscriptResult, TurnSignal};
    use crate::stt::soniox::SonioxTranslation;
    use std::sync::{Arc, Mutex};

    /// "Them" on `provider`, with its own language or none.
    fn speaking(provider: &str, language: Option<&str>) -> PartyAudioConfig {
        PartyAudioConfig {
            role: PartyRole::Them,
            device_id: "default".into(),
            is_input_device: false,
            stt_provider: provider.into(),
            local_model_id: None,
            language: language.map(str::to_string),
            native_translation: None,
        }
    }

    #[tokio::test]
    async fn stop_waits_for_the_provider_tail_and_transcript_forwarder() {
        let (tx, mut rx) = mpsc::channel(4);
        let forwarded = Arc::new(std::sync::Mutex::new(Vec::new()));
        let output = forwarded.clone();
        let forwarder = tokio::spawn(async move {
            while let Some(text) = rx.recv().await { output.lock().unwrap().push(text); }
            output.lock().unwrap().push("flushed");
        });
        let producer = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            tx.send("last sentence").await.unwrap();
        });
        let mut tasks = vec![forwarder, producer];
        assert!(finish_capture_tasks(&mut tasks, std::time::Duration::from_secs(1)).await);
        assert!(tasks.is_empty());
        assert_eq!(*forwarded.lock().unwrap(), ["last sentence", "flushed"]);
    }

    #[tokio::test]
    async fn stop_aborts_all_stalled_tasks_with_one_shared_deadline() {
        let mut tasks: Vec<_> = (0..3).map(|_| tokio::spawn(std::future::pending::<()>())).collect();
        let aborts: Vec<_> = tasks.iter().map(|task| task.abort_handle()).collect();
        let started = tokio::time::Instant::now();
        assert!(!finish_capture_tasks(&mut tasks, std::time::Duration::from_millis(30)).await);
        assert!(started.elapsed() < std::time::Duration::from_millis(200));
        assert!(aborts.iter().all(|task| task.is_finished()));
        assert!(tasks.is_empty());
    }

    #[test]
    fn old_capture_requests_cannot_touch_a_new_meeting() {
        let state = AppState::new();
        assert!(!capture_meeting_matches(&state, Some("old")).unwrap());
        *state.live_meeting.lock().unwrap() = Some(crate::state::LiveMeeting { id: "new".into(), start_ms: 0 });
        assert!(!capture_meeting_matches(&state, Some("old")).unwrap());
        assert!(capture_meeting_matches(&state, Some("new")).unwrap());
        assert!(capture_meeting_matches(&state, None).unwrap());
    }

    /// AppState with a router at `global` and translation target `target`.
    fn state(global: &str, target: Option<&str>) -> AppState {
        let mut state = AppState::new();
        let mut router = crate::stt::STTRouter::new();
        router.set_language(global);
        state.stt = Some(Arc::new(Mutex::new(router)));
        if let Some(target) = target {
            let mut translation = crate::translation::TranslationRouter::new();
            translation.set_default_target_lang(target.to_string());
            state.translation = Some(Arc::new(Mutex::new(translation)));
        }
        state
    }

    #[test]
    fn a_party_uses_its_own_language_else_the_global_one() {
        let state = state("ja-JP", None);
        let shared = get_stt_language(&state);
        assert_eq!(speaking("deepgram", Some("zh-CN")).effective_language(&shared), "zh-CN");
        assert_eq!(speaking("deepgram", Some("auto")).effective_language(&shared), "auto");
        assert_eq!(speaking("deepgram", None).effective_language(&shared), "ja-JP");
        // An empty pick is no pick.
        assert_eq!(speaking("deepgram", Some("  ")).effective_language(&shared), "ja-JP");
    }

    #[test]
    fn older_configs_without_the_new_fields_still_parse() {
        let old = r#"{"role":"You","device_id":"default","is_input_device":true,"stt_provider":"web_speech"}"#;
        let cfg: PartyAudioConfig = serde_json::from_str(old).unwrap();
        assert_eq!(cfg.language, None);
        assert_eq!(cfg.native_translation, None);
        let new = r#"{"role":"Them","device_id":"x","is_input_device":false,"stt_provider":"soniox",
                      "language":"auto","native_translation":{"mode":"one_way","target_language":"zh-CN"}}"#;
        let cfg: PartyAudioConfig = serde_json::from_str(new).unwrap();
        assert_eq!(cfg.language.as_deref(), Some("auto"));
        assert!(cfg.native_translation.unwrap().is_one_way());
    }

    fn one_way(code: &str, soniox: &str) -> SonioxTranslation {
        SonioxTranslation::OneWay { code: code.into(), soniox: soniox.into() }
    }

    #[test]
    fn soniox_translates_only_when_on_and_follows_the_translation_target() {
        let state = state("en-US", Some("zh-CN"));
        let mut them = speaking("soniox", Some("en-US"));
        assert_eq!(soniox_translation(&them, &state), SonioxTranslation::Off);

        them.native_translation = Some(NativeTranslationConfig { mode: "one_way".into(), ..Default::default() });
        assert_eq!(soniox_translation(&them, &state), one_way("zh-CN", "zh"));

        them.native_translation = Some(NativeTranslationConfig {
            mode: "one_way".into(),
            target_language: Some("ja".into()),
            ..Default::default()
        });
        assert_eq!(soniox_translation(&them, &state), one_way("ja", "ja"));

        them.native_translation = Some(NativeTranslationConfig { mode: "off".into(), target_language: Some("ja".into()), ..Default::default() });
        assert_eq!(soniox_translation(&them, &state), SonioxTranslation::Off);

        // No translation router and no target of its own: nothing to translate into.
        let bare = super::tests::state("en-US", None);
        them.native_translation = Some(NativeTranslationConfig { mode: "one_way".into(), ..Default::default() });
        assert_eq!(soniox_translation(&them, &bare), SonioxTranslation::Off);
    }

    #[test]
    fn soniox_two_way_needs_two_different_languages() {
        let state = state("en-US", Some("ja"));
        let mut them = speaking("soniox", Some("auto"));
        let pair = |a: Option<&str>, b: Option<&str>| {
            Some(NativeTranslationConfig {
                mode: "two_way".into(),
                // The one-way target stays saved while two-way is on; it plays no part.
                target_language: Some("ja".into()),
                language_a: a.map(str::to_string),
                language_b: b.map(str::to_string),
            })
        };
        them.native_translation = pair(Some("zh-CN"), Some(" en-US "));
        assert_eq!(
            soniox_translation(&them, &state),
            SonioxTranslation::TwoWay { a_code: "zh-CN".into(), a: "zh".into(), b_code: "en-US".into(), b: "en".into() }
        );
        // A side missing, the same language twice, or a code Soniox can't take: no translation.
        for (a, b) in [
            (Some("zh-CN"), None),
            (None, Some("en")),
            (Some("zh-CN"), Some("  ")),
            (Some("zh-CN"), Some("zh-TW")),
            (Some("yue"), Some("en")),
            (Some("auto"), Some("en")),
        ] {
            them.native_translation = pair(a, b);
            assert_eq!(soniox_translation(&them, &state), SonioxTranslation::Off, "{a:?} {b:?}");
        }
    }

    #[test]
    fn soniox_and_whisper_cpp_segment_their_own_lines() {
        assert!(self_segmenting("soniox"));
        assert!(self_segmenting("whisper_cpp"));
        assert!(!self_segmenting("deepgram"));
        assert!(!self_segmenting("openai_compat"));
        assert_eq!(segment_prefix(Side::Them, "ab12"), "them_ab12_");
        assert_eq!(segment_prefix(Side::You, "ab12"), "you_ab12_");
        assert_eq!((side_speaker(Side::You), side_speaker(Side::Them)), ("User", "Them"));
        assert_eq!((side_label(Side::You), side_label(Side::Them)), ("You", "Them"));
    }

    /// A line as Soniox sends it: its own sentence id, maybe a diarization tag.
    fn engine_line(segment_id: Option<&str>, is_final: bool) -> TranscriptResult {
        TranscriptResult {
            text: "Hi".into(),
            is_final,
            confidence: 0.9,
            timestamp_ms: 42,
            speaker: None,
            language: Some("en".into()),
            segment_id: segment_id.map(str::to_string),
            duration_ms: Some(300),
            speaker_tag: Some("S2".into()),
            turn: None,
        }
    }

    #[test]
    fn direct_lines_carry_the_diarization_tag() {
        let seg = result_segment_json("them_ab12_sx1_1", "Them", &engine_line(Some("sx1_1"), true));
        assert_eq!(seg["id"], "them_ab12_sx1_1");
        assert_eq!(seg["speaker"], "Them");
        assert_eq!(seg["speaker_tag"], "S2");
        assert_eq!(seg["speaker_id"], "speaker_1");
        assert_eq!(seg["is_final"], true);
    }

    /// The id a Soniox line is forwarded under is the prefix its provider was
    /// given plus the sentence id, so a translation finds its line: for the
    /// first provider of a side and for one swapped in for a language change.
    #[test]
    fn an_engines_own_ids_are_forwarded_under_the_prefix_its_provider_was_given() {
        let mut counter = 0;
        let line = engine_line(Some("sx1_1"), false);
        assert_eq!(direct_line_id(Side::Them, "ab12", 0, &line, &mut counter), "them_ab12_sx1_1");
        assert_eq!(
            direct_line_id(Side::Them, "ab12", 0, &line, &mut counter),
            format!("{}sx1_1", segment_prefix(Side::Them, "ab12"))
        );

        // The replacement numbers its sentences from 1 again: its generation keeps the ids apart.
        let running = running(speaking("deepgram", None), speaking("soniox", Some("en-US")), "en-US");
        let mut japanese = speaking("soniox", Some("ja-JP"));
        let plan = swap_plan(&running, Side::Them, &japanese, "en-US", true).unwrap();
        assert_eq!(plan.session_prefix, "ab12s1");
        assert_eq!(
            direct_line_id(Side::Them, "ab12", 1, &line, &mut counter),
            format!("{}sx1_1", segment_prefix(Side::Them, &plan.session_prefix))
        );
        assert_eq!(direct_line_id(Side::Them, "ab12", 1, &line, &mut counter), "them_ab12s1_sx1_1");
        // The next swap of that side is the next generation.
        running.signals[Side::Them.index()].swapped();
        japanese.language = Some("ko-KR".into());
        assert_eq!(swap_plan(&running, Side::Them, &japanese, "en-US", true).unwrap().session_prefix, "ab12s2");
        // The other side's generation is its own.
        let you = speaking("deepgram", Some("fr-FR"));
        assert_eq!(swap_plan(&running, Side::You, &you, "en-US", true).unwrap().session_prefix, "ab12s1");
        assert_eq!(counter, 0, "an engine with its own ids never uses the counter");
    }

    fn tagged(generation: u32, segment_id: Option<&str>, text: &str, is_final: bool, at: u64) -> Tagged {
        Tagged {
            generation,
            result: TranscriptResult {
                text: text.into(),
                is_final,
                confidence: 0.9,
                timestamp_ms: 1_800_000_000_000 + at,
                speaker: Some("Them".into()),
                language: None,
                segment_id: segment_id.map(str::to_string),
                duration_ms: Some(400),
                speaker_tag: None,
                turn: None,
            },
        }
    }

    /// Everything `provider` sends on one side, as the lines that go out: (id, text, final).
    async fn lines_of(provider: &str, sent: Vec<Tagged>, swap_before: Option<usize>) -> Vec<(String, String, bool)> {
        let (tx, mut rx) = mpsc::channel::<Tagged>(64);
        let signal = SwapSignal::default();
        let threshold = std::sync::atomic::AtomicU64::new(3_000);
        for (i, result) in sent.into_iter().enumerate() {
            if swap_before == Some(i) {
                signal.swapped();
            }
            tx.send(result).await.unwrap();
        }
        drop(tx);
        let mut lines = Vec::new();
        pump_party_lines(Side::Them, provider, "ab12", &mut rx, &signal, &threshold, |line| {
            assert_eq!(line.segment["id"], line.id.as_str());
            assert_eq!(line.segment["speaker"], "Them");
            assert_eq!(line.segment["is_final"], line.is_final);
            lines.push((line.id, line.text, line.is_final));
        })
        .await;
        lines
    }

    fn line(id: &str, text: &str, is_final: bool) -> (String, String, bool) {
        (id.to_string(), text.to_string(), is_final)
    }

    /// Soniox cuts its own lines: they go out one for one under its sentence
    /// ids, and a provider swapped in for a language change gets its own ids.
    #[tokio::test]
    async fn a_self_segmenting_engines_lines_go_out_as_they_come() {
        let sent = vec![
            tagged(0, Some("sx1_1"), "How are", false, 0),
            tagged(0, Some("sx1_1"), "How are you?", true, 0),
            tagged(0, Some("sx1_2"), "And the", false, 5_000),
            // The language changed here: the open line ends, the new engine counts from 1.
            tagged(1, Some("sx1_1"), "お元気ですか", false, 9_000),
            tagged(1, Some("sx1_1"), "お元気ですか。", true, 9_000),
        ];
        assert_eq!(
            lines_of("soniox", sent, Some(3)).await,
            vec![
                line("them_ab12_sx1_1", "How are", false),
                line("them_ab12_sx1_1", "How are you?", true),
                line("them_ab12_sx1_2", "And the", false),
                line("them_ab12_sx1_2", "And the", true),
                line("them_ab12s1_sx1_1", "お元気ですか", false),
                line("them_ab12s1_sx1_1", "お元気ですか。", true),
            ]
        );
    }

    /// The other engines' finals are merged into paragraphs; speech after a
    /// pause is a new line, and what is left at the end is flushed.
    #[tokio::test]
    async fn other_engines_lines_are_merged_into_paragraphs() {
        let sent = vec![
            tagged(0, None, "我们今天", true, 0),
            tagged(0, None, "讨论预算。", true, 600),
            tagged(0, None, "Next point", false, 9_000),
        ];
        assert_eq!(
            lines_of("openai_compat", sent, None).await,
            vec![
                line("them_ab12_acc_1", "我们今天", true),
                line("them_ab12_acc_1", "我们今天讨论预算。", true),
                line("them_ab12_acc_2", "Next point", false),
                // Meeting end: the paragraph the accumulator still holds.
                line("them_ab12_acc_1", "我们今天讨论预算。", true),
            ]
        );
    }

    #[test]
    fn a_line_without_an_engine_id_is_numbered() {
        let mut counter = 0;
        let interim = engine_line(None, false);
        let fin = engine_line(None, true);
        assert_eq!(direct_line_id(Side::You, "ab12", 0, &interim, &mut counter), "you_ab12_1");
        assert_eq!(direct_line_id(Side::You, "ab12", 0, &fin, &mut counter), "you_ab12_1");
        assert_eq!(direct_line_id(Side::You, "ab12", 0, &interim, &mut counter), "you_ab12_2");
    }

    /// The capture `start_capture_per_party` leaves running, session "ab12".
    fn running(you: PartyAudioConfig, them: PartyAudioConfig, shared: &str) -> RunningCapture {
        RunningCapture {
            session_prefix: "ab12".into(),
            languages: [you.effective_language(shared), them.effective_language(shared)],
            parties: [you, them],
            signals: [Arc::new(SwapSignal::default()), Arc::new(SwapSignal::default())],
        }
    }

    #[test]
    fn a_language_change_restarts_one_side_only_when_nothing_else_changed() {
        let running = running(speaking("deepgram", Some("en-US")), speaking("openai_compat", None), "zh-CN");
        let mut them = speaking("openai_compat", Some("ja-JP"));
        let plan = swap_plan(&running, Side::Them, &them, "zh-CN", true).unwrap();
        // The replacement is told about the other side as it runs.
        assert_eq!(plan.other.stt_provider, "deepgram");
        assert_eq!(plan.other.language.as_deref(), Some("en-US"));
        // Another engine or device is more than a language: the whole capture restarts.
        them.stt_provider = "soniox".into();
        assert!(swap_plan(&running, Side::Them, &them, "zh-CN", true).is_none());
        them.stt_provider = "openai_compat".into();
        them.device_id = "Speakers (USB)".into();
        assert!(swap_plan(&running, Side::Them, &them, "zh-CN", true).is_none());
        them.device_id = "default".into();
        them.is_input_device = true;
        assert!(swap_plan(&running, Side::Them, &them, "zh-CN", true).is_none());
        // A model or the engine's own translation may change with the language.
        them.is_input_device = false;
        them.local_model_id = Some("small".into());
        them.native_translation = Some(NativeTranslationConfig { mode: "one_way".into(), ..Default::default() });
        assert!(swap_plan(&running, Side::Them, &them, "zh-CN", true).is_some());
    }

    /// Soniox on Auto-detect is hinted the other side's language: when that
    /// changes, its session has to restart too, so the whole capture does.
    #[test]
    fn a_language_change_that_soniox_on_the_other_side_was_hinted_restarts_both() {
        let running = running(speaking("soniox", Some("auto")), speaking("deepgram", Some("en-US")), "en-US");
        let japanese = speaking("deepgram", Some("ja-JP"));
        assert!(swap_plan(&running, Side::Them, &japanese, "en-US", true).is_none());
        // Same language, another region: the hint ("en") stays.
        let british = speaking("deepgram", Some("en-GB"));
        assert!(swap_plan(&running, Side::Them, &british, "en-US", true).is_some());
        // Back to the shared language it started in: no change either.
        assert!(swap_plan(&running, Side::Them, &speaking("deepgram", None), "en-US", true).is_some());
        // An in-person meeting runs no engine for "You": nothing there to restart.
        assert!(swap_plan(&running, Side::Them, &japanese, "en-US", false).is_some());

        // Soniox with a language of its own, or another engine on Auto-detect, isn't hinted.
        for you in [speaking("soniox", Some("zh-CN")), speaking("groq_whisper", Some("auto"))] {
            let fixed = super::tests::running(you, speaking("deepgram", Some("en-US")), "en-US");
            assert!(swap_plan(&fixed, Side::Them, &japanese, "en-US", true).is_some());
        }
        // Soniox follows the shared language when that is Auto-detect.
        let shared_auto = super::tests::running(speaking("soniox", None), speaking("deepgram", Some("en-US")), "auto");
        assert!(swap_plan(&shared_auto, Side::Them, &japanese, "auto", true).is_none());
        // Soniox's own language change is its own restart, whatever it is hinted.
        let soniox = speaking("soniox", Some("ko-KR"));
        assert!(swap_plan(&running, Side::You, &soniox, "en-US", true).is_some());
    }

    #[test]
    fn a_swapped_side_is_remembered_with_its_new_language() {
        // `note_swapped_side` writes the same fields of the shared record.
        let mut running = running(speaking("soniox", Some("auto")), speaking("deepgram", None), "en-US");
        assert_eq!(running.languages, ["auto".to_string(), "en-US".to_string()]);
        let japanese = speaking("deepgram", Some("ja-JP"));
        running.languages[Side::Them.index()] = japanese.effective_language("en-US");
        running.parties[Side::Them.index()] = japanese;
        // Going back to English now changes what Soniox was hinted.
        assert!(swap_plan(&running, Side::Them, &speaking("deepgram", None), "en-US", true).is_none());
    }

    /// NexQ Plus engines and Auto-detect: beyond the shared table.
    #[test]
    fn the_forks_engines_detect_the_language_and_sense_voice_does_too() {
        use crate::stt::provider::STTProviderType as P;
        assert!(supports_auto_language(&P::Soniox, ""));
        assert!(supports_auto_language(&P::OpenAICompat, ""));
        assert!(check_auto_language("auto", &P::Soniox, None, None, "Them").is_ok());
        assert!(check_auto_language("auto", &P::OpenAICompat, None, None, "You").is_ok());
        // Among the Sherpa-ONNX models only SenseVoice detects.
        assert!(check_auto_language("auto", &P::SherpaOnnx, Some("sense-voice-small"), None, "Them").is_ok());
        for model in [None, Some("streaming-zipformer-en-20M"), Some("streaming-zipformer-multi")] {
            let refusal = check_auto_language("auto", &P::SherpaOnnx, model, None, "Them").unwrap_err();
            assert!(refusal.starts_with(&format!("{AUTO_DETECT_REFUSAL} Sherpa-ONNX, used for Them.")), "{refusal}");
        }
        // With a language picked, none of them is asked.
        assert!(check_auto_language("zh-CN", &P::SherpaOnnx, None, None, "Them").is_ok());
    }

    fn output(turn: Option<TurnSignal>) -> AccumulatorOutput {
        AccumulatorOutput {
            id: "acc_1".into(),
            text: "What would you do?".into(),
            speaker: "Them".into(),
            speaker_tag: None,
            timestamp_ms: 5,
            is_final: true,
            confidence: 1.0,
            turn,
        }
    }

    #[test]
    fn a_line_carries_its_turn_signal_only_when_it_has_one() {
        let seg = accumulator_segment_json("them_x_acc_1", "Them", &output(Some(TurnSignal::End)));
        assert_eq!(seg["turn"], "end");
        assert_eq!(seg["text"], "What would you do?");
        let plain = accumulator_segment_json("them_x_acc_1", "Them", &output(None));
        assert!(plain.get("turn").is_none());
    }

    #[test]
    fn automatic_language_detection_is_limited_to_compatible_providers_and_models() {
        use crate::stt::provider::STTProviderType;

        // The same table src/lib/sttLanguages.test.ts reads.
        let table: serde_json::Value =
            serde_json::from_str(include_str!("../../../src/lib/autoDetectCases.json")).unwrap();
        // The refusal wording is the same table's too.
        assert_eq!(AUTO_DETECT_REFUSAL, table["refusalPrefix"].as_str().unwrap());
        assert_eq!(AUTO_DETECT_ADVICE, table["advice"].as_str().unwrap());
        assert_eq!(AUTO_DETECT_WHISPER_ADVICE, table["whisperAdvice"].as_str().unwrap());
        for (model, label) in table["deepgramLabels"].as_object().unwrap() {
            assert_eq!(deepgram_model_label(model), label.as_str().unwrap(), "{model}");
        }
        for (model, label) in table["whisperLabels"].as_object().unwrap() {
            assert_eq!(whisper_model_label(model), label.as_str().unwrap(), "{model}");
        }
        let cases = table["cases"].as_array().unwrap();
        assert!(cases.len() > 20);
        for case in cases {
            let provider = case["provider"].as_str().unwrap();
            let model = case["model"].as_str().unwrap();
            let expected = case["supported"].as_bool().unwrap();
            let kind = STTProviderType::from_str(provider).expect(provider);
            assert_eq!(supports_auto_language(&kind, model), expected, "{provider} / {model}");
            let result = validate_auto_language_provider(&kind, model, "You");
            assert_eq!(result.is_ok(), expected, "{provider} / {model}");
            if let Err(message) = result {
                let name = case["name"].as_str().unwrap();
                assert!(
                    message.starts_with(&format!("{AUTO_DETECT_REFUSAL} {name}, used for You. ")),
                    "{message}"
                );
            }
        }

        // Advice never points a failing Whisper model at "Whisper" in general.
        let whisper = validate_auto_language_provider(&STTProviderType::WhisperCpp, "distil-large-v3", "Them")
            .unwrap_err();
        assert!(whisper.ends_with("Choose a multilingual Whisper model (Tiny, Base, Small, Medium or Large v3 Turbo), or pick a language."), "{whisper}");
        let web = validate_auto_language_provider(&STTProviderType::WebSpeech, "", "You").unwrap_err();
        assert!(web.ends_with("Choose Deepgram Nova-3, Parakeet TDT 0.6B v3, Groq Whisper or Whisper API for that side, or pick a language."), "{web}");
        assert_eq!(resolve_parakeet_model_id("small"), "parakeet-tdt-0.6b-v3-int8");
        assert_eq!(
            resolve_parakeet_model_id("parakeet-tdt-ctc-110m-int8"),
            "parakeet-tdt-ctc-110m-int8"
        );
    }

    #[test]
    fn every_auto_detect_refusal_starts_with_the_shared_prefix() {
        for message in [
            validate_auto_language_provider(&crate::stt::provider::STTProviderType::AzureSpeech, "", "You")
                .unwrap_err(),
            whisper_auto_refusal("ggml-base.en.bin", "Them"),
            parakeet_ctc_auto_refusal("You"),
        ] {
            assert!(message.starts_with(AUTO_DETECT_REFUSAL), "{message}");
        }
        assert!(whisper_auto_refusal("ggml-base.en.bin", "Them").contains("the base.en Whisper model, used for Them"));
    }

    /// What `create_stt_provider_for_party` checks for a side before it creates the provider.
    fn auto_check(side: &PartyAudioConfig, shared: &str, role: &str) -> Result<(), String> {
        let provider = crate::stt::provider::STTProviderType::from_str(&side.stt_provider).unwrap();
        check_auto_language(
            &side.effective_language(shared),
            &provider,
            side.local_model_id.as_deref(),
            Some("nova-3"),
            role,
        )
    }

    #[test]
    fn auto_detect_is_checked_with_each_sides_own_language() {
        let mut you = party("web_speech", "default", true);
        let mut them = party("web_speech", "default", false);
        // Shared language is Auto-detect, no side has its own: both are refused.
        assert!(auto_check(&you, "auto", "You").unwrap_err().ends_with(AUTO_DETECT_ADVICE));
        assert!(auto_check(&them, "auto", "Them").is_err());
        // "You" speaks English: no Auto-detect, so no refusal for You; Them still is.
        you.language = Some("en-US".into());
        assert!(auto_check(&you, "auto", "You").is_ok());
        assert!(auto_check(&them, "auto", "Them").unwrap_err().contains("used for Them."));
        // A fixed shared language with Auto-detect on one side only refuses that side.
        them.language = Some("auto".into());
        assert!(auto_check(&you, "es-ES", "You").is_ok());
        assert!(auto_check(&them, "es-ES", "Room").unwrap_err().contains("used for Room."));
        // A provider that can detect the language passes with Auto-detect on its side.
        them.stt_provider = "groq_whisper".into();
        assert!(auto_check(&them, "es-ES", "Them").is_ok());
        // The refusal for one side is the kind a swap tolerates or reports, per side.
        let refusal = auto_check(&party("web_speech", "d", true), "auto", "You").unwrap_err();
        let side = resolve_side::<u8>(Err(refusal), false, None, false).unwrap();
        assert!(side.provider.is_none() && side.announce);
    }

    #[test]
    fn each_side_resolves_its_own_language() {
        let mut you = party("deepgram", "default", true);
        let mut them = party("deepgram", "default", false);
        you.language = Some("en-US".into());
        them.language = Some("es-ES".into());
        assert_eq!(you.effective_language("fr-FR"), "en-US");
        assert_eq!(them.effective_language("fr-FR"), "es-ES");
        // A saved config from before this setting has none: both follow the shared language.
        you.language = None;
        assert_eq!(you.effective_language("fr-FR"), "fr-FR");
    }

    #[test]
    fn a_provider_that_works_passes_through() {
        let side = resolve_side(Ok(Some(1)), false, None, false).unwrap();
        assert_eq!((side.provider, side.refusal, side.announce), (Some(1), None, false));
    }

    #[test]
    fn a_refusal_at_a_start_goes_without_stt_and_is_announced() {
        let refusal = parakeet_ctc_auto_refusal("You");
        let side = resolve_side::<u8>(Err(refusal.clone()), false, None, false).unwrap();
        assert_eq!((side.provider, side.refusal, side.announce), (None, Some(refusal), true));
    }

    #[test]
    fn a_swap_tolerates_the_refusal_a_side_already_runs_under_without_a_word() {
        let refusal = parakeet_ctc_auto_refusal("You");
        let side = resolve_side::<u8>(Err(refusal.clone()), true, Some(&refusal), false).unwrap();
        assert_eq!((side.provider, side.refusal.as_deref(), side.announce), (None, Some(refusal.as_str()), false));
    }

    #[test]
    fn a_swap_with_a_new_refusal_is_an_error() {
        let old = parakeet_ctc_auto_refusal("You");
        let new = whisper_auto_refusal("distil-large-v3", "You");
        assert_eq!(resolve_side::<u8>(Err(new.clone()), true, Some(&old), false).err(), Some(new.clone()));
        assert_eq!(resolve_side::<u8>(Err(new.clone()), true, None, false).err(), Some(new));
    }

    #[test]
    fn a_swapped_side_reports_a_status_the_overlay_picker_clears_on() {
        let event = swap_status_event("deepgram", "Them", false);
        assert_eq!(event["party"], "Them");
        assert_eq!(event["status"], "connected");
        assert_eq!(event["provider"], "deepgram");
        assert_eq!(swap_status_event("deepgram", "You", true)["status"], "paused");
    }

    #[test]
    fn a_language_change_restarts_a_side_that_still_has_a_provider() {
        assert_eq!(resolve_language_swap(Ok(Some(7u8)), None, false), Ok(Some(7)));
        // Provider and model are the same, only the language changed: Auto-detect on a
        // provider that can't do it is refused with that side's own words.
        let mut them = party("azure_speech", "default", false);
        them.language = Some("auto".into());
        let refusal = auto_check(&them, "en-US", "Them").unwrap_err();
        assert!(refusal.starts_with(AUTO_DETECT_REFUSAL));
        assert_eq!(resolve_language_swap::<u8>(Err(refusal.clone()), None, false), Err(refusal.clone()));
        // The side's own language wins over a shared Auto-detect it was not on.
        them.language = Some("es-ES".into());
        assert!(auto_check(&them, "auto", "Them").is_ok());
    }

    #[test]
    fn a_language_change_goes_on_to_a_full_swap_when_the_side_has_no_provider() {
        // No model, Web Speech: nothing for Rust to restart.
        assert_eq!(resolve_language_swap::<u8>(Ok(None), None, false), Ok(None));
        // The refusal the side already runs under is tolerated silently, like in a full swap.
        let refusal = parakeet_ctc_auto_refusal("Them");
        assert_eq!(resolve_language_swap::<u8>(Err(refusal.clone()), Some(&refusal), false), Ok(None));
        // Any other error stays an error.
        assert!(resolve_language_swap::<u8>(Err("Deepgram key missing".into()), None, false).is_err());
    }

    #[test]
    fn a_language_change_into_a_new_refusal_is_an_error_before_anything_stops() {
        let old = parakeet_ctc_auto_refusal("You");
        let new = whisper_auto_refusal("distil-large-v3", "You");
        assert_eq!(resolve_language_swap::<u8>(Err(new.clone()), Some(&old), false), Err(new.clone()));
        assert_eq!(resolve_language_swap::<u8>(Err(new.clone()), None, false), Err(new));
    }

    #[test]
    fn a_swap_tolerates_a_refusal_for_a_web_speech_side_the_frontend_already_stopped() {
        let refusal = auto_refusal("Web Speech", "You", AUTO_DETECT_ADVICE);
        // Not the side's running refusal, but its frontend told the user: not an error.
        let side = resolve_side::<u8>(Err(refusal.clone()), true, None, true).unwrap();
        assert_eq!((side.provider, side.refusal.as_deref(), side.announce), (None, Some(refusal.as_str()), false));
        // At a start it is still announced.
        let started = resolve_side::<u8>(Err(refusal.clone()), false, None, true).unwrap();
        assert!(started.announce);
        // Other errors stay errors.
        assert!(resolve_side::<u8>(Err("Deepgram key missing".into()), true, None, true).is_err());

        // A later swap changing the other side still goes through, with the same refusal remembered.
        let you = Err(refusal.clone());
        let them: Result<Option<u8>, String> = Ok(None);
        let (you_side, them_side) =
            resolve_sides::<u8, u8>(you, them, true, &[Some(refusal.clone()), None], [true, false]).unwrap();
        assert_eq!(you_side.refusal.as_deref(), Some(refusal.as_str()));
        assert!(!you_side.announce && them_side.refusal.is_none());

        // Another provider's refusal on a swap is still an error.
        let azure = auto_refusal("Azure Speech", "You", AUTO_DETECT_ADVICE);
        assert!(resolve_side::<u8>(Err(azure), true, None, false).is_err());
    }

    #[test]
    fn only_web_speech_on_a_microphone_is_frontend_stt() {
        assert!(uses_frontend_stt(&party("web_speech", "default", true)));
        assert!(!uses_frontend_stt(&party("web_speech", "Speakers", false)));
        assert!(!uses_frontend_stt(&party("windows_native", "default", true)));
    }

    #[test]
    fn the_auto_detect_check_looks_at_the_sides_model() {
        use crate::stt::provider::STTProviderType as P;
        // Not Auto-detect: never a refusal, whatever the provider.
        assert!(check_auto_language("es-ES", &P::WebSpeech, None, None, "You").is_ok());
        // Deepgram depends on the shared model, Whisper and Parakeet on the side's own.
        assert!(check_auto_language("auto", &P::Deepgram, None, Some("nova-3"), "Them").is_ok());
        assert!(check_auto_language("AUTO", &P::Deepgram, None, Some("flux-general-en"), "Them").is_err());
        assert!(check_auto_language("auto", &P::WhisperCpp, Some("base.en"), None, "You").is_err());
        assert!(check_auto_language("auto", &P::WhisperCpp, Some("small"), None, "You").is_ok());
        assert!(check_auto_language("auto", &P::ParakeetTdt, None, None, "Room").is_ok());
        assert!(check_auto_language("auto", &P::ParakeetTdt, Some("parakeet-tdt-ctc-110m-int8"), None, "Room")
            .unwrap_err()
            .contains("used for Room."));
    }

    #[test]
    fn other_errors_stay_errors_at_a_start_and_in_a_swap() {
        for was_capturing in [false, true] {
            assert!(resolve_side::<u8>(Err("Deepgram key missing".into()), was_capturing, None, false).is_err());
        }
    }

    #[test]
    fn a_swap_refused_for_both_sides_names_both_and_a_real_error_wins() {
        let you = parakeet_ctc_auto_refusal("You");
        let them = auto_refusal("Azure Speech", "Them", AUTO_DETECT_ADVICE);
        let none = [None, None];
        let both = resolve_sides::<u8, u8>(Err(you.clone()), Err(them.clone()), true, &none, [false; 2]).err().unwrap();
        assert_eq!(both, format!("{you} {them}"));
        // The side already running without STT isn't part of it: only the new refusal is reported.
        let known = [Some(you.clone()), None];
        assert_eq!(resolve_sides::<u8, u8>(Err(you.clone()), Err(them.clone()), true, &known, [false; 2]).err(), Some(them.clone()));
        // A real error is reported rather than a refusal.
        assert_eq!(
            resolve_sides::<u8, u8>(Err(you), Err("Deepgram key missing".into()), true, &none, [false; 2]).err(),
            Some("Deepgram key missing".to_string())
        );
    }

    #[test]
    fn the_start_toast_is_one_short_sentence_per_announced_side() {
        let you = auto_refusal("Web Speech", "You", AUTO_DETECT_ADVICE);
        let room = whisper_auto_refusal("ggml-base.en.bin", "Room");
        assert_eq!(
            start_warnings(&[("You", Some(you.clone())), ("Room", None)]).unwrap(),
            "You won't be transcribed: Web Speech can't detect the language. Change it in Audio & Devices or pick a language."
        );
        let both = start_warnings(&[("You", Some(you)), ("Room", Some(room))]).unwrap();
        assert!(both.contains("Room won't be transcribed: the base.en Whisper model can't detect the language."), "{both}");
        assert!(start_warnings(&[("You", None), ("Them", None)]).is_none());
        for sentence in both.split(". ") {
            assert!(sentence.split_whitespace().count() <= 22, "{sentence}");
        }
    }

    #[test]
    fn whisper_auto_support_includes_multilingual_models_only() {
        assert!(is_multilingual_whisper_model("tiny"));
        assert!(is_multilingual_whisper_model("ggml-small.bin"));
        assert!(is_multilingual_whisper_model("large-v3-turbo"));
        assert!(!is_multilingual_whisper_model("distil-large-v3"));
        assert!(!is_multilingual_whisper_model("ggml-distil-large-v3.bin"));
        assert!(!is_multilingual_whisper_model("ggml-base.en.bin"));
    }

    #[test]
    fn a_line_straight_from_a_provider_carries_its_turn_signal() {
        let result = TranscriptResult {
            text: "Hello".into(),
            is_final: false,
            confidence: 0.8,
            timestamp_ms: 7,
            speaker: Some("You".into()),
            language: None,
            segment_id: None,
            duration_ms: None,
            speaker_tag: None,
            turn: Some(TurnSignal::EagerEnd),
        };
        let seg = result_segment_json("you_x_1", "User", &result);
        assert_eq!((seg["turn"].as_str(), seg["speaker"].as_str()), (Some("eager_end"), Some("User")));
        let plain = result_segment_json("you_x_1", "User", &TranscriptResult { turn: None, ..result });
        assert!(plain.get("turn").is_none());
    }

    fn party(stt_provider: &str, device_id: &str, is_input_device: bool) -> PartyAudioConfig {
        PartyAudioConfig {
            role: PartyRole::You,
            device_id: device_id.to_string(),
            is_input_device,
            stt_provider: stt_provider.to_string(),
            local_model_id: None,
            language: None,
            native_translation: None,
        }
    }

    /// Web Speech and Windows Speech hear only the OS default mic, so a
    /// non-default input device needs the default switched to it.
    #[test]
    fn default_mic_override_only_for_speech_engines_on_a_chosen_mic() {
        let headset = "Microphone (Logi USB Headset H340)";
        assert!(needs_default_mic_override(&party("web_speech", headset, true), false));
        assert!(needs_default_mic_override(&party("windows_native", headset, true), false));
        // Every other provider reads NexQ's own capture of the chosen device.
        assert!(!needs_default_mic_override(&party("cartesia", headset, true), false));
        assert!(!needs_default_mic_override(&party("parakeet_tdt", headset, true), false));
        // Already the default, or an output device: nothing to switch.
        assert!(!needs_default_mic_override(&party("web_speech", "default", true), false));
        assert!(!needs_default_mic_override(&party("web_speech", "Speakers (Realtek)", false), false));
    }

    /// In an in-person meeting "You" isn't transcribed, so its engine choice
    /// must not move the Windows default mic.
    #[test]
    fn a_skipped_party_never_switches_the_default_mic() {
        let headset = "Microphone (Logi USB Headset H340)";
        assert!(!needs_default_mic_override(&party("web_speech", headset, true), true));
        assert!(!needs_default_mic_override(&party("windows_native", headset, true), true));
    }
}
