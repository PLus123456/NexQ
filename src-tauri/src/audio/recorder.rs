// Sub-PRD 3: Audio recording to WAV file
// Writes PCM data to file in a background thread
// Saves to <app data dir>/recordings/{meeting_id}.wav

use hound::{SampleFormat, WavSpec, WavWriter};
use std::fs;
use std::io::BufWriter;
use std::path::PathBuf;
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex};

use super::recording_mixer::{wall_clock_ms, MixSide, RecordingMixer};

/// Sample rate for recorded audio (matches our pipeline target)
const RECORDING_SAMPLE_RATE: u32 = 16000;
/// Number of bits per sample
const BITS_PER_SAMPLE: u16 = 16;
/// Number of channels (mono)
const NUM_CHANNELS: u16 = 1;

/// Handle to an active recording session.
/// Dropping the handle will stop the recording.
pub struct RecorderHandle {
    /// Channel to send audio samples to the writer thread
    sample_tx: Option<std_mpsc::Sender<RecorderMessage>>,
    /// Writer thread join handle
    writer_thread: Option<std::thread::JoinHandle<Option<PathBuf>>>,
    /// Path where the recording will be saved
    output_path: PathBuf,
    /// Unix epoch milliseconds when recording started
    pub start_time_ms: u64,
}

enum RecorderMessage {
    /// Write these PCM samples to the WAV file
    Samples(Vec<i16>),
    /// Stop recording and finalize the file
    Stop,
}

impl RecorderHandle {
    /// Write PCM samples to the recording.
    /// Samples should be 16kHz mono 16-bit PCM.
    pub fn write_samples(&self, samples: &[i16]) {
        if samples.is_empty() {
            return;
        }
        if let Some(ref tx) = self.sample_tx {
            if tx.send(RecorderMessage::Samples(samples.to_vec())).is_err() {
                log::warn!("Recorder channel closed, samples dropped");
            }
        }
    }

    /// Stop the recording and finalize the WAV file.
    /// Returns the path to the saved recording.
    pub fn stop(mut self) -> Result<PathBuf, String> {
        // Send stop message
        if let Some(tx) = self.sample_tx.take() {
            let _ = tx.send(RecorderMessage::Stop);
        }

        // Wait for writer thread to finish
        if let Some(thread) = self.writer_thread.take() {
            match thread.join() {
                Ok(Some(path)) => {
                    log::info!("Recording saved to: {}", path.display());
                    Ok(path)
                }
                Ok(None) => Err("Recording failed: writer returned no path".to_string()),
                Err(_) => Err("Recording writer thread panicked".to_string()),
            }
        } else {
            Ok(self.output_path.clone())
        }
    }

    /// Get the output path (even before stopping).
    pub fn path(&self) -> &PathBuf {
        &self.output_path
    }
}

impl Drop for RecorderHandle {
    fn drop(&mut self) {
        // If not explicitly stopped, signal the writer to stop
        if let Some(tx) = self.sample_tx.take() {
            let _ = tx.send(RecorderMessage::Stop);
        }
        // We don't join here to avoid blocking on drop
    }
}

/// Get the recordings directory path (`<app data dir>/recordings`, which the
/// asset protocol scope `$APPDATA/recordings/**` covers for playback).
/// Creates it if it doesn't exist.
fn get_recordings_dir() -> Result<PathBuf, String> {
    let recordings_dir = crate::paths::recordings_dir()?;

    fs::create_dir_all(&recordings_dir)
        .map_err(|e| format!("Failed to create recordings directory: {}", e))?;

    Ok(recordings_dir)
}

/// Start recording audio to a WAV file.
///
/// Creates a new WAV file at `<app data dir>/recordings/{meeting_id}.wav`
/// and spawns a background thread to write samples.
///
/// Returns a RecorderHandle for writing samples and stopping.
pub fn start_recording(meeting_id: &str) -> Result<RecorderHandle, String> {
    let recordings_dir = get_recordings_dir()?;
    start_recording_at(recordings_dir.join(format!("{}.wav", meeting_id)))
}

