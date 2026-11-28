use std::ffi::OsStr;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{command, AppHandle, Emitter, ExitRequestApi, Listener, Manager, State};
use tauri_plugin_store::StoreExt;
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::state::AppState;

/// Plugin-store file and keys for the updater preferences ("Automatic updates",
/// "Skip this version"). Written by the frontend (`useUpdater`); read at quit.
const SETTINGS_STORE: &str = "nexq-settings.json";
const AUTO_UPDATE_KEY: &str = "auto_update";
const SKIPPED_VERSION_KEY: &str = "skipped_version";

const UPDATE_CHECK_LIMIT: Duration = Duration::from_secs(8);
const UPDATE_DOWNLOAD_LIMIT: Duration = Duration::from_secs(120);
/// How long Restart waits for the last recording to finish saving.
const RECORDING_WAIT_LIMIT: Duration = Duration::from_secs(120);
/// A quit during startup waits for capture to connect and drain before saving.
const MEETING_END_LIMIT: Duration = Duration::from_secs(120);
/// How long quit waits for the last recording before leaving the app open.
const QUIT_RECORDING_WAIT_LIMIT: Duration = Duration::from_secs(600);

/// Passed to the installer for an install on quit. The NSIS installer
/// forwards everything after `/ARGS` to the NexQ it relaunches (`/R`), and
/// a NexQ started with this argument exits at once (`run`), so quitting
/// with an update installs it without reopening the app.
pub const POST_UPDATE_QUIT_ARG: &str = "--nexq-post-update-quit";

/// True when the process was relaunched by an update installed on quit.
pub fn is_post_update_quit<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    args.into_iter()
        .any(|a| a.as_ref() == OsStr::new(POST_UPDATE_QUIT_ARG))
}

const QUIT_IDLE: u8 = 0;
const QUIT_SAVING: u8 = 1;
const QUIT_READY: u8 = 2;
static QUIT_STATE: AtomicU8 = AtomicU8::new(QUIT_IDLE);

/// Information about an available update.
#[derive(Debug, Clone, Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub body: Option<String>,
    pub date: Option<String>,
}

impl UpdateInfo {
    fn from_update(update: &Update) -> Self {
        Self {
            version: update.version.clone(),
            body: update.body.clone(),
            date: update.date.map(|d| d.to_string()),
        }
    }
}

/// A downloaded update waiting to be installed (on Restart or on quit).
pub struct PendingUpdate {
    /// Installs and reopens NexQ (Restart).
    pub update: Update,
    /// The same release with [`POST_UPDATE_QUIT_ARG`] for the installer
    /// (installs on quit without reopening). `None` if it couldn't be
    /// fetched; quit then installs with `update`.
    pub quit_update: Option<Update>,
    pub bytes: Vec<u8>,
    pub info: UpdateInfo,
}

/// Check for an available update.
///
/// Returns `Some(UpdateInfo)` if a newer version is available, or `None` if the
/// app is already up-to-date.
#[command]
pub async fn check_for_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    Ok(check_latest(&app)
        .await?
        .as_ref()
        .map(UpdateInfo::from_update))
}

async fn check_latest(app: &AppHandle) -> Result<Option<Update>, String> {
    let updater = app
        .updater()
        .map_err(|e| format!("Failed to get updater: {}", e))?;
    tokio::time::timeout(UPDATE_CHECK_LIMIT, updater.check())
        .await
        .map_err(|_| "Checking for an update timed out".to_string())?
        .map_err(|e| format!("Failed to check for update: {e}"))
}

