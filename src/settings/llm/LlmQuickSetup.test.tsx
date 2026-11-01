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
import { resetLlmConnectionsStoreForTests } from "../../stores/llmConnectionsStore";
import { LlmQuickSetup } from "./LlmQuickSetup";

function setup(initial: Parameters<typeof createMockLlmBackend>[0] = {}) {
  backend.current = createMockLlmBackend(initial);
  const onStatusChange = vi.fn();
  const user = userEvent.setup();
  render(<LlmQuickSetup variant="wizard" onStatusChange={onStatusChange} />);
  return { user, onStatusChange, backend: backend.current };
}

beforeEach(() => resetLlmConnectionsStoreForTests());
afterEach(async () => {
  cleanup();
  await act(() => changeUiLanguage("en"));
});

describe("LlmQuickSetup", () => {
  it("falls back to the placeholder in a build without the connection commands", async () => {
    backend.current = createMockLlmBackend();
    backend.current.missing.add("llm_get_config");
    const onStatusChange = vi.fn();
    render(<LlmQuickSetup variant="wizard" onStatusChange={onStatusChange} />);
    expect(await screen.findByRole("button", { name: "Open settings" })).toBeInTheDocument();
    expect(onStatusChange).toHaveBeenCalledWith("incomplete");
  });

  it("tests, then saves the connection with its key as the default", async () => {
    const { user, onStatusChange, backend } = setup();
    await user.click(await screen.findByRole("button", { name: /DeepSeek/ }));
    expect(onStatusChange).toHaveBeenLastCalledWith("incomplete");
    await user.type(screen.getByLabelText("API Key"), "sk-quick-1234{Enter}");
    await user.click(screen.getByRole("button", { name: "Test and save" }));

    await waitFor(() => expect(onStatusChange).toHaveBeenLastCalledWith("ok"));
    const [saved] = backend.view().connections;
    expect(saved).toMatchObject({ template: "deepseek", default_model: "deepseek-flash" });
    expect(saved.verified_at_ms).toEqual(expect.any(Number));
    expect(backend.secrets.get(saved.id)).toBe("sk-quick-1234");
    expect(backend.view().routing.default.target).toEqual({ connection_id: saved.id, model: null });
    expect(await screen.findByText("AI model ready: DeepSeek / deepseek-flash")).toBeInTheDocument();
    // Saved first, then tested by id, so Rust records the success.
    const test = backend.calls.find((c) => c.cmd === "llm_test_connection");
    expect(test?.args).toMatchObject({ id: saved.id, mode: "chat" });
  });

  it("reports a failed test with the error and saves nothing", async () => {
    const { user, onStatusChange, backend } = setup();
    backend.testResult = { ok: false, status: 401, sample: null, error: null, error_body: "invalid api key", hint: "auth_failed" };
    await user.click(await screen.findByRole("button", { name: /DeepSeek/ }));
    await user.click(screen.getByRole("button", { name: "Test and save" }));
    await waitFor(() => expect(onStatusChange).toHaveBeenLastCalledWith("error", "invalid api key"));
    // The connection that didn't answer was removed again.
    expect(backend.view().connections).toHaveLength(0);
    expect(backend.calls.map((c) => c.cmd)).toContain("llm_delete_connection");
    expect(screen.getByText("invalid api key")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save anyway and test later" })).toBeInTheDocument();
  });

  it("checks a local Ollama by fetching its models", async () => {
    const { user, backend } = setup();
    backend.models = [
      { id: "qwen3:8b", name: "qwen3:8b", provider: "ollama", context_window: null },
      { id: "nomic-embed-text", name: "nomic-embed-text", provider: "ollama", context_window: null },
      { id: "llama3.2", name: "llama3.2", provider: "ollama", context_window: null },
    ];
    await user.click(await screen.findByRole("button", { name: /Ollama/ }));
    // Embedding models aren't chat candidates.
    expect(await screen.findByText("Found the server: 2 models available.")).toBeInTheDocument();
    const fetch = backend.calls.find((c) => c.cmd === "llm_fetch_models");
    expect(fetch?.args).toMatchObject({ id: null, draft: { kind: "ollama", base_url: "http://localhost:11434" } });
  });

  it("shows a working default and reports ok", async () => {
    const deepseek = mockConnection({
      id: "c_0000dee5",
      name: "DeepSeek",
      base_url: "https://api.deepseek.com/v1",
      default_model: "deepseek-chat",
      verified_at_ms: 1,
    });
    const { onStatusChange } = setup({
      connections: [deepseek],
      routing: { default: { target: { connection_id: deepseek.id, model: null }, params: {} }, tasks: {} },
    });
    expect(await screen.findByText("AI model ready: DeepSeek / deepseek-chat")).toBeInTheDocument();
    expect(onStatusChange).toHaveBeenCalledWith("ok");
    expect(screen.getByRole("button", { name: "Use another model" })).toBeInTheDocument();
  });
});
