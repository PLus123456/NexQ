//! UI language (NexQ Plus): the frontend pushes its resolved language so the
//! text Rust shows (tray menu, tooltip) follows it.

use tauri::{command, AppHandle, Manager};

use crate::i18n::{self, UiLanguage};
use crate::state::AppState;
use crate::tray::{menu, tooltip};

/// Sets the language of Rust-side text (`"zh-CN"` or `"en"`; the frontend
/// resolves `"system"` first) and refreshes the tray when it changed.
#[command]
pub async fn set_ui_language(app: AppHandle, lang: String) -> Result<(), String> {
    let lang = UiLanguage::parse(&lang).ok_or_else(|| format!("Unsupported UI language: {lang}"))?;
    if i18n::set_current(lang) {
        refresh_tray(&app);
    }
    Ok(())
}

/// Rebuilds the tray menu for the current state and re-renders the tooltip.
pub fn refresh_tray(app: &AppHandle) {
    let state = app.state::<AppState>();
    let (meeting_active, tooltip_text) = match state.tray_manager.lock() {
        Ok(guard) => match guard.as_ref() {
            Some(m) => (
                m.meeting_active,
                Some(tooltip::build_tooltip(
                    m.current_state,
                    m.meeting_start_time,
                    m.is_muted,
                    m.custom_tooltip.as_deref(),
                )),
            ),
            None => (false, None),
        },
        Err(_) => return,
    };

    let Some(tray) = app.tray_by_id("main") else { return };
    let built = if meeting_active {
        menu::build_meeting_menu(app)
    } else {
        menu::build_idle_menu(app)
    };
    match built {
        Ok(menu) => {
            if let Err(e) = tray.set_menu(Some(menu)) {
                log::warn!("Failed to set tray menu: {}", e);
            }
        }
        Err(e) => log::warn!("Failed to build tray menu: {}", e),
    }
    if let Some(text) = tooltip_text {
        if let Err(e) = tray.set_tooltip(Some(&text)) {
            log::warn!("Failed to set tray tooltip: {}", e);
        }
    }
}
