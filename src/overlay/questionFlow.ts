// The overlay's questions and their automatic answers: which questions the
// other party asked, which one gets answered and when. The question strip
// (QuestionStrip.tsx) renders what `useQuestionFlow()` returns and nothing else.
//
// Questions come from question detection v2 (`question_event`, SPEC 3.4) while
// the other party is still speaking. Auto-Answer (SPEC 4.2):
// 1. answers a question once it is complete, with no quiet wait; begun while
//    they are still speaking, that is an early answer;
// 2. starts over (once per question) when a question it is answering changes
//    a lot; when its answer is over, the card offers a new answer instead;
// 3. stops when the model turns the rules' guess down (or a newer question
//    takes its place);
// 4. doesn't start when you are already answering (12 words or more than
//    6 seconds since the question came up; short replies don't count);
// 5. doesn't interrupt another answer: the question waits as a card to click;
//    an answer you ask for always stops an automatic one;
// 6. replays a prepared answer, with Auto-Answer off too;
// 7. asks the backend to skip the knowledge-base query rewrite.
// Steps that start or stop answers run one at a time (`inTurn`), so a start
// never races a stop that is still letting go.

import { useEffect, useMemo, useRef } from "react";
import { create } from "zustand";
import { t } from "../i18n";
import { onTranscriptFinal, onTranscriptUpdate } from "../lib/events";
import { onQuestionEvent, type DetectedQuestionV2, type QuestionEvent } from "../lib/questionDetection/events";
import { runUserAction } from "../lib/userAction";
import {
  REFUSED, answerRunning, autoAnswerRunning, decideTurnStep, inTurn, logAutoAnswer, runYourAction, sameQuestion,
  stopAutoAnswer, useAutoAnswerRunning,
} from "../lib/autoAnswer";
import { useTranscriptStore } from "../stores/transcriptStore";
import { useAIActionsStore } from "../stores/aiActionsStore";
import { useConfigStore } from "../stores/configStore";
import { numbered, useQuestionStore, type AutoAnswerRef, type TrackedQuestion } from "../stores/questionStore";
import { useQuestionDetectionStore } from "../stores/questionDetectionStore";
import { showToast } from "../stores/toastStore";
import type { DetectedQuestion, TranscriptSegment, TranscriptUpdateEvent } from "../lib/types";

/** Below this word-set similarity a revision is a different question (rule 2). */
export const REVISION_SIMILARITY = 0.6;
/** How often Auto-Answer may start over for one question (rule 2). */
export const MAX_AUTO_RESTARTS = 1;
/** You are already answering after this many words since the question came up (rule 4)… */
export const YOU_ANSWERING_WORDS = 12;
/** …or after talking for longer than this (rule 4). */
export const YOU_ANSWERING_MS = 6000;
/** A line of yours shorter than this ("Mm.", "Okay, sure") is a reply, not an answer. */
export const SHORT_REPLY_WORDS = 4;

