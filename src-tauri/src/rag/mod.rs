pub mod cjk;
pub mod config;
pub mod chunker;
pub mod store;
pub mod flat_index;
pub mod embedding;
pub mod engine;
pub mod indexer;
pub mod tauri_host;
pub mod embedder;
pub mod vector_store;
pub mod search;
pub mod prompt_builder;
pub mod file_processor;
pub mod transcript_indexer;

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use config::RagConfig;
use engine::{RagEngine, SearchParams};
use indexer::JobKind;
use search::{ScoredChunk, SearchMode};
use transcript_indexer::TranscriptIndexer;
use crate::db::rag as rag_db;
use crate::db::DatabaseManager;
use rusqlite::Connection;
use tauri::AppHandle;

/// Facade over the RAG engine (`engine.rs`), kept in `AppState.rag`.
///
/// The methods keep their upstream signatures: `intelligence_commands.rs`
/// (the LLM package's file) calls `search_async`, `get_status` and
/// `config()` as before. The static methods ignore the `nexq.db` handles
/// they are given: the index lives in `<app data>/rag/rag.db`.
pub struct RagManager {
    /// Mirror of the engine's config, for `config()` (refreshed by the commands).
    config: RagConfig,
    transcript_indexer: Option<TranscriptIndexer>,
}

impl RagManager {
    /// Starts the engine with the stored config (`<app data>/rag/`), and
    /// once the app state is ready queues the startup sync (when RAG is
    /// enabled): documents removed meanwhile are dropped, new or changed
    /// ones indexed.
    pub fn bootstrap(app: AppHandle, app_data_dir: &Path) -> Self {
        let host = Arc::new(tauri_host::TauriHost::new(app));
        let engine = RagEngine::start(&app_data_dir.join("rag"), host.clone());
        engine::install_global(engine.clone());
        let startup = engine.clone();
        engine::spawn(async move {
            use engine::RagHost;
            for _ in 0..240 {
                if host.resources().is_some() {
                    let config = startup.config();
                    if config.enabled && config.indexing.auto_index {
                        startup.enqueue(JobKind::Sync { resources: None, force: false });
                    }
                    return;
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            log::warn!("RAG: context resources not available, startup sync skipped");
        });
        Self::new(engine.config())
    }

    /// A manager with `config` (no engine of its own; the static methods use
    /// the global one).
    pub fn new(config: RagConfig) -> Self {
        let transcript_indexer = if config.include_transcript {
            Some(TranscriptIndexer::new(config.chunk_size))
        } else {
            None
        };
        Self {
            config,
            transcript_indexer,
        }
    }

    /// Get a reference to the current configuration.
    pub fn config(&self) -> &RagConfig {
        &self.config
    }

    /// The embedding service's base URL (informational).
    pub fn embedder_url(&self) -> String {
        self.config.embedding.base_url.clone()
    }

    /// Get the configured embedding model name.
    pub fn embedding_model(&self) -> String {
        self.config.embedding.model.clone()
    }

    /// Replace the configuration (applied as a patch, so fields the caller
    /// doesn't know keep their values) and store it.
    pub fn update_config(&mut self, config: RagConfig) {
        let next = match (engine::global(), serde_json::to_value(&config)) {
            (Some(engine), Ok(patch)) => match engine.update_config(&patch) {
                Ok(next) => next,
                Err(e) => {
                    log::warn!("RAG config not saved: {e}");
                    config
                }
            },
            _ => config,
        };
        self.mirror(next);
    }

    /// Takes the engine's config without storing anything.
    pub fn mirror(&mut self, config: RagConfig) {
        if config.include_transcript && self.transcript_indexer.is_none() {
            self.transcript_indexer = Some(TranscriptIndexer::new(config.chunk_size));
        } else if !config.include_transcript {
            self.transcript_indexer = None;
        }
        self.config = config;
    }

    /// Get a mutable reference to the transcript indexer, if enabled.
    pub fn transcript_indexer_mut(&mut self) -> Option<&mut TranscriptIndexer> {
        self.transcript_indexer.as_mut()
    }

    /// Index one resource now and wait for it (re-reads the file; unchanged
    /// chunks keep their vectors). Returns its chunk count. The text, name
    /// and connection arguments are not needed any more.
    pub async fn index_file_async(
        _db: &Arc<Mutex<DatabaseManager>>,
        file_id: &str,
        _text: &str,
        _file_name: &str,
        _app_handle: &AppHandle,
        _config: &RagConfig,
        _embedder_url: &str,
    ) -> Result<usize, String> {
        let engine = engine::global().ok_or("RAG engine not started")?;
        let summary = engine
            .run(JobKind::Sync { resources: Some(vec![file_id.to_string()]), force: true })
            .await?;
        if let Some(failure) = summary.failures.first() {
            return Err(failure.error.clone());
        }
        Ok(summary.chunks_inserted + summary.chunks_kept)
    }

    /// Remove a file from the index (queued; also clears the upstream tables).
    pub fn remove_file_index(conn: &Connection, file_id: &str) -> Result<(), String> {
        let _ = rag_db::delete_chunks_by_file(conn, file_id);
        if let Some(engine) = engine::global() {
            engine.enqueue(JobKind::Remove { resource_id: file_id.to_string() });
        }
        Ok(())
    }

    /// Clear the entire RAG index (queued; also clears the upstream tables).
    pub fn clear_index(conn: &Connection) -> Result<(), String> {
        let _ = rag_db::clear_all_chunks(conn);
        if let Some(engine) = engine::global() {
            engine.enqueue(JobKind::Clear);
        }
        Ok(())
    }

    /// Search the index. `config` supplies `top_k`, `search_mode` and
    /// `semantic_weight`; the embedding settings are the engine's. Vectors
    /// are used only when they belong to the current embedding setup, so a
    /// changed model never mixes old and new vectors (keywords answer
    /// meanwhile).
    pub async fn search_async(
        _db: &Arc<Mutex<DatabaseManager>>,
        query: &str,
        config: &RagConfig,
        _embedder_url: &str,
        _model: &str,
    ) -> Result<Vec<ScoredChunk>, String> {
        let Some(engine) = engine::global() else {
            return Ok(Vec::new());
        };
        let params = SearchParams {
            top_k: config.top_k.max(1),
            mode: SearchMode::parse(&config.search_mode),
            semantic_weight: config.semantic_weight,
        };
        Ok(engine.search(query, params).await?.chunks)
    }

    /// Index counters, from memory (no database query).
    pub fn get_status(_conn: &Connection) -> Result<rag_db::RagIndexStatus, String> {
        let stats = engine::global().map(|e| e.stats()).unwrap_or_default();
        Ok(rag_db::RagIndexStatus {
            total_files: stats.documents,
            indexed_files: stats.documents_indexed,
            total_chunks: stats.chunks,
            total_tokens: stats.tokens,
            last_indexed_at: stats.last_indexed_at_ms.and_then(engine::ms_to_rfc3339),
        })
    }
}

#[cfg(test)]
mod tests;
