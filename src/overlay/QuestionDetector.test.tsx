import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DetectionPending, DetectionResult } from "../lib/questionDetection/events";

// Handlers the component subscribes, so a test can send transcript lines and
// the backend's question decisions.
const listeners = vi.hoisted(() => ({
  update: [] as Array<(e: { segment: unknown }) => void>,
  final: [] as Array<(e: { segment: unknown }) => void>,
  pending: [] as Array<(e: unknown) => void>,
  result: [] as Array<(e: unknown) => void>,
}));
vi.mock("../lib/events", () => {
  const subscribe = (list: Array<(e: { segment: unknown }) => void>) => (h: (e: { segment: unknown }) => void) => {
    list.push(h);
    return Promise.resolve(() => { if (list.includes(h)) list.splice(list.indexOf(h), 1); });
  };
  return {
    onTranscriptUpdate: subscribe(listeners.update),
    onTranscriptFinal: subscribe(listeners.final),
  };
});
vi.mock("../lib/questionDetection/events", () => {
  const subscribe = (list: Array<(e: unknown) => void>) => (h: (e: unknown) => void) => {
    list.push(h);
    return Promise.resolve(() => { if (list.includes(h)) list.splice(list.indexOf(h), 1); });
  };
  return {
    onQuestionDetectionPending: subscribe(listeners.pending),
    onQuestionDetectionResult: subscribe(listeners.result),
  };
});
vi.mock("../lib/userAction", () => ({ runUserAction: vi.fn(() => Promise.resolve()) }));
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  cancelGeneration: vi.fn(() => Promise.resolve()),
}));

import {
  AUTO_TRIGGER_DELAY_MS, QuestionDetector, QuestionPanel, lastSentence, looksLikeQuestion, resetQuestionDetectionForTests,
} from "./QuestionDetector";
import { runUserAction } from "../lib/userAction";
import { cancelGeneration } from "../lib/ipc";
import { useStreamStore } from "../stores/streamStore";
import { useAIActionsStore } from "../stores/aiActionsStore";
import { useConfigStore } from "../stores/configStore";
import { useQuestionStore } from "../stores/questionStore";
import { useQuestionDetectionStore } from "../stores/questionDetectionStore";
import { useToastStore } from "../stores/toastStore";
import { DEFAULT_SOURCES_CONFIG, useSourcesStore } from "../stores/sourcesStore";
import { resetMeetingScopedStores } from "../stores/resetMeeting";
import { useTranscriptStore } from "../stores/transcriptStore";
import type { QuestionDetectionMode, QuestionDetectionSettingsView } from "../lib/questionDetection/types";
import type { GlobalDefaults, TranscriptSegment, TurnSignal } from "../lib/types";

const seg = (text: string, is_final = true): TranscriptSegment =>
  ({ id: "them_1", text, speaker: "Them", timestamp_ms: 1, is_final, confidence: 1 }) as TranscriptSegment;
const segment = seg;

/** The backend started deciding a line (or you spoke, or settings changed). */
const pending = (revision: number, source = "Them", timestamp_ms = 1) => {
  const event: DetectionPending = { revision, timestamp_ms, source };
  for (const h of [...listeners.pending]) h(event);
};
/** The backend's decision for a line: its question, or none (a veto). */
const result = (revision: number, text: string | null, extra: Partial<DetectionResult> = {}) => {
  const event: DetectionResult = {
    revision, timestamp_ms: 1, source: "Them", original_text: "那它呢？",
    question: text ? { text, confidence: 0.9, timestamp_ms: 1, source: "Them" } : null,
    ...extra,
  };
  for (const h of [...listeners.result]) h(event);
};

function setDefaults(defaults: Partial<GlobalDefaults>) {
  const { configs } = useAIActionsStore.getState();
  useAIActionsStore.setState({ configs: { ...configs, globalDefaults: { ...configs.globalDefaults, ...defaults } } });
}

const setAutoTrigger = (on: boolean) => setDefaults({ autoTrigger: on });

function setDetectionMode(mode: QuestionDetectionMode) {
  const view: QuestionDetectionSettingsView = {
    revision: 1,
    settings: { mode, confidence_threshold: 0.7, log_requests: false, prediction_enabled: false, prediction_prepare_answers: true },
    effective_mode: mode,
    fallback_reason: null,
  };
  useQuestionDetectionStore.setState({ view });
}

