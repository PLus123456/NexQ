import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface Prediction {
  id: string;
  question: string;
  confidence: number;
  status: "predicted" | "preparing" | "ready" | "unavailable";
  answer: string | null;
}

export interface PredictionView {
  meeting_id: string | null;
  revision: number;
  enabled: boolean;
  expires_at_ms: number;
  predictions: Prediction[];
}

export const getQuestionPredictions = () => invoke<PredictionView>("get_question_predictions");
export const onQuestionPredictions = (handler: (view: PredictionView) => void) =>
  listen<PredictionView>("question_predictions_changed", (event) => handler(event.payload));
