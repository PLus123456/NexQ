use tauri::{command, AppHandle, Manager, State};

use crate::llm::api::LlmKind;
use crate::llm::connections::resolve_route;
use crate::llm::gemini_cache::GeminiCacheClient;
use crate::llm::registry::LlmRegistry;
use crate::state::AppState;

/// Where a context cache lives: `connection_id`'s Gemini connection, else the
/// connection the AI assistant is routed to when it is Gemini, else the first
/// Gemini connection; without any, the old Gemini key on Google's API.
/// Returns the client and the connection id it belongs to.
fn gemini_target(
    app: &AppHandle,
    state: &AppState,
    connection_id: Option<&str>,
) -> Result<(GeminiCacheClient, Option<String>), String> {
    if let Some(registry) = app.try_state::<LlmRegistry>() {
        let config = registry.config();
        let conn = match connection_id {
            Some(id) => Some(
                config
                    .connection(id)
                    .cloned()
                    .ok_or_else(|| format!("Unknown LLM connection \"{id}\""))?,
            ),
            None => resolve_route(&config, "assist")
                .ok()
                .map(|r| r.connection)
                .filter(|c| c.kind == LlmKind::Gemini)
                .or_else(|| config.connections.iter().find(|c| c.kind == LlmKind::Gemini && c.enabled).cloned()),
        };
        if let Some(conn) = conn {
            if conn.kind != LlmKind::Gemini {
                return Err(format!("\"{}\" is not a Gemini connection", conn.display_name()));
            }
            let headers = registry.request_headers(&conn)?;
            if headers.is_empty() {
                return Err(format!("No API key is saved for \"{}\"", conn.display_name()));
            }
            return Ok((GeminiCacheClient::for_connection(&conn.base_url, headers), Some(conn.id)));
        }
    }
    let key = state
        .credentials
        .as_ref()
        .ok_or("Credential manager not initialized")?
        .lock()
        .map_err(|e| format!("Credentials lock failed: {}", e))?
        .get_key("gemini")
        .map_err(|e| format!("Credential error: {}", e))?
        .ok_or("Gemini API key not configured")?;
    Ok((GeminiCacheClient::new(&key, None), None))
}

/// Create a Gemini context cache from all loaded context resources.
///
/// Reads the assembled context text from ContextManager, creates the cache on
/// the Gemini connection (see [`gemini_target`]), and stores it in AppState.
/// Returns JSON with `{ name, model, expire_time, total_token_count, connection_id? }`.
#[command]
pub async fn create_gemini_context_cache(
    model: String,
    ttl_secs: u64,
    system_prompt: Option<String>,
    connection_id: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    // Get assembled context text
    let context_text = {
        let ctx = state
            .context
            .as_ref()
            .ok_or("Context manager not initialized")?
            .lock()
            .map_err(|e| format!("Context lock failed: {}", e))?;
        ctx.get_assembled_context()
    };

    if context_text.trim().is_empty() {
        return Err("No context resources loaded. Add documents before creating a cache.".to_string());
    }

    let (client, cache_connection) = gemini_target(&app, &state, connection_id.as_deref())?;

    let mut cached = client
        .create(
            &model,
            system_prompt.as_deref(),
            &context_text,
            ttl_secs,
        )
        .await?;
    cached.connection_id = cache_connection;

    log::info!(
        "Gemini context cache created: {} ({} tokens, expires {})",
        cached.name,
        cached.total_token_count,
        cached.expire_time
    );

    // Store in AppState
    {
        let mut cache_slot = state
            .gemini_cache
            .lock()
            .map_err(|e| format!("Cache state lock failed: {}", e))?;
        *cache_slot = Some(cached.clone());
    }

    serde_json::to_string(&cached).map_err(|e| format!("Serialize failed: {}", e))
}

/// Delete the active Gemini context cache and clear it from AppState.
#[command]
pub async fn delete_gemini_context_cache(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let cache = {
        let slot = state
            .gemini_cache
            .lock()
            .map_err(|e| format!("Cache state lock failed: {}", e))?;
        slot.as_ref().map(|c| (c.name.clone(), c.connection_id.clone()))
    };

    let Some((name, cache_connection)) = cache else {
        return Ok(()); // Nothing to delete
    };

    // On the connection it was made on. That connection may be gone: the
    // cache then just expires on Google's side.
    match gemini_target(&app, &state, cache_connection.as_deref()) {
        Ok((client, _)) => client.delete(&name).await?,
        Err(e) => log::warn!("Gemini context cache {name} not deleted on the server: {e}"),
    }

    // Clear from state
    {
        let mut slot = state
            .gemini_cache
            .lock()
            .map_err(|e| format!("Cache state lock failed: {}", e))?;
        *slot = None;
    }

    log::info!("Gemini context cache deleted: {}", name);
    Ok(())
}

/// Return the active Gemini cache info, or null if none.
#[command]
pub async fn get_gemini_cache_status(
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let slot = state
        .gemini_cache
        .lock()
        .map_err(|e| format!("Cache state lock failed: {}", e))?;

    match slot.as_ref() {
        None => Ok(None),
        Some(c) => {
            let json = serde_json::to_string(c)
                .map_err(|e| format!("Serialize failed: {}", e))?;
            Ok(Some(json))
        }
    }
}
