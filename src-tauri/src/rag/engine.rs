//! The engine behind `RagManager`: owns the stored config, `rag.db`, the
//! in-memory vector index of the active space, search, and the queue of the
//! background indexer (`indexer.rs`).
//!
//! Vectors from different embedding setups never meet: each setup is a
//! space (`RagConfig::space_key` + measured size). Searches use vectors only
//! when the active space matches the current config; otherwise they fall
//! back to keywords until the user confirms a rebuild.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::time::{Duration, Instant};

use futures::future::BoxFuture;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use super::config::{self, RagConfig, RerankConfig, EMBEDDING_SECRET_SLOT, RERANK_SECRET_SLOT};
use super::embedding::{self, CancelSignal, EmbedError, EmbedTestResult, Embedder, EmbedderSettings, RetryPolicy};
use super::expand::{self, HitPos, Limits, OutlineChunk};
use super::flat_index::{self, FlatIndex};
use super::indexer::{IndexProgress, Job, JobKind, JobSummary};
use super::rerank::{self, Breaker, RerankReport, RerankSettings, RerankStatus, RerankTestResult};
use super::rewrite::{self, RewriteReport};
use super::search::{self, ScoredChunk, SearchMode};
use super::store::{embed_text, ChunkDetail, ChunkKind, SpaceRow, Store, StoreStats};
use crate::net::endpoint::{AuthMode, ConnectionSummary, ResolvedConnection};

/// A document the host wants indexed (a context resource).
#[derive(Debug, Clone, PartialEq)]
pub struct ResourceInfo {
    pub id: String,
    pub name: String,
    pub file_type: String,
    pub path: String,
}

/// A silent LLM call the engine asks the host for, routed by `task` (the
/// LLM settings' task routing picks the connection and model).
#[derive(Debug, Clone)]
pub struct LlmRequest {
    /// Routing key: `rag_query_rewrite`, `rag_summary`.
    pub task: &'static str,
    pub system: String,
    pub user: String,
    pub max_tokens: u64,
    pub temperature: f64,
    /// Ask for JSON output where the connection supports it.
    pub json: bool,
    pub timeout: Duration,
}

/// What the engine needs from the app; a test double in tests.
pub trait RagHost: Send + Sync + 'static {
    /// The documents to index; `None` while they can't be trusted (not
    /// loaded yet, database unavailable), so nothing gets deleted by mistake.
    fn resources(&self) -> Option<Vec<ResourceInfo>>;
    /// Text the host already extracted for a resource.
    fn resource_text(&self, id: &str) -> Option<String>;
    fn emit(&self, event: &str, payload: Value);
    fn read_secret(&self, slot: &str) -> Result<Option<String>, String>;
    fn write_secret(&self, slot: &str, value: Option<&str>) -> Result<(), String>;
    fn meeting_active(&self) -> bool;
    fn resolve_connection(&self, id: &str) -> Result<ResolvedConnection, String>;
    fn list_connections(&self) -> Vec<ConnectionSummary>;
    /// Runs `request` and returns the model's whole answer.
    fn complete(&self, request: LlmRequest) -> BoxFuture<'static, Result<String, String>> {
        let _ = request;
        Box::pin(async { Err("no LLM is available to the knowledge base".to_string()) })
    }
}

/// Whether searches can use vectors right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VectorState {
    /// No embedding model / address configured: keywords only.
    Unconfigured,
    /// Configured, nothing embedded yet.
    Empty,
    /// The active space's vectors are being loaded into memory.
    Loading,
    Ready,
    /// The embedding setup changed: a rebuild is needed before vectors are used again.
    Stale,
    /// `rag.db` could not be opened.
    Unavailable,
}

impl VectorState {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Unconfigured => "unconfigured",
            Self::Empty => "empty",
            Self::Loading => "loading",
            Self::Ready => "ready",
            Self::Stale => "stale",
            Self::Unavailable => "unavailable",
        }
    }
}

/// The active space and its in-memory index.
#[derive(Default)]
pub(super) struct IndexSlot {
    pub space: Option<SpaceRow>,
    pub index: Option<FlatIndex>,
    pub loading: bool,
}

/// The last failure, for the status display.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LastError {
    pub message: String,
    pub kind: String,
    pub at_ms: i64,
}

#[derive(Default)]
pub(super) struct EngineStatus {
    pub stats: StoreStats,
    pub job: Option<IndexProgress>,
    pub last_error: Option<LastError>,
    pub last_job: Option<JobSummary>,
    pub last_emit: Option<Instant>,
    /// The service returned vectors of another size than the active space.
    pub dims_mismatch: bool,
}

/// A summary of the active space.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SpaceInfo {
    pub provider: String,
    pub model: String,
    pub dims: usize,
    pub created_at_ms: i64,
}

/// Everything the settings page shows about the index.
#[derive(Debug, Clone, Serialize)]
pub struct IndexInfo {
    pub enabled: bool,
    pub documents: usize,
    pub documents_indexed: usize,
    pub documents_error: usize,
    pub chunks: usize,
    pub tokens: usize,
    /// Vectors in the active space.
    pub vectors: usize,
    /// Chunks the current settings still have to embed (all of them when a
    /// rebuild is needed).
    pub pending_vectors: usize,
    /// Documents chunked with other chunk settings.
    pub stale_documents: usize,
    pub needs_rebuild: bool,
    /// "model_changed", "chunking_changed", "dimensions_changed".
    pub rebuild_reasons: Vec<&'static str>,
    pub vector_state: VectorState,
    pub embedding_configured: bool,
    pub active_space: Option<SpaceInfo>,
    pub memory_bytes: usize,
    pub last_indexed_at: Option<String>,
    pub job: Option<IndexProgress>,
    pub last_job: Option<JobSummary>,
    pub last_error: Option<LastError>,
    pub store_error: Option<String>,
}

/// One search, with why vectors were not used if they weren't.
#[derive(Debug, Clone, Default, Serialize)]
pub struct SearchOutcome {
    pub chunks: Vec<ScoredChunk>,
    pub vector_used: bool,
    pub degraded: Option<String>,
    /// What reranking did (None: off, or fewer than two results).
    pub rerank: Option<RerankReport>,
    /// Every query searched: the caller's, then the rewritten ones.
    pub queries: Vec<String>,
    /// What query rewriting did (None: off).
    pub rewrite: Option<RewriteReport>,
}