const answerOpts = (preparedOnly?: boolean) =>
  preparedOnly ? { requestId: expect.any(String), preparedOnly: true } : { requestId: expect.any(String) };

beforeEach(() => {
  useConfigStore.setState({ contextScope: { kind: "default", minutes: 5 } });
  setDefaults({ questionDetection: true, autoTrigger: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.mocked(runUserAction).mockReset().mockImplementation(() => Promise.resolve());
  vi.mocked(cancelGeneration).mockClear();
  resetQuestionDetectionForTests();
  useQuestionStore.getState().clear();
  useQuestionDetectionStore.setState({ view: null });
  useStreamStore.getState().resetForMeeting();
  useTranscriptStore.setState({ segments: [] });
  for (const list of Object.values(listeners)) list.length = 0;
});

/** A line from the other party carrying a provider turn signal. */
const turnLine = (text: string, turn: TurnSignal, id = "them_t1"): TranscriptSegment =>
  ({ id, text, speaker: "Them", timestamp_ms: 1, is_final: turn === "end", confidence: 1, turn }) as TranscriptSegment;

/** Delivers a line as the transcript events do (store first, as useTranscript does). */
function send(line: TranscriptSegment) {
  act(() => {
    if (line.is_final) useTranscriptStore.setState({ segments: [line] });
    for (const h of [...(line.is_final ? listeners.final : listeners.update)]) h({ segment: line });
  });
}

/** Lets queued Auto-Answer steps (and their stops) finish. */
async function settle() {
  for (let i = 0; i < 6; i++) await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

/** Answers keep running until cancelled, like real streams. */
function answersRunUntilStopped() {
  const running = new Map<string, () => void>();
  vi.mocked(runUserAction).mockImplementation((_mode, _q, opts) => {
    const id = (typeof opts === "object" ? opts.requestId : undefined) ?? "?";
    useStreamStore.setState({ isStreaming: true, streamRequestId: id });
    return new Promise<void>((resolve) => running.set(id, resolve));
  });
  vi.mocked(cancelGeneration).mockImplementation(async (id) => {
    useStreamStore.setState({ isStreaming: false, streamRequestId: null });
    if (id) running.get(id)?.();
  });
}

const askedFor = () => vi.mocked(runUserAction).mock.calls.map((c) => c[1]);
const requestOf = (n: number) => {
  const opts = vi.mocked(runUserAction).mock.calls[n][2];
  return typeof opts === "object" ? opts.requestId : undefined;
};

describe("authoritative question detection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useTranscriptStore.setState({ segments: [segment("那它呢？")] });
  });

  const hit = () => result(1, "When can we ship this project?", {
    original_text: "When can we ship this project?", prepared: true,
  });

  it("replays a prepared hit immediately and once, without requesting a fresh generation", () => {
    setAutoTrigger(false);
    render(<QuestionDetector />);
    act(hit);
    act(() => vi.advanceTimersByTime(0));
    expect(runUserAction).toHaveBeenCalledWith("Assist", "When can we ship this project?", answerOpts(true));
    act(() => vi.advanceTimersByTime(5000));
    expect(runUserAction).toHaveBeenCalledTimes(1);
  });

  it("does not interrupt a foreground stream and discards a pending hit on settings changes", () => {
    useStreamStore.setState({ isStreaming: true });
    render(<QuestionDetector />);
    act(hit);
    act(() => vi.advanceTimersByTime(5000));
    expect(runUserAction).not.toHaveBeenCalled();
    act(() => pending(2, "Settings", 0));
    act(() => useStreamStore.setState({ isStreaming: false }));
    act(() => vi.advanceTimersByTime(5000));
    expect(runUserAction).not.toHaveBeenCalled();
  });

  it("a stale prepared hit does not fall back to a provider call when auto-answering is off", async () => {
    setAutoTrigger(false);
    vi.mocked(runUserAction).mockRejectedValueOnce(new Error("Prepared answer no longer available"));
    render(<QuestionDetector />);
    act(hit);
    await act(async () => vi.advanceTimersByTime(0));
    act(() => vi.advanceTimersByTime(5000));
    expect(runUserAction).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Get AI assistance for this question" })).toBeInTheDocument();
  });

  it("a stale prepared hit gets a fresh answer when Auto-Answer is on", async () => {
    vi.mocked(runUserAction).mockRejectedValueOnce(new Error("Prepared answer no longer available"));
    render(<QuestionDetector />);
    act(hit);
    await act(async () => vi.advanceTimersByTime(0));
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS));
    expect(runUserAction).toHaveBeenCalledTimes(2);
    expect(runUserAction).toHaveBeenLastCalledWith("Assist", "When can we ship this project?", answerOpts());
  });

  it("does not auto-replay a hit with a different user-selected transcript scope", () => {
    setAutoTrigger(false);
    useConfigStore.setState({ contextScope: { kind: "minutes", minutes: 10 } });
    render(<QuestionDetector />);
    act(hit);
    act(() => vi.advanceTimersByTime(5000));
    expect(runUserAction).not.toHaveBeenCalled();
  });

  it("waits for backend confirmation and sends the resolved question to Assist", () => {
    render(<QuestionDetector />);
    act(() => pending(1));
    act(() => vi.advanceTimersByTime(5000));
    expect(runUserAction).not.toHaveBeenCalled();
    act(() => result(1, "这个数据库的恢复时间目标是多少？"));
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS - 1));
    expect(runUserAction).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(runUserAction).toHaveBeenCalledWith("Assist", "这个数据库的恢复时间目标是多少？", answerOpts());
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
    expect(runUserAction).toHaveBeenCalledWith("Assist", "请解释这个上线计划如何控制风险。", answerOpts());
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
    expect(runUserAction).toHaveBeenCalledWith("Assist", "这个服务怎么上线以及回滚？", answerOpts());
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
    expect(runUserAction).toHaveBeenCalledWith("Assist", "这个服务怎么上线以及回滚？", answerOpts());
  });

  it("shows accepted questions without auto-answering when disabled", () => {
    setAutoTrigger(false);
    render(<QuestionDetector />);
    act(() => result(1, "What would you do first?"));
    act(() => vi.advanceTimersByTime(3000));
    expect(runUserAction).not.toHaveBeenCalled();
    expect(screen.getByText(/What would you do first/)).toBeTruthy();
  });

  it("answers a new question in the same growing paragraph after the previous one was answered", async () => {
    render(<QuestionDetector />);
    act(() => result(1, "怎么上线？"));
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_TRIGGER_DELAY_MS); });
    act(() => { pending(2); result(2, "那出了故障怎么回滚？"); });
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_TRIGGER_DELAY_MS); });
    expect(runUserAction).toHaveBeenNthCalledWith(2, "Assist", "那出了故障怎么回滚？", answerOpts());
    expect(runUserAction).toHaveBeenCalledTimes(2);
    // The first question stays answered.
    expect(screen.getByText(/怎么上线？/)).toBeTruthy();
  });

  it("stops the timer when the user answers or settings invalidate the result", () => {
    render(<QuestionDetector />);
    act(() => result(1, "怎么上线？"));
    act(() => pending(2, "You", 2));
    act(() => vi.advanceTimersByTime(3000));
    expect(runUserAction).not.toHaveBeenCalled();
  });

  it("clears the old meeting's pending answer when a new meeting starts", async () => {
    render(<QuestionDetector />);
    act(() => result(1, "上一场会议的问题？"));
    await act(async () => { await resetMeetingScopedStores(); });
    act(() => vi.advanceTimersByTime(3000));
    expect(runUserAction).not.toHaveBeenCalled();
    expect(screen.queryByText(/上一场会议/)).toBeNull();
  });
});

