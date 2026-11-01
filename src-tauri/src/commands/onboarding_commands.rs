//! First-run setup (NexQ Plus): opens the system settings page where the
//! user grants a permission the audio check found missing. Only the pages
//! listed here can be opened; the frontend never passes a URL.

use tauri::command;

/// The settings page for `pane`: "microphone", or "system_audio" (macOS
/// lists apps that capture system audio under Screen & System Audio
/// Recording). Windows needs no permission for loopback capture.
#[cfg(target_os = "macos")]
fn privacy_settings_url(pane: &str) -> Option<&'static str> {
    match pane {
        "microphone" => Some("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"),
        "system_audio" => Some("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"),
        _ => None,
    }
}

#[cfg(target_os = "windows")]
fn privacy_settings_url(pane: &str) -> Option<&'static str> {
    match pane {
        "microphone" => Some("ms-settings:privacy-microphone"),
        _ => None,
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn privacy_settings_url(_pane: &str) -> Option<&'static str> {
    None
}

/// The program that opens a settings URL.
fn opener() -> &'static str {
    if cfg!(target_os = "windows") {
        "explorer"
    } else {
        "open"
    }
}

/// Opens the system settings page for a privacy permission (see
/// `privacy_settings_url` for the panes).
#[command]
pub async fn open_privacy_settings(pane: String) -> Result<(), String> {
    let url = privacy_settings_url(&pane)
        .ok_or_else(|| format!("No system settings page for \"{pane}\" on this system"))?;
    tokio::task::spawn_blocking(move || {
        // explorer.exe exits with 1 even when it opened the page: only a
        // failure to start counts.
        std::process::Command::new(opener()).arg(url).status().map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("Couldn't open the system settings: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_listed_panes_have_a_page() {
        assert_eq!(privacy_settings_url(""), None);
        assert_eq!(privacy_settings_url("camera"), None);
        assert_eq!(privacy_settings_url("x-apple.systempreferences:anything"), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_pages() {
        assert!(privacy_settings_url("microphone").unwrap().ends_with("?Privacy_Microphone"));
        assert!(privacy_settings_url("system_audio").unwrap().ends_with("?Privacy_ScreenCapture"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_pages() {
        assert_eq!(privacy_settings_url("microphone"), Some("ms-settings:privacy-microphone"));
        assert_eq!(privacy_settings_url("system_audio"), None);
    }

    #[tokio::test]
    async fn an_unknown_pane_is_refused_without_opening_anything() {
        let err = open_privacy_settings("camera".into()).await.unwrap_err();
        assert!(err.contains("camera"));
    }
}
