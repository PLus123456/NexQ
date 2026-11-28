import { create } from "zustand";
import type { DetectedQuestion } from "../lib/types";

export interface TrackedQuestion extends DetectedQuestion {
  /** Names this card for as long as it is listed (see `newQuestionId`). */
  id: string;
  assisted: boolean;
  /** Transcript line the question came from (lines grow while someone talks). */
  segmentId?: string;
  /** Not answered automatically (busy, back from elsewhere, you were answering): it waits for a click. */
  heldBack?: boolean;

  // What question detection v2 says about it (absent on a card from a turn signal).
  /** The backend's id for the question (`question_event`), which its revisions keep. */
  backendId?: string;
  /** The backend's newest revision of it. */
  revision?: number;
  /** Asked to the end, so it can be answered. Absent: complete. */
  complete?: boolean;
  /** "rules": the rules' guess at a pause, not confirmed by the model yet. */
  origin?: "rules" | "model";
  askKind?: "direct" | "implicit";
  /** An answer was prepared for it in advance (question prediction): it replays. */
  prepared?: boolean;
  /** The other party had finished speaking when the newest revision came. */
  speakerDone?: boolean;
  /** The wording its newest answer was asked with. */
  answeredText?: string;
  /** How often Auto-Answer started over because the question changed. */
  autoRestarts?: number;
  /** Held behind this automatic answer: if that answer is withdrawn, this one gets its turn. */
  heldBy?: string;
}

/** An automatic answer NexQ started, so it knows what it may stop. */
export interface AutoAnswerRef {
  requestId: string;
  /** Transcript line the question came from. */
  segmentId: string;
  question: string;
  /** Started before the other party had finished (or on "probably done"). */
  early: boolean;
  /** Settles once the answer has finished, was stopped, or was refused. */
  done: Promise<void>;
  /** The card it answers (question detection v2). Absent for an answer on a turn signal. */
  questionId?: string;
}

/**
 * The id of a new card: the transcript line it came from and when that line
 * started, numbered when the line already has a card (a line can ask twice).
 */
export function newQuestionId(
  listed: readonly TrackedQuestion[],
  question: DetectedQuestion,
  segmentId: string | undefined,
): string {
  return numbered(listed, `${segmentId ?? question.source}@${question.timestamp_ms}`);
}

/** `base`, or `base#2`, `base#3`… when a listed card already has that id. */
export function numbered(listed: readonly TrackedQuestion[], base: string): string {
  let id = base;
  for (let n = 2; listed.some((q) => q.id === id); n++) id = `${base}#${n}`;
  return id;
}

/**
 * Lines from a provider that detects turns (Cartesia, Deepgram Flux): Auto-Answer
 * follows the provider's signals there.
 */
const turnLines = new Set<string>();

/** Backend ids of questions the user closed: their later revisions stay closed. */
const dismissedIds = new Set<string>();

interface QuestionState {
  questions: TrackedQuestion[];
  /** Whether the question panel has looked at this meeting's transcript yet. */
  panelSeen: boolean;

  addQuestion: (question: DetectedQuestion, segmentId?: string) => void;
  setPanelSeen: () => void;
  /** Back from elsewhere: every complete unanswered question waits for a click. */
  holdBackUnanswered: () => void;
  markAssisted: (index: number) => void;
  dismiss: (index: number) => void;
  clear: () => void;

  /** Changes the card `id` (nothing when it isn't listed). */
  updateCard: (id: string, change: Partial<TrackedQuestion>) => void;
  removeCard: (id: string) => void;
  /** The card `id` waits for a click; `heldBy` names the automatic answer it waits behind. */
  holdBackCard: (id: string, heldBy?: string) => void;
  isDismissed: (backendId: string) => boolean;

