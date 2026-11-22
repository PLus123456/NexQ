import { listen } from "@tauri-apps/api/event";

export interface DetectionLog {
  task?: "question_detect" | "question_predict" | "question_prepare";
  id: string;
  timestamp_ms: number;
  latency_ms: number;
  model: string;
  provider: string;
  system_prompt: string;
  user_prompt: string;
  response: string;
  error: string | null;
}

/**
 * A question found by question detection v2. A question that is revised keeps
 * its `id` and counts `revision` up.
 */
export interface DetectedQuestionV2 {
  /** Unique within the meeting, like "q7". */
  id: string;
  /** One more with every revision. */
  revision: number;
  /** The whole question in its own language, with what it refers to spelled out. */
  text: string;
  /** The words of the transcript where the question ends (12 at most): to find it, and to tell a repeat. */
  quote: string;
  ask_kind: "direct" | "implicit";
  /** Asked to the end: it can be answered. */
  complete: boolean;
  /** "rules": the rules' first guess at a pause; "model": confirmed or reworded by the model. */
  origin: "rules" | "model";
  /** The transcript line the question ends in. */
  line_id: string;
  timestamp_ms: number;
  source: string;
  /** When this was sent, the other party had finished speaking (a pause was detected). */
  speaker_done: boolean;
  /** An answer prepared in advance matches it (question prediction). */
  prepared: boolean;
}

/**
 * What `question_event` carries. "upsert": a new question, or a revision of
 * the one with the same id. "remove": the question is gone, because the model
 * turned down the rules' guess ("veto"), a newer question took its place
 * ("superseded"), or the meeting, the settings or the switch were reset ("reset").
 */
export type QuestionEvent =
  | { kind: "upsert"; question: DetectedQuestionV2 }
  | { kind: "remove"; id: string; reason: "veto" | "superseded" | "reset" };

export const onQuestionDetectionLog = (handler: (event: DetectionLog) => void) =>
  listen<DetectionLog>("question_detection_log", (event) => handler(event.payload));

/** Question detection v2: every change to the meeting's questions. */
export const onQuestionEvent = (handler: (event: QuestionEvent) => void) =>
  listen<QuestionEvent>("question_event", (event) => handler(event.payload));
