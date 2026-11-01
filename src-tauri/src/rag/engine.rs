//! The engine behind `RagManager`: owns the stored config, `rag.db`, the
//! in-memory vector index of the active space, search, and the queue of the
//! background indexer (`indexer.rs`).
//!
//! Vectors from different embedding setups never meet: each setup is a
//! space (`RagConfig::space_key` + measured size). Searches use vectors only
//! when the active space matches the current config; otherwise they fall
//! back to keywords until the user confirms a rebuild.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use super::config::{self, RagConfig, EMBEDDING_SECRET_SLOT};
use super::embedding::{self, CancelSignal, EmbedError, EmbedTestResult, Embedder, EmbedderSettings, RetryPolicy};
use super::flat_index::{self, FlatIndex};
use super::indexer::{IndexProgress, Job, JobKind, JobSummary};
use super::search::{self, ScoredChunk, SearchMode};
use super::store::{SpaceRow, Store, StoreStats};
use crate::net::endpoint::{ConnectionSummary, ResolvedConnection};

/// A document the host wants indexed (a context resource).
#[derive(Debug, Clone, PartialEq)]
pub struct ResourceInfo {
    pub id: String,
    pub name: String,
    pub file_type: String,
    pub path: String,
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
#[derive(Debug, Clone, Default)]
pub struct SearchOutcome {
    pub chunks: Vec<ScoredChunk>,
    pub vector_used: bool,
    pub degraded: Option<String>,
}

/// Parameters a caller may override per search.
#[derive(Debug, Clone, Copy)]
pub struct SearchParams {
    pub top_k: usize,
    pub mode: SearchMode,
    pub semantic_weight: f32,
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
        if !config.embedding.key_saved || config.embedding.auth.mode == crate::net::endpoint::AuthMode::None {
            return None;
        }
        let mut cache = self.secret.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(value) = cache.as_ref() {
            return value.clone();
        }
        let value = self.host.read_secret(EMBEDDING_SECRET_SLOT).unwrap_or_else(|e| {
            log::warn!("Cannot read the embedding key: {e}");
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
            Some(self.host.resolve_connection(&config.embedding.connection_id).map_err(EmbedError::Config)?)
        };
        let secret = if connection.is_some() { None } else { self.secret(config) };
        EmbedderSettings::from_config(config, secret.as_deref(), connection.as_ref())
    }

    /// The cached embedding client for the current config.
    pub(super) fn embedder(&self, config: &RagConfig) -> Result<Arc<Embedder>, EmbedError> {
        if let Some(e) = self.embedder.lock().unwrap_or_else(|p| p.into_inner()).clone() {
            return Ok(e);
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

    /// Hybrid search: keywords (bigram FTS) and vectors in parallel, fused
    /// by weighted RRF. Vectors are skipped when unusable (not configured,
    /// stale, loading) or when the query can't be embedded in time; the
    /// keyword results are returned then.
    pub async fn search(&self, query: &str, params: SearchParams) -> Result<SearchOutcome, String> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(SearchOutcome::default());
        }
        let store = self.store()?;
        let config = self.config();
        let depth = config.retrieval.depth.max(params.top_k * 2);
        let state = self.vector_state(&config);
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
                Some(self.vector_search(query, depth, &config, store.clone()).await)
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

        let chunks = self.materialize(store, fused, params.top_k).await?;
        Ok(SearchOutcome { chunks, vector_used: vector_hits.is_some(), degraded })
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

    /// Turns ranked ids into `ScoredChunk`s: details fetched in one query,
    /// identical texts (same hash) kept once, `top_k` returned,
    /// `normalized_score` relative to the best.
    async fn materialize(&self, store: Arc<Store>, ranked: Vec<(i64, f64)>, top_k: usize) -> Result<Vec<ScoredChunk>, String> {
        if ranked.is_empty() {
            return Ok(Vec::new());
        }
        let window: Vec<(i64, f64)> = ranked.into_iter().take(top_k * 3 + 10).collect();
        let ids: Vec<i64> = window.iter().map(|(id, _)| *id).collect();
        let details = blocking(move || store.chunk_details(&ids)).await?;
        let mut seen: HashSet<Vec<u8>> = HashSet::new();
        let mut out: Vec<ScoredChunk> = Vec::with_capacity(top_k);
        for (id, score) in window {
            let Some(d) = details.get(&id) else { continue };
            if !seen.insert(d.hash.clone()) {
                continue;
            }
            out.push(ScoredChunk {
                chunk_id: id.to_string(),
                text: d.text.clone(),
                score,
                normalized_score: 0.0,
                source_file: d.doc_name.clone(),
                chunk_index: d.ord,
                source_type: "file".to_string(),
            });
            if out.len() >= top_k {
                break;
            }
        }
        let max = out.iter().map(|c| c.score).fold(f64::NEG_INFINITY, f64::max);
        for c in &mut out {
            c.normalized_score = if max > 0.0 { c.score / max } else { 0.0 };
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
