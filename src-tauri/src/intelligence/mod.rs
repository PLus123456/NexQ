pub mod action_config;
pub mod context_builder;
pub mod context_scope;
pub mod prompt_templates;
pub mod question_detector;
pub mod transcript_buffer;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::Emitter;

use action_config::AllActionConfigs;
use context_builder::ContextBuilder;
use question_detector::{DetectedQuestion, QuestionDetector};
use transcript_buffer::TranscriptBuffer;

use crate::llm::provider::{CancelToken, GenerationParams};
use crate::llm::cli_agent::manager::SessionScope;

/// Event payload for question detection events emitted to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionDetectedPayload {
    pub question: DetectedQuestion,
}

/// Independent result views can generate concurrently. The live answer panel
/// still owns a single lane, while each meeting task owns its own lane.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GenerationLane {
    LiveAnswer,
    MeetingTask(SessionScope, String),
}

impl GenerationLane {
    pub fn for_mode(mode: &str, scope: &SessionScope) -> Self {
        match mode {
            "MeetingSummary" | "ActionItemsExtraction" | "BookmarkSuggestions" | "MeetingAsk" =>
                Self::MeetingTask(scope.clone(), mode.to_string()),
            _ => Self::LiveAnswer,
        }
    }
}

type InFlight = HashMap<String, (GenerationLane, Arc<CancelToken>)>;

/// Releases only this request on every exit path, including early errors.
pub struct GenerationGuard {
    in_flight: Arc<Mutex<InFlight>>,
    request_id: String,
    cancel_token: Arc<CancelToken>,
}

impl GenerationGuard {
    pub fn cancel_token(&self) -> Arc<CancelToken> {
        self.cancel_token.clone()
    }
}

impl Drop for GenerationGuard {
    fn drop(&mut self) {
        if let Ok(mut requests) = self.in_flight.lock() {
            requests.remove(&self.request_id);
        }
    }
}

/// Orchestrates: read transcript -> detect question -> load context -> build prompt -> LLM stream
pub struct IntelligenceEngine {
    pub transcript_buffer: TranscriptBuffer,
    question_detector: QuestionDetector,
    auto_trigger: AtomicBool,
    /// Request-specific lanes and cancellation; held until the provider exits.
    in_flight: Arc<Mutex<InFlight>>,
    last_detected_question: Option<DetectedQuestion>,
    action_configs: AllActionConfigs,
}

impl IntelligenceEngine {
    pub fn new() -> Self {
        Self {
            transcript_buffer: TranscriptBuffer::new(),
            question_detector: QuestionDetector::new(),
            auto_trigger: AtomicBool::new(true),
            in_flight: Arc::new(Mutex::new(HashMap::new())),
            last_detected_question: None,
            action_configs: AllActionConfigs::default(),
        }
    }

    /// Push a transcript segment into the buffer and run question detection.
    /// Returns detected questions (if any) so the caller can emit events.
    pub fn push_transcript(
        &mut self,
        text: String,
        speaker: String,
        timestamp_ms: u64,
        is_final: bool,
    ) -> Vec<DetectedQuestion> {
        self.transcript_buffer
            .push_segment(text.clone(), speaker.clone(), timestamp_ms, is_final);

        // Only detect questions on final segments
        if !is_final {
            return Vec::new();
        }

        let questions = self
            .question_detector
            .detect_questions(&text, timestamp_ms, &speaker);

        // Store the most recent high-confidence question
        if let Some(q) = questions.iter().max_by(|a, b| {
            a.confidence
                .partial_cmp(&b.confidence)
                .unwrap_or(std::cmp::Ordering::Equal)
        }) {
            self.last_detected_question = Some(q.clone());
        }

        questions
    }

