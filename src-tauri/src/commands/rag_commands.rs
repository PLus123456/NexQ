use tauri::{command, AppHandle, State};
use crate::intelligence::IntelligenceEngine;
use crate::llm::api::{self, LlmTask};
use crate::rag::{self, RagManager, config::RagConfig, embedder::OllamaEmbedder, engine::RagEngine, indexer::JobKind};
use crate::state::AppState;
use std::sync::Arc;

fn engine() -> Result<Arc<RagEngine>, String> {
    rag::engine::global().ok_or_else(|| "RAG engine not started".to_string())
}

/// Copies the engine's config into `AppState.rag` (what `config()` returns).
pub(crate) fn mirror_config(state: &AppState, config: &RagConfig) {
    if let Some(rag) = state.rag.as_ref() {
        if let Ok(mut mgr) = rag.lock() {
            mgr.mirror(config.clone());
        }
    }
}

/// Builds or updates the knowledge base: indexes new and changed documents,
/// re-chunks those chunked with other settings, and when the embedding
/// model changed embeds everything into a new index before switching to it
/// (unchanged chunks keep their vectors). Waits until done.
#[command]
pub async fn rebuild_rag_index(
    state: State<'_, AppState>,
) -> Result<(), String> {
    let engine = engine()?;
    // Auto-enable RAG when user explicitly requests a rebuild
    if !engine.config().enabled {
        let config = engine.update_config(&serde_json::json!({ "enabled": true }))?;
        mirror_config(&state, &config);
        log::info!("RAG auto-enabled via rebuild request");
    }

    let summary = engine.run(JobKind::Rebuild).await?;
    log::info!(
        "RAG index rebuild done: {} files, {} new chunks, {} embedded",
        summary.files_done,
        summary.chunks_inserted,
        summary.vectors_embedded
    );
    match summary.error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

/// Re-reads and re-indexes one document now. Waits until done.
#[command]
pub async fn rebuild_file_index(
    resource_id: String,
) -> Result<(), String> {
    let summary = engine()?
        .run(JobKind::Sync { resources: Some(vec![resource_id.clone()]), force: true })
        .await?;
    if let Some(failure) = summary.failures.into_iter().find(|f| f.resource_id == resource_id) {
        return Err(failure.error);
    }
    if let Some(error) = summary.error {
        return Err(error);
    }
    log::info!("RAG file index rebuilt for resource {}", resource_id);
    Ok(())
}

#[command]
pub async fn clear_rag_index(
    state: State<'_, AppState>,
) -> Result<(), String> {
    if let Some(db_arc) = state.database.as_ref() {
        if let Ok(db) = db_arc.lock() {
            let _ = crate::db::rag::clear_all_chunks(db.connection());
        }
    }
    engine()?.run(JobKind::Clear).await?;
    log::info!("RAG index cleared");
    Ok(())
}

#[command]
pub async fn get_rag_status(
    state: State<'_, AppState>,
) -> Result<String, String> {
    // Get the actual resource count from the context manager (in-memory, reliable)
    let context_file_count = state.context.as_ref()
        .and_then(|c| c.lock().ok())
        .map(|c| c.list_resources().len())
        .unwrap_or(0);

    let engine = engine()?;
    engine.refresh_stats().await;
    let stats = engine.stats();
    let status = crate::db::rag::RagIndexStatus {
        total_files: context_file_count.max(stats.documents_indexed),
        indexed_files: stats.documents_indexed,
        total_chunks: stats.chunks,
        total_tokens: stats.tokens,
        last_indexed_at: stats.last_indexed_at_ms.and_then(rag::engine::ms_to_rfc3339),
    };

    serde_json::to_string(&status)
        .map_err(|e| format!("Failed to serialize RAG status: {}", e))
}

#[command]
pub async fn test_rag_search(
    query: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let rag_arc = state.rag.as_ref()
        .ok_or_else(|| "RAG manager not initialized".to_string())?;
    let db_arc = state.database.as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let (config, embedder_url, model) = {
        let mgr = rag_arc.lock().map_err(|e| e.to_string())?;
        (mgr.config().clone(), mgr.embedder_url(), mgr.embedding_model())
    };

    let results = RagManager::search_async(db_arc, &query, &config, &embedder_url, &model).await?;

    serde_json::to_string(&results)
        .map_err(|e| format!("Failed to serialize search results: {}", e))
}

#[command]
pub async fn get_rag_config() -> Result<String, String> {
    serde_json::to_string(&engine()?.config())
        .map_err(|e| format!("Failed to serialize RAG config: {}", e))
}

/// Applies `config_json` as a patch: a client that sends the upstream
/// fields only leaves the newer settings untouched.
#[command]
pub async fn update_rag_config(
    config_json: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let patch: serde_json::Value = serde_json::from_str(&config_json)
        .map_err(|e| format!("Failed to parse RAG config: {}", e))?;
    let config = engine()?.update_config(&patch)?;
    mirror_config(&state, &config);

    log::info!("RAG config updated");
    Ok(())
}

/// The Ollama server of the embedding settings (or the upstream default).
fn ollama_base_url() -> Result<String, String> {
    let config = engine()?.config();
    Ok(if config.embedding.provider == rag::config::EmbeddingProvider::Ollama && !config.embedding.base_url.is_empty() {
        config.embedding.base_url
    } else {
        config.ollama_url
    })
}

#[command]
pub async fn test_ollama_embedding_connection() -> Result<String, String> {
    let status = OllamaEmbedder::test_connection(&ollama_base_url()?).await?;

    serde_json::to_string(&status)
        .map_err(|e| format!("Failed to serialize connection status: {}", e))
}

#[command]
pub async fn pull_embedding_model(
    model: String,
    app_handle: AppHandle,
) -> Result<(), String> {
    OllamaEmbedder::pull_model(&ollama_base_url()?, &model, app_handle).await
}

/// Remove the RAG index for a single file without touching other files.
/// Called automatically when a file is removed from context.
#[command]
pub async fn remove_file_rag_index(
    resource_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if let Some(db_arc) = state.database.as_ref() {
        if let Ok(db) = db_arc.lock() {
            let _ = crate::db::rag::delete_chunks_by_file(db.connection(), &resource_id);
        }
    }
    engine()?.run(JobKind::Remove { resource_id: resource_id.clone() }).await?;

    log::info!("RAG index removed for resource {}", resource_id);
    Ok(())
}

/// Test RAG pipeline end-to-end: search for chunks, then ask the model the
/// "knowledge base answer" task routes to (`LlmTask::RagAnswer`) to answer
/// the question using those chunks as context.
///
/// `llm_provider` / `llm_model` are accepted for older callers; the model
/// comes from the task routing.
///
/// Uses the same streaming events as generate_assist (llm_stream_start/token/end)
/// so the frontend can display the response progressively.
#[command]
pub async fn test_rag_answer(
    query: String,
    llm_provider: Option<String>,
    llm_model: Option<String>,
    request_id: Option<String>,
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let request_id = request_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    log::debug!("Test KB: caller asked for {:?} / {:?}; using the routed model", llm_provider, llm_model);

    // 1. Search RAG for relevant chunks
    let rag_arc = state.rag.as_ref()
        .ok_or_else(|| "RAG manager not initialized".to_string())?;
    let db_arc = state.database.as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let (config, embedder_url, emb_model) = {
        let mgr = rag_arc.lock().map_err(|e| e.to_string())?;
        (mgr.config().clone(), mgr.embedder_url(), mgr.embedding_model())
    };

    let chunks = RagManager::search_async(db_arc, &query, &config, &embedder_url, &emb_model).await?;

    if chunks.is_empty() {
        return Err("No relevant chunks found in the knowledge base".to_string());
    }

    // 2. Build context from chunks
    let custom_instr = state.context.as_ref()
        .and_then(|c| c.lock().ok())
        .map(|c| c.get_custom_instructions().to_string())
        .unwrap_or_default();
    let context = rag::prompt_builder::build_rag_context(&chunks, &custom_instr);

    // 3. The model for knowledge base answers
    let resolved = api::resolve_for_task(&app_handle, &LlmTask::RagAnswer)
        .await
        .map_err(String::from)?;
    let provider_arc = api::legacy_handle(&resolved);

    // 4. Call LLM with streaming (reuses existing llm_stream_* events)
    let cancel_flag = Arc::new(crate::llm::provider::CancelToken::new());
    let system_prompt = crate::intelligence::prompt_templates::get_system_prompt("AskQuestion");
    IntelligenceEngine::generate_assist(
        system_prompt,
        "AskQuestion",
        Some(&query),
        String::new(),  // no transcript for test
        None,           // no detected question
        context,
        true,           // include_context
        false,          // include_transcript (none for test)
        false,          // include_question
        true,           // include_rag (this is a RAG test)
        false,          // include_instructions
        provider_arc,
        resolved.model,
        resolved.display_name,
        crate::llm::provider::GenerationParams {
            request_id: Some(request_id),
            ..Default::default()
        },
        // Metadata for StreamStartEvent (test-rag defaults)
        0.7,                        // temperature (default)
        Some(query.clone()),        // rag_query
        Vec::new(),                 // rag_chunks (not tracked for test)
        0,                          // rag_chunks_filtered
        chunks.len(),               // rag_total_candidates
        0,                          // transcript_window_seconds (no transcript)
        0,                          // transcript_segments_count
        0,                          // transcript_segments_total
        None,                       // scope_label
        app_handle,
        cancel_flag,
    ).await
}
