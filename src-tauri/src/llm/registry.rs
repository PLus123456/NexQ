//! The LLM connection registry (NexQ Plus): the loaded `llm-connections.json`,
//! one shared client per connection, a concurrency limit per connection for
//! background calls (`complete_text`), task resolution with the Claude
//! fallback, and what follows every change: the old `LLMRouter` façade, the
//! `llmProvider` / `llmModel` mirror in `config.json` and the
//! `llm_config_changed` event.
//!
//! Registered with `app.manage` (not part of `AppState`). Locks are held only
//! to copy data or an `Arc`, never across an `.await`, and the keychain is
//! never read while one is held.

use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeMap, HashMap};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_store::StoreExt;
use tokio::sync::Semaphore;

use super::api::LlmKind;
use super::connections::{
    self, legacy_connection, legacy_id, resolve_route, LlmConfigFile, LlmConnection,
    MigrationInfo, RouteError, RouteParams, RouteTarget, TaskRoute, TaskRouting, KNOWN_TASKS,
};
use super::persist::{self, Loaded};
use super::provider::{
    CompletionStats, GenerationParams, LLMError, LLMMessage, LLMProvider, ModelInfo, TokenSink,
};
use super::{build_provider, LLMRouter, ProviderConfig, ProviderType};
use crate::llm::cli_agent::manager::ClaudeCliConfig;
use crate::llm::cli_agent::routing::ClaudeHealth;
use crate::state::AppState;

/// Tauri event carrying the full [`LlmConfigView`] after every change.
pub const CONFIG_CHANGED_EVENT: &str = "llm_config_changed";
const STORE_FILE: &str = "config.json";

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ── Secrets ─────────────────────────────────────────────────────────────────

/// Where secrets live: the OS keychain, or memory in tests.
pub trait SecretStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn set(&self, account: &str, value: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

/// The keychain (`NexQPlus:<account>`).
pub struct KeychainSecrets;

impl SecretStore for KeychainSecrets {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        crate::credentials::CredentialManager::new().get_key(account)
    }

    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        crate::credentials::CredentialManager::new().store_key(account, value)
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        crate::credentials::CredentialManager::new().delete_key(account)
    }
}

/// Secrets in memory (tests).
#[derive(Default)]
pub struct MemorySecrets(pub Mutex<HashMap<String, String>>);

impl SecretStore for MemorySecrets {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        Ok(self.0.lock().unwrap().get(account).cloned())
    }

    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        self.0.lock().unwrap().insert(account.to_string(), value.to_string());
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(account);
        Ok(())
    }
}

/// `llm:<id>` accounts belong to one connection; old slots (`openai`…) are
/// shared with the old settings and are never deleted by connection removal.
fn owned_account(account: &str) -> bool {
    account.starts_with("llm:")
}

// ── Claude ──────────────────────────────────────────────────────────────────

/// What resolution needs to know about the Claude subscription.
#[derive(Debug, Clone)]
pub struct ClaudeContext {
    pub available: bool,
    /// The Claude settings' fallback type and model, used while the
    /// `claude_fallback` route has no target.
    pub legacy_fallback: Option<(String, Option<String>)>,
    pub fast_model: String,
}

impl Default for ClaudeContext {
    fn default() -> Self {
        Self { available: true, legacy_fallback: None, fast_model: ClaudeCliConfig::default().fast_model }
    }
}

impl ClaudeContext {
    fn from_config(available: bool, cfg: &ClaudeCliConfig) -> Self {
        Self {
            available,
            legacy_fallback: cfg
                .fallback_provider
                .clone()
                .filter(|p| !p.trim().is_empty())
                .map(|p| (p, cfg.fallback_model.clone().filter(|m| !m.trim().is_empty()))),
            fast_model: cfg.fast_model.clone(),
        }
    }
}

/// Claude's health and settings now. Before the frontend has pushed its
/// Claude settings, the values stored in `config.json` stand in.
pub fn claude_context(app: &AppHandle) -> ClaudeContext {
    let Some(state) = app.try_state::<AppState>() else {
        return ClaudeContext::default();
    };
    let available = state.claude_health.get() == ClaudeHealth::Healthy;
    let mut cfg = state.claude_cli_config.read().map(|c| c.clone()).unwrap_or_default();
    if cfg == ClaudeCliConfig::default() {
        if let Some(registry) = app.try_state::<LlmRegistry>() {
            if let Some(stored) = registry.inner.stored_claude.lock().ok().and_then(|s| s.clone()) {
                cfg = stored;
            }
        }
    }
    ClaudeContext::from_config(available, &cfg)
}

// ── Resolution ──────────────────────────────────────────────────────────────

/// A task resolved for a request, the Claude fallback applied.
#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
    pub source: String,
    pub connection: LlmConnection,
    /// `None`: Claude (its settings pick the model), or a fallback whose
    /// model must be looked up (its first listed model, as before).
    pub model: Option<String>,
    pub overrides: Vec<RouteParams>,
    pub via_fallback: bool,
    /// Claude is unavailable and nothing can take over: requests still go
    /// to Claude, which reports why.
    pub no_fallback: bool,
}

/// Resolves `key` and, when it lands on an unavailable Claude, the fallback:
/// the `claude_fallback` route's own target, else the Claude settings'
/// fallback type (its `legacy-<type>` connection), else the default route
/// when that isn't Claude.
pub fn resolve_task(cfg: &LlmConfigFile, key: &str, claude: &ClaudeContext) -> Result<Resolved, (RouteError, Option<LlmConnection>)> {
    let r = resolve_route(cfg, key)?;
    let primary = Resolved {
        source: r.source,
        connection: r.connection,
        model: r.model,
        overrides: r.overrides,
        via_fallback: false,
        no_fallback: false,
    };
    // Frequent, deadline-bound detection needs cancellation-safe HTTP requests.
    // Claude Utility sessions initialize outside cancellation and may outlive a
    // 2.5-second detector deadline. Use local rules instead of a CLI/fallback.
    if key == "question_detect" && primary.connection.kind == LlmKind::ClaudeCli {
        return Err((RouteError::NotConfigured, Some(primary.connection)));
    }
    if primary.connection.kind != LlmKind::ClaudeCli || claude.available {
        return Ok(primary);
    }
    match fallback(cfg, claude) {
        Some(fallback) => Ok(fallback),
        None => Ok(Resolved { no_fallback: true, ..primary }),
    }
}

fn fallback(cfg: &LlmConfigFile, claude: &ClaudeContext) -> Option<Resolved> {
    let not_claude = |r: &connections::RouteResolution| r.connection.kind != LlmKind::ClaudeCli;
    let explicit = cfg
        .routing
        .tasks
        .get("claude_fallback")
        .and_then(|r| r.target.as_ref())
        .is_some_and(|t| cfg.connection(&t.connection_id).is_some());
    if explicit {
        let r = resolve_route(cfg, "claude_fallback").ok().filter(not_claude)?;
        return Some(Resolved {
            source: r.source,
            connection: r.connection,
            model: r.model,
            overrides: r.overrides,
            via_fallback: true,
            no_fallback: false,
        });
    }
    if let Some((provider, model)) = &claude.legacy_fallback {
        let pt = ProviderType::from_str(provider).ok().filter(|pt| *pt != ProviderType::ClaudeCli)?;
        let conn = cfg
            .connection(&legacy_id(pt.as_str()))
            .cloned()
            .unwrap_or_else(|| legacy_connection(&pt, None, None, None));
        if !conn.enabled {
            return None;
        }
        let model = model.clone().or_else(|| conn.default_model.clone());
        return Some(Resolved {
            source: "claude_fallback".to_string(),
            connection: conn,
            model,
            overrides: Vec::new(),
            via_fallback: true,
            no_fallback: false,
        });
    }
    let r = resolve_route(cfg, "default").ok().filter(not_claude)?;
    Some(Resolved {
        source: r.source,
        connection: r.connection,
        model: r.model,
        overrides: r.overrides,
        via_fallback: true,
        no_fallback: false,
    })
}

/// Why a task can't run, for errors shown in the app (English).
pub fn route_error_message(key: &str, error: RouteError, conn: Option<&LlmConnection>) -> String {
    let name = conn.map(|c| c.display_name()).unwrap_or_default();
    match error {
        RouteError::NotConfigured if key == "question_detect" =>
            "Question detection needs its own available connection and model in Settings → AI Models → Task routing".to_string(),
        RouteError::NotConfigured => format!(
            "No AI model is set up for \"{key}\": pick a default connection and model in Settings → AI Models"
        ),
        RouteError::ConnectionMissing => format!(
            "The connection chosen for \"{key}\" was deleted: pick another one in Settings → AI Models"
        ),
        RouteError::ConnectionDisabled => format!("The connection \"{name}\" chosen for \"{key}\" is turned off"),
        RouteError::NoModel => format!("No model is chosen for \"{key}\" on \"{name}\": type or pick one in Settings → AI Models"),
        RouteError::BaseUrlMissing => format!("The connection \"{name}\" has no Base URL yet"),
    }
}

// ── View ────────────────────────────────────────────────────────────────────

