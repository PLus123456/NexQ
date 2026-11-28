// Dual-pass local Whisper.cpp STT. Fast passes preview short chunks, while
// correction passes and finalization decode the entire current line.

use async_trait::async_trait;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc as inference_channel, Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot, OwnedSemaphorePermit, Semaphore};

use crate::audio::AudioChunk;
use crate::stt::provider::{DualPassConfig, STTProvider, STTProviderType, TranscriptResult};
use crate::stt::{push_joined, word_diff};

const SAMPLE_RATE: u64 = 16_000;
const MAX_LINE_SAMPLES: usize = 30 * SAMPLE_RATE as usize;
const SPEECH_RMS_THRESHOLD: f64 = 200.0;
const MAX_PENDING_PREVIEWS: usize = 6;
const MAX_PENDING_FINALS: usize = 4;
const MODEL_LOAD_TIMEOUT: Duration = Duration::from_secs(30);
const DRAIN_TIMEOUT: Duration = Duration::from_secs(8);

// ── Hallucination filter ──

/// Strip whisper hallucination artifacts from output text.
/// Returns empty string if the entire text is a hallucination.
fn clean_whisper_text(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    // Remove all bracket/paren-enclosed content: [anything], (anything)
    let mut result = String::new();
    let mut in_bracket = 0i32;
    let mut in_paren = 0i32;
    for ch in trimmed.chars() {
        match ch {
            '[' => in_bracket += 1,
            ']' if in_bracket > 0 => {
                in_bracket -= 1;
                continue;
            }
            '(' => in_paren += 1,
            ')' if in_paren > 0 => {
                in_paren -= 1;
                continue;
            }
            _ if in_bracket > 0 || in_paren > 0 => continue,
            _ => result.push(ch),
        }
    }

    let cleaned = result.trim().to_string();

    // Check for common hallucination patterns (whisper produces these on silence)
    let lower = cleaned.to_lowercase();
    if lower.is_empty()
        || lower == "you"
        || lower == "thank you."
        || lower == "thank you"
        || lower == "thanks for watching."
        || lower == "thanks for watching"
        || lower == "bye."
        || lower == "bye"
        || lower == "the end"
        || lower == "so"
        || lower == "hmm"
        || lower == "uh"
        || lower.starts_with("subscribe")
        || lower.starts_with("please subscribe")
        || lower.contains("blank_audio")
        || lower.contains("blank audio")
    {
        return String::new();
    }

    // Too short to be meaningful (single punctuation, etc.)
    if cleaned.len() < 2 {
        return String::new();
    }

    cleaned
}

/// Check if an audio buffer has enough energy to contain speech.
fn has_speech_energy(samples: &[i16]) -> bool {
    if samples.is_empty() {
        return false;
    }
    let sum_sq: f64 = samples.iter().map(|&s| (s as f64) * (s as f64)).sum();
    let rms = (sum_sq / samples.len() as f64).sqrt();
    rms > SPEECH_RMS_THRESHOLD
}

/// Load the model and a decoding state, on the GPU when asked (Metal on
/// macOS builds) and on the CPU when that fails. Returns whether it is on the GPU.
fn load_model(
    model: &str,
    use_gpu: bool,
) -> Result<(whisper_rs::WhisperContext, whisper_rs::WhisperState, bool), whisper_rs::WhisperError>
{
    use whisper_rs::{WhisperContext, WhisperContextParameters};

    let load = |gpu: bool| {
        let mut params = WhisperContextParameters::default();
        params.use_gpu(gpu);
        let ctx = WhisperContext::new_with_params(model, params)?;
        let state = ctx.create_state()?;
        Ok::<_, whisper_rs::WhisperError>((ctx, state))
    };
    if use_gpu {
        match load(true) {
            Ok((ctx, state)) => return Ok((ctx, state, true)),
            Err(e) => log::warn!(
                "WhisperCppSTT: GPU initialization failed ({}), using the CPU",
                e
            ),
        }
    }
    load(false).map(|(ctx, state)| (ctx, state, false))
}

#[derive(Clone, Copy)]
struct Line {
    number: u64,
    timestamp_ms: u64,
}

