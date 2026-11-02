import { listen } from "@tauri-apps/api/event";
import type { DetectedQuestion } from "../types";

export interface DetectionPending {
  revision: number;
  timestamp_ms: number;
  source: string;
}

export interface DetectionResult extends DetectionPending {
  original_text: string;
  question: DetectedQuestion | null;
  prepared?: boolean;
}

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

export const onQuestionDetectionPending = (handler: (event: DetectionPending) => void) =>
  listen<DetectionPending>("question_detection_pending", (event) => handler(event.payload));

export const onQuestionDetectionResult = (handler: (event: DetectionResult) => void) =>
  listen<DetectionResult>("question_detection_result", (event) => handler(event.payload));

export const onQuestionDetectionLog = (handler: (event: DetectionLog) => void) =>
  listen<DetectionLog>("question_detection_log", (event) => handler(event.payload));