/** A question as the strip shows it. */
export interface FlowQuestion {
  /** Names the question for `answer` and `dismiss`; it stays the same while the question is listed. */
  id: string;
  text: string;
  /** Asked outright, or implied by what they said ("maybe you can tell me about…"). */
  askKind: "direct" | "implicit";
  /**
   * "detecting": a first guess the model has not confirmed yet (the rules'
   * guess at a pause), or a question still being asked; "open": can be
   * answered; "answering": its answer is being sent or is arriving;
   * "answered"; "held": not answered automatically, waits for a click.
   */
  status: "detecting" | "open" | "answering" | "answered" | "held";
  /** An answer was prepared for it in advance. */
  prepared: boolean;
  timestampMs: number;
  /**
   * Answered (or being answered) for an earlier wording that differs a lot
   * from `text`: `answer(id)` asks again with the new one. The strip can offer
   * "answer again" for it. (Optional only so that older code building a
   * FlowQuestion by hand still compiles; the flow always sets it.)
   */
  revisedSinceAnswer?: boolean;
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

// Local question rules, kept in step with src-tauri/src/intelligence/question_detector.rs.
// The backend decides which lines are questions (question_event);
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

const isYou = (speaker: string) => ["user", "you"].includes(speaker.toLowerCase());

/** Whether question detection runs on the local rules alone (no model). */
const rulesOnly = () => useQuestionDetectionStore.getState().view?.effective_mode === "rules";

/** A prepared answer may only replay for the default transcript scope. */
const defaultScope = () => {
  const scope = useConfigStore.getState().contextScope;
  return !scope || scope.kind === "default";
};

const autoTriggerOn = () => useAIActionsStore.getState().configs.globalDefaults.autoTrigger;

// ── words ──────────────────────────────────────────────────────────────────

/** `Intl.Segmenter` (ES2022; the project's TypeScript lib is older). */
interface WordSegmenter {
  segment(text: string): Iterable<{ segment: string; isWordLike?: boolean }>;
}
const Segmenter = (Intl as unknown as {
  Segmenter?: new (locale: string | undefined, options: { granularity: "word" }) => WordSegmenter;
}).Segmenter;
const segmenter = Segmenter ? new Segmenter(undefined, { granularity: "word" }) : null;

/** The words of `text`, lower case (Chinese and Japanese split into words too). */
export function wordsOf(text: string): string[] {
  if (segmenter) {
    const words: string[] = [];
    for (const part of segmenter.segment(text.toLowerCase())) if (part.isWordLike) words.push(part.segment);
    return words;
  }
  return text.toLowerCase().match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}']+/gu) ?? [];
}

/**
 * Whether a revision makes it a different question (rule 2): more than
 * punctuation and case changed, and the two share few words.
 */
export function changedALot(before: string, after: string): boolean {
  if (sameQuestion(before, after)) return false;
  const a = new Set(wordsOf(before));
  const b = new Set(wordsOf(after));
  const union = new Set([...a, ...b]).size;
  if (union === 0) return false;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / union < REVISION_SIMILARITY;
}

// ── your own words (rule 4) ────────────────────────────────────────────────

/** Your recent transcript lines: when they started effective speech, last grew, and word count. */
const yourLines = new Map<string, { firstAt: number; firstValidAt: number | null; lastAt: number; words: number }>();
/** Snapshot of your words taken when each other-party transcript line first arrived. */
const yourWordsAtLine = new Map<string, { at: number; words: Map<string, number> }>();
/** For each card: when its question came up, and how many words each line of yours had then. */
const yourWordsWhenAsked = new Map<string, { at: number; words: Map<string, number> }>();

function snapshotYourWords(at: number): { at: number; words: Map<string, number> } {
  const words = new Map<string, number>();
  for (const [id, line] of yourLines) words.set(id, line.words);
  return { at, words };
}

function trackYourWords(segments: readonly TranscriptSegment[]) {
  if (segments.length === 0) {
    yourLines.clear();
    yourWordsAtLine.clear();
    return;
  }
  const now = Date.now();
  const start = Math.max(0, segments.length - 30);
  // Walk chronologically so pre-existing segments snapshot your words as they stood when each question line arrived.
  for (let i = start; i < segments.length; i++) {
    const seg = segments[i];
    if (isYou(seg.speaker)) {
      const words = wordsOf(seg.pending_text || seg.text).length;
      const line = yourLines.get(seg.id);
      if (!line) {
        yourLines.set(seg.id, {
          firstAt: now,
          firstValidAt: words >= SHORT_REPLY_WORDS ? now : null,
          lastAt: now,
          words,
        });
      } else if (line.words !== words) {
        if (line.firstValidAt === null && words >= SHORT_REPLY_WORDS) line.firstValidAt = now;
        Object.assign(line, { lastAt: now, words });
      }
    } else if (!yourWordsAtLine.has(seg.id)) {
      yourWordsAtLine.set(seg.id, snapshotYourWords(now));
    }
  }
  // Only the last minutes matter.
  for (const [id, line] of yourLines) if (now - line.lastAt > 5 * 60_000) yourLines.delete(id);
  for (const [id, snap] of yourWordsAtLine) if (now - snap.at > 5 * 60_000) yourWordsAtLine.delete(id);
}