/// Start recording to `output_path`.
pub fn start_recording_at(output_path: PathBuf) -> Result<RecorderHandle, String> {
    log::info!("Starting recording to: {}", output_path.display());

    let spec = WavSpec {
        channels: NUM_CHANNELS,
        sample_rate: RECORDING_SAMPLE_RATE,
        bits_per_sample: BITS_PER_SAMPLE,
        sample_format: SampleFormat::Int,
    };
    // Report an unavailable recording path before the toggle succeeds.
    let file = fs::File::create(&output_path)
        .map_err(|err| format!("Failed to create WAV file: {err}"))?;
    let writer = WavWriter::new(BufWriter::new(file), spec)
        .map_err(|err| format!("Failed to open WAV writer: {err}"))?;

    let path_for_thread = output_path.clone();
    let (tx, rx) = std_mpsc::channel::<RecorderMessage>();

    let writer_thread = std::thread::Builder::new()
        .name("audio-recorder".into())
        .spawn(move || recorder_thread_fn(path_for_thread, writer, rx))
        .map_err(|err| {
            let _ = fs::remove_file(&output_path);
            format!("Failed to spawn recorder thread: {err}")
        })?;

    let start_time_ms = wall_clock_ms();

    Ok(RecorderHandle {
        sample_tx: Some(tx),
        writer_thread: Some(writer_thread),
        output_path,
        start_time_ms,
    })
}

/// The background writer thread function.
fn recorder_thread_fn(
    path: PathBuf,
    mut writer: WavWriter<BufWriter<fs::File>>,
    rx: std_mpsc::Receiver<RecorderMessage>,
) -> Option<PathBuf> {
    let mut total_samples: u64 = 0;

    'recording: loop {
        match rx.recv() {
            Ok(RecorderMessage::Samples(samples)) => {
                for &sample in &samples {
                    if let Err(e) = writer.write_sample(sample) {
                        log::error!("Failed to write sample: {}", e);
                        break 'recording;
                    }
                    total_samples += 1;
                }
            }
            Ok(RecorderMessage::Stop) => {
                break;
            }
            Err(_) => {
                // Channel closed — sender dropped
                log::info!("Recorder channel closed, finalizing");
                break;
            }
        }
    }

    match writer.finalize() {
        Ok(()) => {
            let duration_secs = total_samples as f64 / RECORDING_SAMPLE_RATE as f64;
            log::info!(
                "Recording finalized: {} samples ({:.1}s) at {}",
                total_samples,
                duration_secs,
                path.display()
            );
            Some(path)
        }
        Err(e) => {
            log::error!("Failed to finalize WAV file: {}", e);
            Some(path)
        }
    }
}

#[derive(Clone)]
pub struct FinishedRecording {
    pub meeting_id: String,
    pub wav_path: PathBuf,
    pub start_time_ms: u64,
}

/// The recorder and its timeline outlive any one capture pipeline. A disabled
/// interval never reaches the writer as audio and is padded only upon resuming.
#[derive(Clone, Default)]
pub struct CaptureRecorder(Arc<Mutex<Option<RecordingTrack>>>);

struct RecordingTrack {
    meeting_id: String,
    writer: RecorderHandle,
    mixer: RecordingMixer,
    enabled_since_ms: Option<u64>,
    has_audio: bool,
}

impl RecordingTrack {
    fn new(meeting_id: String, writer: RecorderHandle) -> Self {
        let start = writer.start_time_ms;
        Self {
            meeting_id,
            writer,
            mixer: RecordingMixer::starting_at(start),
            enabled_since_ms: Some(start),
            has_audio: false,
        }
    }

    fn finish_mix(&mut self) {
        self.mixer.finish(&mut |samples| self.writer.write_samples(samples));
    }

    fn set_enabled(&mut self, enabled: bool, now_ms: u64) {
        match (self.enabled_since_ms, enabled) {
            (None, true) => {
                self.mixer.pad_to(now_ms);
                self.enabled_since_ms = Some(now_ms);
            }
            (Some(_), false) => {
                self.finish_mix();
                self.enabled_since_ms = None;
            }
            _ => {}
        }
    }
}

