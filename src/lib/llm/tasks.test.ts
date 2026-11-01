import { describe, expect, it } from "vitest";
import { emptyView, mockConnection } from "./testing/mockLlmBackend";
import { resolveRoute, tasksUsing } from "./tasks";
import type { LlmConfigView } from "./types";

const deepseek = mockConnection({ id: "c_ds", name: "DeepSeek", default_model: "deepseek-chat" });
const ollama = mockConnection({ id: "c_ol", name: "Ollama", kind: "ollama" });
const claude = mockConnection({ id: "c_cl", name: "Claude", kind: "claude_cli" });

function view(patch: Partial<LlmConfigView>): LlmConfigView {
  return emptyView({ connections: [deepseek, ollama, claude], ...patch });
}

describe("resolveRoute", () => {
  it("nothing configured", () => {
    expect(resolveRoute(view({}), "assist").problem).toBe("not_configured");
  });

  it("follows the parent chain up to default, model from the connection", () => {
    const v = view({ routing: { default: { connection_id: "c_ds", model: null }, tasks: {} } });
    const r = resolveRoute(v, "translation_batch");
    expect(r.source).toBe("default");
    expect(r.own).toBeNull();
    expect(r.connection?.id).toBe("c_ds");
    expect(r.model).toBe("deepseek-chat");
    expect(r.modelFromConnection).toBe(true);
  });

  it("stops at the nearest task with a target", () => {
    const v = view({
      routing: {
        default: { connection_id: "c_ds", model: "deepseek-reasoner" },
        tasks: { translation: { target: { connection_id: "c_ol", model: "qwen3:8b" }, params: {} } },
      },
    });
    const r = resolveRoute(v, "translation_batch");
    expect(r.source).toBe("translation");
    expect(r.connection?.id).toBe("c_ol");
    expect(r.model).toBe("qwen3:8b");
  });

  it("a target whose connection was deleted counts as not set", () => {
    const v = view({
      routing: {
        default: { connection_id: "c_ds", model: "deepseek-chat" },
        tasks: { assist: { target: { connection_id: "c_gone", model: "x" }, params: {} } },
      },
    });
    const r = resolveRoute(v, "assist");
    expect(r.own).toBeNull();
    expect(r.source).toBe("default");
    expect(r.connection?.id).toBe("c_ds");
  });

  it("a disabled connection is a problem, not a silent switch", () => {
    const v = view({
      connections: [{ ...deepseek, enabled: false }, ollama, claude],
      routing: { default: { connection_id: "c_ds", model: "deepseek-chat" }, tasks: {} },
    });
    expect(resolveRoute(v, "assist").problem).toBe("connection_disabled");
  });

  it("no model anywhere", () => {
    const v = view({ routing: { default: { connection_id: "c_ol", model: null }, tasks: {} } });
    expect(resolveRoute(v, "assist").problem).toBe("no_model");
  });

  it("Claude needs no model, and is no fallback for itself", () => {
    const v = view({ routing: { default: { connection_id: "c_cl", model: null }, tasks: {} } });
    expect(resolveRoute(v, "assist").problem).toBeNull();
    expect(resolveRoute(v, "assist").model).toBeNull();
    expect(resolveRoute(v, "claude_fallback").problem).toBe("no_fallback");
  });
});

describe("tasksUsing", () => {
  it("lists the tasks that name a connection themselves", () => {
    const v = view({
      routing: {
        default: { connection_id: "c_ds", model: null },
        tasks: {
          translation: { target: { connection_id: "c_ol", model: null }, params: {} },
          meeting_summary: { target: { connection_id: "c_ds", model: "deepseek-reasoner" }, params: {} },
        },
      },
    });
    expect(tasksUsing(v, "c_ds")).toEqual(["default", "meeting_summary"]);
    expect(tasksUsing(v, "c_ol")).toEqual(["translation"]);
    expect(tasksUsing(v, "c_cl")).toEqual([]);
  });
});