/// A connection as the frontend sees it (no secret values).
#[derive(Debug, Clone, Serialize)]
pub struct ConnectionView {
    #[serde(flatten)]
    pub connection: LlmConnection,
    pub legacy_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TaskInfo {
    pub key: String,
    pub parent: Option<String>,
}

/// What a task resolves to now, for the routing table.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct EffectiveRoute {
    pub source: Option<String>,
    pub connection_id: Option<String>,
    pub connection_name: Option<String>,
    pub kind: Option<LlmKind>,
    pub model: Option<String>,
    pub via_fallback: bool,
    pub error: Option<String>,
}

/// `llm_get_config` / `llm_config_changed` (`contract-llm.md` §3.1).
#[derive(Debug, Clone, Serialize)]
pub struct LlmConfigView {
    pub schema_version: u32,
    pub revision: u64,
    pub read_only: bool,
    pub load_warning: Option<String>,
    pub connections: Vec<ConnectionView>,
    pub routing: TaskRouting,
    pub response_language: String,
    pub migration: Option<MigrationInfo>,
    pub known_tasks: Vec<TaskInfo>,
    pub effective: BTreeMap<String, EffectiveRoute>,
    pub claude_available: bool,
}

pub fn effective_route(cfg: &LlmConfigFile, key: &str, claude: &ClaudeContext) -> EffectiveRoute {
    if key == "claude_fallback" {
        // What takes over when Claude is down (never Claude itself).
        let down = ClaudeContext { available: false, ..claude.clone() };
        return match fallback(cfg, &down) {
            Some(r) => EffectiveRoute {
                source: Some(r.source),
                connection_id: Some(r.connection.id.clone()),
                connection_name: Some(r.connection.display_name()),
                kind: Some(r.connection.kind),
                model: r.model,
                via_fallback: false,
                error: None,
            },
            None => EffectiveRoute { error: Some("no_fallback".to_string()), ..Default::default() },
        };
    }
    match resolve_task(cfg, key, claude) {
        Ok(r) => EffectiveRoute {
            source: Some(r.source),
            connection_id: Some(r.connection.id.clone()),
            connection_name: Some(r.connection.display_name()),
            kind: Some(r.connection.kind),
            model: r.model,
            via_fallback: r.via_fallback,
            error: r.no_fallback.then(|| "no_fallback".to_string()),
        },
        Err((error, conn)) => EffectiveRoute {
            connection_id: conn.as_ref().map(|c| c.id.clone()),
            connection_name: conn.as_ref().map(|c| c.display_name()),
            kind: conn.as_ref().map(|c| c.kind),
            error: Some(error.code().to_string()),
            ..Default::default()
        },
    }
}

/// Every key the view describes: the known tasks plus any routed key.
fn view_keys(cfg: &LlmConfigFile) -> Vec<String> {
    let mut keys: Vec<String> = KNOWN_TASKS.iter().map(|(k, _)| k.to_string()).collect();
    for key in cfg.routing.tasks.keys() {
        if !keys.contains(key) {
            keys.push(key.clone());
        }
    }
    keys
}

// ── The registry ────────────────────────────────────────────────────────────

struct CachedProvider {
    fingerprint: u64,
    provider: Arc<dyn LLMProvider>,
}

struct State {
    config: LlmConfigFile,
    read_only: bool,
    load_warning: Option<String>,
}

struct Inner {
    state: RwLock<State>,
    providers: Mutex<HashMap<String, CachedProvider>>,
    semaphores: Mutex<HashMap<String, (usize, Arc<Semaphore>)>>,
    /// Secrets handed over by the old `set_llm_provider` (this session only).
    overrides: Mutex<HashMap<String, String>>,
    secrets: Arc<dyn SecretStore>,
    path: Option<PathBuf>,
    /// Last `(llmProvider, llmModel)` written to `config.json`.
    mirrored: Mutex<Option<(String, String)>>,
    /// The Claude settings stored in `config.json`, until the frontend pushes them.
    stored_claude: Mutex<Option<ClaudeCliConfig>>,
}

/// Cheap to clone: every clone is the same registry.
#[derive(Clone)]
pub struct LlmRegistry {
    inner: Arc<Inner>,
}

/// What a connection upsert must do in the keychain.
#[derive(Debug, Default, PartialEq)]
struct KeychainPlan {
    delete: Vec<String>,
    write: Vec<(String, String)>,
}

impl LlmRegistry {
    pub fn new(loaded: Loaded, path: Option<PathBuf>, secrets: Arc<dyn SecretStore>) -> Self {
        Self {
            inner: Arc::new(Inner {
                state: RwLock::new(State { config: loaded.config, read_only: loaded.read_only, load_warning: loaded.warning }),
                providers: Mutex::new(HashMap::new()),
                semaphores: Mutex::new(HashMap::new()),
                overrides: Mutex::new(HashMap::new()),
                secrets,
                path,
                mirrored: Mutex::new(None),
                stored_claude: Mutex::new(None),
            }),
        }
    }

    /// A copy of the current config.
    pub fn config(&self) -> LlmConfigFile {
        self.inner.state.read().map(|s| s.config.clone()).unwrap_or_default()
    }

    pub fn read_only(&self) -> bool {
        self.inner.state.read().map(|s| s.read_only).unwrap_or(false)
    }

    pub fn view(&self, claude: &ClaudeContext) -> LlmConfigView {
        let (config, read_only, load_warning) = match self.inner.state.read() {
            Ok(s) => (s.config.clone(), s.read_only, s.load_warning.clone()),
            Err(_) => (LlmConfigFile::default(), false, None),
        };
        let effective = view_keys(&config)
            .into_iter()
            .map(|key| {
                let route = effective_route(&config, &key, claude);
                (key, route)
            })
            .collect();
        LlmConfigView {
            schema_version: config.schema_version,
            revision: config.revision,
            read_only,
            load_warning,
            connections: config
                .connections
                .iter()
                .map(|c| ConnectionView { legacy_type: c.legacy_type().to_string(), connection: c.clone() })
                .collect(),
            routing: config.routing.clone(),
            response_language: config.response_language.clone(),
            migration: config.migration.clone(),
            known_tasks: KNOWN_TASKS
                .iter()
                .map(|(k, p)| TaskInfo { key: k.to_string(), parent: p.map(str::to_string) })
                .collect(),
            effective,
            claude_available: claude.available,
        }
    }

    /// Applies `change` to a copy of the config; on success the copy gets
    /// the next revision, is saved (unless read-only) and becomes current.
    pub fn mutate<T>(&self, change: impl FnOnce(&mut LlmConfigFile) -> Result<T, String>) -> Result<(T, LlmConfigFile), String> {
        let mut state = self.inner.state.write().map_err(|_| "LLM settings lock poisoned".to_string())?;
        let mut next = state.config.clone();
        let out = change(&mut next)?;
        next.revision = state.config.revision + 1;
        if !state.read_only {
            if let Some(path) = &self.inner.path {
                persist::save(path, &next).map_err(|e| format!("Could not save the LLM settings: {e}"))?;
            }
        }
        state.config = next.clone();
        Ok((out, next))
    }

    // ── Clients ──

    /// The shared client of `conn`, built on first use (that is when its
    /// secret is read from the keychain) and rebuilt when it changes.
    pub fn provider_for(&self, conn: &LlmConnection) -> Result<Arc<dyn LLMProvider>, String> {
        let fingerprint = self.fingerprint(conn);
        if let Some(cached) = self.inner.providers.lock().ok().and_then(|p| {
            p.get(&conn.id).filter(|c| c.fingerprint == fingerprint).map(|c| c.provider.clone())
        }) {
            return Ok(cached);
        }
        let secret = match self.secret_for(conn) {
            Ok(secret) => secret,
            Err(e) => {
                log::warn!("LLM connection {}: could not read its key: {e}", conn.id);
                None
            }
        };
        let header_secrets = self.header_secrets(conn);
        let provider: Arc<dyn LLMProvider> = Arc::from(build_provider(conn, secret.as_deref(), &header_secrets)?);
        if let Ok(mut providers) = self.inner.providers.lock() {
            providers.insert(conn.id.clone(), CachedProvider { fingerprint, provider: provider.clone() });
        }
        Ok(provider)
    }

    fn fingerprint(&self, conn: &LlmConnection) -> u64 {
        let mut client_fields = conn.clone();
        client_fields.model_cache = None;
        client_fields.verified_at_ms = None;
        client_fields.secret_hint = None;
        client_fields.created_at_ms = None;
        client_fields.default_model = None;
        client_fields.manual_models.clear();
        let mut hasher = DefaultHasher::new();
        serde_json::to_string(&client_fields).unwrap_or_default().hash(&mut hasher);
        self.inner.overrides.lock().ok().and_then(|o| o.get(&conn.id).cloned()).hash(&mut hasher);
        hasher.finish()
    }

    /// Whether `conn` (a draft) sends exactly the requests its saved
    /// version sends (same id, same request settings, same server).
    pub fn matches_saved(&self, conn: &LlmConnection) -> bool {
        let config = self.config();
        config
            .connection(&conn.id)
            .is_some_and(|saved| self.fingerprint(saved) == self.fingerprint(conn))
    }

    /// Forget the client of `id` (its secret changed).
    pub fn invalidate(&self, id: &str) {
        if let Ok(mut providers) = self.inner.providers.lock() {
            providers.remove(id);
        }
    }

