// Windows Speech reads a microphone directly through WinRT. All recognizer
// operations run on one dedicated COM apartment thread.

use async_trait::async_trait;
use tauri::AppHandle;
use tokio::sync::mpsc;

use crate::audio::AudioChunk;
use crate::stt::provider::{STTProvider, STTProviderType, TranscriptResult};

pub struct WindowsNativeSTT {
    language: String,
    app: Option<AppHandle>,
    party: String,
    microphone: bool,
    #[cfg(windows)]
    mute: native::MuteState,
    #[cfg(windows)]
    worker: Option<native::Worker>,
}

impl WindowsNativeSTT {
    pub fn new() -> Self {
        Self::for_mic()
    }

    pub fn for_mic() -> Self {
        Self {
            language: "en-US".into(),
            app: None,
            party: "You".into(),
            microphone: true,
            #[cfg(windows)]
            mute: native::MuteState::default(),
            #[cfg(windows)]
            worker: None,
        }
    }

    pub fn for_custom_stream() -> Self {
        Self {
            microphone: false,
            party: "Them".into(),
            ..Self::for_mic()
        }
    }

    pub fn set_app_handle(&mut self, app: AppHandle) {
        self.app = Some(app);
    }

    pub fn set_party(&mut self, party: &str) {
        self.party = party.into();
    }

    #[cfg(windows)]
    pub fn set_mute_flags(
        &mut self,
        muted: std::sync::Arc<std::sync::atomic::AtomicBool>,
        revision: std::sync::Arc<std::sync::atomic::AtomicU64>,
    ) {
        self.mute = native::MuteState::shared(muted, revision);
    }
}

#[async_trait]
impl STTProvider for WindowsNativeSTT {
    fn provider_name(&self) -> &str {
        "Windows Speech (Built-in)"
    }

    fn provider_type(&self) -> STTProviderType {
        STTProviderType::WindowsNative
    }

    async fn start_stream(
        &mut self,
        result_tx: mpsc::Sender<TranscriptResult>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if !self.microphone {
            return Err("Windows Speech requires a microphone input. Choose another engine for system audio.".into());
        }
        #[cfg(windows)]
        {
            if self.worker.is_some() {
                return Err("Stream already active".into());
            }
            self.worker = Some(
                native::Worker::start(
                    self.language.clone(),
                    self.mute.clone(),
                    self.app.clone(),
                    self.party.clone(),
                    result_tx,
                )
                .await?,
            );
            Ok(())
        }
        #[cfg(not(windows))]
        {
            drop(result_tx);
            Err("Windows Speech is available only on Windows".into())
        }
    }

    async fn feed_audio(
        &mut self,
        _chunk: AudioChunk,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        Ok(())
    }

    async fn stop_stream(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        #[cfg(windows)]
        if let Some(worker) = &mut self.worker {
            let result = worker.stop().await;
            self.worker = None;
            result?;
        }
        Ok(())
    }

    async fn test_connection(&self) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        #[cfg(windows)]
        {
            let language = self.language.clone();
            let probe = tokio::task::spawn_blocking(move || native::check_language(&language));
            Ok(tokio::time::timeout(std::time::Duration::from_secs(10), probe).await???)
        }
        #[cfg(not(windows))]
        {
            Ok(false)
        }
    }

    fn set_language(&mut self, language: &str) {
        self.language = language.into();
    }

    fn set_muted(&mut self, _muted: bool) {
        #[cfg(windows)]
        self.mute.set_if_local(_muted);
    }
}