/// One query's fused results.
struct Ranked {
    fused: Vec<(i64, f64)>,
    vector_used: bool,
    degraded: Option<String>,
}

/// Parameters a caller may override per search.
#[derive(Debug, Clone, Copy)]
pub struct SearchParams {
    pub top_k: usize,
    pub mode: SearchMode,
    pub semantic_weight: f32,
}

impl SearchParams {
    /// `top_k`, `search_mode` and `semantic_weight` of `config`.
    pub fn from_config(config: &RagConfig) -> Self {
        Self {
            top_k: config.top_k.max(1),
            mode: SearchMode::parse(&config.search_mode),
            semantic_weight: config.semantic_weight,
        }
    }
}

/// A search result before it becomes a `ScoredChunk`.
struct Hit {
    id: i64,
    detail: ChunkDetail,
    /// Position (from 1) and score after fusion.
    fused_rank: usize,
    fused_score: f64,
    rerank_score: Option<f64>,
}

pub struct RagEngine {
    pub(super) dir: PathBuf,
    pub(super) config: RwLock<RagConfig>,
    pub(super) store: Option<Arc<Store>>,
    pub(super) store_error: Option<String>,
    pub(super) slot: Arc<RwLock<IndexSlot>>,
    pub(super) host: Arc<dyn RagHost>,
    pub(super) http: reqwest::Client,
    pub(super) jobs: mpsc::UnboundedSender<Job>,
    pub(super) next_job: std::sync::atomic::AtomicU64,
    pub(super) current_cancel: Mutex<Option<Arc<CancelSignal>>>,
    /// The embedding key read from the keychain (outer None: not read yet).
    pub(super) secret: Mutex<Option<Option<String>>>,
    pub(super) embedder: Mutex<Option<Arc<Embedder>>>,
    /// The rerank key read from the keychain (outer None: not read yet).
    pub(super) rerank_secret: Mutex<Option<Option<String>>>,
    /// Rerank request settings and the rerank config they were built from.
    pub(super) reranker: Mutex<Option<(RerankConfig, Arc<RerankSettings>)>>,
    pub(super) rerank_breaker: Breaker,
    pub(super) status: Mutex<EngineStatus>,
    pub(super) retry: RetryPolicy,
}

static ENGINE: OnceLock<Arc<RagEngine>> = OnceLock::new();

/// The app's engine, once `RagManager::bootstrap` ran.
pub fn global() -> Option<Arc<RagEngine>> {
    ENGINE.get().cloned()
}

pub(super) fn install_global(engine: Arc<RagEngine>) {
    let _ = ENGINE.set(engine);
}

/// Spawns on the current tokio runtime, or Tauri's when called outside one.
pub(super) fn spawn<F>(future: F)
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => {
            handle.spawn(future);
        }
        Err(_) => {
            tauri::async_runtime::spawn(future);
        }
    }
}

/// Runs blocking work (SQLite, scans, parsing) off the async threads.
pub(super) async fn blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("RAG background task failed: {e}"))?
}

impl RagEngine {
    /// Loads `<dir>/config.json`, opens `<dir>/rag.db` and starts the
    /// background worker (which first loads the active space's vectors).
    pub fn start(dir: &Path, host: Arc<dyn RagHost>) -> Arc<RagEngine> {
        Self::start_with(dir, host, RetryPolicy::default())
    }

    pub(super) fn start_with(dir: &Path, host: Arc<dyn RagHost>, retry: RetryPolicy) -> Arc<RagEngine> {
        let config = config::load(&dir.join("config.json"));
        let (store, store_error) = match Store::open(&dir.join("rag.db")) {
            Ok(store) => (Some(Arc::new(store)), None),
            Err(e) => {
                log::error!("RAG index unavailable: {e}");
                (None, Some(e))
            }
        };
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .pool_idle_timeout(Duration::from_secs(90))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        let (tx, rx) = mpsc::unbounded_channel();
        let engine = Arc::new(RagEngine {
            dir: dir.to_path_buf(),
            config: RwLock::new(config),
            store,
            store_error,
            slot: Arc::new(RwLock::new(IndexSlot::default())),
            host,
            http,
            jobs: tx,
            next_job: std::sync::atomic::AtomicU64::new(1),
            current_cancel: Mutex::new(None),
            secret: Mutex::new(None),
            embedder: Mutex::new(None),
            rerank_secret: Mutex::new(None),
            reranker: Mutex::new(None),
            rerank_breaker: Breaker::default(),
            status: Mutex::new(EngineStatus::default()),
            retry,
        });
        spawn(super::indexer::worker(engine.clone(), rx));
        engine
    }

    pub fn config_path(&self) -> PathBuf {
        self.dir.join("config.json")
    }

    pub fn config(&self) -> RagConfig {
        self.read_config().clone()
    }

