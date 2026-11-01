// The translation step of the first-run wizard: what it writes and the
// status it reports (ok / incomplete / error).

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingAudioConfig, PartyAudioConfig, STTProviderType } from "../../lib/types";

const invoke = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => undefined));

vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: Record<string, unknown>) => invoke(cmd, args) }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));

import { TranslationQuickSetup } from "./TranslationQuickSetup";
import { PartyTranslationPicker } from "./PartyTranslationPicker";
import { useTranslationStore } from "../../stores/translationStore";
import { useConfigStore } from "../../stores/configStore";
import { useMeetingStore } from "../../stores/meetingStore";

function party(role: "You" | "Them", extra: Partial<PartyAudioConfig> = {}): PartyAudioConfig {
  return { role, device_id: "", is_input_device: role === "You", stt_provider: "deepgram", ...extra };
}

function audio(them: Partial<PartyAudioConfig> = {}): MeetingAudioConfig {
  return { you: party("You"), them: party("Them", them), recording_enabled: false, preset_name: null };
}

const SONIOX = "soniox" as STTProviderType;

function lastStatus(spy: ReturnType<typeof vi.fn>) {
  return spy.mock.calls[spy.mock.calls.length - 1];
}

async function renderStep() {
  const onStatusChange = vi.fn();
  render(<TranslationQuickSetup variant="wizard" onStatusChange={onStatusChange} />);
  await act(async () => {});
  return onStatusChange;
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => (cmd === "has_api_key" ? false : undefined));
  useConfigStore.setState({ meetingAudioConfig: audio() });
  useTranslationStore.setState({
    provider: "llm",
    targetLang: "zh-CN",
    translateParties: { you: false, them: true },
    endpoints: { deepl: "", microsoft: "", google: "" },
    llm: { systemPrompt: "", userTemplate: "", glossary: "" },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("TranslationQuickSetup", () => {
  it("LLM translation of the other side is ready as is", async () => {
    const onStatusChange = await renderStep();
    expect(screen.getByText("Translation")).toBeInTheDocument();
    expect(onStatusChange).toHaveBeenCalledTimes(1);
    expect(lastStatus(onStatusChange)).toEqual(["ok", undefined]);
  });

  it("turning translation off is a finished choice", async () => {
    const onStatusChange = await renderStep();
    fireEvent.click(screen.getByRole("switch", { name: "Translate during meetings" }));
    expect(useTranslationStore.getState().translateParties).toEqual({ you: false, them: false });
    expect(lastStatus(onStatusChange)).toEqual(["ok", undefined]);
  });

  it("a service with a key stays incomplete until it is tested", async () => {
    const onStatusChange = await renderStep();
    invoke.mockClear();
    fireEvent.click(screen.getByRole("radio", { name: "DeepL" }));
    await act(async () => {});
    expect(useTranslationStore.getState().provider).toBe("deepl");
    expect(lastStatus(onStatusChange)).toEqual(["incomplete", undefined]);

    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "test_translation_connection") return { connected: true, language_count: 30, response_ms: 120 };
      return cmd === "has_api_key" ? false : undefined;
    });
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "key:fx" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save & Test" }));
    });
    expect(invoke).toHaveBeenCalledWith("store_api_key", { provider: "translation_deepl", key: "key:fx" });
    expect(invoke.mock.calls.find(([c]) => c === "test_translation_connection")?.[1]).toMatchObject({ provider: "deepl" });
    expect(lastStatus(onStatusChange)).toEqual(["ok", undefined]);
  });

  it("a failed test reports the error", async () => {
    useTranslationStore.setState({ provider: "google", endpoints: { deepl: "", microsoft: "", google: "https://proxy.lan/v2" } });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "test_translation_connection") return { connected: false, language_count: 0, response_ms: 5, error: "Google API returned 403" };
      return cmd === "has_api_key" ? false : undefined;
    });
    const onStatusChange = await renderStep();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    });
    expect(lastStatus(onStatusChange)).toEqual(["error", "Google API returned 403"]);
    expect(screen.getByRole("alert")).toHaveTextContent("Google API returned 403");
  });

  it("offers the STT engine's own translation and needs no service then", async () => {
    useConfigStore.setState({ meetingAudioConfig: audio({ stt_provider: SONIOX }) });
    const onStatusChange = await renderStep();
    const native = screen.getByRole("checkbox", { name: /translate while it recognizes/ });
    fireEvent.click(native);
    expect(useConfigStore.getState().meetingAudioConfig?.them.native_translation).toEqual({ mode: "one_way", target_language: "" });
    // Everything is translated by the engine: no service to choose or test.
    expect(screen.queryByRole("radio", { name: "DeepL" })).toBeNull();
    expect(lastStatus(onStatusChange)).toEqual(["ok", undefined]);

    fireEvent.click(native);
    expect(useConfigStore.getState().meetingAudioConfig?.them.native_translation?.mode).toBe("off");
    expect(useTranslationStore.getState().translateParties.them).toBe(true);
  });

  it("links to the full settings", async () => {
    await renderStep();
    useMeetingStore.setState({ currentView: "wizard", settingsTab: null });
    fireEvent.click(screen.getByRole("button", { name: /More settings/ }));
    expect(useMeetingStore.getState().settingsTab).toBe("translation");
  });
});

describe("PartyTranslationPicker", () => {
  it("the engine option needs an engine that translates", () => {
    render(<PartyTranslationPicker />);
    const themNative = screen.getAllByRole("radio", { name: "Speech engine" })[1];
    expect(themNative).toBeDisabled();
    expect(screen.getAllByRole("radio", { name: "Translation service" })[1]).toHaveAttribute("aria-checked", "true");
    expect(screen.getAllByRole("radio", { name: "Off" })[0]).toHaveAttribute("aria-checked", "true");
  });

  it("choosing the engine writes native_translation, choosing off clears both", () => {
    useConfigStore.setState({ meetingAudioConfig: audio({ stt_provider: SONIOX }) });
    render(<PartyTranslationPicker />);
    fireEvent.click(screen.getAllByRole("radio", { name: "Speech engine" })[1]);
    expect(useConfigStore.getState().meetingAudioConfig?.them.native_translation?.mode).toBe("one_way");
    expect(useTranslationStore.getState().translateParties.them).toBe(true);

    fireEvent.click(screen.getAllByRole("radio", { name: "Off" })[1]);
    expect(useConfigStore.getState().meetingAudioConfig?.them.native_translation?.mode).toBe("off");
    expect(useTranslationStore.getState().translateParties.them).toBe(false);
  });
});
