import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockLlmBackend } from "../../lib/llm/testing/mockLlmBackend";

const backend = vi.hoisted(() => ({ current: null as MockLlmBackend | null }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => backend.current!.invoke(cmd, args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (e: { payload: unknown }) => void) => backend.current!.listen(name, cb),
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));

import { changeUiLanguage } from "../../i18n";
import { createMockLlmBackend, mockConnection } from "../../lib/llm/testing/mockLlmBackend";
import { resetLlmConnectionsStoreForTests, useLlmConnectionsStore } from "../../stores/llmConnectionsStore";
import { LlmQuickPicker } from "./LlmQuickPicker";

const deepseek = mockConnection({
  id: "c_0000dee5",
  name: "DeepSeek",
  template: "deepseek",
  base_url: "https://api.deepseek.com",
  default_model: "deepseek-flash",
  manual_models: ["deepseek-v4-pro"],
});
const ollama = mockConnection({
  id: "c_0000011a",
  name: "Home Ollama",
  kind: "ollama",
  template: "ollama",
  base_url: "http://192.168.1.20:11434",
  default_model: "qwen3:8b",
  model_cache: {
    models: [
      { id: "qwen3:8b", name: "qwen3:8b", provider: "ollama", context_window: null },
      { id: "nomic-embed-text", name: "nomic-embed-text", provider: "ollama", context_window: null },
    ],
    fetched_at_ms: 1,
    url: null,
    error: null,
  },
});
const claude = mockConnection({ id: "c_c1aude0", name: "Claude", kind: "claude_cli", template: "claude_cli" });

async function setup() {
  backend.current = createMockLlmBackend({
    connections: [deepseek, ollama, claude],
    routing: {
      default: { target: { connection_id: deepseek.id, model: null }, params: {} },
      tasks: { translation: { target: { connection_id: ollama.id, model: "qwen3:8b" }, params: {} } },
    },
  });
  await act(() => useLlmConnectionsStore.getState().load());
  const onClose = vi.fn();
  const user = userEvent.setup();
  const view = useLlmConnectionsStore.getState().view!;
  render(<LlmQuickPicker view={view} onClose={onClose} />);
  return { user, onClose, backend: backend.current };
}

beforeEach(() => resetLlmConnectionsStoreForTests());
afterEach(async () => {
  cleanup();
  await act(() => changeUiLanguage("en"));
});

describe("LlmQuickPicker", () => {
  it("groups connections and marks the one in use", async () => {
    await setup();
    expect(screen.getByText("Local")).toBeInTheDocument();
    expect(screen.getByText("Cloud")).toBeInTheDocument();
    expect(screen.getByText("Subscription")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /DeepSeek/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("in use")).toBeInTheDocument();
    // The default connection's models, its default first.
    expect(screen.getByRole("button", { name: "deepseek-flash" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "deepseek-v4-pro" })).toBeInTheDocument();
  });

  it("one click on a model makes it the default", async () => {
    const { user, onClose, backend } = await setup();
    await user.click(screen.getByRole("button", { name: "Home Ollama" }));
    // Embedding models aren't offered.
    expect(screen.queryByRole("button", { name: "nomic-embed-text" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "qwen3:8b" }));
    await waitFor(() => expect(backend.view().routing.default.target).toEqual({ connection_id: ollama.id, model: "qwen3:8b" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("any model id can be typed", async () => {
    const { user, backend } = await setup();
    await user.type(screen.getByRole("combobox", { name: "Type another model ID…" }), "deepseek-v5-preview{Enter}");
    await waitFor(() =>
      expect(backend.view().routing.default.target).toEqual({ connection_id: deepseek.id, model: "deepseek-v5-preview" }),
    );
  });

  it("switches to Claude without a model", async () => {
    const { user, backend } = await setup();
    await user.click(screen.getByRole("button", { name: "Claude" }));
    await user.click(screen.getByRole("button", { name: /Use Claude/ }));
    await waitFor(() => expect(backend.view().routing.default.target).toEqual({ connection_id: claude.id, model: null }));
  });

  it("lists tasks that keep their own model", async () => {
    await setup();
    expect(screen.getByText("These tasks have their own model and stay as they are:")).toBeInTheDocument();
    expect(screen.getByText("Live translation")).toBeInTheDocument();
  });

  it("is translated", async () => {
    await act(() => changeUiLanguage("zh-CN"));
    await setup();
    expect(screen.getByText("本地")).toBeInTheDocument();
    expect(screen.getByText("使用中")).toBeInTheDocument();
  });
});
