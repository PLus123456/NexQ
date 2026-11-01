//! Locate the `claude` binary and query version/login state (no model calls).

use super::command::{configure_command, sandbox_dir};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// Find `claude.exe`: the native installer location first, then `where.exe`.
#[cfg(windows)]
pub fn find_claude_binary() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("USERPROFILE") {
        let p = PathBuf::from(home).join(".local").join("bin").join("claude.exe");
        if p.is_file() {
            return Some(p);
        }
    }
    first_line_ending(&where_claude()?, ".exe")
}

/// An npm install of Claude Code (`claude.cmd` on PATH). NexQ can't use it:
/// it spawns `claude.exe` directly, never through a shell.
#[cfg(windows)]
pub fn find_npm_claude() -> Option<PathBuf> {
    first_line_ending(&where_claude()?, ".cmd")
}

/// `where.exe claude` output (no console window).
#[cfg(windows)]
fn where_claude() -> Option<String> {
    let mut cmd = std::process::Command::new("where.exe");
    cmd.arg("claude");
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// First `where.exe` line ending in `ext` (case-insensitive).
#[cfg(windows)]
fn first_line_ending(stdout: &str, ext: &str) -> Option<PathBuf> {
    stdout
        .lines()
        .map(str::trim)
        .find(|l| l.to_lowercase().ends_with(ext))
        .map(PathBuf::from)
}

/// Where Homebrew puts `claude` (Apple silicon, then Intel). An app started
/// from Finder gets a short PATH without these, so they are checked too.
#[cfg(unix)]
const EXTRA_BIN_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin"];

/// Find `claude`: the native installer location first (`~/.local/bin/claude`,
/// used by `curl -fsSL https://claude.ai/install.sh | bash`), then PATH, then
/// Homebrew's folders and the older local install (`~/.claude/local/claude`).
#[cfg(unix)]
pub fn find_claude_binary() -> Option<PathBuf> {
    let extra: Vec<PathBuf> = EXTRA_BIN_DIRS.iter().map(PathBuf::from).collect();
    find_claude_in(std::env::var_os("HOME").as_deref(), std::env::var_os("PATH").as_deref(), &extra)
}

/// [`find_claude_binary`] for a given `HOME`, `PATH` and extra folders.
#[cfg(unix)]
fn find_claude_in(home: Option<&std::ffi::OsStr>, path: Option<&std::ffi::OsStr>, extra: &[PathBuf]) -> Option<PathBuf> {
    if let Some(home) = home {
        let p = Path::new(home).join(".local").join("bin").join("claude");
        if is_executable_file(&p) {
            return Some(p);
        }
    }
    let on_path = path.map(|p| std::env::split_paths(p).collect::<Vec<_>>()).unwrap_or_default();
    let local = home.map(|h| Path::new(h).join(".claude").join("local"));
    on_path
        .into_iter()
        .chain(extra.iter().cloned())
        .chain(local)
        .map(|dir| dir.join("claude"))
        .find(|p| is_executable_file(p))
}

/// Unix has no npm-vs-native distinction: any `claude` found via PATH or the
/// native installer location is directly spawnable, no shell needed.
#[cfg(unix)]
pub fn find_npm_claude() -> Option<PathBuf> {
    None
}

/// A regular file with at least one executable bit set.
#[cfg(unix)]
fn is_executable_file(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// How a Claude login is billed. Only a claude.ai login with a plan uses
/// the subscription; any other login (Console / API key) bills an API
/// account.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeLogin {
    #[default]
    LoggedOut,
    Subscription,
    ApiBilled,
}

/// Shown wherever an API-billed login would otherwise read as connected.
pub const API_BILLED_NOTE: &str = "This Claude login bills an API account, not your subscription.";

/// Classify a `claude auth status` result (see [`ClaudeLogin`]).
pub fn classify_login(logged_in: bool, auth_method: &str, subscription_type: Option<&str>) -> ClaudeLogin {
    if !logged_in {
        ClaudeLogin::LoggedOut
    } else if auth_method == "claude.ai" && subscription_type.is_some() {
        ClaudeLogin::Subscription
    } else {
        ClaudeLogin::ApiBilled
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClaudeAuthStatus {
    pub logged_in: bool,
    pub auth_method: String,
    pub subscription_type: Option<String>,
    pub email: Option<String>,
    /// How this login is billed (derived from the fields above).
    #[serde(default)]
    pub login: ClaudeLogin,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAuth {
    #[serde(default)]
    logged_in: bool,
    #[serde(default)]
    auth_method: Option<String>,
    #[serde(default)]
    subscription_type: Option<String>,
    #[serde(default)]
    email: Option<String>,
}

/// Parse the JSON printed by `claude auth status`.
pub fn parse_auth_status(json: &str) -> Result<ClaudeAuthStatus, String> {
    let raw: RawAuth =
        serde_json::from_str(json.trim()).map_err(|e| format!("invalid auth status JSON: {e}"))?;
    let auth_method = raw.auth_method.unwrap_or_default();
    let login = classify_login(raw.logged_in, &auth_method, raw.subscription_type.as_deref());
    Ok(ClaudeAuthStatus {
        logged_in: raw.logged_in,
        auth_method,
        subscription_type: raw.subscription_type,
        email: raw.email,
        login,
    })
}

/// Run `claude --version` and `claude auth status` (10 s timeout each, no
/// console window, API-key env stripped). `auth status` exits 1 when logged
/// out but still prints JSON, so a non-zero exit is not an error by itself.
pub async fn claude_status(bin: &Path) -> Result<(String, ClaudeAuthStatus), String> {
    let version = claude_version(bin).await?;
    let status = claude_auth_status(bin).await?;
    Ok((version, status))
}

/// `claude --version`, trimmed.
pub async fn claude_version(bin: &Path) -> Result<String, String> {
    Ok(run_probe(bin, &["--version"]).await?.trim().to_string())
}

/// `claude auth status`, parsed.
pub async fn claude_auth_status(bin: &Path) -> Result<ClaudeAuthStatus, String> {
    parse_auth_status(&run_probe(bin, &["auth", "status"]).await?)
}

async fn run_probe(bin: &Path, args: &[&str]) -> Result<String, String> {
    let label = args.join(" ");
    let mut std_cmd = std::process::Command::new(bin);
    std_cmd.args(args);
    configure_command(&mut std_cmd, &sandbox_dir());
    let mut cmd = tokio::process::Command::from(std_cmd);
    cmd.kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let out = tokio::time::timeout(PROBE_TIMEOUT, cmd.output())
        .await
        .map_err(|_| format!("`claude {label}` timed out after 10 s"))?
        .map_err(|e| format!("failed to run `claude {label}`: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if stdout.trim().is_empty() && !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("`claude {label}` failed: {}", stderr.trim()));
    }
    Ok(stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_status_parses_logged_in() {
        let s = parse_auth_status(
            r#"{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max","email":"a@b"}"#,
        )
        .unwrap();
        assert!(s.logged_in);
        assert_eq!(s.auth_method, "claude.ai");
        assert_eq!(s.subscription_type.as_deref(), Some("max"));
        assert_eq!(s.email.as_deref(), Some("a@b"));
        assert_eq!(s.login, ClaudeLogin::Subscription);
    }

    #[test]
    fn only_a_claude_ai_login_with_a_plan_uses_the_subscription() {
        assert_eq!(classify_login(true, "claude.ai", Some("pro")), ClaudeLogin::Subscription);
        assert_eq!(classify_login(true, "claude.ai", None), ClaudeLogin::ApiBilled);
        assert_eq!(classify_login(true, "api_key", None), ClaudeLogin::ApiBilled);
        assert_eq!(classify_login(true, "console", Some("max")), ClaudeLogin::ApiBilled);
        assert_eq!(classify_login(false, "claude.ai", Some("max")), ClaudeLogin::LoggedOut);
        let s = parse_auth_status(r#"{"loggedIn":true,"authMethod":"api_key"}"#).unwrap();
        assert_eq!(s.login, ClaudeLogin::ApiBilled);
    }

    #[test]
    fn auth_status_parses_logged_out_and_rejects_garbage() {
        let s = parse_auth_status(r#"{"loggedIn":false}"#).unwrap();
        assert!(!s.logged_in);
        assert_eq!(s.subscription_type, None);
        assert_eq!(s.login, ClaudeLogin::LoggedOut);
        assert!(parse_auth_status("nope").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn where_output_picks_exe_line() {
        let out = "C:\\npm\\claude\r\nC:\\npm\\claude.cmd\r\nC:\\bin\\claude.exe\r\n";
        assert_eq!(first_line_ending(out, ".exe"), Some(PathBuf::from("C:\\bin\\claude.exe")));
        assert_eq!(first_line_ending("C:\\npm\\claude.cmd\r\n", ".exe"), None);
    }

    #[cfg(windows)]
    #[test]
    fn where_output_finds_an_npm_install() {
        let out = "C:\\npm\\claude\r\nC:\\npm\\CLAUDE.CMD\r\n";
        assert_eq!(first_line_ending(out, ".cmd"), Some(PathBuf::from("C:\\npm\\CLAUDE.CMD")));
        assert_eq!(first_line_ending("", ".cmd"), None);
    }

    /// A fresh directory for one test. Tests pass `HOME`/`PATH` explicitly:
    /// changing the process environment would race the tests running beside them.
    #[cfg(unix)]
    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nexq-detect-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A `claude` script in `dir` with permission bits `mode`.
    #[cfg(unix)]
    fn claude_script(dir: &Path, mode: u32) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(dir).unwrap();
        let bin = dir.join("claude");
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(mode)).unwrap();
        bin
    }

    #[cfg(unix)]
    #[test]
    fn finds_the_first_executable_claude_on_path() {
        let root = temp_dir("path");
        let plain = claude_script(&root.join("a"), 0o644);
        let exe = claude_script(&root.join("b"), 0o755);
        let path = std::env::join_paths([plain.parent().unwrap(), exe.parent().unwrap()]).unwrap();
        assert_eq!(find_claude_in(None, Some(path.as_os_str()), &[]), Some(exe));
        assert_eq!(find_claude_in(None, None, &[]), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn native_installer_location_takes_priority_over_path() {
        let root = temp_dir("home");
        let native = claude_script(&root.join("home").join(".local").join("bin"), 0o755);
        let on_path = claude_script(&root.join("bin"), 0o755);
        let home = root.join("home");
        let found = find_claude_in(Some(home.as_os_str()), Some(on_path.parent().unwrap().as_os_str()), &[]);
        assert_eq!(found, Some(native));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn homebrew_and_the_old_local_install_are_found_without_path() {
        // A Finder launch: PATH is /usr/bin:/bin:/usr/sbin:/sbin, no Homebrew.
        let root = temp_dir("brew");
        let brew = claude_script(&root.join("opt").join("homebrew").join("bin"), 0o755);
        let short_path = root.join("usr-bin");
        std::fs::create_dir_all(&short_path).unwrap();
        let extra = [root.join("missing"), brew.parent().unwrap().to_path_buf()];
        assert_eq!(find_claude_in(None, Some(short_path.as_os_str()), &extra), Some(brew.clone()));
        // PATH still wins over Homebrew.
        let on_path = claude_script(&root.join("path"), 0o755);
        assert_eq!(find_claude_in(None, Some(on_path.parent().unwrap().as_os_str()), &extra), Some(on_path));
        // `claude migrate-installer` puts it in ~/.claude/local.
        let home = root.join("home");
        let local = claude_script(&home.join(".claude").join("local"), 0o755);
        assert_eq!(find_claude_in(Some(home.as_os_str()), Some(short_path.as_os_str()), &[]), Some(local));
        let _ = std::fs::remove_dir_all(&root);
    }
}
