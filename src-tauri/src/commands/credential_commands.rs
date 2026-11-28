use tauri::{command, AppHandle, Manager, State};

use crate::llm::registry::LlmRegistry;
use crate::state::AppState;

/// Save the two values that were tested together. Readers share this lock,
/// and a failed region write restores the original key.
#[command]
pub async fn store_azure_speech_credentials(
    key: String,
    region: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let credentials = state.credentials.as_ref().ok_or("Credential manager not initialized")?;
    let credentials = credentials.lock().map_err(|e| format!("Failed to lock credential manager: {e}"))?;
    credentials.store_key_with_region("azure_speech", &key, "azure_speech_region", &region)
}

#[command]
pub async fn store_api_key(
    provider: String,
    key: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let cred_mgr = state
        .credentials
        .as_ref()
        .ok_or_else(|| "Credential manager not initialized".to_string())?;

    let cred = cred_mgr
        .lock()
        .map_err(|e| format!("Failed to lock credential manager: {}", e))?;

    let store = || cred.store_key(&provider, &key);
    if let Some(registry) = app.try_state::<LlmRegistry>() {
        registry.update_legacy_credential(&provider, store)
    } else {
        store()
    }
}

#[command]
pub async fn get_api_key(
    provider: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let cred_mgr = state
        .credentials
        .as_ref()
        .ok_or_else(|| "Credential manager not initialized".to_string())?;

    let cred = cred_mgr
        .lock()
        .map_err(|e| format!("Failed to lock credential manager: {}", e))?;

    cred.get_key(&provider)
}

#[command]
pub async fn delete_api_key(
    provider: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let cred_mgr = state
        .credentials
        .as_ref()
        .ok_or_else(|| "Credential manager not initialized".to_string())?;

    let cred = cred_mgr
        .lock()
        .map_err(|e| format!("Failed to lock credential manager: {}", e))?;

    let delete = || cred.delete_key(&provider);
    if let Some(registry) = app.try_state::<LlmRegistry>() {
        registry.update_legacy_credential(&provider, delete)
    } else {
        delete()
    }
}

#[command]
pub async fn has_api_key(
    provider: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let cred_mgr = state
        .credentials
        .as_ref()
        .ok_or_else(|| "Credential manager not initialized".to_string())?;

    let cred = cred_mgr
        .lock()
        .map_err(|e| format!("Failed to lock credential manager: {}", e))?;

    cred.has_key(&provider)
}