describe("Auto-Answer with the provider's turn signals (Cartesia, Deepgram Flux)", () => {
  // Rule-based detection: the local rules decide on the signal, as the backend would.
  beforeEach(() => setDetectionMode("rules"));

  it("answers as soon as the provider says the speaker finished, with no quiet wait", async () => {
    vi.useFakeTimers();
    setAutoTrigger(true);
    render(<QuestionDetector />);
    send(turnLine("Thanks. What would you do first?", "end"));
    await settle();
    expect(askedFor()).toEqual(["What would you do first?"]);
    // The quiet wait doesn't answer it a second time, nor does the backend's decision for the line.
    act(() => result(1, "What would you do first?"));
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_TRIGGER_DELAY_MS * 3); });
    expect(runUserAction).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Answered")).toBeTruthy();
  });

  it("starts early on 'probably done' and keeps that answer when the turn ends the same", async () => {
    vi.useFakeTimers();
    setAutoTrigger(true);
    render(<QuestionDetector />);
    send(turnLine("What would you do first?", "eager_end"));
    await settle();
    expect(askedFor()).toEqual(["What would you do first?"]);
    send(turnLine("What would you do first?", "end"));
    await settle();
    expect(runUserAction).toHaveBeenCalledTimes(1);
    expect(cancelGeneration).not.toHaveBeenCalled();
  });

  it("stops the early answer when they keep talking, and answers the whole question at the end", async () => {
    vi.useFakeTimers();
    setAutoTrigger(true);
    answersRunUntilStopped();
    render(<QuestionDetector />);
    send(turnLine("What would you do", "eager_end"));
    await settle();
    const early = requestOf(0);
    send(turnLine("What would you do", "resumed"));
    await settle();
    expect(cancelGeneration).toHaveBeenCalledWith(early);
    expect(screen.queryByText("Answered")).toBeNull();

    send(turnLine("What would you do if the build broke?", "end"));
    await settle();
    expect(askedFor()).toEqual(["What would you do", "What would you do if the build broke?"]);
  });

  it("replaces the early answer when the turn ends with a different question", async () => {
    vi.useFakeTimers();
    setAutoTrigger(true);
    answersRunUntilStopped();
    render(<QuestionDetector />);
    send(turnLine("What would you do?", "eager_end"));
    await settle();
    send(turnLine("What would you do if the build broke?", "end"));
    await settle();
    expect(cancelGeneration).toHaveBeenCalledWith(requestOf(0));
    expect(askedFor()).toEqual(["What would you do?", "What would you do if the build broke?"]);
  });

  it("never stops an answer you asked for: the question waits as a card to click", async () => {
    vi.useFakeTimers();
    setAutoTrigger(true);
    useStreamStore.setState({ isStreaming: true, streamRequestId: "yours" });
    render(<QuestionDetector />);
    send(turnLine("What would you do first?", "end"));
    await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_TRIGGER_DELAY_MS * 3); });
    expect(runUserAction).not.toHaveBeenCalled();
    expect(cancelGeneration).not.toHaveBeenCalled();
    expect(screen.getByText(/What would you do first\?/)).toBeTruthy();
    expect(screen.queryByText("Answered")).toBeNull();
  });

  it("clicking another question during an automatic answer stops it and answers yours", async () => {
    vi.useFakeTimers();
    setAutoTrigger(true);
    answersRunUntilStopped();
    useQuestionStore.getState().addQuestion(
      { text: "Which database did you pick?", confidence: 1, timestamp_ms: 1, source: "Them" }, "them_old");
    useQuestionStore.getState().markAssisted(0);
    useQuestionStore.getState().holdBack("them_old", "Which database did you pick?");
    render(<QuestionDetector />);
    send(turnLine("What would you do first?", "end"));
    await settle();
    const automatic = requestOf(0);

    fireEvent.click(screen.getByText(/Which database did you pick\?/));
    await settle();
    expect(cancelGeneration).toHaveBeenCalledWith(automatic);
    expect(askedFor()).toEqual(["What would you do first?", "Which database did you pick?"]);
    // The question it stopped goes back to a card to click.
    expect(useQuestionStore.getState().questions[0]).toMatchObject({ assisted: false, heldBack: true });
  });

  it("clicking the question being answered doesn't restart its answer", async () => {
    vi.useFakeTimers();
    setAutoTrigger(true);
    answersRunUntilStopped();
    render(<QuestionDetector />);
    send(turnLine("What would you do first?", "end"));
    await settle();

    fireEvent.click(screen.getByRole("button", { name: /Question: What would you do first\?/ }));
    await settle();
    expect(cancelGeneration).not.toHaveBeenCalled();
    expect(runUserAction).toHaveBeenCalledTimes(1);
  });

  it("a click that gets no answer stays a card to click, and says why", async () => {
    vi.useFakeTimers();
    setAutoTrigger(false);
    vi.mocked(runUserAction).mockRejectedValue("Generation already in progress");
    useQuestionStore.getState().addQuestion(
      { text: "What would you do first?", confidence: 1, timestamp_ms: 1, source: "Them" }, "them_1");
    render(<QuestionDetector />);

    fireEvent.click(screen.getByRole("button", { name: /Question: What would you do first\?/ }));
    await settle();
    expect(screen.queryByText("Answered")).toBeNull();
    expect(useToastStore.getState().toasts.map((t) => t.message)).toContain("Another answer is still running");
  });

  it("answers nothing on turn signals with Auto-Answer off", async () => {
    vi.useFakeTimers();
    setAutoTrigger(false);
    render(<QuestionDetector />);
    send(turnLine("What would you do first?", "eager_end"));
    send(turnLine("What would you do first?", "end"));
    await settle();
    expect(runUserAction).not.toHaveBeenCalled();
  });

  it("leaves the decision to the model outside rule-based detection", async () => {
    vi.useFakeTimers();
    setAutoTrigger(true);
    setDetectionMode("hybrid");
    render(<QuestionDetector />);
    send(turnLine("What would you do first?", "end"));
    await settle();
    expect(runUserAction).not.toHaveBeenCalled();

    act(() => result(1, "What would you do first?"));
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_TRIGGER_DELAY_MS); });
    expect(askedFor()).toEqual(["What would you do first?"]);
  });
});

