//! OpenAI-compatible `POST {base}/embeddings`.

use serde::Deserialize;
use serde_json::{Map, Value};

use super::{decode_base64_f32, snippet, EmbedError, EmbedKind, EmbedderSettings};

/// `{"model", "input", ["dimensions"], ["encoding_format"]}` over the extra body
/// (which can add fields but never replace the model or the input).
pub fn request_body(s: &EmbedderSettings, inputs: &[String], kind: EmbedKind) -> Value {
    let mut body = match s.extra_body(kind) {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    body.insert("model".into(), Value::String(s.model.clone()));
    body.insert("input".into(), Value::from(inputs.to_vec()));
    if s.request_dimensions {
        if let Some(dims) = s.dimensions {
            body.insert("dimensions".into(), dims.into());
        }
    }
    if s.base64 {
        body.insert("encoding_format".into(), "base64".into());
    }
    Value::Object(body)
}

#[derive(Deserialize)]
struct Response {
    data: Vec<Item>,
}

#[derive(Deserialize)]
struct Item {
    #[serde(default)]
    index: Option<usize>,
    embedding: Embedding,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Embedding {
    Floats(Vec<f32>),
    Base64(String),
}

/// Vectors in input order: items are sorted by `index` (some proxies reorder),
/// which must then be exactly 0..n.
pub fn parse_response(text: &str, expected: usize) -> Result<Vec<Vec<f32>>, EmbedError> {
    let response: Response = serde_json::from_str(text)
        .map_err(|_| EmbedError::BadResponse(format!("no \"data\" list of embeddings in {}", snippet(text))))?;
    let mut items = response.data;
    if items.len() != expected {
        return Err(EmbedError::BadResponse(format!("{} vectors for {expected} inputs", items.len())));
    }
    if items.iter().all(|i| i.index.is_some()) {
        items.sort_by_key(|i| i.index);
        if items.iter().enumerate().any(|(pos, i)| i.index != Some(pos)) {
            return Err(EmbedError::BadResponse("the \"index\" fields are not 0..n".to_string()));
        }
    }
    items
        .into_iter()
        .map(|item| match item.embedding {
            Embedding::Floats(v) => Ok(v),
            Embedding::Base64(s) => decode_base64_f32(&s),
        })
        .collect()
}
