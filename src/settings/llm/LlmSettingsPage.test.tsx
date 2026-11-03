import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
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
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
// The classic page has its own tests; here it only has to show up.
vi.mock("../LLMSettings", () => ({ LLMSettings: () => <div>classic provider settings</div> }));

import { changeUiLanguage } from "../../i18n";
import { createMockLlmBackend, mockConnection } from "../../lib/llm/testing/mockLlmBackend";
import { resetLlmConnectionsStoreForTests } from "../../stores/llmConnectionsStore";
import { LlmSettingsPage } from "./LlmSettingsPage";

const deepseek = mockConnection({
  id: "c_0000dee5",
  name: "DeepSeek",
  template: "deepseek",
  base_url: "https://api.deepseek.com/v1",
  auth: { mode: "bearer", header_name: "", prefix: "" },
  default_model: "deepseek-chat",
});
const ollama = mockConnection({
  id: "c_0000011a",
  name: "Home Ollama",
  template: "ollama",
  kind: "ollama",
  base_url: "http://192.168.1.20:11434",
  default_model: "qwen3:8b",
});

function setup(initial: Parameters<typeof createMockLlmBackend>[0] = {}) {
  backend.current = createMockLlmBackend(initial);
  const user = userEvent.setup();
  render(<LlmSettingsPage />);
  return { user, backend: backend.current };
}

beforeEach(() => {
  resetLlmConnectionsStoreForTests();
});

afterEach(async () => {
  cleanup();
  await act(() => changeUiLanguage("en"));
});

