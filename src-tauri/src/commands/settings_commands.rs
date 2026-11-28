use serde::Deserialize;
use serde_json::Value;
use std::sync::Mutex;
use tauri::{command, AppHandle};
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "config.json";
static CONFIG_LIST_WRITES: Mutex<()> = Mutex::new(());

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ConfigListMutation {
    Upsert { item: Value },
    Remove { id: String },
    Clear,
}

fn list_item_id<'a>(key: &str, item: &'a Value) -> Option<&'a str> {
    if key == "customPresets" {
        item.get("preset_name")?.as_str()
    } else {
        item.as_str()
    }
}

/// Apply the edit to the shared store instead of replacing the list with a
/// webview's last snapshot. Both windows use the same write lock.
#[command]
pub fn mutate_config_list(key: String, mutation: ConfigListMutation, app: AppHandle) -> Result<(), String> {
    if !matches!(key.as_str(), "customPresets" | "verifiedCloudProviders" | "openrouterFavorites" | "openrouterRecentlyUsed") {
        return Err("Unknown settings list".to_string());
    }
    let _write = CONFIG_LIST_WRITES.lock().map_err(|_| "Settings list is unavailable")?;
    let store = app.store(STORE_FILE).map_err(|e| format!("Failed to open config store: {e}"))?;
    let mut list = store.get(&key).and_then(|value| value.as_array().cloned()).unwrap_or_default();
    match mutation {
        ConfigListMutation::Upsert { item } => {
            let id = list_item_id(&key, &item).ok_or("Invalid settings list entry")?;
            let recent = key == "openrouterRecentlyUsed";
            if key != "customPresets" && !recent && list.iter().any(|entry| list_item_id(&key, entry) == Some(id)) {
                return Ok(());
            }
            list.retain(|entry| list_item_id(&key, entry) != Some(id));
            if recent {
                list.insert(0, item);
                list.truncate(5);
            } else {
                list.push(item);
            }
        }
        ConfigListMutation::Remove { id } => list.retain(|entry| list_item_id(&key, entry) != Some(id.as_str())),
        ConfigListMutation::Clear => list.clear(),
    }
    store.set(key, Value::Array(list));
    Ok(())
}

#[command]
pub async fn get_config(key: String, app: AppHandle) -> Result<Option<String>, String> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| format!("Failed to open config store: {}", e))?;

    let value = store.get(&key);

    match value {
        Some(val) => {
            // Return the JSON value as a string
            let s = serde_json::to_string(&val)
                .map_err(|e| format!("Failed to serialize config value: {}", e))?;
            Ok(Some(s))
        }
        None => Ok(None),
    }
}

#[command]
pub async fn set_config(key: String, value: String, app: AppHandle) -> Result<(), String> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| format!("Failed to open config store: {}", e))?;

    // Parse the value as a JSON value so it's stored properly
    let json_value: serde_json::Value = serde_json::from_str(&value).unwrap_or_else(|_| {
        // If it's not valid JSON, store as a plain string
        serde_json::Value::String(value.clone())
    });

    store.set(key, json_value);

    Ok(())
}