    /// The secret of `conn`: one handed over by the old UI this session,
    /// else its keychain slot.
    pub fn secret_for(&self, conn: &LlmConnection) -> Result<Option<String>, String> {
        if let Some(secret) = self.inner.overrides.lock().ok().and_then(|o| o.get(&conn.id).cloned()) {
            return Ok(Some(secret));
        }
        match conn.secret_ref.as_deref() {
            Some(account) => self.inner.secrets.get(account),
            None => Ok(None),
        }
    }

    /// Auth and custom headers of `conn` with their secrets (for direct HTTP
    /// use by other packages; never log them unmasked).
    pub fn request_headers(&self, conn: &LlmConnection) -> Result<Vec<(String, String)>, String> {
        let secret = self.secret_for(conn)?;
        let header_secrets = self.header_secrets(conn);
        let custom: Vec<crate::net::endpoint::CustomHeader> = conn
            .headers
            .iter()
            .filter_map(|h| {
                let value = if h.secret {
                    header_secrets.get(&h.name.trim().to_ascii_lowercase())?.clone()
                } else {
                    h.value.clone()
                };
                Some(crate::net::endpoint::CustomHeader { name: h.name.clone(), value })
            })
            .collect();
        crate::net::endpoint::request_headers(&conn.auth, secret.as_deref(), &custom).map_err(|e| e.to_string())
    }

    fn header_secrets(&self, conn: &LlmConnection) -> HashMap<String, String> {
        conn.headers
            .iter()
            .filter(|h| h.secret && h.value_saved)
            .filter_map(|h| {
                let value = self.inner.secrets.get(&conn.header_secret_account(&h.name)).ok().flatten()?;
                Some((h.name.trim().to_ascii_lowercase(), value))
            })
            .collect()
    }

    /// The per-connection limit for background calls.
    pub fn semaphore_for(&self, conn: &LlmConnection) -> Arc<Semaphore> {
        let limit = conn.max_concurrency();
        let mut map = match self.inner.semaphores.lock() {
            Ok(map) => map,
            Err(_) => return Arc::new(Semaphore::new(limit)),
        };
        match map.get(&conn.id) {
            Some((current, sem)) if *current == limit => sem.clone(),
            _ => {
                let sem = Arc::new(Semaphore::new(limit));
                map.insert(conn.id.clone(), (limit, sem.clone()));
                sem
            }
        }
    }

    // ── Changes ──

    /// Saves a connection from the settings page (`llm_upsert_connection`).
    /// Returns its id and the new config.
    pub fn upsert(&self, input: Value, secret: Option<String>) -> Result<(String, LlmConfigFile), String> {
        let snapshot = self.config();
        let (mut conn, plan) = prepare_upsert(&snapshot, input, now_ms())?;
        for account in &plan.delete {
            if let Err(e) = self.inner.secrets.delete(account) {
                log::debug!("LLM settings: could not delete keychain item {account}: {e}");
            }
        }
        for (account, value) in &plan.write {
            self.inner.secrets.set(account, value)?;
        }
        if let Some(secret) = secret {
            self.store_secret(&mut conn, &secret)?;
        }
        let id = conn.id.clone();
        let (_, config) = self.mutate(|cfg| {
            match cfg.connection_mut(&conn.id) {
                Some(existing) => *existing = conn,
                None => cfg.connections.push(conn),
            }
            Ok(())
        })?;
        self.clear_override(&id);
        self.invalidate(&id);
        Ok((id, config))
    }

    /// Writes (or with an empty value deletes) `conn`'s secret and updates
    /// its `secret_ref` / `secret_hint`.
    fn store_secret(&self, conn: &mut LlmConnection, secret: &str) -> Result<(), String> {
        let secret = secret.trim();
        let account = conn.secret_ref.clone().unwrap_or_else(|| format!("llm:{}", conn.id));
        if secret.is_empty() {
            if let Err(e) = self.inner.secrets.delete(&account) {
                log::debug!("LLM settings: could not delete keychain item {account}: {e}");
            }
            conn.secret_hint = None;
        } else {
            self.inner.secrets.set(&account, secret)?;
            conn.secret_ref = Some(account);
            conn.secret_hint = connections::secret_hint(secret);
        }
        Ok(())
    }

    /// `llm_set_secret`.
    pub fn set_secret(&self, id: &str, secret: Option<&str>) -> Result<(SecretStatus, LlmConfigFile), String> {
        let mut conn = self.config().connection(id).cloned().ok_or_else(|| format!("Unknown LLM connection \"{id}\""))?;
        self.store_secret(&mut conn, secret.unwrap_or_default())?;
        let status = SecretStatus { present: conn.secret_hint.is_some(), hint: conn.secret_hint.clone() };
        let (_, config) = self.mutate(|cfg| {
            let existing = cfg.connection_mut(id).ok_or_else(|| format!("Unknown LLM connection \"{id}\""))?;
            existing.secret_ref = conn.secret_ref.clone();
            existing.secret_hint = conn.secret_hint.clone();
            Ok(())
        })?;
        self.clear_override(id);
        self.invalidate(id);
        Ok((status, config))
    }

    /// `llm_secret_status`: reads the keychain; records the hint when it
    /// was unknown. Returns the new config when that changed it.
    pub fn secret_status(&self, id: &str) -> Result<(SecretStatus, Option<LlmConfigFile>), String> {
        let conn = self.config().connection(id).cloned().ok_or_else(|| format!("Unknown LLM connection \"{id}\""))?;
        let secret = self.secret_for(&conn)?;
        let hint = secret.as_deref().and_then(connections::secret_hint);
        let status = SecretStatus { present: hint.is_some(), hint: hint.clone() };
        if hint == conn.secret_hint {
            return Ok((status, None));
        }
        let (_, config) = self.mutate(|cfg| {
            if let Some(existing) = cfg.connection_mut(id) {
                existing.secret_hint = hint;
            }
            Ok(())
        })?;
        Ok((status, Some(config)))
    }

    /// `llm_delete_connection`: removes it and the routes to it; returns the
    /// cleared task keys.
    pub fn delete(&self, id: &str) -> Result<(Vec<String>, LlmConfigFile), String> {
        let (removed, cleared, config) = {
            let ((removed, cleared), config) = self.mutate(|cfg| {
                let index = cfg.connections.iter().position(|c| c.id == id).ok_or_else(|| format!("Unknown LLM connection \"{id}\""))?;
                let removed = cfg.connections.remove(index);
                let cleared = connections::clear_routes_to(&mut cfg.routing, id);
                Ok((removed, cleared))
            })?;
            (removed, cleared, config)
        };
        let mut accounts: Vec<String> = removed.secret_ref.iter().filter(|a| owned_account(a)).cloned().collect();
        accounts.extend(removed.headers.iter().filter(|h| h.secret).map(|h| removed.header_secret_account(&h.name)));
        for account in accounts {
            if let Err(e) = self.inner.secrets.delete(&account) {
                log::debug!("LLM settings: could not delete keychain item {account}: {e}");
            }
        }
        self.clear_override(id);
        self.invalidate(id);
        Ok((cleared, config))
    }

    /// `llm_set_route`.
    pub fn set_route(&self, task: &str, route: Option<TaskRoute>) -> Result<LlmConfigFile, String> {
        let task = task.trim();
        if !connections::is_valid_task_key(task) {
            return Err(format!("Unknown task \"{task}\""));
        }
        let mut route = route;
        if let Some(r) = route.as_mut() {
            connections::validate_params(&r.params)?;
            if let Some(target) = r.target.as_mut() {
                target.model = target.model.take().map(|m| m.trim().to_string()).filter(|m| !m.is_empty());
            }
            if r.params.extra_body.as_ref().is_some_and(|e| e.is_empty()) {
                r.params.extra_body = None;
            }
        }
        let (_, config) = self.mutate(|cfg| {
            if let Some(target) = route.as_ref().and_then(|r| r.target.as_ref()) {
                if cfg.connection(&target.connection_id).is_none() {
                    return Err(format!("Unknown LLM connection \"{}\"", target.connection_id));
                }
            }
            if task == "default" {
                cfg.routing.default = route.unwrap_or_default();
            } else {
                match route {
                    Some(r) if r.target.is_some() || !r.params.is_empty() => {
                        cfg.routing.tasks.insert(task.to_string(), r);
                    }
                    _ => {
                        cfg.routing.tasks.remove(task);
                    }
                }
            }
            Ok(())
        })?;
        Ok(config)
    }

    /// `llm_set_response_language`.
    pub fn set_response_language(&self, value: &str) -> Result<LlmConfigFile, String> {
        let value = value.trim();
        if !(value == "ui" || value == "transcript" || is_language_code(value)) {
            return Err(format!("Unknown response language \"{value}\""));
        }
        self.mutate(|cfg| {
            cfg.response_language = value.to_string();
            Ok(())
        })
        .map(|(_, cfg)| cfg)
    }