/// Download the latest update in the background and keep the bytes in
/// `AppState.pending_update` (nothing is installed yet).
///
/// Broadcasts the start and progress of a download, then its result.
#[command]
pub async fn download_update(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<UpdateInfo, String> {
    let _download = state
        .update_download
        .try_lock()
        .map_err(|_| "An update download is already in progress".to_string())?;
    let result = tokio::time::timeout(UPDATE_DOWNLOAD_LIMIT, download_into_pending(&app, &state))
        .await
        .unwrap_or_else(|_| Err("Downloading the update timed out".to_string()));
    let _ = match &result {
        Ok(info) => app.emit("update_downloaded", info),
        Err(message) => app.emit(
            "update_download_failed",
            serde_json::json!({ "message": message }),
        ),
    };
    result
}

async fn download_into_pending(app: &AppHandle, state: &AppState) -> Result<UpdateInfo, String> {
    let update = check_latest(app)
        .await?
        .ok_or_else(|| "No update available".to_string())?;
    let info = UpdateInfo::from_update(&update);

    // Already downloaded this version — nothing to do.
    if let Ok(pending) = state.pending_update.lock() {
        if let Some(p) = pending.as_ref() {
            if p.info.version == info.version {
                return Ok(p.info.clone());
            }
        }
    }

    let _ = app.emit("update_download_started", &info);
    let progress_app = app.clone();
    let bytes = update
        .download(
            move |chunk_length, content_length| {
                let _ = progress_app.emit(
                    "update_download_progress",
                    serde_json::json!({
                        "chunk_length": chunk_length,
                        "content_length": content_length,
                    }),
                );
            },
            || {},
        )
        .await
        .map_err(|e| format!("Failed to download update: {}", e))?;

    log::info!(
        "Update v{} downloaded ({} bytes)",
        info.version,
        bytes.len()
    );
    #[cfg(target_os = "windows")]
    let quit_update = quit_variant(app, &info.version).await;
    #[cfg(not(target_os = "windows"))]
    let quit_update = None;

    *state
        .pending_update
        .lock()
        .map_err(|e| format!("Failed to lock pending update: {}", e))? = Some(PendingUpdate {
        update,
        quit_update,
        bytes,
        info: info.clone(),
    });

    Ok(info)
}

/// `version` as an [`Update`] whose installer gets [`POST_UPDATE_QUIT_ARG`]
/// (installer arguments are fixed when the updater is built).
#[cfg(target_os = "windows")]
async fn quit_variant(app: &AppHandle, version: &str) -> Option<Update> {
    let checked = match app
        .updater_builder()
        .installer_arg(POST_UPDATE_QUIT_ARG)
        .timeout(UPDATE_CHECK_LIMIT)
        .build()
    {
        Ok(updater) => updater.check().await.map_err(|e| e.to_string()),
        Err(e) => Err(e.to_string()),
    };
    match checked {
        Ok(Some(update)) if update.version == version => Some(update),
        Ok(_) => {
            log::warn!("Install-on-quit variant of v{version} not found; quit will reopen NexQ after installing");
            None
        }
        Err(e) => {
            log::warn!("Install-on-quit variant of v{version} unavailable ({e}); quit will reopen NexQ after installing");
            None
        }
    }
}

/// The downloaded update waiting to be installed, if any.
#[command]
pub async fn get_pending_update(state: State<'_, AppState>) -> Result<Option<UpdateInfo>, String> {
    let pending = state
        .pending_update
        .lock()
        .map_err(|e| format!("Failed to lock pending update: {}", e))?;
    Ok(pending.as_ref().map(|p| p.info.clone()))
}

/// Install the downloaded update now. On Windows the NSIS installer is launched
/// in passive mode (`/P /R`: progress only, relaunches NexQ) and this process
/// exits, so on success this never returns. On macOS the bundle is replaced
/// in place and NexQ restarts itself. (Install on quit passes
/// [`POST_UPDATE_QUIT_ARG`] so the relaunched NexQ exits at once.)
///
/// Waits (up to 2 min) for post-meeting recording pipelines first, so ending a
/// meeting right before the restart doesn't lose its recording.
/// Refuses while a meeting is active, or if the recording is still saving
/// after the wait.
#[command]
pub async fn install_update_now(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let _lifecycle = state
        .meeting_lifecycle
        .try_lock()
        .map_err(|_| "A meeting or update is already in progress".to_string())?;
    if quit_pending() {
        return Err("NexQ is already quitting".to_string());
    }
    if state.meeting_active.load(Ordering::SeqCst) {
        return Err("End the meeting before updating".to_string());
    }
    if !wait_for_recordings(&state, RECORDING_WAIT_LIMIT).await {
        return Err("Still saving the last recording — try again in a moment".to_string());
    }
    if quit_pending() {
        return Err("NexQ is already quitting".to_string());
    }
    {
        let pending = state
            .pending_update
            .lock()
            .map_err(|e| format!("Failed to lock pending update: {e}"))?;
        let update = pending.as_ref().ok_or("No downloaded update to install")?;
        install_downloaded(update, InstallFor::Restart)?;
    }
    // macOS replaces the app bundle in place and returns: relaunch it.
    #[cfg(not(target_os = "windows"))]
    app.restart();
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        Ok(())
    }
}

