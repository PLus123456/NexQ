import { useEffect, useRef, useCallback } from "react";
import { create } from "zustand";
import { HelpCircle, Sparkles, Check, Clock, X } from "lucide-react";
import { useT } from "../i18n";
import { onTranscriptFinal, onTranscriptUpdate } from "../lib/events";
import {
  onQuestionDetectionPending, onQuestionDetectionResult, type DetectionPending, type DetectionResult,
} from "../lib/questionDetection/events";
import { runUserAction } from "../lib/userAction";
import {
  REFUSED, answerRunning, autoAnswerRunning, decideTurnStep, inTurn, logAutoAnswer, runYourAction, sameQuestion,
  stopAutoAnswer,
} from "../lib/autoAnswer";
import { useTranscriptStore } from "../stores/transcriptStore";
import { useAIActionsStore } from "../stores/aiActionsStore";
import { useConfigStore } from "../stores/configStore";
import { useQuestionStore, type TrackedQuestion } from "../stores/questionStore";
import { useQuestionDetectionStore } from "../stores/questionDetectionStore";
import { showToast } from "../stores/toastStore";
import { QuestionPredictions } from "./QuestionPredictions";
import type { DetectedQuestion, TranscriptSegment, TranscriptUpdateEvent } from "../lib/types";

/**
 * Quiet time after the other party's last words before Auto-Trigger answers
 * their question, so a question still being asked isn't answered half-way.
 */
export const AUTO_TRIGGER_DELAY_MS = 1500;

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
      ...question, assisted: false, segmentId, revision: event.revision, prepared: event.prepared,
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

/**
 * The overlay's question card, unless question detection is off. Predicted
 * questions (M2) show with detection off too, and so do their cards: a
 * prepared answer replays when its question is detected.
 */
export function QuestionPanel() {
  const questionDetection = useAIActionsStore((s) => s.configs.globalDefaults.questionDetection);
  const predictionEnabled = useQuestionDetectionStore((s) => s.view?.settings?.prediction_enabled ?? false);
  if (!questionDetection && !predictionEnabled) return null;
  return (
    <div className="shrink-0 rounded-xl border border-info/10 bg-info/5 px-4 py-3">
      <QuestionDetector />
      <QuestionPredictions />
    </div>
  );
}

