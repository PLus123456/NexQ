use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use reqwest::{Client, StatusCode};
use tauri::{AppHandle, Emitter};

use crate::audio::AudioChunk;

pub(super) const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);

/// Capture time spanned by a 16 kHz audio batch, independent of network latency.
#[derive(Clone, Copy, Default)]
pub(super) struct BatchTiming {
    pub(super) start_ms: u64,
    pub(super) end_ms: u64,
}

impl BatchTiming {
    pub(super) fn append(&mut self, chunk: &AudioChunk, first: bool) {
        if first {
            self.start_ms = chunk
                .timestamp_ms
                .saturating_sub(chunk.pcm_data.len() as u64 / 16);
            self.end_ms = chunk.timestamp_ms;
        } else {
            self.end_ms = self.end_ms.max(chunk.timestamp_ms);
        }
    }

    pub(super) fn duration_ms(self) -> u64 {
        self.end_ms.saturating_sub(self.start_ms)
    }
}

/// Shared by the built-in REST providers' probes and transcription requests.
pub(super) fn client() -> Result<Client, String> {
    static CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            Client::builder()
                .connect_timeout(Duration::from_secs(4))
                .read_timeout(REQUEST_TIMEOUT)
                .timeout(REQUEST_TIMEOUT)
                .build()
                .map_err(|e| e.to_string())
        })
        .clone()
}

/// Report each actionable HTTP error once per stream, even with concurrent batches.
#[derive(Clone, Default)]
pub(super) struct BatchStatus {
    app: Option<AppHandle>,
    party: String,
    reported: Arc<AtomicU8>,
}

impl BatchStatus {
    pub(super) fn new(app: Option<AppHandle>, party: &str) -> Self {
        Self {
            app,
            party: party.to_string(),
            ..Self::default()
        }
    }

    pub(super) fn reset(&mut self) {
        self.reported = Arc::new(AtomicU8::new(0));
    }

    pub(super) fn http_error(&self, provider: &str, status: StatusCode) {
        let Some(app) = &self.app else { return };
        let (flag, message) = match status {
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => (
                1,
                format!(
                    "Authentication rejected (HTTP {}). Check the API key and its permissions.",
                    status.as_u16()
                ),
            ),
            StatusCode::TOO_MANY_REQUESTS => (
                2,
                "Rate limit reached (HTTP 429). Wait a moment and try again.".to_string(),
            ),
            _ => return,
        };
        if self.reported.fetch_or(flag, Ordering::Relaxed) & flag == 0 {
            let _ = app.emit(
                "stt_connection_status",
                serde_json::json!({
                    "provider": provider,
                    "party": self.party,
                    "status": "error",
                    "message": message,
                }),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn the_rest_deadline_includes_a_stalled_response_body() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                assert!(socket.read_buf(&mut request).await.unwrap() > 0);
            }
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{")
                .await
                .unwrap();
            std::future::pending::<()>().await;
        });
        let error = tokio::time::timeout(REQUEST_TIMEOUT + Duration::from_secs(2), async {
            let response = client()
                .unwrap()
                .get(format!("http://{address}/test"))
                .send()
                .await
                .unwrap();
            response.bytes().await.unwrap_err()
        })
        .await
        .expect("the configured deadline must expire before the outer timeout");
        assert!(error.is_timeout());
        server.abort();
    }
}
