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
import { DEFAULT_CLAUDE_CLI_CONFIG, useConfigStore } from "../../stores/configStore";
import { resetLlmConnectionsStoreForTests, useLlmConfig } from "../../stores/llmConnectionsStore";
import { ClaudeFallbackRoute } from "./ClaudeFallbackRoute";

const claude = mockConnection({ id: "c_c1aude0", name: "Claude", kind: "claude_cli", template: "claude_cli" });
const ollama = mockConnection({
  id: "c_0000011a",
  name: "Home Ollama",
  kind: "ollama",
  base_url: "http://192.168.1.20:11434",
  default_model: "qwen3:8b",
});

function Harness() {
  const { view } = useLlmConfig();
  return view ? <ClaudeFallbackRoute view={view} /> : null;
}

function setup() {
  backend.current = createMockLlmBackend({
    connections: [claude, ollama],
    routing: { default: { target: { connection_id: claude.id, model: null }, params: {} }, tasks: {} },
  });
  const user = userEvent.setup();
  render(<Harness />);
  return { user, backend: backend.current };
}

beforeEach(() => {
  resetLlmConnectionsStoreForTests();
  useConfigStore.setState({
    claudeCliConfig: { ...DEFAULT_CLAUDE_CLI_CONFIG, fallback_provider: "ollama", fallback_model: "llama3.2" },
  });
});
afterEach(async () => {
  cleanup();
  await act(() => changeUiLanguage("en"));
});

describe("ClaudeFallbackRoute", () => {
  it("shows the earlier fallback while no route is set", async () => {
    setup();
    expect(await screen.findByText("Using the earlier fallback setting: ollama / llama3.2. Pick a connection to replace it.")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Earlier setting (see below)" })).toBeInTheDocument();
    // Claude can't be its own fallback.
    expect(screen.queryByRole("option", { name: "Claude" })).toBeNull();
  });

  it("picking a connection sets the route and retires the earlier setting", async () => {
    const { user, backend } = setup();
    await user.selectOptions(await screen.findByLabelText("Fallback connection"), ollama.id);
    await waitFor(() => expect(backend.view().routing.tasks.claude_fallback?.target).toEqual({ connection_id: ollama.id, model: null }));
    expect(useConfigStore.getState().claudeCliConfig.fallback_provider).toBeNull();
    expect(await screen.findByText("Claude falls back to Home Ollama / qwen3:8b.")).toBeInTheDocument();

    await user.type(screen.getByRole("combobox", { name: "Fallback model" }), "llama3.2{Enter}");
    await waitFor(() => expect(backend.view().routing.tasks.claude_fallback?.target?.model).toBe("llama3.2"));

    await user.selectOptions(screen.getByLabelText("Fallback connection"), "");
    await waitFor(() => expect(backend.view().routing.tasks.claude_fallback).toBeUndefined());
    expect(screen.getByRole("option", { name: "No fallback" })).toBeInTheDocument();
  });
});
