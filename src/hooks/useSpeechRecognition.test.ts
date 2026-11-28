import { act, cleanup, renderHook } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const ipc = vi.hoisted(() => ({ push: vi.fn(async () => {}), ensure: vi.fn(async () => ({ active: false, was_drifted: false })) }));
vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/event")>()),
  emit: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));
vi.mock("../lib/ipc", async (original) => ({
  ...await original<typeof import("../lib/ipc")>(),
  pushTranscript: ipc.push,
  ensureIpolicyOverride: ipc.ensure,
}));
import type { MeetingAudioConfig } from "../lib/types";
import { useSpeechRecognition } from "./useSpeechRecognition";
import { useMeetingStore } from "../stores/meetingStore";
import { useConfigStore } from "../stores/configStore";
import { useTranscriptStore } from "../stores/transcriptStore";
import { stopWebSpeechRecognition } from "../lib/webSpeechLifecycle";

const config: MeetingAudioConfig = {
  you: { role: "You", device_id: "default", is_input_device: true, stt_provider: "web_speech" },
  them: { role: "Them", device_id: "default", is_input_device: false, stt_provider: "deepgram" },
  recording_enabled: true,
  preset_name: null,
};

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  static endOnStop = false;
  /** The instances that were started, in order. */
  static started: FakeRecognition[] = [];
  continuous = false;
  interimResults = false;
  lang = "";
  maxAlternatives = 1;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  onstart: (() => void) | null = null;
  start = vi.fn(() => { FakeRecognition.started.push(this); });
  stop = vi.fn(() => { if (FakeRecognition.endOnStop) this.onend?.(); });
  abort = vi.fn();
  constructor() { FakeRecognition.instances.push(this); }
  result(text: string, isFinal = true) {
    this.onresult?.({ resultIndex: 0, results: [{ isFinal, 0: { transcript: text, confidence: 0.9 } }] });
  }
}
const started = FakeRecognition.started;

beforeEach(() => {
  vi.clearAllMocks();
  FakeRecognition.instances = [];
  started.length = 0;
  Object.defineProperty(window, "SpeechRecognition", { configurable: true, value: FakeRecognition });
});

