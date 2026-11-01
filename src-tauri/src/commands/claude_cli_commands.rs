//! Claude CLI (subscription) provider: detection, model settings, session
//! status and the login terminal.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{command, State};

use crate::llm::cli_agent::detect::{
    claude_auth_status, claude_version, find_claude_binary, find_npm_claude, ClaudeAuthStatus,
};
use crate::llm::cli_agent::manager::{AgentSessionStatus, ClaudeCliConfig};
use crate::llm::cli_agent::models::{probe_models, ClaudeModelInfo, EFFORTS};
use crate::llm::ProviderType;
use crate::state::AppState;

/// Installation and login state of the local `claude` CLI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeCliStatus {
    pub installed: bool,
    pub binary_path: Option<String>,
    /// `None` when not installed or the `--version` probe failed.
    pub version: Option<String>,
    /// `None` when not installed or the `auth status` probe failed.
    pub auth: Option<ClaudeAuthStatus>,
    /// Not installed, but an npm install (`claude.cmd`) was found: NexQ
    /// needs the native installer's `claude.exe`.
    pub npm_only: bool,
}

async fn resolve_binary() -> Option<PathBuf> {
    tokio::task::spawn_blocking(find_claude_binary)
        .await
        .ok()
        .flatten()
}

/// Detect `claude.exe`, its version and login state (no model call). The two
/// probes run independently, so one failing keeps the other's answer.
#[command]
pub async fn claude_cli_status() -> Result<ClaudeCliStatus, String> {
    let Some(bin) = resolve_binary().await else {
        let npm_only = tokio::task::spawn_blocking(find_npm_claude)
            .await
            .ok()
            .flatten()
            .is_some();
        return Ok(ClaudeCliStatus {
            installed: false,
            binary_path: None,
            version: None,
            auth: None,
            npm_only,
        });
    };
    let (version, auth) = tokio::join!(claude_version(&bin), claude_auth_status(&bin));
    let version = version
        .map_err(|e| log::warn!("Claude CLI version probe failed: {e}"))
        .ok();
    let auth = auth
        .map_err(|e| log::warn!("Claude CLI auth probe failed: {e}"))
        .ok();
    Ok(ClaudeCliStatus {
        installed: true,
        binary_path: Some(bin.to_string_lossy().into_owned()),
        version,
        auth,
        npm_only: false,
    })
}

