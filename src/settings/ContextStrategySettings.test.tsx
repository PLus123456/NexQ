import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    get: async () => undefined,
    set: async () => {},
    save: async () => {},
    onKeyChange: async () => () => {},
  }),
}));
vi.mock("../hooks/useRagEvents", () => ({ useRagEvents: () => {} }));
vi.mock("../stores/ragStore", () => {
  const state = {
    settings: null,
    loadSettings: async () => {},
    refreshIndexStatus: async () => {},
    updateConfig: async () => {},
  };
  return { useRagStore: (select: (value: typeof state) => unknown) => select(state) };
});

import type { GeminiCacheInfo } from "../lib/ipc";
import { createMockLlmBackend, mockConnection } from "../lib/llm/testing/mockLlmBackend";
import { useConfigStore } from "../stores/configStore";
import { resetLlmConnectionsStoreForTests } from "../stores/llmConnectionsStore";
import { ContextStrategySettings } from "./ContextStrategySettings";

const defaultConnection = mockConnection({
  id: "c_default",
  name: "Default Gemini",
  kind: "gemini",
  base_url: "https://default.example.org",
  default_model: "gemini-default",
});
const assistConnection = mockConnection({
  id: "c_assist",
  name: "Assist Gemini",
  kind: "gemini",
  base_url: "https://assist.example.org",
  default_model: "gemini-other",
});

let externalCacheChanged: () => void;
let active: GeminiCacheInfo | null;

beforeEach(() => {
  useConfigStore.setState({ contextStrategy: "gemini_cache" });
  resetLlmConnectionsStoreForTests();
  active = null;
  const backend = createMockLlmBackend({
    connections: [defaultConnection, assistConnection],
    routing: {
      default: { target: { connection_id: defaultConnection.id, model: null }, params: {} },
      tasks: { assist: { target: { connection_id: assistConnection.id, model: "gemini-assist" }, params: {} } },
    },
  });
  invoke.mockReset().mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "get_gemini_cache_status") return active ? JSON.stringify(active) : null;
    if (cmd === "create_gemini_context_cache") {
      active = {
        name: "cachedContents/test",
        model: String(args.model),
        connection_id: String(args.connectionId),
        expire_time: "2030-01-01T00:00:00Z",
        total_token_count: 123,
      };
      return JSON.stringify(active);
    }
    if (cmd === "delete_gemini_context_cache") {
      active = null;
      return;
    }
    return backend.invoke(cmd, args);
  });
  listen.mockReset().mockImplementation(async (name: string, callback: () => void) => {
    if (name === "gemini_cache_changed") {
      externalCacheChanged = callback;
      return () => {};
    }
    return backend.listen(name, callback);
  });
});

afterEach(() => {
  cleanup();
  useConfigStore.setState({ contextStrategy: "local_rag" });
});

it("uses the Assist route model by default and sends the selected connection to Rust", async () => {
  render(<ContextStrategySettings />);
  const picker = await screen.findByLabelText("Gemini connection");
  expect(picker).toHaveValue(assistConnection.id);
  expect(screen.getByLabelText("Model")).toHaveValue("gemini-assist");
  fireEvent.change(picker, { target: { value: defaultConnection.id } });
  expect(screen.getByLabelText("Model")).toHaveValue("gemini-default");
  fireEvent.click(screen.getByRole("button", { name: "Create Cache from Context Docs" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("create_gemini_context_cache", expect.objectContaining({
    connectionId: defaultConnection.id,
    model: "gemini-default",
    ttlSecs: 3600,
  })));
});

it("refreshes when another window creates a cache and clears that specific resource", async () => {
  render(<ContextStrategySettings />);
  await screen.findByLabelText("Gemini connection");
  active = {
    name: "cachedContents/remote",
    model: "models/gemini-assist",
    connection_id: assistConnection.id,
    expire_time: "2030-01-01T00:00:00Z",
    total_token_count: 123,
  };
  act(externalCacheChanged);
  fireEvent.click(await screen.findByRole("button", { name: "Clear" }));
  expect(invoke).toHaveBeenCalledWith("delete_gemini_context_cache", {
    cacheName: "cachedContents/remote",
    connectionId: assistConnection.id,
  });
  expect(await screen.findByRole("button", { name: "Create Cache from Context Docs" })).toBeEnabled();
});
