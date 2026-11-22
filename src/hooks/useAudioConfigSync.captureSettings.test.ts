// NexQ Plus: what the running capture depends on besides the audio config
// (Soniox settings, the translation target an engine translates into), and the
// restart's guards around a meeting that ends meanwhile. The swap itself
// (refusals, one-side language changes) is in useAudioConfigSync.test.ts.
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => undefined));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/event")>()),
  emit: vi.fn(async () => {}),
}));
import type { MeetingAudioConfig, PartyAudioConfig } from "../lib/types";
import { captureKey, useAudioConfigSync } from "./useAudioConfigSync";
import { captureKey as audioConfigKey } from "../lib/audioConfigKeys";

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
    // Nothing of the engines' in it then: the audio config's own key.
    expect(captureKey(off, "zh-CN", undefined, "en-US")).toBe(audioConfigKey(off, "en-US"));
  });

  it("changes with the Soniox settings only while a party uses Soniox", () => {
    const other = { ...DEFAULT_SONIOX_CONFIG, model: "another-model" };
    const soniox = config({});
    expect(captureKey(soniox, "zh-CN", DEFAULT_SONIOX_CONFIG)).not.toBe(captureKey(soniox, "zh-CN", other));
    const deepgram = config({ stt_provider: "deepgram" });
    expect(captureKey(deepgram, "zh-CN", DEFAULT_SONIOX_CONFIG)).toBe(captureKey(deepgram, "zh-CN", other));
  });

  it("changes when the shared language moves a side onto or off Auto-detect", () => {
    const follows = config({ stt_provider: "deepgram", language: undefined });
    expect(captureKey(follows, "zh-CN", undefined, "en-US")).not.toBe(captureKey(follows, "zh-CN", undefined, "auto"));
    // Between two fixed languages the capture stays as it is (as upstream).
    expect(captureKey(follows, "zh-CN", undefined, "en-US")).toBe(captureKey(follows, "zh-CN", undefined, "ja-JP"));
  });
});


describe("active capture settings", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invoke.mockReset().mockResolvedValue(undefined);
    useMeetingStore.setState({ isRecording: true, isEndingMeeting: false, activeMeeting: { id: "m1" } as never, audioMode: "online" });
    useConfigStore.setState({
      meetingAudioConfig: config({ native_translation: { mode: "one_way" } }),
      sonioxConfig: { ...DEFAULT_SONIOX_CONFIG },
      sttLanguage: "en-US",
    });
    useTranslationStore.setState({ targetLang: "zh-CN", sourceLang: "auto" });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    useMeetingStore.setState({ isRecording: false, isEndingMeeting: false, activeMeeting: null });
    useConfigStore.setState({ meetingAudioConfig: null });
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
    // No stop first: Rust checks the new setup, then replaces the running capture itself.
    expect(invoke.mock.calls.map(([cmd]) => cmd)).toEqual([
      "update_soniox_config", "set_translation_languages", "start_capture_per_party",
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

  it("does not start after meeting end begins while the settings are being saved", async () => {
    const saving = deferred();
    invoke.mockImplementation(async (cmd) => { if (cmd === "update_soniox_config") await saving.promise; });
    renderHook(useAudioConfigSync);
    changeModel("model-one");
    await advance(300);
    act(() => useMeetingStore.setState({ isEndingMeeting: true }));
    await act(async () => saving.resolve());
    await advance(1000);
    expect(calls("start_capture_per_party")).toHaveLength(0);
    expect(calls("stop_capture")).toHaveLength(0);
  });

  it("stops a start that completes after the meeting has begun ending", async () => {
    const starting = deferred();
    invoke.mockImplementation(async (cmd) => { if (cmd === "start_capture_per_party") await starting.promise; });
    renderHook(useAudioConfigSync);
    changeModel("model-one");
    await advance(500);
    act(() => useMeetingStore.setState({ isEndingMeeting: true }));
    await act(async () => starting.resolve());
    expect(calls("stop_capture").map(([, args]) => args?.keepRecording)).toEqual([false]);
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

  const setLanguage = (language: string) => act(() => {
    const current = useConfigStore.getState().meetingAudioConfig!;
    useConfigStore.setState({ meetingAudioConfig: { ...current, them: { ...current.them, language } } });
  });

  it("restarts only the Soniox side for a change of its language alone", async () => {
    invoke.mockImplementation(async (cmd) => (cmd === "set_party_language" ? true : undefined));
    renderHook(useAudioConfigSync);
    setLanguage("ja-JP");
    await advance(500);
    // Its Soniox settings and target are the ones the running capture started with.
    expect(invoke.mock.calls.map(([cmd]) => cmd)).toEqual(["set_party_language"]);
    expect(calls("set_party_language")[0][1]).toMatchObject({ party: "them", skipYouStt: false });
    // Rust gets the side's whole config: its engine-side translation goes with the new language.
    expect(JSON.parse(String(calls("set_party_language")[0][1]?.config))).toEqual({
      ...config({ native_translation: { mode: "one_way" } }).them,
      language: "ja-JP",
    });
  });

  it("restarts the whole capture when Rust can't restart the side alone", async () => {
    // E.g. the other side is a Soniox side on Auto-detect, hinted with this side's language.
    invoke.mockImplementation(async (cmd) => (cmd === "set_party_language" ? false : undefined));
    renderHook(useAudioConfigSync);
    setLanguage("ja-JP");
    await advance(500);
    expect(invoke.mock.calls.map(([cmd]) => cmd)).toEqual([
      "set_party_language", "update_soniox_config", "set_translation_languages", "start_capture_per_party",
    ]);
    expect(JSON.parse(String(calls("start_capture_per_party")[0][1]?.themConfig)).language).toBe("ja-JP");
  });

  it("restarts the whole capture when a Soniox setting changes along with the language", async () => {
    invoke.mockImplementation(async (cmd) => (cmd === "set_party_language" ? true : undefined));
    renderHook(useAudioConfigSync);
    setLanguage("ja-JP");
    changeModel("stt-rt-new");
    await advance(500);
    expect(invoke.mock.calls.map(([cmd]) => cmd)).toEqual([
      "update_soniox_config", "set_translation_languages", "start_capture_per_party",
    ]);
  });

  it("applies an edit made during a swap that failed", async () => {
    const starting = deferred();
    let starts = 0;
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "start_capture_per_party" && ++starts === 1) {
        await starting.promise;
        throw "Audio device busy";
      }
    });
    renderHook(useAudioConfigSync);
    changeModel("model-one");
    await advance(500);
    changeModel("model-two");
    await advance(500);
    expect(calls("start_capture_per_party")).toHaveLength(1);
    await act(async () => starting.resolve());
    await advance(300);
    expect(calls("start_capture_per_party")).toHaveLength(2);
    expect(calls("update_soniox_config").map(([, args]) => JSON.parse(String(args?.configJson)).model)).toEqual(["model-one", "model-two"]);
  });
});
