// The info and error messages of the bookmark suggestions follow the UI language;
// the "info:" prefix that BookmarksTab looks for stays.

import { act, cleanup, renderHook } from "@testing-library/react";
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

const ipc = vi.hoisted(() => ({ generateAssist: vi.fn() }));
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  generateAssist: (...args: unknown[]) => ipc.generateAssist(...args),
}));

import { useBookmarkSuggestions } from "./useBookmarkSuggestions";
import { changeUiLanguage } from "../i18n";

const MEETING = { id: "m1", transcript: [], speakers: [] } as unknown as Meeting;

/** Runs one suggestion round whose answer is `answer`; returns the hook's error afterwards. */
async function suggestWith(answer: string): Promise<string | null> {
  ipc.generateAssist.mockClear();
  const { result } = renderHook(() => useBookmarkSuggestions(MEETING, () => {}));
  await act(async () => {
    await result.current.suggest();
  });
  const requestId = ipc.generateAssist.mock.calls[0][2].requestId as string;
  await act(async () => {
    stream.token!({ token: answer, request_id: requestId });
    await stream.end!({ total_tokens: 1, latency_ms: 1, request_id: requestId, cancelled: false });
  });
  return result.current.error;
}

const NO_MOMENTS = '[{"note":""}]'; // valid JSON, but nothing to bookmark
const PROSE = "I could not find anything here."; // no JSON array at all
const BROKEN = '[{"note": oops}]'; // an array that does not parse

beforeEach(() => {
  stream.token = null;
  stream.end = null;
  ipc.generateAssist.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await changeUiLanguage("en");
});

describe("useBookmarkSuggestions messages", () => {
  it("keeps the original English text", async () => {
    expect(await suggestWith(NO_MOMENTS)).toBe(
      "info:No notable moments found in this meeting. You can add bookmarks manually from the Transcript tab.",
    );
    expect(await suggestWith(PROSE)).toBe(
      "info:This meeting doesn't have enough content to suggest bookmarks. You can add bookmarks manually from the Transcript tab.",
    );
    expect(await suggestWith(BROKEN)).toBe("Couldn't parse bookmark suggestions. Try again.");
  });

  it("is translated in Chinese, keeping the info prefix", async () => {
    await changeUiLanguage("zh-CN");
    expect(await suggestWith(NO_MOMENTS)).toBe(
      "info:这场会议里没有找到值得标记的重要时刻。你可以在“转写记录”标签页里手动添加书签。",
    );
    expect(await suggestWith(PROSE)).toBe(
      "info:这场会议的内容不足以生成书签建议。你可以在“转写记录”标签页里手动添加书签。",
    );
    expect(await suggestWith(BROKEN)).toBe("无法解析书签建议，请重试。");
  });
});
