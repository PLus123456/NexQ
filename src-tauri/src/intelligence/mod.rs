pub mod action_config;
pub mod context_builder;
pub mod context_scope;
pub mod prompt_templates;
pub mod question_detector;
pub mod question_core;
pub mod question_replay;
pub mod llm_question;
pub mod question_prediction;
pub mod transcript_buffer;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use action_config::AllActionConfigs;
use context_builder::ContextBuilder;
use question_detector::DetectedQuestion;
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
    auto_trigger: AtomicBool,
    /// Request-specific lanes and cancellation; held until the provider exits.
    in_flight: Arc<Mutex<InFlight>>,
    last_detected_question: Option<DetectedQuestion>,
    /// Start time of the paragraph from Them whose questions Assist stopped
    /// using because a newer question started. A final that re-sends that
    /// paragraph must not bring any of them back.
    dismissed_paragraph: Option<u64>,
    /// Id of the last final line from Them, to tell a line that continues from
    /// one that starts.
    them_final_line: Option<String>,
    /// Start time of the last final paragraph from Them. Its question is
    /// decided by the detection service after a short wait, so it may not be
    /// in `last_detected_question` yet when a newer question starts.
    them_final_started: Option<u64>,
    action_configs: AllActionConfigs,
}

impl IntelligenceEngine {
    pub fn new() -> Self {
        Self {
            transcript_buffer: TranscriptBuffer::new(),
            auto_trigger: AtomicBool::new(true),
            in_flight: Arc::new(Mutex::new(HashMap::new())),
            last_detected_question: None,
            dismissed_paragraph: None,
            them_final_line: None,
            them_final_started: None,
            action_configs: AllActionConfigs::default(),
        }
    }

    /// Store transcript context. The shared detector publishes the decision
    /// after model confirmation, so a preliminary rule match never leaks here.
    pub fn push_transcript(
        &mut self,
        text: String,
        speaker: String,
        timestamp_ms: u64,
        is_final: bool,
    ) {
        // The detection service decides about this paragraph a moment later;
        // `note_them_line` needs its start time to refuse that decision when a
        // newer question starts first.
        if is_final && from_them(&speaker) {
            self.them_final_started = Some(timestamp_ms);
        }
        self.transcript_buffer
            .push_segment(text, speaker, timestamp_ms, is_final);
    }

