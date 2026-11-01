//! App directories, recorded once at startup so code that runs without an
//! `AppHandle` (the recorder, for one) uses the same per-identifier folder as
//! everything else (`~/Library/Application Support/com.plus.nexq` on macOS,
//! `%APPDATA%\com.plus.nexq` on Windows).

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static APP_DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Records Tauri's `app_data_dir()`. Called once in setup; later calls are ignored.
pub fn init(app_data_dir: PathBuf) {
    let _ = APP_DATA_DIR.set(app_data_dir);
}

/// The app data directory, once `init` has run.
pub fn app_data_dir() -> Option<&'static Path> {
    APP_DATA_DIR.get().map(PathBuf::as_path)
}

/// `<app data>/recordings` (inside the asset protocol scope `$APPDATA/recordings/**`).
pub fn recordings_dir() -> Result<PathBuf, String> {
    app_data_dir()
        .map(|dir| dir.join("recordings"))
        .ok_or_else(|| "App data directory not initialized".to_string())
}

/// `<app data>/context`: copies of the files loaded as meeting context.
pub fn context_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("context")
}
