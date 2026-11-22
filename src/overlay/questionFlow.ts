// The overlay's questions and their automatic answers: which questions the
// other party asked, which one gets answered and when. The question strip
// (QuestionStrip.tsx) renders what `useQuestionFlow()` returns and nothing else.

import { useEffect, useMemo, useRef } from "react";
import { create } from "zustand";
import { t } from "../i18n";
import { onTranscriptFinal, onTranscriptUpdate } from "../lib/events";
import {
  onQuestionDetectionPending, onQuestionDetectionResult, type DetectionPending, type DetectionResult,
} from "../lib/questionDetection/events";
import { runUserAction } from "../lib/userAction";
import {
  REFUSED, answerRunning, autoAnswerRunning, decideTurnStep, inTurn, logAutoAnswer, runYourAction, sameQuestion,
  stopAutoAnswer, useAutoAnswerRunning,
} from "../lib/autoAnswer";
import { useTranscriptStore } from "../stores/transcriptStore";
import { useAIActionsStore } from "../stores/aiActionsStore";
import { useConfigStore } from "../stores/configStore";
import { newQuestionId, useQuestionStore, type TrackedQuestion } from "../stores/questionStore";
import { useQuestionDetectionStore } from "../stores/questionDetectionStore";
import { showToast } from "../stores/toastStore";
import type { DetectedQuestion, TranscriptSegment, TranscriptUpdateEvent } from "../lib/types";

/**
 * Quiet time after the other party's last words before Auto-Trigger answers
 * their question, so a question still being asked isn't answered half-way.
 */
export const AUTO_TRIGGER_DELAY_MS = 1500;

/** A question as the strip shows it. */
export interface FlowQuestion {
  /** Names the question for `answer` and `dismiss`; it stays the same while the question is listed. */
  id: string;
  text: string;
  /** Asked outright, or implied by what they said. Every question is "direct" for now. */
  askKind: "direct" | "implicit";
  /**
   * "detecting": a first guess the model has not confirmed (not produced yet);
   * "open": can be answered; "answering": its answer is being sent or is
   * arriving; "answered"; "held": not answered automatically, waits for a click.
   */
  status: "detecting" | "open" | "answering" | "answered" | "held";
  /** An answer was prepared for it in advance. */
  prepared: boolean;
  timestampMs: number;
}

export interface QuestionFlow {
  /** Newest first, at most 10. */
  questions: FlowQuestion[];
  /** The user asked for this question's answer: a running automatic answer stops for it. */
  answer: (id: string) => void;
  /** The user closed this question. */
  dismiss: (id: string) => void;
}

const isOtherParty = (speaker: string) => ["them", "interviewer"].includes(speaker.toLowerCase());
const sameSpeaker = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// Local question rules, kept in step with src-tauri/src/intelligence/question_detector.rs.
// The backend decides which lines are questions (question_detection_result);
// these rules only serve Auto-Answer on a provider's turn signals, and only
// while detection runs on the rules alone (see `rulesOnly`).

// Chinese and Japanese question signals.
const CHINESE_QUESTION_WORDS = [
  "什么", "什麼", "怎么", "怎麼", "为什么", "為什麼", "为何", "為何", "怎样", "怎樣",
  "哪", "谁", "誰", "多少", "如何", "何时", "何時", "几时", "幾時", "几点", "幾點", "多久",
  "能不能", "可不可以", "会不会", "會不會", "是不是", "有没有", "有沒有", "要不要", "是否", "能否",
];
// A question word meaning "any" or "no matter" (没什么问题, 无论如何) doesn't ask anything.
const CHINESE_NON_QUESTION_PHRASES = [
  "没什么", "沒什麼", "什么都", "什麼都", "什么也", "什麼也", "不怎么", "不怎麼",
  "哪怕", "谁都", "誰都", "谁也", "誰也", "无论", "無論", "不管", "多多少少",
];
// Interview prompts ("请介绍一下…", "说说…") ask for an answer without a question word.
const CHINESE_INTERVIEW_PATTERNS = [
  "请介绍", "請介紹", "请描述", "請描述", "请解释", "請解釋", "请举例", "請舉例",
  "介绍一下", "介紹一下", "描述一下", "解释一下", "解釋一下", "说说", "說說",
  "谈谈", "談談", "举个例子", "舉個例子",
];
// A bare か also ends ordinary words (静か, 確か, とか).
const JAPANESE_QUESTION_ENDINGS = ["ですか", "ますか", "ませんか", "でしたか", "ましたか", "でしょうか", "ましょうか", "のか", "ないか"];

