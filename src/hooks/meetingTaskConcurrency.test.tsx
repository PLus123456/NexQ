import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Meeting } from "../lib/types";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (..._args: unknown[]) => {}),
  generate: vi.fn(async (..._args: unknown[]) => {}),
  saveSummary: vi.fn(async (..._args: unknown[]) => {}),
  saveItems: vi.fn(async (..._args: unknown[]) => {}),
  handlers: new Map<string, Set<(event: any) => unknown>>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../lib/events", () => {
  const listen = (name: string) => async (handler: (event: any) => unknown) => {
    if (!mocks.handlers.has(name)) mocks.handlers.set(name, new Set());
    mocks.handlers.get(name)!.add(handler);
    return () => { mocks.handlers.get(name)?.delete(handler); };
  };
  return { onStreamToken: listen("token"), onStreamEnd: listen("end"), onStreamError: listen("error") };
});
vi.mock("../lib/ipc", () => ({
  generateAssist: mocks.generate,
  updateMeetingSummary: mocks.saveSummary,
  saveMeetingActionItems: mocks.saveItems,
  addMeetingBookmark: vi.fn(),
}));
vi.mock("../stores/meetingStore", () => ({
  useMeetingStore: { getState: () => ({ loadRecentMeetings: vi.fn() }) },
  pastMeetingIdFor: (meeting: Meeting) => meeting.id,
}));
vi.mock("../stores/configStore", () => ({
  useConfigStore: { getState: () => ({ llmProvider: "openai" }) },
}));
import { useSummaryGeneration } from "./useSummaryGeneration";
import { useActionItemsExtraction } from "./useActionItemsExtraction";
import { useBookmarkSuggestions } from "./useBookmarkSuggestions";

const meeting = (id: string) => ({ id, transcript: [], speakers: [] }) as unknown as Meeting;
const emit = async (name: string, event: unknown) => {
  await Promise.all([...mocks.handlers.get(name) ?? []].map((handler) => handler(event)));
};
const cases = [
  { name: "summary", hook: (m: Meeting) => {
    const state = useSummaryGeneration(m);
    return { run: state.generate, cancel: state.cancel, busy: state.isGenerating };
  } },
  { name: "actions", hook: (m: Meeting) => {
    const state = useActionItemsExtraction(m, () => {});
    return { run: state.extract, cancel: state.cancel, busy: state.isExtracting };
  } },
  { name: "bookmarks", hook: (m: Meeting) => {
    const state = useBookmarkSuggestions(m, () => {});
    return { run: state.suggest, cancel: state.cancel, busy: state.isSuggesting };
  } },
];
beforeEach(() => {
  mocks.handlers.clear();
  mocks.invoke.mockClear();
  mocks.generate.mockClear();
  mocks.saveSummary.mockReset().mockResolvedValue(undefined);
  mocks.saveItems.mockClear();
});

describe.each(cases)("$name request isolation", ({ hook }) => {
  it("cancels only its own request, then accepts a fresh request", async () => {
    const view = renderHook(() => hook(meeting("a")));
    await act(async () => { await view.result.current.run(); });
    const first = mocks.generate.mock.calls[0][2] as { requestId: string };
    await act(async () => { view.result.current.cancel(); });
    expect(mocks.invoke).toHaveBeenCalledWith("cancel_generation", { requestId: first.requestId });
    expect(view.result.current.busy).toBe(false);
    await act(async () => { await view.result.current.run(); });
    const second = mocks.generate.mock.calls[1][2] as { requestId: string };
    expect(second.requestId).not.toBe(first.requestId);
    await act(async () => { await emit("end", { request_id: first.requestId, cancelled: true }); });
    expect(view.result.current.busy).toBe(true);
  });

  it("does not send a request cancelled while subscribing", async () => {
    const view = renderHook(() => hook(meeting("a")));
    await act(async () => {
      const pending = view.result.current.run();
      view.result.current.cancel();
      await pending;
    });
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(view.result.current.busy).toBe(false);
  });

  it("cancels and resets on meeting change", async () => {
    const view = renderHook(({ id }) => hook(meeting(id)), { initialProps: { id: "a" } });
    await act(async () => { await view.result.current.run(); });
    const first = mocks.generate.mock.calls[0][2] as { requestId: string };
    view.rerender({ id: "b" });
    expect(mocks.invoke).toHaveBeenCalledWith("cancel_generation", { requestId: first.requestId });
    expect(view.result.current.busy).toBe(false);
    await act(async () => { await view.result.current.run(); });
    expect(mocks.generate).toHaveBeenCalledTimes(2);
  });
});

it("does not apply a summary to a different view when its save completes late", async () => {
  let resolveSave!: () => void;
  mocks.saveSummary.mockImplementation(() => new Promise<void>((resolve) => { resolveSave = resolve; }));
  const saved = vi.fn();
  const view = renderHook(({ id }) => useSummaryGeneration(meeting(id), saved), { initialProps: { id: "a" } });
  await act(async () => { await view.result.current.generate(); });
  const requestId = (mocks.generate.mock.calls[0][2] as { requestId: string }).requestId;
  await act(async () => { await emit("token", { request_id: requestId, token: "Old summary" }); });
  let ending!: Promise<void>;
  act(() => { ending = emit("end", { request_id: requestId, cancelled: false }); });
  await waitFor(() => expect(mocks.saveSummary).toHaveBeenCalledWith("a", "Old summary"));
  view.rerender({ id: "b" });
  await act(async () => { resolveSave(); await ending; });
  expect(saved).not.toHaveBeenCalled();
  expect(view.result.current.isGenerating).toBe(false);
  expect(view.result.current.streamedContent).toBe("");
});
