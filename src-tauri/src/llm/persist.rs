//! `llm-connections.json` on disk (NexQ Plus): loading (a corrupt file falls
//! back to its `.bak`, a file from a newer build is used read-only), atomic
//! saves that keep the previous version as `.bak`, and the one-time
//! migration from the old settings in `config.json`.
//!
//! The migration only reads the old keys and never changes them, so an older
//! app version keeps working and deleting the new file migrates again. No
//! keychain entry is read or copied: migrated connections point at the old
//! slots (`openai`, `custom`…).

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::api::LlmKind;
use super::connections::{
    legacy_connection, legacy_id, LlmConfigFile, LlmConnection, MigrationInfo, RouteTarget,
    TaskRoute, SCHEMA_VERSION,
};
use super::ProviderType;

pub const FILE_NAME: &str = "llm-connections.json";

/// What [`load`] found.
#[derive(Debug, Clone, PartialEq)]
pub struct Loaded {
    pub config: LlmConfigFile,
    /// The file is from a newer build: use it, never write it.
    pub read_only: bool,
    /// `"restored_from_backup"` | `"reset_corrupt_file"`.
    pub warning: Option<String>,
    /// The config was migrated or restored and should be written.
    pub needs_save: bool,
}

pub fn backup_path(path: &Path) -> PathBuf {
    with_suffix(path, ".bak")
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(suffix);
    path.with_file_name(name)
}

/// Loads `path`, or migrates from the old settings (`legacy` reads the raw
/// `config.json`; it is only called when needed).
pub fn load(path: &Path, legacy: impl FnOnce() -> Option<Value>, now_ms: i64) -> Loaded {
    if !path.exists() {
        return Loaded { config: migrate(legacy().as_ref(), now_ms), read_only: false, warning: None, needs_save: true };
    }
    match read_file(path) {
        Ok((config, read_only)) => Loaded { config, read_only, warning: None, needs_save: false },
        Err(e) => {
            log::warn!("LLM settings: {} is unreadable ({e})", path.display());
            if let Ok((config, read_only)) = read_file(&backup_path(path)) {
                log::warn!("LLM settings: restored from the backup");
                return Loaded {
                    config,
                    read_only,
                    warning: Some("restored_from_backup".to_string()),
                    needs_save: !read_only,
                };
            }
            // Keep the broken file for inspection; start over from the old settings.
            let aside = with_suffix(path, &format!(".corrupt-{now_ms}"));
            if let Err(e) = std::fs::rename(path, &aside) {
                log::warn!("LLM settings: could not move the broken file aside: {e}");
            }
            Loaded {
                config: migrate(legacy().as_ref(), now_ms),
                read_only: false,
                warning: Some("reset_corrupt_file".to_string()),
                needs_save: true,
            }
        }
    }
}

/// The parsed file, and whether it is from a newer build.
fn read_file(path: &Path) -> Result<(LlmConfigFile, bool), String> {
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let value: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if !value.is_object() {
        return Err("not a JSON object".to_string());
    }
    let newer = value
        .get("schema_version")
        .and_then(Value::as_u64)
        .is_some_and(|v| v > SCHEMA_VERSION as u64);
    let config: LlmConfigFile = serde_json::from_value(value).map_err(|e| e.to_string())?;
    Ok((config, newer))
}

/// Writes `config` atomically: a temporary file renamed over `path`, after
/// copying the current file to `.bak`.
pub fn save(path: &Path, config: &LlmConfigFile) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let text = serde_json::to_string_pretty(config).map_err(std::io::Error::other)?;
    let tmp = with_suffix(path, ".tmp");
    {
        use std::io::Write;
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
    }
    if path.exists() {
        if let Err(e) = std::fs::copy(path, backup_path(path)) {
            log::warn!("LLM settings: could not update the backup: {e}");
        }
    }
    std::fs::rename(&tmp, path)
}

/// Moves the file aside (`.disabled-<ts>`) so the next load migrates again.
pub fn disable(path: &Path, now_ms: i64) -> std::io::Result<()> {
    if path.exists() {
        std::fs::rename(path, with_suffix(path, &format!(".disabled-{now_ms}")))?;
    }
    Ok(())
}

// ── Migration ───────────────────────────────────────────────────────────────