// A tag on its own ("Right?", "You know?") asks nothing the AI could answer.
const TAG_QUESTIONS = new Set([
  "right", "okay", "ok", "yeah", "yep", "yes", "no", "nope", "sure", "correct", "true", "really",
  "agreed", "alright", "all right", "huh", "hmm", "hm", "eh", "see", "you see", "you know",
  "isn't it", "sorry", "pardon", "hello", "cool", "good",
]);
const TAG_LEAD_INS = new Set(["and", "so", "but", "well", "oh", "um", "uh", "okay", "ok", "yeah", "yes", "no"]);

function isTagQuestion(sentence: string): boolean {
  const words = sentence.toLowerCase().split(/[\s,.?？!…]+/u).filter(Boolean);
  while (words.length > 1 && TAG_LEAD_INS.has(words[0])) words.shift();
  return TAG_QUESTIONS.has(words.join(" "));
}

function isCjkQuestion(sentence: string): boolean {
  const body = sentence.replace(/[.!。！…]+$/u, "");
  return /[吗嗎呢]$/u.test(body)
    || JAPANESE_QUESTION_ENDINGS.some((ending) => body.endsWith(ending))
    || (CHINESE_QUESTION_WORDS.some((word) => body.includes(word))
      && !CHINESE_NON_QUESTION_PHRASES.some((phrase) => body.includes(phrase)))
    || CHINESE_INTERVIEW_PATTERNS.some((pattern) => body.includes(pattern));
}

export function looksLikeQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (isTagQuestion(trimmed)) return false;
  if (/[?？]$/u.test(trimmed) || isCjkQuestion(trimmed)) return true;
  const lower = trimmed.toLowerCase();
  const qWords = [
    "what ", "how ", "why ", "when ", "where ", "who ", "which ",
    "can you", "could you", "would you", "do you", "are you",
    "is there", "have you", "tell me", "explain",
  ];
  return qWords.some((w) => lower.startsWith(w));
}

/**
 * The newest sentence of a transcript line. Lines grow into paragraphs, so a
 * question is usually the last sentence, not the whole line. A tag after it
 * ("Is that what you meant? Right?") doesn't count as the newest sentence.
 */
export function lastSentence(text: string): string {
  const sentences = text.trim().match(/[^.?!。？！\n]+[.?!。？！]*/gu) ?? [];
  let last = sentences.length - 1;
  while (last > 0 && isTagQuestion(sentences[last])) last--;
  return (sentences[last] ?? "").trim();
}

/** A question card, with what the backend's decision says about it. */
type DetectedCard = TrackedQuestion & {
  /** Revision of the backend decision that found it. */
  revision?: number;
  /** An answer was prepared for this predicted question (M2): replay it. */
  prepared?: boolean;
};

/** Whether question detection runs on the local rules alone (no model). */
const rulesOnly = () => useQuestionDetectionStore.getState().view?.effective_mode === "rules";

/** A prepared answer may only replay for the default transcript scope. */
const defaultScope = () => {
  const scope = useConfigStore.getState().contextScope;
  return !scope || scope.kind === "default";
};

/**
 * The backend's detection revisions: `latest` is the newest line it started or
 * finished deciding; `answerable` is the decision Auto-Answer may answer (none
 * while a newer line is being decided, or after you spoke).
 */
const useDetectionRevision = create<{ latest: number; answerable: number | null }>(() => ({
  latest: 0,
  answerable: null,
}));

/**
 * Questions whose answer the user asked for with a click, until that answer
 * has finished (or could not start). An automatic answer is tracked by the
 * question store's `autoAnswer`.
 */
const useClickedAnswers = create<{ ids: readonly string[] }>(() => ({ ids: [] }));

/** The transcript line a decision is about (lines keep their start time as they grow). */
function lineIdOf(timestampMs: number, source: string): string {
  const segments = useTranscriptStore.getState().segments;
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (seg.timestamp_ms === timestampMs && sameSpeaker(seg.speaker, source)) return seg.id;
  }
  return `${source}@${timestampMs}`;
}

function onDetectionPending(event: DetectionPending) {
  if (event.revision < useDetectionRevision.getState().latest) return;
  useDetectionRevision.setState({ latest: event.revision, answerable: null });
}

