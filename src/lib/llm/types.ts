// LLM connections and task routing as the Rust side owns them
// (`llm-connections.json`, read with `llm_get_config`, pushed with the
// `llm_config_changed` event). JSON is snake_case, like the Rust serde types.
//
// The frontend never persists any of this itself: every change is a command,
// Rust saves and broadcasts the new view, and both windows apply it. Secrets
// never reach the frontend; a connection only says whether one is saved.

import type { ModelInfo } from "../types";
import type { AuthConfig, CustomHeader } from "../endpoint";

/** Request protocol of a connection. A new OpenAI-compatible vendor is a template, not a kind. */
export type LlmKind = "openai_compat" | "anthropic" | "gemini" | "ollama" | "claude_cli";

export const LLM_KINDS: readonly LlmKind[] = ["openai_compat", "anthropic", "gemini", "ollama", "claude_cli"];

/**
 * How the secret is sent. `query` (the key in the URL, old Gemini style) can
 * come from a migrated file; the editor doesn't offer it.
 */
export type LlmAuthMode = AuthConfig["mode"] | "query";

export interface LlmAuthConfig extends Omit<AuthConfig, "mode"> {
  mode: LlmAuthMode;
  /** `query` mode only: the parameter name. */
  query_param?: string | null;
}

/** A custom request header. `secret` values live in the keychain and come back empty. */
export interface LlmHeader extends CustomHeader {
  secret?: boolean;
}

/** Where the model list comes from: the protocol's default path, an address of its own, or nowhere (manual list only). */
export type ModelsEndpoint = { mode: "auto" } | { mode: "custom"; url: string } | { mode: "disabled" };

/** Request parameters; null / missing = not set at this level. */
export interface LlmParams {
  temperature?: number | null;
  max_tokens?: number | null;
  /** Merged into the request body (JSON Merge Patch); `model`, `messages`, `stream` can't be overridden. */
  extra_body?: Record<string, unknown> | null;
}

export type TemperatureCompat = "pass" | "omit" | { fixed: number };
export type MaxTokensField = "max_tokens" | "max_completion_tokens" | "omit";

/** Per-connection switches for servers that deviate from the protocol. */
export interface LlmCompat {
  temperature: TemperatureCompat;
  max_tokens_field: MaxTokensField;
  /** Read `reasoning_content` / `reasoning` / Ollama `thinking` as thinking (never part of the answer). */
  reasoning: "auto" | "off";
  /** Drop a leading `<think>…</think>` block from answers. */
  strip_think_tags: boolean;
  /** Ask for usage in the stream (`stream_options.include_usage`). */
  stream_usage: boolean;
  /** Old custom endpoints: retry Ollama's `/api/chat` on 404/405 only. */
  ollama_fallback_on_404: boolean;
  keep_alive?: string | null;
  web_search?: "none" | "openrouter_online" | "gemini_google_search";
}

/** The last `/models` result, saved with the connection (shared by both windows, kept offline). */
export interface ModelCache {
  models: ModelInfo[];
  fetched_at_ms: number | null;
  error: string | null;
}

export interface LlmConnection {
  /** `c_<8 hex>` for new connections, `legacy-<old provider>` for migrated ones. */
  id: string;
  name: string;
  /** Template id (icon, a few special behaviours); null for none. */
  template: string | null;
  kind: LlmKind;
  enabled: boolean;
  base_url: string;
  /** Full chat URL for irregular gateways; may hold `{model}`. */
  chat_url_override: string | null;
  models_endpoint: ModelsEndpoint;
  auth: LlmAuthConfig;
  /** Last characters of the saved secret ("ab12"); null when none is saved or it's unknown (migrated slots). */
  secret_hint: string | null;
  headers: LlmHeader[];
  /** Used when a route picks the connection without a model. */
  default_model: string | null;
  /** The user's own model list, shown first among the candidates. */
  manual_models: string[];
  model_cache: ModelCache | null;
  params: LlmParams;
  compat: LlmCompat;
  /** Connect timeout (s); null = default (10). */
  timeout_secs: number | null;
  /** Parallel requests per connection; null = default (4). */
  max_concurrency: number | null;
  /** Last successful test (ms since epoch). */
  verified_at_ms: number | null;
}

export interface RouteTarget {
  connection_id: string;
  /** null = the connection's default model. */
  model: string | null;
}

export interface TaskRoute {
  /** null = follow the parent task. */
  target: RouteTarget | null;
  params: LlmParams;
}

export interface LlmRouting {
  default: RouteTarget | null;
  /** Keyed by task key (`assist`, `meeting_summary`, `translation`…). */
  tasks: Record<string, TaskRoute>;
}

/** Language the AI answers in: the UI language, the meeting's language, or a fixed language code. */
export type ResponseLanguage = "ui" | "transcript" | (string & {});

export interface LlmMigrationInfo {
  /** "fresh" (new install) or "legacy" (read from the old config.json keys). */
  from: string;
  at_ms: number;
  legacy_provider: string | null;
  legacy_model: string | null;
}

/** What `llm_get_config` returns and `llm_config_changed` carries. */
export interface LlmConfigView {
  schema_version: number;
  /** Bumped on every save; a view with a lower revision is stale. */
  revision: number;
  /** The file was written by a newer version: shown, not saved. */
  read_only: boolean;
  connections: LlmConnection[];
  routing: LlmRouting;
  response_language: ResponseLanguage;
  migration: LlmMigrationInfo | null;
}

export interface SecretStatus {
  present: boolean;
  hint: string | null;
}

export type TestMode = "chat" | "models";

/** Outcome of `llm_test_connection`: the real request, its status and the start of the answer or the raw error. */
export interface LlmTestResult {
  ok: boolean;
  /** The address the request went to (secrets redacted). */
  url: string;
  status: number | null;
  latency_ms: number;
  /** First words of the answer (chat) or the number of models (models). */
  sample: string | null;
  /** Start of the raw error body (≤ 2 KB) or the transport error. */
  error_body: string | null;
}

export interface EndpointPreviewView {
  chat_url: string | null;
  models_url: string | null;
  warnings: string[];
}