    /// Stores a model list answer (or its failure) on connection `id`.
    pub fn record_models(&self, id: &str, url: Option<String>, result: Result<Vec<ModelInfo>, String>) -> Result<LlmConfigFile, String> {
        self.mutate(|cfg| {
            let conn = cfg.connection_mut(id).ok_or_else(|| format!("Unknown LLM connection \"{id}\""))?;
            let previous = conn.model_cache.take().unwrap_or_default();
            conn.model_cache = Some(match result {
                Ok(models) => connections::ModelCache {
                    models: models.into_iter().map(Into::into).collect(),
                    fetched_at_ms: now_ms(),
                    url,
                    error: None,
                },
                Err(error) => connections::ModelCache { fetched_at_ms: now_ms(), url, error: Some(error), ..previous },
            });
            Ok(())
        })
        .map(|(_, cfg)| cfg)
    }

    /// A successful connection test on `id`.
    pub fn mark_verified(&self, id: &str) -> Result<LlmConfigFile, String> {
        self.mutate(|cfg| {
            if let Some(conn) = cfg.connection_mut(id) {
                conn.verified_at_ms = Some(now_ms());
            }
            Ok(())
        })
        .map(|(_, cfg)| cfg)
    }

    /// The task's connection kind (no fallback applied), if it resolves.
    pub fn route_kind(&self, key: &str) -> Option<LlmKind> {
        resolve_route(&self.config(), key).ok().map(|r| r.connection.kind)
    }

    /// A connection being edited (not saved), with the secrets it may use:
    /// `secret` when given, else the saved one when the draft is a saved
    /// connection on the same server (kind and origin unchanged).
    pub fn draft(&self, input: Value, secret: Option<String>) -> Result<(LlmConnection, Option<String>, HashMap<String, String>), String> {
        let snapshot = self.config();
        let (mut conn, plan) = prepare_upsert(&snapshot, input, now_ms())?;
        let saved = snapshot.connection(&conn.id).filter(|prev| connections::secret_stays_valid(prev, &conn)).cloned();
        let secret = match secret.map(|s| s.trim().to_string()) {
            Some(s) => Some(s).filter(|s| !s.is_empty()),
            None => match &saved {
                Some(prev) => self.secret_for(prev).unwrap_or_else(|e| {
                    log::warn!("LLM connection {}: could not read its key: {e}", prev.id);
                    None
                }),
                None => None,
            },
        };
        let mut header_secrets = saved.as_ref().map(|prev| self.header_secrets(prev)).unwrap_or_default();
        // Secret header values typed in the editor (moved into the keychain plan).
        for (account, value) in plan.write {
            if let Some((_, name)) = account.split_once(":h:") {
                header_secrets.insert(name.to_string(), value);
            }
        }
        for header in &mut conn.headers {
            if header.secret {
                header.value_saved = header_secrets.contains_key(&header.name.trim().to_ascii_lowercase());
            }
        }
        Ok((conn, secret, header_secrets))
    }

    /// `llm_reset_from_legacy`: the file is moved aside and the old
    /// settings are migrated again.
    pub fn reset_from_legacy(&self, legacy: Option<Value>) -> Result<LlmConfigFile, String> {
        if let Some(path) = &self.inner.path {
            if !self.read_only() {
                persist::disable(path, now_ms()).map_err(|e| format!("Could not move the LLM settings aside: {e}"))?;
            }
        }
        let fresh = persist::migrate(legacy.as_ref(), now_ms());
        let (_, config) = self.mutate(|cfg| {
            *cfg = fresh;
            Ok(())
        })?;
        if let Ok(mut providers) = self.inner.providers.lock() {
            providers.clear();
        }
        if let Ok(mut overrides) = self.inner.overrides.lock() {
            overrides.clear();
        }
        Ok(config)
    }

    // ── Old commands (shims) ──

    /// `set_llm_provider`: the default route points at `legacy-<type>`
    /// (created when missing). Idempotent: when the default connection
    /// already stands for this type nothing changes, so the old startup
    /// push never undoes a route chosen in the new settings. A key in the
    /// config is kept in memory for this connection only.
    pub fn apply_legacy_provider(&self, config: &ProviderConfig) -> Result<bool, String> {
        let (pt, mut legacy, secret) = super::legacy_from_config_lenient(config)?;
        let id = legacy.id.clone();
        if let Some(secret) = secret {
            self.set_override(&id, secret);
        }
        let snapshot = self.config();
        if snapshot.default_connection().map(|c| c.legacy_type()) == Some(pt.as_str()) {
            return Ok(false);
        }
        if pt.requires_api_key() && self.inner.overrides.lock().ok().and_then(|o| o.get(&id).cloned()).is_none() {
            // As before: a cloud type can't be activated without its key.
            let has_key = snapshot
                .connection(&id)
                .or(Some(&legacy))
                .and_then(|c| self.secret_for(c).ok().flatten())
                .is_some();
            if !has_key {
                return Err(format!("{} API key required", pt.display_name()));
            }
        }
        legacy.created_at_ms = Some(now_ms());
        let carries_base = config.base_url.as_deref().is_some_and(|b| !b.trim().is_empty());
        let carries_auth = pt == ProviderType::Custom && config.auth_type.is_some();
        if pt == ProviderType::Custom {
            let base = if carries_base {
                legacy.base_url.clone()
            } else {
                snapshot.connection(&id).map(|c| c.base_url.clone()).unwrap_or_default()
            };
            if base.trim().is_empty() {
                return Err("Custom endpoint base URL required".to_string());
            }
        }
        let (dropped, _) = self.mutate(|cfg| {
            let mut dropped: Vec<String> = Vec::new();
            match cfg.connection_mut(&id) {
                Some(existing) => {
                    // The old UI activated this type with these settings.
                    if carries_base && legacy.base_url != existing.base_url {
                        let before = existing.clone();
                        existing.base_url = legacy.base_url.clone();
                        if !connections::secret_stays_valid(&before, existing) {
                            // A key entered in the new settings was given for the old
                            // server: forget it. The old shared slots (`custom`…) stay
                            // bound — the old settings resend their key with the
                            // address they hold, as they always did.
                            if let Some(account) = existing.secret_ref.clone().filter(|a| owned_account(a)) {
                                existing.secret_ref = None;
                                existing.secret_hint = None;
                                dropped.push(account);
                            }
                            for header in existing.headers.iter_mut().filter(|h| h.secret && h.value_saved) {
                                header.value_saved = false;
                                dropped.push(before.header_secret_account(&header.name));
                            }
                            existing.verified_at_ms = None;
                            existing.model_cache = None;
                        }
                    }
                    if carries_auth {
                        existing.auth = legacy.auth.clone();
                    }
                    existing.enabled = true;
                }
                None => cfg.connections.push(legacy),
            }
            cfg.routing.default.target = Some(RouteTarget { connection_id: id.clone(), model: None });
            Ok(dropped)
        })?;
        for account in dropped {
            if let Err(e) = self.inner.secrets.delete(&account) {
                log::debug!("LLM settings: could not delete keychain item {account}: {e}");
            }
        }
        self.invalidate(&id);
        Ok(true)
    }

    /// `set_active_model`: the default route's model, when the default
    /// connection stands for `provider` (else ignored).
    pub fn apply_legacy_model(&self, provider: &str, model: &str) -> Result<bool, String> {
        let model = model.trim();
        let snapshot = self.config();
        let Some(conn) = snapshot.default_connection() else {
            return Ok(false);
        };
        if conn.kind == LlmKind::ClaudeCli || (!provider.is_empty() && conn.legacy_type() != provider) {
            if conn.legacy_type() != provider {
                log::info!("set_active_model({provider}, …) ignored: the default connection is {}", conn.id);
            }
            return Ok(false);
        }
        let current = snapshot.routing.default.target.as_ref().and_then(|t| t.model.clone());
        let next = (!model.is_empty()).then(|| model.to_string());
        if current == next {
            return Ok(false);
        }
        self.mutate(|cfg| {
            if let Some(target) = cfg.routing.default.target.as_mut() {
                target.model = next;
            }
            Ok(())
        })?;
        Ok(true)
    }

    fn set_override(&self, id: &str, secret: String) {
        if let Ok(mut overrides) = self.inner.overrides.lock() {
            if overrides.get(id) != Some(&secret) {
                overrides.insert(id.to_string(), secret);
            }
        }
    }

    fn clear_override(&self, id: &str) {
        if let Ok(mut overrides) = self.inner.overrides.lock() {
            overrides.remove(id);
        }
    }

    // ── Façade and mirror ──

    /// Points the old router at the default route: its connection (built
    /// lazily, so no keychain read happens here), model and legacy type,
    /// and whether any task uses Claude.
    pub fn sync_router(&self, router: &mut LLMRouter, claude: &ClaudeContext) {
        let config = self.config();
        match config.default_connection() {
            Some(conn) => {
                let provider: Arc<dyn LLMProvider> = Arc::new(LazyConnectionProvider { registry: self.clone(), connection: conn.clone() });
                let model = match resolve_route(&config, "default") {
                    Ok(r) if conn.kind == LlmKind::ClaudeCli => {
                        let _ = r;
                        claude.fast_model.clone()
                    }
                    Ok(r) => r.model.unwrap_or_default(),
                    Err(_) => String::new(),
                };
                router.set_shared_provider(Some(provider), ProviderType::from_str(conn.legacy_type()).ok());
                router.set_active_model(model);
            }
            None => {
                router.set_shared_provider(None, None);
                router.set_active_model(String::new());
            }
        }
        let claude_in_use = view_keys(&config).iter().any(|key| {
            resolve_route(&config, key).is_ok_and(|r| r.connection.kind == LlmKind::ClaudeCli)
        });
        router.set_claude_in_use(claude_in_use);
    }

