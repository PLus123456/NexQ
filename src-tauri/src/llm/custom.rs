// Sub-PRD 5: User-configured custom endpoint (the old "custom" provider type)
//
// NexQ Plus: a custom endpoint is an OpenAI-compatible connection
// (`http::HttpLlmClient`) and its errors are shown as the server sent them:
// status, body and the address that was called. It used to resend every
// failed request to Ollama's `/api/chat` and show only that second error
// (and to list no models / report "not connected" without a reason). Now
// Ollama's API is tried only when the chat address answers 404 / 405, and
// both errors are shown if that fails too. The stream format (SSE, NDJSON,
// a whole JSON answer) is detected by `compat::StreamDecoder`.

use serde::{Deserialize, Serialize};

use super::connections::{legacy_connection, LlmConnection};
use super::ProviderType;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum CustomAuthType {
    None,
    Bearer,
    ApiKey,
}

#[derive(Debug, Clone)]
pub struct CustomConfig {
    pub base_url: String,
    pub auth_type: CustomAuthType,
    pub auth_value: Option<String>,
    pub auth_header: Option<String>,
}

/// The connection for a custom endpoint config, and its secret.
pub fn custom_connection(config: &CustomConfig) -> (LlmConnection, Option<String>) {
    let auth = match config.auth_type {
        CustomAuthType::None => None,
        CustomAuthType::Bearer => Some("bearer"),
        CustomAuthType::ApiKey => Some("api_key"),
    };
    let conn = legacy_connection(
        &ProviderType::Custom,
        Some(&config.base_url),
        auth,
        config.auth_header.as_deref(),
    );
    (conn, config.auth_value.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::endpoint::AuthMode;

    #[test]
    fn custom_config_maps_to_a_connection_that_shows_errors() {
        let (conn, secret) = custom_connection(&CustomConfig {
            base_url: " http://192.168.1.10:8000/v1 ".into(),
            auth_type: CustomAuthType::ApiKey,
            auth_value: Some("tok".into()),
            auth_header: Some("api-key".into()),
        });
        assert_eq!(conn.base_url, "http://192.168.1.10:8000/v1");
        assert_eq!((conn.auth.mode, conn.auth.header_name.as_str()), (AuthMode::Header, "api-key"));
        assert_eq!(secret.as_deref(), Some("tok"));
        // Ollama's API only after a 404 / 405, never after other errors.
        assert!(conn.compat.ollama_fallback_on_404);
    }
}
