export type QuestionDetectionMode = "rules" | "hybrid" | "model";

export interface QuestionDetectionSettings {
  mode: QuestionDetectionMode;
  confidence_threshold: number;
  log_requests: boolean;
}

export interface QuestionDetectionSettingsView {
  revision: number;
  settings: QuestionDetectionSettings;
  effective_mode: QuestionDetectionMode;
  fallback_reason: string | null;
}