/// The models the CLI offers, from its `initialize` answer (no model call).
/// Returns the cached catalog unless `refresh` is set or none is cached yet;
/// a successful probe replaces the cache (sessions clamp `--effort` to it).
#[command]
pub async fn claude_cli_models(
    refresh: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Vec<ClaudeModelInfo>, String> {
    if !refresh.unwrap_or(false) {
        if let Some(models) = state.claude_models.get() {
            return Ok(models);
        }
    }
    let bin = resolve_binary()
        .await
        .ok_or_else(|| "Claude CLI is not installed".to_string())?;
    let models = probe_models(&bin).await?;
    state.claude_models.set(models.clone());
    Ok(models)
}

/// Seed the backend catalog with the list the app saved last time, unless a
/// probe already filled it: sessions then clamp `--effort` from the first
/// spawn, even when the startup probe fails. Returns whether it seeded.
#[command]
pub async fn seed_claude_cli_models(
    models: Vec<ClaudeModelInfo>,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    Ok(state.claude_models.seed(models))
}

/// A model alias or id (`haiku`, `claude-haiku-4-5-20251001`, `opus[1m]`).
/// Rejecting a leading `-` keeps it from being read as a CLI flag.
fn valid_model(model: &str) -> bool {
    !model.is_empty()
        && !model.starts_with('-')
        && model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-._:[]".contains(c))
}

fn validate_config(config: &ClaudeCliConfig) -> Result<(), String> {
    for (tier, model, effort) in [
        ("Fast", &config.fast_model, &config.fast_effort),
        ("Deep", &config.deep_model, &config.deep_effort),
    ] {
        if !valid_model(model) {
            return Err(format!("Invalid {tier} model: {model:?}"));
        }
        if !EFFORTS.contains(&effort.as_str()) {
            return Err(format!("Invalid {tier} effort: {effort:?}"));
        }
    }
    if let Some(fallback) = &config.fallback_provider {
        match ProviderType::from_str(fallback) {
            Ok(ProviderType::ClaudeCli) => {
                return Err("Claude CLI cannot be its own fallback provider".to_string())
            }
            Ok(_) => {}
            Err(_) => return Err(format!("Unknown fallback provider: {fallback:?}")),
        }
    }
    Ok(())
}

/// Replace the Claude CLI model settings. Running sessions keep their model;
/// the change applies to sessions started afterwards.
#[command]
pub async fn set_claude_cli_config(
    config: ClaudeCliConfig,
    state: State<'_, AppState>,
) -> Result<(), String> {
    validate_config(&config)?;
    let mut current = state
        .claude_cli_config
        .write()
        .map_err(|_| "Claude CLI config lock poisoned".to_string())?;
    *current = config;
    Ok(())
}

/// Status of every open Claude session.
#[command]
pub async fn get_agent_sessions(
    state: State<'_, AppState>,
) -> Result<Vec<AgentSessionStatus>, String> {
    Ok(state.agent_sessions.snapshot())
}

/// How to launch the login terminal: the working directory and the
/// `cmd.exe` command line. `start` opens a new console window running
/// `claude` (kept open by `/k` so the user sees the result). The binary's
/// folder becomes the working directory and the command names it as
/// `.\claude.exe`, so the path (which may contain `&`, `%` or spaces) never
/// goes through cmd's parser. Without a resolved binary, `claude` comes from
/// PATH.
#[cfg_attr(not(windows), allow(dead_code))]
fn login_launch(bin: Option<&Path>) -> (Option<PathBuf>, String) {
    let dir = bin
        .and_then(Path::parent)
        .filter(|d| !d.as_os_str().is_empty());
    let exe = if dir.is_some() { r".\claude.exe" } else { "claude" };
    (
        dir.map(Path::to_path_buf),
        format!(r#"/d /c start "Claude login" cmd.exe /k {exe}"#),
    )
}

/// Open a visible terminal running `claude` so the user can log in. NexQ
/// reads nothing from it; credentials stay between the user and the CLI.
#[command]
pub async fn open_claude_login_terminal() -> Result<(), String> {
    let bin = resolve_binary().await;
    tokio::task::spawn_blocking(move || open_login_terminal(bin.as_deref()))
        .await
        .map_err(|e| format!("Could not open a terminal: {e}"))?
}

/// Windows: `cmd.exe` `start`s a new console window running `claude` (see
/// [`login_launch`]).
#[cfg(windows)]
fn open_login_terminal(bin: Option<&Path>) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let (dir, command_line) = login_launch(bin);
    let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
    let mut cmd = std::process::Command::new(comspec);
    if let Some(dir) = dir {
        cmd.current_dir(dir);
    }
    // Exact quoting for cmd.exe; this outer cmd has no window of its own
    // (CREATE_NO_WINDOW), `start` gives `claude` a fresh visible console.
    cmd.raw_arg(command_line).creation_flags(0x0800_0000);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open a terminal: {e}"))
}

/// macOS: Terminal runs `$TMPDIR/NexQPlus/claude-login.command` (see
/// [`login_script`]), so `claude` starts in the agent sandbox without the
/// stripped env vars, as sessions do. Waits for `open` to report the result.
#[cfg(target_os = "macos")]
fn open_login_terminal(bin: Option<&Path>) -> Result<(), String> {
    use crate::llm::cli_agent::command::{sandbox_dir, STRIPPED_ENV};
    use std::os::unix::fs::PermissionsExt;
    let sandbox = sandbox_dir();
    if let Err(e) = std::fs::create_dir_all(&sandbox) {
        log::warn!(
            "Claude CLI login: cannot create sandbox dir {}: {e}",
            sandbox.display()
        );
    }
    let dir = std::env::temp_dir().join("NexQPlus");
    let script = dir.join("claude-login.command");
    std::fs::create_dir_all(&dir)
        .and_then(|()| std::fs::write(&script, login_script(&sandbox, bin, &STRIPPED_ENV)))
        .and_then(|()| std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)))
        .map_err(|e| format!("Could not write {}: {e}", script.display()))?;
    let out = std::process::Command::new("/usr/bin/open")
        .args(["-a", "Terminal"])
        .arg(&script)
        .output()
        .map_err(|e| format!("Could not run /usr/bin/open: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    Err(format!(
        "`open -a Terminal` failed ({}): {}",
        out.status,
        String::from_utf8_lossy(&out.stderr).trim()
    ))
}