#[cfg(any(windows, test))]
mod mute {
    use std::sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    };

    #[derive(Clone, Default)]
    pub(super) struct MuteState {
        muted: Arc<AtomicBool>,
        revision: Arc<AtomicU64>,
        shared: bool,
    }

    impl MuteState {
        pub(super) fn shared(muted: Arc<AtomicBool>, revision: Arc<AtomicU64>) -> Self {
            Self {
                muted,
                revision,
                shared: true,
            }
        }

        pub(super) fn set_if_local(&self, muted: bool) {
            if self.shared || self.muted.load(Ordering::Acquire) == muted {
                return;
            }
            if muted {
                self.muted.store(true, Ordering::Release);
            }
            self.revision.fetch_add(1, Ordering::AcqRel);
            if !muted {
                self.muted.store(false, Ordering::Release);
            }
        }

        pub(super) fn revision(&self) -> u64 {
            self.revision.load(Ordering::Acquire)
        }

        pub(super) fn muted(&self) -> bool {
            self.muted.load(Ordering::Acquire)
        }

        pub(super) fn allows(&self, revision: u64) -> bool {
            !self.muted() && self.revision() == revision
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn muting_and_unmuting_fences_callbacks_from_the_old_session() {
            let mute = MuteState::default();
            let first = mute.revision();
            assert!(mute.allows(first));

            mute.set_if_local(true);
            assert!(!mute.allows(first));

            mute.set_if_local(false);
            assert!(!mute.allows(first));
            assert!(mute.allows(mute.revision()));
        }

        #[test]
        fn shared_mute_takes_effect_before_the_audio_loop_checks_it() {
            let muted = Arc::new(AtomicBool::new(false));
            let revision = Arc::new(AtomicU64::new(0));
            let mute = MuteState::shared(muted.clone(), revision.clone());
            muted.store(true, Ordering::Release);
            revision.fetch_add(1, Ordering::AcqRel);
            mute.set_if_local(false);
            assert!(!mute.allows(0));

            revision.fetch_add(1, Ordering::AcqRel);
            muted.store(false, Ordering::Release);
            assert!(!mute.allows(0));
            assert!(mute.allows(revision.load(Ordering::Acquire)));
        }
    }
}

