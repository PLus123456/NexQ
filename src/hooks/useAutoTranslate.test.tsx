// Live translation, end to end inside one window: transcript events in,
// translate_segments requests out, translation events back into the store.
// Regression: the overlay used to subscribe twice and translate every line
// twice; one final line must cause exactly one request.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingAudioConfig, PartyAudioConfig, STTProviderType, TranscriptSegment } from "../lib/types";

type Handler = (e: { payload: unknown }) => void;
const listeners = vi.hoisted(() => new Map<string, Set<(e: { payload: unknown }) => void>>());
const invoke = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => undefined));
const toast = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: Handler) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name)!.add(cb);
    return () => listeners.get(name)!.delete(cb);
  },
  emit: async () => {},
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: Record<string, unknown>) => invoke(cmd, args) }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));
vi.mock("../stores/toastStore", () => ({ showToast: (...args: unknown[]) => toast(...args) }));

import { useAutoTranslate } from "./useAutoTranslate";
import { useTranslationEvents } from "./useTranslationEvents";
import { useTranslationStore } from "../stores/translationStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useConfigStore } from "../stores/configStore";
import type { Meeting } from "../lib/types";

const SETTLE = 1200;

function AppLevel() {
  useTranslationEvents();
  return null;
}

function OverlayLevel() {
  useAutoTranslate();
  return null;
}

function partyConfig(role: "You" | "Them", extra: Partial<PartyAudioConfig> = {}): PartyAudioConfig {
  return { role, device_id: "", is_input_device: role === "You", stt_provider: "deepgram", ...extra };
}

function audioConfig(them: Partial<PartyAudioConfig> = {}, you: Partial<PartyAudioConfig> = {}): MeetingAudioConfig {
  return { you: partyConfig("You", you), them: partyConfig("Them", them), recording_enabled: false, preset_name: null };
}

function segment(id: string, text: string, speaker: TranscriptSegment["speaker"] = "Them", isFinal = true): TranscriptSegment {
  return { id, text, speaker, timestamp_ms: 1_700_000_000_000, is_final: isFinal, confidence: 0.9 };
}

async function dispatch(name: string, payload: unknown) {
  await act(async () => {
    listeners.get(name)?.forEach((cb) => cb({ payload }));
  });
}

const final = (seg: TranscriptSegment) => dispatch("transcript_final", { segment: seg });
const interim = (seg: TranscriptSegment) => dispatch("transcript_update", { segment: { ...seg, is_final: false } });

async function settle(ms = SETTLE) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

/** The translate_segments calls so far. */
function requests() {
  return invoke.mock.calls.filter(([cmd]) => cmd === "translate_segments").map(([, args]) => args!);
}

async function mount(ui: React.ReactElement) {
  render(ui);
  await act(async () => {}); // let the listeners subscribe
}