    /// Writes `llmProvider` / `llmModel` to `config.json` when the default
    /// route changed since the last write (or since the stored values).
    pub fn mirror(&self, app: &AppHandle, claude: &ClaudeContext) {
        let Some((provider, model)) = persist::mirror_values(&self.config(), &claude.fast_model) else {
            return;
        };
        let pair = (provider.clone(), model.clone());
        if self.inner.mirrored.lock().ok().is_some_and(|m| m.as_ref() == Some(&pair)) {
            return;
        }
        let Ok(store) = app.store(STORE_FILE) else {
            log::warn!("LLM settings: config.json store unavailable; llmProvider not mirrored");
            return;
        };
        let stored_provider = store.get("llmProvider").and_then(|v| v.as_str().map(str::to_string)).unwrap_or_else(|| "ollama".to_string());
        let stored_model = store.get("llmModel").and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
        if stored_provider != provider || stored_model != model {
            store.set("llmProvider", Value::String(provider));
            store.set("llmModel", Value::String(model));
            if let Err(e) = store.save() {
                log::warn!("LLM settings: could not save config.json: {e}");
            }
        }
        if let Ok(mut mirrored) = self.inner.mirrored.lock() {
            *mirrored = Some(pair);
        }
    }
}

/// `llm_secret_status` / `llm_set_secret`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SecretStatus {
    pub present: bool,
    pub hint: Option<String>,
}

/// A language code such as `zh-CN`, `en`, `ja`, `pt-BR`, `zh-Hant`.
fn is_language_code(value: &str) -> bool {
    let mut parts = value.split('-');
    let Some(first) = parts.next() else { return false };
    (2..=3).contains(&first.len())
        && first.chars().all(|c| c.is_ascii_alphabetic())
        && parts.all(|p| (2..=8).contains(&p.len()) && p.chars().all(|c| c.is_ascii_alphanumeric()))
}

/// A connection id given by the caller: `c_<hex>`, `legacy-<type>` or a
/// short `[A-Za-z0-9_-]` id.
fn is_valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// The connection to save and what the keychain must do (pure: the
/// registry runs the keychain plan, then commits the connection).
fn prepare_upsert(snapshot: &LlmConfigFile, input: Value, now: i64) -> Result<(LlmConnection, KeychainPlan), String> {
    let mut input = input;
    connections::accept_input_aliases(&mut input);
    let Value::Object(fields) = &input else {
        return Err("A connection must be a JSON object".to_string());
    };
    let has_auth = fields.contains_key("auth");
    let has_compat = fields.contains_key("compat");
    let mut conn: LlmConnection = serde_json::from_value(input.clone()).map_err(|e| format!("Invalid connection: {e}"))?;
    if !has_auth {
        conn.auth = connections::auth_for_kind(conn.kind);
    }
    if !has_compat {
        conn.compat = connections::CompatFlags::for_kind(conn.kind);
    }
    conn.id = conn.id.trim().to_string();
    connections::normalize_connection(&mut conn);
    connections::validate_connection(&conn)?;

    let previous = if conn.id.is_empty() { None } else { snapshot.connection(&conn.id).cloned() };
    if conn.id.is_empty() {
        let mut id = connections::new_connection_id();
        while snapshot.connection(&id).is_some() {
            id = connections::new_connection_id();
        }
        conn.id = id;
    } else if !is_valid_id(&conn.id) {
        return Err(format!("Invalid connection id \"{}\"", conn.id));
    }

    let mut plan = KeychainPlan::default();
    match &previous {
        Some(prev) => {
            conn.secret_ref = prev.secret_ref.clone();
            conn.secret_hint = prev.secret_hint.clone();
            conn.model_cache = prev.model_cache.clone();
            conn.verified_at_ms = prev.verified_at_ms;
            conn.created_at_ms = prev.created_at_ms.or(Some(now));
            if !connections::secret_stays_valid(prev, &conn) {
                // The key was given for another server: forget it (old shared
                // slots stay untouched for the old settings).
                if let Some(account) = prev.secret_ref.as_deref().filter(|a| owned_account(a)) {
                    plan.delete.push(account.to_string());
                }
                conn.secret_ref = None;
                conn.secret_hint = None;
                conn.verified_at_ms = None;
                for header in conn.headers.iter_mut().filter(|h| h.secret) {
                    header.value_saved = false;
                }
                for header in prev.headers.iter().filter(|h| h.secret) {
                    plan.delete.push(prev.header_secret_account(&header.name));
                }
            }
            if prev.base_url != conn.base_url
                || prev.kind != conn.kind
                || prev.models_endpoint != conn.models_endpoint
                || prev.models_url != conn.models_url
            {
                conn.model_cache = None;
            }
        }
        None => {
            conn.secret_ref = None;
            conn.secret_hint = None;
            conn.model_cache = None;
            conn.verified_at_ms = None;
            conn.created_at_ms = Some(now);
        }
    }

    // Secret header values go to the keychain; the file keeps them empty.
    let previous_headers = previous.as_ref().map(|p| p.headers.clone()).unwrap_or_default();
    for header in conn.headers.iter_mut() {
        let account = format!("llm:{}:h:{}", conn.id, header.name.trim().to_ascii_lowercase());
        if header.secret {
            if !header.value.is_empty() {
                plan.write.push((account, header.value.trim().to_string()));
                header.value.clear();
                header.value_saved = true;
            } else if !plan.delete.contains(&account) {
                header.value_saved = previous_headers
                    .iter()
                    .any(|h| h.secret && h.value_saved && h.name.eq_ignore_ascii_case(&header.name));
            } else {
                header.value_saved = false;
            }
        } else {
            header.value_saved = false;
            if previous_headers.iter().any(|h| h.secret && h.name.eq_ignore_ascii_case(&header.name)) {
                plan.delete.push(account);
            }
        }
    }
    for old in previous_headers.iter().filter(|h| h.secret) {
        if !conn.headers.iter().any(|h| h.name.eq_ignore_ascii_case(&old.name)) {
            let account = format!("llm:{}:h:{}", conn.id, old.name.trim().to_ascii_lowercase());
            if !plan.delete.contains(&account) {
                plan.delete.push(account);
            }
        }
    }
    Ok((conn, plan))
}

/// The default connection for the old router: builds its client on first
/// use (that is when the keychain is read), then reuses it.
struct LazyConnectionProvider {
    registry: LlmRegistry,
    connection: LlmConnection,
}

impl LazyConnectionProvider {
    fn get(&self) -> Result<Arc<dyn LLMProvider>, LLMError> {
        self.registry.provider_for(&self.connection).map_err(LLMError::NotConfigured)
    }
}