    fn read_config(&self) -> RwLockReadGuard<'_, RagConfig> {
        self.config.read().unwrap_or_else(|p| p.into_inner())
    }

    fn write_config(&self) -> RwLockWriteGuard<'_, RagConfig> {
        self.config.write().unwrap_or_else(|p| p.into_inner())
    }

    pub(super) fn status(&self) -> MutexGuard<'_, EngineStatus> {
        self.status.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub(super) fn slot_read(&self) -> RwLockReadGuard<'_, IndexSlot> {
        self.slot.read().unwrap_or_else(|p| p.into_inner())
    }

    pub(super) fn slot_write(&self) -> RwLockWriteGuard<'_, IndexSlot> {
        self.slot.write().unwrap_or_else(|p| p.into_inner())
    }

    pub(super) fn store(&self) -> Result<Arc<Store>, String> {
        self.store
            .clone()
            .ok_or_else(|| self.store_error.clone().unwrap_or_else(|| "RAG index unavailable".to_string()))
    }

    // ── Config and secrets ──────────────────────────────────────────────────

    /// Applies a JSON merge patch, saves, and schedules the indexing the
    /// change calls for (never a paid rebuild: that waits for the user).
    pub fn update_config(&self, patch: &Value) -> Result<RagConfig, String> {
        let (prev, next) = {
            let mut cfg = self.write_config();
            let next = cfg.apply_patch(patch)?;
            config::save(&self.config_path(), &next)?;
            let prev = std::mem::replace(&mut *cfg, next.clone());
            (prev, next)
        };
        if prev.embedding != next.embedding {
            self.drop_embedder();
        }
        if prev.rerank != next.rerank {
            self.drop_reranker();
        }
        self.after_config_change(&prev, &next);
        Ok(next)
    }

    fn after_config_change(&self, prev: &RagConfig, next: &RagConfig) {
        if !(next.enabled && next.indexing.auto_index) {
            return;
        }
        let space_changed = next.embedding_configured()
            && (!prev.embedding_configured() || prev.space_key() != next.space_key());
        let active_matches_or_none = match &self.slot_read().space {
            None => true,
            Some(space) => space.space_key == next.space_key(),
        };
        if !prev.enabled || (space_changed && active_matches_or_none) {
            self.enqueue(JobKind::Sync { resources: None, force: false });
        }
    }

    pub(super) fn drop_embedder(&self) {
        *self.embedder.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }

    /// Stores (or with `None` deletes) the embedding API key in the keychain
    /// and records whether one is saved plus its last four characters.
    pub fn set_secret(&self, secret: Option<&str>) -> Result<RagConfig, String> {
        let secret = secret.map(str::trim).filter(|s| !s.is_empty());
        self.host.write_secret(EMBEDDING_SECRET_SLOT, secret)?;
        *self.secret.lock().unwrap_or_else(|p| p.into_inner()) = Some(secret.map(str::to_string));
        self.drop_embedder();
        let mut cfg = self.write_config();
        cfg.embedding.key_saved = secret.is_some();
        cfg.embedding.key_hint = secret.map(secret_hint).unwrap_or_default();
        config::save(&self.config_path(), &cfg)?;
        Ok(cfg.clone())
    }

    /// The embedding key, read from the keychain once (and only when one was saved).
    fn secret(&self, config: &RagConfig) -> Option<String> {
        let e = &config.embedding;
        self.keychain_secret(EMBEDDING_SECRET_SLOT, &self.secret, e.key_saved && e.auth.mode != AuthMode::None)
    }

    /// The key in keychain `slot`, read once into `cache`. The keychain is
    /// not asked unless `needed` (a key was saved and the auth sends one).
    fn keychain_secret(&self, slot: &str, cache: &Mutex<Option<Option<String>>>, needed: bool) -> Option<String> {
        if !needed {
            return None;
        }
        let mut cache = cache.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(value) = cache.as_ref() {
            return value.clone();
        }
        let value = self.host.read_secret(slot).unwrap_or_else(|e| {
            log::warn!("Cannot read the {slot} key: {e}");
            None
        });
        *cache = Some(value.clone());
        value
    }

    /// Request settings for `config` (the reused LLM connection, or the
    /// RAG's own address and key).
    pub(super) fn embedder_settings(&self, config: &RagConfig) -> Result<EmbedderSettings, EmbedError> {
        let connection = if config.embedding.connection_id.is_empty() {
            None
        } else {
            Some(self.reused_connection(&config.embedding.connection_id, "embeddings")?)
        };
        let secret = if connection.is_some() { None } else { self.secret(config) };
        EmbedderSettings::from_config(config, secret.as_deref(), connection.as_ref())
    }

    /// Whether settings built from LLM connection `id` at `base_url` still
    /// match it: false once it was deleted or got another address (cached
    /// settings are rebuilt then). Own addresses (`id` empty) always match.
    fn connection_current(&self, id: &str, base_url: &str) -> bool {
        id.is_empty() || self.host.list_connections().iter().any(|c| c.id == id && c.base_url == base_url)
    }

    /// The LLM connection reused for `used_for`. One that was deleted or
    /// turned off is a settings error saying so: the own address and key
    /// are used only once the settings say so.
    fn reused_connection(&self, id: &str, used_for: &str) -> Result<ResolvedConnection, EmbedError> {
        self.host.resolve_connection(id).map_err(|e| {
            EmbedError::Config(format!(
                "The LLM connection reused for {used_for} can't be used ({e}). Choose another connection, or your own address and key, and save."
            ))
        })
    }

    /// The cached embedding client for the current config.
    pub(super) fn embedder(&self, config: &RagConfig) -> Result<Arc<Embedder>, EmbedError> {
        // A statement of its own: the lock must be released before `drop_embedder`.
        let cached = self.embedder.lock().unwrap_or_else(|p| p.into_inner()).clone();
        if let Some(e) = cached {
            if self.connection_current(&config.embedding.connection_id, &e.settings().base_url) {
                return Ok(e);
            }
            self.drop_embedder();
        }
        let settings = self.embedder_settings(config)?;
        let e = Arc::new(Embedder::new(settings, self.http.clone()).with_retry(self.retry));
        *self.embedder.lock().unwrap_or_else(|p| p.into_inner()) = Some(e.clone());
        Ok(e)
    }

    /// Tests the embedding settings: the stored config with `draft` (a patch)
    /// on top, without saving anything.
    pub async fn test_embedding(&self, draft: Option<&Value>) -> Result<EmbedTestResult, String> {
        let config = match draft {
            Some(patch) => self.config().apply_patch(patch)?,
            None => self.config(),
        };
        let settings = self.embedder_settings(&config).map_err(String::from)?;
        Ok(embedding::test_connection(&settings, &self.http).await)
    }

    // ── Rerank settings ─────────────────────────────────────────────────────

    /// Forgets the cached rerank settings and lifts a failure pause (the
    /// settings or the key changed).
    fn drop_reranker(&self) {
        *self.reranker.lock().unwrap_or_else(|p| p.into_inner()) = None;
        self.rerank_breaker.reset();
    }

    /// Stores (or with `None` deletes) the rerank API key in the keychain
    /// and records whether one is saved plus its last four characters.
    pub fn set_rerank_secret(&self, secret: Option<&str>) -> Result<RagConfig, String> {
        let secret = secret.map(str::trim).filter(|s| !s.is_empty());
        self.host.write_secret(RERANK_SECRET_SLOT, secret)?;
        *self.rerank_secret.lock().unwrap_or_else(|p| p.into_inner()) = Some(secret.map(str::to_string));
        self.drop_reranker();
        let mut cfg = self.write_config();
        cfg.rerank.key_saved = secret.is_some();
        cfg.rerank.key_hint = secret.map(secret_hint).unwrap_or_default();
        config::save(&self.config_path(), &cfg)?;
        Ok(cfg.clone())
    }

    /// Request settings for reranking (the reused LLM connection, or the
    /// rerank section's own address and key).
    pub(super) fn rerank_settings(&self, config: &RagConfig) -> Result<RerankSettings, EmbedError> {
        let r = &config.rerank;
        let connection = if r.connection_id.is_empty() {
            None
        } else {
            Some(self.reused_connection(&r.connection_id, "reranking")?)
        };
        let secret = match connection {
            Some(_) => None,
            None => self.keychain_secret(RERANK_SECRET_SLOT, &self.rerank_secret, r.key_saved && r.auth.mode != AuthMode::None),
        };
        RerankSettings::from_config(config, secret.as_deref(), connection.as_ref())
    }

    /// The cached rerank settings, rebuilt when `config.rerank` differs from
    /// the config they were built from or their LLM connection changed.
    fn reranker(&self, config: &RagConfig) -> Result<Arc<RerankSettings>, EmbedError> {
        let cached = self.reranker.lock().unwrap_or_else(|p| p.into_inner()).clone();
        if let Some((built_from, settings)) = cached {
            if built_from == config.rerank && self.connection_current(&config.rerank.connection_id, &settings.base_url) {
                return Ok(settings);
            }
            *self.reranker.lock().unwrap_or_else(|p| p.into_inner()) = None;
        }
        let settings = Arc::new(self.rerank_settings(config)?);
        *self.reranker.lock().unwrap_or_else(|p| p.into_inner()) = Some((config.rerank.clone(), settings.clone()));
        Ok(settings)
    }

    /// Tests the rerank settings: the stored config with `draft` (a patch)
    /// on top, without saving anything. A successful test of the stored
    /// settings lifts a failure pause.
    pub async fn test_rerank(&self, draft: Option<&Value>) -> Result<RerankTestResult, String> {
        let config = match draft {
            Some(patch) => self.config().apply_patch(patch)?,
            None => self.config(),
        };
        let settings = self.rerank_settings(&config).map_err(String::from)?;
        let result = rerank::test_connection(&self.http, &settings).await;
        if result.ok && draft.is_none() {
            self.rerank_breaker.reset();
        }
        Ok(result)
    }

    // ── Jobs ────────────────────────────────────────────────────────────────

    /// Queues a job; returns its id.
    pub fn enqueue(&self, kind: JobKind) -> u64 {
        self.submit(kind, None)
    }

    /// Queues a job and waits for its result.
    pub async fn run(&self, kind: JobKind) -> Result<JobSummary, String> {
        let (tx, rx) = oneshot::channel();
        self.submit(kind, Some(tx));
        rx.await.map_err(|_| "The RAG indexer stopped".to_string())?
    }

    fn submit(&self, kind: JobKind, done: Option<oneshot::Sender<Result<JobSummary, String>>>) -> u64 {
        let id = self.next_job.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let job = Job { id, kind, done: done.into_iter().collect() };
        if let Err(e) = self.jobs.send(job) {
            for tx in e.0.done {
                let _ = tx.send(Err("The RAG indexer stopped".to_string()));
            }
        }
        id
    }

    /// Cancels the running job (its finished work is kept). False if idle.
    pub fn cancel_current(&self) -> bool {
        match self.current_cancel.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
            Some(cancel) => {
                cancel.cancel();
                true
            }
            None => false,
        }
    }

    // ── Index state ─────────────────────────────────────────────────────────

    pub fn vector_state(&self, config: &RagConfig) -> VectorState {
        if self.store.is_none() {
            return VectorState::Unavailable;
        }
        if !config.embedding_configured() {
            return VectorState::Unconfigured;
        }
        let slot = self.slot_read();
        match &slot.space {
            None => VectorState::Empty,
            Some(space) if space.space_key != config.space_key() => VectorState::Stale,
            Some(_) if self.status().dims_mismatch => VectorState::Stale,
            Some(_) if slot.loading || slot.index.is_none() => VectorState::Loading,
            Some(_) => VectorState::Ready,
        }
    }

    /// Loads the active space's vectors into a fresh in-memory index.
    pub(super) async fn reload_index(&self) {
        let Some(store) = self.store.clone() else { return };
        let active = match blocking({
            let store = store.clone();
            move || store.active_space()
        })
        .await
        {
            Ok(active) => active,
            Err(e) => {
                log::error!("Cannot read the active RAG space: {e}");
                return;
            }
        };
        {
            let mut slot = self.slot_write();
            slot.space = active.clone();
            slot.index = None;
            slot.loading = active.is_some();
        }
        self.status().dims_mismatch = false;
        let Some(space) = active else { return };
        let started = Instant::now();
        let loaded = blocking(move || {
            let mut index = FlatIndex::new(space.dims.max(1));
            let mut bad = 0usize;
            store.for_each_vector(space.id, |id, v| {
                if v.len() == index.dims() {
                    index.upsert(id, v);
                } else {
                    bad += 1;
                }
            })?;
            if bad > 0 {
                log::warn!("Skipped {bad} vectors of the wrong size in RAG space {}", space.id);
            }
            Ok(index)
        })
        .await;
        let mut slot = self.slot_write();
        slot.loading = false;
        match loaded {
            Ok(index) => {
                log::info!("RAG index loaded: {} vectors in {:?}", index.len(), started.elapsed());
                slot.index = Some(index);
            }
            Err(e) => log::error!("Cannot load RAG vectors: {e}"),
        }
    }

    /// Re-reads the counters the legacy status and `retrieve_rag` use.
    pub async fn refresh_stats(&self) {
        let Some(store) = self.store.clone() else { return };
        let space = self.slot_read().space.as_ref().map(|s| s.id);
        if let Ok(stats) = blocking(move || store.stats(space)).await {
            self.status().stats = stats;
        }
    }

    pub fn stats(&self) -> StoreStats {
        self.status().stats.clone()
    }

    /// Resource ids of the documents the index holds chunks of.
    pub async fn indexed_resources(&self) -> HashSet<String> {
        let Some(store) = self.store.clone() else { return HashSet::new() };
        match blocking(move || store.list_documents()).await {
            Ok(docs) => docs.into_iter().filter(|d| d.status == "indexed").map(|d| d.resource_id).collect(),
            Err(e) => {
                log::warn!("Cannot list the indexed documents: {e}");
                HashSet::new()
            }
        }
    }

    pub(super) fn set_last_error(&self, kind: &str, message: String) {
        self.status().last_error = Some(LastError { message, kind: kind.to_string(), at_ms: super::store::now_ms() });
    }

    /// Records progress and emits `rag_index_progress` (at most 4 per second
    /// unless `force`, terminal states always).
    pub(super) fn progress(&self, progress: IndexProgress, force: bool) {
        let terminal = matches!(progress.status.as_str(), "complete" | "cancelled" | "error" | "file_complete");
        let emit = {
            let mut status = self.status();
            status.job = if terminal { None } else { Some(progress.clone()) };
            let due = status.last_emit.is_none_or(|t| t.elapsed() >= Duration::from_millis(250));
            if force || terminal || due {
                status.last_emit = Some(Instant::now());
                true
            } else {
                false
            }
        };
        if emit {
            self.host.emit("rag_index_progress", serde_json::to_value(&progress).unwrap_or(Value::Null));
        }
    }

    pub async fn index_info(&self) -> IndexInfo {
        let config = self.config();
        let vector_state = self.vector_state(&config);
        let (space, memory_bytes) = {
            let slot = self.slot_read();
            (slot.space.clone(), slot.index.as_ref().map_or(0, FlatIndex::memory_bytes))
        };
        let (job, last_job, last_error, dims_mismatch) = {
            let s = self.status();
            (s.job.clone(), s.last_job.clone(), s.last_error.clone(), s.dims_mismatch)
        };
        let mut info = IndexInfo {
            enabled: config.enabled,
            documents: 0,
            documents_indexed: 0,
            documents_error: 0,
            chunks: 0,
            tokens: 0,
            vectors: 0,
            pending_vectors: 0,
            stale_documents: 0,
            needs_rebuild: false,
            rebuild_reasons: Vec::new(),
            vector_state,
            embedding_configured: config.embedding_configured(),
            active_space: space.as_ref().map(|s| SpaceInfo {
                provider: s.provider.clone(),
                model: s.model.clone(),
                dims: s.dims,
                created_at_ms: s.created_at,
            }),
            memory_bytes,
            last_indexed_at: None,
            job,
            last_job,
            last_error,
            store_error: self.store_error.clone(),
        };
        let Some(store) = self.store.clone() else { return info };
        let params = config.chunk_params();
        let key = config.space_key();
        let configured = config.embedding_configured();
        let active_id = space.as_ref().map(|s| s.id);
        let counts = blocking(move || {
            let stats = store.stats(active_id)?;
            let stale = store.count_stale_documents(&params)?;
            let pending = match vector_state {
                VectorState::Ready | VectorState::Loading => store.count_missing_vectors(active_id)?,
                // A rebuild resumes into a half-built space for the new setup, if any.
                VectorState::Empty | VectorState::Stale if configured => {
                    let target = store.space_by_key(&key)?.filter(|s| Some(s.id) != active_id);
                    store.count_missing_vectors(target.map(|s| s.id))?
                }
                _ => 0,
            };
            Ok((stats, stale, pending))
        })
        .await;
        if let Ok((stats, stale, pending)) = counts {
            info.documents = stats.documents;
            info.documents_indexed = stats.documents_indexed;
            info.documents_error = stats.documents_error;
            info.chunks = stats.chunks;
            info.tokens = stats.tokens;
            info.vectors = stats.vectors;
            info.last_indexed_at = stats.last_indexed_at_ms.and_then(ms_to_rfc3339);
            info.stale_documents = stale;
            info.pending_vectors = pending;
            self.status().stats = stats;
        }
        if vector_state == VectorState::Stale {
            info.rebuild_reasons.push(if dims_mismatch { "dimensions_changed" } else { "model_changed" });
        }
        if info.stale_documents > 0 {
            info.rebuild_reasons.push("chunking_changed");
        }
        info.needs_rebuild = !info.rebuild_reasons.is_empty();
        info
    }

    // ── Search ──────────────────────────────────────────────────────────────

    /// Searches `query`, see [`RagEngine::search_queries`].
    pub async fn search(&self, query: &str, params: SearchParams) -> Result<SearchOutcome, String> {
        self.search_queries(&[query.to_string()], params).await
    }

    /// Hybrid search: keywords (bigram FTS) and vectors in parallel, fused
    /// by weighted RRF. Vectors are skipped when unusable (not configured,
    /// stale, loading) or when the query can't be embedded in time; the
    /// keyword results are returned then.
    ///
    /// Every query in `queries` (the first is the question), plus the
    /// rewrites of the first when query rewriting is on, is searched that
    /// way and the lists are fused by RRF. With reranking on, the best
    /// `rerank.candidates` fused results go to the reranker with the first
    /// query and its best `top_k` are returned; when it fails the fusion
    /// order stays. With context expansion on, each result then brings its
    /// neighbours or its section, and results that meet are merged.
    pub async fn search_queries(&self, queries: &[String], params: SearchParams) -> Result<SearchOutcome, String> {
        let mut weighted: Vec<(String, f64)> = Vec::new();
        for query in queries {
            let query = query.trim();
            if !query.is_empty() && !weighted.iter().any(|(q, _)| q == query) {
                weighted.push((query.to_string(), 1.0));
            }
        }
        let Some(primary) = weighted.first().map(|(q, _)| q.clone()) else {
            return Ok(SearchOutcome::default());
        };
        let store = self.store()?;
        let config = self.config();
        let depth = config.retrieval.depth.max(params.top_k * 2);

        let rewrite = if config.rewrite.enabled {
            let (variants, report) = self.rewrite_query(&primary, &config).await;
            for variant in variants {
                if !weighted.iter().any(|(q, _)| *q == variant) {
                    weighted.push((variant, rewrite::VARIANT_WEIGHT));
                }
            }
            Some(report)
        } else {
            None
        };

        let results = futures::future::join_all(
            weighted.iter().map(|(query, _)| self.ranked(query, depth, params, &config, store.clone())),
        )
        .await;
        let mut results = results.into_iter();
        let first = results.next().expect("the first query")?;
        let mut more: Vec<(Vec<i64>, f64)> = Vec::new();
        for (i, ((query, weight), result)) in weighted.iter().skip(1).zip(results).enumerate() {
            match result {
                Ok(ranked) => more.push((ranked.fused.iter().map(|(id, _)| *id).collect(), *weight)),
                // The query is the user's own words, and the log goes into bug reports: its size only.
                Err(e) => log::warn!(
                    "RAG search for query {} of {} ({} chars) failed: {e}",
                    i + 2,
                    weighted.len(),
                    query.chars().count()
                ),
            }
        }
        let fused = if more.is_empty() {
            first.fused
        } else {
            let ids: Vec<i64> = first.fused.iter().map(|(id, _)| *id).collect();
            let mut lists: Vec<(&[i64], f64)> = vec![(&ids, 1.0)];
            lists.extend(more.iter().map(|(ids, weight)| (ids.as_slice(), *weight)));
            search::rrf_fuse(&lists, config.retrieval.rrf_k)
        };

        let rerank_on = config.rerank.enabled;
        let want = if rerank_on { config.rerank.candidates.max(params.top_k) } else { params.top_k };
        let mut hits = self.distinct_hits(store.clone(), fused, want).await?;
        let mut rerank = None;
        if rerank_on && hits.len() >= 2 {
            let (ordered, report) = self.rerank_hits(&primary, hits, params.top_k, &config).await;
            hits = ordered;
            rerank = Some(report);
        }
        hits.truncate(params.top_k);
        let places: Vec<(i64, ChunkKind, usize)> = hits.iter().map(|h| (h.detail.doc_id, h.detail.kind, h.detail.ord)).collect();
        let mut chunks = to_chunks(hits);
        if config.expansion.enabled && !chunks.is_empty() {
            match self.expand(&store, &places, &chunks, &config).await {
                Ok(expanded) => chunks = expanded,
                Err(e) => log::warn!("RAG context expansion skipped: {e}"),
            }
        }
        Ok(SearchOutcome {
            chunks,
            vector_used: first.vector_used,
            degraded: first.degraded,
            rerank,
            queries: weighted.into_iter().map(|(q, _)| q).collect(),
            rewrite,
        })
    }

    /// One query's vector and keyword results, fused.
    async fn ranked(
        &self,
        query: &str,
        depth: usize,
        params: SearchParams,
        config: &RagConfig,
        store: Arc<Store>,
    ) -> Result<Ranked, String> {
        let state = self.vector_state(config);
        let use_vector = params.mode != SearchMode::Keyword && state == VectorState::Ready;
        let mut degraded = match (params.mode, state) {
            (SearchMode::Keyword, _) | (_, VectorState::Ready) => None,
            (_, other) => Some(format!("vectors_{}", other.as_str())),
        };

        let keyword = {
            let store = store.clone();
            let terms = config.retrieval.max_query_terms;
            let query = query.to_string();
            move || -> Result<Vec<(i64, f64)>, String> {
                match super::cjk::fts_match_query(&query, terms) {
                    Some(expr) => store.fts_search(&expr, depth),
                    None => Ok(Vec::new()),
                }
            }
        };
        let run_keyword_now = params.mode != SearchMode::Semantic || !use_vector;
        let keyword_task = async {
            if run_keyword_now {
                blocking(keyword.clone()).await.map(Some)
            } else {
                Ok(None)
            }
        };
        let vector_task = async {
            if use_vector {
                Some(self.vector_search(query, depth, config, store.clone()).await)
            } else {
                None
            }
        };
        let (keyword_hits, vector_hits) = tokio::join!(keyword_task, vector_task);
        let mut keyword_hits = keyword_hits?;
        let vector_hits = match vector_hits {
            Some(Ok(hits)) => Some(hits),
            Some(Err(e)) => {
                log::warn!("RAG vector search skipped: {e}");
                degraded = Some(format!("embedding_failed: {e}"));
                None
            }
            None => None,
        };
        if vector_hits.is_none() && keyword_hits.is_none() {
            keyword_hits = Some(blocking(keyword).await?);
        }

        let fused: Vec<(i64, f64)> = match (&vector_hits, &keyword_hits) {
            (Some(v), Some(k)) if params.mode == SearchMode::Hybrid => {
                let v_ids: Vec<i64> = v.iter().map(|(id, _)| *id).collect();
                let k_ids: Vec<i64> = k.iter().map(|(id, _)| *id).collect();
                let w = params.semantic_weight.clamp(0.0, 1.0) as f64;
                search::rrf_fuse(&[(&v_ids, w), (&k_ids, 1.0 - w)], config.retrieval.rrf_k)
            }
            (Some(v), _) => v.iter().map(|(id, s)| (*id, *s as f64)).collect(),
            (None, Some(k)) => k.clone(),
            (None, None) => Vec::new(),
        };
        Ok(Ranked { fused, vector_used: vector_hits.is_some(), degraded })
    }

    /// Other phrasings of `question` from the `rag_query_rewrite` task,
    /// within `rewrite.timeout_ms`; none when that fails.
    async fn rewrite_query(&self, question: &str, config: &RagConfig) -> (Vec<String>, RewriteReport) {
        let timeout = Duration::from_millis(config.rewrite.timeout_ms);
        let request = LlmRequest {
            task: rewrite::TASK,
            system: rewrite::system_prompt(config.rewrite.variants),
            user: rewrite::user_prompt(question),
            // Room for a thinking model's reasoning too (it counts against
            // the cap): about 250 tokens on a fast model, 400 at times.
            max_tokens: 1500,
            temperature: 0.3,
            json: true,
            timeout,
        };
        let started = Instant::now();
        let answer = tokio::time::timeout(timeout, self.host.complete(request)).await;
        let latency_ms = started.elapsed().as_millis() as u64;
        let (queries, status, error) = match answer {
            Err(_) => (Vec::new(), "timeout", Some(format!("no answer within {} ms", timeout.as_millis()))),
            Ok(Err(e)) => (Vec::new(), "failed", Some(e)),
            Ok(Ok(text)) => {
                let queries = rewrite::parse_queries(&text, question, config.rewrite.variants);
                let status = if queries.is_empty() { "empty" } else { "applied" };
                (queries, status, None)
            }
        };
        match &error {
            Some(e) => log::warn!("RAG query rewrite {status} after {latency_ms} ms, searching the question alone: {e}"),
            None => log::debug!("RAG query rewrite: {} queries in {latency_ms} ms", queries.len()),
        }
        (queries, RewriteReport { status, latency_ms, error })
    }

    async fn vector_search(
        &self,
        query: &str,
        depth: usize,
        config: &RagConfig,
        store: Arc<Store>,
    ) -> Result<Vec<(i64, f32)>, String> {
        let embedder = self.embedder(config).map_err(String::from)?;
        let budget = if self.host.meeting_active() {
            Duration::from_secs(config.embedding.query_timeout_secs)
        } else {
            Duration::from_secs(config.embedding.query_timeout_secs.max(15))
        };
        let vector = embedder.embed_query(query, budget).await.map_err(String::from)?;
        let slot = self.slot.clone();
        let min = (config.retrieval.min_cosine > 0.0).then_some(config.retrieval.min_cosine);
        let result = blocking(move || {
            let (candidates, space_id) = {
                let slot = slot.read().unwrap_or_else(|p| p.into_inner());
                let (Some(index), Some(space)) = (slot.index.as_ref(), slot.space.as_ref()) else {
                    return Err("vectors_loading".to_string());
                };
                if index.dims() != vector.len() {
                    return Err(format!("dims:{}:{}", vector.len(), index.dims()));
                }
                (index.candidates(&vector, depth), space.id)
            };
            Ok(flat_index::rescore_exact(&vector, &candidates, depth, min, |ids| {
                store.fetch_vectors(space_id, ids).unwrap_or_default()
            }))
        })
        .await;
        if let Err(e) = &result {
            if let Some((got, held)) = e.strip_prefix("dims:").and_then(|rest| rest.split_once(':')) {
                self.status().dims_mismatch = true;
                return Err(format!(
                    "the embedding service returned {got}-dimensional vectors but the index holds {held}-dimensional ones; rebuild the index"
                ));
            }
        }
        result
    }

    /// The first `want` results of `ranked` with their details (fetched in
    /// one query), identical texts (same hash) kept once.
    async fn distinct_hits(&self, store: Arc<Store>, ranked: Vec<(i64, f64)>, want: usize) -> Result<Vec<Hit>, String> {
        if ranked.is_empty() {
            return Ok(Vec::new());
        }
        let window: Vec<(i64, f64)> = ranked.into_iter().take(want * 3 + 10).collect();
        let ids: Vec<i64> = window.iter().map(|(id, _)| *id).collect();
        let mut details = blocking(move || store.chunk_details(&ids)).await?;
        let mut seen: HashSet<Vec<u8>> = HashSet::new();
        let mut out: Vec<Hit> = Vec::with_capacity(want);
        for (id, score) in window {
            let Some(detail) = details.remove(&id) else { continue };
            if !seen.insert(detail.hash.clone()) {
                continue;
            }
            out.push(Hit { id, detail, fused_rank: out.len() + 1, fused_score: score, rerank_score: None });
            if out.len() >= want {
                break;
            }
        }
        Ok(out)
    }

    /// Puts `hits` (fusion order) in the reranker's order, best `top_k`
    /// first. Any problem keeps the fusion order and is logged: a search
    /// never fails because of the reranker. Three failures in a row pause
    /// reranking for a minute.
    async fn rerank_hits(&self, query: &str, hits: Vec<Hit>, top_k: usize, config: &RagConfig) -> (Vec<Hit>, RerankReport) {
        let mut report =
            RerankReport { status: RerankStatus::Applied, candidates: 0, latency_ms: 0, error: None, error_kind: None };
        if self.rerank_breaker.is_open() {
            log::debug!("RAG rerank paused after repeated failures, fusion order kept");
            report.status = RerankStatus::Paused;
            return (hits, report);
        }
        let settings = match self.reranker(config) {
            Ok(settings) => settings,
            Err(e) => {
                log::warn!("RAG rerank is on but can't be used, fusion order kept: {e}");
                report.status = RerankStatus::Unconfigured;
                report.error_kind = Some(e.kind().to_string());
                report.error = Some(e.to_string());
                return (hits, report);
            }
        };
        let documents: Vec<String> = hits.iter().map(|h| embed_text(&h.detail.heading, &h.detail.text)).collect();
        report.candidates = documents.len();
        let timeout = Duration::from_millis(config.rerank.timeout_ms);
        let started = Instant::now();
        let result = match rerank::rerank(&self.http, &settings, query, &documents, top_k, timeout).await {
            Ok(ranked) if ranked.is_empty() => Err(EmbedError::BadResponse("the reranker returned no results".to_string())),
            other => other,
        };
        report.latency_ms = started.elapsed().as_millis() as u64;
        match result {
            Ok(ranked) => {
                self.rerank_breaker.success();
                let mut slots: Vec<Option<Hit>> = hits.into_iter().map(Some).collect();
                let ordered: Vec<Hit> = ranked
                    .into_iter()
                    .filter_map(|(i, score)| {
                        let mut hit = slots[i].take()?;
                        hit.rerank_score = Some(score);
                        Some(hit)
                    })
                    .take(top_k)
                    .collect();
                log::debug!("RAG rerank: {} candidates in {} ms", report.candidates, report.latency_ms);
                (ordered, report)
            }
            Err(e) => {
                self.rerank_breaker.failure();
                log::warn!("RAG rerank failed after {} ms, fusion order kept: {e}", report.latency_ms);
                if self.rerank_breaker.is_open() {
                    log::warn!("RAG rerank paused for a minute after repeated failures");
                }
                report.status = RerankStatus::Failed;
                report.error_kind = Some(e.kind().to_string());
                report.error = Some(e.to_string());
                (hits, report)
            }
        }
    }

    /// Context expansion of `chunks` (search order; `places`: document, kind
    /// and position of each): text chunks bring their neighbours or their
    /// section and merge where they meet; summaries stay as they are.
    async fn expand(
        &self,
        store: &Arc<Store>,
        places: &[(i64, ChunkKind, usize)],
        chunks: &[ScoredChunk],
        config: &RagConfig,
    ) -> Result<Vec<ScoredChunk>, String> {
        let mut docs: Vec<i64> = places.iter().filter(|(_, kind, _)| *kind == ChunkKind::Text).map(|(doc, ..)| *doc).collect();
        docs.sort_unstable();
        docs.dedup();
        let outlines: HashMap<i64, Vec<OutlineChunk>> = {
            let store = store.clone();
            blocking(move || docs.into_iter().map(|doc| Ok((doc, store.document_outline(doc)?))).collect()).await?
        };
        let mut positions: Vec<HitPos> = Vec::new();
        let mut chunk_of_hit: Vec<usize> = Vec::new();
        for (i, (doc, kind, ord)) in places.iter().enumerate() {
            if *kind != ChunkKind::Text {
                continue;
            }
            let Some(pos) = outlines.get(doc).and_then(|o| o.binary_search_by_key(ord, |c| c.ord).ok()) else { continue };
            positions.push(HitPos { doc: *doc, pos });
            chunk_of_hit.push(i);
        }
        let summary_tokens: usize = places
            .iter()
            .zip(chunks)
            .filter(|((_, kind, _), _)| *kind == ChunkKind::Summary)
            .map(|(_, c)| super::cjk::estimate_tokens(&c.text))
            .sum();
        let limits = Limits {
            neighbors: config.expansion.neighbors,
            section_max_tokens: config.expansion.section_max_tokens,
            max_total_tokens: config.expansion.max_total_tokens.saturating_sub(summary_tokens),
        };
        let passages = expand::plan(&positions, &outlines, limits);
        let ids: Vec<i64> = passages.iter().flat_map(|p| outlines[&p.doc][p.lo..=p.hi].iter().map(|c| c.id)).collect();
        let texts = {
            let store = store.clone();
            blocking(move || store.chunk_texts(&ids)).await?
        };
        let mut passage_of: HashMap<usize, usize> = HashMap::new();
        for (n, passage) in passages.iter().enumerate() {
            for hit in &passage.hits {
                passage_of.insert(chunk_of_hit[*hit], n);
            }
        }
        let mut out: Vec<ScoredChunk> = Vec::with_capacity(chunks.len());
        for (i, chunk) in chunks.iter().enumerate() {
            let Some(passage) = passage_of.get(&i).map(|n| &passages[*n]) else {
                out.push(chunk.clone());
                continue;
            };
            if chunk_of_hit[passage.hits[0]] != i {
                continue; // part of a better result's passage
            }
            let outline = &outlines[&passage.doc];
            let text = expand::join_text(outline, passage.lo, passage.hi, &texts);
            let mut chunk = chunk.clone();
            if !text.trim().is_empty() {
                chunk.text = text;
                chunk.heading = expand::passage_heading(outline, passage.lo);
                chunk.chunk_range = (passage.lo != passage.hi).then(|| (outline[passage.lo].ord, outline[passage.hi].ord));
            }
            // The same passage from a copy of the document is shown once.
            if !out.iter().any(|c| c.text == chunk.text) {
                out.push(chunk);
            }
        }
        Ok(out)
    }

    // ── In-memory index maintenance (worker) ────────────────────────────────

    pub(super) fn index_remove(&self, ids: &[i64]) {
        if ids.is_empty() {
            return;
        }
        let mut slot = self.slot_write();
        if let Some(index) = slot.index.as_mut() {
            for id in ids {
                index.remove(*id);
            }
        }
    }

    /// Adds vectors to the in-memory index if `space_id` is the active space.
    pub(super) fn index_add(&self, space_id: i64, rows: &[(i64, Vec<f32>)]) {
        let mut slot = self.slot_write();
        if slot.space.as_ref().map(|s| s.id) != Some(space_id) {
            return;
        }
        if let Some(index) = slot.index.as_mut() {
            for (id, v) in rows {
                if v.len() == index.dims() {
                    index.upsert(*id, v);
                }
            }
        }
    }

    pub fn list_connections(&self) -> Vec<ConnectionSummary> {
        use crate::llm::api::LlmKind;
        self.host
            .list_connections()
            .into_iter()
            .filter(|c| matches!(c.kind, LlmKind::OpenAiCompat | LlmKind::Ollama | LlmKind::Gemini))
            .collect()
    }
}

