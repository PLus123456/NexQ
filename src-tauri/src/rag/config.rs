use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::net::endpoint::{AuthConfig, CustomHeader};

/// Version of the `rag/config.json` layout (1 was the in-memory upstream
/// config; 3 split at headings by default, see [`load`]).
pub const CONFIG_SCHEMA_VERSION: u32 = 3;

/// RAG pipeline configuration, stored by Rust in `<app data>/rag/config.json`.
///
/// The flat fields are the upstream ones (other modules and the legacy
/// commands read them). `embedding_model`, `ollama_url`, `batch_size` and
/// `embedding_dimensions` are mirrors of the `embedding` section, kept in
/// step by [`RagConfig::normalize`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct RagConfig {
    /// Whether the RAG pipeline is enabled (follows the "local RAG" context strategy).
    pub enabled: bool,
    /// Mirror of `embedding.model`.
    pub embedding_model: String,
    /// Mirror of `embedding.base_url` when the provider is Ollama.
    pub ollama_url: String,
    /// Mirror of `embedding.batch_size`.
    pub batch_size: usize,
    /// Target chunk size in (estimated) tokens.
    pub chunk_size: usize,
    /// Overlap between consecutive chunks in tokens.
    pub chunk_overlap: usize,
    /// Text splitting: "headings" (sections first, see `headings.rs`) or "recursive".
    pub splitting_strategy: String,
    /// Number of top results to return from search.
    pub top_k: usize,
    /// Search mode: "hybrid", "semantic", or "keyword".
    pub search_mode: String,
    /// Upstream relative score cut. Unused by the engine: see `retrieval.min_cosine`.
    pub similarity_threshold: f32,
    /// Weight for semantic search in hybrid mode (0.0–1.0).
    pub semantic_weight: f32,
    /// Whether to index live transcript segments.
    pub include_transcript: bool,
    /// Mirror of `embedding.dimensions` (0 = whatever the model returns).
    pub embedding_dimensions: usize,

    pub schema_version: u32,
    pub embedding: EmbeddingConfig,
    pub retrieval: RetrievalConfig,
    pub indexing: IndexingConfig,
    pub rerank: RerankConfig,
    pub rewrite: QueryRewriteConfig,
    pub expansion: ExpansionConfig,
    pub summaries: SummaryConfig,
}

/// Request protocol of the embedding service.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EmbeddingProvider {
    /// `POST {base}/embeddings` (OpenAI, vLLM, TEI, LocalAI, DashScope, Zhipu, SiliconFlow…).
    #[default]
    OpenaiCompat,
    /// Ollama's native `POST {base}/api/embed`.
    Ollama,
}

impl EmbeddingProvider {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::OpenaiCompat => "openai_compat",
            Self::Ollama => "ollama",
        }
    }
}

/// Embedding service settings. The API key lives in the keychain slot
/// [`EMBEDDING_SECRET_SLOT`]; only `key_saved` / `key_hint` are stored here.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct EmbeddingConfig {
    pub provider: EmbeddingProvider,
    /// Reuse this LLM connection's address, key and headers (empty: own fields).
    pub connection_id: String,
    /// As typed, version prefix included: `/v1` is never added.
    pub base_url: String,
    pub auth: AuthConfig,
    pub headers: Vec<CustomHeader>,
    /// Set by `rag_set_secret` only (incoming patches can't change these two).
    pub key_saved: bool,
    pub key_hint: String,
    pub model: String,
    /// Declared vector size; None = whatever the service returns.
    pub dimensions: Option<u32>,
    /// Send `dimensions` with each request (only models that support it accept it).
    pub request_dimensions: bool,
    /// "float" or "base64" (OpenAI-compatible only).
    pub encoding_format: String,
    pub batch_size: usize,
    /// Concurrent document requests; 0 = auto (4, Ollama 1).
    pub max_concurrency: usize,
    /// Longer inputs are cut to this many estimated tokens; 0 = auto by model.
    pub max_input_tokens: usize,
    /// When true the prefixes come from [`default_prefixes`] for the model.
    pub prefixes_auto: bool,
    pub query_prefix: String,
    pub document_prefix: String,
    /// JSON object merged into query requests (e.g. Jina's `{"task": "retrieval.query"}`).
    pub extra_body_query: Value,
    /// JSON object merged into document requests. Part of the index fingerprint.
    pub extra_body_document: Value,
    pub request_timeout_secs: u64,
    /// Budget for embedding a search query; past it the search falls back to keywords.
    pub query_timeout_secs: u64,
}