/// The connections and routes that reproduce the old settings exactly:
/// `llmProvider` + `llmModel` become the default route on `legacy-<type>`,
/// every other task follows the default; each provider type the user used
/// (`verifiedCloudProviders`, `lastModelByProvider`, the Claude fallback,
/// a custom endpoint) gets its `legacy-<type>` connection with its last
/// model. Without old settings: one `legacy-ollama` connection.
pub fn migrate(legacy: Option<&Value>, now_ms: i64) -> LlmConfigFile {
    let text = |key: &str| {
        legacy
            .and_then(|v| v.get(key))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let active = text("llmProvider").and_then(|t| ProviderType::from_str(&t).ok());
    let Some(active) = active else {
        let ollama = legacy_connection(&ProviderType::Ollama, None, None, None);
        let mut config = LlmConfigFile::default();
        config.routing.default = TaskRoute { target: Some(target(&ollama.id, None)), ..Default::default() };
        config.migration = Some(MigrationInfo {
            source: "fresh".to_string(),
            at_ms: now_ms,
            connections: vec![ollama.id.clone()],
            ..Default::default()
        });
        config.connections = vec![with_created(ollama, now_ms)];
        return config;
    };

    let last_models: Vec<(String, String)> = legacy
        .and_then(|v| v.get("lastModelByProvider"))
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.trim().to_string())))
                .filter(|(_, v)| !v.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let verified: Vec<String> = legacy
        .and_then(|v| v.get("verifiedCloudProviders"))
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let claude = legacy.and_then(|v| v.get("claudeCliConfig"));
    let fallback_provider = claude
        .and_then(|c| c.get("fallback_provider"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let fallback_model = claude
        .and_then(|c| c.get("fallback_model"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(str::to_string);
    let custom_base = text("customLlmBaseUrl");
    let custom_auth = text("customLlmAuthType");

    // The active type first, then the others in the usual provider order.
    let mut wanted: Vec<ProviderType> = vec![active.clone()];
    let mut add = |name: &str| {
        if let Ok(pt) = ProviderType::from_str(name) {
            if !wanted.contains(&pt) {
                wanted.push(pt);
            }
        }
    };
    for name in &verified {
        add(name);
    }
    for (name, _) in &last_models {
        add(name);
    }
    if let Some(name) = &fallback_provider {
        add(name);
    }
    if custom_base.is_some() {
        add("custom");
    }
    let order = |pt: &ProviderType| super::LLMRouter::get_all_providers().iter().position(|p| p.provider_type == pt.as_str());
    wanted[1..].sort_by_key(|pt| order(pt));

    let mut connections: Vec<LlmConnection> = Vec::new();
    for pt in &wanted {
        let mut conn = legacy_connection(pt, custom_base.as_deref(), custom_auth.as_deref(), None);
        let last = last_models.iter().find(|(k, _)| k == pt.as_str()).map(|(_, m)| m.clone());
        let is_fallback = fallback_provider.as_deref() == Some(pt.as_str());
        let model = last.or_else(|| if is_fallback { fallback_model.clone() } else { None });
        if conn.kind != LlmKind::ClaudeCli {
            if let Some(model) = model {
                conn.manual_models = vec![model.clone()];
                conn.default_model = Some(model);
            }
        }
        if is_fallback {
            if let Some(model) = &fallback_model {
                if !conn.manual_models.contains(model) {
                    conn.manual_models.push(model.clone());
                }
                conn.default_model.get_or_insert_with(|| model.clone());
            }
        }
        if verified.iter().any(|v| v == pt.as_str()) {
            conn.verified_at_ms = Some(now_ms);
        }
        connections.push(with_created(conn, now_ms));
    }

    let legacy_model = text("llmModel");
    let route_model = legacy_model.clone().filter(|_| active != ProviderType::ClaudeCli);
    let mut config = LlmConfigFile::default();
    config.routing.default = TaskRoute { target: Some(target(&legacy_id(active.as_str()), route_model)), ..Default::default() };
    config.migration = Some(MigrationInfo {
        source: "legacy_config".to_string(),
        at_ms: now_ms,
        legacy_provider: Some(active.as_str().to_string()),
        legacy_model,
        connections: connections.iter().map(|c| c.id.clone()).collect(),
    });
    config.connections = connections;
    config
}

fn target(id: &str, model: Option<String>) -> RouteTarget {
    RouteTarget { connection_id: id.to_string(), model }
}

fn with_created(mut conn: LlmConnection, now_ms: i64) -> LlmConnection {
    conn.created_at_ms = Some(now_ms);
    conn
}

/// `llmProvider` / `llmModel` to mirror into `config.json` for the old UI:
/// the default connection's legacy type and model (Claude: its Fast model).
/// `None` without a default connection (nothing is written then).
pub fn mirror_values(config: &LlmConfigFile, claude_fast_model: &str) -> Option<(String, String)> {
    let target = config.routing.default.target.as_ref()?;
    let conn = config.connection(&target.connection_id)?;
    let model = if conn.kind == LlmKind::ClaudeCli {
        claude_fast_model.to_string()
    } else {
        target
            .model
            .clone()
            .filter(|m| !m.trim().is_empty())
            .or_else(|| conn.default_model.clone())
            .unwrap_or_default()
    };
    Some((conn.legacy_type().to_string(), model))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::endpoint::AuthMode;
    use serde_json::json;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nexq-plus-llm-{name}-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn fresh_install_gets_one_ollama_connection() {
        for legacy in [None, Some(json!({})), Some(json!({"llmProvider": "", "theme": "dark"}))] {
            let config = migrate(legacy.as_ref(), 5);
            assert_eq!(config.connections.len(), 1);
            let ollama = &config.connections[0];
            assert_eq!((ollama.id.as_str(), ollama.kind), ("legacy-ollama", LlmKind::Ollama));
            assert_eq!(ollama.base_url, "http://localhost:11434");
            assert_eq!(config.routing.default.target, Some(target("legacy-ollama", None)));
            assert!(config.routing.tasks.is_empty());
            assert_eq!(config.migration.as_ref().unwrap().source, "fresh");
        }
    }

    #[test]
    fn custom_bearer_endpoint_migrates_with_its_old_slot() {
        let legacy = json!({
            "llmProvider": "custom",
            "llmModel": "qwen3-32b",
            "customLlmBaseUrl": "http://192.168.1.10:8000/llm",
            "customLlmAuthType": "bearer",
            "lastModelByProvider": {"custom": "qwen3-32b", "openai": "gpt-4o"},
            "verifiedCloudProviders": ["openai"]
        });
        let config = migrate(Some(&legacy), 9);
        let ids: Vec<&str> = config.connections.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["legacy-custom", "legacy-openai"]);
        let custom = &config.connections[0];
        assert_eq!(custom.base_url, "http://192.168.1.10:8000/llm");
        assert_eq!(custom.auth.mode, AuthMode::Bearer);
        assert_eq!(custom.secret_ref.as_deref(), Some("custom"));
        assert!(custom.compat.ollama_fallback_on_404);
        assert_eq!(custom.default_model.as_deref(), Some("qwen3-32b"));
        let openai = &config.connections[1];
        assert_eq!((openai.default_model.as_deref(), openai.verified_at_ms), (Some("gpt-4o"), Some(9)));
        assert_eq!(openai.secret_ref.as_deref(), Some("openai"));
        assert_eq!(config.routing.default.target, Some(target("legacy-custom", Some("qwen3-32b".into()))));
        let info = config.migration.unwrap();
        assert_eq!((info.legacy_provider.as_deref(), info.legacy_model.as_deref()), (Some("custom"), Some("qwen3-32b")));
    }

    #[test]
    fn claude_with_a_fallback_migrates_both() {
        let legacy = json!({
            "llmProvider": "claude_cli",
            "llmModel": "haiku",
            "claudeCliConfig": {"fast_model": "haiku", "deep_model": "opus", "fallback_provider": "ollama", "fallback_model": "llama3.1:8b"}
        });
        let config = migrate(Some(&legacy), 1);
        let ids: Vec<&str> = config.connections.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["legacy-claude_cli", "legacy-ollama"]);
        assert_eq!(config.routing.default.target, Some(target("legacy-claude_cli", None)), "Claude needs no model");
        assert_eq!(config.connections[1].default_model.as_deref(), Some("llama3.1:8b"));
        // The fallback keeps working through the Claude settings (no route yet).
        assert!(config.routing.tasks.get("claude_fallback").is_none());
        assert_eq!(mirror_values(&config, "haiku"), Some(("claude_cli".to_string(), "haiku".to_string())));
    }

    #[test]
    fn migration_is_repeatable() {
        let legacy = json!({"llmProvider": "groq", "llmModel": "llama-3.3-70b", "lastModelByProvider": {"groq": "x"}});
        assert_eq!(migrate(Some(&legacy), 3), migrate(Some(&legacy), 3));
        // Unknown types are ignored.
        let legacy = json!({"llmProvider": "nope"});
        assert_eq!(migrate(Some(&legacy), 3).connections[0].id, "legacy-ollama");
    }

    #[test]
    fn load_migrates_once_then_reads_the_file() {
        let dir = temp_dir("once");
        let path = dir.join(FILE_NAME);
        let first = load(&path, || Some(json!({"llmProvider": "openai", "llmModel": "gpt-4o"})), 1);
        assert!(first.needs_save && first.warning.is_none());
        save(&path, &first.config).unwrap();
        // Already migrated: the old settings are not even read.
        let second = load(&path, || panic!("must not read config.json again"), 2);
        assert_eq!(second.config, first.config);
        assert!(!second.needs_save && !second.read_only);
        // Saving again keeps the previous version as .bak.
        let mut changed = second.config.clone();
        changed.revision = 7;
        save(&path, &changed).unwrap();
        assert_eq!(read_file(&backup_path(&path)).unwrap().0, first.config);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_corrupt_file_falls_back_to_the_backup_or_starts_over() {
        let dir = temp_dir("corrupt");
        let path = dir.join(FILE_NAME);
        let good = migrate(Some(&json!({"llmProvider": "gemini"})), 1);
        save(&path, &good).unwrap();
        save(&path, &good).unwrap(); // now there is a .bak too
        std::fs::write(&path, "{ not json").unwrap();
        let loaded = load(&path, || None, 2);
        assert_eq!(loaded.warning.as_deref(), Some("restored_from_backup"));
        assert_eq!(loaded.config, good);
        assert!(loaded.needs_save);

        std::fs::write(&path, "[]").unwrap();
        std::fs::remove_file(backup_path(&path)).unwrap();
        let loaded = load(&path, || Some(json!({"llmProvider": "anthropic"})), 3);
        assert_eq!(loaded.warning.as_deref(), Some("reset_corrupt_file"));
        assert_eq!(loaded.config.connections[0].id, "legacy-anthropic");
        assert!(!path.exists(), "the broken file was moved aside");
        assert!(dir.join(format!("{FILE_NAME}.corrupt-3")).exists());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_newer_schema_is_used_read_only() {
        let dir = temp_dir("newer");
        let path = dir.join(FILE_NAME);
        std::fs::write(
            &path,
            json!({"schema_version": 99, "revision": 4, "connections": [{"id": "c_1", "kind": "ollama", "brand_new": true}],
                   "routing": {"default": {"target": {"connection_id": "c_1", "model": "m"}}}})
            .to_string(),
        )
        .unwrap();
        let loaded = load(&path, || None, 1);
        assert!(loaded.read_only && !loaded.needs_save);
        assert_eq!(loaded.config.revision, 4);
        assert_eq!(loaded.config.connections[0].id, "c_1");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn disabling_the_file_migrates_again() {
        let dir = temp_dir("disable");
        let path = dir.join(FILE_NAME);
        save(&path, &migrate(None, 1)).unwrap();
        disable(&path, 42).unwrap();
        assert!(!path.exists() && dir.join(format!("{FILE_NAME}.disabled-42")).exists());
        assert!(load(&path, || None, 43).needs_save);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn mirror_uses_the_route_model_then_the_connection_default() {
        let mut config = migrate(Some(&json!({"llmProvider": "openai", "llmModel": "gpt-4o"})), 1);
        assert_eq!(mirror_values(&config, "haiku"), Some(("openai".into(), "gpt-4o".into())));
        config.routing.default.target.as_mut().unwrap().model = None;
        config.connections[0].default_model = Some("gpt-5".into());
        assert_eq!(mirror_values(&config, "haiku"), Some(("openai".into(), "gpt-5".into())));
        config.routing.default.target = None;
        assert_eq!(mirror_values(&config, "haiku"), None);
    }
}