/// The returned `ScoredChunk`s. `normalized_score` is relative to the
/// first; reranker scores outside 0..=1 (raw logits) go through a sigmoid
/// first, so negative ones keep their order.
fn to_chunks(hits: Vec<Hit>) -> Vec<ScoredChunk> {
    let scores: Vec<f64> = hits.iter().map(|h| h.rerank_score.unwrap_or(h.fused_score)).collect();
    let logits = hits.iter().any(|h| h.rerank_score.is_some_and(|s| !(0.0..=1.0).contains(&s)));
    let scale: Vec<f64> = if logits { scores.iter().map(|s| 1.0 / (1.0 + (-s).exp())).collect() } else { scores.clone() };
    let max = scale.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    hits.into_iter()
        .zip(scores.into_iter().zip(scale))
        .map(|(h, (score, scaled))| {
            let reranked = h.rerank_score.is_some();
            ScoredChunk {
                chunk_id: h.id.to_string(),
                text: h.detail.text,
                score,
                normalized_score: if max > 0.0 { scaled / max } else { 0.0 },
                source_file: h.detail.doc_name,
                chunk_index: h.detail.ord,
                source_type: match h.detail.kind {
                    ChunkKind::Text => "file",
                    ChunkKind::Summary => "summary",
                }
                .to_string(),
                fused_rank: reranked.then_some(h.fused_rank),
                fused_score: reranked.then_some(h.fused_score),
                heading: (!h.detail.heading.is_empty()).then_some(h.detail.heading),
                chunk_range: None,
            }
        })
        .collect()
}

/// Last four characters of a secret long enough to show them.
pub fn secret_hint(secret: &str) -> String {
    let chars: Vec<char> = secret.chars().collect();
    if chars.len() >= 8 {
        chars[chars.len() - 4..].iter().collect()
    } else {
        String::new()
    }
}

pub fn ms_to_rfc3339(ms: i64) -> Option<String> {
    chrono::DateTime::from_timestamp_millis(ms).map(|t| t.to_rfc3339())
}