function onDetectionResult(event: DetectionResult) {
  if (event.revision < useDetectionRevision.getState().latest || !isOtherParty(event.source)) return;
  useDetectionRevision.setState({ latest: event.revision, answerable: event.question ? event.revision : null });

  const segmentId = lineIdOf(event.timestamp_ms, event.source);
  const question = event.question;
  const store = useQuestionStore.getState();
  // The line's question changed while Auto-Answer was still answering the old
  // one: that answer was for an incomplete question and gives way. (Lines with
  // turn signals are handled on those signals.)
  const ref = store.autoAnswer;
  const withdrawn = question && ref && ref.segmentId === segmentId && !sameQuestion(ref.question, question.text)
    && useAIActionsStore.getState().configs.globalDefaults.autoTrigger
    && autoAnswerRunning() && !store.isTurnLine(segmentId)
    ? ref
    : null;
  if (withdrawn) {
    store.setAutoAnswer(null);
    logAutoAnswer("withdrawn");
    void inTurn(() => stopAutoAnswer(withdrawn));
  }

  useQuestionStore.setState((state) => {
    const previous = state.questions as DetectedCard[];
    const sameLine = (q: DetectedCard) => q.timestamp_ms === event.timestamp_ms && sameSpeaker(q.source, event.source);
    // A growing line replaces its last decision. A model veto also removes
    // that line's provisional card; no local heuristic can bypass it.
    const existing = previous.find((q) => sameLine(q)
      && (!q.assisted || (!!withdrawn && sameQuestion(q.text, withdrawn.question))));
    const rest = previous.filter((q) => q !== existing);
    if (!question) return { questions: rest };
    if (previous.some((q) => q.assisted && (q === previous[0] || sameLine(q)) && sameQuestion(q.text, question.text))) {
      return { questions: rest };
    }
    const card: DetectedCard = {
      ...question,
      // The line's question, decided again: still the same card to the strip.
      id: existing?.id ?? newQuestionId(rest, question, segmentId),
      assisted: false,
      segmentId,
      revision: event.revision,
      prepared: event.prepared,
    };
    return { questions: [card, ...rest].slice(0, 10) };
  });
}

// Decisions also arrive while the panel is away (a layout switch, Settings),
// so they're tracked for the overlay window's lifetime, like the questions.
let detectionListeners: Promise<Array<() => void>> | null = null;

function listenForDetections() {
  if (detectionListeners) return;
  const listening = Promise.all([
    onQuestionDetectionPending(onDetectionPending),
    onQuestionDetectionResult(onDetectionResult),
  ]);
  detectionListeners = listening;
  listening.catch(() => {
    if (detectionListeners === listening) detectionListeners = null;
  });
}

export function resetQuestionDetectionForTests() {
  void detectionListeners?.then((unlisten) => unlisten.forEach((u) => u())).catch(() => {});
  detectionListeners = null;
  useDetectionRevision.setState({ latest: 0, answerable: null });
  useClickedAnswers.setState({ ids: [] });
}

/** The question stays available after its prepared answer couldn't replay. */
function unprepare(segmentId: string | undefined, text: string) {
  useQuestionStore.setState((state) => ({
    questions: state.questions.map((q) => {
      if (q.segmentId !== segmentId || !sameQuestion(q.text, text)) return q;
      const card: DetectedCard = { ...q, assisted: false, prepared: false };
      return card;
    }),
  }));
}

/**
 * Starts an automatic answer to `question` (a line's question), unless another
 * answer is running: then the question stays a card to click. `preparedOnly`
 * replays the answer prepared for it (no provider call).
 */
