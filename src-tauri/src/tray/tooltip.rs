use std::time::Instant;

/// Format elapsed time as "MM:SS" or "H:MM:SS".
pub fn format_elapsed(start: Instant) -> String {
    let secs = start.elapsed().as_secs();
    let h = secs / 3600;
    let m = (secs % 3600) / 60;
    let s = secs % 60;
    if h > 0 {
        format!("{}:{:02}:{:02}", h, m, s)
    } else {
        format!("{:02}:{:02}", m, s)
    }
}

/// Build tooltip text based on current state (in the current UI language).
pub fn build_tooltip(
    state: super::TrayState,
    meeting_start: Option<Instant>,
    is_muted: bool,
    custom_text: Option<&str>,
) -> String {
    use super::TrayState;
    use crate::i18n::{elapsed_label, tr, Text, APP_NAME};

    let elapsed = || {
        let elapsed = meeting_start
            .map(format_elapsed)
            .unwrap_or_else(|| "00:00".to_string());
        elapsed_label(&elapsed)
    };

    match state {
        TrayState::Idle => {
            if let Some(text) = custom_text {
                format!("{APP_NAME} — {} · {}", tr(Text::Idle), text)
            } else {
                format!("{APP_NAME} — {}", tr(Text::Idle))
            }
        }
        TrayState::Recording => {
            let label = if is_muted { Text::RecordingMicMuted } else { Text::Recording };
            format!("{APP_NAME} — {} · {}", tr(label), elapsed())
        }
        TrayState::Muted => {
            format!("{APP_NAME} — {} · {}", tr(Text::RecordingMicMuted), elapsed())
        }
        TrayState::Stealth => {
            format!("{APP_NAME} — {} · {}", tr(Text::RecordingOverlayHidden), elapsed())
        }
        TrayState::AiProcessing => format!("{APP_NAME} — {}", tr(Text::AiProcessing)),
        TrayState::Indexing => {
            if let Some(text) = custom_text {
                format!("{APP_NAME} — {}", text)
            } else {
                format!("{APP_NAME} — {}", tr(Text::IndexingFiles))
            }
        }
    }
}
