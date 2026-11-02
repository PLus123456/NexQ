//! Knowledge base (RAG) settings and index commands added by NexQ Plus.
//! The upstream commands stay in `rag_commands.rs`.

use serde::Serialize;
use serde_json::Value;
use tauri::{command, AppHandle, Emitter, State};

use super::rag_commands::mirror_config;
use crate::net::endpoint::ConnectionSummary;
use crate::rag::config::RagConfig;
use crate::rag::embedding::EmbedTestResult;
use crate::rag::engine::{self, IndexInfo, RagEngine};
use crate::rag::indexer::JobKind;
use crate::rag::rerank::RerankTestResult;
use crate::state::AppState;

fn engine() -> Result<std::sync::Arc<RagEngine>, String> {
    engine::global().ok_or_else(|| "RAG engine not started".to_string())
}

/// Values derived from the config that the settings page shows.
#[derive(Debug, Clone, Serialize)]
pub struct EffectiveSettings {
    pub query_prefix: String,
    pub document_prefix: String,
    pub max_input_tokens: usize,
    pub concurrency: usize,
}

/// Everything the knowledge base settings page needs. The API keys are
/// never sent: only `key_saved` / `key_hint` of `config.embedding` and
/// `config.rerank`.
#[derive(Debug, Clone, Serialize)]
pub struct RagSettingsView {
    pub config: RagConfig,
    pub effective: EffectiveSettings,
    /// LLM connections whose address and key embeddings can reuse (empty
    /// until the LLM settings update: the option is hidden then).
    pub connections: Vec<ConnectionSummary>,
}

fn view(engine: &RagEngine, config: RagConfig) -> RagSettingsView {
    let (query_prefix, document_prefix) = config.effective_prefixes();
    RagSettingsView {
        effective: EffectiveSettings {
            query_prefix,
            document_prefix,
            max_input_tokens: config.effective_max_input_tokens(),
            concurrency: config.effective_concurrency(),
        },
        config,
        connections: engine.list_connections(),
    }
}

/// Mirrors the new config into `AppState.rag` and tells both windows.
fn publish(app: &AppHandle, state: &AppState, engine: &RagEngine, config: RagConfig) -> RagSettingsView {
    mirror_config(state, &config);
    let view = view(engine, config);
    let _ = app.emit("rag_config_changed", &view);
    view
}

#[command]
pub async fn rag_get_settings() -> Result<RagSettingsView, String> {
    let engine = engine()?;
    let config = engine.config();
    Ok(view(&engine, config))
}

/// Applies a JSON merge patch to the knowledge base settings. Never starts
/// a paid rebuild: a changed embedding model shows "rebuild needed" until
/// `rag_rebuild_index`.
#[command]
pub async fn rag_update_config(
    patch: Value,
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<RagSettingsView, String> {
    let engine = engine()?;
    let config = engine.update_config(&patch)?;
    Ok(publish(&app_handle, &state, &engine, config))
}

/// Stores the embedding API key in the keychain (`None` / empty deletes it).
#[command]
pub async fn rag_set_secret(
    secret: Option<String>,
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<RagSettingsView, String> {
    let engine = engine()?;
    let config = engine.set_secret(secret.as_deref())?;
    Ok(publish(&app_handle, &state, &engine, config))
}

/// Sends a small embedding request with the saved settings plus `draft`
/// (a patch of not yet saved fields) and reports address, status, latency
/// and vector size.
#[command]
pub async fn rag_test_embedding(draft: Option<Value>) -> Result<EmbedTestResult, String> {
    engine()?.test_embedding(draft.as_ref()).await
}

/// Stores the rerank API key in the keychain (`None` / empty deletes it).
#[command]
pub async fn rag_set_rerank_secret(
    secret: Option<String>,
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<RagSettingsView, String> {
    let engine = engine()?;
    let config = engine.set_rerank_secret(secret.as_deref())?;
    Ok(publish(&app_handle, &state, &engine, config))
}

/// Sends a small rerank request with the saved settings plus `draft` (a
/// patch of not yet saved fields) and reports address, latency and whether
/// the relevant test document came first.
#[command]
pub async fn rag_test_rerank(draft: Option<Value>) -> Result<RerankTestResult, String> {
    engine()?.test_rerank(draft.as_ref()).await
}

#[command]
pub async fn rag_get_index_info() -> Result<IndexInfo, String> {
    Ok(engine()?.index_info().await)
}

/// Queues an incremental sync (all documents when `resource_ids` is empty);
/// returns the job id. Progress arrives as `rag_index_progress`.
#[command]
pub async fn rag_sync_index(resource_ids: Option<Vec<String>>, force: Option<bool>) -> Result<u64, String> {
    let resources = resource_ids.filter(|ids| !ids.is_empty());
    Ok(engine()?.enqueue(JobKind::Sync { resources, force: force.unwrap_or(false) }))
}

/// Queues a rebuild with the current settings (the user confirmed it: with
/// a changed model every chunk is embedded again); returns the job id.
#[command]
pub async fn rag_rebuild_index(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<u64, String> {
    let engine = engine()?;
    if !engine.config().enabled {
        let config = engine.update_config(&serde_json::json!({ "enabled": true }))?;
        publish(&app_handle, &state, &engine, config);
    }
    Ok(engine.enqueue(JobKind::Rebuild))
}

/// Stops the running indexing job (what is done stays done). False if idle.
#[command]
pub async fn rag_cancel_indexing() -> Result<bool, String> {
    Ok(engine()?.cancel_current())
}
