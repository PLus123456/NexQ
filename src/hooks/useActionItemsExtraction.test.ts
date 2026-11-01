// The toasts and the error of the action-items extraction follow the UI language.

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Meeting, StreamEndEvent, StreamTokenEvent } from "../lib/types";

vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));

// The hook's stream listeners, captured so the test can play the backend.
const stream = vi.hoisted(() => ({
  token: null as ((e: StreamTokenEvent) => void) | null,
  end: null as ((e: StreamEndEvent) => unknown) | null,
}));
vi.mock("../lib/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/events")>()),
  onStreamToken: async (handler: (e: StreamTokenEvent) => void) => {
    stream.token = handler;
    return () => {};
  },
  onStreamEnd: async (handler: (e: StreamEndEvent) => unknown) => {
    stream.end = handler;
    return () => {};
  },
  onStreamError: async () => () => {},
}));

const ipc = vi.hoisted(() => ({ generateAssist: vi.fn(), saveMeetingActionItems: vi.fn() }));
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  generateAssist: (...args: unknown[]) => ipc.generateAssist(...args),
  saveMeetingActionItems: (...args: unknown[]) => ipc.saveMeetingActionItems(...args),
}));

import { useActionItemsExtraction } from "./useActionItemsExtraction";
import { changeUiLanguage } from "../i18n";
import { useMeetingStore } from "../stores/meetingStore";
import { useToastStore } from "../stores/toastStore";

const MEETING = { id: "m1", transcript: [], speakers: [] } as unknown as Meeting;

/** Runs one extraction whose answer is `answer`; resolves when the stream has ended. */
async function extractWith(answer: string) {
  const hook = renderHook(() => useActionItemsExtraction(MEETING, () => {}));
  await act(async () => {
    await hook.result.current.extract();
  });
  const requestId = ipc.generateAssist.mock.calls[0][2].requestId as string;
  await act(async () => {
    stream.token!({ token: answer, request_id: requestId });
    await stream.end!({ total_tokens: 1, latency_ms: 1, request_id: requestId, cancelled: false });
  });
  return hook;
}

const toastMessages = () => useToastStore.getState().toasts.map((t) => [t.type, t.message]);

beforeEach(() => {
  stream.token = null;
  stream.end = null;
  ipc.generateAssist.mockReset().mockResolvedValue(undefined);
  ipc.saveMeetingActionItems.mockReset().mockResolvedValue(undefined);
  useToastStore.setState({ toasts: [] });
  useMeetingStore.setState({ loadRecentMeetings: vi.fn() as never });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await changeUiLanguage("en");
});

describe("useActionItemsExtraction messages", () => {
  it("counts the found items in English", async () => {
    await extractWith('[{"text":"Send the notes"},{"text":"Book a room"}]');
    expect(toastMessages()).toEqual([["success", "Found 2 action items"]]);
    expect(ipc.saveMeetingActionItems).toHaveBeenCalledTimes(1);
  });

  it("uses the singular for one item", async () => {
    await extractWith('[{"text":"Send the notes"}]');
    expect(toastMessages()).toEqual([["success", "Found 1 action item"]]);
  });

  it("says when there is nothing", async () => {
    await extractWith("[]");
    expect(toastMessages()).toEqual([["info", "No action items found in this meeting"]]);
  });

  it("reports an answer it cannot parse", async () => {
    const { result } = await extractWith('I think "nothing" stands out in this meeting at all');
    await waitFor(() => expect(result.current.error).toBe("Couldn't parse action items from AI response. Try again."));
  });

  it("is translated in Chinese", async () => {
    await changeUiLanguage("zh-CN");
    await extractWith('[{"text":"Send the notes"}]');
    expect(toastMessages()).toEqual([["success", "找到 1 项待办事项"]]);

    useToastStore.setState({ toasts: [] });
    ipc.generateAssist.mockClear();
    await extractWith("[]");
    expect(toastMessages()).toEqual([["info", "这场会议里没有找到待办事项"]]);

    ipc.generateAssist.mockClear();
    const { result } = await extractWith('I think "nothing" stands out in this meeting at all');
    await waitFor(() => expect(result.current.error).toBe("无法从 AI 的回复中解析出待办事项，请重试。"));
  });
});