#[cfg(windows)]
mod native {
    pub(super) use super::mute::MuteState;
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    };
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
    use tauri::Emitter;
    use tokio::sync::oneshot;
    use windows::core::{Result as WinResult, HSTRING};
    use windows::Foundation::TypedEventHandler;
    use windows::Globalization::Language;
    use windows::Media::SpeechRecognition::*;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};

    const POLL: Duration = Duration::from_millis(20);
    const OPEN_TIMEOUT: Duration = Duration::from_secs(8);
    const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);

    struct ComApartment;

    impl ComApartment {
        fn initialize() -> WinResult<Self> {
            unsafe {
                CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
            }
            Ok(Self)
        }
    }

    impl Drop for ComApartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    struct Recognizer(SpeechRecognizer);

    impl Drop for Recognizer {
        fn drop(&mut self) {
            let _ = self.0.Close();
        }
    }

    #[derive(Default)]
    struct Control {
        stop: AtomicBool,
        abort: AtomicBool,
    }

    pub(super) struct Worker {
        control: Arc<Control>,
        done: oneshot::Receiver<()>,
    }

    impl Worker {
        pub(super) async fn start(
            language: String,
            mute: MuteState,
            app: Option<AppHandle>,
            party: String,
            results: mpsc::Sender<TranscriptResult>,
        ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
            let (ready_tx, ready) = oneshot::channel();
            let (done_tx, done) = oneshot::channel();
            let control = Arc::new(Control::default());
            let worker = Self {
                control: Arc::clone(&control),
                done,
            };
            std::thread::Builder::new()
                .name("win-stt".into())
                .spawn(move || {
                    let mut ready = Some(ready_tx);
                    if let Err(e) = run(
                        &control, &mute, &language, &results, &app, &party, &mut ready,
                    ) {
                        if let Some(ready) = ready {
                            let _ = ready.send(Err(e));
                        } else if !control.abort.load(Ordering::Acquire) {
                            status(&app, &party, "error", Some(e));
                        }
                    }
                    let _ = done_tx.send(());
                })?;

            tokio::time::timeout(OPEN_TIMEOUT * 2 + Duration::from_secs(1), ready)
                .await
                .map_err(|_| "Timed out starting Windows Speech")?
                .map_err(|_| "Windows Speech stopped before initialization completed")??;
            Ok(worker)
        }

        pub(super) async fn stop(
            &mut self,
        ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
            self.control.stop.store(true, Ordering::Release);
            tokio::time::timeout(CLOSE_TIMEOUT + Duration::from_secs(1), &mut self.done)
                .await
                .map_err(|_| "Timed out stopping Windows Speech")?
                .map_err(|_| "Windows Speech worker stopped unexpectedly")?;
            Ok(())
        }
    }

    impl Drop for Worker {
        fn drop(&mut self) {
            self.control.abort.store(true, Ordering::Release);
        }
    }

    fn status(app: &Option<AppHandle>, party: &str, state: &str, message: Option<String>) {
        if let Some(app) = app {
            let _ = app.emit("stt_connection_status", serde_json::json!({
                "provider": "windows_native", "party": party, "status": state, "message": message,
            }));
            let level = if state == "error" { "error" } else { "info" };
            let message = message.unwrap_or_else(|| format!("Windows Speech ({party}): {state}"));
            crate::stt::emit_stt_debug(app, level, "win-stt", &message);
        }
    }

    fn pump_messages() {
        use windows::Win32::UI::WindowsAndMessaging::{
            DispatchMessageW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE,
        };
        unsafe {
            let mut msg = MSG::default();
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        std::thread::sleep(POLL);
    }

    fn wait_operation<T>(
        pending: impl Fn() -> WinResult<bool>,
        result: impl Fn() -> WinResult<T>,
        cancel: impl Fn() -> WinResult<()>,
        timeout: Duration,
        should_continue: impl Fn() -> bool,
    ) -> Result<Option<T>, String> {
        let deadline = Instant::now() + timeout;
        while pending().map_err(|e| e.to_string())? {
            if !should_continue() {
                let _ = cancel();
                return Ok(None);
            }
            if Instant::now() >= deadline {
                let _ = cancel();
                return Err("Windows Speech operation timed out".into());
            }
            pump_messages();
        }
        result().map(Some).map_err(|e| e.to_string())
    }

    fn compile(
        language: &str,
        should_continue: impl Fn() -> bool,
    ) -> Result<Option<Recognizer>, String> {
        let locale =
            Language::CreateLanguage(&HSTRING::from(language)).map_err(|e| e.to_string())?;
        let recognizer = Recognizer(SpeechRecognizer::Create(&locale).map_err(|e| {
            format!("Windows Speech is unavailable for '{language}': {e}. Check the speech language pack in Settings.")
        })?);
        let constraint = SpeechRecognitionTopicConstraint::Create(
            SpeechRecognitionScenario::Dictation,
            &HSTRING::from("freeform"),
        )
        .map_err(|e| e.to_string())?;
        recognizer
            .0
            .Constraints()
            .and_then(|items| items.Append(&constraint))
            .map_err(|e| e.to_string())?;
        let operation = recognizer
            .0
            .CompileConstraintsAsync()
            .map_err(|e| e.to_string())?;
        let compiled = wait_operation(
            || Ok(operation.Status()?.0 == 0), // Windows.Foundation.AsyncStatus.Started
            || operation.GetResults(),
            || operation.Cancel(),
            OPEN_TIMEOUT,
            should_continue,
        )?;
        let Some(compiled) = compiled else {
            return Ok(None);
        };
        let state = compiled.Status().map_err(|e| e.to_string())?;
        if state != SpeechRecognitionResultStatus::Success {
            return Err(format!(
                "Windows Speech could not compile dictation for '{language}': {state:?}"
            ));
        }

        Ok(Some(recognizer))
    }

    pub(super) fn check_language(language: &str) -> Result<bool, String> {
        let _apartment = ComApartment::initialize().map_err(|e| e.to_string())?;
        Ok(compile(language, || true)?.is_some())
    }

    fn run(
        control: &Arc<Control>,
        mute: &MuteState,
        language: &str,
        results: &mpsc::Sender<TranscriptResult>,
        app: &Option<AppHandle>,
        party: &str,
        ready: &mut Option<oneshot::Sender<Result<(), String>>>,
    ) -> Result<(), String> {
        let _apartment = ComApartment::initialize().map_err(|e| e.to_string())?;
        let ended = || {
            control.stop.load(Ordering::Acquire)
                || control.abort.load(Ordering::Acquire)
                || results.is_closed()
        };
        let mut session_number = 0u64;
        let mut retries = 0;
        let mut paused = false;

        while !ended() {
            if mute.muted() {
                if !paused {
                    status(app, party, "paused", None);
                    if let Some(ready) = ready.take() {
                        let _ = ready.send(Ok(()));
                    }
                    paused = true;
                }
                pump_messages();
                continue;
            }

            paused = false;
            let revision = mute.revision();
            let opening = || !ended() && mute.allows(revision);
            status(app, party, "connecting", None);
            let Some(recognizer) = compile(language, opening)? else {
                continue;
            };
            if !opening() {
                continue;
            }

            session_number += 1;
            let started_at = Instant::now();
            let completed = recognize(
                &recognizer.0,
                control,
                mute,
                revision,
                session_number,
                results,
                || {
                    status(app, party, "connected", None);
                    if let Some(ready) = ready.take() {
                        let _ = ready.send(Ok(()));
                    }
                },
            )?;
            drop(recognizer);

            if let Some(completed) = completed {
                if !matches!(
                    completed,
                    SpeechRecognitionResultStatus::Success
                        | SpeechRecognitionResultStatus::TimeoutExceeded
                        | SpeechRecognitionResultStatus::PauseLimitExceeded
                        | SpeechRecognitionResultStatus::UserCanceled
                ) {
                    return Err(format!("Windows Speech recognition ended: {completed:?}"));
                }

                if started_at.elapsed() >= Duration::from_secs(30) {
                    retries = 0;
                }
                retries += 1;
                if retries > 10 {
                    return Err("Windows Speech stopped repeatedly. Check the microphone and speech settings.".into());
                }
                let retry_at = Instant::now() + Duration::from_millis(250 * (1 << retries.min(4)));
                while opening() && Instant::now() < retry_at {
                    pump_messages();
                }
            } else {
                retries = 0;
            }
        }
        status(app, party, "disconnected", None);
        Ok(())
    }

    fn recognize(
        recognizer: &SpeechRecognizer,
        control: &Arc<Control>,
        mute: &MuteState,
        revision: u64,
        session_number: u64,
        results: &mpsc::Sender<TranscriptResult>,
        connected: impl FnOnce(),
    ) -> Result<Option<SpeechRecognitionResultStatus>, String> {
        let session = recognizer
            .ContinuousRecognitionSession()
            .map_err(|e| e.to_string())?;
        let sender = ResultSender {
            results: results.clone(),
            control: Arc::clone(control),
            mute: mute.clone(),
            revision,
            session_number,
            active: Arc::new(AtomicBool::new(true)),
            segment: Arc::new(AtomicU64::new(1)),
        };
        let interim = sender.clone();
        let hypothesis = recognizer
            .HypothesisGenerated(&TypedEventHandler::<
                SpeechRecognizer,
                SpeechRecognitionHypothesisGeneratedEventArgs,
            >::new(move |_, args| {
                if interim.allowed() {
                    if let Ok(text) = args
                        .ok()
                        .and_then(|args| args.Hypothesis())
                        .and_then(|hyp| hyp.Text())
                    {
                        interim.send(text.to_string(), false, 0.8);
                    }
                }
                Ok(())
            }))
            .ok();

        let finals = sender.clone();
        let final_token = session
            .ResultGenerated(&TypedEventHandler::<
                SpeechContinuousRecognitionSession,
                SpeechContinuousRecognitionResultGeneratedEventArgs,
            >::new(move |_, args| {
                if finals.allowed() {
                    if let Ok(result) = args.ok().and_then(|args| args.Result()) {
                        if let Ok(text) = result.Text() {
                            let confidence = match result.Confidence() {
                                Ok(SpeechRecognitionConfidence::High) => 0.95,
                                Ok(SpeechRecognitionConfidence::Medium) => 0.75,
                                Ok(SpeechRecognitionConfidence::Low) => 0.50,
                                _ => 0.60,
                            };
                            finals.send(text.to_string(), true, confidence);
                        }
                    }
                }
                Ok(())
            }))
            .map_err(|e| e.to_string())?;

        let (complete_tx, complete) = std::sync::mpsc::channel();
        let completion = session
            .Completed(&TypedEventHandler::<
                SpeechContinuousRecognitionSession,
                SpeechContinuousRecognitionCompletedEventArgs,
            >::new(move |_, args| {
                if let Ok(state) = args.ok().and_then(|args| args.Status()) {
                    let _ = complete_tx.send(state);
                }
                Ok(())
            }))
            .map_err(|e| e.to_string())?;

        let run_result = (|| {
            let aborting = || !sender.allowed() || results.is_closed();
            let stopping = || control.stop.load(Ordering::Acquire);
            if aborting() || stopping() {
                return Ok(None);
            }
            let start = session.StartAsync().map_err(start_error)?;
            if wait_operation(
                || Ok(start.Status()?.0 == 0),
                || start.GetResults(),
                || start.Cancel(),
                OPEN_TIMEOUT,
                || !aborting() && !stopping(),
            )?
            .is_none()
                || aborting()
            {
                return Ok(None);
            }

            connected();
            loop {
                if aborting() || stopping() {
                    break;
                }
                if let Ok(state) = complete.try_recv() {
                    return Ok(Some(state));
                }
                pump_messages();
            }

            if !aborting() {
                let stop = session.StopAsync().map_err(|e| e.to_string())?;
                if wait_operation(
                    || Ok(stop.Status()?.0 == 0),
                    || stop.GetResults(),
                    || stop.Cancel(),
                    CLOSE_TIMEOUT,
                    || !aborting(),
                )?
                .is_some()
                {
                    return Ok(None);
                }
            }

            sender.active.store(false, Ordering::Release);
            if let Ok(cancel) = session.CancelAsync() {
                let _ = wait_operation(
                    || Ok(cancel.Status()?.0 == 0),
                    || cancel.GetResults(),
                    || cancel.Cancel(),
                    CLOSE_TIMEOUT,
                    || true,
                );
            }
            Ok(None)
        })();

        sender.active.store(false, Ordering::Release);
        let _ = session.RemoveResultGenerated(final_token);
        let _ = session.RemoveCompleted(completion);
        if let Some(token) = hypothesis {
            let _ = recognizer.RemoveHypothesisGenerated(token);
        }
        run_result
    }

    fn start_error(error: windows::core::Error) -> String {
        if error.code().0 as u32 == 0x8004_5509 {
            "Enable online speech recognition in Windows Settings > Privacy & Security > Speech."
                .into()
        } else {
            format!("Failed to start Windows Speech: {error}")
        }
    }

    #[derive(Clone)]
    struct ResultSender {
        results: mpsc::Sender<TranscriptResult>,
        control: Arc<Control>,
        mute: MuteState,
        revision: u64,
        session_number: u64,
        active: Arc<AtomicBool>,
        segment: Arc<AtomicU64>,
    }

    impl ResultSender {
        fn allowed(&self) -> bool {
            self.active.load(Ordering::Acquire)
                && !self.control.abort.load(Ordering::Acquire)
                && self.mute.allows(self.revision)
        }

        fn send(&self, text: String, is_final: bool, confidence: f32) {
            if text.trim().is_empty() || !self.allowed() {
                return;
            }
            let segment = if is_final {
                self.segment.fetch_add(1, Ordering::Relaxed)
            } else {
                self.segment.load(Ordering::Relaxed)
            };
            let result = TranscriptResult {
                text,
                is_final,
                confidence,
                timestamp_ms: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64,
                speaker: None,
                language: None,
                segment_id: Some(format!("win_{}_{}", self.session_number, segment)),
                duration_ms: None,
                speaker_tag: None,
                turn: None,
            };
            // A WinRT callback must never wait on the transcript consumer.
            if self.allowed() {
                if self.results.try_send(result).is_err() && is_final && !self.results.is_closed() {
                    log::warn!("Windows Speech transcript channel is full");
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn windows_speech_rejects_system_audio() {
        let mut stt = WindowsNativeSTT::for_custom_stream();
        let (tx, mut rx) = mpsc::channel(1);
        assert!(stt
            .start_stream(tx)
            .await
            .unwrap_err()
            .to_string()
            .contains("microphone"));
        assert!(rx.recv().await.is_none());
    }
}
