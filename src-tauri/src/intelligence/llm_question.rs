//! Application adapter for the streaming detector. The worker owns at most one
//! provider future. Only session, settings and route changes cancel that future.

use std::future::Future;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Listener, Manager};
use tokio::sync::Notify;
use tokio::time::Instant;

pub use super::question_core::DetectionMode;
use super::question_core::{
    self as core, DetectedQuestionV2, Failure, Origin, QuestionCore, QuestionEvent, Update,
};
use super::question_detector::DetectedQuestion;
use super::question_prediction::QuestionPredictionService;
use crate::llm::api::{self, CompleteOptions, LlmCallError};
use crate::llm::connections::LlmConfigFile;
use crate::llm::provider::{CancelToken, LLMMessage};
use crate::llm::registry::{self, ClaudeContext, LlmRegistry};
use crate::state::AppState;

const TASK: &str = "question_detect";
pub const SETTINGS_EVENT: &str = "question_detection_settings_changed";

/// Web Speech and the standalone STT router broadcast these segment IDs.
/// The native meeting emitters feed the core directly with their own IDs.
pub fn listen_to_transcripts(app: &AppHandle) {
    #[derive(Deserialize)]
    struct Segment {
        id: String,
        text: String,
        speaker: String,
        timestamp_ms: u64,
    }
    #[derive(Deserialize)]
    struct Envelope {
        segment: Segment,
    }
    for (name, is_final) in [("transcript_update", false), ("transcript_final", true)] {
        let handle = app.clone();
        app.listen_any(name, move |event| {
            let Ok(Envelope { segment }) = serde_json::from_str(event.payload()) else {
                return;
            };
            if !segment.id.starts_with("web_") && !segment.id.starts_with("seg_") {
                return;
            }
            handle.state::<QuestionDetectionService>().observe(
                &handle,
                Update {
                    line_id: &segment.id,
                    source: &segment.speaker,
                    text: &segment.text,
                    timestamp_ms: segment.timestamp_ms,
                    is_final,
                },
            );
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct QuestionDetectionSettings {
    pub mode: DetectionMode,
    pub confidence_threshold: f64,
    pub log_requests: bool,
    pub prediction_enabled: bool,
    pub prediction_prepare_answers: bool,
}

impl Default for QuestionDetectionSettings {
    fn default() -> Self {
        Self {
            mode: DetectionMode::Hybrid,
            confidence_threshold: 0.7,
            log_requests: false,
            prediction_enabled: false,
            prediction_prepare_answers: true,
        }
    }
}

impl QuestionDetectionSettings {
    pub fn validate(&self) -> Result<(), String> {
        if !self.confidence_threshold.is_finite()
            || !(0.0..=1.0).contains(&self.confidence_threshold)
        {
            return Err("Question confidence must be between 0 and 1".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct QuestionDetectionSettingsView {
    pub revision: u64,
    pub settings: QuestionDetectionSettings,
    pub effective_mode: DetectionMode,
    pub fallback_reason: Option<String>,
}

#[derive(Clone, Serialize)]
pub(super) struct DetectionLog {
    pub task: &'static str,
    pub id: String,
    pub timestamp_ms: u64,
    pub latency_ms: u64,
    pub model: String,
    pub provider: String,
    pub system_prompt: String,
    pub user_prompt: String,
    pub response: String,
    pub error: Option<String>,
}

/// Includes route/provider resolution, semaphore acquisition and streaming in
/// the same budget, and stops the provider when a session/settings reset wins.
pub(super) async fn run_bounded<F>(
    cancel: Arc<CancelToken>,
    timeout: Duration,
    future: F,
) -> Result<String, LlmCallError>
where
    F: Future<Output = Result<String, LlmCallError>>,
{
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(LlmCallError::Cancelled),
        result = tokio::time::timeout(timeout, future) => match result {
            Ok(result) => result,
            Err(_) => { cancel.cancel(); Err(LlmCallError::Timeout) },
        }
    }
}

fn explicit_route(
    config: &LlmConfigFile,
    claude: &ClaudeContext,
) -> Result<registry::Resolved, &'static str> {
    let target = config
        .routing
        .tasks
        .get(TASK)
        .and_then(|route| route.target.as_ref())
        .ok_or("route_missing")?;
    let connection = config
        .connection(&target.connection_id)
        .ok_or("connection_unavailable")?;
    if !connection.enabled || connection.kind == api::LlmKind::ClaudeCli {
        return Err("connection_unavailable");
    }
    let route =
        registry::resolve_task(config, TASK, claude).map_err(|_| "connection_unavailable")?;
    if route.via_fallback
        || route.no_fallback
        || route.source != TASK
        || route.connection.id != connection.id
    {
        return Err("connection_unavailable");
    }
    Ok(route)
}

type Route = (u64, Result<registry::Resolved, &'static str>);

fn route_for_app(app: &AppHandle) -> Route {
    let Some(registry) = app.try_state::<LlmRegistry>() else {
        return (0, Err("route_missing"));
    };
    let config = registry.config();
    (
        config.revision,
        explicit_route(&config, &registry::claude_context(app)),
    )
}

struct Inner {
    core: QuestionCore,
    settings: QuestionDetectionSettings,
    route: Option<Route>,
    runtime_failure: Option<&'static str>,
    epoch: u64,
    view_revision: u64,
    question_detection: bool,
    worker_running: bool,
    cancel: Option<Arc<CancelToken>>,
}

impl Inner {
    fn new(settings: QuestionDetectionSettings) -> Self {
        Self {
            core: QuestionCore::default(),
            settings,
            route: None,
            runtime_failure: None,
            epoch: 0,
            view_revision: 0,
            question_detection: true,
            worker_running: false,
            cancel: None,
        }
    }

    fn mode(&self) -> Option<DetectionMode> {
        (self.question_detection || self.settings.prediction_enabled).then(|| {
            if self.route.as_ref().is_some_and(|(_, r)| r.is_ok()) {
                self.settings.mode
            } else {
                DetectionMode::Rules
            }
        })
    }

    fn reset(&mut self, new_meeting: bool) -> Vec<QuestionEvent> {
        self.epoch += 1;
        self.view_revision += 1;
        if let Some(token) = self.cancel.take() {
            token.cancel();
        }
        self.runtime_failure = None;
        self.core.reset(new_meeting)
    }

    fn current(&self, epoch: u64, revision: u64) -> bool {
        self.epoch == epoch && self.route.as_ref().is_some_and(|r| r.0 == revision)
    }

    fn view(&self) -> QuestionDetectionSettingsView {
        let failure = (self.settings.mode != DetectionMode::Rules)
            .then(|| {
                self.route
                    .as_ref()
                    .and_then(|r| r.1.as_ref().err().copied())
                    .or(self.runtime_failure)
            })
            .flatten();
        QuestionDetectionSettingsView {
            settings: self.settings.clone(),
            revision: self.view_revision,
            effective_mode: if failure.is_some() {
                DetectionMode::Rules
            } else {
                self.settings.mode
            },
            fallback_reason: failure.map(String::from),
        }
    }
}

#[derive(Clone)]
pub struct QuestionDetectionService {
    path: PathBuf,
    inner: Arc<Mutex<Inner>>,
    wake: Arc<Notify>,
    clock: Instant,
}

impl QuestionDetectionService {
    pub fn new(path: PathBuf) -> Self {
        let settings = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<QuestionDetectionSettings>(&bytes).ok())
            .filter(|s| s.validate().is_ok())
            .unwrap_or_default();
        Self {
            path,
            inner: Arc::new(Mutex::new(Inner::new(settings))),
            wake: Arc::new(Notify::new()),
            clock: Instant::now(),
        }
    }

    fn now(&self) -> u64 {
        self.clock.elapsed().as_millis() as u64
    }

    pub fn settings(&self) -> QuestionDetectionSettings {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .settings
            .clone()
    }

    pub fn view(&self, app: &AppHandle) -> QuestionDetectionSettingsView {
        let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        state.route.get_or_insert_with(|| route_for_app(app));
        state.view()
    }

    pub fn set_settings(
        &self,
        app: &AppHandle,
        settings: QuestionDetectionSettings,
    ) -> Result<QuestionDetectionSettingsView, String> {
        settings.validate()?;
        let view = {
            let mut state = self
                .inner
                .lock()
                .map_err(|_| "Question settings lock poisoned")?;
            if let Some(parent) = self.path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let temp = self.path.with_extension("json.tmp");
            std::fs::write(
                &temp,
                serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            std::fs::rename(&temp, &self.path).map_err(|e| e.to_string())?;
            state.route.get_or_insert_with(|| route_for_app(app));
            if state.settings == settings {
                return Ok(state.view());
            }
            state.settings = settings;
            reset(app, &mut state, false);
            state.view()
        };
        self.wake.notify_one();
        super::question_prediction::invalidate(app);
        let _ = app.emit(SETTINGS_EVENT, &view);
        Ok(view)
    }

    pub fn set_question_detection(&self, app: &AppHandle, on: bool) {
        let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if state.question_detection == on {
            return;
        }
        state.question_detection = on;
        if !on {
            reset(app, &mut state, false);
        }
        self.wake.notify_one();
    }

    pub fn route_changed(&self, app: &AppHandle) {
        let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let route = route_for_app(app);
        if state.route.as_ref().is_some_and(|r| r.0 == route.0) {
            return;
        }
        state.route = Some(route);
        reset(app, &mut state, false);
        let _ = app.emit(SETTINGS_EVENT, state.view());
        self.wake.notify_one();
    }

    pub fn reset_session(&self, app: &AppHandle) {
        let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        state.route.get_or_insert_with(|| route_for_app(app));
        reset(app, &mut state, true);
        let _ = app.emit(SETTINGS_EVENT, state.view());
        self.wake.notify_one();
    }

    // Capture the ID before answering: the model can revise its text mid-stream.
    pub(crate) fn answer_key(&self, text: &str) -> Option<(u64, String)> {
        let state = self.inner.lock().ok()?;
        Some((state.epoch, state.core.question_id(text)?.to_owned()))
    }

    pub(crate) fn answered(&self, key: &(u64, String)) {
        if let Ok(mut state) = self.inner.lock() {
            if state.epoch == key.0 {
                state.core.mark_answered(&key.1);
            }
        }
    }

    pub fn observe(&self, app: &AppHandle, update: Update<'_>) {
        {
            let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            // The audio emitter can have been draining as end_meeting reset the detector.
            if !app
                .state::<AppState>()
                .meeting_active
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                return;
            }
            state.route.get_or_insert_with(|| route_for_app(app));
            let mode = state.mode();
            if mode == Some(DetectionMode::Rules) && super::from_them(update.source) {
                with_engine(app, |engine| {
                    engine.note_them_line(update.line_id, update.text, update.is_final)
                });
            }
            let observed = state.core.observe(update, self.now(), mode);
            if let Some(check) = observed.rule_check {
                log_decision(
                    "line_final",
                    check.new_chars,
                    0,
                    if check.matched { "question" } else { "none" },
                    "rules",
                );
                if mode == Some(DetectionMode::Rules) && !check.matched {
                    app.state::<QuestionPredictionService>()
                        .on_detection(app, &[]);
                }
            }
            publish(
                app,
                &state.core,
                observed.events,
                mode == Some(DetectionMode::Rules),
            );
            if state.core.next_start_ms().is_none() || state.worker_running {
                return;
            }
            state.worker_running = true;
        }
        let service = self.clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            service.run(&app).await;
        });
    }

    async fn run(&self, app: &AppHandle) {
        loop {
            let deadline = {
                let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
                let Some(ms) = state.core.next_start_ms() else {
                    state.worker_running = false;
                    return;
                };
                self.clock + Duration::from_millis(ms)
            };
            if deadline > Instant::now() {
                tokio::select! { _ = tokio::time::sleep_until(deadline) => {}, _ = self.wake.notified() => continue }
            }
            let (req, epoch, revision, route, cancel) = {
                let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
                let Some(req) = state.core.start_request(self.now()) else {
                    continue;
                };
                let (revision, route) = state
                    .route
                    .as_ref()
                    .expect("a scheduled request has a route");
                let route = route
                    .clone()
                    .expect("only explicit model routes schedule requests");
                let revision = *revision;
                let cancel = Arc::new(CancelToken::new());
                state.cancel = Some(cancel.clone());
                (req, state.epoch, revision, route, cancel)
            };
            let started = Instant::now();
            let result = execute(app, &req.input, &route, revision, cancel).await;
            let latency = started.elapsed().as_millis() as u64;
            let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            state.cancel = None;
            if !state.current(epoch, revision) {
                continue;
            }
            if app.state::<LlmRegistry>().config().revision != revision {
                state.route = Some(route_for_app(app));
                reset(app, &mut state, false);
                let _ = app.emit(SETTINGS_EVENT, state.view());
                continue;
            }
            let decision = state.core.finish(&req, result);
            let chars = req.input.new_text.chars().count();
            log_decision(req.trigger, chars, latency, decision.result, "model");
            for rule in &decision.fallback_rules {
                log_decision(
                    decision.result,
                    rule.new_chars,
                    0,
                    if rule.matched { "question" } else { "none" },
                    "rules",
                );
            }
            if decision.result == "none" {
                app.state::<QuestionPredictionService>()
                    .on_detection(app, &[]);
            }
            let failure =
                matches!(decision.result, "timeout" | "invalid").then_some(decision.result);
            if state.runtime_failure != failure {
                state.runtime_failure = failure;
                state.view_revision += 1;
                let _ = app.emit(SETTINGS_EVENT, state.view());
            }
            if state.settings.log_requests {
                let _ = app.emit(
                    "question_detection_log",
                    DetectionLog {
                        task: TASK,
                        id: uuid::Uuid::new_v4().to_string(),
                        timestamp_ms: registry::now_ms().max(0) as u64,
                        latency_ms: latency,
                        model: route.model.unwrap_or_default(),
                        provider: route.connection.display_name(),
                        system_prompt: String::new(),
                        user_prompt: format!("{} new_chars={chars}", req.trigger),
                        response: decision.result.into(),
                        error: failure.map(str::to_owned),
                    },
                );
            }
            publish(app, &state.core, decision.events, failure.is_some());
        }
    }
}

fn log_decision(trigger: &str, chars: usize, latency: u64, result: &str, origin: &str) {
    log::info!("[question-detection] trigger={trigger} new_chars={chars} latency_ms={latency} result={result} origin={origin}");
}

fn with_engine(app: &AppHandle, apply: impl FnOnce(&mut super::IntelligenceEngine)) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Some(engine) = &state.intelligence {
            if let Ok(mut engine) = engine.lock() {
                apply(&mut engine);
            }
        }
    }
}

fn reset(app: &AppHandle, state: &mut Inner, new_meeting: bool) {
    for event in state.reset(new_meeting) {
        let _ = app.emit("question_event", event);
    }
    with_engine(app, |engine| engine.reset_detected_question());
}

fn engine_question(q: &DetectedQuestionV2) -> DetectedQuestion {
    DetectedQuestion {
        text: q.text.clone(),
        timestamp_ms: q.timestamp_ms,
        source: q.source.clone(),
        confidence: 1.0,
    }
}

fn publish(
    app: &AppHandle,
    core: &QuestionCore,
    mut events: Vec<QuestionEvent>,
    confirmed_rules: bool,
) {
    if events.is_empty() {
        return;
    }
    prepare_events(&mut events, confirmed_rules, |texts| {
        app.state::<QuestionPredictionService>()
            .on_detection(app, texts)
    });
    with_engine(app, |engine| {
        engine.set_detected_question(core.latest_complete().map(engine_question))
    });
    for event in events {
        let _ = app.emit("question_event", event);
    }
}

fn prepare_events(
    events: &mut [QuestionEvent],
    confirmed_rules: bool,
    on_detection: impl FnOnce(&[&str]) -> Vec<bool>,
) {
    let questions: Vec<_> = events
        .iter_mut()
        .filter_map(|e| match e {
            QuestionEvent::Upsert { question }
                if question.complete && (question.origin == Origin::Model || confirmed_rules) =>
            {
                Some(question)
            }
            _ => None,
        })
        .collect();
    if !questions.is_empty() {
        let texts: Vec<_> = questions.iter().map(|q| q.text.as_str()).collect();
        let prepared = on_detection(&texts);
        for (question, ready) in questions.into_iter().zip(prepared) {
            question.prepared = ready;
        }
    }
}

fn options(cancel: Arc<CancelToken>) -> CompleteOptions {
    CompleteOptions {
        temperature: Some(0.0),
        max_tokens: Some(core::MAX_TOKENS),
        timeout: Some(Duration::from_millis(core::TIMEOUT_MS)),
        cancel: Some(cancel),
        json_mode: true,
        thinking_auto_off: true,
        ..Default::default()
    }
}

async fn execute(
    app: &AppHandle,
    input: &core::ModelInput,
    route: &registry::Resolved,
    revision: u64,
    cancel: Arc<CancelToken>,
) -> Result<Vec<core::ModelQuestion>, Failure> {
    let messages = vec![
        LLMMessage {
            role: "system".into(),
            content: core::SYSTEM_PROMPT.into(),
        },
        LLMMessage {
            role: "user".into(),
            content: serde_json::to_string(input).expect("serializable request"),
        },
    ];
    let opts = options(cancel.clone());
    let raw = run_bounded(cancel, Duration::from_millis(core::TIMEOUT_MS), async {
        let registry = app.state::<LlmRegistry>();
        if registry.config().revision != revision {
            return Err(LlmCallError::Cancelled);
        }
        let client = api::resolved_client(&registry, route, &registry::claude_context(app)).await?;
        api::complete_resolved_text(app, client, messages, opts).await
    })
    .await
    .map_err(|e| {
        if e == LlmCallError::Timeout {
            Failure::Timeout
        } else {
            Failure::Invalid
        }
    })?;
    core::parse_response(&raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::api::LlmKind;
    use crate::llm::connections::{LlmConnection, RouteTarget, TaskRoute};
    use crate::llm::provider::GenerationParams;
    use crate::llm::thinking::{self, ThinkingSetting};

    fn state() -> Inner {
        let mut state = Inner::new(QuestionDetectionSettings::default());
        state.route = Some((
            1,
            Ok(registry::Resolved {
                source: TASK.into(),
                connection: LlmConnection::default(),
                model: Some("test".into()),
                overrides: vec![],
                via_fallback: false,
                no_fallback: false,
            }),
        ));
        state
    }

    fn update(id: &str) -> Update<'_> {
        Update {
            line_id: id,
            source: "Them",
            text: "Why use the network?",
            timestamp_ms: 0,
            is_final: true,
        }
    }

    #[test]
    fn switches_gate_calls_and_keep_predictions_operational() {
        for (on, predictions) in [(false, false), (false, true), (true, false), (true, true)] {
            let mut s = state();
            s.question_detection = on;
            s.settings.prediction_enabled = predictions;
            let mode = s.mode();
            let events = s.core.observe(update("a"), 0, mode).events;
            assert_eq!(!events.is_empty(), on || predictions);
            assert_eq!(s.core.start_request(0).is_some(), on || predictions);
        }
        let mut s = state();
        s.route = Some((2, Err("connection_unavailable")));
        s.core.observe(update("a"), 0, s.mode());
        assert_eq!(s.view().effective_mode, DetectionMode::Rules);
        assert!(s.core.start_request(0).is_none());
    }

    #[test]
    fn settings_and_route_resets_cancel_jobs_and_remove_every_old_id() {
        for new_meeting in [false, true] {
            let mut s = state();
            s.core.observe(update("a"), 0, s.mode());
            let job = s.core.start_request(0).unwrap();
            let cancel = Arc::new(CancelToken::new());
            s.cancel = Some(cancel.clone());
            assert!(!s.current(s.epoch, 2), "the registry has a newer revision");
            let epoch = s.epoch;
            let removed = s.reset(new_meeting);
            assert_eq!(
                removed,
                [QuestionEvent::Remove {
                    id: "q1".into(),
                    reason: core::RemoveReason::Reset
                }]
            );
            assert!(cancel.is_cancelled() && !s.current(epoch, 1));
            assert!(s.core.finish(&job, Ok(vec![])).events.is_empty());
            assert!(s.core.latest_complete().is_none());
            let next = s.core.observe(update("b"), 1000, s.mode()).events;
            let QuestionEvent::Upsert { question } = &next[0] else {
                panic!()
            };
            assert_eq!(question.id, if new_meeting { "q1" } else { "q2" });
        }
    }

    #[test]
    fn confirmed_answerable_questions_notify_predictions_and_update_the_engine() {
        let mut s = state();
        let mut events = s.core.observe(update("a"), 0, s.mode()).events;
        prepare_events(&mut events, false, |_| {
            panic!("only confirmed questions go to prediction")
        });
        let req = s.core.start_request(0).unwrap();
        let raw = r#"{"questions":[{"text":"Why use the network?","quote":"use the network?","kind":"direct","complete":true,"same_as":"q1"}]}"#;
        let mut decision = s.core.finish(&req, core::parse_response(raw));
        let mut calls = Vec::new();
        prepare_events(&mut decision.events, false, |texts| {
            calls.extend(texts.iter().map(|s| s.to_string()));
            vec![true; texts.len()]
        });
        assert_eq!(calls, ["Why use the network?"]);
        let QuestionEvent::Upsert { question } = &decision.events[0] else {
            panic!()
        };
        assert!(question.prepared);
        let mut engine = super::super::IntelligenceEngine::new();
        engine.set_detected_question(s.core.latest_complete().map(engine_question));
        assert_eq!(
            &engine.last_detected_question().unwrap().text,
            &question.text
        );
        let other = Update {
            line_id: "b",
            text: "And what else?",
            timestamp_ms: 1000,
            ..update("b")
        };
        s.core.observe(other, 1000, s.mode());
        let req = s.core.start_request(1000).unwrap();
        s.core.finish(&req, Ok(vec![]));
        engine.set_detected_question(s.core.latest_complete().map(engine_question));
        assert_eq!(
            engine.last_detected_question().unwrap().text,
            "Why use the network?"
        );
    }

    #[tokio::test]
    async fn deadline_cancels_the_provider_and_the_task_defaults_to_thinking_off() {
        let cancel = Arc::new(CancelToken::new());
        let o = options(cancel.clone());
        assert!(o.json_mode);
        assert_eq!(
            (o.temperature, o.max_tokens, o.timeout),
            (Some(0.0), Some(400), Some(Duration::from_secs(4)))
        );
        let p = GenerationParams {
            thinking: o.thinking,
            thinking_auto_off: o.thinking_auto_off,
            ..Default::default()
        };
        assert_eq!(
            thinking::resolve(&p, ThinkingSetting::Auto),
            ThinkingSetting::Off
        );
        assert_eq!(
            thinking::resolve(&p, ThinkingSetting::Low),
            ThinkingSetting::Low
        );
        assert_eq!(
            run_bounded(
                cancel.clone(),
                Duration::from_millis(2),
                std::future::pending()
            )
            .await,
            Err(LlmCallError::Timeout)
        );
        assert!(cancel.is_cancelled());
    }

    #[test]
    fn settings_still_read_old_defaults_and_reject_invalid_thresholds() {
        let settings: QuestionDetectionSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(settings.mode, DetectionMode::Hybrid);
        assert!(!settings.log_requests);
        for confidence_threshold in [-0.1, 1.1, f64::NAN] {
            assert!(QuestionDetectionSettings {
                confidence_threshold,
                ..settings.clone()
            }
            .validate()
            .is_err());
        }
    }
    #[test]
    fn explicit_route_never_inherits_or_uses_a_claude_fallback() {
        let mut config = LlmConfigFile::default();
        let connection = LlmConnection {
            id: "local".into(),
            name: "Local".into(),
            enabled: true,
            kind: LlmKind::Ollama,
            base_url: "http://127.0.0.1:11434".into(),
            default_model: Some("qwen3:1.7b".into()),
            ..Default::default()
        };
        config.connections.push(connection);
        let route = TaskRoute {
            target: Some(RouteTarget {
                connection_id: "local".into(),
                model: None,
            }),
            ..Default::default()
        };
        config.routing.default = route.clone();
        assert_eq!(
            explicit_route(&config, &ClaudeContext::default()),
            Err("route_missing")
        );
        config.routing.tasks.insert(TASK.into(), route);
        assert!(explicit_route(&config, &ClaudeContext::default()).is_ok());
        config.connections[0].enabled = false;
        assert_eq!(
            explicit_route(&config, &ClaudeContext::default()),
            Err("connection_unavailable")
        );
        config.connections[0].enabled = true;
        config.connections[0].kind = LlmKind::ClaudeCli;
        assert_eq!(
            explicit_route(
                &config,
                &ClaudeContext {
                    available: false,
                    ..Default::default()
                }
            ),
            Err("connection_unavailable")
        );
        config.connections.clear();
        assert_eq!(
            explicit_route(&config, &ClaudeContext::default()),
            Err("connection_unavailable")
        );
    }
}
