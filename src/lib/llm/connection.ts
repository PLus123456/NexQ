// Connection defaults, normalization of what the backend sends, ids, and the
// model candidates shown in model inputs.

import type { ModelOption } from "../../components/ModelCombobox";
import type { AuthConfig } from "../endpoint";
import { computeEffective, KNOWN_TASKS } from "./tasks";
import type {
  EffectiveRoute,
  LlmCompat,
  LlmConfigView,
  LlmConnection,
  LlmConnectionInput,
  LlmKind,
  LlmParams,
  LlmRouting,
  ModelsEndpointMode,
  TaskInfo,
  TaskRoute,
  WebSearchMode,
} from "./types";
import { LLM_KINDS } from "./types";

export const DEFAULT_COMPAT: Readonly<LlmCompat> = Object.freeze({
  temperature: "pass",
  fixed_temperature: null,
  max_tokens_field: "max_tokens",
  reasoning: "auto",
  strip_think_tags: true,
  stream_usage: false,
  supports_json_mode: false,
  ollama_fallback_on_404: false,
  keep_alive: null,
  web_search: "auto",
});

export const DEFAULT_TIMEOUT_SECS = 10;
export const DEFAULT_MAX_CONCURRENCY = 4;

/** The auth a kind starts with (the backend's defaults). */
export function defaultAuth(kind: LlmKind): AuthConfig {
  switch (kind) {
    case "openai_compat":
      return { mode: "bearer", header_name: "", prefix: "" };
    case "anthropic":
      return { mode: "header", header_name: "x-api-key", prefix: "" };
    case "gemini":
      return { mode: "header", header_name: "x-goog-api-key", prefix: "" };
    default:
      return { mode: "none", header_name: "", prefix: "" };
  }
}

