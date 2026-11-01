// Endpoint address rules and auth headers for user-configured HTTP services
// (LLM connections, remote STT, embeddings, rerank). NexQ Plus contract:
// frozen once merged — add, never change.
//
// Mirrors src-tauri/src/net/endpoint.rs; both sides run the cases in
// ./endpointCases.json, so the address the settings page previews is the
// address the request goes to. The base URL is used as typed (version prefix
// included): `/v1` is never added automatically.

/** Fixed paths appended to a base URL. */
export const ENDPOINT_PATHS = {
  chatCompletions: "/chat/completions",
  models: "/models",
  audioTranscriptions: "/audio/transcriptions",
  embeddings: "/embeddings",
  rerank: "/rerank",
} as const;

/**
 * `already_full`: the base URL already ends with the path, nothing was appended.
 * `no_version_prefix`: the base URL has no path (most OpenAI-compatible
 * services need a version prefix such as `/v1`).
 */
export type EndpointWarning = "already_full" | "no_version_prefix";

export type EndpointErrorCode = "empty" | "missing_scheme" | "unsupported_scheme" | "invalid_url";

/** Why a base URL was rejected; same JSON as the Rust `EndpointError`. */
export interface EndpointError {
  code: EndpointErrorCode;
  /** `missing_scheme`: the input with a guessed scheme, e.g. `http://localhost:11434`. */
  suggestion?: string;
  /** `unsupported_scheme`: the scheme typed, lowercased. */
  scheme?: string;
  /** `invalid_url`: the parser's message (English, differs between engines). */
  detail?: string;
}

export type NormalizeResult = { ok: true; base: string; pathEmpty: boolean } | { ok: false; error: EndpointError };

export type JoinResult = { ok: true; url: string; warnings: EndpointWarning[] } | { ok: false; error: EndpointError };

/**
 * Trims and checks a base URL: `http://` / `https://` only, fragment and empty
 * query dropped, query kept, trailing `/` stripped. `base` is
 * `scheme://[userinfo@]host[:port]<path>[?query]` (`http://192.168.1.10:8000`
 * for a host only, which also sets `pathEmpty`).
 */
export function normalizeBaseUrl(input: string): NormalizeResult {
  const parsed = parse(input);
  if (!parsed.ok) return parsed;
  return { ok: true, base: baseString(parsed.url, parsed.path), pathEmpty: parsed.path === "" };
}

/**
 * The address a request goes to: `base` + `path` (e.g.
 * `ENDPOINT_PATHS.chatCompletions`), query kept. A base that already ends with
 * `path` is used as is; an empty `path` gives the base itself.
 */
export function joinEndpoint(base: string, path: string): JoinResult {
  const parsed = parse(base);
  if (!parsed.ok) return parsed;
  const { url, path: current } = parsed;
  const suffix = path.replace(/^\/+/, "");
  if (suffix) {
    if (stripSegments(current, suffix) !== null) return { ok: true, url: url.href, warnings: ["already_full"] };
    url.pathname = `${current}/${suffix}`;
  }
  return { ok: true, url: url.href, warnings: current === "" ? ["no_version_prefix"] : [] };
}

/**
 * For a full endpoint URL pasted into a base URL field: the base before the
 * first of `paths` it ends with, and that path (`…/llm/chat/completions` →
 * `…/llm`). `null` if none matches or `input` is invalid.
 */
export function stripEndpointPath(input: string, paths: readonly string[]): { base: string; path: string } | null {
  const parsed = parse(input);
  if (!parsed.ok) return null;
  for (const path of paths) {
    const rest = stripSegments(parsed.path, path);
    if (rest !== null) return { base: baseString(parsed.url, rest.replace(/\/+$/, "")), path };
  }
  return null;
}

/** The normalized base with `prefix` appended to its path, for the "Add /v1" button. Invalid input comes back unchanged. */
export function addVersionPrefix(base: string, prefix = "/v1"): string {
  const parsed = parse(base);
  if (!parsed.ok) return base;
  const { url, path } = parsed;
  const segment = prefix.replace(/^\/+|\/+$/g, "");
  if (!segment) return baseString(url, path);
  url.pathname = `${path}/${segment}`;
  return baseString(url, url.pathname.replace(/\/+$/, ""));
}

// ── Auth ────────────────────────────────────────────────────────────────────

/** How the secret is sent: none, `Authorization: Bearer <key>`, or `<header_name>: [<prefix> ]<key>`. */
export type AuthMode = "none" | "bearer" | "header";

/** Auth settings, same JSON as the Rust `AuthConfig` (the secret itself lives in the keychain). */
export interface AuthConfig {
  mode: AuthMode;
  /** Header name for `header` mode, e.g. `api-key`. */
  header_name: string;
  /** Optional value prefix for `header` mode (`Token` → `Token <key>`). */
  prefix: string;
}

/** A custom request header. Values are plain settings, never secrets. */
export interface CustomHeader {
  name: string;
  value: string;
}

export const NO_AUTH: AuthConfig = Object.freeze({ mode: "none", header_name: "", prefix: "" });

export type HeaderErrorCode = "header_name_required" | "invalid_header_name" | "invalid_header_value";

/** An RFC 7230 token: letters, digits and ``!#$%&'*+-.^_`|~``. Not trimmed. */
export function isValidHeaderName(name: string): boolean {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name);
}

