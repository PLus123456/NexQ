//! Background indexing: one worker task runs queued jobs in order.
//!
//! A sync skips files whose size and mtime are unchanged, re-chunks a file
//! only when its text changed (content hash), stores only the chunks that
//! changed (chunk hash, see `Store::apply_document`) and embeds only chunks
//! that have no vector in the target space, one transaction per batch. There
//! is no job table: what is left to do is whatever the database says is
//! missing, so an interrupted job simply continues next time.

use std::collections::{HashSet, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, oneshot};

use super::chunker;
use super::config::{self, RagConfig};
use super::embedding::{CancelSignal, EmbedError, EmbedKind};
use super::engine::{blocking, RagEngine, ResourceInfo};
use super::flat_index::FlatIndex;
use super::store::{ApplyOutcome, DocMeta, NewChunk, SpaceRow, Store};

/// Bumped when text extraction changes, so documents get re-chunked.
const EXTRACTOR_VERSION: &str = "x1";

/// What a job does.
#[derive(Debug, Clone, PartialEq)]
pub enum JobKind {
    /// Index new and changed documents and embed what is missing. `None`
    /// means every document (and drop the ones that are gone); `force`
    /// re-reads the files even when size and mtime are unchanged.
    Sync { resources: Option<Vec<String>>, force: bool },
    /// Forget one document.
    Remove { resource_id: String },
    /// Apply the current settings fully: re-chunk documents chunked with
    /// other settings, and (when the embedding setup changed) embed
    /// everything into a new space, then switch to it.
    Rebuild,
    /// Delete the whole index.
    Clear,
}

pub(super) struct Job {
    pub id: u64,
    pub kind: JobKind,
    pub done: Vec<oneshot::Sender<Result<JobSummary, String>>>,
}

/// A file that could not be indexed.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct FileFailure {
    pub resource_id: String,
    pub name: String,
    pub error: String,
}

/// What a job did.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct JobSummary {
    pub files_total: usize,
    pub files_done: usize,
    pub files_skipped: usize,
    pub files_failed: usize,
    pub files_removed: usize,
    pub chunks_inserted: usize,
    pub chunks_removed: usize,
    /// Chunks whose text was unchanged (kept with their vectors).
    pub chunks_kept: usize,
    /// New chunks that got an existing vector (same text elsewhere).
    pub vectors_reused: usize,
    pub vectors_embedded: usize,
    pub switched_space: bool,
    pub cancelled: bool,
    /// The embedding pass stopped on this error (keyword search still works).
    pub error: Option<String>,
    pub error_kind: Option<String>,
    pub failures: Vec<FileFailure>,
}

/// Payload of `rag_index_progress` (field names as `src/lib/types.ts` declares them).
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct IndexProgress {
    /// scanning | extracting | embedding | paused | file_complete | complete | cancelled | error
    pub status: String,
    pub job_id: u64,
    pub file_id: Option<String>,
    pub file_name: Option<String>,
    pub files_total: usize,
    pub files_done: usize,
    pub chunks_total: usize,
    pub chunks_done: usize,
    pub chunks_reused: usize,
    pub errors: usize,
    pub message: Option<String>,
}

enum FileOutcome {
    Skipped,
    Touched,
    Applied(ApplyOutcome, usize),
    Failed(String),
}

