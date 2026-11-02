import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/events", () => ({ onQuestionDetected: () => Promise.resolve(() => {}) }));
vi.mock("../lib/userAction", () => ({ runUserAction: vi.fn(() => Promise.resolve()) }));

import { AUTO_TRIGGER_DELAY_MS, QuestionDetector, lastSentence, looksLikeQuestion } from "./QuestionDetector";
import { runUserAction } from "../lib/userAction";
import { useAIActionsStore } from "../stores/aiActionsStore";
import { useTranscriptStore } from "../stores/transcriptStore";
import type { TranscriptSegment } from "../lib/types";

const seg = (text: string, is_final = true): TranscriptSegment =>
  ({ id: "them_1", text, speaker: "Them", timestamp_ms: 1, is_final, confidence: 1 }) as TranscriptSegment;

function setAutoTrigger(on: boolean) {
  const { configs } = useAIActionsStore.getState();
  useAIActionsStore.setState({ configs: { ...configs, globalDefaults: { ...configs.globalDefaults, autoTrigger: on } } });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.mocked(runUserAction).mockClear();
});

describe("Auto-Trigger", () => {
  it("automatically answers a Chinese question after the other party pauses", () => {
    vi.useFakeTimers();
    setAutoTrigger(true);
    useTranscriptStore.setState({ segments: [seg("先介绍一下背景。你准备好了吗？")] });
    render(<QuestionDetector />);
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS));
    expect(runUserAction).toHaveBeenCalledWith("Assist", "你准备好了吗？");
    expect(runUserAction).toHaveBeenCalledTimes(1);
  });

  it("answers a question once the other party has been quiet for a moment", () => {
    vi.useFakeTimers();
    setAutoTrigger(true);
    useTranscriptStore.setState({ segments: [seg("Thanks for joining. What would you do first?")] });
    render(<QuestionDetector />);
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS - 100));
    expect(runUserAction).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(100));
    expect(runUserAction).toHaveBeenCalledWith("Assist", "What would you do first?");
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS * 3));
    expect(runUserAction).toHaveBeenCalledTimes(1);
  });

  it("waits while they keep talking, and answers the finished question", () => {
    vi.useFakeTimers();
    setAutoTrigger(true);
    useTranscriptStore.setState({ segments: [seg("What would you do")] });
    render(<QuestionDetector />);
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS - 500));
    act(() => useTranscriptStore.setState({ segments: [seg("What would you do if the build broke?", false)] }));
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS - 500));
    act(() => useTranscriptStore.setState({ segments: [seg("What would you do if the build broke?")] }));
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS - 1));
    expect(runUserAction).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(runUserAction).toHaveBeenCalledWith("Assist", "What would you do if the build broke?");
  });

  it("only shows the question when turned off", () => {
    vi.useFakeTimers();
    setAutoTrigger(false);
    useTranscriptStore.setState({ segments: [seg("What would you do first?")] });
    render(<QuestionDetector />);
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS * 3));
    expect(runUserAction).not.toHaveBeenCalled();
    expect(screen.getByText(/What would you do first\?/)).toBeTruthy();
  });
});

describe("QuestionDetector", () => {
  it("handles Chinese punctuation, questions without punctuation, and interview prompts", () => {
    expect(lastSentence("我们开始吧！谁？")).toBe("谁？");
    expect(lastSentence("第一句。\n你怎么看这个方案")).toBe("你怎么看这个方案");
    expect(lastSentence("他说。“你准备好了吗？”")).toBe("“你准备好了吗？”");
    for (const text of ["谁？", "你怎么看这个方案", "你准备好了吗", "您的计划呢", "請介紹一下你的項目經驗"]) {
      expect(looksLikeQuestion(text), text).toBe(true);
    }
    expect(looksLikeQuestion("谢谢大家。")).toBe(false);
    expect(looksLikeQuestion("！？")).toBe(false);
  });

  it("checks the newest sentence of a line", () => {
    expect(lastSentence("So here's the situation. What would you do?")).toBe("What would you do?");
    expect(looksLikeQuestion(lastSentence("We run preview days. How many do you run"))).toBe(true);
  });

  it("finds a question a line gains after its first final", () => {
    useTranscriptStore.setState({ segments: [seg("So here's the situation.")] });
    render(<QuestionDetector />);
    expect(screen.queryByText(/What would you do/)).toBeNull();

    act(() => useTranscriptStore.setState({ segments: [seg("So here's the situation. What would you do?")] }));
    expect(screen.getByText(/What would you do\?/)).toBeTruthy();
  });
});
