import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DetectionLog } from "../lib/questionDetection/events";
const callbacks = vi.hoisted(() => ({ log: (_: DetectionLog) => {} }));
vi.mock("../lib/questionDetection/events", () => ({
  onQuestionDetectionLog: (handler: typeof callbacks.log) => {
    callbacks.log = handler;
    return Promise.resolve(() => {});
  },
}));
import { useQuestionDetectionLog } from "./useQuestionDetectionLog";
import { useCallLogStore } from "../stores/callLogStore";
import { useStreamStore } from "../stores/streamStore";

afterEach(cleanup);

it.each(["question_predict", "question_prepare"] as const)("records %s as a separate diagnostic without touching the answer", (task) => {
  useCallLogStore.getState().clearAll();
  const before = useStreamStore.getState();
  renderHook(() => useQuestionDetectionLog());
  act(() => callbacks.log({
    task, id: task, timestamp_ms: 1000, latency_ms: 25, model: "mock", provider: "mock",
    system_prompt: "policy", user_prompt: "conversation", response: "speculation", error: null,
  }));
  expect(useCallLogStore.getState().entries[0]).toMatchObject({ mode: task, status: "complete" });
  expect(useStreamStore.getState()).toBe(before);
});

it("records opt-in diagnostics separately without changing the active Assist stream", () => {
  useCallLogStore.getState().clearAll();
  const before = useStreamStore.getState();
  renderHook(() => useQuestionDetectionLog());
  expect(useCallLogStore.getState().entries).toHaveLength(0);
  act(() => callbacks.log({
    id: "detect-1", timestamp_ms: 1000, latency_ms: 23,
    model: "qwen3:1.7b", provider: "Local model", system_prompt: "JSON classifier",
    user_prompt: "conversation", response: '{"is_question":false}', error: null,
  }));
  expect(useCallLogStore.getState().entries[0]).toMatchObject({
    mode: "question_detect", status: "complete", latencyMs: 23,
    actualUserPrompt: "conversation", responseContent: '{"is_question":false}',
  });
  expect(useStreamStore.getState()).toBe(before);
});

it("records a failed detection as a diagnostic error", () => {
  useCallLogStore.getState().clearAll();
  renderHook(() => useQuestionDetectionLog());
  act(() => callbacks.log({
    id: "detect-2", timestamp_ms: 1000, latency_ms: 2500,
    model: "qwen3:1.7b", provider: "Local model", system_prompt: "JSON classifier",
    user_prompt: "conversation", response: "", error: "timeout",
  }));
  expect(useCallLogStore.getState().entries[0]).toMatchObject({
    mode: "question_detect", status: "error", errorMessage: "timeout",
  });
});