/// Wait until no post-meeting recording pipeline is running. Returns false on timeout.
async fn wait_for_recordings(state: &AppState, limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    while state.recording_jobs.load(Ordering::SeqCst) > 0 {
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    true
}

/// Why the downloaded update is installed.
#[derive(Clone, Copy)]
enum InstallFor {
    /// Restart pill: NexQ reopens after installing.
    Restart,
    /// Quit: the installer's relaunch exits at once.
    Quit,
}

fn install_downloaded(p: &PendingUpdate, why: InstallFor) -> Result<(), String> {
    let update = match why {
        InstallFor::Quit => p.quit_update.as_ref().unwrap_or(&p.update),
        InstallFor::Restart => &p.update,
    };

    log::info!("Installing update v{}...", p.info.version);
    // The plugin's default `on_before_exit` hook runs `cleanup_before_exit`
    // (drops plugin stores, flushing pending saves; clears the tray icon)
    // before the process exits.
    update
        .install(&p.bytes)
        .map_err(|e| format!("Failed to install update: {}", e))
}

/// True while a quit is saving the meeting and its recordings or exiting.
/// Tray actions that would start new work are ignored meanwhile.
pub fn quit_pending() -> bool {
    QUIT_STATE.load(Ordering::SeqCst) != QUIT_IDLE
}

/// Whether a quit is deferred (waiting for meeting data to save), so
/// the frontend doesn't start a meeting meanwhile (e.g. Ctrl+M).
#[command]
pub fn is_quit_pending() -> bool {
    quit_pending()
}

/// `RunEvent::ExitRequested` handler (tray Quit calls `app.exit(0)`).
pub fn on_exit_requested(app: &AppHandle, api: &ExitRequestApi, code: i32) {
    match QUIT_STATE.compare_exchange(QUIT_IDLE, QUIT_SAVING, Ordering::SeqCst, Ordering::SeqCst) {
        Ok(_) => {
            api.prevent_exit();
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                match prepare_quit(&app).await {
                    Ok(()) => {
                        QUIT_STATE.store(QUIT_READY, Ordering::SeqCst);
                        app.exit(code);
                    }
                    Err(e) => {
                        log::warn!("Quit deferred work failed, leaving NexQ open: {e}");
                        QUIT_STATE.store(QUIT_IDLE, Ordering::SeqCst);
                        let _ = app.emit("nexq:quit_failed", ());
                    }
                }
            });
        }
        Err(QUIT_READY) => {}
        Err(_) => api.prevent_exit(),
    }
}

