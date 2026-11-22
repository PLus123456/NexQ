import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DetectedQuestionV2, QuestionEvent } from "../lib/questionDetection/events";

// Handlers the flow subscribes, so a test can send transcript lines and the
// backend's question events.
const listeners = vi.hoisted(() => ({
  update: [] as Array<(e: { segment: unknown }) => void>,
  final: [] as Array<(e: { segment: unknown }) => void>,
  question: [] as Array<(e: unknown) => void>,
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
vi.mock("../lib/questionDetection/events", () => ({
  onQuestionEvent: (h: (e: unknown) => void) => {
    listeners.question.push(h);
    return Promise.resolve(() => {
      if (listeners.question.includes(h)) listeners.question.splice(listeners.question.indexOf(h), 1);
    });
  },
}));
vi.mock("../lib/userAction", () => ({ runUserAction: vi.fn(() => Promise.resolve()) }));
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  cancelGeneration: vi.fn(() => Promise.resolve()),
}));

import {
  changedALot, lastSentence, looksLikeQuestion, resetQuestionDetectionForTests, useQuestionFlow,
} from "./questionFlow";
import { runUserAction } from "../lib/userAction";
import { cancelGeneration } from "../lib/ipc";
import { REFUSED } from "../lib/autoAnswer";
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

// ── what the backend sends ────────────────────────────────────────────────

const revisions = new Map<string, number>();

/**
 * The backend found question `id`, or revised it. Unless told otherwise it is
 * the model's, complete, and the other party has finished speaking.
 */
const upsert = (id: string, text: string, extra: Partial<DetectedQuestionV2> = {}) => {
  const revision = extra.revision ?? (revisions.get(id) ?? 0) + 1;
  revisions.set(id, revision);
  const question: DetectedQuestionV2 = {
    id, revision, text, quote: text, ask_kind: "direct", complete: true, origin: "model",
    line_id: "them_1", timestamp_ms: 1, source: "Them", speaker_done: true, prepared: false,
    ...extra,
  };
  const event: QuestionEvent = { kind: "upsert", question };
  act(() => { for (const h of [...listeners.question]) h(event); });
};
/** The rules' guess at a pause: the model hasn't confirmed it yet. */
const guess = (id: string, text: string, extra: Partial<DetectedQuestionV2> = {}) =>
  upsert(id, text, { origin: "rules", ...extra });
/** A question still being asked: the other party is speaking. */
const asking = (id: string, text: string, extra: Partial<DetectedQuestionV2> = {}) =>
  upsert(id, text, { complete: false, speaker_done: false, ...extra });
/** Asked to the end, but they are still speaking: an answer now is an early one. */
const askedWhileSpeaking = (id: string, text: string, extra: Partial<DetectedQuestionV2> = {}) =>
  upsert(id, text, { speaker_done: false, ...extra });
const remove = (id: string, reason: "veto" | "superseded" | "reset") => {
  const event: QuestionEvent = { kind: "remove", id, reason };
  act(() => { for (const h of [...listeners.question]) h(event); });
};

// ── settings ──────────────────────────────────────────────────────────────

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

/** What an automatic answer sends: never a query rewrite (rule 7). */
const autoOpts = (preparedOnly?: boolean) => ({
  requestId: expect.any(String), skipQueryRewrite: true, ...(preparedOnly ? { preparedOnly: true } : {}),
});

/**
 * Mounts the flow the way the question strip does. `questions()` is what the
 * strip would show; `answer` and `dismiss` are a click on a card and on its ✕.
 */
