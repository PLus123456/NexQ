//! UI language on the Rust side: the text Rust shows itself (tray menu and
//! tooltip) and the language other modules read (`current_ui_language()`,
//! e.g. the LLM package's "answer in the UI language").
//!
//! The frontend owns the setting (`uiLanguage` in `config.json`: `"system"`,
//! `"zh-CN"` or `"en"`) and pushes the resolved language with
//! `set_ui_language` whenever it changes. At startup Rust reads the stored
//! value once so the tray doesn't flash English; for `"system"` it waits for
//! the frontend's push instead of detecting the OS language itself.

use std::sync::atomic::{AtomicU8, Ordering};

use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

/// Product name (the frontend's `APP_NAME`).
pub const APP_NAME: &str = "NexQ Plus";

const STORE_FILE: &str = "config.json";
const UI_LANGUAGE_KEY: &str = "uiLanguage";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UiLanguage {
    En,
    ZhCn,
}

impl UiLanguage {
    /// BCP 47 code, as the frontend names it.
    pub fn code(self) -> &'static str {
        match self {
            Self::En => "en",
            Self::ZhCn => "zh-CN",
        }
    }

    /// A resolved language (`"zh-CN"`, `"zh"`, `"zh_Hans"`, `"en-US"`…).
    /// `None` for `"system"` and anything unrecognised.
    pub fn parse(value: &str) -> Option<Self> {
        let value = value.trim().to_ascii_lowercase().replace('_', "-");
        if value == "zh" || value.starts_with("zh-") {
            Some(Self::ZhCn)
        } else if value == "en" || value.starts_with("en-") {
            Some(Self::En)
        } else {
            None
        }
    }

    fn to_u8(self) -> u8 {
        match self {
            Self::En => 0,
            Self::ZhCn => 1,
        }
    }

    fn from_u8(value: u8) -> Self {
        match value {
            1 => Self::ZhCn,
            _ => Self::En,
        }
    }
}

static CURRENT: AtomicU8 = AtomicU8::new(0);

/// The language the UI is shown in right now.
pub fn current_ui_language() -> UiLanguage {
    UiLanguage::from_u8(CURRENT.load(Ordering::Relaxed))
}

/// Sets the current language; true when it changed.
pub fn set_current(lang: UiLanguage) -> bool {
    CURRENT.swap(lang.to_u8(), Ordering::Relaxed) != lang.to_u8()
}

/// Applies the stored `uiLanguage` (explicit choices only; see module docs).
pub fn load_from_config(app: &AppHandle) {
    let stored = app
        .store(STORE_FILE)
        .ok()
        .and_then(|store| store.get(UI_LANGUAGE_KEY))
        .and_then(|value| value.as_str().map(str::to_string));
    if let Some(lang) = stored.as_deref().and_then(UiLanguage::parse) {
        set_current(lang);
    }
}

/// Fixed text shown by Rust.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Text {
    StartMeeting,
    StopMeeting,
    MuteMicrophone,
    MuteSystemAudio,
    HideFromScreenShare,
    HideOverlay,
    ShowOverlay,
    CopyLastAiAnswer,
    CopyActionItems,
    CopySummary,
    CopyTranscript,
    Settings,
    Quit,
    Idle,
    Recording,
    RecordingMicMuted,
    RecordingOverlayHidden,
    AiProcessing,
    IndexingFiles,
}

/// `text` in the current language.
pub fn tr(text: Text) -> &'static str {
    tr_in(current_ui_language(), text)
}