/// Runs jobs until the engine is dropped. Loads the active space's vectors first.
pub(super) async fn worker(engine: Arc<RagEngine>, mut rx: mpsc::UnboundedReceiver<Job>) {
    engine.reload_index().await;
    engine.refresh_stats().await;
    let mut pending: VecDeque<Job> = VecDeque::new();
    loop {
        let job = match pending.pop_front() {
            Some(job) => job,
            None => match rx.recv().await {
                Some(job) => job,
                None => return,
            },
        };
        while let Ok(more) = rx.try_recv() {
            pending.push_back(more);
        }
        let job = merge_syncs(job, &mut pending);

        let cancel = Arc::new(CancelSignal::new());
        *engine.current_cancel.lock().unwrap_or_else(|p| p.into_inner()) = Some(cancel.clone());
        let result = engine.run_job(job.id, job.kind.clone(), &cancel).await;
        *engine.current_cancel.lock().unwrap_or_else(|p| p.into_inner()) = None;
        engine.refresh_stats().await;

        while let Ok(more) = rx.try_recv() {
            pending.push_back(more);
        }
        let idle = pending.is_empty();
        let mut end = IndexProgress { job_id: job.id, ..Default::default() };
        match &result {
            Ok(summary) => {
                end.status = if summary.cancelled {
                    "cancelled"
                } else if summary.error.is_some() {
                    "error"
                } else if idle {
                    "complete"
                } else {
                    "file_complete"
                }
                .to_string();
                end.files_total = summary.files_total;
                end.files_done = summary.files_done;
                end.chunks_done = summary.vectors_embedded;
                end.chunks_reused = summary.chunks_kept + summary.vectors_reused;
                end.errors = summary.files_failed + usize::from(summary.error.is_some());
                end.message = summary.error.clone();
                engine.status().last_job = Some(summary.clone());
            }
            Err(e) => {
                end.status = "error".to_string();
                end.errors = 1;
                end.message = Some(e.clone());
                engine.set_last_error("job", e.clone());
            }
        }
        engine.progress(end, true);
        for tx in job.done {
            let _ = tx.send(result.clone());
        }
    }
}

/// Folds the syncs queued right behind `job` into it (one pass instead of many).
fn merge_syncs(mut job: Job, pending: &mut VecDeque<Job>) -> Job {
    loop {
        let next_is_sync = matches!(pending.front(), Some(Job { kind: JobKind::Sync { .. }, .. }));
        let JobKind::Sync { resources, force } = &mut job.kind else { return job };
        if !next_is_sync {
            return job;
        }
        let Some(next) = pending.pop_front() else { return job };
        let JobKind::Sync { resources: more, force: more_force } = next.kind else { unreachable!() };
        *force |= more_force;
        *resources = match (resources.take(), more) {
            (Some(mut a), Some(b)) => {
                for id in b {
                    if !a.contains(&id) {
                        a.push(id);
                    }
                }
                Some(a)
            }
            _ => None,
        };
        job.done.extend(next.done);
    }
}

pub(super) fn sha256(bytes: &[u8]) -> Vec<u8> {
    Sha256::digest(bytes).to_vec()
}

fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as i64)
}

/// Chunks with their hashes.
pub(super) fn make_chunks(text: &str, size: usize, overlap: usize, strategy: &str) -> Vec<NewChunk> {
    chunker::chunk_text(text, size, overlap, strategy)
        .into_iter()
        .map(|c| NewChunk {
            ord: c.index,
            hash: sha256(c.text.as_bytes()),
            token_est: c.token_count,
            text: c.text,
            start_char: c.start_char,
            end_char: c.end_char,
        })
        .collect()
}

/// Text extraction off the async threads, with a time limit and a panic guard
/// (a broken PDF must not take the worker down).
async fn extract_text(path: String, file_type: String, timeout: Duration) -> Result<String, String> {
    let task = tokio::task::spawn_blocking(move || {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            super::file_processor::extract_text(&path, &file_type)
        }))
        .unwrap_or_else(|_| Err("the file parser crashed on this file".to_string()))
    });
    match tokio::time::timeout(timeout, task).await {
        Err(_) => Err(format!("text extraction took longer than {} s", timeout.as_secs())),
        Ok(Err(e)) => Err(format!("text extraction failed: {e}")),
        Ok(Ok(result)) => result,
    }
}

impl RagEngine {
    pub(super) async fn run_job(&self, job: u64, kind: JobKind, cancel: &CancelSignal) -> Result<JobSummary, String> {
        match kind {
            JobKind::Sync { resources, force } => self.sync(job, resources, force, false, cancel).await,
            JobKind::Rebuild => self.sync(job, None, false, true, cancel).await,
            JobKind::Remove { resource_id } => self.remove_document(&resource_id).await,
            JobKind::Clear => self.clear_index().await,
        }
    }