enum Pass {
    Fast(OwnedSemaphorePermit),
    Correction(OwnedSemaphorePermit),
    Final(OwnedSemaphorePermit),
}

struct InferenceTask {
    line: Line,
    samples: Vec<i16>,
    pass: Pass,
}

#[derive(Default)]
struct Recognized {
    text: String,
    language: Option<String>,
}

fn recognize(state: &mut whisper_rs::WhisperState, samples: &[i16], language: &str) -> Recognized {
    use whisper_rs::{FullParams, SamplingStrategy};

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    let detect = language.eq_ignore_ascii_case("auto");
    params.set_language((!detect).then_some(language));
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_n_threads(4);
    params.set_no_context(true);
    params.set_suppress_blank(true);
    params.set_suppress_nst(true);
    params.set_no_speech_thold(0.6);

    let samples: Vec<f32> = samples
        .iter()
        .map(|&sample| sample as f32 / 32768.0)
        .collect();
    if let Err(e) = state.full(params, &samples) {
        log::error!("WhisperCppSTT: Inference failed: {e}");
        return Recognized::default();
    }

    let mut text = String::new();
    for i in 0..state.full_n_segments() {
        if let Some(segment) = state.get_segment(i) {
            if let Ok(content) = segment.to_str() {
                text.push_str(content);
            }
        }
    }
    Recognized {
        text: clean_whisper_text(&text),
        language: if detect {
            whisper_rs::get_lang_str(state.full_lang_id_from_state()).map(str::to_string)
        } else {
            Some(language.to_string())
        },
    }
}

/// Tasks for each line end with its final pass in FIFO order. The worker owns
/// that line's text, so a delayed preview cannot change another line's final.
fn process_passes(
    tasks: inference_channel::Receiver<InferenceTask>,
    feedback: inference_channel::Sender<u64>,
    results: mpsc::Sender<TranscriptResult>,
    aborted: &AtomicBool,
    skip_previews_through: &AtomicU64,
    mut infer: impl FnMut(&[i16]) -> Recognized,
) {
    let mut recognized = Recognized::default();
    let mut corrected_samples = None;

    while let Ok(task) = tasks.recv() {
        if aborted.load(Ordering::Relaxed) || results.is_closed() {
            break;
        }
        let (is_final, is_fast, _queue_slot) = match task.pass {
            Pass::Fast(slot) => (false, true, slot),
            Pass::Correction(slot) => (false, false, slot),
            Pass::Final(slot) => (true, false, slot),
        };
        if !is_final && task.line.number <= skip_previews_through.load(Ordering::Acquire) {
            continue;
        }

        // Reuse the full correction when the final pass covers the same audio.
        if !is_final || corrected_samples != Some(task.samples.len()) {
            let inference = infer(&task.samples);
            if inference.text.is_empty() && !is_final {
                continue;
            }
            if aborted.load(Ordering::Relaxed) {
                break;
            }
            if !inference.text.is_empty() {
                if is_fast {
                    push_joined(&mut recognized.text, &inference.text);
                    let _ = feedback.send(task.line.number);
                } else {
                    recognized.text = word_diff::merge_correction(
                        &recognized.text.split_whitespace().collect::<Vec<_>>(),
                        &inference.text.split_whitespace().collect::<Vec<_>>(),
                    );
                    corrected_samples = Some(task.samples.len());
                }
                recognized.language = inference.language;
            }
        }

        let result = if is_final {
            corrected_samples = None;
            std::mem::take(&mut recognized)
        } else {
            Recognized {
                text: recognized.text.clone(),
                language: recognized.language.clone(),
            }
        };
        if !result.text.is_empty()
            && results
                .blocking_send(TranscriptResult {
                    text: result.text,
                    is_final,
                    confidence: if is_fast { 0.80 } else { 0.92 },
                    timestamp_ms: task.line.timestamp_ms,
                    speaker: None,
                    language: result.language,
                    segment_id: Some(format!("line_{}", task.line.number)),
                    duration_ms: None,
                    speaker_tag: None,
                    turn: None,
                })
                .is_err()
        {
            break;
        }
    }
}

