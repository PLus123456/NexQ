import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const ipc = vi.hoisted(() => ({ push: vi.fn(async () => {}), ensure: vi.fn(async () => ({ active: false, was_drifted: false })) }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async () => {}), listen: vi.fn(async () => () => {}) }));
vi.mock("../lib/ipc", async (original) => ({
  ...await original<typeof import("../lib/ipc")>(),
  pushTranscript: ipc.push,
  ensureIpolicyOverride: ipc.ensure,
}));
import type { MeetingAudioConfig } from "../lib/types";
import { useSpeechRecognition, webSpeechLanguage } from "./useSpeechRecognition";
import { useMeetingStore } from "../stores/meetingStore";
import { useConfigStore } from "../stores/configStore";
import { useTranscriptStore } from "../stores/transcriptStore";
import { stopWebSpeechRecognition } from "../lib/webSpeechLifecycle";

const config = (you: Partial<MeetingAudioConfig["you"]>, them: Partial<MeetingAudioConfig["them"]>): MeetingAudioConfig => ({
  you: { role: "You", device_id: "default", is_input_device: true, stt_provider: "web_speech", ...you },
  them: { role: "Them", device_id: "default", is_input_device: false, stt_provider: "deepgram", ...them },
  recording_enabled: false,
  preset_name: null,
});

describe("Web Speech language", () => {
  it("is the language of the party that uses Web Speech", () => {
    expect(webSpeechLanguage(config({ language: "zh-CN" }, { language: "en-US" }), "fr-FR")).toBe("zh-CN");
    expect(
      webSpeechLanguage(
        config({ stt_provider: "deepgram", language: "zh-CN" }, { stt_provider: "web_speech", is_input_device: true, language: "ja-JP" }),
        "fr-FR",
      ),
    ).toBe("ja-JP");
  });

  it("falls back to the global language, and to the system language for auto", () => {
    expect(webSpeechLanguage(config({}, {}), "de-DE")).toBe("de-DE");
    expect(webSpeechLanguage(null, "de-DE")).toBe("de-DE");
    expect(webSpeechLanguage(config({ language: "auto" }, {}), "de-DE")).toBe(navigator.language || "en-US");
  });
});


class FakeRecognition {
  static instances: FakeRecognition[] = [];
  continuous = false;
  interimResults = false;
  lang = "";
  maxAlternatives = 1;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  onstart: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();
  constructor() { FakeRecognition.instances.push(this); }
  result(text: string, isFinal = true) {
    this.onresult?.({ resultIndex: 0, results: [{ isFinal, 0: { transcript: text, confidence: 0.9 } }] });
  }
}

describe("Web Speech meeting end", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeRecognition.instances = [];
    Object.defineProperty(window, "SpeechRecognition", { configurable: true, value: FakeRecognition });
    ipc.push.mockReset().mockResolvedValue(undefined);
    ipc.ensure.mockClear();
    useConfigStore.setState({ meetingAudioConfig: config({ language: "en-US" }, {}) });
    useMeetingStore.setState({ activeMeeting: { id: "m1" } as never, isRecording: true, isEndingMeeting: false, audioMode: "online" });
    useTranscriptStore.getState().clearSegments();
  });
  afterEach(async () => {
    cleanup();
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
    vi.useRealTimers();
  });

  it("stops as ending begins, then keeps the final result until onend and its writes finish", async () => {
    let releaseWrite!: () => void;
    ipc.push.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseWrite = resolve; }));
    renderHook(useSpeechRecognition);
    const recognition = FakeRecognition.instances[0];
    act(() => useMeetingStore.setState({ isEndingMeeting: true }));
    expect(recognition.stop).toHaveBeenCalledTimes(1);
    expect(recognition.abort).not.toHaveBeenCalled();
    let drained = false;
    const stop = stopWebSpeechRecognition().then(() => { drained = true; });
    await act(async () => {
      recognition.result("the last sentence");
      recognition.onend?.();
    });
    expect(useTranscriptStore.getState().segments).toEqual([
      expect.objectContaining({ text: "the last sentence", is_final: true }),
    ]);
    expect(drained).toBe(false);
    await act(async () => { releaseWrite(); await stop; });
    expect(drained).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(recognition.start).toHaveBeenCalledTimes(1);
    expect(recognition.abort).not.toHaveBeenCalled();
  });

  it("bounds a stalled stop and keeps its timeout and late results away from the next meeting", async () => {
    renderHook(useSpeechRecognition);
    const first = FakeRecognition.instances[0];
    act(() => useMeetingStore.setState({ isEndingMeeting: true }));
    const stopping = stopWebSpeechRecognition();
    act(() => useMeetingStore.setState({ activeMeeting: { id: "m2" } as never, isEndingMeeting: false }));
    const next = FakeRecognition.instances[1];
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); await stopping; });
    expect(first.abort).toHaveBeenCalledTimes(1);
    expect(next.abort).not.toHaveBeenCalled();
    act(() => { first.result("stale words"); next.result("new meeting"); });
    expect(useTranscriptStore.getState().segments.map((s) => s.text)).toEqual(["new meeting"]);
  });

  it("does not restart when ending begins during the asynchronous restart check", async () => {
    let release!: (value: { active: boolean; was_drifted: boolean }) => void;
    ipc.ensure.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    renderHook(useSpeechRecognition);
    const recognition = FakeRecognition.instances[0];
    recognition.onend?.();
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    act(() => useMeetingStore.setState({ isEndingMeeting: true }));
    await act(async () => { release({ active: false, was_drifted: false }); });
    expect(recognition.start).toHaveBeenCalledTimes(1);
    expect(FakeRecognition.instances).toHaveLength(1);
  });
});
