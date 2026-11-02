import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DetectionPending, DetectionResult } from "../lib/questionDetection/events";
import type { Meeting, TranscriptSegment } from "../lib/types";

const callbacks = vi.hoisted(() => ({
  pending: (_: DetectionPending) => {},
  result: (_: DetectionResult) => {},
}));
vi.mock("../lib/questionDetection/events", () => ({
  onQuestionDetectionPending: (handler: typeof callbacks.pending) => {
    callbacks.pending = handler;
    return Promise.resolve(() => {});
  },
  onQuestionDetectionResult: (handler: typeof callbacks.result) => {
    callbacks.result = handler;
    return Promise.resolve(() => {});
  },
}));
vi.mock("../lib/userAction", () => ({ runUserAction: vi.fn(() => Promise.resolve()) }));

import { AUTO_TRIGGER_DELAY_MS, QuestionDetector } from "./QuestionDetector";
import { runUserAction } from "../lib/userAction";
import { useAIActionsStore } from "../stores/aiActionsStore";
import { useTranscriptStore } from "../stores/transcriptStore";
import { useMeetingStore } from "../stores/meetingStore";

const segment = (text: string, is_final = true): TranscriptSegment =>
  ({ id: "them_1", text, speaker: "Them", timestamp_ms: 1, is_final, confidence: 1 }) as TranscriptSegment;
const pending = (revision: number) => callbacks.pending({ revision, timestamp_ms: 1, source: "Them" });
const result = (revision: number, text: string | null) => callbacks.result({
  revision, timestamp_ms: 1, source: "Them", original_text: "那它呢？",
  question: text ? { text, confidence: 0.9, timestamp_ms: 1, source: "Them" } : null,
});
function setAutoTrigger(on: boolean) {
  const { configs } = useAIActionsStore.getState();
  useAIActionsStore.setState({ configs: { ...configs, globalDefaults: { ...configs.globalDefaults, autoTrigger: on } } });
}

beforeEach(() => {
  vi.useFakeTimers();
  setAutoTrigger(true);
  useTranscriptStore.setState({ segments: [segment("那它呢？")] });
  useMeetingStore.setState({ activeMeeting: { id: "meeting-1" } as Meeting });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.mocked(runUserAction).mockClear();
});

describe("authoritative question detection", () => {
  it("waits for backend confirmation and sends the resolved question to Assist", () => {
    render(<QuestionDetector />);
    act(() => pending(1));
    act(() => vi.advanceTimersByTime(5000));
    expect(runUserAction).not.toHaveBeenCalled();
    act(() => result(1, "这个数据库的恢复时间目标是多少？"));
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS - 1));
    expect(runUserAction).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(runUserAction).toHaveBeenCalledWith("Assist", "这个数据库的恢复时间目标是多少？");
    act(() => vi.advanceTimersByTime(5000));
    expect(runUserAction).toHaveBeenCalledTimes(1);
  });

  it("does not bypass model rejection with frontend punctuation rules", () => {
    render(<QuestionDetector />);
    act(() => { pending(1); result(1, null); });
    act(() => vi.advanceTimersByTime(5000));
    expect(runUserAction).not.toHaveBeenCalled();
    expect(screen.queryByText(/那它呢/)).toBeNull();
  });

  it("accepts an implicit question even when the transcript has no question words", () => {
    useTranscriptStore.setState({ segments: [segment("我对这个上线计划还有些疑虑。")] });
    render(<QuestionDetector />);
    act(() => result(1, "请解释这个上线计划如何控制风险。"));
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS));
    expect(runUserAction).toHaveBeenCalledWith("Assist", "请解释这个上线计划如何控制风险。");
  });

  it("discards stale results and cancels the previous auto-trigger while a new line is pending", () => {
    render(<QuestionDetector />);
    act(() => result(1, "最初的问题？"));
    act(() => vi.advanceTimersByTime(1000));
    act(() => pending(2));
    act(() => result(1, "过期的响应？"));
    act(() => vi.advanceTimersByTime(3000));
    expect(runUserAction).not.toHaveBeenCalled();
    act(() => result(2, null));
    act(() => vi.advanceTimersByTime(3000));
    expect(runUserAction).not.toHaveBeenCalled();
    expect(screen.queryByText(/最初的问题/)).toBeNull();
  });

  it("waits for the other party's partial sentence to finish", () => {
    render(<QuestionDetector />);
    act(() => result(1, "怎么上线？"));
    act(() => useTranscriptStore.setState({ segments: [segment("怎么上线以及", false)] }));
    act(() => vi.advanceTimersByTime(3000));
    expect(runUserAction).not.toHaveBeenCalled();
    act(() => { pending(2); useTranscriptStore.setState({ segments: [segment("怎么上线以及回滚？")] }); });
    act(() => result(2, "这个服务怎么上线以及回滚？"));
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS));
    expect(runUserAction).toHaveBeenCalledWith("Assist", "这个服务怎么上线以及回滚？");
  });

  it("pauses for interim words stored on an already-final paragraph", () => {
    render(<QuestionDetector />);
    act(() => result(1, "怎么上线？"));
    act(() => useTranscriptStore.setState({ segments: [{ ...segment("怎么上线？"), pending_text: "怎么上线以及回滚？" }] }));
    act(() => vi.advanceTimersByTime(3000));
    expect(runUserAction).not.toHaveBeenCalled();
    act(() => { pending(2); useTranscriptStore.setState({ segments: [segment("怎么上线以及回滚？")] }); });
    act(() => result(2, "这个服务怎么上线以及回滚？"));
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS));
    expect(runUserAction).toHaveBeenCalledWith("Assist", "这个服务怎么上线以及回滚？");
  });

  it("shows accepted questions without auto-answering when disabled", () => {
    setAutoTrigger(false);
    render(<QuestionDetector />);
    act(() => result(1, "What would you do first?"));
    act(() => vi.advanceTimersByTime(3000));
    expect(runUserAction).not.toHaveBeenCalled();
    expect(screen.getByText(/What would you do first/)).toBeTruthy();
  });

  it("answers a new question in the same growing paragraph after the previous one was answered", () => {
    render(<QuestionDetector />);
    act(() => result(1, "怎么上线？"));
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS));
    act(() => { pending(2); result(2, "那出了故障怎么回滚？"); });
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS));
    expect(runUserAction).toHaveBeenNthCalledWith(2, "Assist", "那出了故障怎么回滚？");
    expect(runUserAction).toHaveBeenCalledTimes(2);
  });

  it("stops the timer when the user answers or settings invalidate the result", () => {
    render(<QuestionDetector />);
    act(() => result(1, "怎么上线？"));
    act(() => callbacks.pending({ revision: 2, timestamp_ms: 2, source: "You" }));
    act(() => vi.advanceTimersByTime(3000));
    expect(runUserAction).not.toHaveBeenCalled();
  });

  it("clears the old meeting's pending answer on meeting changes", () => {
    render(<QuestionDetector />);
    act(() => result(1, "上一场会议的问题？"));
    act(() => useMeetingStore.setState({ activeMeeting: { id: "meeting-2" } as Meeting }));
    act(() => vi.advanceTimersByTime(3000));
    expect(runUserAction).not.toHaveBeenCalled();
    expect(screen.queryByText(/上一场会议/)).toBeNull();
  });
});
