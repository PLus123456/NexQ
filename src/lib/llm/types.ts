// LLM connections and task routing as the Rust side owns them
// (`llm-connections.json`, read with `llm_get_config`, pushed with the
// `llm_config_changed` event). JSON is snake_case, like the Rust serde types.
// The shapes follow the P1 contract (shared notes, contract-llm.md v1).
//
// The frontend never persists any of this itself: every change is a command,
// Rust saves and broadcasts the new view, and both windows apply it. Secrets
// never reach the frontend; a connection only says whether one is saved.

import type { ModelInfo } from "../types";
import type { AuthConfig } from "../endpoint";

/** Request protocol of a connection. A new OpenAI-compatible vendor is a template, not a kind. */
export type LlmKind = "openai_compat" | "anthropic" | "gemini" | "ollama" | "claude_cli";

export const LLM_KINDS: readonly LlmKind[] = ["openai_compat", "anthropic", "gemini", "ollama", "claude_cli"];

/** A custom request header. A `secret` header's value lives in the keychain and comes back "". */
export interface LlmHeader {
  name: string;
  /** For a secret header: "" in views; on upsert "" keeps the stored value. */
  value: string;
  secret: boolean;
  /** Read-only: a secret header has a stored value. */
  value_saved?: boolean;
}

/** Where the model list comes from: the protocol's default path, `models_url`, or nowhere (manual list only). */
export type ModelsEndpointMode = "auto" | "custom" | "disabled";

/** Request parameters; null / missing = not set at this level. */
export interface LlmParams {
  temperature?: number | null;
  max_tokens?: number | null;
  /** Merged into the request body (JSON Merge Patch); `model`, `messages`, `stream` can't be overridden. */
  extra_body?: Record<string, unknown> | null;
}

export type TemperatureCompat = "pass" | "omit" | "fixed";
export type MaxTokensField = "max_tokens" | "max_completion_tokens" | "omit";
export type WebSearchMode = "auto" | "none" | "openrouter_online" | "gemini_google_search";

/** Per-connection switches for servers that deviate from the protocol. */
export interface LlmCompat {
  temperature: TemperatureCompat;
  /** Sent when `temperature` is "fixed". */
  fixed_temperature: number | null;
  max_tokens_field: MaxTokensField;
  /** Read `reasoning_content` / `reasoning` / Ollama `thinking` as thinking (never part of the answer). */
  reasoning: "auto" | "off";
  /** Drop a leading `<think>…</think>` block from answers. */
  strip_think_tags: boolean;
  /** Ask for usage in the stream (`stream_options.include_usage`). */
  stream_usage: boolean;
  /** Allow individual background tasks to request native JSON output. */
  supports_json_mode?: boolean;
  /** Old custom endpoints: retry Ollama's `/api/chat` on 404/405 only. */
  ollama_fallback_on_404: boolean;
  /** Ollama only; null = "30m". */
  keep_alive: string | null;
  /** "auto": Gemini → Google Search, the OpenRouter template → `:online`, others none. */
  web_search: WebSearchMode;
}

/** The last model list fetch, saved with the connection (shared by both windows, kept offline). */
export interface ModelCache {
  models: ModelInfo[];
  fetched_at_ms: number | null;
  /** The address it was fetched from (secrets redacted). */
  url: string | null;
  /** The last fetch's error, as the server said it; the last good list is kept. */
  error: string | null;
}

export interface LlmConnection {
  // ── Editable (what `llm_upsert_connection` takes) ──
  /** `c_<8 hex>`, `legacy-<old provider>` for migrated ones; "" when sent to create one. */
  id: string;
  /** Empty: the backend uses the template's / kind's name. */
  name: string;
  /** Template id (icon, a few special behaviours); null for none. */
  template: string | null;
  kind: LlmKind;
  enabled: boolean;
  base_url: string;
  /** Full chat URL for irregular gateways; may hold `{model}`. */
  chat_url_override: string | null;
  models_endpoint: ModelsEndpointMode;
  /** The model list address when `models_endpoint` is "custom". */
  models_url: string | null;
  auth: AuthConfig;
  headers: LlmHeader[];
  /** Used when a route picks the connection without a model. */
  default_model: string | null;
  /** The user's own model list, shown first among the candidates. */
  manual_models: string[];
  /** Context length (tokens) per model id, as typed; beats what the model list says. */
  context_windows: Record<string, number>;
  params: LlmParams;
  compat: LlmCompat;
  /** Connect timeout (s); null = 10. */
  timeout_secs: number | null;
  /** Parallel background requests (translation etc.); null = 4. */
  max_concurrency: number | null;