describe("Auto-Answer without turn signals", () => {
  it("a refused automatic answer leaves the question to click, not marked answered", async () => {
    vi.useFakeTimers();
    useStreamStore.setState({ isStreaming: true, streamRequestId: "yours" });
    useTranscriptStore.setState({ segments: [seg("What would you do first?")] });
    render(<QuestionDetector />);
    act(() => result(1, "What would you do first?"));
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_TRIGGER_DELAY_MS * 3); });
    await settle();
    expect(runUserAction).not.toHaveBeenCalled();
    expect(screen.queryByText("Answered")).toBeNull();
  });

  it("a line that grows into another question replaces the running automatic answer", async () => {
    vi.useFakeTimers();
    answersRunUntilStopped();
    useTranscriptStore.setState({ segments: [seg("What would you do")] });
    render(<QuestionDetector />);
    act(() => result(1, "What would you do"));
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_TRIGGER_DELAY_MS); });
    await settle();
    expect(askedFor()).toEqual(["What would you do"]);

    act(() => { pending(2); useTranscriptStore.setState({ segments: [seg("What would you do if the build broke?")] }); });
    act(() => result(2, "What would you do if the build broke?"));
    await settle();
    expect(cancelGeneration).toHaveBeenCalledWith(requestOf(0));
    // The stopped answer's card gives way to the whole question.
    expect(screen.queryByText("What would you do")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_TRIGGER_DELAY_MS - 1); });
    expect(runUserAction).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await settle();
    expect(askedFor()).toEqual(["What would you do", "What would you do if the build broke?"]);
  });
});

