import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptSegment } from "../lib/types";

const invoke = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => undefined));
const browserStop = vi.hoisted(() => vi.fn(async () => {}));
const events = vi.hoisted(() => ({
  emit: vi.fn(async (_name: string, _payload: unknown) => {}),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: events.emit,
  listen: async (name: string, callback: (event: { payload: unknown }) => void) => {
    events.listeners.set(name, callback);
    return () => { events.listeners.delete(name); };
  },
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ label: "launcher" }) }));
vi.mock("../lib/webSpeechLifecycle", () => ({ stopWebSpeechRecognition: browserStop }));

import { attachMeetingWindow, useMeetingStore } from "./meetingStore";
import { useTranscriptStore } from "./transcriptStore";
import { resetSavedSegments } from "../lib/transcriptPersistence";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const line = (id: string): TranscriptSegment => ({ id, text: id, speaker: "Them", is_final: true, timestamp_ms: 1, confidence: 1 });
const saved = () => invoke.mock.calls.filter(([cmd]) => cmd === "append_transcript_segment")
  .map(([, args]) => JSON.parse(String(args?.segment)).text);

beforeEach(() => {
  resetSavedSegments();
  useTranscriptStore.setState({ segments: [line("before stop")] });
  useMeetingStore.setState({ activeMeeting: { id: "m1" } as never, isRecording: true, isEndingMeeting: false, overlayMeetingId: "m1", lastPersistedIndex: 0 });
  invoke.mockReset().mockImplementation(async (cmd) => cmd === "list_meetings" ? "[]" : undefined);
  browserStop.mockReset().mockResolvedValue(undefined);
  events.emit.mockClear();
  events.listeners.clear();
});

describe("meeting end drains speech before saving", () => {
  it("persists native and browser tail results before closing the meeting", async () => {
    const native = deferred();
    const browser = deferred();
    const entered = deferred();
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "stop_capture") { entered.resolve(); await native.promise; }
      if (cmd === "list_meetings") return "[]";
    });
    browserStop.mockImplementation(async () => { await browser.promise; });
    const ending = useMeetingStore.getState().endMeetingFlow();
    await entered.promise;
    expect(useMeetingStore.getState().isEndingMeeting).toBe(true);
    expect(saved()).toEqual([]);
    useTranscriptStore.getState().appendSegment(line("native tail"));
    native.resolve();
    await Promise.resolve();
    expect(saved()).toEqual([]);
    useTranscriptStore.getState().appendSegment(line("browser tail"));
    browser.resolve();
    await ending;
    expect(saved()).toEqual(["before stop", "native tail", "browser tail"]);
    const commands = invoke.mock.calls.map(([cmd]) => cmd);
    expect(commands.lastIndexOf("append_transcript_segment")).toBeLessThan(commands.indexOf("end_meeting"));
    expect(useMeetingStore.getState().activeMeeting).toBeNull();
    expect(useMeetingStore.getState().isEndingMeeting).toBe(false);
  });

  it("keeps the transcript and permits retry when the browser drain fails", async () => {
    browserStop.mockRejectedValueOnce(new Error("browser did not stop"));
    await expect(useMeetingStore.getState().endMeetingFlow()).rejects.toThrow("browser did not stop");
    expect(useMeetingStore.getState().activeMeeting?.id).toBe("m1");
    expect(useMeetingStore.getState().isEndingMeeting).toBe(false);
    expect(saved()).toEqual([]);
    // A peer window's early stop intent is not this window's reentry guard.
    useMeetingStore.setState({ isEndingMeeting: true });
    await useMeetingStore.getState().endMeetingFlow();
    expect(saved()).toEqual(["before stop"]);
    expect(useMeetingStore.getState().activeMeeting).toBeNull();
  });

  it("waits for the overlay's save and applies its speaker merges in one end flow", async () => {
    const detach = attachMeetingWindow();
    try {
      useTranscriptStore.setState({ segments: [{ ...line("speech"), speaker_id: "speaker_1" }] });
      const ending = useMeetingStore.getState().endMeetingFlow();
      expect(useMeetingStore.getState().endMeetingFlow()).toBe(ending);
      const saveRequest = () => events.emit.mock.calls.find(([name]) => name === "nexq:save_overlay_meeting");
      await vi.waitFor(() => expect(saveRequest()).toBeDefined());
      const request = saveRequest()![1] as { requestId: string };
      const reply = events.listeners.get("nexq:overlay_meeting_saved")!;
      reply({ payload: { ...request, meetingId: "old" } });
      expect(invoke.mock.calls.some(([name]) => name === "end_meeting")).toBe(false);
      reply({ payload: { ...request, meetingId: "m1", speakerAliases: [["speaker_1", "speaker_2"]] } });
      await ending;

      const appended = invoke.mock.calls.find(([name]) => name === "append_transcript_segment");
      expect(JSON.parse(String(appended?.[1]?.segment))).toMatchObject({ speaker_id: "speaker_2" });
      expect(invoke.mock.calls.filter(([name]) => name === "stop_capture")).toHaveLength(1);
      expect(invoke.mock.calls.filter(([name]) => name === "end_meeting")).toHaveLength(1);
      expect(events.emit).toHaveBeenCalledWith("nexq:meeting_ended", { meetingId: "m1", window: "launcher" });
    } finally {
      detach();
    }
  });
});