impl Default for EmbeddingConfig {
    fn default() -> Self {
        Self {
            provider: EmbeddingProvider::OpenaiCompat,
            connection_id: String::new(),
            base_url: String::new(),
            auth: AuthConfig {
                mode: crate::net::endpoint::AuthMode::Bearer,
                ..AuthConfig::default()
            },
            headers: Vec::new(),
            key_saved: false,
            key_hint: String::new(),
            model: String::new(),
            dimensions: None,
            request_dimensions: false,
            encoding_format: "float".to_string(),
            batch_size: 32,
            max_concurrency: 0,
            max_input_tokens: 0,
            prefixes_auto: true,
            query_prefix: String::new(),
            document_prefix: String::new(),
            extra_body_query: Value::Object(Default::default()),
            extra_body_document: Value::Object(Default::default()),
            request_timeout_secs: 60,
            query_timeout_secs: 5,
        }
    }
}

/// Search tuning.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct RetrievalConfig {
    /// Candidates taken from each path (vector, keyword) before fusion.
    pub depth: usize,
    /// Reciprocal rank fusion constant.
    pub rrf_k: f64,
    /// Vector hits below this cosine are dropped (0 = off).
    pub min_cosine: f32,
    /// Keyword terms kept from a query (the question part comes first).
    pub max_query_terms: usize,
}

impl Default for RetrievalConfig {
    fn default() -> Self {
        Self { depth: 100, rrf_k: 60.0, min_cosine: 0.0, max_query_terms: 48 }
    }
}

/// Background indexing.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct IndexingConfig {
    /// Index added or changed documents automatically while RAG is enabled.
    pub auto_index: bool,
    /// Larger files are skipped (MB).
    pub max_file_mb: u64,
    /// Text extraction of one file gives up after this long.
    pub extract_timeout_secs: u64,
    /// During a meeting: "pause_local" (pause a local Ollama, one request at a
    /// time for a remote service), "slow" (one request at a time), "normal".
    pub meeting_mode: String,
}

impl Default for IndexingConfig {
    fn default() -> Self {
        Self {
            auto_index: true,
            max_file_mb: 50,
            extract_timeout_secs: 120,
            meeting_mode: "pause_local".to_string(),
        }
    }
}

/// Optional reranking of the fused candidates (generic `/rerank` API).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct RerankConfig {
    pub enabled: bool,
    pub connection_id: String,
    pub base_url: String,
    pub auth: AuthConfig,
    pub headers: Vec<CustomHeader>,
    pub key_saved: bool,
    pub key_hint: String,
    pub model: String,
    /// "generic" (`documents`, Jina / Cohere / SiliconFlow / vLLM) or "tei" (`texts`).
    pub format: String,
    /// Fused candidates sent for reranking.
    pub candidates: usize,
    pub timeout_ms: u64,
}

impl Default for RerankConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            connection_id: String::new(),
            base_url: String::new(),
            auth: AuthConfig {
                mode: crate::net::endpoint::AuthMode::Bearer,
                ..AuthConfig::default()
            },
            headers: Vec::new(),
            key_saved: false,
            key_hint: String::new(),
            model: String::new(),
            format: "generic".to_string(),
            candidates: 30,
            timeout_ms: 2500,
        }
    }
}

/// Other phrasings of the question searched along with it (one LLM call per
/// search, task `rag_query_rewrite`), their result lists fused by RRF.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct QueryRewriteConfig {
    pub enabled: bool,
    /// Phrasings asked for (1–5).
    pub variants: usize,
    /// Past this the search goes on with the question alone.
    pub timeout_ms: u64,
}

impl Default for QueryRewriteConfig {
    fn default() -> Self {
        Self { enabled: false, variants: 3, timeout_ms: 5000 }
    }
}

/// What a search result brings along: its neighbouring chunks, or its whole
/// section when that is short enough. Results from the same document that
/// meet are merged into one passage.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ExpansionConfig {
    pub enabled: bool,
    /// Chunks taken on each side of a hit (0–5).
    pub neighbors: usize,
    /// The hit's section, or the largest enclosing one, is returned whole
    /// (instead of the neighbours) up to this many tokens (0: never).
    pub section_max_tokens: usize,
    /// All passages of one search together; past it hits stay unexpanded.
    pub max_total_tokens: usize,
}

impl Default for ExpansionConfig {
    fn default() -> Self {
        Self { enabled: true, neighbors: 1, section_max_tokens: 2000, max_total_tokens: 16000 }
    }
}

/// One LLM summary per chapter, written at index time (task `rag_summary`),
/// stored and searched like a chunk of its chapter. Needs heading splitting.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct SummaryConfig {
    pub enabled: bool,
    /// Longest chapter text sent (tokens); the rest of a longer chapter is left out.
    pub max_input_tokens: usize,
    /// One summary request gives up after this long.
    pub timeout_secs: u64,
}

