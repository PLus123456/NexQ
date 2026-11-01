// Request addresses of an LLM connection by protocol, on top of the shared
// rules in ../endpoint.ts (base URL used as typed, `/v1` never added):
//
//   openai_compat  {base}/chat/completions          {base}/models
//   anthropic      {base}/v1/messages               {base}/v1/models      (base may end in /v1: not repeated)
//   gemini         {base}/v1beta/models/{model}:streamGenerateContent?alt=sse
//                                                   {base}/v1beta/models  (base may end in /v1beta: not repeated)
//   ollama         {base}/api/chat                  {base}/api/tags
//
// A chat URL override replaces the chat address (`{model}` is filled in);
// the models address can be custom or turned off.

import { ENDPOINT_PATHS, joinEndpoint, normalizeBaseUrl } from "../endpoint";
import type { LlmConnection, LlmKind } from "./types";

/** `{model}` in a chat URL override. */
export const MODEL_PLACEHOLDER = "{model}";

/** Path of the base URL (without trailing `/`), or null when it doesn't parse. */
function basePath(baseUrl: string): string | null {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized.ok) return null;
  try {
    return new URL(normalized.base).pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function endsWithSegment(path: string | null, segment: string): boolean {
  return path !== null && (path === `/${segment}` || path.endsWith(`/${segment}`));
}

/**
 * The fixed path appended to the base URL for chat requests (what the base
 * URL field previews). Gemini's path holds the model; without one the models
 * path stands in. null for Claude (no HTTP endpoint).
 */
export function chatPath(kind: LlmKind, baseUrl: string, model?: string | null): string | null {
  switch (kind) {
    case "openai_compat":
      return ENDPOINT_PATHS.chatCompletions;
    case "anthropic":
      return endsWithSegment(basePath(baseUrl), "v1") ? "/messages" : "/v1/messages";
    case "gemini": {
      const prefix = endsWithSegment(basePath(baseUrl), "v1beta") ? "/models" : "/v1beta/models";
      const id = model?.trim();
      return id ? `${prefix}/${encodeURIComponent(id)}:streamGenerateContent` : prefix;
    }
    case "ollama":
      return "/api/chat";
    case "claude_cli":
      return null;
  }
}

/** The protocol's model list path (before any custom models address). */
export function modelsPath(kind: LlmKind, baseUrl: string): string | null {
  switch (kind) {
    case "openai_compat":
      return ENDPOINT_PATHS.models;
    case "anthropic":
      return endsWithSegment(basePath(baseUrl), "v1") ? "/models" : "/v1/models";
    case "gemini":
      return endsWithSegment(basePath(baseUrl), "v1beta") ? "/models" : "/v1beta/models";
    case "ollama":
      return "/api/tags";
    case "claude_cli":
      return null;
  }
}

/** Every path a pasted full URL may end with (cut back to the base on paste). */
export function knownPaths(kind: LlmKind): string[] {
  switch (kind) {
    case "openai_compat":
      return [ENDPOINT_PATHS.chatCompletions, ENDPOINT_PATHS.models];
    case "anthropic":
      return ["/v1/messages", "/v1/models"];
    case "gemini":
      return ["/v1beta/models"];
    case "ollama":
      return ["/api/chat", "/api/tags"];
    case "claude_cli":
      return [];
  }
}

/** Only OpenAI-compatible base URLs normally carry a version prefix such as /v1. */
export function wantsVersionPrefix(kind: LlmKind): boolean {
  return kind === "openai_compat";
}

/** An Ollama base URL ending in /v1 is its OpenAI-compatible API: the kind is probably wrong. */
export function looksLikeOpenAiPath(kind: LlmKind, baseUrl: string): boolean {
  return kind === "ollama" && endsWithSegment(basePath(baseUrl), "v1");
}

export type UrlPreview = { ok: true; url: string } | { ok: false; reason: "empty" | "invalid" | "none" };

/** A chat URL override with `{model}` filled in (URL-encoded); left as `{model}` without a model. */
export function fillModel(template: string, model: string | null | undefined): string {
  const id = model?.trim();
  return id ? template.split(MODEL_PLACEHOLDER).join(encodeURIComponent(id)) : template;
}

/** The address a chat request goes to. */
export function chatUrl(connection: Pick<LlmConnection, "kind" | "base_url" | "chat_url_override">, model?: string | null): UrlPreview {
  if (connection.kind === "claude_cli") return { ok: false, reason: "none" };
  const override = connection.chat_url_override?.trim();
  if (override) {
    const filled = fillModel(override, model);
    const joined = joinEndpoint(filled.split(MODEL_PLACEHOLDER).join("MODEL"), "");
    // The override is used as is; it only has to be a valid address.
    return joined.ok ? { ok: true, url: filled } : { ok: false, reason: "invalid" };
  }
  if (connection.kind === "gemini") return geminiChatUrl(connection.base_url, model);
  const path = chatPath(connection.kind, connection.base_url, model);
  if (path === null) return { ok: false, reason: "none" };
  const joined = joinEndpoint(connection.base_url, path);
  if (!joined.ok) return { ok: false, reason: joined.error.code === "empty" ? "empty" : "invalid" };
  return { ok: true, url: joined.url };
}

/** `…/v1beta/models/<model>:streamGenerateContent?alt=sse`, with `{model}` shown when none is chosen. */
function geminiChatUrl(baseUrl: string, model: string | null | undefined): UrlPreview {
  const joined = joinEndpoint(baseUrl, chatPath("gemini", baseUrl, null) ?? "");
  if (!joined.ok) return { ok: false, reason: joined.error.code === "empty" ? "empty" : "invalid" };
  const id = model?.trim();
  const stand = "__model__";
  try {
    const url = new URL(joined.url);
    url.pathname = `${url.pathname}/${id ? encodeURIComponent(id) : stand}:streamGenerateContent`;
    url.searchParams.set("alt", "sse");
    return { ok: true, url: id ? url.href : url.href.replace(stand, MODEL_PLACEHOLDER) };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

/** The address the model list is fetched from; `none` when turned off. */
export function modelsUrl(connection: Pick<LlmConnection, "kind" | "base_url" | "models_endpoint" | "models_url">): UrlPreview {
  if (connection.kind === "claude_cli" || connection.models_endpoint === "disabled") return { ok: false, reason: "none" };
  if (connection.models_endpoint === "custom") {
    const joined = joinEndpoint(connection.models_url ?? "", "");
    if (!joined.ok) return { ok: false, reason: joined.error.code === "empty" ? "empty" : "invalid" };
    return { ok: true, url: joined.url };
  }
  const path = modelsPath(connection.kind, connection.base_url);
  if (path === null) return { ok: false, reason: "none" };
  const joined = joinEndpoint(connection.base_url, path);
  if (!joined.ok) return { ok: false, reason: joined.error.code === "empty" ? "empty" : "invalid" };
  return { ok: true, url: joined.url };
}

/** A chat URL override that sends every model to the same address (only a hint). */
export function overrideWithoutModel(connection: Pick<LlmConnection, "chat_url_override">): boolean {
  const override = connection.chat_url_override?.trim();
  return !!override && !override.includes(MODEL_PLACEHOLDER);
}

/**
 * Plain `http://` to a host that isn't this computer or the local network:
 * the key would cross the internet unencrypted (only a hint).
 */
export function isPlainHttpRemote(address: string): boolean {
  const normalized = normalizeBaseUrl(address);
  if (!normalized.ok) return false;
  let url: URL;
  try {
    url = new URL(normalized.base);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".lan")) return false;
  // IPv6 literal: loopback, link-local and unique-local addresses are local.
  if (host.includes(":")) return !(host === "::1" || host.startsWith("fe80:") || /^f[cd]/.test(host));
  const parts = host.split(".");
  if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p))) {
    const [a, b] = parts.map(Number);
    return !(a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127));
  }
  // A single-label name ("nas", "gpu-box") is a local machine.
  return host.includes(".");
}

/**
 * The origins (scheme://host:port) a connection's secret would be sent to:
 * the base URL, the chat override and a custom models address. Used to ask
 * for the key again before it could go to a new host.
 */
export function secretOrigins(
  connection: Pick<LlmConnection, "kind" | "base_url" | "chat_url_override" | "models_endpoint" | "models_url">,
): Set<string> {
  const origins = new Set<string>();
  const add = (address: string | null | undefined) => {
    const text = address?.trim();
    if (!text) return;
    const normalized = normalizeBaseUrl(text.split(MODEL_PLACEHOLDER).join("MODEL"));
    if (!normalized.ok) return;
    try {
      origins.add(new URL(normalized.base).origin);
    } catch {
      // Not an address: nothing is sent there.
    }
  };
  add(connection.base_url);
  add(connection.chat_url_override);
  if (connection.models_endpoint === "custom") add(connection.models_url);
  return origins;
}
