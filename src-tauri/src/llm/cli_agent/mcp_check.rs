//! Checking one MCP server: start it the way a with-sources session would and
//! read the tools the CLI reports, with no model call.
//!
//! The session is primed with an empty `shouldQuery:false` message, which makes
//! the CLI print `system/init` after it connected its MCP servers. That init
//! lists every tool (`mcp__<key>__<tool>`) and each server's status.

use super::command::SessionConfig;
use super::detect::find_claude_binary;
use super::mcp_diagnose::diagnose_start;
use super::session::{AgentError, ClaudeSession, InitInfo, SessionTimeouts};
use crate::sources::config::McpServer;
use crate::sources::launch::single_server_launch;
use std::time::Duration;

/// `MCP_TIMEOUT` of a Check, in ms. A first `npx` or `uvx` run downloads the
/// server, which takes longer than the 20 s a meeting session allows.
pub const CHECK_MCP_TIMEOUT_MS: u32 = 60_000;
/// How long the Check session may take to come up: `system/init` waits for a
/// hung server up to [`CHECK_MCP_TIMEOUT_MS`] (measured: plus about 0.3 s).
pub const CHECK_INIT_TIMEOUT: Duration = Duration::from_secs(75);

/// System prompt of the check session. It is never answered: no model call.
const CHECK_SYSTEM_PROMPT: &str = "NexQ is checking an MCP server. No answer is needed.";

/// The full names (`mcp__<key>__<tool>`) of server `key`'s tools in `info`, or
/// why the server is not usable: it did not connect (`failed`, `needs-auth`),
/// is still connecting, or is not in the list at all.
pub fn tools_of_server(info: &InitInfo, key: &str) -> Result<Vec<String>, String> {
    let status = info.mcp_servers.iter().find(|s| s.name == key).map(|s| s.status.as_str());
    match status {
        Some("connected") => {
            let prefix = format!("mcp__{key}__");
            Ok(info.tools.iter().filter(|t| t.starts_with(&prefix)).cloned().collect())
        }
        Some("failed") => Err(crate::i18n::messages::mcp_failed_to_start(crate::i18n::current_ui_language())),
        Some("needs-auth") => Err(crate::i18n::messages::mcp_needs_sign_in(crate::i18n::current_ui_language())),
        Some("pending") => Err(crate::i18n::messages::mcp_pending(crate::i18n::current_ui_language())),
        Some(other) => Err(crate::i18n::messages::mcp_other_status(crate::i18n::current_ui_language(), other)),
        None => Err(crate::i18n::messages::mcp_not_started(crate::i18n::current_ui_language())),
    }
}

/// The launch of a Check: `server` alone, with the longer startup limit.
pub fn check_launch(
    server: &McpServer,
    secret: &dyn Fn(&str) -> Option<String>,
) -> Result<crate::llm::cli_agent::command::SourcesLaunch, String> {
    let mut launch = single_server_launch(server, secret)?;
    launch.mcp_startup_timeout_ms = Some(CHECK_MCP_TIMEOUT_MS);
    Ok(launch)
}

