//! The engine's view of the running app: context resources, events,
//! keychain, meeting state and LLM connections.

use std::sync::atomic::Ordering;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use futures::future::BoxFuture;

use super::engine::{LlmRequest, RagHost, ResourceInfo};
use crate::credentials::CredentialManager;
use crate::net::endpoint::{ConnectionSummary, ResolvedConnection};
use crate::state::AppState;

pub struct TauriHost {
    app: AppHandle,
}

impl TauriHost {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl RagHost for TauriHost {
    fn resources(&self) -> Option<Vec<ResourceInfo>> {
        let state = self.app.try_state::<AppState>()?;
        // Resources are restored from nexq.db: without it the list is empty
        // for the wrong reason and must not delete the index.
        state.database.as_ref()?;
        let ctx = state.context.as_ref()?.lock().ok()?;
        Some(
            ctx.list_resources()
                .into_iter()
                .map(|r| ResourceInfo { id: r.id, name: r.name, file_type: r.file_type, path: r.file_path })
                .collect(),
        )
    }

    fn resource_text(&self, id: &str) -> Option<String> {
        let state = self.app.try_state::<AppState>()?;
        let ctx = state.context.as_ref()?.lock().ok()?;
        ctx.resource_text(id)
    }

    fn emit(&self, event: &str, payload: Value) {
        let _ = self.app.emit(event, payload);
    }

    fn read_secret(&self, slot: &str) -> Result<Option<String>, String> {
        CredentialManager::new().get_key(slot)
    }

    fn write_secret(&self, slot: &str, value: Option<&str>) -> Result<(), String> {
        let creds = CredentialManager::new();
        match value {
            Some(secret) => creds.store_key(slot, secret),
            None => creds.delete_key(slot),
        }
    }

    fn meeting_active(&self) -> bool {
        self.app
            .try_state::<AppState>()
            .is_some_and(|s| s.meeting_active.load(Ordering::SeqCst))
    }

    fn resolve_connection(&self, id: &str) -> Result<ResolvedConnection, String> {
        crate::llm::api::resolve_connection(&self.app, id).map_err(|e| e.to_string())
    }

    fn list_connections(&self) -> Vec<ConnectionSummary> {
        crate::llm::api::list_connections(&self.app)
    }

    fn complete(&self, request: LlmRequest) -> BoxFuture<'static, Result<String, String>> {
        use crate::llm::api::{self, CompleteOptions, LlmTask};
        use crate::llm::provider::LLMMessage;
        let app = self.app.clone();
        Box::pin(async move {
            let messages = vec![
                LLMMessage { role: "system".into(), content: request.system },
                LLMMessage { role: "user".into(), content: request.user },
            ];
            let options = CompleteOptions {
                temperature: Some(request.temperature),
                max_tokens: Some(request.max_tokens),
                json_mode: request.json,
                timeout: Some(request.timeout),
                ..Default::default()
            };
            api::complete_text(&app, &LlmTask::Other(request.task), messages, options)
                .await
                .map_err(|e| e.to_string())
        })
    }
}
