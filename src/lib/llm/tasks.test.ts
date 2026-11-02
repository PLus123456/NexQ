import { describe, expect, it } from "vitest";
import { normalizeView } from "./connection";
import { emptyView, mockConnection } from "./testing/mockLlmBackend";
import { computeEffective, resolveRoute, tasksUsing } from "./tasks";
import type { LlmConfigView, RouteTarget, TaskRoute } from "./types";

const deepseek = mockConnection({ id: "c_ds", name: "DeepSeek", base_url: "https://api.deepseek.com/v1", default_model: "deepseek-chat" });
const ollama = mockConnection({ id: "c_ol", name: "Ollama", kind: "ollama", base_url: "http://localhost:11434" });
const claude = mockConnection({ id: "c_cl", name: "Claude", kind: "claude_cli" });

const route = (target: RouteTarget | null, params = {}): TaskRoute => ({ target, params });

function view(defaultTarget: RouteTarget | null, tasks: Record<string, TaskRoute> = {}, patch: Partial<LlmConfigView> = {}) {
  return emptyView({ connections: [deepseek, ollama, claude], routing: { default: route(defaultTarget), tasks }, ...patch });
}

describe("resolveRoute", () => {
  it("nothing configured", () => {
    expect(resolveRoute(view(null), "assist").error).toBe("not_configured");
  });

  it("requires a dedicated question detector route and never inherits the default", () => {
    const defaultTarget = { connection_id: "c_ds", model: "deepseek-chat" };
    expect(resolveRoute(view(defaultTarget), "question_detect")).toMatchObject({ error: "not_configured", connection_id: null });
    expect(resolveRoute(view(defaultTarget, { question_detect: route({ connection_id: "c_gone", model: "x" }) }), "question_detect").error).toBe("connection_missing");
    expect(resolveRoute(view(defaultTarget, { question_detect: route({ connection_id: "c_ol", model: "qwen3:1.7b" }) }), "question_detect")).toMatchObject({ error: null, source: "question_detect", connection_id: "c_ol", model: "qwen3:1.7b" });
    expect(resolveRoute(view(defaultTarget, { question_detect: route({ connection_id: "c_cl", model: null }) }), "question_detect")).toMatchObject({ error: "not_configured", kind: "claude_cli" });
  });

  it("follows the parent chain up to default, model from the connection", () => {
    const r = resolveRoute(view({ connection_id: "c_ds", model: null }), "translation_batch");
    expect(r).toMatchObject({ source: "default", connection_id: "c_ds", connection_name: "DeepSeek", model: "deepseek-chat", error: null });
  });

  it("stops at the nearest task with a target", () => {
    const v = view({ connection_id: "c_ds", model: "deepseek-reasoner" }, { translation: route({ connection_id: "c_ol", model: "qwen3:8b" }) });
    expect(resolveRoute(v, "translation_batch")).toMatchObject({ source: "translation", connection_id: "c_ol", model: "qwen3:8b" });
    // assist:<action> follows assist, then default.
    expect(resolveRoute(v, "assist:Shorten")).toMatchObject({ source: "default", model: "deepseek-reasoner" });
  });

  it("a task target whose connection was deleted counts as not set", () => {
    const v = view({ connection_id: "c_ds", model: "deepseek-chat" }, { assist: route({ connection_id: "c_gone", model: "x" }) });
    expect(resolveRoute(v, "assist")).toMatchObject({ source: "default", connection_id: "c_ds" });
    // A default pointing at a deleted connection is reported as such.
    expect(resolveRoute(view({ connection_id: "c_gone", model: null }), "assist").error).toBe("connection_missing");
  });

  it("disabled connection, missing model, missing address", () => {
    expect(
      resolveRoute(view({ connection_id: "c_ds", model: "x" }, {}, { connections: [{ ...deepseek, enabled: false }] }), "assist").error,
    ).toBe("connection_disabled");
    expect(resolveRoute(view({ connection_id: "c_ol", model: null }), "assist").error).toBe("no_model");
    expect(
      resolveRoute(view({ connection_id: "c_ds", model: "x" }, {}, { connections: [{ ...deepseek, base_url: "" }] }), "assist").error,
    ).toBe("base_url_missing");
  });

  it("Claude needs no model, and is no fallback for itself", () => {
    const v = view({ connection_id: "c_cl", model: null });
    expect(resolveRoute(v, "assist")).toMatchObject({ error: null, model: null, kind: "claude_cli" });
    expect(resolveRoute(v, "claude_fallback").error).toBe("no_fallback");
  });
});

describe("effective", () => {
  it("covers every known task and every routed key", () => {
    const v = view({ connection_id: "c_ds", model: null }, { "assist:Recap": route({ connection_id: "c_ol", model: "llama3.2" }) });
    const effective = computeEffective(v);
    expect(Object.keys(effective)).toEqual(expect.arrayContaining(["default", "assist", "translation_batch", "claude_fallback", "assist:Recap"]));
    expect(effective["assist:Recap"]).toMatchObject({ source: "assist:Recap", model: "llama3.2" });
  });

  it("the backend's effective wins over the local resolution", () => {
    const raw = {
      ...view({ connection_id: "c_cl", model: null }),
      effective: {
        default: { source: "claude_fallback", connection_id: "c_ds", connection_name: "DeepSeek", kind: "openai_compat", model: "deepseek-chat", via_fallback: true, error: null },
      },
    };
    expect(normalizeView(raw).effective.default).toMatchObject({ via_fallback: true, connection_id: "c_ds" });
  });
});

describe("tasksUsing", () => {
  it("lists the tasks that name a connection themselves", () => {
    const v = view(
      { connection_id: "c_ds", model: null },
      {
        translation: route({ connection_id: "c_ol", model: null }),
        meeting_summary: route({ connection_id: "c_ds", model: "deepseek-reasoner" }),
      },
    );
    expect(tasksUsing(v, "c_ds")).toEqual(["default", "meeting_summary"]);
    expect(tasksUsing(v, "c_ol")).toEqual(["translation"]);
    expect(tasksUsing(v, "c_cl")).toEqual([]);
  });
});