    /// Main entry point: generate AI assistance in the given mode.
    /// Orchestrates the full pipeline: transcript -> question -> context -> prompt -> LLM stream.
    ///
    /// This is called from the Tauri command layer. The LLMRouter and ContextManager
    /// are passed in because they live in AppState under separate locks.
    pub async fn generate_assist(
        system_prompt: &str,
        mode: &str,
        custom_question: Option<&str>,
        transcript_text: String,
        last_question: Option<DetectedQuestion>,
        context_text: String,
        include_context: bool,
        include_transcript: bool,
        include_question: bool,
        include_rag: bool,
        include_instructions: bool,
        llm_provider: Arc<tokio::sync::Mutex<Box<dyn crate::llm::provider::LLMProvider>>>,
        model: String,
        provider_name: String,
        params: GenerationParams,
        // New metadata fields for StreamStartEvent
        temperature: f64,
        rag_query: Option<String>,
        rag_chunks: Vec<crate::llm::provider::RagChunkInfo>,
        rag_chunks_filtered: usize,
        rag_total_candidates: usize,
        transcript_window_seconds: u64,
        transcript_segments_count: usize,
        transcript_segments_total: usize,
        scope_label: Option<String>,
        app_handle: tauri::AppHandle,
        cancel_token: Arc<CancelToken>,
    ) -> Result<(), String> {
        // The token is created by `begin_generation` (before the guard is handed out),
        // so a Stop pressed while the prompt is still being assembled is not lost.
        let params = GenerationParams {
            cancel: Some(cancel_token.clone()),
            ..params
        };

        // The answer language chosen in Settings → AI Models (the UI language by
        // default) closes the system prompt.
        let system_prompt = crate::llm::api::with_answer_language(system_prompt, &app_handle);

        // Build the prompt using configurable flags.
        // The system prompt IS the only instruction (per-action editable + composed instructions).
        // The user message contains only togglable data sections (transcript, RAG, questions).
        let builder = ContextBuilder::new();
        let messages = builder.build_prompt_with_config(
            &system_prompt,
            &transcript_text,
            last_question.as_ref(),
            &context_text,
            custom_question,
            include_context,
            include_transcript,
            include_question,
        );

        // Check for cancellation before starting
        if cancel_token.is_cancelled() {
            return Ok(());
        }

        // Extract actual messages for the call log
        let system_msg = messages.iter()
            .find(|m| m.role == "system")
            .map(|m| m.content.clone())
            .unwrap_or_default();
        let user_msg = messages.iter()
            .find(|m| m.role == "user")
            .map(|m| m.content.clone())
            .unwrap_or_default();

        // Emit stream start with actual prompt data
        let _ = app_handle.emit(
            "llm_stream_start",
            crate::llm::provider::StreamStartPayload {
                mode: mode.to_string(),
                model: model.clone(),
                provider: provider_name.clone(),
                system_prompt: system_msg,
                user_prompt: user_msg,
                include_transcript,
                include_rag,
                include_instructions,
                include_question,
                temperature,
                rag_query,
                rag_chunks,
                rag_chunks_filtered,
                rag_total_candidates,
                transcript_window_seconds,
                transcript_segments_count,
                transcript_segments_total,
                request_id: params.request_id.clone(),
                session_key: None,
                scope_label,
            },
        );

        // Call the LLM provider's stream_completion
        let provider_guard = llm_provider.lock().await;
        let result = provider_guard
            .stream_completion(messages, &model, params, app_handle.clone(), None)
            .await;

        // The provider already emitted llm_stream_end / llm_stream_error for this request.
        // A cancelled stream is a normal stop: `cancel_generation` emitted the end event.
        // An error that merely surfaced because the stream was stopped is not a failure.
        match result {
            Ok(_) | Err(crate::llm::provider::LLMError::Cancelled) => Ok(()),
            Err(_) if cancel_token.is_cancelled() => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }

    /// Claim one output view, without blocking unrelated meeting tasks.
    /// Cancelled requests retain their lane until the provider has stopped.
    pub fn begin_generation(&self, request_id: &str, lane: GenerationLane) -> Option<GenerationGuard> {
        let mut requests = self.in_flight.lock().ok()?;
        if requests.contains_key(request_id) || requests.values().any(|(active, _)| *active == lane) {
            return None;
        }
        let cancel_token = Arc::new(CancelToken::new());
        requests.insert(request_id.to_string(), (lane, cancel_token.clone()));
        Some(GenerationGuard {
            in_flight: self.in_flight.clone(),
            request_id: request_id.to_string(),
            cancel_token,
        })
    }

    /// Stop a specific request. Legacy callers without an id stop only the
    /// live answer panel; they never cancel a summary or another meeting's task.
    /// Return the id once, for its immediate cancelled-end event.
    pub fn cancel(&self, request_id: Option<&str>) -> Option<String> {
        let requests = self.in_flight.lock().ok()?;
        let (id, (_, token)) = match request_id {
            Some(id) => requests.get_key_value(id)?,
            None => requests.iter().find(|(_, (lane, _))| *lane == GenerationLane::LiveAnswer)?,
        };
        if token.is_cancelled() {
            return None;
        }
        token.cancel();
        Some(id.clone())
    }

    #[cfg(test)]
    pub fn is_generating(&self) -> bool {
        self.in_flight.lock().map(|r| !r.is_empty()).unwrap_or(false)
    }

    /// Toggle auto-detection of questions.
    pub fn set_auto_trigger(&self, enabled: bool) {
        self.auto_trigger.store(enabled, Ordering::SeqCst);
    }

    /// Check if auto-trigger is enabled.
    pub fn auto_trigger_enabled(&self) -> bool {
        self.auto_trigger.load(Ordering::SeqCst)
    }

    /// Set the transcript buffer context window size.
    pub fn set_context_window(&mut self, seconds: u64) {
        self.transcript_buffer.set_window_seconds(seconds);
    }

    /// Get the most recently detected question.
    pub fn last_detected_question(&self) -> Option<&DetectedQuestion> {
        self.last_detected_question.as_ref()
    }

    /// Get recent transcript text within the configured window.
    pub fn get_recent_transcript(&self) -> String {
        let window = self.transcript_buffer.window_seconds();
        self.transcript_buffer.get_recent_text(window)
    }

    /// Get all transcript text (for Recap mode with window=0).
    pub fn get_all_transcript(&self) -> String {
        self.transcript_buffer.get_all_text()
    }

    /// Set action configs (called from IPC when frontend syncs).
    pub fn set_action_configs(&mut self, configs: AllActionConfigs) {
        self.action_configs = configs;
    }

    /// Get action configs.
    pub fn get_action_configs(&self) -> &AllActionConfigs {
        &self.action_configs
    }

    /// Get a specific action config by mode key.
    pub fn get_action_config(&self, mode: &str) -> Option<&action_config::ActionConfig> {
        self.action_configs.actions.get(mode)
    }

    /// Reset per-meeting state so the next meeting starts clean.
    /// Clears the transcript buffer and last detected question.
    pub fn clear_session(&mut self) {
        self.transcript_buffer.clear();
        self.last_detected_question = None;
        log::info!("[intelligence] session cleared for new meeting");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guard_blocks_second_generation_until_dropped() {
        let engine = IntelligenceEngine::new();
        let guard = engine.begin_generation("req-1", GenerationLane::LiveAnswer).expect("first claim succeeds");
        assert!(engine.is_generating());
        assert!(engine.begin_generation("req-2", GenerationLane::LiveAnswer).is_none());
        drop(guard);
        assert!(!engine.is_generating());
        assert!(engine.begin_generation("req-3", GenerationLane::LiveAnswer).is_some());
    }

    #[test]
    fn guard_releases_on_early_error_return() {
        fn failing(engine: &IntelligenceEngine) -> Result<(), String> {
            let _guard = engine.begin_generation("req-1", GenerationLane::LiveAnswer).ok_or("busy")?;
            Err("no active provider".to_string())
        }
        let engine = IntelligenceEngine::new();
        assert!(failing(&engine).is_err());
        assert!(!engine.is_generating());
        assert!(engine.begin_generation("req-2", GenerationLane::LiveAnswer).is_some());
    }

    #[test]
    fn cancel_returns_request_id_once_and_fires_token() {
        let engine = IntelligenceEngine::new();
        assert_eq!(engine.cancel(None), None); // nothing running
        let guard = engine.begin_generation("req-1", GenerationLane::LiveAnswer).unwrap();
        let token = guard.cancel_token();
        assert!(!token.is_cancelled());
        assert_eq!(engine.cancel(None), Some("req-1".to_string()));
        assert!(token.is_cancelled());
        assert_eq!(engine.cancel(None), None);
    }

    #[test]
    fn each_generation_gets_a_fresh_cancel_token() {
        let engine = IntelligenceEngine::new();
        let first = engine.begin_generation("req-1", GenerationLane::LiveAnswer).unwrap();
        engine.cancel(None);
        assert!(first.cancel_token().is_cancelled());
        drop(first);
        let second = engine.begin_generation("req-2", GenerationLane::LiveAnswer).unwrap();
        assert!(!second.cancel_token().is_cancelled());
    }
}

#[cfg(test)]
mod concurrency_tests {
    use super::*;

    #[test]
    fn independent_views_run_and_cancel_without_affecting_each_other() {
        let engine = IntelligenceEngine::new();
        let scope = SessionScope::Past("m1".into());
        let live = engine.begin_generation("live", GenerationLane::LiveAnswer).unwrap();
        let summary = engine.begin_generation("summary", GenerationLane::for_mode("MeetingSummary", &scope)).unwrap();
        let chat = engine.begin_generation("chat", GenerationLane::for_mode("MeetingAsk", &scope)).unwrap();
        assert!(engine.begin_generation("duplicate", GenerationLane::for_mode("MeetingSummary", &scope)).is_none());
        assert!(engine.begin_generation("summary", GenerationLane::for_mode("BookmarkSuggestions", &scope)).is_none());
        assert_eq!(engine.cancel(Some("summary")), Some("summary".into()));
        assert!(summary.cancel_token().is_cancelled());
        assert!(!chat.cancel_token().is_cancelled());
        assert!(!live.cancel_token().is_cancelled());
        assert_eq!(engine.cancel(Some("summary")), None);
        assert!(engine.begin_generation("still-stopping", GenerationLane::for_mode("MeetingSummary", &scope)).is_none());
        drop(summary);
        assert!(engine.is_generating());
        assert!(engine.begin_generation("retry", GenerationLane::for_mode("MeetingSummary", &scope)).is_some());
        assert_eq!(engine.cancel(None), Some("live".into()));
        assert!(!chat.cancel_token().is_cancelled());
        drop(live);
        assert_eq!(engine.cancel(None), None);
        assert_eq!(engine.cancel(Some("missing")), None);
    }

    #[test]
    fn same_task_in_different_meetings_has_independent_lane() {
        let engine = IntelligenceEngine::new();
        let a = engine.begin_generation("a", GenerationLane::for_mode("MeetingSummary", &SessionScope::Past("a".into()))).unwrap();
        let b = engine.begin_generation("b", GenerationLane::for_mode("MeetingSummary", &SessionScope::Past("b".into()))).unwrap();
        drop(a);
        assert!(engine.is_generating());
        assert!(!b.cancel_token().is_cancelled());
        drop(b);
        assert!(!engine.is_generating());
    }
}