    /// Tell the engine about a line from Them (interim or final) with the
    /// accumulator's line id and text. When an interim starts a new line that
    /// reads as a question, the question detected from the earlier line of
    /// Them is stale: Assist stops using it until a final detects a new one.
    /// Other talk ("Mm-hmm", an answer) keeps it. Interims grow, so each one
    /// is checked; a final that starts a line is checked too. Call this before
    /// `push_transcript` (`ingest_transcript`) so a question in that final
    /// becomes the new one. Without a question Assist works from the recent
    /// transcript.
    pub fn note_them_line(&mut self, line_id: &str, text: &str, is_final: bool) {
        // A line that continues the last final one (also the old paragraph a
        // new final re-sends) changes nothing. Providers that only send
        // placeholder interims reach a new line through its final.
        let continues = self.them_final_line.as_deref() == Some(line_id);
        if is_final {
            self.them_final_line = Some(line_id.to_string());
        }
        if continues {
            return;
        }
        if !question_detector::looks_like_new_question(text) {
            return;
        }
        match self.last_detected_question.as_ref().map(|q| from_them(&q.source)) {
            Some(true) => {
                if let Some(q) = self.last_detected_question.take() {
                    self.dismissed_paragraph = Some(q.timestamp_ms);
                }
            }
            // A question of yours stays.
            Some(false) => {}
            // No decision about the earlier paragraph has arrived yet (the
            // detection service waits, then asks its model): refuse it when
            // it does.
            None => {
                if let Some(started) = self.them_final_started {
                    self.dismissed_paragraph = Some(started);
                }
            }
        }
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
                prepared: false,
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

    /// The detection service's decision about the latest line (`None`: no
    /// question). A question of a paragraph Assist already dropped does not
    /// come back: the final that re-sends that paragraph, or a decision that
    /// arrives after the newer question started, changes nothing.
    pub fn set_detected_question(&mut self, question: Option<DetectedQuestion>) {
        let dismissed = self.dismissed_paragraph;
        self.last_detected_question =
            question.filter(|q| !(from_them(&q.source) && dismissed == Some(q.timestamp_ms)));
    }

    /// Drop both the selection and the rule-mode paragraph that suppressed it.
    fn reset_detected_question(&mut self) {
        self.last_detected_question = None;
        self.dismissed_paragraph = None;
        self.them_final_line = None;
        self.them_final_started = None;
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
        self.reset_detected_question();
        log::info!("[intelligence] session cleared for new meeting");
    }
}

/// Whether a speaker label names the other party (the detection service
/// reports their questions as "Them" or "Interviewer").
fn from_them(speaker: &str) -> bool {
    speaker.eq_ignore_ascii_case("them") || speaker.eq_ignore_ascii_case("interviewer")
}

/// Observe native updates synchronously in each audio emitter's delivery order.
pub fn ingest_native_line(app: &tauri::AppHandle, line_id: &str, source: &str, text: String, timestamp_ms: u64, is_final: bool) {
    app.state::<llm_question::QuestionDetectionService>().observe(app, question_core::Update {
        line_id, source, text: &text, timestamp_ms, is_final,
    });
    if is_final {
        ingest_transcript(app, text, source.to_owned(), timestamp_ms, true);
    }
}

/// Store final transcript context and feed the speculative prediction service.
pub fn ingest_transcript(
    app: &tauri::AppHandle,
    text: String,
    speaker: String,
    timestamp_ms: u64,
    is_final: bool,
) {
    let state = app.state::<crate::state::AppState>();
    if let Some(intel) = &state.intelligence {
        if let Ok(mut engine) = intel.lock() {
            engine.push_transcript(text.clone(), speaker.clone(), timestamp_ms, is_final);
        }
    }
    if state.meeting_active.load(Ordering::SeqCst) {
        app.state::<question_prediction::QuestionPredictionService>()
            .observe(app, &text, &speaker, timestamp_ms, is_final);
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
    fn cancelling_a_named_request_leaves_any_other_running() {
        let engine = IntelligenceEngine::new();
        assert_eq!(engine.cancel(Some("auto-1")), None); // nothing running
        let guard = engine.begin_generation("yours", GenerationLane::LiveAnswer).unwrap();
        // An automatic answer that already ended must not stop yours.
        assert_eq!(engine.cancel(Some("auto-1")), None);
        assert!(!guard.cancel_token().is_cancelled());
        assert_eq!(engine.cancel(Some("yours")), Some("yours".to_string()));
        assert!(guard.cancel_token().is_cancelled());
        assert_eq!(engine.cancel(Some("yours")), None);
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

    // Questions reach the engine from the detection service
    // (`set_detected_question`), a moment after the final they are about. In
    // these tests the local rules stand in for the service's model.

    fn rule_questions(text: &str, ts: u64) -> Vec<DetectedQuestion> {
        question_detector::QuestionDetector::new().detect_questions(text, ts, "Them")
    }

    /// The detection service's decision about a final line of Them.
    fn decide(engine: &mut IntelligenceEngine, text: &str, ts: u64) {
        engine.set_detected_question(rule_questions(text, ts).pop());
    }

    /// A final line of Them as the capture loop reports it, with its decision.
    fn them_final(engine: &mut IntelligenceEngine, id: &str, text: &str, ts: u64) {
        engine.note_them_line(id, text, true);
        engine.push_transcript(text.to_string(), "Them".to_string(), ts, true);
        decide(engine, text, ts);
    }

    #[test]
    fn a_new_question_from_them_drops_the_old_detected_question() {
        let mut engine = IntelligenceEngine::new();
        them_final(&mut engine, "acc_1", "Why do you want this job?", 1_000);
        assert!(engine.last_detected_question().is_some());
        // An interim that extends the same line keeps it.
        engine.note_them_line("acc_1", "Why do you want this job? and", false);
        assert!(engine.last_detected_question().is_some());
        // A new line that is a question has started after a pause.
        engine.note_them_line("acc_2", "So how did you handle that", false);
        assert!(engine.last_detected_question().is_none());
        // The final that starts that line re-sends the old line first: it must
        // not bring the question back.
        them_final(&mut engine, "acc_1", "Why do you want this job?", 1_000);
        assert!(engine.last_detected_question().is_none());
        them_final(&mut engine, "acc_2", "So how did you handle that?", 62_000);
        assert_eq!(
            engine.last_detected_question().map(|q| q.text.as_str()),
            Some("So how did you handle that?")
        );
    }

    #[test]
    fn talk_that_is_not_a_question_keeps_the_detected_question() {
        for text in ["Mm-hmm.", "Take your time with that.", "Yeah, that makes sense.", "Okay"] {
            let mut engine = IntelligenceEngine::new();
            them_final(&mut engine, "acc_1", "Why do you want this job?", 1_000);
            engine.note_them_line("acc_2", text, false);
            assert!(engine.last_detected_question().is_some(), "{text}");
            // The final of that line does not drop it either. (What the
            // detection service then decides about that final is its own.)
            engine.note_them_line("acc_1", "Why do you want this job?", true);
            engine.note_them_line("acc_2", text, true);
            assert_eq!(
                engine.last_detected_question().map(|q| q.text.as_str()),
                Some("Why do you want this job?"),
                "{text}"
            );
        }
    }

    #[test]
    fn a_short_question_drops_it_and_so_does_a_line_that_grows_into_one() {
        let mut engine = IntelligenceEngine::new();
        them_final(&mut engine, "acc_1", "Why do you want this job?", 1_000);
        engine.note_them_line("acc_2", "Why?", false);
        assert!(engine.last_detected_question().is_none());

        let mut engine = IntelligenceEngine::new();
        them_final(&mut engine, "acc_1", "Why do you want this job?", 1_000);
        engine.note_them_line("acc_2", "Okay", false);
        assert!(engine.last_detected_question().is_some());
        engine.note_them_line("acc_2", "Okay, and what about the budget", false);
        assert!(engine.last_detected_question().is_none());
    }

    #[test]
    fn every_question_of_the_dropped_paragraph_stays_dropped() {
        let mut engine = IntelligenceEngine::new();
        let old = "Why this company? And why now?";
        them_final(&mut engine, "acc_1", old, 1_000);
        assert!(engine.last_detected_question().is_some());
        engine.note_them_line("acc_2", "How would you start", false);
        assert!(engine.last_detected_question().is_none());
        // The final re-sends the old paragraph: neither of its questions returns.
        let questions = rule_questions(old, 1_000);
        assert_eq!(questions.len(), 2);
        for question in questions {
            engine.set_detected_question(Some(question));
            assert!(engine.last_detected_question().is_none());
        }
    }

    #[test]
    fn a_final_only_line_drops_the_question_only_when_it_is_a_question() {
        // Providers with placeholder interims reach a new line only through its final.
        let mut engine = IntelligenceEngine::new();
        them_final(&mut engine, "acc_1", "Why do you want this job?", 1_000);
        them_final(&mut engine, "acc_1", "Why do you want this job?", 1_000);
        assert!(engine.last_detected_question().is_some(), "a re-send changes nothing");
        engine.note_them_line("acc_2", "So why did you choose Rust.", true);
        assert!(engine.last_detected_question().is_none());
        engine.push_transcript("So why did you choose Rust.".to_string(), "Them".to_string(), 62_000, true);
        decide(&mut engine, "So why did you choose Rust.", 62_000);
        assert!(engine.last_detected_question().is_none(), "no detected question in a plain sentence");
        // The old paragraph re-sent by the next final stays dropped.
        them_final(&mut engine, "acc_2", "So why did you choose Rust.", 62_000);
        assert!(engine.last_detected_question().is_none());
        // So does a late decision about the paragraph before it.
        decide(&mut engine, "Why do you want this job?", 1_000);
        assert!(engine.last_detected_question().is_none());

        let mut engine = IntelligenceEngine::new();
        them_final(&mut engine, "acc_1", "Why do you want this job?", 1_000);
        engine.note_them_line("acc_2", "Take your time with that.", true);
        assert!(engine.last_detected_question().is_some());
    }

    #[test]
    fn a_final_that_starts_a_line_with_a_question_becomes_the_new_question() {
        let mut engine = IntelligenceEngine::new();
        them_final(&mut engine, "acc_1", "Why do you want this job?", 1_000);
        them_final(&mut engine, "acc_2", "What is your salary expectation?", 62_000);
        assert_eq!(
            engine.last_detected_question().map(|q| q.text.as_str()),
            Some("What is your salary expectation?")
        );
    }

    #[test]
    fn a_question_from_you_is_kept_when_them_starts_a_question() {
        let mut engine = IntelligenceEngine::new();
        engine.set_detected_question(Some(DetectedQuestion {
            text: "Can I ask about the team?".to_string(),
            confidence: 0.95,
            timestamp_ms: 1_000,
            source: "You".to_string(),
        }));
        engine.note_them_line("acc_1", "Why?", false);
        assert!(engine.last_detected_question().is_some());
    }

    #[test]
    fn clearing_the_session_forgets_the_dropped_question() {
        let mut engine = IntelligenceEngine::new();
        them_final(&mut engine, "acc_1", "Why do you want this job?", 1_000);
        engine.note_them_line("acc_2", "Why?", false);
        engine.clear_session();
        them_final(&mut engine, "acc_1", "Why do you want this job?", 1_000);
        assert!(engine.last_detected_question().is_some());
    }

    #[test]
    fn a_decision_that_arrives_after_a_newer_question_started_is_dropped() {
        let mut engine = IntelligenceEngine::new();
        // The final is stored; the detection service has not decided yet.
        engine.note_them_line("acc_1", "Why do you want this job?", true);
        engine.push_transcript("Why do you want this job?".to_string(), "Them".to_string(), 1_000, true);
        assert!(engine.last_detected_question().is_none());
        engine.note_them_line("acc_2", "So how did you handle that", false);
        // Its decision arrives while the newer question is still being asked.
        decide(&mut engine, "Why do you want this job?", 1_000);
        assert!(engine.last_detected_question().is_none());
        them_final(&mut engine, "acc_2", "So how did you handle that?", 62_000);
        assert_eq!(
            engine.last_detected_question().map(|q| q.text.as_str()),
            Some("So how did you handle that?")
        );
    }

    #[test]
    fn a_decision_about_the_line_still_being_spoken_is_kept() {
        let mut engine = IntelligenceEngine::new();
        // No newer question started: a late decision is taken as it is.
        engine.note_them_line("acc_1", "Why do you want this job?", true);
        engine.push_transcript("Why do you want this job?".to_string(), "Them".to_string(), 1_000, true);
        engine.note_them_line("acc_1", "Why do you want this job? I mean", false);
        engine.note_them_line("acc_2", "Take your time.", false);
        decide(&mut engine, "Why do you want this job?", 1_000);
        assert!(engine.last_detected_question().is_some());
        // A decision without a question clears it, as before.
        engine.set_detected_question(None);
        assert!(engine.last_detected_question().is_none());
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
