use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WaveformData {
    pub sample_rate: u32,   // peaks per minute
    pub duration_ms: u64,
    pub peaks: Vec<[f32; 2]>, // [min, max] normalized to -1.0..1.0
}

/// Extract waveform peaks from a WAV file.
/// Resolution: ~50 peaks per second (3000 per minute).
/// Uses RMS-weighted peaks for better visual representation of loudness.
pub fn extract_peaks(wav_path: &Path) -> Result<WaveformData, String> {
    let reader = hound::WavReader::open(wav_path)
        .map_err(|e| format!("Failed to open WAV: {}", e))?;

    let spec = reader.spec();
    if spec.sample_rate == 0 || spec.channels == 0 {
        return Err("WAV has an invalid sample rate or channel count".to_string());
    }
    let duration_ms = u64::from(reader.duration()) * 1000 / u64::from(spec.sample_rate);
    let samples_per_peak = ((spec.sample_rate / 50).max(1) as usize) * usize::from(spec.channels);
    let mut peaks = Vec::new();
    let mut sum_sq = 0.0;
    let mut count = 0;
    let peak = |sum_sq: f64, n: usize| {
        let magnitude = ((sum_sq / n as f64).sqrt() * 2.5).min(1.0) as f32;
        [-magnitude, magnitude]
    };
    for sample in reader.into_samples::<i16>() {
        let sample = sample.map_err(|e| format!("Failed to read WAV sample: {e}"))?;
        sum_sq += (f64::from(sample) / f64::from(i16::MAX)).powi(2);
        count += 1;
        if count == samples_per_peak {
            peaks.push(peak(sum_sq, count));
            sum_sq = 0.0;
            count = 0;
        }
    }
    if count > 0 {
        peaks.push(peak(sum_sq, count));
    }

    Ok(WaveformData {
        sample_rate: 3000,
        duration_ms,
        peaks,
    })
}

/// Max-pool `peaks` down to at most `target` values.
/// Returns the input unchanged when it already fits.
pub fn downsample_peaks(peaks: &[f32], target: usize) -> Vec<f32> {
    if peaks.len() <= target {
        return peaks.to_vec();
    }
    if target == 0 {
        return Vec::new();
    }
    let len = peaks.len();
    (0..target)
        .map(|i| {
            let start = i * len / target;
            let end = ((i + 1) * len / target).max(start + 1).min(len);
            peaks[start..end].iter().cloned().fold(0.0_f32, f32::max)
        })
        .collect()
}

/// Cap a waveform at `target` peaks (max-pooling the magnitude of each
/// `[min, max]` pair) so large recordings don't ship ~87k peaks over IPC.
pub fn downsample_waveform(data: WaveformData, target: usize) -> WaveformData {
    if data.peaks.len() <= target {
        return data;
    }
    let magnitudes: Vec<f32> = data
        .peaks
        .iter()
        .map(|p| p[0].abs().max(p[1].abs()))
        .collect();
    let peaks: Vec<[f32; 2]> = downsample_peaks(&magnitudes, target)
        .into_iter()
        .map(|m| [-m, m])
        .collect();
    WaveformData { peaks, ..data }
}

/// Write waveform data to a JSON file.
pub fn write_waveform_json(data: &WaveformData, output_path: &Path) -> Result<(), String> {
    let json = serde_json::to_string(data)
        .map_err(|e| format!("Failed to serialize waveform: {}", e))?;
    std::fs::write(output_path, json)
        .map_err(|e| format!("Failed to write waveform file: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waveform_duration_counts_frames_and_rejects_a_zero_sample_rate() {
        let path = std::env::temp_dir().join(format!("nexq-waveform-{}.wav", uuid::Uuid::new_v4()));
        let spec = hound::WavSpec { channels: 2, sample_rate: 16_000, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        let mut writer = hound::WavWriter::create(&path, spec).unwrap();
        for _ in 0..32_000 {
            writer.write_sample(100i16).unwrap();
        }
        writer.finalize().unwrap();
        let waveform = extract_peaks(&path).unwrap();
        assert_eq!(waveform.duration_ms, 1_000);
        assert_eq!(waveform.peaks.len(), 50);

        let mut bad_header = std::fs::read(&path).unwrap();
        bad_header[24..28].fill(0);
        std::fs::write(&path, bad_header).unwrap();
        assert!(extract_peaks(&path).is_err());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn downsample_keeps_max_per_bucket() {
        assert_eq!(downsample_peaks(&[0.1, 0.9, 0.2, 0.3], 2), vec![0.9, 0.3]);
    }

    #[test]
    fn downsample_noop_when_short() {
        assert_eq!(downsample_peaks(&[0.1, 0.5, 0.2], 10), vec![0.1, 0.5, 0.2]);
    }

    #[test]
    fn downsample_output_len_matches_target() {
        let peaks = vec![0.5_f32; 87_000];
        assert_eq!(downsample_peaks(&peaks, 4000).len(), 4000);
    }

    #[test]
    fn downsample_waveform_caps_pairs_and_keeps_duration() {
        let data = WaveformData {
            sample_rate: 3000,
            duration_ms: 60_000,
            peaks: vec![[-0.1, 0.1], [-0.9, 0.9], [-0.2, 0.2], [-0.3, 0.3]],
        };
        let out = downsample_waveform(data, 2);
        assert_eq!(out.duration_ms, 60_000);
        assert_eq!(out.peaks, vec![[-0.9, 0.9], [-0.3, 0.3]]);
    }
}
