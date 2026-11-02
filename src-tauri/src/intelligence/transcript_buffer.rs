// Sub-PRD 6: Sliding window ring buffer (default 120s, configurable)

use std::collections::VecDeque;

/// How many recent segments are checked for a paragraph being pushed again.
const GROWN_LOOKBACK: usize = 16;

/// A single transcript segment stored in the buffer.
#[derive(Debug, Clone)]
pub struct BufferSegment {
    pub text: String,
    pub speaker: String,
    pub timestamp_ms: u64,
    pub is_final: bool,
}

/// Thread-safe sliding window ring buffer for recent transcript segments.
/// Keeps segments within a configurable time window (default 120s).
pub struct TranscriptBuffer {
    segments: VecDeque<BufferSegment>,
    window_seconds: u64,
    max_segments: usize,
}

impl TranscriptBuffer {
    pub fn new() -> Self {
        Self {
            segments: VecDeque::new(),
            window_seconds: 120,
            max_segments: 500,
        }
    }

    /// Push a new transcript segment into the buffer.
    /// Automatically prunes segments older than the configured window.
    pub fn push_segment(
        &mut self,
        text: String,
        speaker: String,
        timestamp_ms: u64,
        is_final: bool,
    ) {
        // A paragraph that grew is pushed again as a final with the same
        // speaker and start time: replace it instead of keeping both copies.
        if is_final {
            if let Some(existing) = self.segments.iter_mut().rev().take(GROWN_LOOKBACK).find(|s| {
                s.is_final && s.timestamp_ms == timestamp_ms && s.speaker == speaker
            }) {
                existing.text = text;
                return;
            }
        }

        let segment = BufferSegment {
            text,
            speaker,
            timestamp_ms,
            is_final,
        };

        self.segments.push_back(segment);

        // Enforce max capacity
        while self.segments.len() > self.max_segments {
            self.segments.pop_front();
        }

        // Prune old segments based on the time window
        self.prune(timestamp_ms);
    }

    /// Get recent transcript text within the specified number of seconds
    /// from the most recent segment.
    pub fn get_recent_text(&self, window_seconds: u64) -> String {
        if self.segments.is_empty() {
            return String::new();
        }

        let latest_ts = self
            .segments
            .back()
            .map(|s| s.timestamp_ms)
            .unwrap_or(0);
        let cutoff_ms = latest_ts.saturating_sub(window_seconds * 1000);

        let mut parts: Vec<String> = Vec::new();
        for seg in &self.segments {
            if seg.timestamp_ms >= cutoff_ms && seg.is_final {
                let speaker_label = match seg.speaker.as_str() {
                    "User" | "You" | "user" | "you" | "me" => "You",
                    "Them" | "them" => "Them",
                    "Interviewer" | "interviewer" => "Interviewer",
                    _ => "Unknown",
                };
                parts.push(format!("[{}]: {}", speaker_label, seg.text));
            }
        }

        parts.join("\n")
    }

    /// Get all text in the buffer (only final segments).
    pub fn get_all_text(&self) -> String {
        let mut parts: Vec<String> = Vec::new();
        for seg in &self.segments {
            if seg.is_final {
                let speaker_label = match seg.speaker.as_str() {
                    "User" | "You" | "user" | "you" | "me" => "You",
                    "Them" | "them" => "Them",
                    "Interviewer" | "interviewer" => "Interviewer",
                    _ => "Unknown",
                };
                parts.push(format!("[{}]: {}", speaker_label, seg.text));
            }
        }
        parts.join("\n")
    }

    /// Clear all segments from the buffer.
    pub fn clear(&mut self) {
        self.segments.clear();
    }

    /// Set the window size in seconds.
    pub fn set_window_seconds(&mut self, seconds: u64) {
        self.window_seconds = seconds;
    }

    /// Get the current window size in seconds.
    pub fn window_seconds(&self) -> u64 {
        self.window_seconds
    }

    /// Get the number of segments currently in the buffer.
    pub fn len(&self) -> usize {
        self.segments.len()
    }

    /// Check if the buffer is empty.
    pub fn is_empty(&self) -> bool {
        self.segments.is_empty()
    }

    /// Prune segments older than the time window relative to the given timestamp.
    fn prune(&mut self, current_ms: u64) {
        let cutoff_ms = current_ms.saturating_sub(self.window_seconds * 1000);
        while let Some(front) = self.segments.front() {
            if front.timestamp_ms < cutoff_ms {
                self.segments.pop_front();
            } else {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn background_assist_preserves_both_speakers_and_only_final_original_text() {
        let mut buf = TranscriptBuffer::new();
        buf.push_segment("月底上线。".into(), "You".into(), 1_000, true);
        buf.push_segment("还有预算要讨论。".into(), "Them".into(), 2_000, true);
        buf.push_segment("未说完".into(), "Them".into(), 3_000, false);
        assert_eq!(buf.get_recent_text(90), "[You]: 月底上线。\n[Them]: 还有预算要讨论。");
        assert_eq!(buf.get_all_text(), buf.get_recent_text(90));
    }

    #[test]
    fn a_grown_paragraph_replaces_its_earlier_copy() {
        let mut buf = TranscriptBuffer::new();
        buf.push_segment("We ship".into(), "Them".into(), 1_000, true);
        buf.push_segment("Sure".into(), "User".into(), 2_000, true);
        buf.push_segment("We ship on Friday".into(), "Them".into(), 1_000, true);
        assert_eq!(buf.len(), 2);
        assert_eq!(buf.get_all_text(), "[Them]: We ship on Friday\n[You]: Sure");
        // Another speaker's line at the same time is its own segment.
        buf.push_segment("Hm".into(), "User".into(), 1_000, true);
        assert_eq!(buf.len(), 3);
    }
}