async fn prepare_quit(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let meeting_id = {
        let _lifecycle = state.meeting_lifecycle.lock().await;
        let live = state
            .live_meeting
            .lock()
            .map_err(|_| "Live meeting lock poisoned")?;
        live.as_ref().map(|meeting| meeting.id.clone())
    };
    if let Some(meeting_id) = meeting_id {
        end_meeting_on_quit(app, &state, &meeting_id).await?;
    }
    if !wait_for_recordings(&state, QUIT_RECORDING_WAIT_LIMIT).await {
        return Err("The recording is still saving".to_string());
    }

    let _lifecycle = state.meeting_lifecycle.lock().await;
    if state.meeting_active.load(Ordering::SeqCst) {
        return Err("The meeting is still active".to_string());
    }
    if let Err(e) = install_on_quit(app, &state) {
        log::error!("Install on quit failed: {e}");
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MeetingEndEvent {
    meeting_id: String,
    window: Option<String>,
    message: Option<String>,
}

async fn end_meeting_on_quit(
    app: &AppHandle,
    state: &AppState,
    meeting_id: &str,
) -> Result<(), String> {
    let (send, mut receive) = tokio::sync::mpsc::channel(1);
    let send_failed = send.clone();
    let expected_id = meeting_id.to_string();
    let ended = app.listen_any("nexq:meeting_ended", move |event| {
        if let Ok(payload) = serde_json::from_str::<MeetingEndEvent>(event.payload()) {
            if payload.meeting_id == expected_id && payload.window.as_deref() == Some("launcher") {
                let _ = send.try_send(Ok(()));
            }
        }
    });
    let expected_id = meeting_id.to_string();
    let failed = app.listen_any("nexq:meeting_end_failed", move |event| {
        if let Ok(payload) = serde_json::from_str::<MeetingEndEvent>(event.payload()) {
            if payload.meeting_id == expected_id {
                let message = payload
                    .message
                    .unwrap_or_else(|| "The meeting could not be saved".to_string());
                let _ = send_failed.try_send(Err(message));
            }
        }
    });

    let mut retry = tokio::time::interval(Duration::from_secs(2));
    let result = tokio::time::timeout(MEETING_END_LIMIT, async {
        loop {
            tokio::select! {
                Some(outcome) = receive.recv() => return outcome,
                _ = retry.tick() => {
                    if !state.meeting_active.load(Ordering::SeqCst) {
                        return Ok(());
                    }
                    // The launcher may still be finishing start. Its end flow
                    // coalesces repeated stop requests for this meeting.
                    app.emit_to("launcher", "tray_stop_meeting", serde_json::json!({ "meetingId": meeting_id }))
                        .map_err(|e| format!("Couldn't request meeting shutdown: {e}"))?;
                }
            }
        }
    }).await;
    app.unlisten(ended);
    app.unlisten(failed);
    result.unwrap_or_else(|_| Err("Timed out waiting for the meeting to be saved".to_string()))
}

fn install_on_quit(app: &AppHandle, state: &AppState) -> Result<(), String> {
    if !auto_update_enabled(app) {
        return Ok(());
    }
    let skipped = skipped_version(app);
    let pending = state
        .pending_update
        .lock()
        .map_err(|e| format!("Failed to lock pending update: {e}"))?;
    if let Some(update) = pending.as_ref() {
        if skipped.as_deref() != Some(update.info.version.as_str()) {
            install_downloaded(update, InstallFor::Quit)?;
        }
    }
    Ok(())
}

fn setting(app: &AppHandle, key: &str) -> Option<serde_json::Value> {
    app.store(SETTINGS_STORE)
        .ok()
        .and_then(|store| store.get(key))
}

/// "Automatic updates" preference; defaults to on when unset or unreadable.
fn auto_update_enabled(app: &AppHandle) -> bool {
    setting(app, AUTO_UPDATE_KEY)
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

fn skipped_version(app: &AppHandle) -> Option<String> {
    setting(app, SKIPPED_VERSION_KEY).and_then(|v| v.as_str().map(str::to_string))
}

#[cfg(test)]
mod tests {
    use super::{
        is_post_update_quit, wait_for_recordings, AppState, Duration, Ordering,
        POST_UPDATE_QUIT_ARG,
    };

    #[test]
    fn relaunch_after_install_on_quit_is_recognised() {
        assert!(is_post_update_quit([
            r"C:\NexQ\nexq.exe",
            POST_UPDATE_QUIT_ARG
        ]));
        assert!(is_post_update_quit(vec![
            std::ffi::OsString::from("nexq.exe"),
            std::ffi::OsString::from("--flag"),
            std::ffi::OsString::from(POST_UPDATE_QUIT_ARG),
        ]));
    }

    #[test]
    fn normal_launch_and_restart_relaunch_are_not_post_update_quit() {
        assert!(!is_post_update_quit(["nexq.exe"]));
        assert!(!is_post_update_quit(Vec::<String>::new()));
        assert!(!is_post_update_quit([
            "nexq.exe",
            "--nexq-post-update-quit-later"
        ]));
    }

    #[tokio::test]
    async fn only_finishes_waiting_when_recording_jobs_are_drained() {
        let state = AppState::new();
        state.recording_jobs.store(1, Ordering::SeqCst);
        assert!(!wait_for_recordings(&state, Duration::ZERO).await);
        state.recording_jobs.store(0, Ordering::SeqCst);
        assert!(wait_for_recordings(&state, Duration::ZERO).await);
    }
}
