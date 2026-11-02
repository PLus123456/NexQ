import { afterEach, beforeEach, expect, it, vi } from "vitest";
const eventBus = vi.hoisted(() => new Map<string, Set<(event: { payload: unknown }) => void>>());
const webview = vi.hoisted(() => ({ label: "overlay" }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => webview }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: (event: { payload: unknown }) => void) => {
    if (!eventBus.has(name)) eventBus.set(name, new Set());
    eventBus.get(name)!.add(cb);
    return () => { eventBus.get(name)?.delete(cb); };
  },
  emit: async (name: string, payload: unknown) => {
    for (const cb of [...eventBus.get(name) ?? []]) cb({ payload });
  },
}));
import { onWebSpeechStopRequest, registerWebSpeechStop, stopMeetingWebSpeech } from "./webSpeechLifecycle";

beforeEach(() => { eventBus.clear(); webview.label = "overlay"; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it("waits in the overlay for the launcher's matching stop acknowledgement", async () => {
  let finish!: () => void;
  const unregister = registerWebSpeechStop(() => new Promise((resolve) => { finish = resolve; }));
  const begin = vi.fn((meetingId: string) => meetingId === "m1");
  const unlisten = await onWebSpeechStopRequest(begin);
  let done = false;
  const stopped = stopMeetingWebSpeech("m1").then(() => { done = true; });
  await vi.advanceTimersByTimeAsync(0);
  expect(begin).toHaveBeenCalledWith("m1");
  expect(done).toBe(false);
  finish();
  await stopped;
  expect(done).toBe(true);
  expect(eventBus.get("nexq:web_speech_stopped")?.size).toBe(0);
  unregister(); unlisten();
});

it("does not save through a missing or mismatched launcher acknowledgement", async () => {
  const unlisten = await onWebSpeechStopRequest((meetingId) => meetingId === "different-meeting");
  const stopped = stopMeetingWebSpeech("no-ack-meeting");
  const rejected = expect(stopped).rejects.toThrow("Timed out waiting");
  await vi.advanceTimersByTimeAsync(3000);
  await rejected;
  expect(eventBus.get("nexq:web_speech_stopped")?.size).toBe(0);
  unlisten();
});


it("acknowledges a drained previous meeting without stopping the new one", async () => {
  webview.label = "launcher";
  await stopMeetingWebSpeech("completed-meeting");
  const stopNew = vi.fn(async () => {});
  const unregister = registerWebSpeechStop(stopNew);
  const unlisten = await onWebSpeechStopRequest(() => false);
  webview.label = "overlay";
  await stopMeetingWebSpeech("completed-meeting");
  expect(stopNew).not.toHaveBeenCalled();
  unregister(); unlisten();
});