#[async_trait::async_trait]
impl LLMProvider for LazyConnectionProvider {
    fn provider_name(&self) -> &str {
        self.connection.legacy_type()
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, LLMError> {
        self.get()?.list_models().await
    }

    async fn test_connection(&self) -> Result<bool, LLMError> {
        self.get()?.test_connection().await
    }

    async fn stream_completion(
        &self,
        messages: Vec<LLMMessage>,
        model: &str,
        params: GenerationParams,
        app_handle: AppHandle,
        sink: Option<TokenSink>,
    ) -> Result<CompletionStats, LLMError> {
        self.get()?.stream_completion(messages, model, params, app_handle, sink).await
    }
}

/// A provider with a route's parameter overrides: they beat the caller's
/// values; `extra_body` patches are applied after the connection's own.
pub struct RoutedProvider {
    pub inner: Arc<dyn LLMProvider>,
    pub overrides: Vec<RouteParams>,
}

impl RoutedProvider {
    fn apply(&self, mut params: GenerationParams) -> GenerationParams {
        for layer in &self.overrides {
            if layer.temperature.is_some() {
                params.temperature = layer.temperature;
            }
            if layer.max_tokens.is_some() {
                params.max_tokens = layer.max_tokens;
            }
            if let Some(extra) = &layer.extra_body {
                let target = params.extra_body.get_or_insert_with(|| Value::Object(Default::default()));
                super::compat::merge_patch(target, &Value::Object(extra.clone()));
            }
        }
        params
    }
}

#[async_trait::async_trait]
impl LLMProvider for RoutedProvider {
    fn provider_name(&self) -> &str {
        self.inner.provider_name()
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, LLMError> {
        self.inner.list_models().await
    }

    async fn test_connection(&self) -> Result<bool, LLMError> {
        self.inner.test_connection().await
    }

    async fn stream_completion(
        &self,
        messages: Vec<LLMMessage>,
        model: &str,
        params: GenerationParams,
        app_handle: AppHandle,
        sink: Option<TokenSink>,
    ) -> Result<CompletionStats, LLMError> {
        let params = self.apply(params);
        self.inner.stream_completion(messages, model, params, app_handle, sink).await
    }
}

// ── App wiring ──────────────────────────────────────────────────────────────

/// The raw `config.json` (the old settings) as one JSON object.
fn legacy_settings(app: &AppHandle) -> Option<Value> {
    let store = app.store(STORE_FILE).ok()?;
    let map: serde_json::Map<String, Value> = store.entries().into_iter().collect();
    Some(Value::Object(map))
}

/// Loads (or migrates) the LLM settings at startup, builds the old router
/// on the default route, mirrors it to `config.json` and registers the
/// registry. Called in `setup` before `AppState` is managed.
pub fn init(app: &AppHandle, app_state: &mut AppState, app_data_dir: &Path) {
    let path = app_data_dir.join(persist::FILE_NAME);
    let loaded = persist::load(&path, || legacy_settings(app), now_ms());
    if loaded.needs_save && !loaded.read_only {
        if let Err(e) = persist::save(&path, &loaded.config) {
            log::error!("LLM settings: could not write {}: {e}", path.display());
        }
    }
    if let Some(info) = loaded.config.migration.as_ref().filter(|_| loaded.needs_save) {
        log::info!("LLM settings: migrated ({}) {} connection(s)", info.source, info.connections.len());
    }
    let registry = LlmRegistry::new(loaded, Some(path), Arc::new(KeychainSecrets));
    let stored_claude = app
        .store(STORE_FILE)
        .ok()
        .and_then(|s| s.get("claudeCliConfig"))
        .and_then(|v| serde_json::from_value::<ClaudeCliConfig>(v).ok());
    if let Ok(mut slot) = registry.inner.stored_claude.lock() {
        *slot = stored_claude.clone();
    }
    let claude = ClaudeContext::from_config(true, &stored_claude.unwrap_or_default());
    let mut router = LLMRouter::new();
    registry.sync_router(&mut router, &claude);
    app_state.llm = Some(Arc::new(Mutex::new(router)));
    registry.mirror(app, &claude);
    app.manage(registry);
    log::info!("LLM connections loaded");
}

/// After every change: the old router, the `config.json` mirror and the
/// `llm_config_changed` event.
pub fn after_change(app: &AppHandle) {
    let Some(registry) = app.try_state::<LlmRegistry>() else {
        return;
    };
    let claude = claude_context(app);
    if let Some(state) = app.try_state::<AppState>() {
        if let Some(llm) = &state.llm {
            if let Ok(mut router) = llm.lock() {
                registry.sync_router(&mut router, &claude);
            }
        }
    }
    registry.mirror(app, &claude);
    let _ = app.emit(CONFIG_CHANGED_EVENT, registry.view(&claude));
}

/// Startup work after `setup`: a default Ollama connection without a model
/// gets the first installed model (as the old router did, now saved).
pub fn spawn_startup_tasks(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Give Ollama a moment to be ready
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        let Some(registry) = app.try_state::<LlmRegistry>().map(|r| r.inner().clone()) else {
            return;
        };
        let config = registry.config();
        let Some(conn) = config.default_connection().cloned() else { return };
        if conn.kind != LlmKind::Ollama || resolve_route(&config, "default").is_ok() {
            return;
        }
        let provider = match registry.provider_for(&conn) {
            Ok(p) => p,
            Err(e) => {
                log::warn!("Ollama auto-detect skipped: {e}");
                return;
            }
        };
        match provider.list_models().await {
            Ok(models) if !models.is_empty() => {
                let first = models[0].id.clone();
                let result = registry.mutate(|cfg| {
                    if let Some(c) = cfg.connection_mut(&conn.id) {
                        if c.default_model.is_none() {
                            c.default_model = Some(first.clone());
                        }
                    }
                    Ok(())
                });
                match result {
                    Ok(_) => {
                        log::info!("Auto-detected Ollama model: {} (from {} available)", first, models.len());
                        after_change(&app);
                    }
                    Err(e) => log::warn!("Could not save the detected Ollama model: {e}"),
                }
            }
            Ok(_) => log::warn!("Ollama running but no models found"),
            Err(e) => log::warn!("Ollama not reachable for auto-detect: {e}"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::connections::{LlmHeader, ModelsEndpoint};
    use serde_json::json;

    fn registry_with(config: LlmConfigFile) -> (LlmRegistry, Arc<MemorySecrets>) {
        let secrets = Arc::new(MemorySecrets::default());
        let loaded = Loaded { config, read_only: false, warning: None, needs_save: false };
        (LlmRegistry::new(loaded, None, secrets.clone()), secrets)
    }

    fn compat(id: &str, base: &str) -> LlmConnection {
        LlmConnection { id: id.into(), name: id.into(), base_url: base.into(), default_model: Some(format!("{id}-m")), ..Default::default() }
    }

    fn claude_down(fallback: Option<(&str, Option<&str>)>) -> ClaudeContext {
        ClaudeContext {
            available: false,
            legacy_fallback: fallback.map(|(p, m)| (p.to_string(), m.map(str::to_string))),
            fast_model: "haiku".into(),
        }
    }

    fn with_default(conns: Vec<LlmConnection>, default: &str) -> LlmConfigFile {
        let mut cfg = LlmConfigFile::default();
        cfg.connections = conns;
        cfg.routing.default.target = Some(RouteTarget { connection_id: default.into(), model: None });
        cfg
    }

    #[test]
    fn question_detection_rejects_claude_cli_and_never_switches_to_fallback() {
        let claude = legacy_connection(&ProviderType::ClaudeCli, None, None, None);
        let mut cfg = with_default(vec![claude.clone(), compat("paid", "https://paid/v1")], "paid");
        cfg.routing.tasks.insert("question_detect".into(), TaskRoute {
            target: Some(RouteTarget { connection_id: claude.id.clone(), model: None }),
            ..Default::default()
        });
        assert_eq!(resolve_task(&cfg, "question_detect", &ClaudeContext::default()).unwrap_err().0, RouteError::NotConfigured);
        assert_eq!(resolve_task(&cfg, "question_detect", &claude_down(Some(("groq", None)))).unwrap_err().0, RouteError::NotConfigured);
    }

    #[test]
    fn claude_outage_uses_the_fallback_for_every_task() {
        let claude = legacy_connection(&ProviderType::ClaudeCli, None, None, None);
        let ollama = LlmConnection { default_model: Some("llama".into()), ..legacy_connection(&ProviderType::Ollama, None, None, None) };
        let cfg = with_default(vec![claude.clone(), ollama.clone()], &claude.id);

        // Healthy: Claude itself (no model: its settings decide).
        let r = resolve_task(&cfg, "translation", &ClaudeContext::default()).unwrap();
        assert_eq!((r.connection.kind, r.model.clone(), r.via_fallback), (LlmKind::ClaudeCli, None, false));

        // Down, fallback from the Claude settings → legacy-ollama with its model.
        let r = resolve_task(&cfg, "translation", &claude_down(Some(("ollama", Some("qwen3"))))).unwrap();
        assert_eq!((r.connection.id.as_str(), r.model.as_deref(), r.via_fallback), ("legacy-ollama", Some("qwen3"), true));
        // A fallback type without its connection is built like the old fallback (default address).
        let r = resolve_task(&cfg, "assist:Assist", &claude_down(Some(("groq", None)))).unwrap();
        assert_eq!((r.connection.id.as_str(), r.model.clone()), ("legacy-groq", None), "model looked up later");

        // Down, no fallback: still Claude, which reports why.
        let r = resolve_task(&cfg, "assist", &claude_down(None)).unwrap();
        assert!(r.no_fallback && r.connection.kind == LlmKind::ClaudeCli);

        // An explicit claude_fallback route wins.
        let mut cfg2 = cfg.clone();
        cfg2.connections.push(compat("c_ds", "https://api.deepseek.com"));
        cfg2.routing.tasks.insert("claude_fallback".into(), TaskRoute { target: Some(RouteTarget { connection_id: "c_ds".into(), model: Some("deepseek-chat".into()) }), ..Default::default() });
        let r = resolve_task(&cfg2, "meeting_summary", &claude_down(Some(("ollama", None)))).unwrap();
        assert_eq!((r.connection.id.as_str(), r.model.as_deref()), ("c_ds", Some("deepseek-chat")));

        // Assist on Claude, default elsewhere: the default takes over.
        let mut cfg3 = with_default(vec![claude.clone(), compat("c_ds", "https://api.deepseek.com")], "c_ds");
        cfg3.routing.tasks.insert("assist".into(), TaskRoute { target: Some(RouteTarget { connection_id: claude.id.clone(), model: None }), ..Default::default() });
        let r = resolve_task(&cfg3, "assist:WhatToSay", &claude_down(None)).unwrap();
        assert_eq!((r.connection.id.as_str(), r.via_fallback), ("c_ds", true));
        let view = effective_route(&cfg3, "assist", &claude_down(None));
        assert!(view.via_fallback && view.error.is_none());
    }

    #[test]
    fn the_fallback_row_shows_who_takes_over() {
        let claude = legacy_connection(&ProviderType::ClaudeCli, None, None, None);
        let cfg = with_default(vec![claude], "legacy-claude_cli");
        let none = effective_route(&cfg, "claude_fallback", &ClaudeContext::default());
        assert_eq!(none.error.as_deref(), Some("no_fallback"));
        let legacy = ClaudeContext { legacy_fallback: Some(("ollama".into(), Some("qwen3".into()))), ..Default::default() };
        let row = effective_route(&cfg, "claude_fallback", &legacy);
        assert_eq!((row.connection_id.as_deref(), row.model.as_deref(), row.error.clone()), (Some("legacy-ollama"), Some("qwen3"), None));
    }

    #[test]
    fn effective_routes_explain_errors() {
        let cfg = with_default(vec![], "gone");
        let e = effective_route(&cfg, "translation", &ClaudeContext::default());
        assert_eq!(e.error.as_deref(), Some("connection_missing"));
        let cfg = LlmConfigFile::default();
        assert_eq!(effective_route(&cfg, "default", &ClaudeContext::default()).error.as_deref(), Some("not_configured"));
        let mut c = compat("c_1", "https://h/v1");
        c.default_model = None;
        let cfg = with_default(vec![c], "c_1");
        let e = effective_route(&cfg, "assist", &ClaudeContext::default());
        assert_eq!((e.error.as_deref(), e.connection_id.as_deref()), (Some("no_model"), Some("c_1")));
    }

    #[test]
    fn upsert_creates_ids_keeps_backend_fields_and_drops_secrets_for_a_new_host() {
        let (registry, secrets) = registry_with(LlmConfigFile::default());
        let (id, cfg) = registry
            .upsert(json!({"id": "", "name": "DeepSeek", "kind": "openai_compat", "base_url": "https://api.deepseek.com/", "default_model": "deepseek-chat"}), Some("sk-abcdef123456".into()))
            .unwrap();
        assert!(id.starts_with("c_") && id.len() == 10, "{id}");
        let conn = cfg.connection(&id).unwrap().clone();
        assert_eq!(conn.base_url, "https://api.deepseek.com");
        assert_eq!(conn.auth.mode, crate::net::endpoint::AuthMode::Bearer, "kind default when auth is absent");
        assert_eq!(conn.secret_ref, Some(format!("llm:{id}")));
        assert_eq!(conn.secret_hint.as_deref(), Some("…3456"));
        assert_eq!(secrets.get(&format!("llm:{id}")).unwrap().as_deref(), Some("sk-abcdef123456"));
        assert_eq!(cfg.revision, 1);

        // Same host, new path: the key stays; backend fields can't be forged.
        let mut input = serde_json::to_value(&conn).unwrap();
        input["base_url"] = json!("https://api.deepseek.com/v1");
        input["secret_hint"] = json!("…FAKE");
        input["verified_at_ms"] = json!(123);
        let (_, cfg) = registry.upsert(input, None).unwrap();
        let kept = cfg.connection(&id).unwrap();
        assert_eq!((kept.secret_hint.as_deref(), kept.verified_at_ms), (Some("…3456"), None));
        assert!(secrets.get(&format!("llm:{id}")).unwrap().is_some());

        // Another host: the key is forgotten and deleted.
        let mut input = serde_json::to_value(kept).unwrap();
        input["base_url"] = json!("https://evil.example.com/v1");
        let (_, cfg) = registry.upsert(input, None).unwrap();
        let moved = cfg.connection(&id).unwrap();
        assert_eq!((moved.secret_ref.clone(), moved.secret_hint.clone()), (None, None));
        assert!(secrets.get(&format!("llm:{id}")).unwrap().is_none());

        // Validation errors don't save anything.
        assert!(registry.upsert(json!({"id": "", "base_url": "ftp://x"}), None).is_err());
        assert!(registry.upsert(json!({"id": "bad id!", "base_url": "https://x"}), None).is_err());
        assert_eq!(registry.config().revision, 3);
    }

    #[test]
    fn legacy_slots_survive_deletion_and_owned_secrets_do_not() {
        let mut openai = legacy_connection(&ProviderType::Openai, None, None, None);
        openai.default_model = Some("gpt-4o".into());
        let (registry, secrets) = registry_with(with_default(vec![openai], "legacy-openai"));
        secrets.set("openai", "sk-old").unwrap();
        let (cleared, cfg) = registry.delete("legacy-openai").unwrap();
        assert_eq!(cleared, vec!["default"]);
        assert!(cfg.connections.is_empty() && cfg.routing.default.target.is_none());
        assert_eq!(secrets.get("openai").unwrap().as_deref(), Some("sk-old"), "old shared slot kept");

        let (id, _) = registry
            .upsert(json!({"id": "", "base_url": "https://h/v1", "headers": [{"name": "X-Token", "value": "hidden", "secret": true}]}), Some("k".into()))
            .unwrap();
        let account = format!("llm:{id}:h:x-token");
        assert_eq!(secrets.get(&account).unwrap().as_deref(), Some("hidden"));
        let header = registry.config().connection(&id).unwrap().headers[0].clone();
        assert_eq!(header, LlmHeader { name: "X-Token".into(), value: String::new(), secret: true, value_saved: true });
        registry.delete(&id).unwrap();
        assert!(secrets.get(&account).unwrap().is_none());
        assert!(secrets.get(&format!("llm:{id}")).unwrap().is_none());
    }

    #[test]
    fn secret_headers_keep_their_value_until_changed() {
        let (registry, secrets) = registry_with(LlmConfigFile::default());
        let (id, cfg) = registry.upsert(json!({"id": "", "base_url": "https://h/v1", "headers": [{"name": "X-K", "value": "v1", "secret": true}]}), None).unwrap();
        // Saved again with an empty value: kept.
        let input = serde_json::to_value(cfg.connection(&id).unwrap()).unwrap();
        let (_, cfg) = registry.upsert(input, None).unwrap();
        assert!(cfg.connection(&id).unwrap().headers[0].value_saved);
        assert_eq!(secrets.get(&format!("llm:{id}:h:x-k")).unwrap().as_deref(), Some("v1"));
        // Turned into a plain header: the keychain value goes.
        let mut input = serde_json::to_value(cfg.connection(&id).unwrap()).unwrap();
        input["headers"] = json!([{"name": "X-K", "value": "plain", "secret": false}]);
        let (_, cfg) = registry.upsert(input, None).unwrap();
        assert_eq!(cfg.connection(&id).unwrap().headers[0].value, "plain");
        assert!(secrets.get(&format!("llm:{id}:h:x-k")).unwrap().is_none());
    }

    #[test]
    fn routes_validate_their_targets_and_keys() {
        let (registry, _) = registry_with(with_default(vec![compat("c_a", "https://a/v1")], "c_a"));
        assert!(registry.set_route("translation", Some(TaskRoute { target: Some(RouteTarget { connection_id: "nope".into(), model: None }), ..Default::default() })).is_err());
        assert!(registry.set_route("Bad Key", None).is_err());
        let bad_params = TaskRoute { params: RouteParams { extra_body: Some(json!({"messages": []}).as_object().unwrap().clone()), ..Default::default() }, ..Default::default() };
        assert!(registry.set_route("translation", Some(bad_params)).is_err());
        let cfg = registry
            .set_route("translation", Some(TaskRoute { target: Some(RouteTarget { connection_id: "c_a".into(), model: Some(" fast ".into()) }), ..Default::default() }))
            .unwrap();
        assert_eq!(cfg.routing.tasks["translation"].target.as_ref().unwrap().model.as_deref(), Some("fast"));
        let cfg = registry.set_route("translation", None).unwrap();
        assert!(!cfg.routing.tasks.contains_key("translation"));
        let cfg = registry.set_route("default", None).unwrap();
        assert!(cfg.routing.default.target.is_none());
        assert!(registry.set_response_language("zh-CN").is_ok());
        assert!(registry.set_response_language("transcript").is_ok());
        assert!(registry.set_response_language("中文").is_err());
    }

    #[test]
    fn legacy_shim_is_idempotent_and_switches_only_on_a_new_type() {
        let mut deepseek = compat("c_ds", "https://api.deepseek.com");
        deepseek.template = Some("deepseek".into());
        let ollama = legacy_connection(&ProviderType::Ollama, None, None, None);
        let (registry, _) = registry_with(with_default(vec![deepseek, ollama], "c_ds"));
        let push = |t: &str| ProviderConfig { provider_type: t.into(), api_key: None, base_url: None, auth_type: None, auth_value: None, auth_header: None };

        // The default (a new connection) stands for "custom": the startup push changes nothing.
        let custom = ProviderConfig { base_url: Some("http://old-custom/v1".into()), ..push("custom") };
        assert!(!registry.apply_legacy_provider(&custom).unwrap());
        assert!(!registry.apply_legacy_provider(&custom).unwrap());
        assert_eq!(registry.config().routing.default.target.as_ref().unwrap().connection_id, "c_ds");
        assert_eq!(registry.config().revision, 0);
        // set_active_model for the same type sets the default route's model.
        assert!(registry.apply_legacy_model("custom", "deepseek-reasoner").unwrap());
        assert!(!registry.apply_legacy_model("custom", "deepseek-reasoner").unwrap(), "idempotent");
        assert!(!registry.apply_legacy_model("ollama", "llama3").unwrap(), "another type is ignored");
        assert_eq!(registry.config().routing.default.target.as_ref().unwrap().model.as_deref(), Some("deepseek-reasoner"));

        // The footer picks Ollama: the default switches to legacy-ollama.
        assert!(registry.apply_legacy_provider(&push("ollama")).unwrap());
        let cfg = registry.config();
        assert_eq!(cfg.routing.default.target, Some(RouteTarget { connection_id: "legacy-ollama".into(), model: None }));
        // A cloud type without any key is refused, as before.
        assert!(registry.apply_legacy_provider(&push("openai")).is_err());
        // With the key in the config it is created (the key stays in memory only).
        let with_key = ProviderConfig { api_key: Some("sk-x".into()), ..push("openai") };
        assert!(registry.apply_legacy_provider(&with_key).unwrap());
        let cfg = registry.config();
        let openai = cfg.connection("legacy-openai").unwrap();
        assert_eq!(registry.secret_for(openai).unwrap().as_deref(), Some("sk-x"));
        assert!(openai.secret_hint.is_none(), "nothing written to the keychain");
    }

    #[test]
    fn the_old_ui_moving_a_connection_to_another_host_drops_new_keys() {
        let mut custom = legacy_connection(&ProviderType::Custom, Some("https://a.example.com/v1"), Some("bearer"), None);
        custom.secret_ref = Some("llm:legacy-custom".into());
        custom.secret_hint = Some("…1234".into());
        let ollama = legacy_connection(&ProviderType::Ollama, None, None, None);
        let (registry, secrets) = registry_with(with_default(vec![custom, ollama], "legacy-ollama"));
        secrets.set("llm:legacy-custom", "sk-new-ui").unwrap();
        let push = ProviderConfig {
            provider_type: "custom".into(),
            api_key: None,
            base_url: Some("https://b.example.net/v1".into()),
            auth_type: Some("bearer".into()),
            auth_value: None,
            auth_header: None,
        };
        assert!(registry.apply_legacy_provider(&push).unwrap());
        let cfg = registry.config();
        let moved = cfg.connection("legacy-custom").unwrap();
        assert_eq!(moved.base_url, "https://b.example.net/v1");
        assert_eq!((moved.secret_ref.clone(), moved.secret_hint.clone()), (None, None));
        assert!(secrets.get("llm:legacy-custom").unwrap().is_none());
        assert_eq!(registry.secret_for(moved).unwrap(), None, "the new host gets no key");

        // The old shared slot stays bound (the old settings own it).
        let mut legacy_slot = legacy_connection(&ProviderType::Custom, Some("https://a.example.com/v1"), Some("bearer"), None);
        legacy_slot.secret_ref = Some("custom".into());
        let (registry, secrets) = registry_with(with_default(vec![legacy_slot, legacy_connection(&ProviderType::Ollama, None, None, None)], "legacy-ollama"));
        secrets.set("custom", "tok").unwrap();
        registry.apply_legacy_provider(&push).unwrap();
        assert_eq!(registry.config().connection("legacy-custom").unwrap().secret_ref.as_deref(), Some("custom"));
        assert_eq!(secrets.get("custom").unwrap().as_deref(), Some("tok"));
    }

    #[test]
    fn a_draft_never_sends_the_saved_key_to_a_new_address() {
        let (registry, _) = registry_with(LlmConfigFile::default());
        let (id, cfg) = registry.upsert(json!({"id": "", "base_url": "https://api.example.com/v1"}), Some("sk-saved".into())).unwrap();
        let mut draft = serde_json::to_value(cfg.connection(&id).unwrap()).unwrap();
        let (_, secret, _) = registry.draft(draft.clone(), None).unwrap();
        assert_eq!(secret.as_deref(), Some("sk-saved"), "same server: the saved key is used");
        draft["chat_url_override"] = json!("https://evil.example.net/{model}");
        let (_, secret, _) = registry.draft(draft.clone(), None).unwrap();
        assert_eq!(secret, None);
        draft["chat_url_override"] = Value::Null;
        draft["models_endpoint"] = json!("custom");
        draft["models_url"] = json!("https://evil.example.net/models");
        assert_eq!(registry.draft(draft, None).unwrap().1, None);
    }

    #[test]
    fn the_router_follows_the_default_route_without_reading_keys() {
        let mut openai = legacy_connection(&ProviderType::Openai, None, None, None);
        openai.default_model = Some("gpt-4o".into());
        let (registry, _) = registry_with(with_default(vec![openai], "legacy-openai"));
        let mut router = LLMRouter::new();
        registry.sync_router(&mut router, &ClaudeContext::default());
        assert_eq!(router.active_model(), "gpt-4o");
        assert_eq!(router.active_provider_type(), Some(&ProviderType::Openai));
        assert!(!router.claude_in_use());
        assert!(registry.inner.providers.lock().unwrap().is_empty(), "the client is built lazily");
        // Two old-style handles never share a lock.
        let a = router.get_provider().unwrap();
        let b = router.get_provider().unwrap();
        let _held = a.try_lock().unwrap();
        assert!(b.try_lock().is_ok());

        let claude = legacy_connection(&ProviderType::ClaudeCli, None, None, None);
        registry.upsert(serde_json::to_value(&claude).unwrap(), None).unwrap();
        registry.set_route("assist", Some(TaskRoute { target: Some(RouteTarget { connection_id: claude.id.clone(), model: None }), ..Default::default() })).unwrap();
        registry.sync_router(&mut router, &ClaudeContext::default());
        assert!(router.claude_in_use());
    }

    #[test]
    fn providers_are_cached_until_the_connection_changes() {
        let (registry, secrets) = registry_with(LlmConfigFile::default());
        secrets.set("llm:c_x", "k").unwrap();
        let mut conn = compat("c_x", "https://h/v1");
        conn.secret_ref = Some("llm:c_x".into());
        let a = registry.provider_for(&conn).unwrap();
        let b = registry.provider_for(&conn).unwrap();
        assert!(Arc::ptr_eq(&a, &b));
        conn.models_endpoint = ModelsEndpoint::Disabled;
        let c = registry.provider_for(&conn).unwrap();
        assert!(!Arc::ptr_eq(&a, &c));
        // The model list cache doesn't change the client.
        conn.model_cache = Some(Default::default());
        assert!(Arc::ptr_eq(&c, &registry.provider_for(&conn).unwrap()));
    }

    #[test]
    fn semaphores_follow_the_limit() {
        let (registry, _) = registry_with(LlmConfigFile::default());
        let mut conn = compat("c_x", "https://h/v1");
        assert_eq!(registry.semaphore_for(&conn).available_permits(), 4);
        conn.max_concurrency = Some(1);
        assert_eq!(registry.semaphore_for(&conn).available_permits(), 1);
    }

    #[test]
    fn model_lists_are_recorded_with_errors_keeping_the_last_list() {
        let (registry, _) = registry_with(with_default(vec![compat("c_a", "https://a/v1")], "c_a"));
        let models = vec![ModelInfo { id: "m1".into(), name: "m1".into(), provider: "custom".into(), context_window: None }];
        registry.record_models("c_a", Some("https://a/v1/models".into()), Ok(models)).unwrap();
        let cfg = registry.record_models("c_a", None, Err("HTTP 500".into())).unwrap();
        let cache = cfg.connection("c_a").unwrap().model_cache.clone().unwrap();
        assert_eq!((cache.models.len(), cache.error.as_deref()), (1, Some("HTTP 500")));
    }

    #[test]
    fn route_overrides_beat_the_caller_and_patch_extra_body() {
        let routed = RoutedProvider {
            inner: Arc::from(super::super::build_provider(&compat("c", "https://h/v1"), None, &HashMap::new()).unwrap()),
            overrides: vec![
                RouteParams { temperature: Some(0.2), extra_body: Some(json!({"a": 1, "n": {"x": 1}}).as_object().unwrap().clone()), ..Default::default() },
                RouteParams { max_tokens: Some(9), extra_body: Some(json!({"n": {"y": 2}}).as_object().unwrap().clone()), ..Default::default() },
            ],
        };
        let params = routed.apply(GenerationParams { temperature: Some(0.7), max_tokens: Some(100), ..Default::default() });
        assert_eq!((params.temperature, params.max_tokens), (Some(0.2), Some(9)));
        assert_eq!(params.extra_body, Some(json!({"a": 1, "n": {"x": 1, "y": 2}})));
    }

    #[test]
    fn view_lists_known_tasks_and_effective_routes() {
        let (registry, _) = registry_with(with_default(vec![compat("c_a", "https://a/v1")], "c_a"));
        registry.set_route("assist:Recap", Some(TaskRoute { params: RouteParams { temperature: Some(0.1), ..Default::default() }, ..Default::default() })).unwrap();
        let view = registry.view(&ClaudeContext::default());
        assert_eq!(view.known_tasks[0], TaskInfo { key: "default".into(), parent: None });
        let recap = &view.effective["assist:Recap"];
        assert_eq!((recap.source.as_deref(), recap.model.as_deref()), (Some("default"), Some("c_a-m")));
        let json = serde_json::to_value(&view).unwrap();
        assert_eq!(json["connections"][0]["legacy_type"], "custom");
        assert_eq!(json["connections"][0]["id"], "c_a");
        assert!(json["effective"]["translation"]["error"].is_null());
    }
}