struct InferenceWorker {
    tasks: Option<inference_channel::Sender<InferenceTask>>,
    feedback: Mutex<inference_channel::Receiver<u64>>,
    previews: Arc<Semaphore>,
    finals: Arc<Semaphore>,
    skip_previews_through: Arc<AtomicU64>,
    aborted: Arc<AtomicBool>,
    finished: oneshot::Receiver<()>,
}

impl Drop for InferenceWorker {
    fn drop(&mut self) {
        self.aborted.store(true, Ordering::Release);
    }
}

pub struct WhisperCppSTT {
    model_path: PathBuf,
    language: String,
    use_gpu: bool,
    config: Arc<RwLock<DualPassConfig>>,
    worker: Option<InferenceWorker>,
    line_number: u64,
    line: Option<Line>,
    closing_line: bool,
    line_audio: Vec<i16>,
    fast_buffer: Vec<i16>,
    buffer_has_speech: bool,
    last_speech_sample: usize,
    last_preview_sample: usize,
    last_new_word: Option<Instant>,
}

impl WhisperCppSTT {
    pub fn new(model_path: PathBuf, config: Arc<RwLock<DualPassConfig>>) -> Self {
        Self {
            model_path,
            language: "en".to_string(),
            use_gpu: true,
            config,
            worker: None,
            line_number: 0,
            line: None,
            closing_line: false,
            line_audio: Vec::new(),
            fast_buffer: Vec::new(),
            buffer_has_speech: false,
            last_speech_sample: 0,
            last_preview_sample: 0,
            last_new_word: None,
        }
    }

    /// Use Metal when available. Fall back to CPU if loading fails.
    pub fn set_use_gpu(&mut self, use_gpu: bool) {
        self.use_gpu = use_gpu;
    }

    fn queue_final(&mut self, permit: OwnedSemaphorePermit) -> Result<(), String> {
        let worker = self
            .worker
            .as_ref()
            .ok_or("Whisper worker is not running")?;
        let tx = worker.tasks.as_ref().ok_or("Whisper stream is closing")?;
        if let Some(line) = self.line.take() {
            let samples = std::mem::take(&mut self.line_audio);
            tx.send(InferenceTask {
                line,
                samples,
                pass: Pass::Final(permit),
            })
            .map_err(|_| "Whisper worker stopped")?;
        }
        self.clear_line();
        Ok(())
    }

    fn clear_line(&mut self) {
        self.line = None;
        self.line_audio.clear();
        self.closing_line = false;
        self.fast_buffer.clear();
        self.buffer_has_speech = false;
        self.last_speech_sample = 0;
        self.last_preview_sample = 0;
        self.last_new_word = None;
    }

    async fn finalize_when_ready(&mut self) -> Result<(), String> {
        let worker = self
            .worker
            .as_ref()
            .ok_or("Whisper worker is not running")?;
        self.closing_line = true;
        let slots = Arc::clone(&worker.finals);
        let permit = match Arc::clone(&slots).try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                // Let the earlier finals free a slot before accepting more
                // audio. This blocks only this side's STT feed.
                let finalized = self.line_number.saturating_sub(1);
                worker
                    .skip_previews_through
                    .fetch_max(finalized, Ordering::Release);
                slots
                    .acquire_owned()
                    .await
                    .map_err(|_| "Whisper worker stopped")?
            }
        };
        self.queue_final(permit)
    }
}

#[async_trait]
impl STTProvider for WhisperCppSTT {
    fn provider_name(&self) -> &str {
        "Whisper.cpp (Local)"
    }

    fn provider_type(&self) -> STTProviderType {
        STTProviderType::WhisperCpp
    }

