//! Launch arguments and process hygiene for the `claude` child process.

use std::path::{Path, PathBuf};

/// Model/effort/system prompt for one session.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionConfig {
    pub model: String,
    /// `None` for a model that takes no effort: `--effort` is left out.
    pub effort: Option<String>,
    pub system_prompt: String,
    /// Extended thinking. Off sets [`DISABLE_THINKING_ENV`] on the process:
    /// the first words then come far sooner (Haiku thinks on every turn).
    pub thinking: bool,
}

/// Env var that turns off extended thinking in the `claude` CLI.
pub const DISABLE_THINKING_ENV: &str = "CLAUDE_CODE_DISABLE_THINKING";

/// Env vars removed from the child so a stray API key / provider switch can
/// never override the user's own `claude` login.
pub const STRIPPED_ENV: [&str; 7] = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
];

/// Exact launch args (never `--bare`). The system prompt travels via file.
pub fn build_args(cfg: &SessionConfig, system_prompt_file: &Path) -> Vec<String> {
    let s = |x: &str| x.to_string();
    let mut args = vec![
        s("-p"),
        s("--input-format"),
        s("stream-json"),
        s("--output-format"),
        s("stream-json"),
        s("--verbose"),
        s("--include-partial-messages"),
        s("--safe-mode"),
        s("--tools"),
        s(""),
        s("--disallowedTools"),
        s("*"),
        s("--permission-prompts"),
        s("none"),
        s("--no-session-persistence"),
        s("--model"),
        cfg.model.clone(),
    ];
    if let Some(effort) = &cfg.effort {
        args.extend([s("--effort"), effort.clone()]);
    }
    args.extend([
        s("--system-prompt-file"),
        system_prompt_file.to_string_lossy().into_owned(),
    ]);
    args
}

/// `%LOCALAPPDATA%\NexQPlus\agent-sandbox` (`$TMPDIR/NexQPlus/agent-sandbox`
/// on macOS): the empty cwd the agent runs in.
pub fn sandbox_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("NexQPlus").join("agent-sandbox")
}

/// Apply cwd (created if missing), stripped env and CREATE_NO_WINDOW.
pub fn configure_command(cmd: &mut std::process::Command, sandbox: &Path) {
    if let Err(e) = std::fs::create_dir_all(sandbox) {
        log::warn!("cli_agent: cannot create sandbox dir {}: {e}", sandbox.display());
    }
    cmd.current_dir(sandbox);
    for key in STRIPPED_ENV {
        cmd.env_remove(key);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
}

/// [`configure_command`] plus the session's own env: thinking off sets
/// [`DISABLE_THINKING_ENV`], thinking on removes any inherited value.
pub fn configure_session_command(cmd: &mut std::process::Command, sandbox: &Path, thinking: bool) {
    configure_command(cmd, sandbox);
    if thinking {
        cmd.env_remove(DISABLE_THINKING_ENV);
    } else {
        cmd.env(DISABLE_THINKING_ENV, "1");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> SessionConfig {
        SessionConfig {
            model: "haiku".into(),
            effort: Some("low".into()),
            system_prompt: "sp".into(),
            thinking: true,
        }
    }

    fn env_of(cmd: &std::process::Command, key: &str) -> Option<Option<String>> {
        cmd.get_envs()
            .find(|(k, _)| *k == key)
            .map(|(_, v)| v.map(|v| v.to_string_lossy().into_owned()))
    }

    #[test]
    fn session_env_disables_thinking_iff_off() {
        assert!(!STRIPPED_ENV.contains(&DISABLE_THINKING_ENV));
        let dir = std::env::temp_dir().join("nexq-cli-agent-test-thinking");
        let mut off = std::process::Command::new("claude.exe");
        configure_session_command(&mut off, &dir, false);
        assert_eq!(env_of(&off, DISABLE_THINKING_ENV), Some(Some("1".into())));
        let mut on = std::process::Command::new("claude.exe");
        configure_session_command(&mut on, &dir, true);
        // Removed, so a value inherited from the user's env can't turn it off.
        assert_eq!(env_of(&on, DISABLE_THINKING_ENV), Some(None));
        for cmd in [&off, &on] {
            assert!(STRIPPED_ENV.iter().all(|k| env_of(cmd, k) == Some(None)));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn build_args_exact() {
        let args = build_args(&cfg(), Path::new("C:\\t\\sp.txt"));
        let joined = args.join("\u{1}");
        assert_eq!(args[0], "-p");
        for seq in [
            vec!["--input-format", "stream-json"],
            vec!["--output-format", "stream-json"],
            vec!["--tools", ""],
            vec!["--disallowedTools", "*"],
            vec!["--permission-prompts", "none"],
            vec!["--model", "haiku"],
            vec!["--effort", "low"],
            vec!["--system-prompt-file", "C:\\t\\sp.txt"],
        ] {
            assert!(joined.contains(&seq.join("\u{1}")), "missing {seq:?}");
        }
        for flag in ["--verbose", "--include-partial-messages", "--safe-mode", "--no-session-persistence"] {
            assert!(args.iter().any(|a| a == flag), "missing {flag}");
        }
        assert!(!args.iter().any(|a| a == "--bare"));
        let pos = |f: &str| args.iter().position(|a| a == f).unwrap();
        assert!(pos("--model") < pos("--effort") && pos("--effort") < pos("--system-prompt-file"));
    }

    #[test]
    fn build_args_omits_effort_when_unsupported() {
        let no_effort = SessionConfig { effort: None, ..cfg() };
        let args = build_args(&no_effort, Path::new("C:\\t\\sp.txt"));
        assert!(!args.iter().any(|a| a == "--effort"), "{args:?}");
        assert!(args.windows(2).any(|w| w[0] == "--model" && w[1] == "haiku"));
        assert!(args.iter().any(|a| a == "--system-prompt-file"));
    }

    #[test]
    fn configure_command_strips_env() {
        std::env::set_var("ANTHROPIC_API_KEY", "sk-test");
        let dir = std::env::temp_dir().join("nexq-cli-agent-test-sandbox");
        let mut cmd = std::process::Command::new("claude.exe");
        configure_command(&mut cmd, &dir);
        for key in STRIPPED_ENV {
            assert!(
                cmd.get_envs().any(|(k, v)| k == key && v.is_none()),
                "{key} not stripped"
            );
        }
        assert_eq!(cmd.get_current_dir(), Some(dir.as_path()));
        assert!(dir.is_dir());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