/**
 * The auth header, then the custom headers in order (names and values trimmed,
 * blank names skipped). No secret means no auth header and no error; a
 * header-mode name is checked either way. On error, `name` is the header at
 * fault.
 */
export function requestHeaders(
  auth: AuthConfig,
  secret: string | null | undefined,
  custom: readonly CustomHeader[] = [],
): { ok: true; headers: [string, string][] } | { ok: false; error: HeaderErrorCode; name?: string } {
  const headers: [string, string][] = [];
  if (auth.mode === "bearer" || auth.mode === "header") {
    let name = "Authorization";
    let prefix = "Bearer";
    if (auth.mode === "header") {
      name = trimWs(auth.header_name ?? "");
      if (!name) return { ok: false, error: "header_name_required" };
      if (!isValidHeaderName(name)) return { ok: false, error: "invalid_header_name", name };
      prefix = trimWs(auth.prefix ?? "");
    }
    const key = trimWs(secret ?? "");
    if (key) {
      const value = prefix ? `${prefix} ${key}` : key;
      if (!isValidHeaderValue(value)) return { ok: false, error: "invalid_header_value", name };
      headers.push([name, value]);
    }
  }
  for (const header of custom) {
    const name = trimWs(header.name ?? "");
    if (!name) continue;
    if (!isValidHeaderName(name)) return { ok: false, error: "invalid_header_name", name };
    const value = trimWs(header.value ?? "");
    if (!isValidHeaderValue(value)) return { ok: false, error: "invalid_header_value", name };
    headers.push([name, value]);
  }
  return { ok: true, headers };
}

// ── Internals (kept in step with endpoint.rs) ───────────────────────────────

type Parsed = { ok: true; url: URL; path: string } | { ok: false; error: EndpointError };

/** Parses `input`; `path` is the URL path without trailing `/` ("" for a host only). */
function parse(input: string): Parsed {
  const text = trimWs(input);
  if (!text) return { ok: false, error: { code: "empty" } };
  // Checked as text first: `localhost:11434` parses as scheme "localhost".
  if (!/^https?:\/\//i.test(text)) {
    const scheme = explicitScheme(text);
    const error: EndpointError =
      scheme !== null
        ? { code: "unsupported_scheme", scheme }
        : { code: "missing_scheme", suggestion: `${guessScheme(text)}://${text}` };
    return { ok: false, error };
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch (e) {
    return { ok: false, error: { code: "invalid_url", detail: e instanceof Error ? e.message : String(e) } };
  }
  // `detail` is parser text, never shown as is.
  if (!url.hostname) return { ok: false, error: { code: "invalid_url", detail: "empty host" } }; // i18n-ignore
  url.hash = "";
  // `search` reads "" for both no query and a lone "?"; setting "" drops the "?".
  if (url.search === "") url.search = "";
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path || "/";
  return { ok: true, url, path };
}

/** `scheme://[userinfo@]host[:port]` + `path` + `?query`. */
function baseString(url: URL, path: string): string {
  const credentials = url.username || url.password ? `${url.username}${url.password ? `:${url.password}` : ""}@` : "";
  return `${url.protocol}//${credentials}${url.host}${path}${url.search}`;
}

/** `path` without a trailing `/<suffix>` (whole segments, case-sensitive); `null` if it doesn't end with it. */
function stripSegments(path: string, suffix: string): string | null {
  const segments = suffix.replace(/^\/+/, "");
  if (!segments || !path.endsWith(`/${segments}`)) return null;
  return path.slice(0, path.length - segments.length - 1);
}

/** What `String.prototype.trim` trims, plus U+0085: Rust's `char::is_whitespace` set plus U+FEFF. */
function trimWs(s: string): string {
  return s.replace(/^[\s\u0085]+|[\s\u0085]+$/g, "");
}

/** The scheme before `://`, lowercased, if the text there is one (in `host/?next=http://x` it isn't). */
function explicitScheme(input: string): string | null {
  const end = input.indexOf("://");
  if (end < 0) return null;
  const scheme = input.slice(0, end);
  return /^[A-Za-z][A-Za-z0-9+.-]*$/.test(scheme) ? scheme.toLowerCase() : null;
}

/**
 * `http` for local-looking hosts (localhost, `*.local`, `*.localhost`, private
 * IPv4, IPv6 literals) or an explicit port other than 443, else `https`.
 */
function guessScheme(input: string): "http" | "https" {
  const authority = input.split(/[/?#]/, 1)[0];
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  if (hostPort.startsWith("[")) return "http";
  const colon = hostPort.lastIndexOf(":");
  const host = asciiLower(colon < 0 ? hostPort : hostPort.slice(0, colon));
  const port = colon < 0 ? "" : hostPort.slice(colon + 1);
  const local =
    host === "localhost" || host.endsWith(".local") || host.endsWith(".localhost") || isPrivateIpv4(host);
  return local || (port !== "" && port !== "443") ? "http" : "https";
}

/** Dotted-quad loopback or private IPv4: 127/8, 10/8, 172.16/12, 192.168/16. */
function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^[0-9]{1,3}$/.test(p) && Number(p) <= 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/** Control characters other than tab (what reqwest's `HeaderValue` rejects; CR/LF would split the header). */
function isValidHeaderValue(value: string): boolean {
  return !/[\u0000-\u0008\u000a-\u001f\u007f]/.test(value);
}

function asciiLower(s: string): string {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}