impl Default for SummaryConfig {
    fn default() -> Self {
        Self { enabled: false, max_input_tokens: 32000, timeout_secs: 180 }
    }
}

/// Keychain slot of the embedding API key.
pub const EMBEDDING_SECRET_SLOT: &str = "rag-embedding";
/// Keychain slot of the rerank API key.
pub const RERANK_SECRET_SLOT: &str = "rag-rerank";

impl Default for RagConfig {
    fn default() -> Self {
        let embedding = EmbeddingConfig::default();
        let mut config = Self {
            enabled: false,
            embedding_model: String::new(),
            ollama_url: "http://localhost:11434".to_string(),
            batch_size: embedding.batch_size,
            chunk_size: 512,
            chunk_overlap: 64,
            splitting_strategy: super::chunker::STRATEGY_HEADINGS.to_string(),
            top_k: 5,
            search_mode: "hybrid".to_string(),
            similarity_threshold: 0.3,
            semantic_weight: 0.7,
            include_transcript: false,
            embedding_dimensions: 0,
            schema_version: CONFIG_SCHEMA_VERSION,
            embedding,
            retrieval: RetrievalConfig::default(),
            indexing: IndexingConfig::default(),
            rerank: RerankConfig::default(),
            rewrite: QueryRewriteConfig::default(),
            expansion: ExpansionConfig::default(),
            summaries: SummaryConfig::default(),
        };
        config.normalize();
        config
    }
}

impl RagConfig {
    /// Clamps values into range and refreshes the legacy mirrors.
    pub fn normalize(&mut self) {
        self.schema_version = CONFIG_SCHEMA_VERSION;
        self.chunk_size = self.chunk_size.clamp(64, 8192);
        if self.chunk_overlap >= self.chunk_size {
            self.chunk_overlap = self.chunk_size / 4;
        }
        self.top_k = self.top_k.clamp(1, 100);
        if !matches!(self.search_mode.as_str(), "hybrid" | "semantic" | "keyword") {
            self.search_mode = "hybrid".to_string();
        }
        if !matches!(
            self.splitting_strategy.as_str(),
            super::chunker::STRATEGY_HEADINGS | super::chunker::STRATEGY_RECURSIVE
        ) {
            self.splitting_strategy = super::chunker::STRATEGY_HEADINGS.to_string();
        }
        if !self.semantic_weight.is_finite() {
            self.semantic_weight = 0.7;
        }
        self.semantic_weight = self.semantic_weight.clamp(0.0, 1.0);

        let e = &mut self.embedding;
        e.base_url = e.base_url.trim().to_string();
        e.model = e.model.trim().to_string();
        e.connection_id = e.connection_id.trim().to_string();
        e.batch_size = e.batch_size.clamp(1, 2048);
        e.max_concurrency = e.max_concurrency.min(16);
        e.request_timeout_secs = e.request_timeout_secs.clamp(1, 600);
        e.query_timeout_secs = e.query_timeout_secs.clamp(1, 120);
        if e.dimensions == Some(0) {
            e.dimensions = None;
        }
        if !matches!(e.encoding_format.as_str(), "float" | "base64") {
            e.encoding_format = "float".to_string();
        }
        for body in [&mut e.extra_body_query, &mut e.extra_body_document] {
            if !body.is_object() {
                *body = Value::Object(Default::default());
            }
        }

        let r = &mut self.retrieval;
        r.depth = r.depth.clamp(10, 1000);
        if !(r.rrf_k.is_finite() && r.rrf_k > 0.0) {
            r.rrf_k = 60.0;
        }
        if !r.min_cosine.is_finite() {
            r.min_cosine = 0.0;
        }
        r.min_cosine = r.min_cosine.clamp(-1.0, 1.0);
        r.max_query_terms = r.max_query_terms.clamp(4, 256);

        let ix = &mut self.indexing;
        ix.max_file_mb = ix.max_file_mb.clamp(1, 2048);
        ix.extract_timeout_secs = ix.extract_timeout_secs.clamp(5, 3600);
        if !matches!(ix.meeting_mode.as_str(), "pause_local" | "slow" | "normal") {
            ix.meeting_mode = "pause_local".to_string();
        }

        let rr = &mut self.rerank;
        rr.base_url = rr.base_url.trim().to_string();
        rr.model = rr.model.trim().to_string();
        rr.candidates = rr.candidates.clamp(2, 200);
        rr.timeout_ms = rr.timeout_ms.clamp(200, 60_000);
        if !matches!(rr.format.as_str(), "generic" | "tei") {
            rr.format = "generic".to_string();
        }

        let rw = &mut self.rewrite;
        rw.variants = rw.variants.clamp(1, 5);
        rw.timeout_ms = rw.timeout_ms.clamp(500, 60_000);

        let ex = &mut self.expansion;
        ex.neighbors = ex.neighbors.min(5);
        ex.section_max_tokens = ex.section_max_tokens.min(32_000);
        ex.max_total_tokens = ex.max_total_tokens.clamp(1000, 200_000);

        let su = &mut self.summaries;
        su.max_input_tokens = su.max_input_tokens.clamp(2000, 200_000);
        su.timeout_secs = su.timeout_secs.clamp(10, 1800);

        self.embedding_model = self.embedding.model.clone();
        self.batch_size = self.embedding.batch_size;
        self.embedding_dimensions = self.embedding.dimensions.unwrap_or(0) as usize;
        if self.embedding.provider == EmbeddingProvider::Ollama {
            self.ollama_url = self.embedding.base_url.clone();
        }
    }