    async fn start_stream(
        &mut self,
        result_tx: mpsc::Sender<TranscriptResult>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if self.worker.is_some() {
            return Err("Stream already active".into());
        }
        if !self.model_path.is_file() {
            return Err(
                format!("Whisper model not found at: {}", self.model_path.display()).into(),
            );
        }

        let (tasks, task_rx) = inference_channel::channel();
        let (feedback_tx, feedback) = inference_channel::channel();
        let (ready_tx, ready) = oneshot::channel::<Result<(), String>>();
        let (finished_tx, finished) = oneshot::channel();
        let aborted = Arc::new(AtomicBool::new(false));
        let worker_aborted = Arc::clone(&aborted);
        let skip_previews_through = Arc::new(AtomicU64::new(0));
        let skip_previews = Arc::clone(&skip_previews_through);
        let model_path = self.model_path.clone();
        let use_gpu = self.use_gpu;
        let language = self.language.clone();

        std::thread::Builder::new()
            .name("whisper-inference".into())
            .spawn(move || {
                let (_context, mut state, on_gpu) =
                    match load_model(&model_path.to_string_lossy(), use_gpu) {
                        Ok(loaded) => loaded,
                        Err(e) => {
                            let _ =
                                ready_tx.send(Err(format!("Failed to load Whisper model: {e}")));
                            return;
                        }
                    };
                if ready_tx.send(Ok(())).is_err() {
                    return;
                }
                log::info!(
                    "WhisperCppSTT: Model loaded on the {}",
                    if on_gpu { "GPU" } else { "CPU" }
                );
                process_passes(
                    task_rx,
                    feedback_tx,
                    result_tx,
                    &worker_aborted,
                    &skip_previews,
                    |samples| recognize(&mut state, samples, &language),
                );
                let _ = finished_tx.send(());
            })?;

        tokio::time::timeout(MODEL_LOAD_TIMEOUT, ready)
            .await
            .map_err(|_| "Timed out loading the Whisper model")?
            .map_err(|_| "Whisper worker stopped before the model loaded")??;
        self.worker = Some(InferenceWorker {
            tasks: Some(tasks),
            feedback: Mutex::new(feedback),
            previews: Arc::new(Semaphore::new(MAX_PENDING_PREVIEWS)),
            finals: Arc::new(Semaphore::new(MAX_PENDING_FINALS)),
            skip_previews_through,
            aborted,
            finished,
        });
        self.line_number = 0;
        self.clear_line();
        Ok(())
    }

    async fn feed_audio(
        &mut self,
        chunk: AudioChunk,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if self.closing_line {
            self.finalize_when_ready().await?;
        }
        let Some(worker) = &self.worker else {
            return Ok(());
        };
        let Some(tx) = &worker.tasks else {
            return Ok(());
        };
        let config = self
            .config
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let short_samples = (SAMPLE_RATE as f32 * config.short_chunk_secs) as usize;
        let correction_samples = (SAMPLE_RATE as f32 * config.long_chunk_secs) as usize;
        let pause_samples = (SAMPLE_RATE as f32 * config.pause_secs) as usize;
        let has_speech = has_speech_energy(&chunk.pcm_data);

        if self.line.is_none() && !has_speech {
            return Ok(());
        }
        let line = *self.line.get_or_insert_with(|| {
            self.line_number += 1;
            let duration_ms = chunk.pcm_data.len() as u64 * 1000 / SAMPLE_RATE;
            Line {
                number: self.line_number,
                timestamp_ms: chunk.timestamp_ms.saturating_sub(duration_ms),
            }
        });

        {
            let feedback = worker.feedback.lock().unwrap_or_else(|e| e.into_inner());
            for number in feedback.try_iter() {
                if number == line.number {
                    self.last_new_word = Some(Instant::now());
                }
            }
        }

        self.line_audio.extend_from_slice(&chunk.pcm_data);
        self.fast_buffer.extend_from_slice(&chunk.pcm_data);
        if has_speech {
            self.buffer_has_speech = true;
            self.last_speech_sample = self.line_audio.len();
        }

        let pause_by_silence = self.line_audio.len() - self.last_speech_sample >= pause_samples;
        let pause_by_words = self
            .last_new_word
            .is_some_and(|at| at.elapsed().as_secs_f32() >= config.pause_secs);
        if self.line_audio.len() >= MAX_LINE_SAMPLES || pause_by_silence || pause_by_words {
            return self.finalize_when_ready().await.map_err(Into::into);
        }

        if self.fast_buffer.len() >= short_samples {
            let samples = std::mem::take(&mut self.fast_buffer);
            if self.buffer_has_speech {
                if let Ok(permit) = Arc::clone(&worker.previews).try_acquire_owned() {
                    let _ = tx.send(InferenceTask {
                        line,
                        samples,
                        pass: Pass::Fast(permit),
                    });
                }
            }
            self.buffer_has_speech = false;

            // Correction snapshots end at fast-pass boundaries, so future
            // fast passes append only previously uncovered audio.
            if self.line_audio.len() - self.last_preview_sample >= correction_samples {
                if let Ok(permit) = Arc::clone(&worker.previews).try_acquire_owned() {
                    self.last_preview_sample = self.line_audio.len();
                    let _ = tx.send(InferenceTask {
                        line,
                        samples: self.line_audio.clone(),
                        pass: Pass::Correction(permit),
                    });
                }
            }
        }
        Ok(())
    }