function startAutoAnswer(
  question: DetectedQuestion,
  segmentId: string | undefined,
  early: boolean,
  detail?: string,
  preparedOnly = false,
) {
  const store = useQuestionStore.getState();
  if (answerRunning()) {
    // A turn signal can come before the line's card: it shows now.
    if (segmentId !== undefined && !store.questions.some((q) => q.segmentId === segmentId)) {
      store.addQuestion(question, segmentId);
    }
    useQuestionStore.getState().holdBack(segmentId, question.text);
    logAutoAnswer("held");
    return;
  }
  if (segmentId !== undefined) store.answerLine(question, segmentId);
  const requestId = crypto.randomUUID();
  const opts = preparedOnly ? { requestId, preparedOnly } : { requestId };
  const done = runUserAction("Assist", question.text, opts).catch((err) => {
    const refused = String(err).includes(REFUSED);
    if (!refused && !preparedOnly) return;
    const now = useQuestionStore.getState();
    if (now.autoAnswer?.requestId === requestId) now.setAutoAnswer(null);
    if (refused) {
      // Refused: an answer started elsewhere in the meantime.
      now.holdBack(segmentId, question.text);
      logAutoAnswer("held");
    } else {
      // A settings change or expiry can invalidate a prepared answer between
      // its confirmation and the replay. The question stays available, without
      // a paid request unless Auto-Answer is on.
      unprepare(segmentId, question.text);
    }
  });
  if (segmentId !== undefined) store.setAutoAnswer({ requestId, segmentId, question: question.text, early, done });
  logAutoAnswer(early ? "early" : "answered", detail);
}

/** Answers the newest question after the quiet wait, or replays its prepared answer. */
function autoAssist() {
  const store = useQuestionStore.getState();
  const q = store.questions[0] as DetectedCard | undefined;
  if (!q || q.assisted || q.heldBack) return;
  const preparedOnly = !!q.prepared && defaultScope();
  if (!preparedOnly && !useAIActionsStore.getState().configs.globalDefaults.autoTrigger) return;
  store.markAssisted(0);
  startAutoAnswer(q, q.segmentId, false, preparedOnly ? "a prepared answer" : "after the quiet wait", preparedOnly);
}

/** Auto-Answer for a line that carries the provider's turn signal. */
async function onTurnSignal(seg: TranscriptSegment, signalAt: number) {
  if (!seg.turn || !useAIActionsStore.getState().configs.globalDefaults.autoTrigger || !rulesOnly()) return;
  const store = useQuestionStore.getState();
  const sentence = lastSentence(seg.text);
  const question = sentence && looksLikeQuestion(sentence) ? sentence : null;
  const current = store.autoAnswer;
  const step = decideTurnStep(seg.turn, seg.id, question, current);
  if (step.kind === "none") return;
  if (step.kind === "confirm") {
    if (current) store.setAutoAnswer({ ...current, early: false });
    logAutoAnswer("kept");
    return;
  }
  // The early answer was premature: it gives way.
  if (current && (step.kind === "withdraw" || step.replaces)) {
    store.setAutoAnswer(null);
    if (step.kind === "withdraw") store.holdBack(seg.id, current.question);
    logAutoAnswer("withdrawn");
    await stopAutoAnswer(current);
  }
  if (step.kind === "answer") {
    const q = { text: step.question, confidence: 0.9, timestamp_ms: seg.timestamp_ms, source: seg.speaker };
    startAutoAnswer(q, seg.id, step.early, `${seg.turn}, ${Date.now() - signalAt} ms after the signal`);
  }
}

/** The user asked for this question's answer (a click on its card). */
function answerQuestion(id: string) {
  const store = useQuestionStore.getState();
  const index = store.questions.findIndex((q) => q.id === id);
  const question = store.questions[index];
  if (!question) return;
  // Its automatic answer is on the way: a click doesn't restart it.
  if (autoAnswerRunning() && sameQuestion(store.autoAnswer?.question, question.text)) return;
  store.markAssisted(index);
  useClickedAnswers.setState((s) => ({ ids: [...s.ids, id] }));
  runYourAction("Assist", question.text)
    .catch((err) => {
      // No answer came, so it stays a card to click.
      useQuestionStore.getState().holdBack(question.segmentId, question.text);
      showToast(
        t(String(err).includes(REFUSED) ? "overlay:modes.errors.anotherRunning" : "overlay:modes.errors.generateFailed"),
        "error",
      );
    })
    .finally(() => {
      // One click's answer is over; an earlier click on the same question may still be running.
      useClickedAnswers.setState((s) => {
        const at = s.ids.indexOf(id);
        return at < 0 ? s : { ids: s.ids.filter((_, i) => i !== at) };
      });
    });
}

/** The user closed this question. */
function dismissQuestion(id: string) {
  const store = useQuestionStore.getState();
  const index = store.questions.findIndex((q) => q.id === id);
  if (index >= 0) store.dismiss(index);
}

/**
 * The questions of the meeting and what a click on one does. It also runs
 * everything that happens by itself while it is mounted: it listens for the
 * backend's decisions, answers the newest question after the quiet wait or on
 * the provider's turn signals, and leaves questions that were unanswered when
 * it came back as cards to click. Mount it in one place (the question strip).
 */