    /// Applies a JSON merge patch (RFC 7386: objects merge, `null` resets a
    /// field to its default, other values replace) and normalizes.
    ///
    /// Legacy flat fields (`embedding_model`, `ollama_url`, `batch_size`,
    /// `embedding_dimensions`) in the patch are mapped into `embedding` when
    /// they differ from the current mirrors, so a client that still sends
    /// the whole upstream object never resets the newer settings. The stored
    /// key status can't be patched.
    pub fn apply_patch(&self, patch: &Value) -> Result<RagConfig, String> {
        let Value::Object(patch) = patch else {
            return Err("RAG config patch must be a JSON object".to_string());
        };
        let mut patch = patch.clone();
        let mut base = serde_json::to_value(self).map_err(|e| e.to_string())?;

        let mut embedding_patch = match patch.remove("embedding") {
            Some(Value::Object(map)) => map,
            Some(Value::Null) | None => Default::default(),
            Some(_) => return Err("\"embedding\" must be an object".to_string()),
        };
        if let Some(Value::String(model)) = patch.get("embedding_model") {
            if *model != self.embedding_model && !embedding_patch.contains_key("model") {
                embedding_patch.insert("model".into(), Value::String(model.clone()));
            }
        }
        if let Some(Value::String(url)) = patch.get("ollama_url") {
            if *url != self.ollama_url && !embedding_patch.contains_key("base_url") {
                embedding_patch.insert("provider".into(), Value::String("ollama".into()));
                embedding_patch.insert("base_url".into(), Value::String(url.clone()));
            }
        }
        if let Some(batch) = patch.get("batch_size").and_then(Value::as_u64) {
            if batch as usize != self.batch_size && !embedding_patch.contains_key("batch_size") {
                embedding_patch.insert("batch_size".into(), batch.into());
            }
        }
        if let Some(dims) = patch.get("embedding_dimensions").and_then(Value::as_u64) {
            if dims as usize != self.embedding_dimensions && !embedding_patch.contains_key("dimensions") {
                let value = if dims == 0 { Value::Null } else { dims.into() };
                embedding_patch.insert("dimensions".into(), value);
            }
        }
        for mirror in ["embedding_model", "ollama_url", "batch_size", "embedding_dimensions", "schema_version"] {
            patch.remove(mirror);
        }
        for status in ["key_saved", "key_hint"] {
            embedding_patch.remove(status);
        }
        if let Some(Value::Object(rerank)) = patch.get_mut("rerank") {
            rerank.remove("key_saved");
            rerank.remove("key_hint");
        }
        if !embedding_patch.is_empty() {
            patch.insert("embedding".into(), Value::Object(embedding_patch));
        }

        merge_patch(&mut base, &Value::Object(patch), &serde_json::to_value(RagConfig::default()).map_err(|e| e.to_string())?);
        let mut next: RagConfig =
            serde_json::from_value(base).map_err(|e| format!("Invalid RAG config: {e}"))?;
        next.normalize();
        Ok(next)
    }

    /// The prefixes actually sent: the presets for the model, or the user's.
    pub fn effective_prefixes(&self) -> (String, String) {
        if self.embedding.prefixes_auto {
            let (q, d) = default_prefixes(&self.embedding.model);
            (q.to_string(), d.to_string())
        } else {
            (self.embedding.query_prefix.clone(), self.embedding.document_prefix.clone())
        }
    }