pub fn tr_in(lang: UiLanguage, text: Text) -> &'static str {
    match lang {
        UiLanguage::En => match text {
            Text::StartMeeting => "Start Meeting",
            Text::StopMeeting => "Stop Meeting",
            Text::MuteMicrophone => "Mute Microphone",
            Text::MuteSystemAudio => "Mute System Audio",
            Text::HideFromScreenShare => "Hide from Screen Share",
            Text::HideOverlay => "Hide Overlay",
            Text::ShowOverlay => "Show Overlay",
            Text::CopyLastAiAnswer => "Copy Last AI Answer",
            Text::CopyActionItems => "Copy Action Items",
            Text::CopySummary => "Copy Summary",
            Text::CopyTranscript => "Copy Transcript",
            Text::Settings => "Settings",
            Text::Quit => "Quit NexQ Plus",
            Text::Idle => "Idle",
            Text::Recording => "Recording",
            Text::RecordingMicMuted => "Recording (Mic Muted)",
            Text::RecordingOverlayHidden => "Recording (Overlay Hidden)",
            Text::AiProcessing => "AI Processing...",
            Text::IndexingFiles => "Indexing files...",
        },
        UiLanguage::ZhCn => match text {
            Text::StartMeeting => "开始会议",
            Text::StopMeeting => "结束会议",
            Text::MuteMicrophone => "麦克风静音",
            Text::MuteSystemAudio => "系统音频静音",
            Text::HideFromScreenShare => "共享屏幕时隐藏",
            Text::HideOverlay => "隐藏悬浮窗",
            Text::ShowOverlay => "显示悬浮窗",
            Text::CopyLastAiAnswer => "复制最新的 AI 回答",
            Text::CopyActionItems => "复制待办事项",
            Text::CopySummary => "复制会议总结",
            Text::CopyTranscript => "复制转写记录",
            Text::Settings => "设置",
            Text::Quit => "退出 NexQ Plus",
            Text::Idle => "空闲",
            Text::Recording => "录音中",
            Text::RecordingMicMuted => "录音中（麦克风已静音）",
            Text::RecordingOverlayHidden => "录音中（悬浮窗已隐藏）",
            Text::AiProcessing => "AI 处理中…",
            Text::IndexingFiles => "正在建立索引…",
        },
    }
}

/// "{elapsed} elapsed" for the recording tooltip.
pub fn elapsed_label(elapsed: &str) -> String {
    match current_ui_language() {
        UiLanguage::En => format!("{elapsed} elapsed"),
        UiLanguage::ZhCn => format!("已进行 {elapsed}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_resolved_languages() {
        assert_eq!(UiLanguage::parse("zh-CN"), Some(UiLanguage::ZhCn));
        assert_eq!(UiLanguage::parse("zh"), Some(UiLanguage::ZhCn));
        assert_eq!(UiLanguage::parse("zh_Hans_CN"), Some(UiLanguage::ZhCn));
        assert_eq!(UiLanguage::parse(" EN-us "), Some(UiLanguage::En));
        assert_eq!(UiLanguage::parse("en"), Some(UiLanguage::En));
        assert_eq!(UiLanguage::parse("system"), None);
        assert_eq!(UiLanguage::parse("ja"), None);
        assert_eq!(UiLanguage::parse(""), None);
    }

    #[test]
    fn codes_round_trip() {
        for lang in [UiLanguage::En, UiLanguage::ZhCn] {
            assert_eq!(UiLanguage::parse(lang.code()), Some(lang));
            assert_eq!(UiLanguage::from_u8(lang.to_u8()), lang);
        }
    }

    #[test]
    fn every_text_has_both_languages() {
        let all = [
            Text::StartMeeting, Text::StopMeeting, Text::MuteMicrophone, Text::MuteSystemAudio,
            Text::HideFromScreenShare, Text::HideOverlay, Text::ShowOverlay, Text::CopyLastAiAnswer,
            Text::CopyActionItems, Text::CopySummary, Text::CopyTranscript, Text::Settings, Text::Quit,
            Text::Idle, Text::Recording, Text::RecordingMicMuted, Text::RecordingOverlayHidden,
            Text::AiProcessing, Text::IndexingFiles,
        ];
        for text in all {
            assert!(!tr_in(UiLanguage::En, text).is_empty());
            assert!(!tr_in(UiLanguage::ZhCn, text).is_empty());
            assert_ne!(tr_in(UiLanguage::En, text), tr_in(UiLanguage::ZhCn, text), "{text:?}");
        }
        assert!(tr_in(UiLanguage::ZhCn, Text::Quit).contains(APP_NAME));
    }
}