function rememberYourWords(cardId: string, lineId?: string) {
  const atLine = lineId ? yourWordsAtLine.get(lineId) : undefined;
  if (atLine) {
    yourWordsWhenAsked.set(cardId, { at: atLine.at, words: new Map(atLine.words) });
    return;
  }
  yourWordsWhenAsked.set(cardId, snapshotYourWords(Date.now()));
}

/** Whether you have been answering since the card's question came up (rule 4). */
function youAreAnswering(cardId: string): boolean {
  const asked = yourWordsWhenAsked.get(cardId);
  if (!asked) return false;
  let words = 0;
  let firstSpoke = Infinity;
  let lastSpoke = -Infinity;
  for (const [id, line] of yourLines) {
    if (line.words < SHORT_REPLY_WORDS) continue;
    // Words a line already had when the question came up don't count.
    const added = Math.max(0, line.words - (asked.words.get(id) ?? 0));
    if (added === 0) continue;
    words += added;
    const start = Math.max(line.firstValidAt ?? line.firstAt, asked.at);
    if (start < firstSpoke) firstSpoke = start;
    if (line.lastAt > lastSpoke) lastSpoke = line.lastAt;
  }
  const ms = lastSpoke > firstSpoke ? lastSpoke - firstSpoke : 0;
  return words >= YOU_ANSWERING_WORDS || ms > YOU_ANSWERING_MS;
}

// ── the flow's state ───────────────────────────────────────────────────────

/**
 * Questions whose answer the user asked for with a click, until that answer
 * has finished (or could not start). An automatic answer is tracked by the
 * question store's `autoAnswer`.
 */
const useClickedAnswers = create<{ ids: readonly string[] }>(() => ({ ids: [] }));

/** How many question strips are mounted: Auto-Answer starts answers only while one is. */
let mounted = 0;
let meetingVersion = 0;

const cardsNow = () => useQuestionStore.getState().questions;
const cardById = (id: string) => cardsNow().find((q) => q.id === id);

/** Whether `ref` is the automatic answer to the card `id`, still running. */
function answeringCard(ref: AutoAnswerRef | null, id: string): ref is AutoAnswerRef {
  return !!ref && ref.questionId === id && autoAnswerRunning();
}

/** The automatic answer `ref` was premature: stop it, then give its turn to `next` (card ids). */
function withdraw(ref: AutoAnswerRef, next: () => string[]) {
  useQuestionStore.getState().setAutoAnswer(null);
  const version = meetingVersion;
  void inTurn(async () => {
    if (meetingVersion !== version) return;
    await stopAutoAnswer(ref);
    if (meetingVersion === version) startDue(next());
  });
}

/** The cards held behind `requestId`, now free to be answered. */
function releaseHeldBy(requestId: string): string[] {
  const released = cardsNow().filter((q) => q.heldBack && q.heldBy === requestId).map((q) => q.id);
  for (const id of released) useQuestionStore.getState().updateCard(id, { heldBack: false, heldBy: undefined });
  return released;
}

// ── question events ────────────────────────────────────────────────────────

function onUpsert(q: DetectedQuestionV2) {
  if (isYou(q.source)) return;
  const store = useQuestionStore.getState();
  if (store.isDismissed(q.id)) return;
  const cards = store.questions;
  // A card from a provider's turn signal for the same line and words becomes this question.
  const card = cards.find((c) => c.backendId === q.id)
    ?? cards.find((c) => !c.backendId && c.segmentId === q.line_id && sameQuestion(c.text, q.text));
  if (card?.backendId === q.id && (card.revision ?? 0) >= q.revision) return; // out of date

  const ref = store.autoAnswer;
  const restart = !!card && answeringCard(ref, card.id) && changedALot(ref.question, q.text)
    && (card.autoRestarts ?? 0) < MAX_AUTO_RESTARTS;
  const id = card?.id ?? numbered(cards, q.id);
  const next: TrackedQuestion = {
    ...card,
    id,
    backendId: q.id,
    revision: q.revision,
    text: q.text,
    confidence: card?.confidence ?? 1,
    timestamp_ms: q.timestamp_ms,
    source: q.source as DetectedQuestion["source"],
    segmentId: q.line_id,
    complete: q.complete,
    origin: q.origin,
    askKind: q.ask_kind,
    prepared: q.prepared,
    speakerDone: q.speaker_done,
    assisted: card?.assisted ?? false,
    ...(restart ? { assisted: false, heldBack: false, autoRestarts: (card?.autoRestarts ?? 0) + 1 } : {}),
  };
  if (!card) {
    rememberYourWords(id, q.line_id);
    for (const omitted of cards.slice(9)) yourWordsWhenAsked.delete(omitted.id);
  }
  useQuestionStore.setState((state) => ({
    questions: card
      ? state.questions.map((c) => (c.id === card.id ? next : c))
      : [next, ...state.questions].slice(0, 10),
  }));

  if (restart && ref) {
    logAutoAnswer("restarted");
    withdraw(ref, () => [id]);
  } else {
    const version = meetingVersion;
    void inTurn(() => {
      if (meetingVersion === version) startDue([id]);
    });
  }
}

