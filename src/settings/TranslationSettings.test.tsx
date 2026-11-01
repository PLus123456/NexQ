import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => undefined));

vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: Record<string, unknown>) => invoke(cmd, args) }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));

import { TranslationSettings } from "./TranslationSettings";
import { useTranslationStore } from "../stores/translationStore";

function respond(cmd: string): unknown {
  switch (cmd) {
    case "has_api_key":
      return false;
    case "list_opus_mt_models":
      return [];
    case "test_translation_connection":
      return { connected: true, language_count: 0, response_ms: 850, sample: "早上好，各位。" };
    default:
      return undefined;
  }
}

async function renderPage() {
  render(<TranslationSettings />);
  await act(async () => {});
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => respond(cmd));
  useTranslationStore.setState({
    provider: "llm",
    targetLang: "zh-CN",
    sourceLang: "auto",
    endpoints: { deepl: "", microsoft: "", google: "" },
    llm: { systemPrompt: "", userTemplate: "", glossary: "" },
    backendStatus: null,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("TranslationSettings", () => {
  it("shows why the active provider isn't ready", async () => {
    useTranslationStore.setState({
      provider: "deepl",
      backendStatus: { provider: "deepl", ok: false, error: "API key missing for provider: deepl" },
    });
    await renderPage();
    expect(screen.getByText("Active: DeepL · Chinese (Simplified)")).toBeInTheDocument();
    expect(screen.getByText("Not ready: API key missing for provider: deepl")).toBeInTheDocument();
  });

  it("a custom service URL shows where requests go", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /DeepL/ }));
    await act(async () => {});
    fireEvent.change(screen.getByLabelText(/Service URL/), { target: { value: "http://deeplx.lan:1188/v2" } });
    expect(screen.getByText("http://deeplx.lan:1188/v2/translate")).toBeInTheDocument();
    expect(useTranslationStore.getState().endpoints.deepl).toBe("http://deeplx.lan:1188/v2");
    // With a custom address the key is optional, so it can be tested without one.
    expect(screen.getByRole("button", { name: "Test Connection" })).toBeInTheDocument();
  });

  it("the wait before translating can be typed freely and is saved on blur", async () => {
    useTranslationStore.setState({ liveSettleMs: 1200 });
    await renderPage();
    const input = screen.getByLabelText("Wait before translating a line") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.change(input, { target: { value: "2." } });
    expect(useTranslationStore.getState().liveSettleMs).toBe(1200);
    fireEvent.change(input, { target: { value: "2.5" } });
    fireEvent.blur(input);
    expect(useTranslationStore.getState().liveSettleMs).toBe(2500);
    expect(input.value).toBe("2.5");

    // Cleared, or out of range: back to the saved value, or clamped.
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(input.value).toBe("2.5");
    fireEvent.change(input, { target: { value: "0.05" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useTranslationStore.getState().liveSettleMs).toBe(300);
    expect(input.value).toBe("0.3");
  });

  it("LLM translation is tested with a real sentence and the prompts on screen", async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText("Glossary"), { target: { value: "sprint => 冲刺" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Test translation" }));
    });
    const call = invoke.mock.calls.find(([cmd]) => cmd === "test_translation_connection");
    expect(call?.[1]).toMatchObject({ provider: "llm", options: { llm: { glossary: "sprint => 冲刺" } } });
    expect(screen.getByText("“早上好，各位。”")).toBeInTheDocument();
  });
});
