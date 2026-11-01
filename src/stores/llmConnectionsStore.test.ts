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
    routing: { default: { connection_id: deepseek.id, model: "deepseek-chat" }, tasks: {} },
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
    const ollama = mockConnection({ id: "c_00000003", name: "Ollama", kind: "ollama" });
    await act(async () => {
      await useLlmConnectionsStore.getState().upsertConnection(ollama);
    });
    expect(useLlmConnectionsStore.getState().view!.connections.map((c) => c.id)).toEqual([deepseek.id, ollama.id]);

    await act(async () => {
      await useLlmConnectionsStore.getState().setRoute("translation", {
        target: { connection_id: ollama.id, model: "qwen3:8b" },
        params: { temperature: 0.2 },
      });
    });
    expect(useLlmConnectionsStore.getState().view!.routing.tasks.translation.target?.model).toBe("qwen3:8b");

    await act(async () => {
      await useLlmConnectionsStore.getState().deleteConnection(ollama.id);
    });
    expect(useLlmConnectionsStore.getState().view!.routing.tasks.translation.target).toBeNull();
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
    expect(connection.models_endpoint).toEqual({ mode: "auto" });
    expect(connection.compat.strip_think_tags).toBe(true);
    expect(connection.manual_models).toEqual([]);
    expect(useLlmConnectionsStore.getState().view!.routing).toEqual({ default: null, tasks: {} });
  });
});
