import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PredictionView } from "../lib/questionDetection/predictions";
import type { Meeting } from "../lib/types";

const ipc = vi.hoisted(() => ({ get: vi.fn(), stop: vi.fn(), emit: (_: PredictionView) => {} }));
vi.mock("../lib/questionDetection/predictions", () => ({
  getQuestionPredictions: ipc.get,
  onQuestionPredictions: (handler: typeof ipc.emit) => {
    ipc.emit = handler;
    return Promise.resolve(ipc.stop);
  },
}));
import { QuestionPredictions } from "./QuestionPredictions";
import { useMeetingStore } from "../stores/meetingStore";
import { useStreamStore } from "../stores/streamStore";
import { useCallLogStore } from "../stores/callLogStore";

const snapshot = (patch: Partial<PredictionView> = {}): PredictionView => ({
  meeting_id: "m1",
  revision: 1,
  enabled: true,
  expires_at_ms: Date.now() + 90_000,
  predictions: [
    {
      id: "p1",
      question: "When can we ship this project?",
      confidence: 0.9,
      status: "ready",
      answer: "<think>private draft</think>Next week.",
    },
  ],
  ...patch,
});

beforeEach(() => {
  vi.useFakeTimers();
  ipc.get.mockReset().mockResolvedValue(snapshot());
  ipc.stop.mockClear();
  useMeetingStore.setState({ activeMeeting: { id: "m1" } as Meeting });
  useStreamStore.getState().resetForMeeting();
  useCallLogStore.getState().clearAll();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("is collapsed as a compact count button initially and previews an answer in a popover without generating, logging or saving it", async () => {
  const stream = useStreamStore.getState();
  const log = useCallLogStore.getState();
  render(<QuestionPredictions />);
  await act(async () => {});
  const trigger = screen.getByRole("button", { name: "1 predicted question" });
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(trigger).toHaveTextContent("1");
  expect(screen.queryByRole("dialog", { name: "They may ask" })).toBeNull();

  fireEvent.click(trigger);
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("dialog", { name: "They may ask" })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /When can we ship/ }));
  expect(screen.getByText("Next week.")).toBeInTheDocument();
  expect(screen.getByText("Prepared in advance")).toBeInTheDocument();
  expect(screen.queryByText("private draft")).toBeNull();
  expect(useStreamStore.getState()).toBe(stream);
  expect(useCallLogStore.getState()).toBe(log);
  expect(ipc.get).toHaveBeenCalledTimes(1);

  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "They may ask" })).toBeNull();
});

it("hides disabled, expired and cleared predictions", async () => {
  render(<QuestionPredictions />);
  await act(async () => {});
  act(() => ipc.emit(snapshot({ revision: 2, enabled: false })));
  expect(screen.queryByRole("button", { name: /predicted question/ })).toBeNull();
  act(() => ipc.emit(snapshot({ revision: 3, expires_at_ms: Date.now() + 100 })));
  expect(screen.getByRole("button", { name: "1 predicted question" })).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(101));
  expect(screen.queryByRole("button", { name: /predicted question/ })).toBeNull();
  act(() => ipc.emit(snapshot({ revision: 4, predictions: [] })));
  expect(screen.queryByRole("button", { name: /predicted question/ })).toBeNull();
});

it("ignores old revisions, a stale initial read and another meeting's results", async () => {
  let resolve!: (view: PredictionView) => void;
  ipc.get.mockImplementationOnce(() => new Promise<PredictionView>((r) => { resolve = r; }));
  render(<QuestionPredictions />);
  await act(async () => {});
  act(() => ipc.emit(snapshot({ revision: 4, predictions: [] })));
  await act(async () => resolve(snapshot()));
  act(() => ipc.emit(snapshot({ revision: 2 })));
  expect(screen.queryByRole("button", { name: /predicted question/ })).toBeNull();
  act(() => useMeetingStore.setState({ activeMeeting: { id: "m2" } as Meeting }));
  await act(async () => {});
  act(() => ipc.emit(snapshot({ revision: 5 })));
  expect(screen.queryByRole("button", { name: /predicted question/ })).toBeNull();
  expect(ipc.stop).toHaveBeenCalled();
});

it("does not subscribe or read without an active meeting", async () => {
  useMeetingStore.setState({ activeMeeting: null });
  render(<QuestionPredictions />);
  await act(async () => {});
  expect(ipc.get).not.toHaveBeenCalled();
});
