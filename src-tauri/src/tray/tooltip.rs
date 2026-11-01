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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::{set_current, UiLanguage};
    use crate::tray::TrayState;

    // The only test that changes the global UI language; it puts English back.
    #[test]
    fn tooltip_follows_the_ui_language() {
        assert_eq!(build_tooltip(TrayState::Idle, None, false, None), "NexQ Plus — Idle");
        assert_eq!(
            build_tooltip(TrayState::Recording, None, true, None),
            "NexQ Plus — Recording (Mic Muted) · 00:00 elapsed"
        );

        set_current(UiLanguage::ZhCn);
        let idle = build_tooltip(TrayState::Idle, None, false, Some("3 场会议"));
        let stealth = build_tooltip(TrayState::Stealth, None, false, None);
        let indexing = build_tooltip(TrayState::Indexing, None, false, None);
        set_current(UiLanguage::En);

        assert_eq!(idle, "NexQ Plus — 空闲 · 3 场会议");
        assert_eq!(stealth, "NexQ Plus — 录音中（悬浮窗已隐藏） · 已进行 00:00");
        assert_eq!(indexing, "NexQ Plus — 正在建立索引…");
    }
}
