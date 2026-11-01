//! Ollama's native `POST {base}/api/embed`.

use serde::Deserialize;
use serde_json::{Map, Value};

use super::{snippet, EmbedError, EmbedKind, EmbedderSettings};

/// Path appended to the Ollama base URL (the host, not an OpenAI-style `/v1`).
pub const EMBED_PATH: &str = "/api/embed";

/// `{"model", "input", "truncate": true, "keep_alive"}` over the extra body.
pub fn request_body(s: &EmbedderSettings, inputs: &[String], kind: EmbedKind) -> Value {
    let mut body = match s.extra_body(kind) {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    body.insert("model".into(), Value::String(s.model.clone()));
    body.insert("input".into(), Value::from(inputs.to_vec()));
    body.entry("truncate").or_insert(Value::Bool(true));
    body.entry("keep_alive").or_insert(Value::String("10m".into()));
    if s.request_dimensions {
        if let Some(dims) = s.dimensions {
            body.insert("dimensions".into(), dims.into());
        }
    }
    Value::Object(body)
}

#[derive(Deserialize)]
struct Response {
    embeddings: Vec<Vec<f32>>,
}

pub fn parse_response(text: &str, expected: usize) -> Result<Vec<Vec<f32>>, EmbedError> {
    let response: Response = serde_json::from_str(text)
        .map_err(|_| EmbedError::BadResponse(format!("no \"embeddings\" list in {}", snippet(text))))?;
    if response.embeddings.len() != expected {
        return Err(EmbedError::BadResponse(format!(
            "{} vectors for {expected} inputs",
            response.embeddings.len()
        )));
    }
    Ok(response.embeddings)
}
