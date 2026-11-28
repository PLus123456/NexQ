// Tauri commands for managing OPUS-MT translation model downloads.

use tauri::{command, AppHandle, Manager};

use crate::state::AppState;

/// List all OPUS-MT models with their download and activation status.
#[command]
pub async fn list_opus_mt_models(app: AppHandle) -> Result<String, String> {
    let state = app.state::<AppState>();
    let mgr = state
        .opus_mt_manager
        .as_ref()
        .ok_or("OPUS-MT manager not initialized")?;
    let mgr = mgr
        .lock()
        .map_err(|_| "OPUS-MT manager lock poisoned".to_string())?;

    let models = mgr.list_models();
    serde_json::to_string(&models)
        .map_err(|e| format!("Failed to serialize models: {}", e))
}

/// Start downloading an OPUS-MT model. Progress emitted via `model_download_progress` events.
#[command]
pub async fn download_opus_mt_model(
    app: AppHandle,
    model_id: String,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mgr = state
        .opus_mt_manager
        .as_ref()
        .ok_or("OPUS-MT manager not initialized")?;

    let mut mgr = mgr
        .lock()
        .map_err(|_| "OPUS-MT manager lock poisoned".to_string())?;

    mgr.download_model(&model_id, app.clone())
}

/// Cancel an active OPUS-MT model download.
#[command]
pub async fn cancel_opus_mt_download(
    app: AppHandle,
    model_id: String,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mgr = state
        .opus_mt_manager
        .as_ref()
        .ok_or("OPUS-MT manager not initialized")?;

    let mut mgr = mgr
        .lock()
        .map_err(|_| "OPUS-MT manager lock poisoned".to_string())?;

    mgr.cancel_download(&model_id);
    Ok(())
}

/// Delete a downloaded OPUS-MT model.
#[command]
pub async fn delete_opus_mt_model(
    app: AppHandle,
    model_id: String,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mgr = state
        .opus_mt_manager
        .as_ref()
        .ok_or("OPUS-MT manager not initialized")?;

    let mut mgr = mgr
        .lock()
        .map_err(|_| "OPUS-MT manager lock poisoned".to_string())?;

    let mut router = state.translation.as_ref().map(|router| {
        router.lock().map_err(|_| "Translation router lock poisoned".to_string())
    }).transpose()?;
    mgr.delete_model(&model_id)?;
    if let Some(router) = router.as_mut() {
        router.set_opus_mt_active_model(mgr.active_model_id().map(str::to_owned));
    }
    Ok(())
}

/// Activate a downloaded OPUS-MT model. ONNX sessions load lazily on first translate().
#[command]
pub async fn activate_opus_mt_model(
    app: AppHandle,
    model_id: String,
) -> Result<(), String> {
    let state = app.state::<AppState>();

    let mgr = state
        .opus_mt_manager
        .as_ref()
        .ok_or("OPUS-MT manager not initialized")?;
    let mut mgr = mgr
        .lock()
        .map_err(|_| "OPUS-MT manager lock poisoned".to_string())?;
    let mut router = state.translation.as_ref().map(|router| {
        router.lock().map_err(|_| "Translation router lock poisoned".to_string())
    }).transpose()?;

    mgr.activate_model(&model_id)?;
    if let Some(router) = router.as_mut() {
        use crate::translation::TranslationProviderType::OpusMt;
        router.set_opus_mt_active_model(mgr.active_model_id().map(str::to_owned));
        if router.active_type() != Some(&OpusMt) {
            router.set_provider(OpusMt).map_err(|error| error.to_string())?;
        }
    }

    log::info!("OPUS-MT model activated: {} (ONNX will load on first translate)", model_id);
    Ok(())
}