    /// The input cap actually used.
    pub fn effective_max_input_tokens(&self) -> usize {
        if self.embedding.max_input_tokens > 0 {
            self.embedding.max_input_tokens
        } else {
            default_max_input_tokens(&self.embedding.model)
        }
    }

    /// The document-request concurrency actually used.
    pub fn effective_concurrency(&self) -> usize {
        match (self.embedding.max_concurrency, self.embedding.provider) {
            (0, EmbeddingProvider::Ollama) => 1,
            (0, EmbeddingProvider::OpenaiCompat) => 4,
            (n, _) => n,
        }
    }

    /// About the most document text one search brings back (tokens): the
    /// expanded passages' budget, or `top_k` plain chunks when that is more.
    pub fn retrieved_tokens_max(&self) -> usize {
        let chunks = self.top_k * self.chunk_size;
        if self.expansion.enabled {
            chunks.max(self.expansion.max_total_tokens)
        } else {
            chunks
        }
    }

    /// Enough to send requests: a model and (unless an LLM connection is reused) a base URL.
    pub fn embedding_configured(&self) -> bool {
        !self.embedding.model.is_empty()
            && (!self.embedding.base_url.is_empty() || !self.embedding.connection_id.is_empty())
    }

    /// Identity of the vector space this config produces, before the
    /// measured vector size is known: provider, model, document prefix,
    /// document extra body and the requested size. The address, key, batch
    /// size and query prefix are left out: changing them needs no rebuild.
    pub fn space_key(&self) -> String {
        let (_, doc_prefix) = self.effective_prefixes();
        let descriptor = serde_json::json!({
            "v": 1,
            "provider": self.embedding.provider.as_str(),
            "model": self.embedding.model,
            "document_prefix": doc_prefix,
            "extra_body_document": canonical_json(&self.embedding.extra_body_document),
            "dimensions": if self.embedding.request_dimensions { self.embedding.dimensions } else { None },
        });
        let mut hasher = Sha256::new();
        hasher.update(descriptor.to_string().as_bytes());
        hex(&hasher.finalize())
    }

    /// Chunking identity of a document: re-chunked when this changes.
    /// Chapter summaries are part of it, so turning them on or off asks for
    /// a rebuild (and a document whose summaries failed stays due for one).
    pub fn chunk_params(&self) -> String {
        let mut params = format!(
            "v{}:{}:{}:{}",
            super::chunker::CHUNKER_VERSION,
            self.chunk_size,
            self.chunk_overlap,
            self.splitting_strategy
        );
        if self.summaries_active() {
            params.push_str(":summaries");
        }
        params
    }

    /// Chapter summaries are written: on, and chapters are known (heading splitting).
    pub fn summaries_active(&self) -> bool {
        self.summaries.enabled && self.splitting_strategy == super::chunker::STRATEGY_HEADINGS
    }

    /// Changes a config stored by an older version: version 3 made heading
    /// splitting the default, and the only older strategy was "recursive".
    fn migrate(&mut self) {
        if self.schema_version < 3 && self.splitting_strategy == super::chunker::STRATEGY_RECURSIVE {
            self.splitting_strategy = super::chunker::STRATEGY_HEADINGS.to_string();
        }
    }
}

/// Free-form JSON fields: a patch replaces them instead of merging into them.
const REPLACED_WHOLE: &[&str] = &["extra_body_query", "extra_body_document"];

/// RFC 7386 merge; `null` resets to the value at the same path in `defaults`.
fn merge_patch(target: &mut Value, patch: &Value, defaults: &Value) {
    let Value::Object(patch) = patch else {
        *target = patch.clone();
        return;
    };
    if !target.is_object() {
        *target = Value::Object(Default::default());
    }
    let target = target.as_object_mut().expect("object");
    for (key, value) in patch {
        let default = defaults.get(key).unwrap_or(&Value::Null);
        if value.is_null() {
            if default.is_null() {
                target.remove(key);
            } else {
                target.insert(key.clone(), default.clone());
            }
        } else if value.is_object() && default.is_object() && !REPLACED_WHOLE.contains(&key.as_str()) {
            let entry = target.entry(key.clone()).or_insert(Value::Null);
            merge_patch(entry, value, default);
        } else {
            target.insert(key.clone(), value.clone());
        }
    }
}