  /** The newest automatic answer NexQ started (it may have finished since). */
  autoAnswer: AutoAnswerRef | null;
  setAutoAnswer: (ref: AutoAnswerRef | null) => void;
  /** Shows `question` as the line's question, answered (a new card if the line has none). */
  answerLine: (question: DetectedQuestion, segmentId: string) => void;
  /** The question stays a card to click; Auto-Answer leaves it alone. */
  holdBack: (segmentId: string | undefined, text: string, exceptId?: string) => void;
  markTurnLine: (segmentId: string) => void;
  isTurnLine: (segmentId: string | undefined) => boolean;
}

// The panel unmounts on a layout switch and while Settings is open, so what it
// has found and answered lives here, for the meeting.
export const useQuestionStore = create<QuestionState>((set) => ({
  questions: [],
  panelSeen: false,
  autoAnswer: null,

  addQuestion: (q, segmentId) =>
    set((state) => {
      const prev = state.questions;
      // The same line grew: update its question in place (unless already answered).
      if (segmentId) {
        const i = prev.findIndex((p) => p.segmentId === segmentId);
        if (i >= 0) {
          if (prev[i].assisted || prev[i].text === q.text) return state;
          return { questions: prev.map((p, j) => (j === i ? { ...p, text: q.text, heldBack: false } : p)) };
        }
      }
      if (prev.length > 0 && prev[0].text === q.text) return state;
      const id = newQuestionId(prev, q, segmentId);
      return { questions: [{ ...q, id, assisted: false, segmentId }, ...prev].slice(0, 10) };
    }),

  setPanelSeen: () => set({ panelSeen: true }),

  holdBackUnanswered: () =>
    set((state) => ({
      questions: state.questions.map((q) =>
        (q.assisted || q.complete === false ? q : { ...q, heldBack: true, heldBy: undefined })),
    })),

  markAssisted: (index) =>
    set((state) => ({
      questions: state.questions.map((q, i) => (i === index ? { ...q, assisted: true } : q)),
    })),

  dismiss: (index) =>
    set((state) => {
      const backendId = state.questions[index]?.backendId;
      if (backendId) dismissedIds.add(backendId);
      return { questions: state.questions.filter((_, i) => i !== index) };
    }),

  clear: () => {
    turnLines.clear();
    dismissedIds.clear();
    set({ questions: [], panelSeen: false, autoAnswer: null });
  },

  updateCard: (id, change) =>
    set((state) => (state.questions.some((q) => q.id === id)
      ? { questions: state.questions.map((q) => (q.id === id ? { ...q, ...change } : q)) }
      : state)),

  removeCard: (id) =>
    set((state) => ({ questions: state.questions.filter((q) => q.id !== id) })),

  holdBackCard: (id, heldBy) =>
    set((state) => ({
      questions: state.questions.map((q) => (q.id === id ? { ...q, assisted: false, heldBack: true, heldBy } : q)),
    })),

  isDismissed: (backendId) => dismissedIds.has(backendId),

  setAutoAnswer: (ref) => set({ autoAnswer: ref }),

  answerLine: (q, segmentId) =>
    set((state) => {
      const i = state.questions.findIndex((p) => p.segmentId === segmentId);
      if (i < 0) {
        const id = newQuestionId(state.questions, q, segmentId);
        return { questions: [{ ...q, id, assisted: true, segmentId }, ...state.questions].slice(0, 10) };
      }
      return {
        questions: state.questions.map((p, j) =>
          j === i ? { ...p, text: q.text, assisted: true, heldBack: false } : p),
      };
    }),

  holdBack: (segmentId, text, exceptId) =>
    set((state) => ({
      questions: state.questions.map((q) =>
        q.id !== exceptId && (segmentId !== undefined ? q.segmentId === segmentId : q.text === text)
          ? { ...q, assisted: false, heldBack: true }
          : q),
    })),

  markTurnLine: (segmentId) => {
    turnLines.add(segmentId);
  },

  isTurnLine: (segmentId) => segmentId !== undefined && turnLines.has(segmentId),
}));