/** A new connection id: `c_` + 8 hex digits (only a draft key until saved: Rust assigns the real one). */
export function newConnectionId(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return `c_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** A blank connection of `kind` (fields the editor and the backend expect). */
export function blankConnection(kind: LlmKind, id = newConnectionId()): LlmConnection {
  return {
    id,
    name: "",
    template: null,
    kind,
    enabled: true,
    base_url: "",
    chat_url_override: null,
    models_endpoint: kind === "claude_cli" ? "disabled" : "auto",
    models_url: null,
    auth: defaultAuth(kind),
    headers: [],
    default_model: null,
    manual_models: [],
    params: {},
    compat: { ...DEFAULT_COMPAT, temperature: kind === "anthropic" ? "omit" : "pass" },
    timeout_secs: null,
    max_concurrency: null,
    secret_ref: null,
    secret_hint: null,
    model_cache: null,
    verified_at_ms: null,
    created_at_ms: null,
    legacy_type: null,
  };
}

/** The editable fields, as `llm_upsert_connection` takes them. */
export function toInput(connection: LlmConnection): LlmConnectionInput {
  const {
    secret_ref: _secretRef,
    secret_hint: _secretHint,
    model_cache: _modelCache,
    verified_at_ms: _verifiedAt,
    created_at_ms: _createdAt,
    legacy_type: _legacyType,
    ...input
  } = connection;
  return input;
}

/** "…ab12" → "ab12" (the shared key field adds its own ellipsis). */
export function bareHint(hint: string | null | undefined): string | null {
  const bare = hint?.replace(/^(…|\.\.\.)/, "").trim();
  return bare ? bare : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return options.find((option) => option === value) ?? fallback;
}

function normalizeParams(raw: unknown): LlmParams {
  if (!isRecord(raw)) return {};
  const params: LlmParams = {};
  const temperature = numOrNull(raw.temperature);
  if (temperature !== null) params.temperature = temperature;
  const maxTokens = numOrNull(raw.max_tokens);
  if (maxTokens !== null) params.max_tokens = maxTokens;
  if (isRecord(raw.extra_body)) params.extra_body = raw.extra_body;
  return params;
}

function normalizeCompat(raw: unknown, kind: LlmKind): LlmCompat {
  const r = isRecord(raw) ? raw : {};
  const defaults = blankConnection(kind, "x").compat;
  return {
    temperature: oneOf(r.temperature, ["pass", "omit", "fixed"] as const, defaults.temperature),
    fixed_temperature: numOrNull(r.fixed_temperature),
    max_tokens_field: oneOf(r.max_tokens_field, ["max_tokens", "max_completion_tokens", "omit"] as const, "max_tokens"),
    reasoning: oneOf(r.reasoning, ["auto", "off"] as const, "auto"),
    strip_think_tags: r.strip_think_tags !== false,
    stream_usage: r.stream_usage === true,
    supports_json_mode: r.supports_json_mode === true,
    ollama_fallback_on_404: r.ollama_fallback_on_404 === true,
    keep_alive: strOrNull(r.keep_alive),
    web_search: oneOf<WebSearchMode>(r.web_search, ["auto", "none", "openrouter_online", "gemini_google_search"], "auto"),
  };
}

/**
 * A connection as received, with every field present and typed. Tolerates
 * missing fields (serde defaults on the Rust side, older files).
 */
export function normalizeConnection(raw: unknown): LlmConnection {
  const r = isRecord(raw) ? raw : {};
  const kind = oneOf(r.kind, LLM_KINDS, "openai_compat");
  const base = blankConnection(kind, str(r.id));
  const auth = isRecord(r.auth) ? r.auth : null;
  const cache = isRecord(r.model_cache) ? r.model_cache : null;
  return {
    ...base,
    name: str(r.name),
    template: strOrNull(r.template),
    enabled: r.enabled !== false,
    base_url: str(r.base_url),
    chat_url_override: strOrNull(r.chat_url_override),
    models_endpoint: oneOf<ModelsEndpointMode>(r.models_endpoint, ["auto", "custom", "disabled"], base.models_endpoint),
    models_url: strOrNull(r.models_url),
    auth: auth
      ? {
          mode: oneOf(auth.mode, ["none", "bearer", "header"] as const, "none"),
          header_name: str(auth.header_name),
          prefix: str(auth.prefix),
        }
      : base.auth,
    headers: Array.isArray(r.headers)
      ? r.headers.filter(isRecord).map((h) => ({
          name: str(h.name),
          value: str(h.value),
          secret: h.secret === true,
          value_saved: h.value_saved === true,
        }))
      : [],
    default_model: strOrNull(r.default_model),
    manual_models: Array.isArray(r.manual_models)
      ? r.manual_models.filter((m): m is string => typeof m === "string" && m.trim() !== "")
      : [],
    params: normalizeParams(r.params),
    compat: normalizeCompat(r.compat, kind),
    timeout_secs: numOrNull(r.timeout_secs),
    max_concurrency: numOrNull(r.max_concurrency),
    secret_ref: strOrNull(r.secret_ref),
    secret_hint: strOrNull(r.secret_hint),
    model_cache: cache
      ? {
          models: Array.isArray(cache.models)
            ? cache.models.filter(isRecord).map((m) => ({
                id: str(m.id),
                name: str(m.name) || str(m.id),
                provider: str(m.provider),
                context_window: numOrNull(m.context_window),
              }))
            : [],
          fetched_at_ms: numOrNull(cache.fetched_at_ms),
          url: strOrNull(cache.url),
          error: strOrNull(cache.error),
        }
      : null,
    verified_at_ms: numOrNull(r.verified_at_ms),
    created_at_ms: numOrNull(r.created_at_ms),
    legacy_type: strOrNull(r.legacy_type),
  };
}

function normalizeTaskRoute(raw: unknown): TaskRoute {
  const r = isRecord(raw) ? raw : {};
  const target =
    isRecord(r.target) && typeof r.target.connection_id === "string" && r.target.connection_id
      ? { connection_id: r.target.connection_id, model: strOrNull(r.target.model) }
      : null;
  return { target, params: normalizeParams(r.params) };
}

function normalizeRouting(raw: unknown): LlmRouting {
  const r = isRecord(raw) ? raw : {};
  const tasks: Record<string, TaskRoute> = {};
  if (isRecord(r.tasks)) for (const [key, value] of Object.entries(r.tasks)) tasks[key] = normalizeTaskRoute(value);
  return { default: normalizeTaskRoute(r.default), tasks };
}

function normalizeEffective(raw: unknown): EffectiveRoute | null {
  if (!isRecord(raw)) return null;
  return {
    source: strOrNull(raw.source),
    connection_id: strOrNull(raw.connection_id),
    connection_name: strOrNull(raw.connection_name),
    kind: (LLM_KINDS as readonly unknown[]).includes(raw.kind) ? (raw.kind as LlmKind) : null,
    model: strOrNull(raw.model),
    via_fallback: raw.via_fallback === true,
    error: strOrNull(raw.error),
  };
}

/** The whole view as received, normalized; `effective` is computed when the view has none. */
export function normalizeView(raw: unknown): LlmConfigView {
  const r = isRecord(raw) ? raw : {};
  const migration = isRecord(r.migration) ? r.migration : null;
  const connections = Array.isArray(r.connections) ? r.connections.map(normalizeConnection).filter((c) => c.id) : [];
  const routing = normalizeRouting(r.routing);
  const knownTasks: TaskInfo[] = Array.isArray(r.known_tasks)
    ? r.known_tasks
        .filter(isRecord)
        .filter((task) => typeof task.key === "string" && task.key)
        .map((task) => ({ key: task.key as string, parent: strOrNull(task.parent) }))
    : [];
  const known_tasks = knownTasks.length > 0 ? knownTasks : [...KNOWN_TASKS];
  const effective: Record<string, EffectiveRoute> = {};
  if (isRecord(r.effective)) {
    for (const [key, value] of Object.entries(r.effective)) {
      const route = normalizeEffective(value);
      if (route) effective[key] = route;
    }
  }
  return {
    schema_version: numOrNull(r.schema_version) ?? 1,
    revision: numOrNull(r.revision) ?? 0,
    read_only: r.read_only === true,
    load_warning: strOrNull(r.load_warning),
    connections,
    routing,
    response_language: str(r.response_language) || "ui",
    migration: migration
      ? {
          source: str(migration.source) || "fresh",
          at_ms: numOrNull(migration.at_ms) ?? 0,
          legacy_provider: strOrNull(migration.legacy_provider),
          legacy_model: strOrNull(migration.legacy_model),
          connections: Array.isArray(migration.connections)
            ? migration.connections.filter((id): id is string => typeof id === "string")
            : [],
        }
      : null,
    known_tasks,
    effective: Object.keys(effective).length > 0 ? effective : computeEffective({ connections, routing, known_tasks }),
    claude_available: r.claude_available !== false,
  };
}

/** A name not used by another connection: "DeepSeek", "DeepSeek 2", … */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const names = new Set(Array.from(taken, (n) => n.trim().toLowerCase()));
  const name = base.trim();
  if (!names.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) {
    const candidate = `${name} ${i}`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
}

const NON_CHAT_PATTERNS = ["embed", "all-minilm", "bge-", "rerank", "snowflake-arctic", "whisper", "tts-", "dall-e"];

/** Embedding, rerank, speech and image models, left out of chat model candidates. */
export function isEmbeddingModel(id: string): boolean {
  const lower = id.toLowerCase();
  return NON_CHAT_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Model candidates for a connection, in the order the model input shows them:
 * the user's list, then the fetched list.
 */
export function modelOptions(
  connection: Pick<LlmConnection, "manual_models" | "model_cache" | "default_model"> | null | undefined,
): ModelOption[] {
  if (!connection) return [];
  const options: ModelOption[] = [];
  for (const id of connection.manual_models) options.push({ id, source: "manual" });
  for (const model of connection.model_cache?.models ?? []) {
    options.push({
      id: model.id,
      label: model.name && model.name !== model.id ? model.name : undefined,
      source: "fetched",
      detail: model.context_window ? `${Math.round(model.context_window / 1000)}K` : undefined,
    });
  }
  return options;
}

/** Same editable fields (what Rust keeps itself, like the model cache, is ignored). */
export function sameConnection(a: LlmConnection, b: LlmConnection): boolean {
  return JSON.stringify(sortKeys(toInput(a))) === JSON.stringify(sortKeys(toInput(b)));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    );
  }
  return value;
}
