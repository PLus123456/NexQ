//! Private per-session files for the prompt and the MCP config. The config
//! contains each server's secrets separately from the CLI's process env.
//!
//! The folder is in the user's local app data on Windows and in the system
//! temp directory on Unix. In both cases it is outside the CLI's sandbox.
//!
//! Files are named `nexq-mcp-<pid>-<uuid>.json`, written when a session starts,
//! and cleaned up on close, drop or the next app start after a crash. The MCP
//! config is deleted earlier, when the CLI's `system/init` arrives.

use std::io::{self, Write};
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};

const PREFIX: &str = "nexq-mcp-";
const SUFFIX: &str = ".json";

/// The app's private directory for CLI session data.
pub fn private_dir() -> PathBuf {
    #[cfg(windows)]
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    #[cfg(not(windows))]
    let base = std::env::temp_dir();
    base.join("NexQPlus").join("agent-private")
}

/// Owns a session file from its creation through launch and teardown.
pub struct PrivateFile(PathBuf);

impl PrivateFile {
    pub fn new(dir: &Path, content: &str) -> io::Result<Self> {
        write_private_file(dir, content).map(Self)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    pub fn remove(&self) {
        remove_private_file(self.path());
    }
}

impl Drop for PrivateFile {
    fn drop(&mut self) {
        self.remove();
    }
}

/// Write `content` to a new, uniquely named file in `dir` (created if missing).
pub fn write_private_file(dir: &Path, content: &str) -> io::Result<PathBuf> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    builder.mode(0o700);
    builder.create(dir)?;
    secure_directory(dir)?;

    let path = dir.join(format!(
        "{PREFIX}{}-{}{SUFFIX}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(&path)?;
    if let Err(e) = file.write_all(content.as_bytes()).and_then(|_| file.flush()) {
        drop(file);
        let _ = std::fs::remove_file(&path);
        return Err(e);
    }
    Ok(path)
}

#[cfg(unix)]
fn secure_directory(dir: &Path) -> io::Result<()> {
    let ownership_error = || io::Error::new(
        io::ErrorKind::PermissionDenied,
        "session files require a private directory owned by this user",
    );
    // SAFETY: geteuid has no inputs or memory preconditions.
    let owner = unsafe { libc::geteuid() };
    let parent = std::fs::symlink_metadata(dir.parent().ok_or_else(ownership_error)?)?;
    let owner_writable_only = parent.uid() == owner && parent.mode() & 0o022 == 0;
    let system_sticky = parent.uid() == 0 && parent.mode() & 0o1000 != 0;
    if !parent.is_dir() || !(owner_writable_only || system_sticky) {
        return Err(ownership_error());
    }

    let metadata = std::fs::symlink_metadata(dir)?;
    if !metadata.is_dir() || metadata.uid() != owner {
        return Err(ownership_error());
    }
    // Tighten directories created by earlier versions before writing or
    // examining any session files.
    if metadata.mode() & 0o777 != 0o700 {
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn secure_directory(_dir: &Path) -> io::Result<()> {
    Ok(())
}

/// Delete one private file; a missing file is fine.
pub fn remove_private_file(path: &Path) {
    if let Err(e) = std::fs::remove_file(path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            log::warn!("cannot remove a private session file: {e}");
        }
    }
}

/// App start: delete files whose owning NexQ process is gone (a crash or a
/// kill left them). Files of this process and of another running NexQ stay.
/// Returns how many were deleted.
pub fn cleanup_leftovers(dir: &Path) -> usize {
    if secure_directory(dir).is_err() {
        return 0;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    let me = std::process::id();
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(pid) = owner_pid(&name) else { continue };
        if pid == me || pid_alive(pid) {
            continue;
        }
        if std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// The pid in `nexq-mcp-<pid>-<uuid>.json`.
fn owner_pid(file_name: &str) -> Option<u32> {
    let rest = file_name.strip_prefix(PREFIX)?.strip_suffix(SUFFIX)?;
    rest.split('-').next()?.parse().ok()
}

#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
    use windows::Win32::Foundation::{CloseHandle, ERROR_INVALID_PARAMETER};
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    const STILL_ACTIVE: u32 = 259;
    // SAFETY: plain Win32 calls; the handle is closed before returning.
    unsafe {
        let handle = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(handle) => handle,
            Err(e) => return e.code() != ERROR_INVALID_PARAMETER.into(),
        };
        let mut code = 0u32;
        let alive = GetExitCodeProcess(handle, &mut code).is_err() || code == STILL_ACTIVE;
        let _ = CloseHandle(handle);
        alive
    }
}

#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else { return false };
    if pid <= 0 {
        return false;
    }
    // SAFETY: signal zero queries existence without sending a signal.
    unsafe { libc::kill(pid, 0) == 0 || io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) }
}

#[cfg(not(any(unix, windows)))]
fn pid_alive(_pid: u32) -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("nexq-private-{name}-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn private_dir_is_beside_the_sandbox_not_inside_it() {
        let private = private_dir();
        let sandbox = crate::llm::cli_agent::command::sandbox_dir();
        assert!(!private.starts_with(&sandbox), "{private:?} is readable by the model");
    }

    #[test]
    fn write_then_remove() {
        let dir = temp_dir("write");
        let a = write_private_file(&dir, "{\"x\":1}").unwrap();
        let b = write_private_file(&dir, "{}").unwrap();
        assert_ne!(a, b);
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "{\"x\":1}");
        remove_private_file(&a);
        assert!(!a.exists() && b.exists());
        remove_private_file(&a); // already gone: no panic
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn files_and_their_directory_are_private_even_after_upgrading() {
        let dir = temp_dir("mode");
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        let file = PrivateFile::new(&dir, "{}").unwrap();
        assert_eq!(std::fs::metadata(&dir).unwrap().mode() & 0o777, 0o700);
        assert_eq!(std::fs::metadata(file.path()).unwrap().mode() & 0o077, 0);
        let path = file.path().to_owned();
        drop(file);
        assert!(!path.exists());
        std::fs::remove_dir(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn startup_cleanup_keeps_files_owned_by_another_live_process() {
        use std::process::{Command, Stdio};

        let dir = temp_dir("live-owner");
        let mut child = Command::new("/bin/cat").stdin(Stdio::piped()).spawn().unwrap();
        std::fs::create_dir(&dir).unwrap();
        let live = dir.join(format!("{PREFIX}{}-live{SUFFIX}", child.id()));
        std::fs::write(&live, "{}").unwrap();
        let removed = cleanup_leftovers(&dir);
        let kept = live.exists();
        drop(child.stdin.take());
        child.wait().unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(removed, 0);
        assert!(kept);
    }

    #[test]
    fn leftovers_of_dead_processes_are_deleted_and_live_ones_kept() {
        let dir = temp_dir("cleanup");
        let mine = write_private_file(&dir, "mine").unwrap();
        let dead = dir.join(format!("{PREFIX}{}-abc{SUFFIX}", u32::MAX));
        std::fs::write(&dead, "stale").unwrap();
        let unrelated = dir.join("notes.txt");
        std::fs::write(&unrelated, "x").unwrap();
        assert_eq!(cleanup_leftovers(&dir), 1);
        assert!(mine.exists() && unrelated.exists() && !dead.exists());
        assert_eq!(cleanup_leftovers(&dir.join("missing")), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn owner_pid_reads_the_file_name() {
        assert_eq!(owner_pid("nexq-mcp-1234-abc-def.json"), Some(1234));
        assert_eq!(owner_pid("nexq-mcp-x-abc.json"), None);
        assert_eq!(owner_pid("other.json"), None);
    }
}