    async fn sync(
        &self,
        job: u64,
        only: Option<Vec<String>>,
        force: bool,
        rebuild: bool,
        cancel: &CancelSignal,
    ) -> Result<JobSummary, String> {
        let store = self.store()?;
        let config = self.config();
        let resources = self
            .host
            .resources()
            .ok_or_else(|| "The document list is not available yet".to_string())?;
        let mut summary = JobSummary::default();
        self.progress(IndexProgress { status: "scanning".into(), job_id: job, ..Default::default() }, true);

        let live: HashSet<&str> = resources.iter().map(|r| r.id.as_str()).collect();
        let gone: Vec<String> = match &only {
            None => {
                let s = store.clone();
                blocking(move || s.list_documents())
                    .await?
                    .into_iter()
                    .map(|d| d.resource_id)
                    .filter(|id| !live.contains(id.as_str()))
                    .collect()
            }
            Some(ids) => ids.iter().filter(|id| !live.contains(id.as_str())).cloned().collect(),
        };
        for id in gone {
            let s = store.clone();
            let removed = blocking(move || s.delete_document(&id)).await?;
            self.index_remove(&removed);
            summary.files_removed += 1;
            summary.chunks_removed += removed.len();
        }

        let targets: Vec<&ResourceInfo> = match &only {
            None => resources.iter().collect(),
            Some(ids) => resources.iter().filter(|r| ids.contains(&r.id)).collect(),
        };
        summary.files_total = targets.len();
        for res in targets {
            if cancel.is_cancelled() {
                summary.cancelled = true;
                break;
            }
            self.progress(
                IndexProgress {
                    status: "extracting".into(),
                    job_id: job,
                    file_id: Some(res.id.clone()),
                    file_name: Some(res.name.clone()),
                    files_total: summary.files_total,
                    files_done: summary.files_done,
                    errors: summary.files_failed,
                    ..Default::default()
                },
                false,
            );
            match self.index_resource(&store, &config, res, force, rebuild).await {
                Ok(FileOutcome::Skipped) | Ok(FileOutcome::Touched) => summary.files_skipped += 1,
                Ok(FileOutcome::Applied(outcome, reused_in_active)) => {
                    summary.chunks_inserted += outcome.inserted.len();
                    summary.chunks_removed += outcome.removed.len();
                    summary.chunks_kept += outcome.kept;
                    summary.vectors_reused += reused_in_active;
                }
                Ok(FileOutcome::Failed(error)) | Err(error) => {
                    log::warn!("RAG: cannot index {}: {error}", res.name);
                    summary.files_failed += 1;
                    if summary.failures.len() < 20 {
                        summary.failures.push(FileFailure { resource_id: res.id.clone(), name: res.name.clone(), error });
                    }
                }
            }
            summary.files_done += 1;
        }

        if !summary.cancelled {
            self.embed_missing(job, &store, &config, rebuild, cancel, &mut summary).await?;
        }
        Ok(summary)
    }

