import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Meeting, StreamUsage } from "../lib/types";

type Handler = (payload: unknown) => void;
const { handlers, register } = vi.hoisted(() => {
  const handlers: Record<string, Handler> = {};
  const register = (name: string) => (handler: Handler) => {
    handlers[name] = handler;
    return Promise.resolve(() => {
      delete handlers[name];
    });
  };
  return { handlers, register };
});

vi.mock("../lib/events", () => ({
  onStreamStart: register("start"),
  onStreamToken: register("token"),
  onStreamThinking: register("thinking"),
  onStreamEnd: register("end"),
  onStreamError: register("error"),
}));

const ipc = vi.hoisted(() => ({ saveMeetingAiInteractions: vi.fn() }));
vi.mock("../lib/ipc", () => ({
  saveMeetingAiInteractions: (...args: unknown[]) => ipc.saveMeetingAiInteractions(...args),
}));

import { STALL_TIMEOUT_MS, useCallLogCapture } from "./useCallLogCapture";
import { STALLED_MESSAGE, useCallLogStore } from "../stores/callLogStore";
import { useMeetingStore } from "../stores/meetingStore";

const start = (request_id: string, over: Record<string, unknown> = {}) =>
  handlers.start({
    mode: "Assist",
    model: "haiku",
    provider: "Claude (subscription)",
    system_prompt: "sp",
    user_prompt: "up",
    include_transcript: true,
    include_rag: false,
    include_instructions: false,
    include_question: false,
    temperature: 0.3,
    rag_query: null,
    rag_chunks: [],
    rag_chunks_filtered: 0,
    rag_total_candidates: 0,
    transcript_window_seconds: 0,
    transcript_segments_count: 1,
    transcript_segments_total: 1,
    request_id,
    session_key: "live:m1:fast",
    ...over,
  });

const USAGE: StreamUsage = {
  input_tokens: 10,
  cache_read_tokens: 4000,
  cache_write_tokens: 190,
  output_tokens: 38,
  thinking_tokens: 0,
  cost_usd: 0.0021,
  first_token_ms: 640,
};

const entry = () => useCallLogStore.getState().entries[0];