describe("QuestionPanel", () => {
  it("keeps detecting with Auto-Answer off, so the user picks what to answer", () => {
    vi.useFakeTimers();
    setDefaults({ questionDetection: true, autoTrigger: false });
    useTranscriptStore.setState({ segments: [seg("What would you do first?")] });
    render(<QuestionPanel />);
    act(() => result(1, "What would you do first?"));
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS * 3));
    expect(runUserAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Get AI assistance for this question" }));
    expect(runUserAction).toHaveBeenCalledWith("Assist", "What would you do first?");
  });

  it("shows nothing and answers nothing with detection off", () => {
    vi.useFakeTimers();
    setDefaults({ questionDetection: false, autoTrigger: true });
    useTranscriptStore.setState({ segments: [seg("What would you do first?")] });
    render(<QuestionPanel />);
    act(() => result(1, "What would you do first?"));
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS * 3));
    expect(screen.queryByText(/What would you do first\?/)).toBeNull();
    expect(runUserAction).not.toHaveBeenCalled();
  });
});

describe("QuestionPanel coming back (layout switch, Settings)", () => {
  const question = "What would you do first?";

  it("doesn't answer an answered question again, and still shows it as answered", () => {
    vi.useFakeTimers();
    useTranscriptStore.setState({ segments: [seg(question)] });
    const { unmount } = render(<QuestionPanel />);
    act(() => result(1, question));
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS));
    expect(runUserAction).toHaveBeenCalledTimes(1);

    unmount();
    render(<QuestionPanel />);
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS * 3));
    expect(runUserAction).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Already answered" })).toBeTruthy();
  });

  it("shows a question asked while away without answering it, then answers the next one", () => {
    vi.useFakeTimers();
    const { unmount } = render(<QuestionPanel />);
    unmount();

    useTranscriptStore.setState({ segments: [seg(question)] });
    act(() => result(1, question));
    render(<QuestionPanel />);
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS * 3));
    expect(screen.getByText(/What would you do first\?/)).toBeTruthy();
    expect(runUserAction).not.toHaveBeenCalled();

    const next = { ...seg("And how long would it take?"), id: "them_2", timestamp_ms: 2 };
    act(() => useTranscriptStore.setState({ segments: [seg(question), next] }));
    act(() => result(2, "And how long would it take?", {
      timestamp_ms: 2,
      question: { text: "And how long would it take?", confidence: 0.9, timestamp_ms: 2, source: "Them" },
    }));
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS));
    expect(runUserAction).toHaveBeenCalledWith("Assist", "And how long would it take?", answerOpts());
  });

  it("doesn't answer a question still waiting when the panel went away", () => {
    vi.useFakeTimers();
    useTranscriptStore.setState({ segments: [seg(question)] });
    const { unmount } = render(<QuestionPanel />);
    act(() => result(1, question));
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS - 1));
    unmount();

    render(<QuestionPanel />);
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS * 3));
    expect(runUserAction).not.toHaveBeenCalled();
    expect(screen.getByText(/What would you do first\?/)).toBeTruthy();
  });

  it("keeps a dismissed question dismissed", () => {
    setDefaults({ questionDetection: true, autoTrigger: false });
    useTranscriptStore.setState({ segments: [seg(question)] });
    const { unmount } = render(<QuestionPanel />);
    act(() => result(1, question));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss question" }));
    unmount();

    render(<QuestionPanel />);
    expect(screen.queryByText(/What would you do first\?/)).toBeNull();
  });

  it("starts empty in a new meeting, and answers its first question", async () => {
    useTranscriptStore.setState({ segments: [seg(question)] });
    const { unmount } = render(<QuestionPanel />);
    act(() => result(1, question));
    expect(screen.getByText(/What would you do first\?/)).toBeTruthy();
    unmount();

    await resetMeetingScopedStores();
    vi.useFakeTimers();
    render(<QuestionPanel />);
    expect(screen.queryByText(/What would you do first\?/)).toBeNull();

    // Same line as the last meeting's: the new meeting's decision still counts.
    act(() => useTranscriptStore.setState({ segments: [seg(question)] }));
    act(() => { pending(2); result(2, question); });
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS));
    expect(runUserAction).toHaveBeenCalledWith("Assist", question, answerOpts());
  });
});

