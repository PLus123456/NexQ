import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => undefined));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import type { MeetingAudioConfig, PartyAudioConfig } from "../lib/types";
import { captureKey, useAudioConfigSync } from "./useAudioConfigSync";

import { useConfigStore } from "../stores/configStore";
import { useTranslationStore } from "../stores/translationStore";
import { useMeetingStore } from "../stores/meetingStore";
import { DEFAULT_SONIOX_CONFIG } from "../lib/stt/types";

const config = (them: Partial<PartyAudioConfig>): MeetingAudioConfig => ({
  you: { role: "You", device_id: "default", is_input_device: true, stt_provider: "whisper_cpp", language: "zh-CN" },
  them: { role: "Them", device_id: "default", is_input_device: false, stt_provider: "soniox", language: "auto", ...them },
  recording_enabled: false,
  preset_name: null,
});

describe("captureKey", () => {
  it("changes with the translation target while Soniox follows it", () => {
    const cfg = config({ native_translation: { mode: "one_way" } });
    expect(captureKey(cfg, "zh-CN")).not.toBe(captureKey(cfg, "ja"));
  });

  it("ignores the translation target otherwise", () => {
    const own = config({ native_translation: { mode: "one_way", target_language: "en" } });
    expect(captureKey(own, "zh-CN")).toBe(captureKey(own, "ja"));
    const off = config({ native_translation: { mode: "off" } });
    expect(captureKey(off, "zh-CN")).toBe(captureKey(off, "ja"));
    const deepgram = config({ stt_provider: "deepgram", native_translation: { mode: "one_way" } });
    expect(captureKey(deepgram, "zh-CN")).toBe(captureKey(deepgram, "ja"));
    // The plain config key, as before.
    expect(captureKey(off, "zh-CN")).toBe(JSON.stringify(off));
  });
});


describe("active capture settings", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invoke.mockReset().mockResolvedValue(undefined);
    useMeetingStore.setState({ isRecording: true, isEndingMeeting: false, activeMeeting: { id: "m1" } as never });
    useConfigStore.setState({ meetingAudioConfig: config({ native_translation: { mode: "one_way" } }), sonioxConfig: { ...DEFAULT_SONIOX_CONFIG } });
    useTranslationStore.setState({ targetLang: "zh-CN", sourceLang: "auto" });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  const calls = (name: string) => invoke.mock.calls.filter(([cmd]) => cmd === name);
  const changeModel = (model: string) => act(() => {
    useConfigStore.setState({ sonioxConfig: { ...DEFAULT_SONIOX_CONFIG, model } });
  });
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  };

  it("applies Soniox config and the inherited target before starting its new session", async () => {
    renderHook(useAudioConfigSync);
    changeModel("stt-rt-new");
    act(() => useTranslationStore.setState({ targetLang: "ja" }));
    await advance(500);
    expect(invoke.mock.calls.map(([cmd]) => cmd)).toEqual([
      "stop_capture", "update_soniox_config", "set_translation_languages", "start_capture_per_party",
    ]);
    expect(JSON.parse(String(calls("update_soniox_config")[0][1]?.configJson)).model).toBe("stt-rt-new");
    expect(calls("set_translation_languages")[0][1]).toMatchObject({ targetLang: "ja" });
  });

  it("does not postpone the debounce when unrelated translation results arrive", async () => {
    renderHook(useAudioConfigSync);
    changeModel("model-one");
    for (let i = 0; i < 5; i++) {
      await advance(100);
      act(() => useTranslationStore.setState({ batchProgress: { completed: i, total: 5 } }));
    }
    expect(calls("start_capture_per_party")).toHaveLength(1);
  });

  it("does not restart for Soniox edits when neither party uses Soniox", async () => {
    useConfigStore.setState({ meetingAudioConfig: config({ stt_provider: "deepgram" }) });
    renderHook(useAudioConfigSync);
    changeModel("unused-model");
    await advance(1000);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("consumes another edit made while the previous start is in flight", async () => {
    const starting = deferred();
    let starts = 0;
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "start_capture_per_party" && ++starts === 1) await starting.promise;
    });
    renderHook(useAudioConfigSync);
    changeModel("model-one");
    await advance(500);
    changeModel("model-two");
    await advance(500);
    expect(calls("start_capture_per_party")).toHaveLength(1);
    await act(async () => starting.resolve());
    await advance(200);
    expect(calls("start_capture_per_party")).toHaveLength(2);
    expect(calls("update_soniox_config").map(([, args]) => JSON.parse(String(args?.configJson)).model)).toEqual(["model-one", "model-two"]);
  });

  it("does not restart after meeting end begins during stop", async () => {
    const stopping = deferred();
    invoke.mockImplementation(async (cmd) => { if (cmd === "stop_capture") await stopping.promise; });
    renderHook(useAudioConfigSync);
    changeModel("model-one");
    await advance(300);
    act(() => useMeetingStore.setState({ isEndingMeeting: true }));
    await act(async () => stopping.resolve());
    await advance(1000);
    expect(calls("start_capture_per_party")).toHaveLength(0);
  });

  it("stops a start that completes after the meeting has begun ending", async () => {
    const starting = deferred();
    invoke.mockImplementation(async (cmd) => { if (cmd === "start_capture_per_party") await starting.promise; });
    renderHook(useAudioConfigSync);
    changeModel("model-one");
    await advance(500);
    act(() => useMeetingStore.setState({ isEndingMeeting: true }));
    await act(async () => starting.resolve());
    expect(calls("stop_capture").map(([, args]) => args?.keepRecording)).toEqual([true, false]);
  });

  it("scopes stale completion cleanup to the original meeting", async () => {
    const starting = deferred();
    invoke.mockImplementation(async (cmd) => { if (cmd === "start_capture_per_party") await starting.promise; });
    renderHook(useAudioConfigSync);
    changeModel("model-one");
    await advance(500);
    act(() => useMeetingStore.setState({ activeMeeting: { id: "m2" } as never }));
    await act(async () => starting.resolve());
    expect(calls("start_capture_per_party")[0][1]?.expectedMeetingId).toBe("m1");
    expect(calls("stop_capture")[calls("stop_capture").length - 1]?.[1]).toEqual({ keepRecording: false, expectedMeetingId: "m1" });
  });

  it("cancels a debounced restart on unmount or when the edit is reverted", async () => {
    const { unmount } = renderHook(useAudioConfigSync);
    changeModel("model-one");
    changeModel(DEFAULT_SONIOX_CONFIG.model);
    await advance(1000);
    expect(invoke).not.toHaveBeenCalled();
    changeModel("model-two");
    unmount();
    await advance(1000);
    expect(invoke).not.toHaveBeenCalled();
  });
});