describe("Web Speech language", () => {
  beforeEach(() => {
    FakeRecognition.endOnStop = true;
    useMeetingStore.setState({ isRecording: true, isEndingMeeting: false, audioMode: "online" });
    useConfigStore.setState({ meetingAudioConfig: config, sttLanguage: "en-US" });
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
    useMeetingStore.setState({ isRecording: false });
    useConfigStore.setState({ meetingAudioConfig: null, sttLanguage: "en-US" });
  });

  it("tells the user when Auto-detect silences a running Web Speech side", async () => {
    renderHook(() => useSpeechRecognition());
    expect(started).toHaveLength(1);

    await act(async () => useConfigStore.setState({ sttLanguage: "auto" }));
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      "capture_warning",
      "Stopped transcribing You: Web Speech can't detect the language. " +
      "Pick a language (it applies right away) or choose another provider for You.",
    );

    // Picking a language starts it again, and the warning isn't repeated.
    await act(async () => useConfigStore.setState({ sttLanguage: "uk-UA" }));
    expect(started).toHaveLength(2);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("recognises the language of the side it transcribes, not the shared one", async () => {
    useConfigStore.setState({
      sttLanguage: "en-US",
      meetingAudioConfig: { ...config, you: { ...config.you, language: "es-ES" } },
    });
    renderHook(() => useSpeechRecognition());
    expect(started).toHaveLength(1);
    expect(started[0].lang).toBe("es-ES");

    // The other side's language is not Web Speech's business.
    await act(async () =>
      useConfigStore.setState({
        meetingAudioConfig: { ...config, you: { ...config.you, language: "es-ES" }, them: { ...config.them, language: "fr-FR" } },
      }),
    );
    expect(started).toHaveLength(1);

    // Changing this side's language restarts recognition in the new one.
    await act(async () =>
      useConfigStore.setState({ meetingAudioConfig: { ...config, you: { ...config.you, language: "de-DE" } } }),
    );
    expect(started).toHaveLength(2);
    expect(started[1].lang).toBe("de-DE");

    // Back to "Same as…": the shared language.
    await act(async () => useConfigStore.setState({ meetingAudioConfig: config }));
    expect(started[2].lang).toBe("en-US");
    await act(async () => useConfigStore.setState({ sttLanguage: "it-IT" }));
    expect(started[3].lang).toBe("it-IT");
  });

  it("follows the room side's language when Web Speech transcribes Them", async () => {
    const them: MeetingAudioConfig = {
      ...config,
      you: { ...config.you, stt_provider: "deepgram", language: "en-US" },
      them: { ...config.them, stt_provider: "web_speech", is_input_device: true, language: "pt-BR" },
    };
    useConfigStore.setState({ sttLanguage: "en-US", meetingAudioConfig: them });
    renderHook(() => useSpeechRecognition());
    expect(started[0].lang).toBe("pt-BR");
  });

  it("is silenced by Auto-detect on its own side while the shared language is fixed", async () => {
    renderHook(() => useSpeechRecognition());
    expect(started).toHaveLength(1);
    await act(async () =>
      useConfigStore.setState({ meetingAudioConfig: { ...config, you: { ...config.you, language: "auto" } } }),
    );
    expect(emit).toHaveBeenCalledWith(
      "capture_warning",
      "Stopped transcribing You: Web Speech can't detect the language. " +
      "Pick a language (it applies right away) or choose another provider for You.",
    );
    expect(started).toHaveLength(1);
  });

  it("names the room in an in-person meeting", async () => {
    const room: MeetingAudioConfig = {
      ...config,
      you: { ...config.you, stt_provider: "deepgram" },
      them: { ...config.them, stt_provider: "web_speech", is_input_device: true },
    };
    useMeetingStore.setState({ audioMode: "in_person" });
    useConfigStore.setState({ meetingAudioConfig: room });
    renderHook(() => useSpeechRecognition());
    expect(started).toHaveLength(1);
    await act(async () => useConfigStore.setState({ sttLanguage: "auto" }));
    expect(emit).toHaveBeenCalledWith(
      "capture_warning",
      "Stopped transcribing Room: Web Speech can't detect the language. " +
      "Pick a language (it applies right away) or choose another provider for Room.",
    );
  });

  it("stays quiet when Web Speech was not running", async () => {
    useConfigStore.setState({ sttLanguage: "auto" });
    renderHook(() => useSpeechRecognition());
    await act(async () => useConfigStore.setState({ sttLanguage: "auto", meetingAudioConfig: { ...config } }));
    expect(started).toHaveLength(0);
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("Web Speech meeting end", () => {
  beforeEach(() => {
    FakeRecognition.endOnStop = false;
    vi.useFakeTimers();
    ipc.push.mockReset().mockResolvedValue(undefined);
    ipc.ensure.mockClear();
    useConfigStore.setState({
      meetingAudioConfig: { ...config, you: { ...config.you, language: "en-US" }, recording_enabled: false },
      sttLanguage: "en-US",
    });
    useMeetingStore.setState({ activeMeeting: { id: "m1" } as never, isRecording: true, isEndingMeeting: false, audioMode: "online" });
    useTranscriptStore.getState().clearSegments();
  });
  afterEach(async () => {
    cleanup();
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
    vi.useRealTimers();
    useMeetingStore.setState({ activeMeeting: null, isRecording: false, isEndingMeeting: false });
    useConfigStore.setState({ meetingAudioConfig: null });
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
    expect(FakeRecognition.instances).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); await stopping; });
    const next = FakeRecognition.instances[1];
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

  it("never starts in the system language for Auto-detect", async () => {
    // Web Speech can't detect: a side on Auto-detect stays silent (Rust says so at the start).
    useConfigStore.setState({ meetingAudioConfig: { ...config, you: { ...config.you, language: "auto" } } });
    renderHook(useSpeechRecognition);
    expect(FakeRecognition.instances).toHaveLength(0);
    expect(emit).not.toHaveBeenCalledWith("capture_warning", expect.anything());
  });

  it("aborts the muted side, ignores a stale result, and resumes only after it stops", async () => {
    renderHook(useSpeechRecognition);
    const first = FakeRecognition.instances[0];
    act(() => useConfigStore.setState({ mutedYou: true }));
    expect(first.abort).toHaveBeenCalledTimes(1);
    act(() => first.result("while muted"));
    expect(useTranscriptStore.getState().segments).toEqual([]);
    act(() => useConfigStore.setState({ mutedYou: false }));
    expect(FakeRecognition.instances).toHaveLength(1);
    await act(async () => first.onend?.());
    expect(FakeRecognition.instances).toHaveLength(2);
    act(() => FakeRecognition.instances[1].result("after unmute"));
    expect(useTranscriptStore.getState().segments.map((segment) => segment.text)).toEqual(["after unmute"]);
  });

  it("does not restart after permission, capture, or language errors", async () => {
    const { unmount } = renderHook(useSpeechRecognition);
    const recognition = FakeRecognition.instances[0];
    act(() => {
      recognition.onerror?.({ error: "not-allowed" });
      recognition.onend?.();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(recognition.start).toHaveBeenCalledTimes(1);
    unmount();
  });
});