describe("useCallLogCapture", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useCallLogStore.setState({ entries: [] });
    useMeetingStore.setState({ activeMeeting: { id: "m1" } as Meeting });
    ipc.saveMeetingAiInteractions.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    useMeetingStore.setState({ activeMeeting: null });
  });

  async function mount() {
    renderHook(() => useCallLogCapture());
    await act(async () => {});
    expect(handlers.end).toBeDefined();
  }

  it("persists a replayed Assist answer but never the prediction or unused preparation diagnostics", async () => {
    await mount();
    act(() => {
      start("prediction", { mode: "question_predict" });
      handlers.token({ token: "Speculative question", request_id: "prediction" });
      handlers.end({ total_tokens: 3, latency_ms: 10, request_id: "prediction", cancelled: false });
      start("preparation", { mode: "question_prepare" });
      handlers.token({ token: "Unused answer", request_id: "preparation" });
      handlers.end({ total_tokens: 3, latency_ms: 10, request_id: "preparation", cancelled: false });
    });
    expect(ipc.saveMeetingAiInteractions).not.toHaveBeenCalled();
    act(() => {
      start("replayed", { prepared: true });
      handlers.token({ token: "Prepared answer now used", request_id: "replayed" });
      handlers.end({ total_tokens: 0, latency_ms: 0, request_id: "replayed", cancelled: false });
    });
    const saved = JSON.parse(ipc.saveMeetingAiInteractions.mock.calls[0][1]);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ mode: "Assist", response: "Prepared answer now used" });
  });

  it("keeps concurrent meeting tasks in the log without saving them into the live meeting", async () => {
    await mount();
    act(() => {
      start("live");
      start("summary", { mode: "MeetingSummary", session_key: "past:old:deep" });
      handlers.token({ token: "Old summary", request_id: "summary" });
      handlers.token({ token: "Live answer", request_id: "live" });
      handlers.end({ total_tokens: 3, latency_ms: 10, request_id: "summary", cancelled: false });
    });
    expect(ipc.saveMeetingAiInteractions).not.toHaveBeenCalled();
    act(() => handlers.end({ total_tokens: 3, latency_ms: 10, request_id: "live", cancelled: false }));
    const saved = JSON.parse(ipc.saveMeetingAiInteractions.mock.calls[0][1]);
    expect(saved).toHaveLength(1);
    expect(saved[0].response).toBe("Live answer");
    expect(useCallLogStore.getState().entries).toHaveLength(2);
  });

  it("does not fail a slow answer: tokens after 30 s still complete and persist it", async () => {
    await mount();
    act(() => start("r1"));
    expect(entry().sessionKey).toBe("live:m1:fast");
    act(() => vi.advanceTimersByTime(30_000));
    expect(entry().status).toBe("sending");

    act(() => {
      handlers.token({ token: "Hello", request_id: "r1" });
      handlers.end({ total_tokens: 4238, latency_ms: 31_000, request_id: "r1", cancelled: false, usage: USAGE });
    });
    expect(entry().status).toBe("complete");
    expect(entry().responseContent).toBe("Hello");
    expect(entry().latencyMs).toBe(31_000);
    expect(entry().usage).toEqual(USAGE);

    expect(ipc.saveMeetingAiInteractions).toHaveBeenCalledTimes(1);
    const [meetingId, json] = ipc.saveMeetingAiInteractions.mock.calls[0];
    expect(meetingId).toBe("m1");
    const saved = JSON.parse(json as string);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ meeting_id: "m1", response: "Hello", latency_ms: 31_000 });
  });

  it("shows 'No response yet' after 120 s of silence, then revives on a late token and end", async () => {
    await mount();
    act(() => start("r2"));
    act(() => vi.advanceTimersByTime(STALL_TIMEOUT_MS - 1));
    expect(entry().status).toBe("sending");
    act(() => vi.advanceTimersByTime(1));
    expect(entry().status).toBe("error");
    expect(entry().stalled).toBe(true);
    expect(entry().errorMessage).toBe(STALLED_MESSAGE);

    act(() => handlers.token({ token: "Late", request_id: "r2" }));
    expect(entry().status).toBe("streaming");
    expect(entry().stalled).toBe(false);
    expect(entry().errorMessage).toBeNull();

    act(() => handlers.end({ total_tokens: 5, latency_ms: 125_000, request_id: "r2", cancelled: false }));
    expect(entry().status).toBe("complete");
    expect(entry().usage).toBeNull();
    expect(ipc.saveMeetingAiInteractions).toHaveBeenCalledTimes(1);
  });

  it("a stalled entry with no tokens still completes when its end arrives", async () => {
    await mount();
    act(() => start("r3"));
    act(() => vi.advanceTimersByTime(STALL_TIMEOUT_MS));
    expect(entry().stalled).toBe(true);
    act(() => handlers.end({ total_tokens: 0, latency_ms: 130_000, request_id: "r3", cancelled: false }));
    expect(entry().status).toBe("complete");
    expect(entry().errorMessage).toBeNull();
  });

  it("thinking restarts the silence clock", async () => {
    await mount();
    act(() => start("r4"));
    act(() => vi.advanceTimersByTime(100_000));
    act(() => handlers.thinking({ request_id: "r4" }));
    act(() => vi.advanceTimersByTime(100_000));
    expect(entry().status).toBe("sending");
    act(() => vi.advanceTimersByTime(STALL_TIMEOUT_MS));
    expect(entry().stalled).toBe(true);
  });

  it("a real error still fails the entry; a stopped stream is cancelled, not failed", async () => {
    await mount();
    act(() => {
      start("e1");
      handlers.error({ message: "boom", request_id: "e1" });
    });
    expect(entry().status).toBe("error");
    expect(entry().errorMessage).toBe("boom");

    act(() => {
      start("c1");
      handlers.token({ token: "part", request_id: "c1" });
      handlers.end({ total_tokens: 0, latency_ms: 900, request_id: "c1", cancelled: true });
    });
    expect(entry().status).toBe("cancelled");
    expect(entry().errorMessage).toBeNull();
  });
});