describe("QuestionDetector", () => {
  it("checks the newest sentence of a line", () => {
    expect(lastSentence("So here's the situation. What would you do?")).toBe("What would you do?");
    expect(looksLikeQuestion(lastSentence("We run preview days. How many do you run"))).toBe(true);
  });

  it("finds Chinese and Japanese questions", () => {
    expect(lastSentence("今天讨论进度。计划完成了吗？")).toBe("计划完成了吗？");
    expect(lastSentence("ありがとうございます。\n準備できましたか")).toBe("準備できましたか");
    for (const q of [
      "计划完成了？", "准备好了吗", "你的计划呢", "這個問題怎麼解決", "准备什么时候发布", "いつ始めますか。", "一緒に行きませんか",
      "能不能今天上线", "请介绍一下你的项目", "说说你的经验",
    ]) {
      expect(looksLikeQuestion(q), q).toBe(true);
    }
    for (const s of ["会议结束了。", "我们开始吧", "没什么问题", "无论如何都要按时完成", "会議は終了しました。", "とても静か", "コーヒーとか"]) {
      expect(looksLikeQuestion(s), s).toBe(false);
    }
  });

  it("ignores a bare tag, which leaves nothing to answer", () => {
    for (const tag of ["Right?", "right", "Okay?", "Yeah, right?", "So, right?", "You know?", "Isn't it?", "Really?"]) {
      expect(looksLikeQuestion(tag), tag).toBe(false);
    }
    for (const q of ["Why?", "Is that right?", "Right now?", "And you?", "Can you start?"]) {
      expect(looksLikeQuestion(q), q).toBe(true);
    }
  });

  it("looks past a trailing tag for the question before it", () => {
    expect(lastSentence("Is that what you were thinking about? Right?")).toBe("Is that what you were thinking about?");
    expect(lastSentence("Can something change? Okay? Yeah, right?")).toBe("Can something change?");
    expect(lastSentence("Right?")).toBe("Right?");
  });
});