/// JSON with object keys sorted, so equal objects hash equally.
fn canonical_json(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let mut out = serde_json::Map::new();
            for k in keys {
                out.insert(k.clone(), canonical_json(&map[k]));
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(canonical_json).collect()),
        other => other.clone(),
    }
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Query and document prefixes that models expect, by model name.
pub fn default_prefixes(model: &str) -> (&'static str, &'static str) {
    let m = model.to_ascii_lowercase();
    if m.contains("nomic-embed") {
        ("search_query: ", "search_document: ")
    } else if m.contains("bge-m3") {
        ("", "")
    } else if m.contains("bge") && m.contains("zh") {
        ("为这个句子生成表示以用于检索相关文章：", "")
    } else if m.contains("bge") && (m.contains("en") || m.contains("large") || m.contains("base") || m.contains("small")) {
        ("Represent this sentence for searching relevant passages: ", "")
    } else if m.contains("mxbai-embed") {
        ("Represent this sentence for searching relevant passages: ", "")
    } else if m.contains("e5") && !m.contains("instruct") {
        ("query: ", "passage: ")
    } else if m.contains("qwen3-embedding") || (m.contains("e5") && m.contains("instruct")) {
        (
            "Instruct: Given a question, retrieve passages that answer the question\nQuery: ",
            "",
        )
    } else {
        ("", "")
    }
}

/// Input caps of common models (estimated tokens), 2048 when unknown.
pub fn default_max_input_tokens(model: &str) -> usize {
    let m = model.to_ascii_lowercase();
    if m.contains("all-minilm") {
        256
    } else if m.contains("bge-m3") || m.contains("qwen3-embedding") || m.contains("jina") || m.contains("text-embedding-3") || m.contains("text-embedding-ada") {
        8000
    } else if m.contains("bge") || m.contains("e5") || m.contains("mxbai") || m.contains("gte") {
        512
    } else {
        2048
    }
}

/// Reads the stored config; missing → defaults; unreadable → defaults, and
/// the bad file is kept next to it as `config.json.bad` for inspection.
pub fn load(path: &Path) -> RagConfig {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return RagConfig::default(),
        Err(e) => {
            log::warn!("RAG config unreadable ({}), using defaults: {e}", path.display());
            return RagConfig::default();
        }
    };
    match serde_json::from_str::<RagConfig>(&text) {
        Ok(mut config) => {
            config.migrate();
            config.normalize();
            config
        }
        Err(e) => {
            log::warn!("RAG config invalid ({}), using defaults: {e}", path.display());
            let _ = std::fs::rename(path, path.with_extension("json.bad"));
            RagConfig::default()
        }
    }
}