    async fn index_resource(
        &self,
        store: &Arc<Store>,
        config: &RagConfig,
        res: &ResourceInfo,
        force: bool,
        rechunk_stale: bool,
    ) -> Result<FileOutcome, String> {
        let file_meta = tokio::fs::metadata(&res.path).await;
        let (size, mtime) = match &file_meta {
            Ok(m) => (m.len() as i64, mtime_ms(m)),
            Err(_) => (0, 0),
        };
        let meta = DocMeta {
            resource_id: res.id.clone(),
            name: res.name.clone(),
            file_type: res.file_type.clone(),
            path: res.path.clone(),
            size_bytes: size,
            mtime_ms: mtime,
        };
        if let Err(e) = file_meta {
            return self.fail(store, meta, format!("the file is missing ({e})")).await;
        }
        let doc = {
            let (s, id) = (store.clone(), res.id.clone());
            blocking(move || s.document(&id)).await?
        };
        let params = config.chunk_params();
        if let Some(d) = &doc {
            let same_file = d.size_bytes == size && d.mtime_ms == mtime && matches!(d.status.as_str(), "indexed" | "empty");
            if !force && same_file && (d.chunk_params == params || !rechunk_stale) {
                return Ok(FileOutcome::Skipped);
            }
        }
        if size as u64 > config.indexing.max_file_mb * 1024 * 1024 {
            return self.fail(store, meta, format!("the file is larger than {} MB", config.indexing.max_file_mb)).await;
        }
        let text = match self.host.resource_text(&res.id).filter(|t| !t.trim().is_empty()) {
            Some(text) => text,
            None => {
                let timeout = Duration::from_secs(config.indexing.extract_timeout_secs);
                match extract_text(res.path.clone(), res.file_type.clone(), timeout).await {
                    Ok(text) => text,
                    Err(e) => return self.fail(store, meta, e).await,
                }
            }
        };
        let mut hashed = EXTRACTOR_VERSION.as_bytes().to_vec();
        hashed.push(0);
        hashed.extend_from_slice(text.as_bytes());
        let content_hash = sha256(&hashed);
        if let Some(d) = &doc {
            if d.content_hash.as_deref() == Some(content_hash.as_slice()) && d.chunk_params == params {
                let s = store.clone();
                blocking(move || s.touch_document(&meta)).await?;
                return Ok(FileOutcome::Touched);
            }
        }
        let (size_t, overlap, strategy) = (config.chunk_size, config.chunk_overlap, config.splitting_strategy.clone());
        let chunks = blocking(move || Ok(make_chunks(&text, size_t, overlap, &strategy))).await?;
        let outcome = {
            let s = store.clone();
            blocking(move || s.apply_document(&meta, &content_hash, &params, &chunks)).await?
        };
        self.index_remove(&outcome.removed);
        let active = self.slot_read().space.as_ref().map(|s| s.id);
        let mut reused = 0;
        if let Some(space) = active {
            let ids: Vec<i64> = outcome.copied.iter().filter(|(s, _)| *s == space).map(|(_, c)| *c).collect();
            if !ids.is_empty() {
                let s = store.clone();
                let rows = blocking(move || s.fetch_vectors(space, &ids)).await?;
                reused = rows.len();
                self.index_add(space, &rows);
            }
        }
        Ok(FileOutcome::Applied(outcome, reused))
    }

    async fn fail(&self, store: &Arc<Store>, meta: DocMeta, error: String) -> Result<FileOutcome, String> {
        let s = store.clone();
        let message = error.clone();
        blocking(move || s.mark_document_error(&meta, &message)).await?;
        Ok(FileOutcome::Failed(error))
    }

    /// Document-request concurrency (lowered during meetings, see `meeting_gate`).
    fn embed_concurrency(&self, config: &RagConfig) -> usize {
        let n = config.effective_concurrency().max(1);
        if self.host.meeting_active() && config.indexing.meeting_mode != "normal" {
            1
        } else {
            n
        }
    }