function onRemove(backendId: string, reason: "veto" | "superseded" | "reset") {
  const store = useQuestionStore.getState();
  const card = store.questions.find((c) => c.backendId === backendId);
  if (!card) return;
  const ref = store.autoAnswer;
  if (reason !== "reset" && answeringCard(ref, card.id)) {
    yourWordsWhenAsked.delete(card.id);
    store.removeCard(card.id);
    logAutoAnswer(reason === "veto" ? "vetoed" : "withdrawn");
    withdraw(ref, () => releaseHeldBy(ref.requestId));
    return;
  }
  // Its answer is there, or on its way because you asked: the card stays with it.
  if (card.assisted) return;
  yourWordsWhenAsked.delete(card.id);
  store.removeCard(card.id);
}

function onEvent(event: QuestionEvent) {
  if (event.kind === "upsert") onUpsert(event.question);
  else onRemove(event.id, event.reason);
}

// Questions also arrive while the panel is away (a layout switch, Settings),
// so they're tracked for the overlay window's lifetime.
let listening: Promise<() => void> | null = null;
let stopTrackingWords: (() => void) | null = null;

function listenForQuestions() {
  if (!stopTrackingWords) {
    trackYourWords(useTranscriptStore.getState().segments);
    stopTrackingWords = useTranscriptStore.subscribe((s, before) => {
      if (s.segments !== before.segments) trackYourWords(s.segments);
    });
  }
  if (listening) return;
  const subscribed = onQuestionEvent(onEvent);
  listening = subscribed;
  subscribed.catch(() => {
    if (listening === subscribed) listening = null;
  });
}

export function resetQuestionDetectionForTests() {
  void listening?.then((unlisten) => unlisten()).catch(() => {});
  listening = null;
  stopTrackingWords?.();
  stopTrackingWords = null;
  resetQuestionFlowForMeeting();
}

export function resetQuestionFlowForMeeting() {
  ++meetingVersion;
  yourLines.clear();
  yourWordsAtLine.clear();
  yourWordsWhenAsked.clear();
  useClickedAnswers.setState({ ids: [] });
}

// ── automatic answers ──────────────────────────────────────────────────────

/**
 * Starts the automatic answers that are due among `ids` (newest first): a
 * prepared answer replays; with Auto-Answer on, a complete question gets an
 * answer unless another one is running or you are already answering. Run it
 * in turn (`inTurn`).
 */
function startDue(ids: readonly string[]) {
  if (mounted === 0) return;
  const due = cardsNow().filter((c) => ids.includes(c.id));
  for (const card of due) {
    if (card.assisted || card.heldBack || card.complete === false) continue;
    // A provider's turn signals answer that line (rule-based detection).
    if (useQuestionStore.getState().isTurnLine(card.segmentId)) continue;
    const replay = !!card.prepared && defaultScope();
    if (!replay && !autoTriggerOn()) continue;
    if (answerRunning()) {
      const ref = useQuestionStore.getState().autoAnswer;
      useQuestionStore.getState().holdBackCard(card.id, ref && autoAnswerRunning() ? ref.requestId : undefined);
      logAutoAnswer("held");
      continue;
    }
    if (!replay && youAreAnswering(card.id)) {
      useQuestionStore.getState().holdBackCard(card.id);
      logAutoAnswer("youAnswering");
      continue;
    }
    answerCard(card, replay);
  }
}