function mountFlow() {
  const { result: hook, unmount } = renderHook(() => useQuestionFlow());
  const questions = () => hook.current.questions;
  const idOf = (text: string) => {
    const found = questions().find((q) => q.text === text);
    if (!found) throw new Error(`no question "${text}" among ${JSON.stringify(questions().map((q) => q.text))}`);
    return found.id;
  };
  return {
    questions,
    /** `[text, status]` of every question, newest first. */
    shown: () => questions().map((q) => [q.text, q.status]),
    answer: (text: string) => act(() => hook.current.answer(idOf(text))),
    dismiss: (text: string) => act(() => hook.current.dismiss(idOf(text))),
    flow: () => hook.current,
    unmount,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  useConfigStore.setState({ contextScope: { kind: "default", minutes: 5 } });
  setDefaults({ questionDetection: true, autoTrigger: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.mocked(runUserAction).mockReset().mockImplementation(() => Promise.resolve());
  vi.mocked(cancelGeneration).mockReset().mockImplementation(() => Promise.resolve());
  resetQuestionDetectionForTests();
  useQuestionStore.getState().clear();
  useQuestionDetectionStore.setState({ view: null });
  useStreamStore.getState().resetForMeeting();
  useTranscriptStore.setState({ segments: [] });
  useToastStore.setState({ toasts: [] });
  revisions.clear();
  for (const list of Object.values(listeners)) list.length = 0;
});

// ── transcript ────────────────────────────────────────────────────────────

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

/** You said `text` (line `id` grows when said again with more words). */
function youSay(text: string, id = "you_1", is_final = false) {
  act(() => useTranscriptStore.getState().updateInterimSegment(
    { id, text, speaker: "User", timestamp_ms: 2, is_final, confidence: 1 } as TranscriptSegment,
  ));
}

// ── time and answers ──────────────────────────────────────────────────────

/** Lets queued Auto-Answer steps (and their stops) finish. */
async function settle() {
  for (let i = 0; i < 6; i++) await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

async function later(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  await settle();
}

/**
 * Answers keep running until cancelled, like real streams, and the backend
 * refuses an answer while another one runs. A stopped answer lets go
 * `releaseMs` after it was cancelled. `finish` ends the one running.
 */
function answersRunUntilStopped({ releaseMs = 0 } = {}) {
  const running = new Map<string, () => void>();
  const end = (id: string | null | undefined) => {
    if (useStreamStore.getState().streamRequestId === id) {
      useStreamStore.setState({ isStreaming: false, streamRequestId: null });
    }
    if (id) running.get(id)?.();
  };
  vi.mocked(runUserAction).mockImplementation((_mode, _q, opts) => {
    if (useStreamStore.getState().isStreaming) return Promise.reject(REFUSED);
    const id = (typeof opts === "object" ? opts.requestId : undefined) ?? `yours-${running.size}`;
    useStreamStore.setState({ isStreaming: true, streamRequestId: id });
    return new Promise<void>((resolve) => running.set(id, resolve));
  });
  vi.mocked(cancelGeneration).mockImplementation(async (id) => {
    if (releaseMs > 0) setTimeout(() => end(id), releaseMs);
    else end(id);
  });
  return { finish: () => end(useStreamStore.getState().streamRequestId) };
}

const askedFor = () => vi.mocked(runUserAction).mock.calls.map((c) => c[1]);
const optsOf = (n: number) => vi.mocked(runUserAction).mock.calls[n][2];
const requestOf = (n: number) => {
  const opts = optsOf(n);
  return typeof opts === "object" ? opts.requestId : undefined;
};

// ── the tests ─────────────────────────────────────────────────────────────

describe("the questions the strip shows", () => {
  it("describes a question: its id, kind, when it was asked, whether an answer was prepared", () => {
    setAutoTrigger(false);
    useConfigStore.setState({ contextScope: { kind: "minutes", minutes: 10 } }); // no replay
    const { questions } = mountFlow();
    upsert("q7", "What would you do", { timestamp_ms: 4200, complete: false });
    expect(questions()).toEqual([{
      id: "q7", text: "What would you do", askKind: "direct", status: "detecting", prepared: false,
      timestampMs: 4200, revisedSinceAnswer: false,
    }]);

    // Revised under the same id: the same question to the strip.
    upsert("q7", "What would you do first?", { timestamp_ms: 4200, prepared: true });
    expect(questions()).toEqual([{
      id: "q7", text: "What would you do first?", askKind: "direct", status: "open", prepared: true,
      timestampMs: 4200, revisedSinceAnswer: false,
    }]);
  });

  it("keeps an implied question's kind", () => {
    setAutoTrigger(false);
    const { questions } = mountFlow();
    upsert("q1", "Tell me more about the migration.", { ask_kind: "implicit" });
    expect(questions()[0]).toMatchObject({ askKind: "implicit", status: "open" });
  });

  it("shows the rules' guess as 'detecting' until the model confirms it", () => {
    setAutoTrigger(false);
    const { shown } = mountFlow();
    guess("q1", "How would you roll it back?");
    expect(shown()).toEqual([["How would you roll it back?", "detecting"]]);
    upsert("q1", "How would you roll the release back?");
    expect(shown()).toEqual([["How would you roll the release back?", "open"]]);
  });

  it("ignores a revision older than the one it shows", () => {
    setAutoTrigger(false);
    const { shown } = mountFlow();
    upsert("q1", "Newer wording?", { revision: 3 });
    upsert("q1", "Older wording?", { revision: 2 });
    expect(shown()).toEqual([["Newer wording?", "open"]]);
  });

  it("drops a question the backend removes before it was answered, whatever the reason", () => {
    setAutoTrigger(false);
    const { shown } = mountFlow();
    guess("q1", "Right, so what?");
    upsert("q2", "First question?");
    upsert("q3", "Second question?");
    remove("q1", "veto");
    remove("q2", "superseded");
    expect(shown()).toEqual([["Second question?", "open"]]);
    remove("q3", "reset");
    expect(shown()).toEqual([]);
  });

  it("keeps a dismissed question dismissed, also when the backend revises it", () => {
    setAutoTrigger(false);
    const { dismiss, shown } = mountFlow();
    upsert("q1", "What would you do first?");
    dismiss("What would you do first?");
    upsert("q1", "What would you do first, and why?");
    expect(shown()).toEqual([]);
  });

  it("lists at most 10 questions, newest first", () => {
    setAutoTrigger(false);
    const { questions } = mountFlow();
    for (let n = 1; n <= 12; n++) upsert(`q${n}`, `Question ${n}?`, { timestamp_ms: n });
    expect(questions().map((q) => q.text)).toEqual(
      [12, 11, 10, 9, 8, 7, 6, 5, 4, 3].map((n) => `Question ${n}?`),
    );
  });

  it("ignores a click or a dismissal for a question that is no longer listed", async () => {
    setAutoTrigger(false);
    const { flow, shown } = mountFlow();
    upsert("q1", "What would you do first?");
    act(() => { flow().answer("gone"); flow().dismiss("gone"); });
    await settle();
    expect(runUserAction).not.toHaveBeenCalled();
    expect(shown()).toEqual([["What would you do first?", "open"]]);
  });

  it("is 'answering' while the automatic answer arrives, and 'answered' once it has", async () => {
    const { finish } = answersRunUntilStopped();
    const { shown } = mountFlow();
    upsert("q1", "What would you do first?");
    expect(shown()).toEqual([["What would you do first?", "answering"]]);
    act(finish);
    await settle();
    expect(shown()).toEqual([["What would you do first?", "answered"]]);
  });

  it("is 'answering' from the click until the answer the user asked for has finished", async () => {
    setAutoTrigger(false);
    const { finish } = answersRunUntilStopped();
    const { answer, shown } = mountFlow();
    upsert("q1", "What would you do first?");
    expect(shown()).toEqual([["What would you do first?", "open"]]);
    answer("What would you do first?");
    await settle();
    expect(shown()).toEqual([["What would you do first?", "answering"]]);
    act(finish);
    await settle();
    expect(shown()).toEqual([["What would you do first?", "answered"]]);
  });
});

describe("rule 1: a complete question is answered at once", () => {
  it("answers the model's question as soon as it is complete, with no quiet wait", () => {
    const { shown } = mountFlow();
    upsert("q1", "这个数据库的恢复时间目标是多少？");
    expect(runUserAction).toHaveBeenCalledWith("Assist", "这个数据库的恢复时间目标是多少？", autoOpts());
    expect(shown()).toEqual([["这个数据库的恢复时间目标是多少？", "answered"]]);
    expect(useQuestionStore.getState().autoAnswer).toMatchObject({ questionId: "q1", early: false });
  });

  it("waits while the question is still being asked, and answers early once it is complete", async () => {
    const { shown } = mountFlow();
    asking("q1", "How would you");
    asking("q1", "How would you roll the release");
    await settle();
    expect(runUserAction).not.toHaveBeenCalled();
    expect(shown()).toEqual([["How would you roll the release", "detecting"]]);

    // Complete while they are still speaking: an early answer.
    askedWhileSpeaking("q1", "How would you roll the release back?");
    await settle();
    expect(askedFor()).toEqual(["How would you roll the release back?"]);
    expect(useQuestionStore.getState().autoAnswer).toMatchObject({ questionId: "q1", early: true });
  });

  it("answers the rules' guess at once too, without waiting for the model", () => {
    answersRunUntilStopped();
    const { shown } = mountFlow();
    guess("q1", "What would you do first?");
    expect(askedFor()).toEqual(["What would you do first?"]);
    expect(shown()).toEqual([["What would you do first?", "answering"]]);
  });

  it("answers a question once: the model confirming it doesn't answer it again", async () => {
    mountFlow();
    guess("q1", "What would you do first?");
    upsert("q1", "What would you do first?");
    upsert("q1", "What would you do first ?");
    await later(5000);
    expect(runUserAction).toHaveBeenCalledTimes(1);
  });

  it("answers an implied question, which has no question words", () => {
    mountFlow();
    upsert("q1", "请解释这个上线计划如何控制风险。", { ask_kind: "implicit" });
    expect(runUserAction).toHaveBeenCalledWith("Assist", "请解释这个上线计划如何控制风险。", autoOpts());
  });

  it("answers a new question after the previous one was answered, each its own card", async () => {
    const { questions, shown } = mountFlow();
    upsert("q1", "怎么上线？");
    await settle();
    upsert("q2", "那出了故障怎么回滚？");
    await settle();
    expect(askedFor()).toEqual(["怎么上线？", "那出了故障怎么回滚？"]);
    expect(shown()).toEqual([["那出了故障怎么回滚？", "answered"], ["怎么上线？", "answered"]]);
    expect(questions().map((q) => q.id)).toEqual(["q2", "q1"]);
  });

  it("with Auto-Answer off, only lists it; a click answers it with the query rewrite", async () => {
    setAutoTrigger(false);
    const { answer, shown } = mountFlow();
    upsert("q1", "What would you do first?");
    await later(5000);
    expect(runUserAction).not.toHaveBeenCalled();
    expect(shown()).toEqual([["What would you do first?", "open"]]);

    answer("What would you do first?");
    await settle();
    expect(runUserAction).toHaveBeenCalledWith("Assist", "What would you do first?");
  });
});

describe("rule 2: a question that changes a lot while it is answered", () => {
  it("tells a different question from a reworded one", () => {
    expect(changedALot("How would you roll back the release?", "how would you roll back the release")).toBe(false);
    expect(changedALot("How would you roll back the release?", "How would you roll back the release safely?")).toBe(false);
    expect(changedALot("What would you do?", "What would you do if the build broke at night?")).toBe(true);
    expect(changedALot("怎么上线？", "怎么上线？")).toBe(false);
    expect(changedALot("你们怎么上线？", "出了故障以后数据库怎么回滚？")).toBe(true);
  });

  it("stops the early answer and answers the new wording", async () => {
    answersRunUntilStopped();
    const { questions, shown } = mountFlow();
    askedWhileSpeaking("q1", "What would you do?");
    const early = requestOf(0);

    askedWhileSpeaking("q1", "What would you do if the build broke at night?");
    await settle();
    expect(cancelGeneration).toHaveBeenCalledWith(early);
    expect(askedFor()).toEqual(["What would you do?", "What would you do if the build broke at night?"]);
    expect(optsOf(1)).toEqual(autoOpts());
    expect(questions().map((q) => q.id)).toEqual(["q1"]);
    expect(shown()).toEqual([["What would you do if the build broke at night?", "answering"]]);
  });

  it("doesn't start over when only punctuation or case changed", async () => {
    answersRunUntilStopped();
    const { questions } = mountFlow();
    askedWhileSpeaking("q1", "what would you do first");
    upsert("q1", "What would you do first?");
    await settle();
    expect(cancelGeneration).not.toHaveBeenCalled();
    expect(runUserAction).toHaveBeenCalledTimes(1);
    expect(questions()[0]).toMatchObject({ text: "What would you do first?", status: "answering", revisedSinceAnswer: false });
  });

  it("doesn't start over for a revision that keeps most of the words", async () => {
    answersRunUntilStopped();
    mountFlow();
    askedWhileSpeaking("q1", "How would you roll back the release?");
    upsert("q1", "How would you roll back the release safely?");
    await settle();
    expect(cancelGeneration).not.toHaveBeenCalled();
    expect(runUserAction).toHaveBeenCalledTimes(1);
  });

  it("starts over at most once; after that the card offers a new answer", async () => {
    const { finish } = answersRunUntilStopped();
    const { answer, questions } = mountFlow();
    askedWhileSpeaking("q1", "What would you do?");
    askedWhileSpeaking("q1", "What would you do if the build broke?");
    await settle();
    expect(runUserAction).toHaveBeenCalledTimes(2);

    // Revised a lot again: the second answer keeps going.
    upsert("q1", "Which monitoring tools have you used in production?");
    await settle();
    expect(runUserAction).toHaveBeenCalledTimes(2);
    expect(questions()[0]).toMatchObject({ status: "answering", revisedSinceAnswer: true });

    act(finish);
    await settle();
    expect(questions()[0]).toMatchObject({ status: "answered", revisedSinceAnswer: true });
    // "Answer again" is a click: the user's own request.
    answer("Which monitoring tools have you used in production?");
    await settle();
    expect(askedFor()[2]).toBe("Which monitoring tools have you used in production?");
    expect(optsOf(2)).toBeUndefined();
    expect(questions()[0]).toMatchObject({ status: "answering", revisedSinceAnswer: false });
  });

  it("doesn't answer again by itself once the answer is over", async () => {
    const { finish } = answersRunUntilStopped();
    const { questions } = mountFlow();
    askedWhileSpeaking("q1", "What would you do?");
    act(finish);
    await settle();
    upsert("q1", "What would you do if the build broke at night?");
    await settle();
    expect(runUserAction).toHaveBeenCalledTimes(1);
    expect(cancelGeneration).not.toHaveBeenCalled();
    expect(questions()[0]).toMatchObject({ status: "answered", revisedSinceAnswer: true });
  });

  it("revised twice while the stop is still letting go: answers the newest wording, once", async () => {
    answersRunUntilStopped({ releaseMs: 500 });
    const { shown } = mountFlow();
    askedWhileSpeaking("q1", "What would you do?");
    askedWhileSpeaking("q1", "What would you do if the build broke?");
    await settle();
    upsert("q1", "What would you do if the build broke during a release at night?");
    await later(500);
    expect(askedFor()).toEqual(["What would you do?", "What would you do if the build broke during a release at night?"]);
    expect(shown()).toEqual([["What would you do if the build broke during a release at night?", "answering"]]);
  });

  it("an answer starting over for a prepared question replays the prepared answer", async () => {
    answersRunUntilStopped();
    mountFlow();
    askedWhileSpeaking("q1", "What would you do?");
    upsert("q1", "When can we ship this project?", { prepared: true });
    await settle();
    expect(runUserAction).toHaveBeenLastCalledWith("Assist", "When can we ship this project?", autoOpts(true));
  });
});

describe("rule 3: the model turns down the rules' guess", () => {
  it("stops the answer to it and drops the card", async () => {
    answersRunUntilStopped();
    const { shown } = mountFlow();
    guess("q1", "So you'd say that's fine?");
    const guessed = requestOf(0);
    remove("q1", "veto");
    await settle();
    expect(cancelGeneration).toHaveBeenCalledWith(guessed);
    expect(shown()).toEqual([]);
    expect(useQuestionStore.getState().autoAnswer).toBeNull();
  });

  it("a veto after the answer finished stops nothing, and the answered card stays", async () => {
    const { finish } = answersRunUntilStopped();
    const { shown } = mountFlow();
    guess("q1", "So you'd say that's fine?");
    act(finish);
    await settle();
    remove("q1", "veto");
    await settle();
    expect(cancelGeneration).not.toHaveBeenCalled();
    expect(shown()).toEqual([["So you'd say that's fine?", "answered"]]);
  });

  it("a veto doesn't stop an answer the user asked for", async () => {
    setAutoTrigger(false);
    answersRunUntilStopped();
    const { answer, shown } = mountFlow();
    guess("q1", "So you'd say that's fine?");
    answer("So you'd say that's fine?");
    await settle();
    remove("q1", "veto");
    await settle();
    expect(cancelGeneration).not.toHaveBeenCalled();
    expect(shown()).toEqual([["So you'd say that's fine?", "answering"]]);
  });

  it("a superseded question's answer stops, and the question held behind it gets the answer", async () => {
    answersRunUntilStopped();
    const { shown } = mountFlow();
    askedWhileSpeaking("q1", "How do you test?");
    upsert("q2", "How do you test the payment service end to end?");
    await settle();
    expect(shown()).toEqual([
      ["How do you test the payment service end to end?", "held"], ["How do you test?", "answering"],
    ]);
    remove("q1", "superseded");
    await settle();
    expect(cancelGeneration).toHaveBeenCalledWith(requestOf(0));
    expect(askedFor()).toEqual(["How do you test?", "How do you test the payment service end to end?"]);
    expect(shown()).toEqual([["How do you test the payment service end to end?", "answering"]]);
  });

  it("a reset doesn't stop an answer that is running", async () => {
    answersRunUntilStopped();
    const { shown } = mountFlow();
    upsert("q1", "What would you do first?");
    remove("q1", "reset");
    await settle();
    expect(cancelGeneration).not.toHaveBeenCalled();
    expect(shown()).toEqual([["What would you do first?", "answering"]]);
  });
});

describe("rule 4: you are already answering", () => {
  it("doesn't start after you said 12 words since the question came up; it waits for a click", async () => {
    const { shown } = mountFlow();
    asking("q1", "How would you design the");
    youSay("So I think the first thing I would look at is how the");
    upsert("q1", "How would you design the cache?");
    await settle();
    expect(runUserAction).not.toHaveBeenCalled();
    expect(shown()).toEqual([["How would you design the cache?", "held"]]);
  });

  it("doesn't start after you talked for more than 6 seconds", async () => {
    const { shown } = mountFlow();
    asking("q1", "How would you design the");
    youSay("I think that's a");
    await later(6500);
    youSay("I think that's a good");
    upsert("q1", "How would you design the cache?");
    await settle();
    expect(runUserAction).not.toHaveBeenCalled();
    expect(shown()).toEqual([["How would you design the cache?", "held"]]);
  });

  it("short replies don't count", async () => {
    mountFlow();
    asking("q1", "How would you design the");
    youSay("Mm.", "you_1", true);
    await later(4000);
    youSay("Okay, sure.", "you_2", true);
    await later(4000);
    youSay("Yeah.", "you_3", true);
    upsert("q1", "How would you design the cache?");
    await settle();
    expect(askedFor()).toEqual(["How would you design the cache?"]);
  });

  it("what you said before the question came up doesn't count", () => {
    youSay("Before that I spent two years running the platform team at a fintech startup.");
    mountFlow();
    upsert("q1", "What did the platform team own?");
    expect(askedFor()).toEqual(["What did the platform team own?"]);
  });

  it("talking after the answer started doesn't stop it", async () => {
    answersRunUntilStopped();
    const { shown } = mountFlow();
    upsert("q1", "How would you design the cache?");
    youSay("So I think the first thing I would look at is how the reads are spread");
    await later(8000);
    expect(cancelGeneration).not.toHaveBeenCalled();
    expect(shown()).toEqual([["How would you design the cache?", "answering"]]);
  });
});

describe("rule 5: one answer at a time", () => {
  it("never stops an answer you asked for: the question waits as a card to click", async () => {
    useStreamStore.setState({ isStreaming: true, streamRequestId: "yours" });
    const { shown } = mountFlow();
    upsert("q1", "What would you do first?");
    await later(5000);
    expect(runUserAction).not.toHaveBeenCalled();
    expect(cancelGeneration).not.toHaveBeenCalled();
    expect(shown()).toEqual([["What would you do first?", "held"]]);
  });

  it("two questions in one turn: the first is answered, the second waits", async () => {
    answersRunUntilStopped();
    const { shown } = mountFlow();
    askedWhileSpeaking("q1", "Why did you leave your last job?");
    askedWhileSpeaking("q2", "And what are you looking for now?");
    upsert("q2", "And what are you looking for now?");
    await settle();
    expect(askedFor()).toEqual(["Why did you leave your last job?"]);
    expect(shown()).toEqual([
      ["And what are you looking for now?", "held"], ["Why did you leave your last job?", "answering"],
    ]);
  });

  it("clicking another question during an automatic answer stops it and answers yours", async () => {
    answersRunUntilStopped();
    const { answer, shown } = mountFlow();
    upsert("q1", "Which database did you pick?");
    upsert("q2", "What would you do first?");
    await settle();
    expect(shown()).toEqual([["What would you do first?", "held"], ["Which database did you pick?", "answering"]]);
    const automatic = requestOf(0);

    answer("What would you do first?");
    await settle();
    expect(cancelGeneration).toHaveBeenCalledWith(automatic);
    expect(askedFor()).toEqual(["Which database did you pick?", "What would you do first?"]);
    // The question it stopped goes back to a card to click.
    expect(shown()).toEqual([["What would you do first?", "answering"], ["Which database did you pick?", "held"]]);
  });

  it("clicking the question being answered doesn't restart its answer", async () => {
    answersRunUntilStopped();
    const { answer } = mountFlow();
    upsert("q1", "What would you do first?");
    answer("What would you do first?");
    await settle();
    expect(cancelGeneration).not.toHaveBeenCalled();
    expect(runUserAction).toHaveBeenCalledTimes(1);
  });

  it("a refused automatic answer leaves the question to click, not marked answered", async () => {
    vi.mocked(runUserAction).mockRejectedValue(REFUSED);
    const { shown } = mountFlow();
    upsert("q1", "What would you do first?");
    await settle();
    expect(shown()).toEqual([["What would you do first?", "held"]]);
  });

  it("a click that gets no answer stays a card to click, and says why", async () => {
    setAutoTrigger(false);
    vi.mocked(runUserAction).mockRejectedValue(REFUSED);
    const { answer, shown } = mountFlow();
    upsert("q1", "What would you do first?");
    answer("What would you do first?");
    await settle();
    expect(shown()).toEqual([["What would you do first?", "held"]]);
    expect(useToastStore.getState().toasts.map((t) => t.message)).toContain("Another answer is still running");
  });
});

describe("rule 6: a prepared answer replays", () => {
  const hit = () => upsert("q1", "When can we ship this project?", { prepared: true });

  it("replays at once and once, with Auto-Answer off, without a fresh generation", async () => {
    setAutoTrigger(false);
    const { questions } = mountFlow();
    hit();
    expect(questions()[0]).toMatchObject({ text: "When can we ship this project?", prepared: true });
    expect(runUserAction).toHaveBeenCalledWith("Assist", "When can we ship this project?", autoOpts(true));
    upsert("q1", "When can we ship this project?", { prepared: true });
    await later(5000);
    expect(runUserAction).toHaveBeenCalledTimes(1);
  });

  it("doesn't interrupt a foreground stream", async () => {
    useStreamStore.setState({ isStreaming: true, streamRequestId: "yours" });
    const { shown } = mountFlow();
    hit();
    await later(5000);
    expect(runUserAction).not.toHaveBeenCalled();
    expect(shown()).toEqual([["When can we ship this project?", "held"]]);
  });

  it("a stale prepared hit doesn't fall back to a provider call when Auto-Answer is off", async () => {
    setAutoTrigger(false);
    vi.mocked(runUserAction).mockRejectedValueOnce(new Error("Prepared answer no longer available"));
    const { questions } = mountFlow();
    hit();
    await later(5000);
    expect(runUserAction).toHaveBeenCalledTimes(1);
    // The question is still there to click, no longer as a prepared one.
    expect(questions()).toMatchObject([{ text: "When can we ship this project?", status: "open", prepared: false }]);
  });

  it("a stale prepared hit gets a fresh answer when Auto-Answer is on", async () => {
    vi.mocked(runUserAction).mockRejectedValueOnce(new Error("Prepared answer no longer available"));
    mountFlow();
    hit();
    await settle();
    expect(runUserAction).toHaveBeenCalledTimes(2);
    expect(runUserAction).toHaveBeenLastCalledWith("Assist", "When can we ship this project?", autoOpts());
  });

  it("doesn't replay for a transcript scope the user picked", async () => {
    setAutoTrigger(false);
    useConfigStore.setState({ contextScope: { kind: "minutes", minutes: 10 } });
    mountFlow();
    hit();
    await later(5000);
    expect(runUserAction).not.toHaveBeenCalled();
  });

  it("a prepared answer for a question whose early answer is running: the early answer goes on", async () => {
    answersRunUntilStopped();
    const { questions } = mountFlow();
    askedWhileSpeaking("q1", "When can we ship this project?");
    upsert("q1", "When can we ship this project?", { prepared: true });
    await settle();
    expect(runUserAction).toHaveBeenCalledTimes(1);
    expect(cancelGeneration).not.toHaveBeenCalled();
    expect(questions()[0]).toMatchObject({ status: "answering", prepared: true });
  });
});

describe("steps that run into each other", () => {
  it("a new question arriving while a stop is still letting go waits for it, and isn't refused", async () => {
    answersRunUntilStopped({ releaseMs: 800 });
    const { shown } = mountFlow();
    askedWhileSpeaking("q1", "What would you do?");
    askedWhileSpeaking("q1", "What would you do if the build broke?");
    upsert("q2", "How long have you worked with Kubernetes?");
    await later(400);
    // Still letting go: nothing new has started.
    expect(askedFor()).toEqual(["What would you do?"]);
    await later(400);
    expect(askedFor()).toEqual(["What would you do?", "What would you do if the build broke?"]);
    expect(shown()).toEqual([
      ["How long have you worked with Kubernetes?", "held"],
      ["What would you do if the build broke?", "answering"],
    ]);
  });

  it("the user's click during a stop wins over the automatic start it was queued with", async () => {
    answersRunUntilStopped({ releaseMs: 800 });
    const { answer, shown } = mountFlow();
    guess("q1", "So that's fine?");
    remove("q1", "veto");
    upsert("q2", "How long have you worked with Kubernetes?");
    answer("How long have you worked with Kubernetes?");
    await later(800);
    expect(askedFor()).toEqual(["So that's fine?", "How long have you worked with Kubernetes?"]);
    expect(optsOf(1)).toBeUndefined(); // the user's own request
    expect(shown()).toEqual([["How long have you worked with Kubernetes?", "answering"]]);
  });

  it("a click on a question its automatic answer is about to start doesn't answer it twice", async () => {
    answersRunUntilStopped({ releaseMs: 800 });
    const { answer } = mountFlow();
    askedWhileSpeaking("q1", "What would you do?");
    askedWhileSpeaking("q1", "What would you do if the build broke?");
    answer("What would you do if the build broke?");
    await later(800);
    expect(askedFor()).toEqual(["What would you do?", "What would you do if the build broke?"]);
  });
});

describe("Auto-Answer with the provider's turn signals (Cartesia, Deepgram Flux)", () => {
  // Rule-based detection: the local rules decide on the signal.
  beforeEach(() => setDetectionMode("rules"));

  it("answers as soon as the provider says the speaker finished", async () => {
    const { shown } = mountFlow();
    send(turnLine("Thanks. What would you do first?", "end"));
    await settle();
    expect(askedFor()).toEqual(["What would you do first?"]);
    // The backend's question for the line doesn't answer it a second time.
    guess("q1", "What would you do first?", { line_id: "them_t1" });
    await later(5000);
    expect(runUserAction).toHaveBeenCalledTimes(1);
    expect(shown()).toEqual([["What would you do first?", "answered"]]);
  });

  it("starts early on 'probably done' and keeps that answer when the turn ends the same", async () => {
    mountFlow();
    send(turnLine("What would you do first?", "eager_end"));
    await settle();
    expect(askedFor()).toEqual(["What would you do first?"]);
    send(turnLine("What would you do first?", "end"));
    await settle();
    expect(runUserAction).toHaveBeenCalledTimes(1);
    expect(cancelGeneration).not.toHaveBeenCalled();
  });

  it("stops the early answer when they keep talking, and answers the whole question at the end", async () => {
    answersRunUntilStopped();
    const { shown } = mountFlow();
    send(turnLine("What would you do", "eager_end"));
    await settle();
    const early = requestOf(0);
    send(turnLine("What would you do", "resumed"));
    await settle();
    expect(cancelGeneration).toHaveBeenCalledWith(early);
    expect(shown()).toEqual([["What would you do", "held"]]);

    send(turnLine("What would you do if the build broke?", "end"));
    await settle();
    expect(askedFor()).toEqual(["What would you do", "What would you do if the build broke?"]);
  });

  it("replaces the early answer when the turn ends with a different question", async () => {
    answersRunUntilStopped();
    mountFlow();
    send(turnLine("What would you do?", "eager_end"));
    await settle();
    send(turnLine("What would you do if the build broke?", "end"));
    await settle();
    expect(cancelGeneration).toHaveBeenCalledWith(requestOf(0));
    expect(askedFor()).toEqual(["What would you do?", "What would you do if the build broke?"]);
  });

  it("keeps the upstream request: no skipQueryRewrite on a turn signal's answer", async () => {
    mountFlow();
    send(turnLine("What would you do first?", "end"));
    await settle();
    expect(optsOf(0)).toEqual({ requestId: expect.any(String) });
  });

  it("never stops an answer you asked for: the question waits as a card to click", async () => {
    useStreamStore.setState({ isStreaming: true, streamRequestId: "yours" });
    const { shown } = mountFlow();
    send(turnLine("What would you do first?", "end"));
    await later(5000);
    expect(runUserAction).not.toHaveBeenCalled();
    expect(cancelGeneration).not.toHaveBeenCalled();
    expect(shown()).toEqual([["What would you do first?", "held"]]);
  });

  it("answers nothing on turn signals with Auto-Answer off", async () => {
    setAutoTrigger(false);
    mountFlow();
    send(turnLine("What would you do first?", "eager_end"));
    send(turnLine("What would you do first?", "end"));
    await settle();
    expect(runUserAction).not.toHaveBeenCalled();
  });

  it("leaves the decision to question detection outside rule-based detection", async () => {
    setDetectionMode("hybrid");
    mountFlow();
    send(turnLine("What would you do first?", "end"));
    await settle();
    expect(runUserAction).not.toHaveBeenCalled();

    upsert("q1", "What would you do first?", { line_id: "them_t1" });
    expect(askedFor()).toEqual(["What would you do first?"]);
  });
});

describe("the flow coming back (layout switch, Settings)", () => {
  const question = "What would you do first?";

  it("doesn't answer an answered question again, and still shows it as answered", async () => {
    const first = mountFlow();
    upsert("q1", question);
    expect(runUserAction).toHaveBeenCalledTimes(1);

    first.unmount();
    const back = mountFlow();
    await later(5000);
    expect(runUserAction).toHaveBeenCalledTimes(1);
    expect(back.shown()).toEqual([[question, "answered"]]);
  });

  it("shows a question asked while away without answering it, then answers the next one", async () => {
    mountFlow().unmount();
    upsert("q1", question);
    await settle();
    const back = mountFlow();
    expect(back.shown()).toEqual([[question, "held"]]);
    expect(runUserAction).not.toHaveBeenCalled();

    upsert("q2", "And how long would it take?", { timestamp_ms: 2, line_id: "them_2" });
    await settle();
    expect(runUserAction).toHaveBeenCalledWith("Assist", "And how long would it take?", autoOpts());
  });

  it("a question being asked when it comes back is answered once it is complete", async () => {
    const first = mountFlow();
    asking("q1", "What would you");
    first.unmount();
    mountFlow();
    upsert("q1", question);
    await settle();
    expect(askedFor()).toEqual([question]);
  });

  it("a question completed while away waits for a click", async () => {
    const first = mountFlow();
    asking("q1", "What would you");
    first.unmount();
    upsert("q1", question);
    await settle();
    const back = mountFlow();
    expect(runUserAction).not.toHaveBeenCalled();
    expect(back.shown()).toEqual([[question, "held"]]);
  });

  it("keeps a dismissed question dismissed", () => {
    setAutoTrigger(false);
    const first = mountFlow();
    upsert("q1", question);
    first.dismiss(question);
    expect(first.shown()).toEqual([]);
    first.unmount();
    expect(mountFlow().shown()).toEqual([]);
  });

  it("starts empty in a new meeting, and answers its first question", async () => {
    setAutoTrigger(false);
    const first = mountFlow();
    upsert("q1", question);
    first.dismiss(question);
    first.unmount();

    await act(async () => { await resetMeetingScopedStores(); });
    setAutoTrigger(true);
    revisions.clear();
    const next = mountFlow();
    expect(next.shown()).toEqual([]);
    // The new meeting counts its questions from q1 again: not the old dismissed one.
    upsert("q1", question);
    expect(runUserAction).toHaveBeenCalledWith("Assist", question, autoOpts());
  });
});

describe("question rules", () => {
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
        notes_folders: [{ id: "f1", label: "Vault", path: "D:\\Vault", enabled: true }],
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

  it("Auto-Answer on a turn signal never sends sources, even with both pills on", async () => {
    setDetectionMode("rules");
    bothPillsOn();
    mountFlow();
    send(turnLine("Thanks. What would you do first?", "end"));
    await settle();
    expect(askedFor()).toEqual(["What would you do first?"]);
    expect(optsOf(0)).not.toHaveProperty("sources");
  });

  it("Auto-Answer to a detected question never sends sources either", async () => {
    bothPillsOn();
    mountFlow();
    upsert("q1", "What would you do first?");
    await settle();
    expect(askedFor()).toEqual(["What would you do first?"]);
    expect(optsOf(0)).not.toHaveProperty("sources");
  });

  it("clicking a question card is your own request, so it sends the pills that are on", async () => {
    setAutoTrigger(false);
    bothPillsOn();
    const { answer } = mountFlow();
    upsert("q1", "Which database did you pick?");
    answer("Which database did you pick?");
    await settle();
    expect(vi.mocked(runUserAction)).toHaveBeenCalledWith(
      "Assist", "Which database did you pick?", { sources: { notes: true, tools: true } },
    );
  });
});