describe("Personal sources and automatic answers", () => {
  const providerBefore = useConfigStore.getState().llmProvider;

  /** Claude subscription, a notes folder and a ready tool, both pills on. */
  function bothPillsOn() {
    useConfigStore.setState({ llmProvider: "claude_cli" });
    useSourcesStore.setState({
      config: {
        ...DEFAULT_SOURCES_CONFIG,
        notes_folders: [{ id: "f1", label: "Vault", path: "D:\Vault", enabled: true }],
        mcp_servers: [
          {
            id: "s1", key: "mira", label: "Mira", enabled: true, needs_sign_in: false, env: [],
            transport: { type: "stdio", command: "node", args: [] },
            tools: [{ name: "person_brief", full_name: "mcp__mira__person_brief", allowed: true }],
            last_check: { ok: true, tool_count: 1, error: null, checked_at_ms: 1 },
          },
        ],
      },
      toggles: { notes: true, tools: true },
    });
  }

  afterEach(() => {
    useConfigStore.setState({ llmProvider: providerBefore });
    useSourcesStore.setState({ config: DEFAULT_SOURCES_CONFIG, toggles: { notes: false, tools: false } });
  });

  it("Auto-Answer never sends sources, even with both pills on", async () => {
    vi.useFakeTimers();
    setAutoTrigger(true);
    // NexQ Plus: a provider's turn signal answers by itself only in the "rules" mode.
    setDetectionMode("rules");
    bothPillsOn();
    render(<QuestionDetector />);
    send(turnLine("Thanks. What would you do first?", "end"));
    await settle();
    expect(askedFor()).toEqual(["What would you do first?"]);
    const opts = vi.mocked(runUserAction).mock.calls[0][2] as Record<string, unknown>;
    expect(opts).not.toHaveProperty("sources");
  });

  it("Auto-Answer to a question the model detected never sends sources either", async () => {
    vi.useFakeTimers();
    setAutoTrigger(true);
    bothPillsOn();
    useTranscriptStore.setState({ segments: [segment("What would you do first?")] });
    render(<QuestionDetector />);
    act(() => result(1, "What would you do first?"));
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS));
    await settle();
    expect(askedFor()).toEqual(["What would you do first?"]);
    const opts = vi.mocked(runUserAction).mock.calls[0][2] as Record<string, unknown>;
    expect(opts).not.toHaveProperty("sources");
  });

  it("clicking a question card is your own request, so it sends the pills that are on", async () => {
    vi.useFakeTimers();
    setAutoTrigger(false);
    bothPillsOn();
    useQuestionStore.getState().addQuestion(
      { text: "Which database did you pick?", confidence: 1, timestamp_ms: 1, source: "Them" }, "them_old");
    render(<QuestionDetector />);
    fireEvent.click(screen.getByText(/Which database did you pick\?/));
    await settle();
    expect(vi.mocked(runUserAction)).toHaveBeenCalledWith(
      "Assist", "Which database did you pick?", { sources: { notes: true, tools: true } },
    );
  });
});
