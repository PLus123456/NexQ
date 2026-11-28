use tauri::{command, AppHandle, Emitter, Manager, State};

use crate::llm::api::LlmKind;
use crate::llm::gemini_cache::GeminiCacheClient;
use crate::llm::registry::{claude_context, resolve_task, LlmRegistry};
use crate::net::endpoint::AuthMode;
use crate::state::AppState;

const CACHE_CHANGED: &str = "gemini_cache_changed";

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
            None => resolve_task(&config, "assist", &claude_context(app))
                .ok()
                .map(|r| r.connection)
                .filter(|c| c.kind == LlmKind::Gemini)
                .or_else(|| config.connections.iter().find(|c| c.kind == LlmKind::Gemini && c.enabled && !c.base_url.trim().is_empty()).cloned()),
        };
        if let Some(conn) = conn {
            if conn.kind != LlmKind::Gemini {
                return Err(format!("\"{}\" is not a Gemini connection", conn.display_name()));
            }
            if !conn.enabled {
                return Err(format!("\"{}\" is turned off", conn.display_name()));
            }
            let headers = registry.request_headers(&conn)?;
            if conn.auth.mode != AuthMode::None && headers.is_empty() {
                return Err(format!("No API key is saved for \"{}\"", conn.display_name()));
            }
            return Ok((GeminiCacheClient::for_connection(&conn.base_url, headers)?, Some(conn.id)));
        }
    } else if let Some(id) = connection_id {
        return Err(format!("Unknown LLM connection \"{id}\""));
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
    Ok((GeminiCacheClient::new(&key, None)?, None))
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

    let cached = state.gemini_cache
        .create(
            client,
            cache_connection,
            &model,
            system_prompt.as_deref(),
            &context_text,
            ttl_secs,
        )
        .await?;
    log::info!(
        "Gemini context cache created: {} ({} tokens, expires {})",
        cached.name,
        cached.total_token_count,
        cached.expire_time
    );

    let _ = app.emit(CACHE_CHANGED, ());
    serde_json::to_string(&cached).map_err(|e| format!("Serialize failed: {}", e))
}

/// Delete the active Gemini context cache and clear it from AppState.
#[command]
pub async fn delete_gemini_context_cache(
    cache_name: Option<String>,
    connection_id: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let expected = cache_name.as_deref().map(|name| (name, connection_id.as_deref()));
    state.gemini_cache.delete(expected).await?;
    let _ = app.emit(CACHE_CHANGED, ());
    Ok(())
}

/// Return the active Gemini cache info, or null if none.
#[command]
pub async fn get_gemini_cache_status(
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    state.gemini_cache.status()?.map(|cache| {
        serde_json::to_string(&cache).map_err(|e| format!("Serialize failed: {e}"))
    }).transpose()
}