describe("LlmSettingsPage", () => {
  it("shows the classic settings when the build has no connection commands", async () => {
    backend.current = createMockLlmBackend();
    backend.current.missing.add("llm_get_config");
    render(<LlmSettingsPage />);
    expect(await screen.findByText("classic provider settings")).toBeInTheDocument();
  });

  it("adds a connection from a template, saves its key and makes it the default", async () => {
    const { user, backend } = setup();
    // No connections yet: the template picker opens right away.
    expect(await screen.findByText("Add a connection")).toBeInTheDocument();
    expect(screen.getByText("No default model yet")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /DeepSeek/ }));
    expect(screen.getByLabelText<HTMLInputElement>("Connection name").value).toBe("DeepSeek");
    expect(screen.getByLabelText<HTMLInputElement>("Base URL").value).toBe("https://api.deepseek.com");
    // The address the request really goes to; DeepSeek needs no version prefix, so no "/v1" hint.
    expect(screen.getByText("https://api.deepseek.com/chat/completions")).toBeInTheDocument();
    expect(screen.queryByText(/need a version prefix/)).toBeNull();

    await user.type(screen.getByLabelText("API Key"), "sk-secret-1234{Enter}");
    expect(screen.getByText("The new key is saved when you click Save.")).toBeInTheDocument();
    // Templates name no model: the user types one.
    await user.type(screen.getByLabelText("Default model"), "deepseek-flash{Enter}");

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(backend.view().connections).toHaveLength(1));
    const saved = backend.view().connections[0];
    expect(saved.name).toBe("DeepSeek");
    expect(saved.template).toBe("deepseek");
    expect(saved.default_model).toBe("deepseek-flash");
    expect(backend.secrets.get(saved.id)).toBe("sk-secret-1234");
    await waitFor(() => expect(backend.view().routing.default.target).toEqual({ connection_id: saved.id, model: null }));
    // Created with an empty id and the key in the same call.
    expect(backend.calls.find((c) => c.cmd === "llm_upsert_connection")?.args).toMatchObject({ connection: { id: "" }, secret: "sk-secret-1234" });
    expect(await screen.findByText("Default: DeepSeek / deepseek-flash")).toBeInTheDocument();
    expect(screen.getByText("All changes saved")).toBeInTheDocument();
  });

  it("asks for the key again before a saved key could go to a new host", async () => {
    const { user, backend } = setup({
      connections: [deepseek],
      routing: { default: { target: { connection_id: deepseek.id, model: null }, params: {} }, tasks: {} },
    });
    backend.secrets.set(deepseek.id, "sk-old-9999");
    const baseUrl = await screen.findByLabelText<HTMLInputElement>("Base URL");

    // A path change on the same host is fine.
    await user.clear(baseUrl);
    await user.type(baseUrl, "https://api.deepseek.com");
    expect(screen.queryByText(/The protocol or the host changed/)).toBeNull();

    // Another host: the saved key must be typed again.
    await user.clear(baseUrl);
    await user.type(baseUrl, "https://proxy.example.com/v1");
    expect(screen.getByText(/The protocol or the host changed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Test chat/ })).toBeDisabled();

    await user.type(screen.getByLabelText("API Key"), "sk-new-0000{Enter}");
    expect(screen.queryByText(/The protocol or the host changed/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(backend.view().connections[0].base_url).toBe("https://proxy.example.com/v1"));
    expect(backend.secrets.get(deepseek.id)).toBe("sk-new-0000");
    // The new key travels with the new address, in one call.
    expect(backend.calls.filter((c) => c.cmd === "llm_set_secret")).toHaveLength(0);
    expect(backend.calls.find((c) => c.cmd === "llm_upsert_connection")?.args).toMatchObject({
      connection: { id: deepseek.id, base_url: "https://proxy.example.com/v1" },
      secret: "sk-new-0000",
    });
  });

  it("undoing the address change keeps the saved key", async () => {
    const { user, backend } = setup({ connections: [deepseek] });
    backend.secrets.set(deepseek.id, "sk-old-9999");
    const baseUrl = await screen.findByLabelText<HTMLInputElement>("Base URL");
    await user.clear(baseUrl);
    await user.type(baseUrl, "https://proxy.example.com/v1");
    await user.click(screen.getByRole("button", { name: "Undo address change" }));
    expect(baseUrl.value).toBe("https://api.deepseek.com/v1");
    expect(screen.getByText("All changes saved")).toBeInTheDocument();
  });

  it("test chat shows the real address, status and the raw error", async () => {
    const { user, backend } = setup({ connections: [deepseek] });
    backend.testResult = {
      ok: false,
      url: "https://api.deepseek.com/v1/chat/completions",
      status: 401,
      latency_ms: 230,
      sample: null,
      error: "HTTP 401 Unauthorized",
      error_body: '{"error":{"message":"Authentication Fails (no such user)"}}',
      hint: "auth_failed",
    };
    await user.click(await screen.findByRole("button", { name: /Test chat/ }));
    const result = await screen.findByRole("status");
    expect(within(result).getByText("Failed")).toBeInTheDocument();
    expect(within(result).getByText(/HTTP 401 · 230 ms/)).toBeInTheDocument();
    expect(within(result).getByText("HTTP 401 Unauthorized")).toBeInTheDocument();
    expect(within(result).getByText("https://api.deepseek.com/v1/chat/completions")).toBeInTheDocument();
    expect(within(result).getByText(/Authentication Fails/)).toBeInTheDocument();
    expect(within(result).getByText(/The server rejected the key/)).toBeInTheDocument();
    // A saved connection without edits is tested by id (Rust records a success).
    const test = backend.calls.find((c) => c.cmd === "llm_test_connection");
    expect(test?.args).toMatchObject({ id: deepseek.id, draft: null, model: "deepseek-chat", mode: "chat" });

    backend.testResult = { ok: true, url: "https://api.deepseek.com/v1/chat/completions", status: 200, latency_ms: 412, sample: "pong" };
    await user.click(screen.getByRole("button", { name: /Test chat/ }));
    expect(await screen.findByText("It works")).toBeInTheDocument();
    expect(screen.getByText("pong")).toBeInTheDocument();
  });

  it("routes a task to its own connection and model", async () => {
    const { user, backend } = setup({
      connections: [deepseek, ollama],
      routing: { default: { target: { connection_id: deepseek.id, model: null }, params: {} }, tasks: {} },
    });
    await user.click(await screen.findByRole("tab", { name: "Task routing" }));

    // Every task follows the default until it gets its own connection.
    expect(screen.getAllByText("Follows Default → DeepSeek / deepseek-chat").length).toBeGreaterThan(5);

    const translationRow = screen.getByText("Live translation").closest("div.rounded-lg") as HTMLElement;
    await user.selectOptions(within(translationRow).getByLabelText("Connection"), ollama.id);
    await waitFor(() =>
      expect(backend.view().routing.tasks.translation?.target).toEqual({ connection_id: ollama.id, model: null }),
    );
    expect(within(translationRow).getByText("→ Home Ollama / qwen3:8b")).toBeInTheDocument();

    const model = within(translationRow).getByRole("combobox", { name: "Model for Live translation" });
    await user.type(model, "qwen3:1.7b{Enter}");
    await waitFor(() => expect(backend.view().routing.tasks.translation?.target?.model).toBe("qwen3:1.7b"));

    // Batch translation follows live translation.
    expect(screen.getByText("Follows Live translation → Home Ollama / qwen3:1.7b")).toBeInTheDocument();

    // Back to following the default.
    await user.selectOptions(within(translationRow).getByLabelText("Connection"), "");
    await waitFor(() => expect(backend.view().routing.tasks.translation).toBeUndefined());
  });

  it("routes a single AI action", async () => {
    const { user, backend } = setup({
      connections: [deepseek, ollama],
      routing: { default: { target: { connection_id: deepseek.id, model: null }, params: {} }, tasks: {} },
    });
    await user.click(await screen.findByRole("tab", { name: "Task routing" }));
    await user.click(screen.getByRole("button", { name: "Set per AI action" }));
    const row = screen.getByText("What to say").closest("div.rounded-lg") as HTMLElement;
    // Neither the action nor AI assist has a route: the default answers.
    expect(within(row).getByText("Follows Default → DeepSeek / deepseek-chat")).toBeInTheDocument();
    expect(within(row).getByRole("option", { name: "Follow AI assist" })).toBeInTheDocument();
    await user.selectOptions(within(row).getByLabelText("Connection"), ollama.id);
    await waitFor(() =>
      expect(backend.view().routing.tasks["assist:WhatToSay"]?.target).toEqual({ connection_id: ollama.id, model: null }),
    );
    expect(screen.getByRole("button", { name: "Per AI action (1 set)" })).toBeInTheDocument();
  });

  it("requires a dedicated HTTP connection for sentence-by-sentence question detection", async () => {
    const subscription = mockConnection({ id: "claude-subscription", name: "Claude subscription", kind: "claude_cli" });
    const { user } = setup({
      connections: [deepseek, subscription],
      routing: { default: { target: { connection_id: deepseek.id, model: null }, params: {} }, tasks: {} },
    });
    await user.click(await screen.findByRole("tab", { name: "Task routing" }));
    const row = screen.getByText("Question detection").closest("div.rounded-lg") as HTMLElement;
    expect(within(row).getByRole("option", { name: "Claude subscription" })).toBeDisabled();
    expect(within(row).getByRole("option", { name: "Not configured — use rules" })).toBeInTheDocument();
    expect(within(row).getByText("Rules only until a connection is chosen for this task.")).toBeInTheDocument();
    const assist = screen.getByText("AI assist").closest("div.rounded-lg") as HTMLElement;
    expect(within(assist).getByRole("option", { name: "Claude subscription" })).toBeEnabled();
  });

  it("picks an OpenRouter model from its catalog", async () => {
    const openrouter = mockConnection({
      id: "c_0000a0a0",
      name: "OpenRouter",
      template: "openrouter",
      base_url: "https://openrouter.ai/api/v1",
      auth: { mode: "bearer", header_name: "", prefix: "" },
    });
    const { user, backend } = setup({ connections: [openrouter] });
    const original = backend.invoke;
    backend.invoke = async (cmd, args) => {
      if (cmd !== "list_openrouter_models") return original(cmd, args);
      backend.calls.push({ cmd, args });
      const model = (id: string, name: string, free: boolean) => ({
        id, name, provider_name: id.split("/")[0], description: `${name} model`, created: 1_790_000_000,
        context_length: 1_000_000, max_completion_tokens: null,
        pricing: free ? { prompt: 0, completion: 0 } : { prompt: 0.3, completion: 1.2 },
        is_free: free, modality: "text->text", input_modalities: ["text"], output_modalities: ["text"],
        tokenizer: "", supports_tools: true, supports_reasoning: !free, supports_web_search: false,
      });
      return JSON.stringify([model("deepseek/deepseek-v4.1-flash", "DeepSeek V4.1 Flash", false), model("google/gemma-4-31b-it:free", "Gemma 4 31B", true)]);
    };
    await user.click(await screen.findByRole("button", { name: "Browse the OpenRouter catalog" }));
    expect(await screen.findByText("DeepSeek V4.1 Flash")).toBeInTheDocument();
    // The saved connection's key lists the catalog.
    expect(backend.calls.find((c) => c.cmd === "list_openrouter_models")?.args).toMatchObject({ connectionId: openrouter.id });
    await user.click(screen.getByText("DeepSeek V4.1 Flash"));
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(backend.view().connections[0].default_model).toBe("deepseek/deepseek-v4.1-flash"));
  });

  it("follows a change made in the other window", async () => {
    const { backend } = setup({ connections: [deepseek] });
    expect(await screen.findByLabelText("Connection name")).toBeInTheDocument();
    act(() => {
      backend.externalChange({ connections: [deepseek, ollama] });
    });
    expect(await screen.findByText("Home Ollama")).toBeInTheDocument();
  });

  it("is translated", async () => {
    await act(() => changeUiLanguage("zh-CN"));
    setup({ connections: [deepseek], routing: { default: { target: { connection_id: deepseek.id, model: null }, params: {} }, tasks: {} } });
    expect(await screen.findByRole("tab", { name: "任务路由" })).toBeInTheDocument();
    expect(screen.getByText("默认：DeepSeek / deepseek-chat")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /测试对话/ })).toBeInTheDocument();
  });
});
