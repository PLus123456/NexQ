import { describe, expect, it } from "vitest";
import { mockConnection } from "../../lib/llm/testing/mockLlmBackend";
import { connectionToSave, draftOf, draftProblems, isDirty, needsSecretReentry, secretToSave } from "./draft";
import { parseExtraBody } from "./ParamsFields";
import { connectionFromTemplate, findTemplate, PROVIDER_TEMPLATES } from "./providerTemplates";

const saved = mockConnection({
  id: "c_00000001",
  name: "Gateway",
  base_url: "https://api.example.com/v1",
  auth: { mode: "bearer", header_name: "", prefix: "" },
  verified_at_ms: 1000,
});

describe("needsSecretReentry", () => {
  it("only when a saved key could reach a new host or protocol", () => {
    const edit = (patch: Partial<typeof saved>) => draftOf({ ...saved, ...patch });
    expect(needsSecretReentry(edit({ base_url: "https://api.example.com/v2" }), saved, true)).toBe(false);
    expect(needsSecretReentry(edit({ base_url: "https://evil.example.net/v1" }), saved, true)).toBe(true);
    expect(needsSecretReentry(edit({ kind: "anthropic" }), saved, true)).toBe(true);
    expect(needsSecretReentry(edit({ chat_url_override: "https://other.example.org/chat" }), saved, true)).toBe(true);
    expect(
      needsSecretReentry(edit({ models_endpoint: "custom", models_url: "http://10.0.0.9/models" }), saved, true),
    ).toBe(true);
    // No saved key, a new key typed, or the key removed: nothing to protect.
    expect(needsSecretReentry(edit({ base_url: "https://evil.example.net/v1" }), saved, false)).toBe(false);
    expect(
      needsSecretReentry({ ...edit({ base_url: "https://evil.example.net/v1" }), pendingSecret: "sk-new" }, saved, true),
    ).toBe(false);
    expect(
      needsSecretReentry({ ...edit({ base_url: "https://evil.example.net/v1" }), clearSecret: true }, saved, true),
    ).toBe(false);
    // A new connection has nothing saved.
    expect(needsSecretReentry(draftOf(saved, true), null, false)).toBe(false);
  });
});

describe("draftProblems", () => {
  it("lists what blocks saving", () => {
    expect(draftProblems(draftOf(saved), saved, false)).toEqual([]);
    expect(draftProblems(draftOf({ ...saved, base_url: "" }), saved, false)).toEqual(["baseUrlMissing"]);
    // An override alone is enough.
    expect(
      draftProblems(draftOf({ ...saved, base_url: "", chat_url_override: "https://gw.example.com/{model}/chat" }), saved, false),
    ).toEqual([]);
    expect(draftProblems(draftOf({ ...saved, base_url: "api.example.com/v1" }), saved, false)).toEqual(["baseUrlInvalid"]);
    expect(
      draftProblems(draftOf({ ...saved, headers: [{ name: "bad name", value: "x", secret: false }] }), saved, false),
    ).toEqual(["headersInvalid"]);
    expect(draftProblems({ ...draftOf(saved), invalid: ["params"] }, saved, false)).toEqual(["fieldsInvalid"]);
    expect(draftProblems(draftOf({ ...saved, base_url: "https://evil.example.net/v1" }), saved, true)).toEqual(["secretReentry"]);
  });

  it("Claude needs no address", () => {
    const claude = mockConnection({ id: "c_c1aude0", kind: "claude_cli" });
    expect(draftProblems(draftOf(claude, true), null, false)).toEqual([]);
  });
});

describe("isDirty, connectionToSave and secretToSave", () => {
  it("compares the editable fields with the saved connection", () => {
    expect(isDirty(draftOf(saved), saved)).toBe(false);
    expect(isDirty(draftOf({ ...saved, name: "Renamed" }), saved)).toBe(true);
    expect(isDirty({ ...draftOf(saved), pendingSecret: "sk" }, saved)).toBe(true);
    expect(isDirty(draftOf(saved, true), null)).toBe(true);
    // What Rust keeps itself (a fresh model list, a test time) isn't an edit.
    expect(isDirty(draftOf(saved), { ...saved, verified_at_ms: 99, model_cache: { models: [], fetched_at_ms: 1, url: null, error: null } })).toBe(false);
  });

  it("trims the name; the key argument says keep, store or remove", () => {
    expect(connectionToSave(draftOf({ ...saved, name: "  Renamed  " })).name).toBe("Renamed");
    expect(secretToSave(draftOf(saved))).toBeUndefined();
    expect(secretToSave({ ...draftOf(saved), pendingSecret: "sk-new" })).toBe("sk-new");
    expect(secretToSave({ ...draftOf(saved), clearSecret: true })).toBe("");
  });
});

describe("parseExtraBody", () => {
  it("accepts objects without reserved keys", () => {
    expect(parseExtraBody("")).toEqual({ ok: true, value: null });
    expect(parseExtraBody('{"thinking":{"type":"disabled"}}')).toEqual({ ok: true, value: { thinking: { type: "disabled" } } });
    expect(parseExtraBody("{oops")).toMatchObject({ ok: false, error: "invalid" });
    expect(parseExtraBody("[1,2]")).toMatchObject({ ok: false, error: "notObject" });
    expect(parseExtraBody('{"model":"x"}')).toMatchObject({ ok: false, error: "reserved", key: "model" });
  });
});

describe("provider templates", () => {
  it("every template has a unique id and a sane address", () => {
    const ids = PROVIDER_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const template of PROVIDER_TEMPLATES) {
      if (template.baseUrl) expect(template.baseUrl).toMatch(/^https?:\/\/[^/]+/);
      if (template.kind === "anthropic") expect(template.baseUrl).not.toMatch(/\/v1$/);
    }
  });

  it("a connection from a template is pre-filled and editable", () => {
    const zhipu = connectionFromTemplate(findTemplate("zhipu")!, "Zhipu GLM", ["Zhipu GLM"]);
    expect(zhipu.name).toBe("Zhipu GLM 2");
    expect(zhipu.id).toMatch(/^c_[0-9a-f]{8}$/);
    expect(zhipu.base_url).toBe("https://open.bigmodel.cn/api/paas/v4");
    expect(zhipu.auth.mode).toBe("bearer");
    expect(zhipu.template).toBe("zhipu");
    const anthropic = connectionFromTemplate(findTemplate("anthropic")!, "Anthropic", []);
    expect(anthropic.auth).toEqual({ mode: "header", header_name: "x-api-key", prefix: "" });
    expect(anthropic.compat.temperature).toBe("omit");
    expect(connectionFromTemplate(findTemplate("claude_cli")!, "Claude", []).models_endpoint).toBe("disabled");
  });
});
