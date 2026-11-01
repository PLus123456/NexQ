use std::sync::Arc;
use tauri::{command, AppHandle, State};
use tokio::sync::Mutex as TokioMutex;

use crate::llm::provider::LLMProvider;
use crate::llm::registry::{self, LlmRegistry};
use crate::llm::{create_provider, LLMRouter, ProviderConfig};
use crate::llm::openrouter_models;
use crate::state::AppState;

/// Resolve the provider for a read-only operation (model listing, connection test).
///
/// A JSON `ProviderConfig` builds a temporary provider and never touches the
/// router; a bare type name (or anything else) uses the currently active provider.
fn resolve_provider(
    llm: &std::sync::Mutex<LLMRouter>,
    provider: &str,
) -> Result<Arc<TokioMutex<Box<dyn LLMProvider>>>, String> {
    if let Ok(config) = serde_json::from_str::<ProviderConfig>(provider) {
        let temp = create_provider(&config).map_err(|e| format!("Failed to create provider: {}", e))?;
        return Ok(Arc::new(TokioMutex::new(temp)));
    }

    let router = llm
        .lock()
        .map_err(|e| format!("Failed to lock LLM router: {}", e))?;
    router
        .get_provider()
        .map_err(|e| format!("No active provider: {}", e))
}

/// Old API (NexQ Plus shim): points the default route at the connection
/// that stands for this provider type (`legacy-<type>`, created when
/// missing). Idempotent: when the default connection already stands for
/// this type nothing changes, so the frontend's startup push never undoes a
/// route chosen in the new settings. An API key in the config is used for
/// this session only (the old settings store it in the keychain themselves).
#[command]
pub async fn set_llm_provider(
    provider: String,
    app: AppHandle,
    registry: State<'_, LlmRegistry>,
) -> Result<(), String> {
    // Parse the provider config from the JSON string, or create a simple one from the provider name
    let config: ProviderConfig = match serde_json::from_str(&provider) {
        Ok(config) => config,
        Err(_) => {
            // Treat the input as just a provider type name
            ProviderConfig {
                provider_type: provider.clone(),
                api_key: None,
                base_url: None,
                auth_type: None,
                auth_value: None,
                auth_header: None,
            }
        }
    };

    // Log the provider type only: the raw config JSON carries the API key / auth value.
    let provider_type = config.provider_type.clone();
    let changed = registry
        .apply_legacy_provider(&config)
        .map_err(|e| format!("Failed to set provider: {}", e))?;
    if changed {
        registry::after_change(&app);
        log::info!("LLM provider set to: {}", provider_type);
    }
    Ok(())
}

#[command]
pub async fn list_models(
    provider: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let llm = state
        .llm
        .as_ref()
        .ok_or_else(|| "LLM router not initialized".to_string())?;

    // A JSON config uses a temporary provider; the active provider is never switched.
    let provider_arc = resolve_provider(llm, &provider)?;

    let provider_guard = provider_arc.lock().await;
    let models = provider_guard
        .list_models()
        .await
        .map_err(|e| format!("Failed to list models: {}", e))?;

    serde_json::to_string(&models).map_err(|e| format!("Failed to serialize models: {}", e))
}

/// Old API (NexQ Plus shim): the default route's model, when the default
/// connection stands for `provider`; ignored otherwise.
#[command]
pub async fn set_active_model(
    provider: String,
    model_id: String,
    app: AppHandle,
    registry: State<'_, LlmRegistry>,
) -> Result<(), String> {
    let changed = registry
        .apply_legacy_model(&provider, &model_id)
        .map_err(|e| format!("Failed to set model: {}", e))?;
    if changed {
        registry::after_change(&app);
        log::info!("Active model set to: {}", model_id);
    }
    Ok(())
}

#[command]
pub async fn test_llm_connection(
    provider: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let llm = state
        .llm
        .as_ref()
        .ok_or_else(|| "LLM router not initialized".to_string())?;

    // A JSON config uses a temporary provider; the active provider is never switched.
    let provider_arc = resolve_provider(llm, &provider)?;

    let provider_guard = provider_arc.lock().await;
    provider_guard
        .test_connection()
        .await
        .map_err(|e| format!("Connection test failed: {}", e))
}

#[command]
pub async fn get_llm_providers() -> Result<String, String> {
    let providers = LLMRouter::get_all_providers();
    serde_json::to_string(&providers)
        .map_err(|e| format!("Failed to serialize providers: {}", e))
}

/// The OpenRouter key for the model catalog: `connection_id`'s, else the
/// old `openrouter` slot, else the first OpenRouter connection's.
fn openrouter_key(
    registry: &LlmRegistry,
    state: &AppState,
    connection_id: Option<&str>,
) -> Result<String, String> {
    let config = registry.config();
    if let Some(id) = connection_id {
        let conn = config
            .connection(id)
            .ok_or_else(|| format!("Unknown LLM connection \"{id}\""))?;
        return registry
            .secret_for(conn)?
            .ok_or_else(|| format!("No API key is saved for \"{}\"", conn.display_name()));
    }
    let slot = state
        .credentials
        .as_ref()
        .and_then(|c| c.lock().ok())
        .and_then(|c| c.get_key("openrouter").ok().flatten());
    if let Some(key) = slot {
        return Ok(key);
    }
    config
        .connections
        .iter()
        .filter(|c| c.is_openrouter())
        .find_map(|c| registry.secret_for(c).ok().flatten())
        .ok_or_else(|| "OpenRouter API key not found. Please enter your API key first.".to_string())
}

#[command]
pub async fn list_openrouter_models(
    force_refresh: bool,
    connection_id: Option<String>,
    registry: State<'_, LlmRegistry>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    // Check cache first (unless force refresh)
    if !force_refresh {
        let cache_guard = state
            .openrouter_cache
            .lock()
            .map_err(|e| format!("Failed to lock cache: {}", e))?;
        if let Some(ref cache) = *cache_guard {
            if cache.is_valid() {
                log::info!(
                    "OpenRouter models: returning {} cached models",
                    cache.models.len()
                );
                return serde_json::to_string(&cache.models)
                    .map_err(|e| format!("Failed to serialize: {}", e));
            }
        }
    }

    // The key of the given OpenRouter connection, or the usual one.
    let api_key = openrouter_key(&registry, &state, connection_id.as_deref())?;

    // Fetch from API
    let models = openrouter_models::fetch_openrouter_models(&api_key).await?;
    let model_count = models.len();

    // Update cache
    {
        let mut cache_guard = state
            .openrouter_cache
            .lock()
            .map_err(|e| format!("Failed to lock cache: {}", e))?;
        *cache_guard = Some(openrouter_models::OpenRouterModelCache::new(models.clone()));
    }

    log::info!(
        "OpenRouter models: fetched and cached {} models",
        model_count
    );

    serde_json::to_string(&models).map_err(|e| format!("Failed to serialize: {}", e))
}