export function QuestionDetector() {
  const { t } = useT("overlay");
  const questions = useQuestionStore((s) => s.questions) as DetectedCard[];
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
  }, [questions]);

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

  const handleAssist = useCallback((index: number) => {
    const question = questions[index];
    if (!question) return;
    // Its automatic answer is on the way: a click doesn't restart it.
    const store = useQuestionStore.getState();
    if (autoAnswerRunning() && sameQuestion(store.autoAnswer?.question, question.text)) return;
    store.markAssisted(index);
    runYourAction("Assist", question.text).catch((err) => {
      // No answer came, so it stays a card to click.
      useQuestionStore.getState().holdBack(question.segmentId, question.text);
      showToast(String(err).includes(REFUSED) ? "Another answer is still running" : t("modes.errors.generateFailed"), "error");
    });
  }, [questions, t]);

  const handleDismiss = useCallback((index: number, e: React.MouseEvent) => {
    e.stopPropagation();
    useQuestionStore.getState().dismiss(index);
  }, []);

  const latest = questions.length > 0 ? questions[0] : null;
  const previousQuestions = questions.slice(1, 4);

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

  return (
    <div className="flex flex-col gap-2.5" role="region" aria-label={t("question.region.ariaLabel")}>
      {/* Latest question — prominent card */}
      <div
        className={`group flex items-start gap-3 rounded-lg transition-all duration-200 ${
          latest ? "cursor-pointer hover:bg-info/10 question-card-enter" : ""
        }`}
        onClick={() => latest && handleAssist(0)}
        onKeyDown={(e) => { if (latest && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); handleAssist(0); } }}
        role={latest ? "button" : undefined}
        tabIndex={latest ? 0 : undefined}
        aria-label={
          latest
            ? t(latest.assisted ? "question.card.labelAnswered" : "question.card.labelPending", { text: latest.text })
            : undefined
        }
      >
        <div className="relative mt-0.5 shrink-0" aria-hidden="true">
          <HelpCircle className={`h-5 w-5 transition-colors ${latest ? "text-info" : "text-muted-foreground/50"}`} />
          {latest && !latest.assisted && (
            <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-info animate-pulse" />
          )}
          {latest?.assisted && (
            <span className="absolute -top-0.5 -right-0.5 flex h-3 w-3 items-center justify-center rounded-full bg-success">
              <Check className="h-2 w-2 text-white" />
            </span>
          )}
        </div>

        <div className="flex-1 min-w-0">
          {latest ? (
            <p className="text-sm leading-relaxed font-medium text-foreground/90">
              &ldquo;{latest.text}&rdquo;
            </p>
          ) : (
            <p className="text-xs text-muted-foreground/50">
              {t("question.empty")}
            </p>
          )}
        </div>

        {latest && (
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={(e) => { e.stopPropagation(); handleAssist(0); }}
              aria-label={latest.assisted ? t("question.button.answeredLabel") : t("question.button.assistLabel")}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all duration-150 cursor-pointer ${
                latest.assisted
                  ? "bg-success/10 border border-success/20 text-success"
                  : "bg-info/10 border border-info/20 text-info hover:bg-info/20"
              }`}
            >
              {latest.assisted ? (
                <><Check className="h-3.5 w-3.5" aria-hidden="true" />{t("question.answered")}</>
              ) : (
                <><Sparkles className="h-3.5 w-3.5" aria-hidden="true" />{t("question.assist")}</>
              )}
            </button>
            <button
              onClick={(e) => handleDismiss(0, e)}
              aria-label={t("question.dismiss")}
              className="rounded-lg p-1.5 text-muted-foreground/30 opacity-0 transition-all duration-150 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Previous questions — compact list */}
      {previousQuestions.length > 0 && (
        <div className="flex flex-col gap-1">
          {previousQuestions.map((q, idx) => {
            const realIdx = idx + 1;
            return (
              <div
                key={`q-${realIdx}-${q.timestamp_ms}`}
                className={`group/q flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-all duration-150 question-card-enter ${
                  q.assisted
                    ? "bg-success/5 border border-success/10"
                    : "bg-card/20 hover:bg-card/40 hover:border-border/20 cursor-pointer"
                }`}
                onClick={() => !q.assisted && handleAssist(realIdx)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleAssist(realIdx); } }}
                title={q.text}
              >
                <div className="shrink-0">
                  {q.assisted ? (
                    <div className="flex h-4 w-4 items-center justify-center rounded-full bg-success/20">
                      <Check className="h-2.5 w-2.5 text-success" />
                    </div>
                  ) : (
                    <div className="flex h-4 w-4 items-center justify-center rounded-full bg-muted/30">
                      <Clock className="h-2.5 w-2.5 text-muted-foreground/60" />
                    </div>
                  )}
                </div>

                <span className={`flex-1 truncate text-xs leading-snug transition-colors ${
                  q.assisted
                    ? "text-success/70 font-medium"
                    : "text-muted-foreground/60 group-hover/q:text-foreground/80"
                }`}>
                  {q.text}
                </span>

                {!q.assisted && (
                  <Sparkles className="h-3 w-3 shrink-0 text-info/0 group-hover/q:text-info/60 transition-colors" />
                )}
                <button
                  onClick={(e) => handleDismiss(realIdx, e)}
                  aria-label={t("question.dismiss")}
                  className="rounded p-0.5 text-muted-foreground/0 opacity-0 transition-all duration-150 hover:bg-destructive/10 hover:text-destructive group-hover/q:opacity-100 group-hover/q:text-muted-foreground/30 cursor-pointer"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
