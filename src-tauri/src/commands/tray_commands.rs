use tauri::{command, AppHandle, Manager};
use crate::state::AppState;
use crate::tray::{TrayState, tooltip};
use std::time::Instant;

/// Write from a tray click even when neither webview has focus.
#[command]
pub async fn write_tray_clipboard(text: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || write_clipboard(&text))
        .await
        .map_err(|err| err.to_string())?
}

#[cfg(any(target_os = "macos", windows))]
fn write_clipboard(text: &str) -> Result<(), String> {
    use std::{io::Write, process::{Command, Stdio}};
    #[cfg(target_os = "macos")]
    let (mut command, input) = {
        let mut command = Command::new("/usr/bin/pbcopy");
        command.env("LC_CTYPE", "en_US.UTF-8");
        (command, text.as_bytes().to_vec())
    };
    #[cfg(windows)]
    let (mut command, input) = {
        use std::os::windows::process::CommandExt;
        use windows::Win32::System::Threading::CREATE_NO_WINDOW;
        let root = std::env::var_os("SystemRoot").ok_or("Windows directory is unavailable")?;
        let mut command = Command::new(std::path::PathBuf::from(root).join("System32").join("clip.exe"));
        command.creation_flags(CREATE_NO_WINDOW.0);
        let input: Vec<u8> = std::iter::once(0xfeff).chain(text.encode_utf16())
            .flat_map(u16::to_le_bytes).collect();
        (command, input)
    };
    let mut process = command.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null())
        .spawn().map_err(|err| err.to_string())?;
    let write = process.stdin.take().ok_or("Clipboard input is unavailable")?.write_all(&input);
    let status = process.wait().map_err(|err| err.to_string())?;
    write.map_err(|err| err.to_string())?;
    if status.success() { Ok(()) } else { Err(format!("Clipboard command failed: {status}")) }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn write_clipboard(_text: &str) -> Result<(), String> {
    Err("Tray clipboard is unavailable on this platform".into())
}

/// Update the tray icon to reflect a new state.
#[command]
pub async fn set_tray_state(
    app: AppHandle,
    state: TrayState,
) -> Result<(), String> {
    let app_state = app.state::<AppState>();
    let mut mgr = app_state.tray_manager.lock().map_err(|e| e.to_string())?;
    let manager = mgr.as_mut().ok_or("TrayManager not initialized")?;

    // Cancel pulse timer if leaving recording state
    if manager.current_state == TrayState::Recording && state != TrayState::Recording {
        if let Some(h) = manager.pulse_timer.take() { h.abort(); }
    }

    manager.current_state = state;

    // Update icon — log errors but don't propagate (tray may not be ready during init)
    let icon = manager.icon_set.get(state);
    if let Some(tray) = app.tray_by_id("main") {
        if let Err(e) = tray.set_icon(Some(icon)) {
            log::warn!("Failed to set tray icon: {}", e);
        }
    }

    // Update tooltip — log errors but don't propagate
    let tooltip_text = tooltip::build_tooltip(
        state,
        manager.meeting_start_time,
        manager.is_muted,
        manager.custom_tooltip.as_deref(),
    );
    if let Some(tray) = app.tray_by_id("main") {
        if let Err(e) = tray.set_tooltip(Some(&tooltip_text)) {
            log::warn!("Failed to set tray tooltip: {}", e);
        }
    }

    // Start pulse animation for recording
    if state == TrayState::Recording {
        let tray_mgr_clone = app_state.tray_manager.clone();
        let app_clone = app.clone();
        let handle = tokio::spawn(async move {
            let mut bright = true;
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(750)).await;
                bright = !bright;
                let mgr = tray_mgr_clone.lock().unwrap();
                if let Some(ref m) = *mgr {
                    if m.current_state != TrayState::Recording { break; }
                    let icon = if bright {
                        m.icon_set.get(TrayState::Recording)
                    } else {
                        m.icon_set.get_recording_dim()
                    };
                    if let Some(tray) = app_clone.tray_by_id("main") {
                        let _ = tray.set_icon(Some(icon));
                    }
                } else { break; }
            }
        });
        // Need to re-acquire lock to store handle
        drop(mgr);
        let mut mgr = app_state.tray_manager.lock().map_err(|e| e.to_string())?;
        if let Some(ref mut m) = *mgr {
            m.pulse_timer = Some(handle);
        }
    }

    Ok(())
}

/// Set custom tooltip text (used for idle stats).
#[command]
pub async fn set_tray_tooltip(
    app: AppHandle,
    text: String,
) -> Result<(), String> {
    let app_state = app.state::<AppState>();
    let mut mgr = app_state.tray_manager.lock().map_err(|e| e.to_string())?;
    let manager = mgr.as_mut().ok_or("TrayManager not initialized")?;

    manager.custom_tooltip = if text.is_empty() { None } else { Some(text) };

    let tooltip_text = tooltip::build_tooltip(
        manager.current_state,
        manager.meeting_start_time,
        manager.is_muted,
        manager.custom_tooltip.as_deref(),
    );
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_tooltip(Some(&tooltip_text)).map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Set or clear the meeting start time (for Rust-side elapsed time tooltip).
#[command]
pub async fn set_meeting_start_time(
    app: AppHandle,
    started: bool,
) -> Result<(), String> {
    let app_state = app.state::<AppState>();
    let tray_mgr = app_state.tray_manager.clone();

    {
        let mut mgr = tray_mgr.lock().map_err(|e| e.to_string())?;
        let manager = mgr.as_mut().ok_or("TrayManager not initialized")?;

        if started {
            manager.meeting_start_time = Some(Instant::now());
            manager.meeting_active = true;

            // Cancel any existing tooltip timer
            if let Some(h) = manager.tooltip_timer.take() { h.abort(); }
        } else {
            manager.meeting_start_time = None;
            manager.meeting_active = false;

            // Cancel tooltip timer
            if let Some(h) = manager.tooltip_timer.take() { h.abort(); }
            return Ok(());
        }
    }

    // Start tooltip update timer (every 5 seconds)
    let app_clone = app.clone();
    let timer_tray = tray_mgr.clone();
    let handle = tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            let mgr = timer_tray.lock().unwrap();
            if let Some(ref m) = *mgr {
                if m.meeting_start_time.is_none() { break; }
                let text = tooltip::build_tooltip(
                    m.current_state,
                    m.meeting_start_time,
                    m.is_muted,
                    m.custom_tooltip.as_deref(),
                );
                if let Some(tray) = app_clone.tray_by_id("main") {
                    let _ = tray.set_tooltip(Some(&text));
                }
            } else { break; }
        }
    });

    let mut mgr = tray_mgr.lock().map_err(|e| e.to_string())?;
    if let Some(ref mut m) = *mgr {
        m.tooltip_timer = Some(handle);
    }

    Ok(())
}

/// Rebuild the tray menu for the current state (idle vs meeting).
#[command]
pub async fn rebuild_tray_menu(
    app: AppHandle,
    meeting_active: bool,
) -> Result<(), String> {
    let menu = if meeting_active {
        crate::tray::menu::build_meeting_menu(&app).map_err(|e| e.to_string())?
    } else {
        crate::tray::menu::build_idle_menu(&app).map_err(|e| e.to_string())?
    };

    if let Some(tray) = app.tray_by_id("main") {
        if let Err(e) = tray.set_menu(Some(menu)) {
            log::warn!("Failed to set tray menu: {}", e);
        }
    }

    Ok(())
}