impl CaptureRecorder {
    #[cfg(test)]
    pub(crate) fn for_test(meeting_id: &str, path: PathBuf) -> (Self, u64) {
        let writer = start_recording_at(path).unwrap();
        let start = writer.start_time_ms;
        let track = RecordingTrack::new(meeting_id.to_owned(), writer);
        (Self(Arc::new(Mutex::new(Some(track)))), start)
    }

    pub fn set_enabled(&self, enabled: bool, start_for_meeting: Option<&str>) -> Result<(), String> {
        let mut slot = self.0.lock().map_err(|_| "Recording state lock poisoned")?;
        if let Some(track) = slot.as_mut() {
            track.set_enabled(enabled, wall_clock_ms());
        } else if let (true, Some(meeting_id)) = (enabled, start_for_meeting) {
            *slot = Some(RecordingTrack::new(meeting_id.to_owned(), start_recording(meeting_id)?));
        }
        Ok(())
    }

    pub fn push(&self, side: MixSide, samples: &[i16], end_ms: u64) {
        let Ok(mut slot) = self.0.lock() else { return };
        let Some(track) = slot.as_mut() else { return };
        let Some(start) = track.enabled_since_ms else { return };
        // Clip a chunk straddling the toggle, including audio held by echo cancellation.
        let count = (end_ms.saturating_sub(start).saturating_mul(16)).min(samples.len() as u64) as usize;
        if count > 0 {
            track.has_audio = true;
            track.mixer.push(side, &samples[samples.len() - count..], end_ms, &mut |samples| {
                track.writer.write_samples(samples);
            });
        }
    }

    pub fn tick(&self, now_ms: u64) {
        let Ok(mut slot) = self.0.lock() else { return };
        if let Some(track) = slot.as_mut().filter(|track| track.enabled_since_ms.is_some()) {
            track.mixer.tick(now_ms, &mut |samples| track.writer.write_samples(samples));
        }
    }

    pub fn stop(&self) -> Option<FinishedRecording> {
        let mut track = self.0.lock().ok()?.take()?;
        track.finish_mix();
        let start_time_ms = track.writer.start_time_ms;
        let wav_path = match track.writer.stop() {
            Ok(path) => path,
            Err(err) => {
                log::error!("Failed to stop recording: {err}");
                return None;
            }
        };
        if !track.has_audio {
            let _ = fs::remove_file(wav_path);
            return None;
        }
        Some(FinishedRecording { meeting_id: track.meeting_id, wav_path, start_time_ms })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toggling_recording_keeps_existing_audio_and_skips_the_disabled_interval() {
        let path = std::env::temp_dir().join(format!("nexq-rec-{}.wav", uuid::Uuid::new_v4()));
        let (recorder, start) = CaptureRecorder::for_test("owner", path.clone());
        recorder.push(MixSide::Mic, &[100; 160], start + 10);
        {
            let mut slot = recorder.0.lock().unwrap();
            slot.as_mut().unwrap().set_enabled(false, start + 10);
        }
        recorder.push(MixSide::Mic, &[900; 160], start + 20);
        {
            let mut slot = recorder.0.lock().unwrap();
            slot.as_mut().unwrap().set_enabled(true, start + 20);
        }
        const CLIPPED: [i16; 240] = [300; 240];
        recorder.push(MixSide::Mic, &CLIPPED, start + 30);
        let saved = recorder.stop().unwrap();
        assert_eq!(saved.meeting_id, "owner");
        let samples: Vec<i16> = hound::WavReader::open(&saved.wav_path).unwrap()
            .into_samples::<i16>().map(Result::unwrap).collect();
        assert_eq!(&samples[..160], &[400; 160]);
        assert_eq!(&samples[160..320], &[0; 160]);
        assert_eq!(&samples[320..], &[1200; 160]);
        let _ = fs::remove_file(path);
    }
}
