use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    AppHandle,
};

use crate::i18n::{tr, Text};

/// "Hide from Screen Share" (stealth mode), checked while it is on.
fn screen_share_item(app: &AppHandle) -> Result<CheckMenuItem<tauri::Wry>, tauri::Error> {
    CheckMenuItem::with_id(
        app,
        "toggle_screen_share_stealth",
        tr(Text::HideFromScreenShare),
        true,
        crate::commands::stealth_commands::stealth_enabled(),
        None::<&str>,
    )
}

fn item(app: &AppHandle, id: &str, text: Text) -> Result<MenuItem<tauri::Wry>, tauri::Error> {
    MenuItem::with_id(app, id, tr(text), true, None::<&str>)
}

/// Build the idle-state tray menu.
pub fn build_idle_menu(app: &AppHandle) -> Result<Menu<tauri::Wry>, tauri::Error> {
    let start = item(app, "start_meeting", Text::StartMeeting)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let copy_ai = item(app, "copy_ai_answer", Text::CopyLastAiAnswer)?;
    let copy_actions = item(app, "copy_action_items", Text::CopyActionItems)?;
    let copy_summary = item(app, "copy_summary", Text::CopySummary)?;
    let copy_transcript = item(app, "copy_transcript", Text::CopyTranscript)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let screen_share = screen_share_item(app)?;
    let settings = item(app, "settings", Text::Settings)?;
    let quit = item(app, "quit", Text::Quit)?;

    Menu::with_items(app, &[
        &start, &sep1,
        &copy_ai, &copy_actions, &copy_summary, &copy_transcript, &sep2,
        &screen_share, &settings, &quit,
    ])
}

/// Build the meeting-active tray menu.
pub fn build_meeting_menu(app: &AppHandle) -> Result<Menu<tauri::Wry>, tauri::Error> {
    let stop = item(app, "stop_meeting", Text::StopMeeting)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let mute_mic = item(app, "toggle_mic", Text::MuteMicrophone)?;
    let mute_sys = item(app, "toggle_system", Text::MuteSystemAudio)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let screen_share = screen_share_item(app)?;
    let stealth = item(app, "toggle_stealth", Text::HideOverlay)?;
    let show_overlay = item(app, "show_overlay", Text::ShowOverlay)?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    let copy_ai = item(app, "copy_ai_answer", Text::CopyLastAiAnswer)?;
    let copy_actions = item(app, "copy_action_items", Text::CopyActionItems)?;
    let copy_summary = item(app, "copy_summary", Text::CopySummary)?;
    let copy_transcript = item(app, "copy_transcript", Text::CopyTranscript)?;
    let sep4 = PredefinedMenuItem::separator(app)?;
    let settings = item(app, "settings", Text::Settings)?;
    let quit = item(app, "quit", Text::Quit)?;

    Menu::with_items(app, &[
        &stop, &sep1,
        &mute_mic, &mute_sys, &sep2,
        &screen_share, &stealth, &show_overlay, &sep3,
        &copy_ai, &copy_actions, &copy_summary, &copy_transcript, &sep4,
        &settings, &quit,
    ])
}