    async fn stop_stream(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(worker) = &self.worker else {
            return Ok(());
        };
        let deadline = tokio::time::Instant::now() + DRAIN_TIMEOUT;
        // Preview work is superseded by the complete audio queued for each final.
        worker
            .skip_previews_through
            .store(self.line_number, Ordering::Release);
        if self.line.is_some() {
            let permit =
                match tokio::time::timeout_at(deadline, Arc::clone(&worker.finals).acquire_owned())
                    .await
                {
                    Ok(Ok(permit)) => permit,
                    _ => {
                        self.worker.take();
                        self.clear_line();
                        return Err("Timed out queuing the final Whisper transcript".into());
                    }
                };
            if let Err(e) = self.queue_final(permit) {
                self.worker.take();
                self.clear_line();
                return Err(e.into());
            }
        }

        let mut worker = self.worker.take().expect("running worker");
        worker.tasks.take();
        tokio::time::timeout_at(deadline, &mut worker.finished)
            .await
            .map_err(|_| "Timed out draining the final Whisper transcript")?
            .map_err(|_| "Whisper worker stopped before the stream was drained")?;
        Ok(())
    }

    async fn test_connection(&self) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        Ok(self.model_path.is_file())
    }

    fn set_language(&mut self, language: &str) {
        self.language = crate::stt::language::whisper_cpp_language(language);
        log::info!("WhisperCppSTT: Language set to {}", self.language);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_words_with_spaces_and_cjk_without() {
        let mut line = String::new();
        push_joined(&mut line, " Hello");
        push_joined(&mut line, "world ");
        assert_eq!(line, "Hello world");

        let mut zh = String::new();
        push_joined(&mut zh, "我们今天");
        push_joined(&mut zh, "开会。");
        push_joined(&mut zh, "OK");
        assert_eq!(zh, "我们今天开会。OK");

        let mut mixed = String::from("NexQ");
        push_joined(&mut mixed, "很好用");
        push_joined(&mut mixed, "");
        assert_eq!(mixed, "NexQ很好用");
    }

    fn sample_inference(text: &str) -> Recognized {
        Recognized {
            text: text.to_string(),
            language: Some("en".into()),
        }
    }

    #[test]
    fn corrected_line_is_final_before_the_next_preview_even_if_final_decode_is_blank() {
        let (tasks, task_rx) = inference_channel::channel();
        let (feedback, words) = inference_channel::channel();
        let (results, mut outputs) = mpsc::channel(8);
        let slots = Arc::new(Semaphore::new(5));
        let first = Line {
            number: 1,
            timestamp_ms: 1_800_000_000_000,
        };
        let second = Line {
            number: 2,
            timestamp_ms: first.timestamp_ms + 1_000,
        };
        let permit = || Arc::clone(&slots).try_acquire_owned().unwrap();

        for (line, samples, pass) in [
            (first, vec![1], Pass::Fast(permit())),
            (first, vec![2, 1], Pass::Correction(permit())),
            (first, vec![3, 1, 2], Pass::Final(permit())),
            (second, vec![4], Pass::Fast(permit())),
            (second, vec![4], Pass::Final(permit())),
        ] {
            tasks
                .send(InferenceTask {
                    line,
                    samples,
                    pass,
                })
                .unwrap();
        }
        drop(tasks);

        process_passes(
            task_rx,
            feedback,
            results,
            &AtomicBool::new(false),
            &AtomicU64::new(0),
            |audio| {
                sample_inference(match audio[0] {
                    1 => "meeting tomarrow",
                    2 => "Meeting tomorrow.",
                    3 => "",
                    _ => "New topic.",
                })
            },
        );

        let mut outputs = std::iter::from_fn(|| outputs.try_recv().ok());
        assert!(!outputs.next().unwrap().is_final);
        assert_eq!(outputs.next().unwrap().text, "Meeting tomorrow.");
        let corrected = outputs.next().unwrap();
        assert!(corrected.is_final);
        assert_eq!(corrected.text, "Meeting tomorrow.");
        assert_eq!(corrected.timestamp_ms, first.timestamp_ms);
        let preview = outputs.next().unwrap();
        assert_eq!(preview.text, "New topic.");
        assert_eq!(preview.timestamp_ms, second.timestamp_ms);
        assert_eq!(preview.segment_id.as_deref(), Some("line_2"));
        assert!(outputs.next().unwrap().is_final);
        assert!(outputs.next().is_none());
        assert_eq!(words.try_iter().collect::<Vec<_>>(), [1, 2]);
    }

    #[tokio::test]
    async fn graceful_stop_decodes_the_short_tail_with_the_capture_clock() {
        let mut stt = WhisperCppSTT::new(
            PathBuf::new(),
            Arc::new(RwLock::new(DualPassConfig::default())),
        );
        let (tasks, task_rx) = inference_channel::channel();
        let (feedback_tx, feedback) = inference_channel::channel();
        let (results, mut outputs) = mpsc::channel(4);
        let (done, finished) = oneshot::channel();
        let aborted = Arc::new(AtomicBool::new(false));
        let skip_previews_through = Arc::new(AtomicU64::new(0));
        let worker_abort = Arc::clone(&aborted);
        let worker_skip = Arc::clone(&skip_previews_through);
        let worker = std::thread::spawn(move || {
            process_passes(
                task_rx,
                feedback_tx,
                results,
                &worker_abort,
                &worker_skip,
                |samples| {
                    assert_eq!(samples.len(), 1_600);
                    sample_inference("Tail words.")
                },
            );
            let _ = done.send(());
        });
        stt.worker = Some(InferenceWorker {
            tasks: Some(tasks),
            feedback: Mutex::new(feedback),
            previews: Arc::new(Semaphore::new(MAX_PENDING_PREVIEWS)),
            finals: Arc::new(Semaphore::new(MAX_PENDING_FINALS)),
            aborted,
            skip_previews_through,
            finished,
        });

        let capture_start = 1_800_000_000_000;
        stt.feed_audio(AudioChunk {
            pcm_data: vec![1000; 1_600],
            source: crate::audio::AudioSource::Mic,
            timestamp_ms: capture_start + 100,
            is_speech: true,
        })
        .await
        .unwrap();
        stt.stop_stream().await.unwrap();
        worker.join().unwrap();

        let tail = outputs.try_recv().unwrap();
        assert!(tail.is_final);
        assert_eq!(tail.text, "Tail words.");
        assert_eq!(tail.timestamp_ms, capture_start);
        assert!(outputs.recv().await.is_none());
    }

    #[tokio::test]
    async fn saturated_final_queue_retains_the_line_and_bounds_pending_audio() {
        let mut stt = WhisperCppSTT::new(
            PathBuf::new(),
            Arc::new(RwLock::new(DualPassConfig::default())),
        );
        let (tx, tasks) = inference_channel::channel();
        let (_feedback_tx, feedback) = inference_channel::channel();
        let (_done, finished) = oneshot::channel();
        let finals = Arc::new(Semaphore::new(0));
        stt.worker = Some(InferenceWorker {
            tasks: Some(tx),
            feedback: Mutex::new(feedback),
            previews: Arc::new(Semaphore::new(MAX_PENDING_PREVIEWS)),
            finals: Arc::clone(&finals),
            aborted: Arc::new(AtomicBool::new(false)),
            skip_previews_through: Arc::new(AtomicU64::new(0)),
            finished,
        });

        let capture_start = 1_800_000_000_000;
        let chunk = |samples, time| AudioChunk {
            pcm_data: vec![1000; samples],
            source: crate::audio::AudioSource::Mic,
            timestamp_ms: capture_start + time,
            is_speech: true,
        };
        {
            let saturated = stt.feed_audio(chunk(MAX_LINE_SAMPLES, 30_000));
            tokio::pin!(saturated);
            assert!(futures::poll!(&mut saturated).is_pending());
            finals.add_permits(1);
            saturated.await.unwrap();
        }
        stt.feed_audio(chunk(160, 30_020)).await.unwrap();
        let final_task = tasks.try_recv().unwrap();
        assert!(matches!(final_task.pass, Pass::Final(_)));
        assert_eq!(final_task.samples.len(), MAX_LINE_SAMPLES);
        assert_eq!(final_task.line.timestamp_ms, capture_start);
        assert_eq!(stt.line_audio.len(), 160);
        assert_eq!(stt.line.unwrap().number, 2);
    }

    #[tokio::test]
    async fn corrupt_model_fails_start_before_reporting_ready() {
        let path =
            std::env::temp_dir().join(format!("nexq-whisper-test-{}.bin", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"invalid").unwrap();
        let mut stt = WhisperCppSTT::new(
            path.clone(),
            Arc::new(RwLock::new(DualPassConfig::default())),
        );
        stt.set_use_gpu(false);
        let (outputs, _) = mpsc::channel(1);
        let result = stt.start_stream(outputs).await;
        std::fs::remove_file(&path).unwrap();

        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Failed to load Whisper model"));
        assert!(stt.worker.is_none());
    }

    /// Metal vs CPU on the same audio (reads files only, never the app's data):
    ///
    /// `NEXQ_WHISPER_MODEL=<ggml-*.bin> NEXQ_TEST_WAV=<16 kHz mono 16-bit wav> cargo test --lib whisper_cpp::tests::gpu_vs_cpu -- --ignored --nocapture`
    ///
    /// Each backend loads once, warms up on the first 5 s, then transcribes the
    /// whole file; the printed times go into the P2 report.
    #[test]
    #[ignore]
    fn gpu_vs_cpu_on_the_same_wav() {
        use whisper_rs::{FullParams, SamplingStrategy};

        let model = std::env::var("NEXQ_WHISPER_MODEL").expect("set NEXQ_WHISPER_MODEL");
        let wav = std::env::var("NEXQ_TEST_WAV").expect("set NEXQ_TEST_WAV");
        let reader = hound::WavReader::open(&wav).expect("wav");
        let spec = reader.spec();
        assert_eq!(
            (spec.sample_rate, spec.channels),
            (16_000, 1),
            "the WAV must be 16 kHz mono"
        );
        let samples: Vec<f32> = reader
            .into_samples::<i16>()
            .map(|s| s.expect("sample") as f32 / 32768.0)
            .collect();
        let audio_secs = samples.len() as f32 / 16_000.0;
        let language = std::env::var("NEXQ_TEST_LANG").unwrap_or_else(|_| "auto".to_string());

        for gpu in [true, false] {
            let started = Instant::now();
            let (_ctx, mut state, on_gpu) = load_model(&model, gpu).expect("load model");
            let load_ms = started.elapsed().as_millis();
            let mut run = |audio: &[f32]| {
                let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
                params.set_language(Some(&language));
                params.set_n_threads(4);
                params.set_print_progress(false);
                params.set_print_realtime(false);
                let t = Instant::now();
                state.full(params, audio).expect("transcribe");
                let text: String = (0..state.full_n_segments())
                    .filter_map(|i| {
                        state
                            .get_segment(i)
                            .and_then(|seg| seg.to_str().ok().map(str::to_string))
                    })
                    .collect();
                (t.elapsed().as_millis(), text)
            };
            let _ = run(&samples[..samples.len().min(5 * 16_000)]);
            let (ms, text) = run(&samples);
            println!(
                "{} (asked {}): load {} ms, {:.1} s of audio in {} ms ({:.1}x real time)\n  {}",
                if on_gpu { "GPU" } else { "CPU" },
                if gpu { "GPU" } else { "CPU" },
                load_ms,
                audio_secs,
                ms,
                audio_secs * 1000.0 / ms.max(1) as f32,
                text.chars().take(200).collect::<String>()
            );
        }
    }
}