/** Answers the card's question by itself; `preparedOnly` replays its prepared answer. */
function answerCard(card: TrackedQuestion, preparedOnly: boolean) {
  const store = useQuestionStore.getState();
  const requestId = crypto.randomUUID();
  const early = card.speakerDone === false;
  store.updateCard(card.id, { assisted: true, heldBack: false, heldBy: undefined, answeredText: card.text });
  const opts = { requestId, skipQueryRewrite: true, ...(preparedOnly ? { preparedOnly: true } : {}) };
  const done = runUserAction("Assist", card.text, opts).catch((err) => {
    const refused = String(err).includes(REFUSED);
    const now = useQuestionStore.getState();
    if (now.autoAnswer?.requestId !== requestId) return;
    now.setAutoAnswer(null);
    if (refused || !preparedOnly) {
      now.holdBackCard(card.id);
      logAutoAnswer("held");
    } else {
      // A settings change or expiry can invalidate a prepared answer between
      // its confirmation and the replay. The question stays available, and
      // gets a fresh answer only when Auto-Answer is on.
      now.updateCard(card.id, { assisted: false, prepared: false, answeredText: undefined });
      const version = meetingVersion;
      void inTurn(() => {
        if (meetingVersion === version) startDue([card.id]);
      });
    }
  });
  store.setAutoAnswer({
    requestId, segmentId: card.segmentId ?? card.id, question: card.text, early, done, questionId: card.id,
  });
  const seenAt = yourWordsWhenAsked.get(card.id)?.at;
  const detail = [
    preparedOnly ? "a prepared answer" : card.origin === "rules" ? "the rules' guess" : "the model's question",
    ...(seenAt !== undefined ? [`${Date.now() - seenAt} ms after it came up`] : []),
  ].join(", ");
  logAutoAnswer(early ? "early" : "answered", detail);
}

/**
 * An automatic answer on a provider's turn signal, unless another answer is
 * running: then the question stays a card to click.
 */
function startTurnAnswer(question: DetectedQuestion, segmentId: string, early: boolean, detail: string) {
  const store = useQuestionStore.getState();
  if (answerRunning()) {
    // A turn signal can come before the line's card: it shows now.
    if (!store.questions.some((q) => q.segmentId === segmentId)) store.addQuestion(question, segmentId);
    useQuestionStore.getState().holdBack(segmentId, question.text);
    logAutoAnswer("held");
    return;
  }
  store.answerLine(question, segmentId);
  const requestId = crypto.randomUUID();
  const done = runUserAction("Assist", question.text, { requestId }).catch(() => {
    const now = useQuestionStore.getState();
    if (now.autoAnswer?.requestId !== requestId) return;
    now.setAutoAnswer(null);
    now.holdBack(segmentId, question.text);
    logAutoAnswer("held");
  });
  store.setAutoAnswer({ requestId, segmentId, question: question.text, early, done });
  logAutoAnswer(early ? "early" : "answered", detail);
}

/** Auto-Answer for a line that carries the provider's turn signal (rule-based detection only). */
async function onTurnSignal(seg: TranscriptSegment, signalAt: number, version: number) {
  if (meetingVersion !== version || !seg.turn || !autoTriggerOn() || !rulesOnly()) return;
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
  if (step.kind === "answer" && meetingVersion === version) {
    const q = { text: step.question, confidence: 0.9, timestamp_ms: seg.timestamp_ms, source: seg.speaker };
    startTurnAnswer(q, seg.id, step.early, `${seg.turn}, ${Date.now() - signalAt} ms after the signal`);
  }
}

// ── what a click does ──────────────────────────────────────────────────────

