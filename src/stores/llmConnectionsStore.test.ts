import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MockLlmBackend } from "../lib/llm/testing/mockLlmBackend";

const backend = vi.hoisted(() => ({ current: null as MockLlmBackend | null }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => backend.current!.invoke(cmd, args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (e: { payload: unknown }) => void) => backend.current!.listen(name, cb),
}));

import { createMockLlmBackend, mockConnection } from "../lib/llm/testing/mockLlmBackend";
import { resetLlmConnectionsStoreForTests, useLlmConfig, useLlmConnectionsStore } from "./llmConnectionsStore";

const deepseek = mockConnection({ id: "c_00000001", name: "DeepSeek", base_url: "https://api.deepseek.com/v1" });

beforeEach(() => {
  backend.current = createMockLlmBackend({
    revision: 5,
    connections: [deepseek],
    routing: { default: { target: { connection_id: deepseek.id, model: "deepseek-chat" }, params: {} }, tasks: {} },
  });
  resetLlmConnectionsStoreForTests();
});

describe("llmConnectionsStore", () => {
  it("loads itself the first time a component uses it", async () => {
    const { result } = renderHook(() => useLlmConfig());
    await waitFor(() => expect(result.current.loadState).toBe("ready"));
    expect(result.current.view?.connections.map((c) => c.name)).toEqual(["DeepSeek"]);
    expect(backend.current!.calls.filter((c) => c.cmd === "llm_get_config")).toHaveLength(1);

    // A second user doesn't load again.
    renderHook(() => useLlmConfig());
    expect(backend.current!.calls.filter((c) => c.cmd === "llm_get_config")).toHaveLength(1);
  });

  it("follows a change made in the other window", async () => {
    await act(() => useLlmConnectionsStore.getState().load());
    act(() => {
      backend.current!.externalChange({
        connections: [deepseek, mockConnection({ id: "c_00000002", name: "Ollama", kind: "ollama" })],
      });
    });
    const view = useLlmConnectionsStore.getState().view!;
    expect(view.revision).toBe(6);
    expect(view.connections.map((c) => c.name)).toEqual(["DeepSeek", "Ollama"]);
  });

  it("ignores a view older than the one shown", async () => {
    await act(() => useLlmConnectionsStore.getState().load());
    act(() => backend.current!.emit({ ...backend.current!.view(), revision: 3, connections: [] }));
    expect(useLlmConnectionsStore.getState().view!.connections).toHaveLength(1);
    expect(useLlmConnectionsStore.getState().view!.revision).toBe(5);
  });

  it("applies the view a command answers with", async () => {
    await act(() => useLlmConnectionsStore.getState().load());
    // A new connection: sent with an empty id, Rust assigns one; the key travels in the same call.
    const draft = mockConnection({ id: "c_draft001", name: "Ollama", kind: "ollama", base_url: "http://localhost:11434" });
    let id = "";
    await act(async () => {
      id = await useLlmConnectionsStore.getState().upsertConnection(draft, { isNew: true, secret: "k-1234" });
    });
    const upsert = backend.current!.calls.find((c) => c.cmd === "llm_upsert_connection");
    expect(upsert?.args).toMatchObject({ connection: { id: "" }, secret: "k-1234" });
    expect(id).toMatch(/^c_[0-9a-f]{8}$/);
    expect(useLlmConnectionsStore.getState().view!.connections.map((c) => c.id)).toEqual([deepseek.id, id]);
    expect(useLlmConnectionsStore.getState().view!.connections[1].secret_hint).toBe("…1234");

    await act(async () => {
      await useLlmConnectionsStore.getState().setRoute("translation", {
        target: { connection_id: id, model: "qwen3:8b" },
        params: { temperature: 0.2 },
      });
    });
    expect(useLlmConnectionsStore.getState().view!.routing.tasks.translation.target?.model).toBe("qwen3:8b");
    expect(useLlmConnectionsStore.getState().view!.effective.translation_batch).toMatchObject({ source: "translation", model: "qwen3:8b" });

    let cleared: string[] = [];
    await act(async () => {
      cleared = await useLlmConnectionsStore.getState().deleteConnection(id);
    });
    expect(cleared).toEqual(["translation"]);
    // Parameter overrides survive; the task follows its parent again.
    expect(useLlmConnectionsStore.getState().view!.routing.tasks.translation).toEqual({ target: null, params: { temperature: 0.2 } });
  });

  it("points the default route somewhere else and keeps its parameters", async () => {
    await act(() => useLlmConnectionsStore.getState().load());
    act(() => {
      backend.current!.externalChange({
        routing: { default: { target: { connection_id: deepseek.id, model: null }, params: { temperature: 0.5 } }, tasks: {} },
      });
    });
    await act(async () => {
      await useLlmConnectionsStore.getState().setDefaultRoute({ connection_id: deepseek.id, model: "deepseek-reasoner" });
    });
    expect(backend.current!.view().routing.default).toEqual({
      target: { connection_id: deepseek.id, model: "deepseek-reasoner" },
      params: { temperature: 0.5 },
    });
  });

  it("marks the store unavailable when the build has no LLM commands", async () => {
    backend.current!.missing.add("llm_get_config");
    await act(() => useLlmConnectionsStore.getState().load());
    expect(useLlmConnectionsStore.getState().loadState).toBe("unavailable");
  });

  it("reports other load errors and keeps a view it already has", async () => {
    await act(() => useLlmConnectionsStore.getState().load());
    const original = backend.current!.invoke;
    backend.current!.invoke = async (cmd, args) => {
      if (cmd === "llm_get_config") throw "disk on fire";
      return original(cmd, args);
    };
    await act(() => useLlmConnectionsStore.getState().load());
    const state = useLlmConnectionsStore.getState();
    expect(state.loadState).toBe("ready");
    expect(state.loadError).toBe("disk on fire");
    expect(state.view!.connections).toHaveLength(1);
  });

  it("fills in fields the backend left out", async () => {
    backend.current = createMockLlmBackend();
    backend.current.invoke = async () => ({ revision: 2, connections: [{ id: "legacy-ollama", kind: "ollama" }] });
    await act(() => useLlmConnectionsStore.getState().load());
    const [connection] = useLlmConnectionsStore.getState().view!.connections;
    expect(connection.models_endpoint).toBe("auto");
    expect(connection.compat).toMatchObject({ strip_think_tags: true, web_search: "auto", temperature: "pass" });
    expect(connection.manual_models).toEqual([]);
    const view = useLlmConnectionsStore.getState().view!;
    expect(view.routing).toEqual({ default: { target: null, params: {} }, tasks: {} });
    // No effective from the backend: computed here.
    expect(view.effective.assist.error).toBe("not_configured");
    expect(view.known_tasks.map((t) => t.key)).toContain("claude_fallback");
  });
});