  // ── Kept by Rust (ignored on upsert) ──
  /** Keychain account: "llm:<id>", or a migrated slot ("openai", "custom"…); null = none yet. */
  secret_ref: string | null;
  /** "…ab12"; null when none is saved or unknown (migrated slots until the first status check). */
  secret_hint: string | null;
  model_cache: ModelCache | null;
  /** Last successful test (ms since epoch). */
  verified_at_ms: number | null;
  created_at_ms: number | null;
  /** The old provider type this connection maps to (old UI, config.json mirror). */
  legacy_type: string | null;
}

/** The fields `llm_upsert_connection` reads. */
export type LlmConnectionInput = Omit<
  LlmConnection,
  "secret_ref" | "secret_hint" | "model_cache" | "verified_at_ms" | "created_at_ms" | "legacy_type"
>;

export interface RouteTarget {
  connection_id: string;
  /** null = the connection's default model. */
  model: string | null;
}

export interface TaskRoute {
  /** null = follow the parent task (only the parameter overrides apply). */
  target: RouteTarget | null;
  params: LlmParams;
}

export interface LlmRouting {
  /** The default route; its target null = nothing configured yet. */
  default: TaskRoute;
  /** Other task keys (`assist`, `meeting_summary`, `translation`…); a missing key follows its parent. */
  tasks: Record<string, TaskRoute>;
}

export interface TaskInfo {
  key: string;
  /** null for "default". */
  parent: string | null;
}

export type RouteError =
  | "not_configured"
  | "connection_missing"
  | "connection_disabled"
  | "no_model"
  | "no_fallback"
  | "base_url_missing";

/** What actually answers a task, as resolved by Rust. */
export interface EffectiveRoute {
  /** The task whose route applies ("default", a parent, itself); null without a usable target. */
  source: string | null;
  connection_id: string | null;
  connection_name: string | null;
  kind: LlmKind | null;
  /** null for the Claude subscription (its Fast / Deep settings decide). */
  model: string | null;
  /** Claude is unavailable, so `claude_fallback` answers. */
  via_fallback: boolean;
  error: RouteError | (string & {}) | null;
}

/** Language the AI answers in: the UI language, the meeting's language, or a fixed language code. */
export type ResponseLanguage = "ui" | "transcript" | (string & {});

export interface LlmMigrationInfo {
  source: "legacy_config" | "fresh" | (string & {});
  at_ms: number;
  legacy_provider: string | null;
  legacy_model: string | null;
  /** Ids of the connections the migration created. */
  connections: string[];
}

/** What `llm_get_config` returns and `llm_config_changed` carries. */
export interface LlmConfigView {
  schema_version: number;
  /** Bumped on every change; a view with a lower revision is stale. */
  revision: number;
  /** Written by a newer version: editable, but changes stay in memory (not saved). */
  read_only: boolean;
  /** "restored_from_backup" | "reset_corrupt_file" | null. */
  load_warning: string | null;
  /** In creation order. */
  connections: LlmConnection[];
  routing: LlmRouting;
  response_language: ResponseLanguage;
  migration: LlmMigrationInfo | null;
  /** The routing table's rows, in display order. */
  known_tasks: TaskInfo[];
  /** Every known task key (and every key in routing.tasks) → what answers it. */
  effective: Record<string, EffectiveRoute>;
  /** The Claude subscription works right now (when not, `effective` shows the fallback). */
  claude_available: boolean;
}

export interface UpsertResult {
  id: string;
  config: LlmConfigView;
}

export interface DeleteResult {
  /** Task keys whose routes pointed at the deleted connection. */
  cleared_routes: string[];
  config: LlmConfigView;
}

export interface SecretStatus {
  present: boolean;
  hint: string | null;
}

/** "check_version_prefix" (404) | "auth_failed" (401/403) | "no_model" | "base_url_invalid" | "looks_openai_compat". */
export type ResultHint = "check_version_prefix" | "auth_failed" | "no_model" | "base_url_invalid" | "looks_openai_compat";

export interface FetchModelsResult {
  ok: boolean;
  /** The address requested (redacted); null when it couldn't be built. */
  url: string | null;
  /** HTTP status; null for network errors. */
  status: number | null;
  latency_ms: number;
  models: ModelInfo[];
  /** The error as it came (not translated). */
  error: string | null;
  /** HTTP errors: the start of the response body (≤ 2 KB). */
  error_body: string | null;
  hint: ResultHint | (string & {}) | null;
}

export type TestMode = "chat" | "models";

/** Outcome of `llm_test_connection`: the real request, its status and the start of the answer or the raw error. */
export interface TestConnectionResult {
  ok: boolean;
  url: string | null;
  status: number | null;
  latency_ms: number;
  /** The model a chat test used. */
  model: string | null;
  /** Start of the answer (≤ 200 chars); "" when the model only produced reasoning. */
  sample: string | null;
  error: string | null;
  error_body: string | null;
  hint: ResultHint | (string & {}) | null;
}