/** The user asked for this question's answer (a click on its card). */
function answerQuestion(id: string) {
  const store = useQuestionStore.getState();
  const question = cardById(id);
  if (!question || useClickedAnswers.getState().ids.includes(id)) return;
  // Its automatic answer is on the way: a click doesn't restart it (unless the question changed since).
  const ref = store.autoAnswer;
  const replacingAuto = autoAnswerRunning() && ref && (ref.questionId
    ? ref.questionId === id
    : ref.segmentId === question.segmentId && sameQuestion(ref.question, question.answeredText ?? question.text));
  if (replacingAuto && !changedALot(ref.question, question.text)) return;
  const version = meetingVersion;
  const isCurrent = () => meetingVersion === version;
  store.updateCard(id, { assisted: true, heldBack: false, heldBy: undefined, answeredText: question.text });
  useClickedAnswers.setState((s) => ({ ids: [...s.ids, id] }));
  runYourAction("Assist", question.text, undefined, { id, isCurrent })
    .catch((err) => {
      if (!isCurrent()) return;
      const now = useQuestionStore.getState();
      const refused = String(err).includes(REFUSED);
      if (!replacingAuto && (question.assisted || (refused && question.heldBack))) {
        const { assisted, heldBack, heldBy, answeredText } = question;
        now.updateCard(id, { assisted, heldBack, heldBy, answeredText });
      } else {
        now.holdBackCard(id);
      }
      showToast(
        t(refused ? "overlay:modes.errors.anotherRunning" : "overlay:modes.errors.generateFailed"),
        "error",
      );
    })
    .finally(() => {
      if (isCurrent()) useClickedAnswers.setState((s) => ({ ids: s.ids.filter((other) => other !== id) }));
    });
}

/** The user closed this question. */
function dismissQuestion(id: string) {
  const store = useQuestionStore.getState();
  const index = store.questions.findIndex((q) => q.id === id);
  if (index >= 0) {
    yourWordsWhenAsked.delete(id);
    store.dismiss(index);
  }
}

/**
 * The questions of the meeting and what a click on one does. It also runs
 * everything that happens by itself while it is mounted: it answers questions
 * as question detection finds them (or on the provider's turn signals), and
 * leaves questions that were unanswered when it came back as cards to click.
 * Mount it in one place (the question strip).
 */
export function useQuestionFlow(): QuestionFlow {
  const cards = useQuestionStore((s) => s.questions);
  const autoTrigger = useAIActionsStore((s) => s.configs.globalDefaults.autoTrigger);
  const turnSignals = useQuestionDetectionStore((s) => autoTrigger && s.view?.effective_mode === "rules");
  const mountedRef = useRef(false);

  useEffect(() => {
    listenForQuestions();
    mounted += 1;
    return () => {
      mounted -= 1;
    };
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
  // "done", or early on "probably done". Only with rule-based detection.
  useEffect(() => {
    if (!turnSignals) return;
    const onLine = ({ segment }: TranscriptUpdateEvent) => {
      if (!segment.turn || !isOtherParty(segment.speaker)) return;
      useQuestionStore.getState().markTurnLine(segment.id);
      const at = Date.now();
      const version = meetingVersion;
      void inTurn(() => onTurnSignal(segment, at, version));
    };
    const updates = onTranscriptUpdate(onLine);
    const finals = onTranscriptFinal(onLine);
    return () => {
      updates.then((u) => u());
      finals.then((u) => u());
    };
  }, [turnSignals]);

  // Whose answer is on its way: the automatic one's question, and the ones clicked.
  const autoAnswer = useQuestionStore((s) => s.autoAnswer);
  const autoRunning = useAutoAnswerRunning();
  const clicked = useClickedAnswers((s) => s.ids);
  const questions = useMemo(
    () => cards.map((card): FlowQuestion => {
      const automatic = autoRunning && !!autoAnswer && (autoAnswer.questionId
        ? autoAnswer.questionId === card.id
        : autoAnswer.segmentId === card.segmentId && sameQuestion(autoAnswer.question, card.text));
      const answering = clicked.includes(card.id) || automatic;
      const unconfirmed = card.origin === "rules" || card.complete === false;
      return {
        id: card.id,
        text: card.text,
        askKind: card.askKind ?? "direct",
        status: card.assisted
          ? (answering ? "answering" : "answered")
          : card.heldBack ? "held" : unconfirmed ? "detecting" : "open",
        prepared: !!card.prepared,
        timestampMs: card.timestamp_ms,
        revisedSinceAnswer: card.assisted && !!card.answeredText && changedALot(card.answeredText, card.text),
      };
    }),
    [cards, autoAnswer, autoRunning, clicked],
  );

  return { questions, answer: answerQuestion, dismiss: dismissQuestion };
}