    /// While a meeting runs with `pause_local`, indexing against a model on
    /// this machine waits (it would compete with transcription for the CPU
    /// / GPU). Returns false when cancelled.
    async fn meeting_gate(&self, job: u64, config: &RagConfig, cancel: &CancelSignal, progress: &IndexProgress) -> bool {
        if config.indexing.meeting_mode != "pause_local" || !is_local_service(&config.embedding.base_url) {
            return true;
        }
        let mut announced = false;
        while self.host.meeting_active() {
            if !announced {
                self.progress(IndexProgress { status: "paused".into(), job_id: job, ..progress.clone() }, true);
                announced = true;
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(2)) => {}
                _ = cancel.cancelled() => return false,
            }
        }
        !cancel.is_cancelled()
    }

    /// Embeds the chunks that have no vector in the target space: the active
    /// space when it matches the config; a new space on the first build; a
    /// new space for a changed setup only when `explicit` (a confirmed
    /// rebuild), switched to once it is complete.
    async fn embed_missing(
        &self,
        job: u64,
        store: &Arc<Store>,
        config: &RagConfig,
        explicit: bool,
        cancel: &CancelSignal,
        summary: &mut JobSummary,
    ) -> Result<(), String> {
        if !config.embedding_configured() {
            return Ok(());
        }
        let key = config.space_key();
        let active = {
            let s = store.clone();
            blocking(move || s.active_space()).await?
        };
        let dims_mismatch = self.status().dims_mismatch;
        let mut target: Option<SpaceRow> = match &active {
            Some(space) if space.space_key == key && !dims_mismatch => Some(space.clone()),
            Some(_) if !explicit => return Ok(()),
            _ => {
                let (s, k) = (store.clone(), key.clone());
                let active_id = active.as_ref().map(|a| a.id);
                blocking(move || s.space_by_key(&k)).await?.filter(|s| Some(s.id) != active_id)
            }
        };
        let total = {
            let s = store.clone();
            let id = target.as_ref().map(|t| t.id);
            blocking(move || s.count_missing_vectors(id)).await?
        };
        if total > 0 {
            let embedder = match self.embedder(config) {
                Ok(e) => e,
                Err(e) => {
                    self.record_embed_error(summary, &e);
                    return Ok(());
                }
            };
            let batch = config.embedding.batch_size.max(1);
            let mut after = 0i64;
            let mut done = 0usize;
            let mut progress = IndexProgress {
                status: "embedding".into(),
                job_id: job,
                files_total: summary.files_total,
                files_done: summary.files_done,
                chunks_total: total,
                chunks_reused: summary.chunks_kept + summary.vectors_reused,
                ..Default::default()
            };
            self.progress(progress.clone(), true);
            loop {
                if cancel.is_cancelled() || !self.meeting_gate(job, config, cancel, &progress).await {
                    summary.cancelled = true;
                    break;
                }
                // The user switched to another embedding setup meanwhile: stop
                // spending on this one (its vectors would not be searched).
                if self.config().space_key() != key {
                    log::info!("RAG: embedding setup changed during the job; stopping it");
                    break;
                }
                let lanes = if target.is_none() { 1 } else { self.embed_concurrency(config) };
                let rows = {
                    let s = store.clone();
                    let space = target.as_ref().map_or(-1, |t| t.id);
                    blocking(move || s.chunks_missing_vectors(space, after, batch * lanes)).await?
                };
                let Some(last) = rows.last() else { break };
                after = last.0;
                let groups: Vec<&[(i64, String)]> = rows.chunks(batch).collect();
                let results = futures::future::join_all(groups.iter().map(|group| {
                    let texts: Vec<String> = group.iter().map(|(_, t)| t.clone()).collect();
                    let embedder = embedder.clone();
                    async move { embedder.embed(&texts, EmbedKind::Document, Some(cancel)).await }
                }))
                .await;

                let mut failure: Option<EmbedError> = None;
                for (group, result) in groups.iter().zip(results) {
                    let vectors = match result {
                        Ok(v) => v,
                        Err(e) => {
                            failure.get_or_insert(e);
                            continue;
                        }
                    };
                    let dims = vectors.first().map_or(0, Vec::len);
                    let space = match &target {
                        Some(t) if t.dims == dims => t.clone(),
                        Some(t) => {
                            if active.as_ref().map(|a| a.id) == Some(t.id) {
                                self.status().dims_mismatch = true;
                            }
                            failure.get_or_insert(EmbedError::BadResponse(format!(
                                "the service now returns {dims}-dimensional vectors but this index holds {}-dimensional ones; rebuild the index",
                                t.dims
                            )));
                            continue;
                        }
                        None => {
                            let created = self.create_space(store, config, dims, active.is_none()).await?;
                            target = Some(created.clone());
                            created
                        }
                    };
                    let rows: Vec<(i64, Vec<f32>)> = group.iter().map(|(id, _)| *id).zip(vectors).collect();
                    let stored = {
                        let s = store.clone();
                        let rows = rows.clone();
                        blocking(move || s.insert_vectors(space.id, &rows)).await?
                    };
                    let stored_set: HashSet<i64> = stored.iter().copied().collect();
                    let kept: Vec<(i64, Vec<f32>)> = rows.into_iter().filter(|(id, _)| stored_set.contains(id)).collect();
                    self.index_add(space.id, &kept);
                    done += stored.len();
                    summary.vectors_embedded += stored.len();
                    progress.chunks_done = done;
                    self.progress(progress.clone(), false);
                }
                if let Some(e) = failure {
                    if e == EmbedError::Cancelled {
                        summary.cancelled = true;
                    } else {
                        self.record_embed_error(summary, &e);
                    }
                    break;
                }
            }
        }
        if explicit && !summary.cancelled && summary.error.is_none() {
            self.switch_to(store, target, summary).await?;
        }
        Ok(())
    }

    fn record_embed_error(&self, summary: &mut JobSummary, e: &EmbedError) {
        log::warn!("RAG embedding stopped: {e}");
        summary.error = Some(e.to_string());
        summary.error_kind = Some(e.kind().to_string());
        self.set_last_error(e.kind(), e.to_string());
    }

    async fn create_space(&self, store: &Arc<Store>, config: &RagConfig, dims: usize, activate: bool) -> Result<SpaceRow, String> {
        let key = config.space_key();
        let fingerprint = config::hex(&sha256(format!("{key}:{dims}").as_bytes()));
        let (_, doc_prefix) = config.effective_prefixes();
        let descriptor = serde_json::json!({
            "provider": config.embedding.provider.as_str(),
            "model": config.embedding.model,
            "dims": dims,
            "document_prefix": doc_prefix,
            "request_dimensions": config.embedding.request_dimensions,
            "dimensions": config.embedding.dimensions,
        })
        .to_string();
        let provider = config.embedding.provider.as_str().to_string();
        let model = config.embedding.model.clone();
        let s = store.clone();
        let mut space = blocking(move || s.create_space(&key, &fingerprint, &provider, &model, dims, &descriptor)).await?;
        if activate {
            let s = store.clone();
            let id = space.id;
            blocking(move || s.activate_space(id)).await?;
            space.status = "ready".into();
            let mut slot = self.slot_write();
            slot.space = Some(space.clone());
            slot.index = Some(FlatIndex::new(dims.max(1)));
            slot.loading = false;
            drop(slot);
            self.status().dims_mismatch = false;
        }
        Ok(space)
    }

    /// After a confirmed rebuild: once `target` holds a vector for every
    /// chunk, make it the active space, load it, and delete the other spaces.
    async fn switch_to(&self, store: &Arc<Store>, target: Option<SpaceRow>, summary: &mut JobSummary) -> Result<(), String> {
        let Some(target) = target else { return Ok(()) };
        let remaining = {
            let s = store.clone();
            blocking(move || s.count_missing_vectors(Some(target.id))).await?
        };
        if remaining > 0 {
            return Ok(());
        }
        let already_active = self.slot_read().space.as_ref().map(|s| s.id) == Some(target.id);
        if !already_active {
            let s = store.clone();
            blocking(move || s.activate_space(target.id)).await?;
            self.reload_index().await;
            summary.switched_space = true;
            log::info!("RAG index switched to space {} ({} / {})", target.id, target.provider, target.model);
        }
        let spaces = {
            let s = store.clone();
            blocking(move || s.list_spaces()).await?
        };
        for old in spaces.into_iter().filter(|s| s.id != target.id) {
            let s = store.clone();
            let removed = blocking(move || s.delete_space(old.id)).await?;
            log::info!("RAG: deleted old space {} ({removed} vectors)", old.id);
        }
        Ok(())
    }

    async fn remove_document(&self, resource_id: &str) -> Result<JobSummary, String> {
        let store = self.store()?;
        let id = resource_id.to_string();
        let removed = blocking(move || store.delete_document(&id)).await?;
        self.index_remove(&removed);
        Ok(JobSummary { files_removed: 1, chunks_removed: removed.len(), ..Default::default() })
    }

    async fn clear_index(&self) -> Result<JobSummary, String> {
        let store = self.store()?;
        blocking(move || store.clear_all()).await?;
        *self.slot_write() = Default::default();
        self.status().dims_mismatch = false;
        Ok(JobSummary::default())
    }
}

/// localhost, 127.x or ::1: a model running on this machine.
fn is_local_service(base_url: &str) -> bool {
    let Ok(url) = url::Url::parse(base_url.trim()) else { return false };
    match url.host() {
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost") || d.ends_with(".localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}
