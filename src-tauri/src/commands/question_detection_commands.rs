//! Persisted question-classifier preferences, shared by both windows.

use crate::intelligence::llm_question::{
    QuestionDetectionService, QuestionDetectionSettings, QuestionDetectionSettingsView,
};
use tauri::{AppHandle, State};

#[tauri::command]
pub fn get_question_predictions(
    service: State<'_, crate::intelligence::question_prediction::QuestionPredictionService>,
) -> crate::intelligence::question_prediction::PredictionView {
    service.view()
}

#[tauri::command]
pub fn get_question_detection_settings(
    app: AppHandle,
    service: State<'_, QuestionDetectionService>,
) -> QuestionDetectionSettingsView {
    service.view(&app)
}

#[tauri::command]
pub fn set_question_detection_settings(
    app: AppHandle,
    service: State<'_, QuestionDetectionService>,
    settings: QuestionDetectionSettings,
) -> Result<QuestionDetectionSettingsView, String> {
    service.set_settings(&app, settings)
}
