// Knowledge base (RAG) settings and index types. JSON shapes match the Rust
// side (src-tauri/src/rag/{config,engine,indexer}.rs, snake_case).

import type { AuthConfig, CustomHeader } from "../endpoint";
import type { RagConfig } from "../types";

export type EmbeddingProvider = "openai_compat" | "ollama";

export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  /** Reuse this LLM connection's address, key and headers ("" = own fields). */
  connection_id: string;
  base_url: string;
  auth: AuthConfig;
  headers: CustomHeader[];
  /** Read-only: set by rag_set_secret. */
  key_saved: boolean;
  key_hint: string;
  model: string;
  /** null = whatever the service returns. */
  dimensions: number | null;
  request_dimensions: boolean;
  encoding_format: "float" | "base64";
  batch_size: number;
  /** 0 = auto (4, Ollama 1). */
  max_concurrency: number;
  /** 0 = auto by model. */
  max_input_tokens: number;
  prefixes_auto: boolean;
  query_prefix: string;
  document_prefix: string;
  extra_body_query: Record<string, unknown>;
  extra_body_document: Record<string, unknown>;
  request_timeout_secs: number;
  query_timeout_secs: number;
}

export interface RetrievalConfig {
  depth: number;
  rrf_k: number;
  /** Vector hits below this cosine are dropped (0 = off). */
  min_cosine: number;
  max_query_terms: number;
}

export interface IndexingConfig {
  auto_index: boolean;
  max_file_mb: number;
  extract_timeout_secs: number;
  meeting_mode: "pause_local" | "slow" | "normal";
}

/** "generic": `{model, query, documents, top_n}` (Jina, Cohere, SiliconFlow, vLLM…); "tei": `{query, texts}`. */
export type RerankFormat = "generic" | "tei";

export interface RerankConfig {
  enabled: boolean;
  /** Reuse this LLM connection's address, key and headers ("" = own fields). */
  connection_id: string;
  base_url: string;
  auth: AuthConfig;
  headers: CustomHeader[];
  /** Read-only: set by rag_set_rerank_secret. */
  key_saved: boolean;
  key_hint: string;
  model: string;
  format: RerankFormat;
  /** Fused results sent for reranking (2–200; at least top-K are sent). */
  candidates: number;
  /** Past this the fusion order is kept (200–60000). */
  timeout_ms: number;
}

/** The stored config: the upstream flat fields plus the NexQ Plus sections. */
export interface RagFullConfig extends RagConfig {
  schema_version: number;
  embedding: EmbeddingConfig;
  retrieval: RetrievalConfig;
  indexing: IndexingConfig;
  rerank: RerankConfig;
}

/** A JSON merge patch of the config (nested objects merge; null resets a field). */
export type RagConfigPatch = {
  [K in keyof RagFullConfig]?: RagFullConfig[K] extends object
    ? RagFullConfig[K] extends unknown[]
      ? RagFullConfig[K]
      : Partial<RagFullConfig[K]> | null
    : RagFullConfig[K] | null;
};

/** An LLM connection embeddings and rerank can reuse (no secrets). */
export interface RagConnectionSummary {
  id: string;
  name: string;
  kind: string;
  base_url: string;
}

export interface RagSettingsView {
  config: RagFullConfig;
  effective: {
    query_prefix: string;
    document_prefix: string;
    max_input_tokens: number;
    concurrency: number;
  };
  connections: RagConnectionSummary[];
}

export type VectorState = "unconfigured" | "empty" | "loading" | "ready" | "stale" | "unavailable";

export type RebuildReason = "model_changed" | "chunking_changed" | "dimensions_changed";

export type IndexStatusName =
  | "scanning"
  | "extracting"
  | "embedding"
  | "paused"
  | "file_complete"
  | "complete"
  | "cancelled"
  | "error";

/** `rag_index_progress` payload. */
export interface IndexProgressEvent {
  status: IndexStatusName | string;
  job_id?: number;
  file_id?: string | null;
  file_name?: string | null;
  files_total?: number;
  files_done?: number;
  chunks_total?: number;
  chunks_done?: number;
  chunks_reused?: number;
  errors?: number;
  message?: string | null;
}

export interface FileFailure {
  resource_id: string;
  name: string;
  error: string;
}

export interface JobSummary {
  files_total: number;
  files_done: number;
  files_skipped: number;
  files_failed: number;
  files_removed: number;
  chunks_inserted: number;
  chunks_removed: number;
  chunks_kept: number;
  vectors_reused: number;
  vectors_embedded: number;
  switched_space: boolean;
  cancelled: boolean;
  error: string | null;
  error_kind: string | null;
  failures: FileFailure[];
}

export interface IndexInfo {
  enabled: boolean;
  documents: number;
  documents_indexed: number;
  documents_error: number;
  chunks: number;
  tokens: number;
  vectors: number;
  pending_vectors: number;
  stale_documents: number;
  needs_rebuild: boolean;
  rebuild_reasons: RebuildReason[];
  vector_state: VectorState;
  embedding_configured: boolean;
  active_space: { provider: string; model: string; dims: number; created_at_ms: number } | null;
  memory_bytes: number;
  last_indexed_at: string | null;
  job: IndexProgressEvent | null;
  last_job: JobSummary | null;
  last_error: { message: string; kind: string; at_ms: number } | null;
  store_error: string | null;
}

export interface EmbedTestResult {
  ok: boolean;
  url: string;
  latency_ms: number;
  dims: number | null;
  dimensions_respected: boolean | null;
  error: string | null;
  error_kind: string | null;
  /** "add_v1": the same address with /v1 answered. */
  hint: string | null;
}

export interface RerankTestResult {
  ok: boolean;
  url: string;
  latency_ms: number;
  /** Whether the relevant test document came out on top. */
  ranked_correctly: boolean | null;
  error: string | null;
  error_kind: string | null;
}

/** Statuses after which nothing is running. */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["complete", "cancelled", "error"]);