export function useQuestionFlow(): QuestionFlow {
  const cards = useQuestionStore((s) => s.questions) as DetectedCard[];
  const answerable = useDetectionRevision((s) => s.answerable);
  const autoTrigger = useAIActionsStore((s) => s.configs.globalDefaults.autoTrigger);
  const turnSignals = useQuestionDetectionStore((s) => autoTrigger && s.view?.effective_mode === "rules");
  const scopeIsDefault = useConfigStore((s) => !s.contextScope || s.contextScope.kind === "default");
  const otherPartyTalking = useTranscriptStore((s) => {
    for (let i = s.segments.length - 1; i >= 0; i--) {
      const seg = s.segments[i];
      if (isOtherParty(seg.speaker)) return !seg.is_final || !!seg.pending_text;
    }
    return false;
  });
  // Changes whenever the other party says more (a new line, or a line growing).
  const otherPartyActivity = useTranscriptStore((s) => {
    for (let i = s.segments.length - 1; i >= 0; i--) {
      const seg = s.segments[i];
      if (isOtherParty(seg.speaker)) return `${seg.id}:${seg.text}:${seg.pending_text ?? ""}`;
    }
    return "";
  });
  const mountedRef = useRef(false);

  useEffect(() => {
    listenForDetections();
  }, []);

  useEffect(() => {
    const store = useQuestionStore.getState();
    // Back from a layout switch or Settings: what is unanswered now can be
    // minutes old, so it stays a card to click rather than getting answered.
    if (!mountedRef.current) {
      mountedRef.current = true;
      if (store.panelSeen) store.holdBackUnanswered();
    }
    if (!store.panelSeen) store.setPanelSeen();
  }, [cards]);

  // Providers that detect turns (Cartesia, Deepgram Flux): answer on their
  // "done", or early on "probably done", instead of waiting for quiet. Only
  // with rule-based detection: a model's decision comes after the final line.
  useEffect(() => {
    if (!turnSignals) return;
    const onLine = ({ segment }: TranscriptUpdateEvent) => {
      if (!segment.turn || !isOtherParty(segment.speaker)) return;
      useQuestionStore.getState().markTurnLine(segment.id);
      const at = Date.now();
      void inTurn(() => onTurnSignal(segment, at));
    };
    const updates = onTranscriptUpdate(onLine);
    const finals = onTranscriptFinal(onLine);
    return () => {
      updates.then((u) => u());
      finals.then((u) => u());
    };
  }, [turnSignals]);

  const latest = cards.length > 0 ? cards[0] : null;

  // Auto-Trigger: answer the newest question the backend confirmed once the
  // other party has been quiet for a moment. More words from them restart the
  // wait; a newer line being decided, or your own words, cancel it. A prepared
  // answer replays at once, with Auto-Answer off too, unless a transcript scope
  // is picked. Lines from a provider that detects turns are answered on its
  // signals instead.
  const preparedReplay = !!latest?.prepared && scopeIsDefault;
  const waiting = (autoTrigger || preparedReplay) && !!latest && !latest.assisted && !latest.heldBack
    && latest.revision === answerable && !otherPartyTalking
    && !useQuestionStore.getState().isTurnLine(latest.segmentId);
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => void inTurn(autoAssist), preparedReplay ? 0 : AUTO_TRIGGER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [waiting, latest?.text, preparedReplay, otherPartyActivity]);

  // Whose answer is on its way: the automatic one's question, and the ones clicked.
  const autoAnswer = useQuestionStore((s) => s.autoAnswer);
  const autoRunning = useAutoAnswerRunning();
  const clicked = useClickedAnswers((s) => s.ids);
  const questions = useMemo(
    () => cards.map((card): FlowQuestion => {
      const answering = clicked.includes(card.id)
        || (autoRunning && !!autoAnswer && autoAnswer.segmentId === card.segmentId
          && sameQuestion(autoAnswer.question, card.text));
      return {
        id: card.id,
        text: card.text,
        askKind: "direct",
        status: card.assisted ? (answering ? "answering" : "answered") : card.heldBack ? "held" : "open",
        prepared: !!card.prepared,
        timestampMs: card.timestamp_ms,
      };
    }),
    [cards, autoAnswer, autoRunning, clicked],
  );

  return { questions, answer: answerQuestion, dismiss: dismissQuestion };
}