beforeEach(() => {
  vi.useFakeTimers();
  listeners.clear();
  invoke.mockReset();
  invoke.mockImplementation(async () => undefined);
  toast.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  useMeetingStore.setState({ activeMeeting: { id: "m1", title: "Standup" } as Meeting, audioMode: "online" });
  useConfigStore.setState({ meetingAudioConfig: audioConfig(), sttLanguage: "en-US" });
  useTranslationStore.getState().clearTranslations();
  useTranslationStore.setState({
    autoTranslateActive: true,
    targetLang: "zh-CN",
    sourceLang: "auto",
    translateParties: { you: false, them: true },
    liveSettleMs: SETTLE,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("live translation requests", () => {
  it("one final line causes exactly one request, however many components mount the hooks", async () => {
    await mount(
      <>
        <AppLevel />
        <OverlayLevel />
        <OverlayLevel />
      </>,
    );
    await final(segment("them_1_acc_1", "Hello everyone"));
    await settle();
    await settle(10_000);

    expect(requests()).toEqual([
      {
        segmentIds: ["them_1_acc_1"],
        texts: ["Hello everyone"],
        meetingId: "m1",
        targetLang: "zh-CN",
        sourceLang: "en-US",
      },
    ]);
    expect(useTranslationStore.getState().translating.has("them_1_acc_1")).toBe(true);
  });

  it("the events hook alone (any other window) never requests translations", async () => {
    await mount(<AppLevel />);
    await final(segment("them_1_acc_1", "Hello"));
    await settle();
    expect(requests()).toEqual([]);
  });

  it("a paragraph the accumulator re-sends as it grows is translated once, with its final text", async () => {
    await mount(<OverlayLevel />);
    await final(segment("them_1_acc_1", "Hello"));
    await interim(segment("them_1_acc_1", "Hello every"));
    await settle(600);
    await final(segment("them_1_acc_1", "Hello everyone"));
    await interim(segment("them_1_acc_1", "Hello everyone, wel"));
    await settle(600);
    await final(segment("them_1_acc_1", "Hello everyone, welcome."));
    await settle();
    expect(requests().map((r) => r.texts)).toEqual([["Hello everyone, welcome."]]);
  });

  it("nothing is requested while translation is off or without a meeting", async () => {
    await mount(<OverlayLevel />);
    useTranslationStore.setState({ autoTranslateActive: false });
    await final(segment("a", "One"));
    await settle();
    useTranslationStore.setState({ autoTranslateActive: true });
    useMeetingStore.setState({ activeMeeting: null });
    await final(segment("b", "Two"));
    await settle();
    expect(requests()).toEqual([]);
  });

  it("translates only the parties chosen in the settings", async () => {
    await mount(<OverlayLevel />);
    await final(segment("you_1", "My line", "User"));
    await final(segment("them_1", "Their line", "Them"));
    await settle();
    expect(requests().map((r) => r.segmentIds)).toEqual([["them_1"]]);

    useTranslationStore.setState({ translateParties: { you: true, them: false } });
    await final(segment("you_2", "Mine again", "User"));
    await final(segment("them_2", "Theirs again", "Them"));
    await settle();
    expect(requests().map((r) => r.segmentIds)).toEqual([["them_1"], ["you_2"]]);
  });

  it("skips a party whose STT engine translates it, and shows the engine's translations", async () => {
    useConfigStore.setState({
      meetingAudioConfig: audioConfig({
        stt_provider: "soniox" as STTProviderType,
        native_translation: { mode: "one_way", target_language: "" },
      }),
    });
    await mount(
      <>
        <AppLevel />
        <OverlayLevel />
      </>,
    );
    await final(segment("them_s_sx1_1", "Bonjour à tous."));
    await settle();
    expect(requests()).toEqual([]);

    // Soniox's translation arrives later and is displayed as is.
    await dispatch("translation_result", {
      segment_id: "them_s_sx1_1",
      original_text: "Bonjour à tous.",
      translated_text: "大家好。",
      source_lang: "fr",
      target_lang: "zh",
      provider: "soniox",
    });
    expect(useTranslationStore.getState().translations.get("them_s_sx1_1")?.translated_text).toBe("大家好。");
  });

  it("the source language is the party's recognition language", async () => {
    useConfigStore.setState({ meetingAudioConfig: audioConfig({ language: "ja-JP" }), sttLanguage: "en-US" });
    await mount(<OverlayLevel />);
    await final(segment("them_1", "こんにちは"));
    await settle();
    expect(requests()[0].sourceLang).toBe("ja-JP");
  });

  it("in person, the user's microphone lines are not translated", async () => {
    useMeetingStore.setState({ audioMode: "in_person" });
    useTranslationStore.setState({ translateParties: { you: true, them: true } });
    await mount(<OverlayLevel />);
    await final(segment("you_1", "Mic line", "User"));
    await final(segment("them_1", "Room line", "Them"));
    await settle();
    expect(requests().map((r) => r.segmentIds)).toEqual([["them_1"]]);
  });
});

describe("results and failures", () => {
  it("an answer for text the line has outgrown is ignored", async () => {
    await mount(
      <>
        <AppLevel />
        <OverlayLevel />
      </>,
    );
    await final(segment("them_1", "Hello"));
    await settle(8000); // still growing: translated after the longest wait
    await final(segment("them_1", "Hello everyone"));
    await settle();
    expect(requests().map((r) => r.texts)).toEqual([["Hello"], ["Hello everyone"]]);

    const answer = (original: string, translated: string) =>
      dispatch("translation_result", {
        segment_id: "them_1",
        original_text: original,
        translated_text: translated,
        source_lang: "en",
        target_lang: "zh-CN",
        provider: "DeepL",
      });
    await answer("Hello everyone", "大家好");
    await answer("Hello", "你好"); // the older request answers last
    const state = useTranslationStore.getState();
    expect(state.translations.get("them_1")?.translated_text).toBe("大家好");
    expect(state.translating.has("them_1")).toBe(false);
  });

  it("a failed request shows on the line and as one toast, not one per line", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "translate_segments") throw "LLM not configured: No active model selected";
      return undefined;
    });
    await mount(<OverlayLevel />);
    await final(segment("them_1", "First"));
    await settle();
    await final(segment("them_2", "Second"));
    await settle();

    const { errors, translating } = useTranslationStore.getState();
    expect(errors.get("them_1")).toBe("LLM not configured: No active model selected");
    expect(errors.get("them_2")).toBe("LLM not configured: No active model selected");
    expect(translating.size).toBe(0);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0]).toBe("Translation failed: LLM not configured: No active model selected");
    expect(toast.mock.calls[0][1]).toBe("error");
  });

  it("a translation_error event marks the line", async () => {
    await mount(<AppLevel />);
    await dispatch("translation_error", { segment_id: "them_9", original_text: "x", error: "HTTP 403: quota" });
    expect(useTranslationStore.getState().errors.get("them_9")).toBe("HTTP 403: quota");
  });

  it("the backend's provider status reaches the store", async () => {
    await mount(<AppLevel />);
    await dispatch("translation_backend_status", { provider: "deepl", ok: false, error: "API key missing for provider: deepl" });
    expect(useTranslationStore.getState().backendStatus).toEqual({
      provider: "deepl",
      ok: false,
      error: "API key missing for provider: deepl",
    });
  });
});
