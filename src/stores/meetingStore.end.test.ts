import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptSegment } from "../lib/types";

const invoke = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => undefined));
const browserStop = vi.hoisted(() => vi.fn(async (_meetingId: string) => {}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ label: "launcher" }) }));
vi.mock("../lib/webSpeechLifecycle", () => ({ stopMeetingWebSpeech: browserStop }));

import { useMeetingStore } from "./meetingStore";
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

  it("keeps the transcript and permits retry when the launcher drain is not acknowledged", async () => {
    browserStop.mockRejectedValueOnce(new Error("launcher did not acknowledge"));
    await expect(useMeetingStore.getState().endMeetingFlow()).rejects.toThrow("launcher did not acknowledge");
    expect(useMeetingStore.getState().activeMeeting?.id).toBe("m1");
    expect(useMeetingStore.getState().isEndingMeeting).toBe(false);
    expect(saved()).toEqual([]);
    // A peer window's early stop intent is not this window's reentry guard.
    useMeetingStore.setState({ isEndingMeeting: true });
    await useMeetingStore.getState().endMeetingFlow();
    expect(saved()).toEqual(["before stop"]);
    expect(useMeetingStore.getState().activeMeeting).toBeNull();
  });
});