/// Elsewhere there is no terminal NexQ can count on: the user starts `claude`.
#[cfg(not(any(windows, target_os = "macos")))]
fn open_login_terminal(_bin: Option<&Path>) -> Result<(), String> {
    Err("Open a terminal and run `claude` to log in".to_string())
}

/// The macOS login script: `cd` into the sandbox, `unset` the stripped env
/// vars, then `exec` the resolved binary (`claude` from PATH without one).
/// Names that are not shell identifiers are left out (`unset` would abort).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn login_script(sandbox: &Path, bin: Option<&Path>, stripped: &[&str]) -> String {
    let quote = |p: &Path| sh_single_quote(&p.to_string_lossy());
    let names: Vec<&str> = stripped
        .iter()
        .copied()
        .filter(|n| {
            n.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
                && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        })
        .collect();
    let mut lines = vec!["#!/bin/sh".to_string(), format!("cd {}", quote(sandbox))];
    if !names.is_empty() {
        lines.push(format!("unset {}", names.join(" ")));
    }
    let exe = bin.map_or_else(|| "claude".to_string(), quote);
    lines.push(format!("exec {exe}"));
    lines.join("\n") + "\n"
}

/// `s` as one `sh` word: wrapped in `'`, each `'` written as `'\''`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn sh_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::cli_agent::detect::ClaudeLogin;

    #[test]
    fn claude_cli_config_validation() {
        assert!(validate_config(&ClaudeCliConfig::default()).is_ok());
        let full_id = ClaudeCliConfig {
            deep_model: "claude-opus-4-1[1m]".into(),
            deep_effort: "xhigh".into(),
            ..Default::default()
        };
        assert!(validate_config(&full_id).is_ok());
        for bad in [
            ClaudeCliConfig { fast_model: "".into(), ..Default::default() },
            ClaudeCliConfig { fast_model: "--bare".into(), ..Default::default() },
            ClaudeCliConfig { deep_model: "son net".into(), ..Default::default() },
            ClaudeCliConfig { fast_effort: "ultra".into(), ..Default::default() },
        ] {
            assert!(validate_config(&bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn claude_cli_config_validates_fallback() {
        let with = |p: &str| ClaudeCliConfig {
            fallback_provider: Some(p.into()),
            ..Default::default()
        };
        assert!(validate_config(&with("ollama")).is_ok());
        assert!(validate_config(&with("claude_cli")).is_err());
        assert!(validate_config(&with("nope")).is_err());
        assert!(validate_config(&with("")).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn claude_cli_login_launch_keeps_path_out_of_cmd() {
        let bin = Path::new(r"C:\Users\Tom&Jerry 100%\.local\bin\claude.exe");
        let (dir, line) = login_launch(Some(bin));
        assert_eq!(
            dir.as_deref(),
            Some(Path::new(r"C:\Users\Tom&Jerry 100%\.local\bin"))
        );
        assert_eq!(line, r#"/d /c start "Claude login" cmd.exe /k .\claude.exe"#);
        assert!(!line.contains('&') && !line.contains('%'));

        let (dir, line) = login_launch(None);
        assert_eq!(dir, None);
        assert_eq!(line, r#"/d /c start "Claude login" cmd.exe /k claude"#);
    }

    #[test]
    fn claude_cli_status_serializes_snake_case() {
        let status = ClaudeCliStatus {
            installed: true,
            binary_path: Some("c".into()),
            version: Some("2.1".into()),
            auth: Some(ClaudeAuthStatus {
                logged_in: true,
                auth_method: "claude.ai".into(),
                subscription_type: Some("max".into()),
                email: None,
                login: ClaudeLogin::Subscription,
            }),
            npm_only: false,
        };
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["binary_path"], "c");
        assert_eq!(json["auth"]["logged_in"], true);
        assert_eq!(json["auth"]["subscription_type"], "max");
        assert_eq!(json["auth"]["login"], "subscription");
        assert_eq!(json["npm_only"], false);
    }

    #[cfg(unix)]
    #[test]
    fn claude_cli_login_script_quotes_paths() {
        use crate::llm::cli_agent::command::STRIPPED_ENV;
        let sandbox = Path::new("/var/T/Nex Q's/agent-sandbox");
        let bin = Path::new("/Users/Tom&Jerry 100%/it's/claude");
        let script = login_script(sandbox, Some(bin), &STRIPPED_ENV);
        let unset = format!("unset {}", STRIPPED_ENV.join(" "));
        assert_eq!(
            script.lines().collect::<Vec<_>>(),
            [
                "#!/bin/sh",
                r"cd '/var/T/Nex Q'\''s/agent-sandbox'",
                unset.as_str(),
                r"exec '/Users/Tom&Jerry 100%/it'\''s/claude'",
            ]
        );
        assert!(script.ends_with('\n'));
    }

    #[cfg(unix)]
    #[test]
    fn claude_cli_login_script_without_binary_execs_claude() {
        let script = login_script(Path::new("/tmp/sandbox"), None, &["ANTHROPIC_API_KEY"]);
        assert_eq!(
            script,
            "#!/bin/sh\ncd '/tmp/sandbox'\nunset ANTHROPIC_API_KEY\nexec claude\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn claude_cli_login_script_unsets_shell_names_only() {
        let sandbox = Path::new("/tmp/sandbox");
        let names = ["_OK", "A1", "1A", "A-B", "A B", "", "$(id)", "É"];
        let script = login_script(sandbox, None, &names);
        assert!(script.contains("\nunset _OK A1\n"), "{script}");
        let script = login_script(sandbox, None, &["A;B"]);
        assert!(!script.contains("unset"), "{script}");
    }

    #[cfg(unix)]
    #[test]
    fn claude_cli_login_script_is_valid_sh() {
        use crate::llm::cli_agent::command::STRIPPED_ENV;
        let tricky = "/Users/Tom&Jerry 100%/it's/claude";
        for bin in [Some(Path::new(tricky)), None] {
            let script = login_script(Path::new("/tmp/Nex Q's"), bin, &STRIPPED_ENV);
            // `-n` only parses: nothing in the script runs, `claude` included.
            let parsed = std::process::Command::new("/bin/sh")
                .args(["-n", "-c", script.as_str()])
                .status()
                .unwrap();
            assert!(parsed.success(), "{script}");
        }
        // Each quoted string reaches the command as one unchanged word.
        for s in [tricky, "'", "''", "a'b'c", r#"$HOME "x" \n"#, ""] {
            let line = format!("printf %s {}", sh_single_quote(s));
            let out = std::process::Command::new("/bin/sh")
                .args(["-c", line.as_str()])
                .output()
                .unwrap();
            assert_eq!(String::from_utf8_lossy(&out.stdout), s);
        }
    }
}
