import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { QuestionDetectionSettings, QuestionDetectionSettingsView } from "./types";

export function getQuestionDetectionSettings(): Promise<QuestionDetectionSettingsView> {
  return invoke("get_question_detection_settings");
}

export function setQuestionDetectionSettings(settings: QuestionDetectionSettings): Promise<QuestionDetectionSettingsView> {
  return invoke("set_question_detection_settings", { settings });
}

export function onQuestionDetectionSettingsChanged(handler: (view: QuestionDetectionSettingsView) => void): Promise<UnlistenFn> {
  return listen<QuestionDetectionSettingsView>("question_detection_settings_changed", (event) => handler(event.payload));
}
