use std::collections::HashSet;

use tauri::{command, AppHandle, Manager, State};

use crate::llm::api::LlmKind;
use crate::llm::cli_agent::routing::DOC_PRELOAD_TOKEN_CAP;
use crate::llm::registry::{self as llm_registry, LlmRegistry};
use crate::rag;
use crate::state::AppState;

#[command]
pub async fn load_context_file(
    file_path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let ctx_mgr = state
        .context
        .as_ref()
        .ok_or_else(|| "Context manager not initialized".to_string())?;

    let resource = {
        let mut ctx = ctx_mgr
            .lock()
            .map_err(|e| format!("Failed to lock context manager: {}", e))?;
        ctx.load_file(&file_path)?
    };

    // Persist to DB so the resource survives app restarts
    if let Some(db_arc) = state.database.as_ref() {
        if let Ok(db_guard) = db_arc.lock() {
            let db_res = crate::db::context::ContextResource {
                id: resource.id.clone(),
                name: resource.name.clone(),
                file_type: resource.file_type.clone(),
                file_path: resource.file_path.clone(),
                size_bytes: resource.size_bytes as i64,
                token_count: resource.token_count as i64,
                preview: resource.preview.clone(),
                loaded_at: resource.loaded_at.clone(),
            };
            if let Err(e) = crate::db::context::add_context_resource(db_guard.connection(), &db_res) {
                log::warn!("Failed to persist context resource to DB: {}", e);
            }
        }
    }

    // Index it in the background while the knowledge base is on.
    if let Some(engine) = crate::rag::engine::global() {
        let config = engine.config();
        if config.enabled && config.indexing.auto_index {
            engine.enqueue(crate::rag::indexer::JobKind::Sync {
                resources: Some(vec![resource.id.clone()]),
                force: false,
            });
        }
    }

    serde_json::to_string(&resource)
        .map_err(|e| format!("Failed to serialize resource: {}", e))
}

#[command]
pub async fn remove_context_file(
    resource_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let ctx_mgr = state
        .context
        .as_ref()
        .ok_or_else(|| "Context manager not initialized".to_string())?;

    {
        let mut ctx = ctx_mgr
            .lock()
            .map_err(|e| format!("Failed to lock context manager: {}", e))?;
        ctx.remove_file(&resource_id)?;
    }

    // Remove from DB (context record + RAG chunks)
    if let Some(db_arc) = state.database.as_ref() {
        if let Ok(db_guard) = db_arc.lock() {
            let _ = crate::db::context::delete_context_resource(db_guard.connection(), &resource_id);
            let _ = crate::db::rag::delete_chunks_by_file(db_guard.connection(), &resource_id);
        }
    }
    // Searches must stop finding it whatever the context strategy.
    if let Some(engine) = crate::rag::engine::global() {
        engine.enqueue(crate::rag::indexer::JobKind::Remove { resource_id: resource_id.clone() });
    }

    Ok(())
}

#[command]
pub async fn list_context_resources(
    state: State<'_, AppState>,
) -> Result<String, String> {
    let ctx_mgr = state
        .context
        .as_ref()
        .ok_or_else(|| "Context manager not initialized".to_string())?;

    let ctx = ctx_mgr
        .lock()
        .map_err(|e| format!("Failed to lock context manager: {}", e))?;

    let resources = ctx.list_resources();

    serde_json::to_string(&resources)
        .map_err(|e| format!("Failed to serialize resources: {}", e))
}

#[command]
pub async fn set_custom_instructions(
    instructions: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let ctx_mgr = state
        .context
        .as_ref()
        .ok_or_else(|| "Context manager not initialized".to_string())?;

    let mut ctx = ctx_mgr
        .lock()
        .map_err(|e| format!("Failed to lock context manager: {}", e))?;

    ctx.set_custom_instructions(&instructions);

    Ok(())
}

#[command]
pub async fn get_assembled_context(
    state: State<'_, AppState>,
) -> Result<String, String> {
    let ctx_mgr = state
        .context
        .as_ref()
        .ok_or_else(|| "Context manager not initialized".to_string())?;

    let ctx = ctx_mgr
        .lock()
        .map_err(|e| format!("Failed to lock context manager: {}", e))?;

    Ok(ctx.get_assembled_context())
}

/// The model the assist route sends the context to, its connection's name,
/// its context length (0 when it isn't known) and whether it is a Claude
/// CLI connection.
fn assist_context_window(app: &AppHandle) -> (Option<String>, Option<String>, u64, bool) {
    let Some(registry) = app.try_state::<LlmRegistry>() else {
        return (None, None, 0, false);
    };
    let claude = llm_registry::claude_context(app);
    match llm_registry::resolve_task(&registry.config(), "assist:Assist", &claude) {
        Ok(route) => {
            let limit = route
                .model
                .as_deref()
                .and_then(|m| route.connection.context_window(m))
                .unwrap_or(0);
            let claude_cli = route.connection.kind == LlmKind::ClaudeCli;
            (route.model, Some(route.connection.display_name()), limit, claude_cli)
        }
        Err(_) => (None, None, 0, false),
    }
}

#[command]
pub async fn get_token_budget(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let (model, connection, model_context_window, claude_cli) = assist_context_window(&app);

    // Indexed documents reach the model as the passages a search finds.
    let (indexed, retrieved_tokens) = match rag::engine::global() {
        Some(engine) => (engine.indexed_resources().await, engine.config().retrieved_tokens_max()),
        None => (HashSet::new(), 0),
    };

    let ctx_mgr = state
        .context
        .as_ref()
        .ok_or_else(|| "Context manager not initialized".to_string())?;

    let ctx = ctx_mgr
        .lock()
        .map_err(|e| format!("Failed to lock context manager: {}", e))?;

    // Transcript tokens default to 0 when not in a meeting
    let transcript_tokens: usize = 0;

    // A Claude session preloads documents that fit its cap, indexed or not.
    let sent_whole = claude_cli && ctx.resources_tokens() <= DOC_PRELOAD_TOKEN_CAP;
    let retrieved_tokens = if sent_whole { 0 } else { retrieved_tokens };

    let mut budget = ctx.get_token_budget(model_context_window, transcript_tokens, &indexed, retrieved_tokens);
    budget.model = model;
    budget.connection = connection;

    serde_json::to_string(&budget)
        .map_err(|e| format!("Failed to serialize token budget: {}", e))
}