/// Writes the config atomically (temp file + rename), keeping the previous
/// version as `config.json.bak`.
pub fn save(path: &Path, config: &RagConfig) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;
    }
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("Cannot write {}: {e}", tmp.display()))?;
    if path.exists() {
        let _ = std::fs::copy(path, path.with_extension("json.bak"));
    }
    std::fs::rename(&tmp, path).map_err(|e| format!("Cannot replace {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("nexq-rag-config-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn defaults_are_normalized_and_unconfigured() {
        let c = RagConfig::default();
        assert_eq!(c.schema_version, CONFIG_SCHEMA_VERSION);
        assert!(!c.include_transcript);
        assert!(!c.embedding_configured());
        assert_eq!(c.effective_concurrency(), 4);
        assert_eq!(c.chunk_params(), format!("v{}:512:64:headings", super::super::chunker::CHUNKER_VERSION));
        assert!(!c.rewrite.enabled && !c.summaries.enabled, "LLM calls are opt-in");
        assert!(c.expansion.enabled);
    }

    #[test]
    fn patch_merges_nested_objects_and_null_resets() {
        let c = RagConfig::default();
        let c = c
            .apply_patch(&json!({"top_k": 9, "embedding": {"base_url": " https://api.example.com/v4 ", "model": "bge-m3"}}))
            .unwrap();
        assert_eq!(c.top_k, 9);
        assert_eq!(c.embedding.base_url, "https://api.example.com/v4");
        assert_eq!(c.embedding.model, "bge-m3");
        assert_eq!(c.embedding_model, "bge-m3", "legacy mirror follows");
        assert_eq!(c.embedding.batch_size, 32, "untouched nested field kept");
        let c = c.apply_patch(&json!({"embedding": {"model": null}, "top_k": null})).unwrap();
        assert_eq!(c.embedding.model, "");
        assert_eq!(c.top_k, 5);
        assert_eq!(c.embedding.base_url, "https://api.example.com/v4");
    }

    #[test]
    fn a_whole_upstream_config_does_not_reset_new_fields() {
        let c = RagConfig::default()
            .apply_patch(&json!({"embedding": {"provider": "openai_compat", "base_url": "http://10.0.0.5:8000/v1", "model": "bge-m3", "dimensions": 1024}}))
            .unwrap();
        // The old settings page sends every flat field back, mirrors unchanged.
        let mut upstream = serde_json::to_value(&c).unwrap();
        let upstream = upstream.as_object_mut().unwrap();
        upstream.retain(|k, _| !["embedding", "retrieval", "indexing", "rerank", "schema_version"].contains(&k.as_str()));
        upstream.insert("top_k".into(), json!(7));
        let next = c.apply_patch(&Value::Object(upstream.clone())).unwrap();
        assert_eq!(next.top_k, 7);
        assert_eq!(next.embedding.base_url, "http://10.0.0.5:8000/v1");
        assert_eq!(next.embedding.dimensions, Some(1024));
        assert_eq!(next.embedding.provider, EmbeddingProvider::OpenaiCompat);
    }

    #[test]
    fn changed_legacy_fields_map_into_embedding() {
        let c = RagConfig::default()
            .apply_patch(&json!({"embedding_model": "mxbai-embed-large", "ollama_url": "http://localhost:11500", "embedding_dimensions": 1024, "batch_size": 8}))
            .unwrap();
        assert_eq!(c.embedding.model, "mxbai-embed-large");
        assert_eq!(c.embedding.provider, EmbeddingProvider::Ollama);
        assert_eq!(c.embedding.base_url, "http://localhost:11500");
        assert_eq!(c.embedding.dimensions, Some(1024));
        assert_eq!(c.embedding.batch_size, 8);
        assert_eq!(c.ollama_url, "http://localhost:11500");
        assert_eq!(c.effective_concurrency(), 1);
    }

    #[test]
    fn key_status_cannot_be_patched() {
        let mut c = RagConfig::default();
        c.embedding.key_saved = true;
        c.embedding.key_hint = "ab12".into();
        let next = c.apply_patch(&json!({"embedding": {"key_saved": false, "key_hint": "zzzz"}, "rerank": {"key_saved": true}})).unwrap();
        assert!(next.embedding.key_saved);
        assert_eq!(next.embedding.key_hint, "ab12");
        assert!(!next.rerank.key_saved);
    }

    #[test]
    fn patch_rejects_non_objects_and_bad_types() {
        let c = RagConfig::default();
        assert!(c.apply_patch(&json!([1])).is_err());
        assert!(c.apply_patch(&json!({"embedding": 3})).is_err());
        assert!(c.apply_patch(&json!({"top_k": "many"})).is_err());
    }

    #[test]
    fn values_are_clamped() {
        let c = RagConfig::default()
            .apply_patch(&json!({"chunk_size": 10, "chunk_overlap": 500, "semantic_weight": 3.0, "search_mode": "magic", "embedding": {"dimensions": 0, "encoding_format": "hex", "extra_body_query": [1]}}))
            .unwrap();
        assert_eq!(c.chunk_size, 64);
        assert_eq!(c.chunk_overlap, 16);
        assert_eq!(c.semantic_weight, 1.0);
        assert_eq!(c.search_mode, "hybrid");
        assert_eq!(c.embedding.dimensions, None);
        assert_eq!(c.embedding.encoding_format, "float");
        assert!(c.embedding.extra_body_query.is_object());
    }

    #[test]
    fn space_key_ignores_address_key_batch_and_query_prefix() {
        let base = RagConfig::default()
            .apply_patch(&json!({"embedding": {"base_url": "https://a.example/v1", "model": "text-embedding-3-small"}}))
            .unwrap();
        let key = base.space_key();
        for patch in [
            json!({"embedding": {"base_url": "https://b.example/v1"}}),
            json!({"embedding": {"batch_size": 8, "max_concurrency": 2}}),
            json!({"embedding": {"prefixes_auto": false, "query_prefix": "q: "}}),
            json!({"embedding": {"dimensions": 256}}), // not sent → same vectors
            json!({"embedding": {"extra_body_query": {"task": "x"}}}),
        ] {
            assert_eq!(base.apply_patch(&patch).unwrap().space_key(), key, "{patch}");
        }
        for patch in [
            json!({"embedding": {"model": "text-embedding-3-large"}}),
            json!({"embedding": {"provider": "ollama"}}),
            json!({"embedding": {"prefixes_auto": false, "document_prefix": "passage: "}}),
            json!({"embedding": {"dimensions": 256, "request_dimensions": true}}),
            json!({"embedding": {"extra_body_document": {"task": "retrieval.passage"}}}),
        ] {
            assert_ne!(base.apply_patch(&patch).unwrap().space_key(), key, "{patch}");
        }
        // Key order inside the extra body does not matter.
        let a = base.apply_patch(&json!({"embedding": {"extra_body_document": {"a": 1, "b": 2}}})).unwrap();
        let b = base.apply_patch(&json!({"embedding": {"extra_body_document": {"b": 2, "a": 1}}})).unwrap();
        assert_eq!(a.space_key(), b.space_key());
        // A patched extra body replaces the old one (a removed key is gone).
        let c = a.apply_patch(&json!({"embedding": {"extra_body_document": {"b": 2}}})).unwrap();
        assert_eq!(c.embedding.extra_body_document, json!({"b": 2}));
    }

    #[test]
    fn prefixes_follow_the_model_until_edited() {
        let c = RagConfig::default().apply_patch(&json!({"embedding": {"model": "nomic-embed-text"}})).unwrap();
        assert_eq!(c.effective_prefixes(), ("search_query: ".into(), "search_document: ".into()));
        let c = c.apply_patch(&json!({"embedding": {"model": "BAAI/bge-large-zh-v1.5"}})).unwrap();
        assert_eq!(c.effective_prefixes().1, "");
        assert!(c.effective_prefixes().0.starts_with("为这个句子"));
        let c = c.apply_patch(&json!({"embedding": {"prefixes_auto": false, "query_prefix": "Q: ", "document_prefix": "D: "}})).unwrap();
        assert_eq!(c.effective_prefixes(), ("Q: ".into(), "D: ".into()));
        assert_eq!(default_prefixes("bge-m3"), ("", ""));
        assert_eq!(default_prefixes("text-embedding-3-small"), ("", ""));
        assert_eq!(default_prefixes("intfloat/multilingual-e5-large").1, "passage: ");
    }

    #[test]
    fn save_and_load_round_trip_and_survive_garbage() {
        let dir = temp_dir("roundtrip");
        let path = dir.join("rag").join("config.json");
        assert_eq!(load(&path), RagConfig::default(), "missing file → defaults");
        let c = RagConfig::default().apply_patch(&json!({"top_k": 11, "embedding": {"model": "bge-m3"}})).unwrap();
        save(&path, &c).unwrap();
        assert_eq!(load(&path), c);
        save(&path, &c.apply_patch(&json!({"top_k": 12})).unwrap()).unwrap();
        assert!(path.with_extension("json.bak").exists());
        std::fs::write(&path, "{not json").unwrap();
        assert_eq!(load(&path), RagConfig::default());
        assert!(path.with_extension("json.bad").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_older_stored_config_switches_to_heading_splitting_once() {
        let dir = temp_dir("migrate");
        let path = dir.join("config.json");
        std::fs::write(&path, r#"{"schema_version": 2, "splitting_strategy": "recursive", "chunk_size": 600}"#).unwrap();
        let c = load(&path);
        assert_eq!(c.splitting_strategy, "headings");
        assert_eq!(c.schema_version, CONFIG_SCHEMA_VERSION);
        // A choice made with this version stays.
        let c = c.apply_patch(&json!({"splitting_strategy": "recursive"})).unwrap();
        save(&path, &c).unwrap();
        assert_eq!(load(&path).splitting_strategy, "recursive");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn retrieval_extras_are_clamped_and_summaries_need_headings() {
        let c = RagConfig::default()
            .apply_patch(&json!({
                "splitting_strategy": "magic",
                "rewrite": {"enabled": true, "variants": 9, "timeout_ms": 1},
                "expansion": {"neighbors": 50, "max_total_tokens": 10},
                "summaries": {"enabled": true, "max_input_tokens": 1}
            }))
            .unwrap();
        assert_eq!(c.splitting_strategy, "headings");
        assert_eq!((c.rewrite.variants, c.rewrite.timeout_ms), (5, 500));
        assert_eq!((c.expansion.neighbors, c.expansion.max_total_tokens), (5, 1000));
        assert_eq!(c.expansion.section_max_tokens, 2000, "untouched field kept");
        assert_eq!(c.summaries.max_input_tokens, 2000);
        assert!(c.summaries_active());
        assert!(c.chunk_params().ends_with(":headings:summaries"));
        let plain = c.apply_patch(&json!({"splitting_strategy": "recursive"})).unwrap();
        assert!(!plain.summaries_active());
        assert!(plain.chunk_params().ends_with(":recursive"));
    }

    #[test]
    fn a_partial_stored_file_gets_defaults_for_the_rest() {
        let dir = temp_dir("partial");
        let path = dir.join("config.json");
        std::fs::write(&path, r#"{"top_k": 3, "embedding": {"model": "m"}}"#).unwrap();
        let c = load(&path);
        assert_eq!(c.top_k, 3);
        assert_eq!(c.embedding.model, "m");
        assert_eq!(c.embedding.batch_size, 32);
        assert_eq!(c.retrieval.depth, 100);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