/// Start `server` alone and list its tools. `secret` looks a saved value up by
/// credential id. Takes up to [`CHECK_INIT_TIMEOUT`] (a hung server holds
/// `system/init` back for [`CHECK_MCP_TIMEOUT_MS`]), then up to
/// [`super::mcp_diagnose::DIAGNOSE_LIMIT`] more to find the cause.
pub async fn list_server_tools(
    server: &McpServer,
    secret: &(dyn Fn(&str) -> Option<String> + Sync),
) -> Result<Vec<String>, String> {
    let launch = check_launch(server, secret)?;
    let bin = tokio::task::spawn_blocking(find_claude_binary)
        .await
        .ok()
        .flatten()
        .ok_or_else(|| crate::i18n::messages::mcp_cli_missing(crate::i18n::current_ui_language()))?;
    let cfg = SessionConfig {
        model: "haiku".to_string(),
        effort: None,
        system_prompt: CHECK_SYSTEM_PROMPT.to_string(),
        thinking: false,
        sources: Some(launch),
    };
    let timeouts = SessionTimeouts { init: CHECK_INIT_TIMEOUT, ..SessionTimeouts::default() };
    let failure = match ClaudeSession::spawn_with_timeouts(bin, cfg, timeouts).await {
        Ok(session) => {
            let info = session.init_info();
            session.close().await;
            tools_of_server(&info, &server.key)
        }
        // Nothing usable left: the statuses say why, no error text to parse.
        Err(AgentError::NoUsableSources { info, .. }) => tools_of_server(&info, &server.key),
        Err(AgentError::Timeout) => Err(crate::i18n::messages::mcp_timeout(crate::i18n::current_ui_language())),
        // Claude itself is the problem, not the server: no point diagnosing it.
        Err(e) => return Err(e.to_string()),
    };
    match failure {
        Ok(tools) => Ok(tools),
        // The CLI says only "failed", so start the server alone and look.
        Err(message) => Err(match diagnose_start(server, secret).await {
            Some(cause) => format!("{message} {cause}"),
            None => message,
        }),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn check_failures_follow_the_ui_language() {
        use crate::i18n::{set_current, UiLanguage};
        let info = InitInfo::default();
        assert_eq!(tools_of_server(&info, "mira").unwrap_err(), "The server didn't start.");
        set_current(UiLanguage::ZhCn);
        assert_eq!(tools_of_server(&info, "mira").unwrap_err(), "服务器没有启动。");
        set_current(UiLanguage::En);
    }

    use super::*;
    use crate::llm::cli_agent::protocol::McpServerState;

    fn info(tools: &[&str], servers: &[(&str, &str)]) -> InitInfo {
        InitInfo {
            tools: tools.iter().map(|t| t.to_string()).collect(),
            mcp_servers: servers
                .iter()
                .map(|(n, s)| McpServerState { name: n.to_string(), status: s.to_string() })
                .collect(),
        }
    }

    #[test]
    fn tools_of_server_filters_by_key_and_reports_failure() {
        let ok = info(&["Read", "mcp__mira__kb_search", "mcp__other__x"], &[("mira", "connected")]);
        assert_eq!(tools_of_server(&ok, "mira"), Ok(vec!["mcp__mira__kb_search".to_string()]));
        let failed = info(&[], &[("mira", "failed")]);
        assert!(tools_of_server(&failed, "mira").unwrap_err().contains("failed"));
    }

    #[test]
    fn a_check_waits_longer_for_the_server_than_a_meeting_session() {
        let server = McpServer { key: "s".into(), label: "S".into(), ..Default::default() };
        let launch = check_launch(&server, &|_| None).unwrap();
        assert_eq!(launch.mcp_startup_timeout_ms, Some(60_000));
        assert!(CHECK_INIT_TIMEOUT > Duration::from_millis(CHECK_MCP_TIMEOUT_MS as u64));
        // A meeting session keeps the default.
        assert_eq!(single_server_launch(&server, &|_| None).unwrap().mcp_startup_timeout_ms, None);
    }

    #[test]
    fn tools_of_server_other_states() {
        let auth = info(&[], &[("a", "needs-auth")]);
        assert!(tools_of_server(&auth, "a").unwrap_err().contains("sign-in"));
        let pending = info(&[], &[("a", "pending")]);
        assert!(tools_of_server(&pending, "a").unwrap_err().contains("didn't answer in time"));
        let other = info(&[], &[("a", "disabled")]);
        assert!(tools_of_server(&other, "a").unwrap_err().contains("disabled"));
        assert!(tools_of_server(&info(&[], &[]), "a").is_err());
        // A server with no tools is fine: an empty list.
        assert_eq!(tools_of_server(&info(&[], &[("a", "connected")]), "a"), Ok(vec![]));
        // Another server's failure does not matter.
        let mixed = info(&["mcp__a__t"], &[("a", "connected"), ("b", "failed")]);
        assert_eq!(tools_of_server(&mixed, "a"), Ok(vec!["mcp__a__t".to_string()]));
    }

    /// Real `claude.exe` and a real stdio MCP server (a Node script that serves
    /// `get_note` and `delete_note`). Run by hand:
    /// `NEXQ_TEST_MCP_SERVER_JS=<path> cargo test --lib -- --ignored real_cli_lists`.
    #[tokio::test]
    #[ignore = "needs claude.exe, node and NEXQ_TEST_MCP_SERVER_JS"]
    async fn real_cli_lists_the_tools_of_a_stdio_server() {
        use crate::sources::config::{McpTransport, EnvVar};
        let script = std::env::var("NEXQ_TEST_MCP_SERVER_JS").expect("NEXQ_TEST_MCP_SERVER_JS");
        let server = McpServer {
            key: "my-server".into(),
            label: "My Server".into(),
            transport: McpTransport::Stdio { command: "node".into(), args: vec![script] },
            env: vec![EnvVar { name: "API_KEY".into(), value: None, secret: true }],
            ..Default::default()
        };
        let secret = |id: &str| (id == "mcp:my-server:API_KEY").then(|| "s3cret".to_string());
        let started = std::time::Instant::now();
        let tools = list_server_tools(&server, &secret).await.unwrap();
        eprintln!("tools after {:?}: {tools:?}", started.elapsed());
        assert!(tools.contains(&"mcp__my-server__get_note".to_string()), "{tools:?}");

        let broken = McpServer {
            transport: McpTransport::Stdio { command: "no-such-command-xyz".into(), args: vec![] },
            ..server
        };
        let err = list_server_tools(&broken, &secret).await.unwrap_err();
        assert!(err.contains("failed"), "{err}");
    }
}
