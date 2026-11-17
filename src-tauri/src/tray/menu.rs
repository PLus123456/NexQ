use tauri::{
    menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem},
    AppHandle, Wry,
};

use crate::i18n::{tr, Text};

/// One row of a tray menu.
pub(crate) enum Entry {
    /// A clickable item: menu id (handled in lib.rs `on_menu_event`) and its
    /// text, shown in the current UI language.
    Item(&'static str, Text),
    /// "Hide from Screen Share" (stealth mode), checked while it is on.
    ScreenShare,
    Separator,
}

use Entry::{Item, ScreenShare, Separator};

/// Idle: opening the dashboard comes first, since NexQ has no taskbar
/// button under stealth mode and the tray is the way back to it.
pub(crate) const IDLE_MENU: &[Entry] = &[
    Item("open_dashboard", Text::OpenDashboard),
    Item("start_meeting", Text::StartMeeting),
    Separator,
    Item("copy_ai_answer", Text::CopyLastAiAnswer),
    Item("copy_action_items", Text::CopyActionItems),
    Item("copy_summary", Text::CopySummary),
    Item("copy_transcript", Text::CopyTranscript),
    Separator,
    ScreenShare,
    Item("settings", Text::Settings),
    Item("quit", Text::Quit),
];

/// During a meeting: back to the meeting or to the dashboard first.
pub(crate) const MEETING_MENU: &[Entry] = &[
    Item("show_overlay", Text::ShowOverlay),
    Item("open_dashboard", Text::OpenDashboard),
    Separator,
    Item("stop_meeting", Text::StopMeeting),
    Separator,
    Item("toggle_mic", Text::MuteMicrophone),
    Item("toggle_system", Text::MuteSystemAudio),
    Separator,
    ScreenShare,
    Item("toggle_stealth", Text::HideOverlay),
    Separator,
    Item("copy_ai_answer", Text::CopyLastAiAnswer),
    Item("copy_action_items", Text::CopyActionItems),
    Item("copy_summary", Text::CopySummary),
    Item("copy_transcript", Text::CopyTranscript),
    Separator,
    Item("settings", Text::Settings),
    Item("quit", Text::Quit),
];

fn build(app: &AppHandle, layout: &[Entry]) -> Result<Menu<Wry>, tauri::Error> {
    let mut items: Vec<Box<dyn IsMenuItem<Wry>>> = Vec::with_capacity(layout.len());
    for entry in layout {
        items.push(match entry {
            Item(id, text) => Box::new(MenuItem::with_id(app, *id, tr(*text), true, None::<&str>)?),
            ScreenShare => Box::new(CheckMenuItem::with_id(
                app,
                "toggle_screen_share_stealth",
                tr(Text::HideFromScreenShare),
                true,
                crate::commands::stealth_commands::stealth_enabled(),
                None::<&str>,
            )?),
            Separator => Box::new(PredefinedMenuItem::separator(app)?),
        });
    }
    let refs: Vec<&dyn IsMenuItem<Wry>> = items.iter().map(|i| i.as_ref()).collect();
    Menu::with_items(app, &refs)
}

/// Build the idle-state tray menu.
pub fn build_idle_menu(app: &AppHandle) -> Result<Menu<Wry>, tauri::Error> {
    build(app, IDLE_MENU)
}

/// Build the meeting-active tray menu.
pub fn build_meeting_menu(app: &AppHandle) -> Result<Menu<Wry>, tauri::Error> {
    build(app, MEETING_MENU)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(layout: &[Entry]) -> Vec<&'static str> {
        layout
            .iter()
            .filter_map(|e| match e {
                Entry::Item(id, _) => Some(*id),
                Entry::ScreenShare => Some("toggle_screen_share_stealth"),
                Entry::Separator => None,
            })
            .collect()
    }

    #[test]
    fn the_dashboard_is_first_in_both_menus() {
        assert_eq!(ids(IDLE_MENU)[0], "open_dashboard");
        assert_eq!(&ids(MEETING_MENU)[..2], ["show_overlay", "open_dashboard"]);
    }

    #[test]
    fn both_menus_keep_settings_and_quit_last() {
        for layout in [IDLE_MENU, MEETING_MENU] {
            assert_eq!(ids(layout)[ids(layout).len() - 2..], ["settings", "quit"]);
        }
    }
}
