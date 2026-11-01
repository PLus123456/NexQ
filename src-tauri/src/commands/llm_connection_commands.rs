//! Settings → AI Models (NexQ Plus): LLM connections, task routing, secrets,
//! model lists and connection tests. The frontend contract is
//! `contract-llm.md` in the shared notes. Every change answers with the new
//! config and emits `llm_config_changed`, so both windows follow.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tauri::{command, AppHandle, State};

use crate::llm::api::LlmKind;
use crate::llm::compat::truncate_chars;
use crate::llm::connections::{self, EndpointsPreview, LlmConnection, TaskRoute};
use crate::llm::http::{Failure, FailureKind, HttpLlmClient, StreamOutput};
use crate::llm::provider::{GenerationParams, LLMMessage, ModelInfo};
use crate::llm::registry::{self, LlmConfigView, LlmRegistry, SecretStatus};
use crate::net::endpoint;

/// Longest answer sample a chat test returns (characters).
const SAMPLE_CHARS: usize = 200;
/// A chat test gives up after this long.
const TEST_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Serialize)]
pub struct UpsertResult {
    pub id: String,
    pub config: LlmConfigView,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeleteResult {
    pub cleared_routes: Vec<String>,
    pub config: LlmConfigView,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct FetchModelsResult {
    pub ok: bool,
    pub url: Option<String>,
    pub status: Option<u16>,
    pub latency_ms: u64,
    pub models: Vec<ModelInfo>,
    pub error: Option<String>,
    pub error_body: Option<String>,
    pub hint: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct TestConnectionResult {
    pub ok: bool,
    pub url: Option<String>,
    pub status: Option<u16>,
    pub latency_ms: u64,
    pub model: Option<String>,
    pub sample: Option<String>,
    pub error: Option<String>,
    pub error_body: Option<String>,
    pub hint: Option<String>,
}

/// [`connections::EndpointsPreview`] plus the base URL as it will be saved.
#[derive(Debug, Clone, Serialize)]
pub struct EndpointsPreviewResult {
    #[serde(flatten)]
    pub preview: EndpointsPreview,
    /// The base URL after saving, when it differs from the typed one (a
    /// pasted full endpoint is cut back to its base).
    pub normalized_base_url: Option<String>,
}

fn view(app: &AppHandle, registry: &LlmRegistry) -> LlmConfigView {
    registry.view(&registry::claude_context(app))
}

#[command]
pub async fn llm_get_config(app: AppHandle, registry: State<'_, LlmRegistry>) -> Result<LlmConfigView, String> {
    Ok(view(&app, &registry))
}

#[command]
pub async fn llm_upsert_connection(
    connection: Value,
    secret: Option<String>,
    app: AppHandle,
    registry: State<'_, LlmRegistry>,
) -> Result<UpsertResult, String> {
    let (id, _) = registry.upsert(connection, secret)?;
    registry::after_change(&app);
    Ok(UpsertResult { id, config: view(&app, &registry) })
}

#[command]
pub async fn llm_delete_connection(
    id: String,
    app: AppHandle,
    registry: State<'_, LlmRegistry>,
) -> Result<DeleteResult, String> {
    let (cleared_routes, _) = registry.delete(&id)?;
    registry::after_change(&app);
    Ok(DeleteResult { cleared_routes, config: view(&app, &registry) })
}

#[command]
pub async fn llm_set_route(
    task: String,
    route: Option<TaskRoute>,
    app: AppHandle,
    registry: State<'_, LlmRegistry>,
) -> Result<LlmConfigView, String> {
    registry.set_route(&task, route)?;
    registry::after_change(&app);
    Ok(view(&app, &registry))
}

#[command]
pub async fn llm_set_response_language(
    value: String,
    app: AppHandle,
    registry: State<'_, LlmRegistry>,
) -> Result<LlmConfigView, String> {
    registry.set_response_language(&value)?;
    registry::after_change(&app);
    Ok(view(&app, &registry))
}

#[command]
pub async fn llm_set_secret(
    id: String,
    secret: Option<String>,
    app: AppHandle,
    registry: State<'_, LlmRegistry>,
) -> Result<SecretStatus, String> {
    let (status, _) = registry.set_secret(&id, secret.as_deref())?;
    registry::after_change(&app);
    Ok(status)
}

#[command]
pub async fn llm_secret_status(
    id: String,
    app: AppHandle,
    registry: State<'_, LlmRegistry>,
) -> Result<SecretStatus, String> {
    let (status, changed) = registry.secret_status(&id)?;
    if changed.is_some() {
        registry::after_change(&app);
    }
    Ok(status)
}

/// The client to probe: a draft being edited, or a saved connection.
fn probe_client(
    registry: &LlmRegistry,
    id: Option<String>,
    draft: Option<Value>,
    secret: Option<String>,
) -> Result<(HttpLlmClient, LlmConnection), Failure> {
    let (conn, secret, header_secrets) = match draft {
        Some(draft) => registry.draft(draft, secret).map_err(Failure::config)?,
        None => {
            let id = id.ok_or_else(|| Failure::config("Pass a connection id or a draft"))?;
            let conn = registry
                .config()
                .connection(&id)
                .cloned()
                .ok_or_else(|| Failure::config(format!("Unknown LLM connection \"{id}\"")))?;
            let secret = match secret.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
                Some(secret) => Some(secret),
                None => registry.secret_for(&conn).map_err(Failure::config)?,
            };
            // Secret headers come from the keychain through the saved connection.
            let headers = registry.request_headers(&conn).unwrap_or_default();
            let header_secrets: HashMap<String, String> = conn
                .headers
                .iter()
                .filter(|h| h.secret)
                .filter_map(|h| {
                    headers
                        .iter()
                        .find(|(name, _)| name.eq_ignore_ascii_case(h.name.trim()))
                        .map(|(_, value)| (h.name.trim().to_ascii_lowercase(), value.clone()))
                })
                .collect();
            (conn, secret, header_secrets)
        }
    };
    if conn.kind == LlmKind::ClaudeCli {
        return Err(Failure::config("The Claude subscription is checked in its own settings (Claude status)"));
    }
    let client = HttpLlmClient::new(&conn, secret.as_deref(), &header_secrets).map_err(Failure::config)?;
    Ok((client, conn))
}

/// Settings-page hint for a failure on `conn`.
fn hint_for(failure: &Failure, conn: Option<&LlmConnection>) -> Option<String> {
    if failure.status == Some(404) {
        if let Some(conn) = conn {
            if connections::preview(conn).kind_warnings.iter().any(|w| w == "looks_openai_compat") {
                return Some("looks_openai_compat".to_string());
            }
        }
    }
    if let Some(hint) = failure.hint() {
        return Some(hint.to_string());
    }
    if failure.kind == FailureKind::Config && conn.is_some_and(|c| endpoint::normalize_base_url(&c.base_url).is_err()) {
        return Some("base_url_invalid".to_string());
    }
    None
}

#[command]
pub async fn llm_fetch_models(
    id: Option<String>,
    draft: Option<Value>,
    secret: Option<String>,
    app: AppHandle,
    registry: State<'_, LlmRegistry>,
) -> Result<FetchModelsResult, String> {
    let saved_id = if draft.is_none() { id.clone() } else { None };
    let start = Instant::now();
    let (client, conn) = match probe_client(&registry, id, draft, secret) {
        Ok(found) => found,
        Err(failure) => {
            return Ok(FetchModelsResult {
                error: Some(failure.message.clone()),
                hint: hint_for(&failure, None),
                ..Default::default()
            })
        }
    };
    let models_url = client.models_url().and_then(Result::ok).map(|u| endpoint::redact_url(&u));
    let result = client.fetch_models().await;
    let latency_ms = start.elapsed().as_millis() as u64;
    let out = match result {
        Ok((url, models)) => FetchModelsResult {
            ok: true,
            url: Some(endpoint::redact_url(&url)).filter(|u| !u.is_empty()),
            status: Some(200),
            latency_ms,
            models,
            ..Default::default()
        },
        Err(failure) => FetchModelsResult {
            ok: false,
            url: failure.url.clone().or(models_url),
            status: failure.status,
            latency_ms,
            models: Vec::new(),
            error: Some(failure.message.clone()),
            error_body: failure.body.clone(),
            hint: hint_for(&failure, Some(&conn)),
        },
    };
    if let Some(id) = saved_id {
        let recorded = if out.ok { Ok(out.models.clone()) } else { Err(out.error.clone().unwrap_or_default()) };
        match registry.record_models(&id, out.url.clone(), recorded) {
            Ok(_) => registry::after_change(&app),
            Err(e) => log::warn!("Could not store the model list of {id}: {e}"),
        }
    }
    Ok(out)
}

/// Collects a test answer.
#[derive(Default)]
struct SampleOutput {
    text: Mutex<String>,
}

impl StreamOutput for SampleOutput {
    fn token(&self, token: &str) {
        if let Ok(mut text) = self.text.lock() {
            text.push_str(token);
        }
    }

    fn thinking(&self) {}

    fn error(&self, _message: &str) {}
}

#[command]
#[allow(clippy::too_many_arguments)]
pub async fn llm_test_connection(
    id: Option<String>,
    draft: Option<Value>,
    secret: Option<String>,
    model: Option<String>,
    mode: Option<String>,
    app: AppHandle,
    registry: State<'_, LlmRegistry>,
) -> Result<TestConnectionResult, String> {
    let saved_id = if draft.is_none() { id.clone() } else { None };
    let start = Instant::now();
    let (client, conn) = match probe_client(&registry, id, draft, secret) {
        Ok(found) => found,
        Err(failure) => {
            return Ok(TestConnectionResult {
                error: Some(failure.message.clone()),
                hint: hint_for(&failure, None),
                ..Default::default()
            })
        }
    };
    let out = if mode.as_deref() == Some("models") {
        match client.check().await {
            Ok(url) => TestConnectionResult {
                ok: true,
                url: Some(endpoint::redact_url(&url)),
                status: Some(200),
                latency_ms: start.elapsed().as_millis() as u64,
                ..Default::default()
            },
            Err(failure) => failed(&failure, &conn, start, None),
        }
    } else {
        let model = model
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty())
            .or_else(|| conn.default_model.clone())
            .or_else(|| conn.manual_models.first().cloned());
        let Some(model) = model else {
            return Ok(TestConnectionResult {
                error: Some("No model to test with: type a model name first".to_string()),
                hint: Some("no_model".to_string()),
                ..Default::default()
            });
        };
        let url = client.chat_url(&model).ok().map(|u| endpoint::redact_url(&u));
        let messages = vec![LLMMessage { role: "user".to_string(), content: "ping".to_string() }];
        let params = GenerationParams { max_tokens: Some(16), silent: true, ..Default::default() };
        let sample = SampleOutput::default();
        let result = tokio::time::timeout(TEST_TIMEOUT, client.stream_with(&messages, &model, &params, &sample)).await;
        match result {
            Ok(Ok(_)) => TestConnectionResult {
                ok: true,
                url,
                status: Some(200),
                latency_ms: start.elapsed().as_millis() as u64,
                model: Some(model),
                sample: Some(truncate_chars(sample.text.lock().map(|t| t.trim().to_string()).unwrap_or_default().as_str(), SAMPLE_CHARS)),
                ..Default::default()
            },
            Ok(Err(failure)) => failed(&failure, &conn, start, Some(model)),
            Err(_) => TestConnectionResult {
                url,
                latency_ms: start.elapsed().as_millis() as u64,
                model: Some(model),
                error: Some(format!("No answer within {} seconds", TEST_TIMEOUT.as_secs())),
                ..Default::default()
            },
        }
    };
    if out.ok {
        if let Some(id) = saved_id {
            match registry.mark_verified(&id) {
                Ok(_) => registry::after_change(&app),
                Err(e) => log::warn!("Could not mark {id} as tested: {e}"),
            }
        }
    }
    Ok(out)
}

fn failed(failure: &Failure, conn: &LlmConnection, start: Instant, model: Option<String>) -> TestConnectionResult {
    TestConnectionResult {
        ok: false,
        url: failure.url.clone(),
        status: failure.status,
        latency_ms: start.elapsed().as_millis() as u64,
        model,
        sample: None,
        error: Some(failure.message.clone()),
        error_body: failure.body.clone(),
        hint: hint_for(failure, Some(conn)),
    }
}

#[command]
pub async fn llm_preview_endpoints(draft: Value) -> Result<EndpointsPreviewResult, String> {
    let has_auth = draft.get("auth").is_some();
    let mut conn: LlmConnection = serde_json::from_value(draft).map_err(|e| format!("Invalid connection: {e}"))?;
    if !has_auth {
        conn.auth = connections::auth_for_kind(conn.kind);
    }
    let typed = conn.base_url.trim().trim_end_matches('/').to_string();
    connections::normalize_connection(&mut conn);
    let mut preview = connections::preview(&conn);
    let normalized_base_url = (conn.kind != LlmKind::ClaudeCli && !typed.is_empty() && conn.base_url != typed).then(|| conn.base_url.clone());
    if normalized_base_url.is_some() && endpoint::normalize_base_url(&typed).is_ok() {
        preview.kind_warnings.push("base_url_trimmed".to_string());
    }
    Ok(EndpointsPreviewResult { preview, normalized_base_url })
}

#[command]
pub async fn llm_reset_from_legacy(app: AppHandle, registry: State<'_, LlmRegistry>) -> Result<LlmConfigView, String> {
    use tauri_plugin_store::StoreExt;
    let legacy = app.store("config.json").ok().map(|store| {
        Value::Object(store.entries().into_iter().collect::<serde_json::Map<String, Value>>())
    });
    registry.reset_from_legacy(legacy)?;
    registry::after_change(&app);
    Ok(view(&app, &registry))
}
