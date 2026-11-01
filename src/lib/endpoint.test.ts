import { describe, expect, it } from "vitest";
import cases from "./endpointCases.json";
import {
  addVersionPrefix,
  ENDPOINT_PATHS,
  isValidHeaderName,
  joinEndpoint,
  NO_AUTH,
  normalizeBaseUrl,
  requestHeaders,
  stripEndpointPath,
  type AuthConfig,
  type CustomHeader,
  type EndpointError,
} from "./endpoint";

// The case file is shared with src-tauri/src/net/endpoint.rs.
interface ErrorCase {
  name: string;
  error?: string;
  suggestion?: string;
  scheme?: string;
}
interface JoinCase extends ErrorCase {
  base: string;
  path: string;
  url?: string;
  warnings?: string[];
}
interface NormalizeCase extends ErrorCase {
  input: string;
  base?: string;
  path_empty?: boolean;
}
interface CaseFile {
  version: number;
  join: JoinCase[];
  normalize: NormalizeCase[];
  strip: { name: string; input: string; paths: string[]; result: { base: string; path: string } | null }[];
  add_version_prefix: { name: string; base: string; prefix?: string; result: string }[];
  header_names: { header: string; valid: boolean }[];
  headers: {
    name: string;
    auth: AuthConfig;
    secret: string | null;
    custom?: CustomHeader[];
    headers?: [string, string][];
    error?: string;
    error_header?: string;
  }[];
}

const suite = cases as unknown as CaseFile;

/** Same checks as the Rust side: the code, plus the suggestion / scheme it carries. */
function expectError(error: EndpointError, c: ErrorCase) {
  expect(error.code, c.name).toBe(c.error);
  if (error.code === "missing_scheme") expect(error.suggestion, c.name).toBe(c.suggestion);
  if (error.code === "unsupported_scheme") expect(error.scheme, c.name).toBe(c.scheme);
  if (error.code === "invalid_url") expect(error.detail, c.name).toEqual(expect.any(String));
}

describe("shared endpoint cases", () => {
  it("reads version 1", () => {
    expect(suite.version).toBe(1);
  });

  it.each(suite.join)("join: $name", (c) => {
    const result = joinEndpoint(c.base, c.path);
    if (c.error === undefined) {
      expect(result).toEqual({ ok: true, url: c.url, warnings: c.warnings ?? [] });
    } else {
      expect(c.url, "a case gives either url or error").toBeUndefined();
      if (result.ok) throw new Error(`${c.name}: expected ${c.error}, got ${result.url}`);
      expectError(result.error, c);
    }
  });

  it.each(suite.normalize)("normalize: $name", (c) => {
    const result = normalizeBaseUrl(c.input);
    if (c.error === undefined) {
      expect(result).toEqual({ ok: true, base: c.base, pathEmpty: c.path_empty });
    } else {
      expect(c.base, "a case gives either base or error").toBeUndefined();
      if (result.ok) throw new Error(`${c.name}: expected ${c.error}, got ${result.base}`);
      expectError(result.error, c);
    }
  });

  it.each(suite.strip)("strip: $name", (c) => {
    expect(stripEndpointPath(c.input, c.paths)).toEqual(c.result);
  });

  it.each(suite.add_version_prefix)("add version prefix: $name", (c) => {
    const result = c.prefix === undefined ? addVersionPrefix(c.base) : addVersionPrefix(c.base, c.prefix);
    expect(result).toBe(c.result);
  });

  it.each(suite.header_names)("header name $header", (c) => {
    expect(isValidHeaderName(c.header)).toBe(c.valid);
  });

  it.each(suite.headers)("headers: $name", (c) => {
    const result = requestHeaders(c.auth, c.secret, c.custom);
    if (c.error === undefined) {
      expect(result).toEqual({ ok: true, headers: c.headers });
    } else {
      expect(c.headers, "a case gives either headers or error").toBeUndefined();
      const expected = c.error_header === undefined ? { ok: false, error: c.error } : { ok: false, error: c.error, name: c.error_header };
      expect(result).toEqual(expected);
    }
  });
});

describe("endpoint helpers", () => {
  it("keeps the fixed paths in step with the Rust constants", () => {
    expect(ENDPOINT_PATHS).toEqual({
      chatCompletions: "/chat/completions",
      models: "/models",
      audioTranscriptions: "/audio/transcriptions",
      embeddings: "/embeddings",
      rerank: "/rerank",
    });
  });

  it("strips any of the fixed paths from a pasted full URL", () => {
    const paths = Object.values(ENDPOINT_PATHS);
    expect(stripEndpointPath("https://gw.example.com/llm/audio/transcriptions", paths)).toEqual({
      base: "https://gw.example.com/llm",
      path: "/audio/transcriptions",
    });
  });

  it("sends no auth header with NO_AUTH, and NO_AUTH cannot be changed", () => {
    expect(requestHeaders(NO_AUTH, "sk-test")).toEqual({ ok: true, headers: [] });
    expect(Object.isFrozen(NO_AUTH)).toBe(true);
  });

  it("defaults to the /v1 prefix", () => {
    expect(addVersionPrefix("http://192.168.1.10:8000/")).toBe("http://192.168.1.10:8000/v1");
  });
});
