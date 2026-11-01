// Connection defaults, normalization of what the backend sends, ids, and the
// model candidates shown in model inputs.

import type { ModelOption } from "../../components/ModelCombobox";
import type {
  LlmAuthConfig,
  LlmCompat,
  LlmConfigView,
  LlmConnection,
  LlmKind,
  LlmParams,
  LlmRouting,
  ModelsEndpoint,
  TaskRoute,
} from "./types";
import { LLM_KINDS } from "./types";

export const DEFAULT_COMPAT: Readonly<LlmCompat> = Object.freeze({
  temperature: "pass",
  max_tokens_field: "max_tokens",
  reasoning: "auto",
  strip_think_tags: true,
  stream_usage: false,
  ollama_fallback_on_404: false,
  keep_alive: null,
  web_search: "none",
});

export const DEFAULT_TIMEOUT_SECS = 10;
export const DEFAULT_MAX_CONCURRENCY = 4;

const NO_AUTH: LlmAuthConfig = { mode: "none", header_name: "", prefix: "" };

/** A new connection id: `c_` + 8 hex digits. */
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
    models_endpoint: kind === "claude_cli" ? { mode: "disabled" } : { mode: "auto" },
    auth: kind === "openai_compat" ? { mode: "bearer", header_name: "", prefix: "" } : { ...NO_AUTH },
    secret_hint: null,
    headers: [],
    default_model: null,
    manual_models: [],
    model_cache: null,
    params: {},
    compat: { ...DEFAULT_COMPAT },
    timeout_secs: null,
    max_concurrency: null,
    verified_at_ms: null,
  };
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

function normalizeModelsEndpoint(raw: unknown, kind: LlmKind): ModelsEndpoint {
  // Accept the tagged object and plain strings ("auto", "disabled", or an address).
  if (isRecord(raw)) {
    if (raw.mode === "disabled") return { mode: "disabled" };
    if (raw.mode === "custom" && typeof raw.url === "string") return { mode: "custom", url: raw.url };
    if (raw.mode === "auto") return { mode: "auto" };
  }
  if (raw === "disabled") return { mode: "disabled" };
  if (typeof raw === "string" && raw !== "auto" && raw.trim() !== "") return { mode: "custom", url: raw };
  return kind === "claude_cli" ? { mode: "disabled" } : { mode: "auto" };
}

/**
 * A connection as received, with every field present and typed. Tolerates
 * missing fields (serde defaults on the Rust side, older files).
 */
export function normalizeConnection(raw: unknown): LlmConnection {
  const r = isRecord(raw) ? raw : {};
  const kind = (LLM_KINDS as readonly string[]).includes(str(r.kind)) ? (r.kind as LlmKind) : "openai_compat";
  const base = blankConnection(kind, str(r.id));
  const auth = isRecord(r.auth) ? r.auth : {};
  const compat = isRecord(r.compat) ? r.compat : {};
  const cache = isRecord(r.model_cache) ? r.model_cache : null;
  return {
    ...base,
    name: str(r.name),
    template: strOrNull(r.template),
    enabled: r.enabled !== false,
    base_url: str(r.base_url),
    chat_url_override: strOrNull(r.chat_url_override),
    models_endpoint: normalizeModelsEndpoint(r.models_endpoint, kind),
    auth: {
      mode: (["none", "bearer", "header", "query"] as const).find((m) => m === auth.mode) ?? "none",
      header_name: str(auth.header_name),
      prefix: str(auth.prefix),
      query_param: strOrNull(auth.query_param),
    },
    secret_hint: strOrNull(r.secret_hint),
    headers: Array.isArray(r.headers)
      ? r.headers.filter(isRecord).map((h) => ({ name: str(h.name), value: str(h.value), secret: h.secret === true }))
      : [],
    default_model: strOrNull(r.default_model),
    manual_models: Array.isArray(r.manual_models)
      ? r.manual_models.filter((m): m is string => typeof m === "string" && m.trim() !== "")
      : [],
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
          error: strOrNull(cache.error),
        }
      : null,
    params: normalizeParams(r.params),
    compat: { ...DEFAULT_COMPAT, ...(compat as Partial<LlmCompat>) },
    timeout_secs: numOrNull(r.timeout_secs),
    max_concurrency: numOrNull(r.max_concurrency),
    verified_at_ms: numOrNull(r.verified_at_ms),
  };
}

function normalizeTaskRoute(raw: unknown): TaskRoute {
  const r = isRecord(raw) ? raw : {};
  const target = isRecord(r.target) && typeof r.target.connection_id === "string" && r.target.connection_id
    ? { connection_id: r.target.connection_id, model: strOrNull(r.target.model) }
    : null;
  return { target, params: normalizeParams(r.params) };
}

function normalizeRouting(raw: unknown): LlmRouting {
  const r = isRecord(raw) ? raw : {};
  const def = isRecord(r.default) && typeof r.default.connection_id === "string" && r.default.connection_id
    ? { connection_id: r.default.connection_id, model: strOrNull(r.default.model) }
    : null;
  const tasks: Record<string, TaskRoute> = {};
  if (isRecord(r.tasks)) for (const [key, value] of Object.entries(r.tasks)) tasks[key] = normalizeTaskRoute(value);
  return { default: def, tasks };
}

/** The whole view as received, normalized. */
export function normalizeView(raw: unknown): LlmConfigView {
  const r = isRecord(raw) ? raw : {};
  const migration = isRecord(r.migration) ? r.migration : null;
  return {
    schema_version: numOrNull(r.schema_version) ?? 1,
    revision: numOrNull(r.revision) ?? 0,
    read_only: r.read_only === true,
    connections: Array.isArray(r.connections) ? r.connections.map(normalizeConnection).filter((c) => c.id) : [],
    routing: normalizeRouting(r.routing),
    response_language: str(r.response_language) || "ui",
    migration: migration
      ? {
          from: str(migration.from),
          at_ms: numOrNull(migration.at_ms) ?? 0,
          legacy_provider: strOrNull(migration.legacy_provider),
          legacy_model: strOrNull(migration.legacy_model),
        }
      : null,
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
 * the user's list, the fetched list, then the template's suggestions.
 */
export function modelOptions(
  connection: Pick<LlmConnection, "manual_models" | "model_cache" | "default_model"> | null | undefined,
  suggested: readonly string[] = [],
): ModelOption[] {
  if (!connection) return suggested.map((id) => ({ id, source: "suggested" }));
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
  for (const id of suggested) options.push({ id, source: "suggested" });
  return options;
}

/** Shallow-equal check of two connections as saved (order of keys ignored). */
export function sameConnection(a: LlmConnection, b: LlmConnection): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
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
