import { useEffect, useCallback, useState } from "react";
import { attachMeetingWindow, persistOverlayMeetingData, useMeetingStore } from "./stores/meetingStore";
import { useConfigStore } from "./stores/configStore";
import { useAIActionsStore, watchSavedActionConfigs } from "./stores/aiActionsStore";
import { useSourcesStore } from "./stores/sourcesStore";
import { useScenarioStore, watchSavedScenarios } from "./stores/scenarioStore";
import { LauncherView } from "./launcher/LauncherView";
import { OverlayView } from "./overlay/OverlayView";
import { SettingsOverlay } from "./settings/SettingsOverlay";
import { FirstRunWizard } from "./components/wizard/FirstRunWizard";
import { ToastContainer } from "./components/Toast";
import { showToast } from "./stores/toastStore";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { t as translate, useT } from "./i18n";
import { initOnboarding } from "./stores/onboardingStore";
import { resolveAppView } from "./lib/onboarding/view";
import { UpdateReadyToast } from "./components/UpdateToast";
import { UpdateDialog } from "./components/UpdateDialog";
import { useTheme } from "./hooks/useTheme";
import { useGlobalShortcut } from "./hooks/useGlobalShortcut";
import { useTranslationEvents } from "./hooks/useTranslationEvents";
import { useAutoTranslate } from "./hooks/useAutoTranslate";
import { useTraySync } from "./hooks/useTraySync";
import { useStealthCursor } from "./hooks/useStealthCursor";
import { useUpdater } from "./hooks/useUpdater";
import { useAgentFallbackToast } from "./hooks/useAgentFallbackToast";
import { refreshClaudeModelsOnStart } from "./stores/agentStore";
import { useTranslationStore } from "./stores/translationStore";
import { CallLogPanel } from "./calllog";
import { OverlayResizeHandles } from "./overlay/OverlayResizeHandles";
import { SelectionToolbar } from "./components/SelectionToolbar";
import { ActiveMeetingProvider } from "./components/ActiveMeetingProvider";
import { initMeetingSpeakers, resetMeetingScopedStores } from "./stores/resetMeeting";
import { emit, listen, type Event as TauriEvent } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { AppView, WindowMeetingEndedEvent } from "./lib/types";
import { useDemoShortcut } from "./demo/useDemoShortcut";
import { DemoPicker } from "./demo/DemoPicker";
import { DemoBadge } from "./demo/DemoBadge";
import { SCREENSHOT_EVENT, leaveSettingsForAsk } from "./lib/screenCapture";
import { SHOW_MEETING_OVERLAY_EVENT, TOGGLE_OVERLAY_SETTINGS_EVENT, showLauncherWindow, showMeetingOverlay, showOverlayWindow, toggleWindowSettings } from "./lib/windows";
import { createEventScope } from "./lib/eventScope";
import { acknowledgeOverlaySave, MEETING_ENDED, MEETING_END_FAILED, MEETING_STARTED, MEETING_STOP_REQUEST, OVERLAY_PRESENT, OVERLAY_SAVE_REQUEST, type MeetingEndResult, type MeetingStarted, type OverlaySaveRequest } from "./lib/meetingWindowEvents";
import { isQuitPending } from "./lib/ipc";
import { copyFromTray, type TrayCopyKind } from "./lib/trayCopy";
import { emitOverlayMeetingReady, onAudioCaptureStatus, onAudioCaptureStopped, onCaptureWarning, onOverlayMeetingReady, onStartDetectedMeeting, onStealthModeChanged } from "./lib/events";
import { createCaptureStatusHandler } from "./lib/captureStatus";
import { useCaptionsMeeting } from "./lib/captions/useCaptionsMeeting";

function App() {
  const { t } = useT("onboarding");
  const currentView = useMeetingStore((s) => s.currentView);
  const settingsOpen = useMeetingStore((s) => s.settingsOpen);
  const setSettingsOpen = useMeetingStore((s) => s.setSettingsOpen);
  const setCurrentView = useMeetingStore((s) => s.setCurrentView);
  const loadRecentMeetings = useMeetingStore((s) => s.loadRecentMeetings);
  // Changes on every new meeting → used as a React key to remount overlay UI
  // so local component state (open panels, tabs, layout) is reset too.
  const activeMeetingId = useMeetingStore((s) => s.activeMeeting?.id ?? "");
  const meetingListenersReadyId = useMeetingStore((s) => s.meetingListenersReadyId);
  const [windowLabel] = useState(() => {
    try { return getCurrentWebviewWindow().label; } catch { return ""; }
  });
  const firstRunCompleted = useConfigStore((s) => s.firstRunCompleted);
  const configLoaded = useConfigStore((s) => s._loaded);
  const loadConfig = useConfigStore((s) => s.loadConfig);

  // Wire up theme and global shortcuts
  useTheme();
  useGlobalShortcut();

  // Demo mode keyboard shortcut (Ctrl+Shift+D)
  useDemoShortcut();

  // Translation events in every window (results, errors, provider status);
  // live translation requests only in the overlay window, also while it shows settings.
  useTranslationEvents();
  useAutoTranslate();

  // Sync frontend state to system tray icon & menu
  useTraySync(windowLabel === "launcher");

  // Background updates — the loop runs only in the launcher window
  useUpdater();

  // Tray notification toasts for meeting start/stop
  // Tray notifications removed — LauncherView/OverlayView/StatusBar already show meeting toasts

  // Load persisted config from Tauri store on app start
  useEffect(() => {
    loadConfig();
    // First-run setup progress; also follows setup being started again in another window
    initOnboarding();
    useAIActionsStore.getState().loadConfigs();
    useSourcesStore.getState().load();
    // Restore the translation provider and its settings in the backend (the
    // Microsoft region comes from the keychain there). A provider that isn't
    // ready — e.g. no key yet — is kept in backendStatus, which the overlay's
    // Translate button and the translation settings show.
    useTranslationStore.getState().loadConfig().then(() => useTranslationStore.getState().syncBackend());
    // Load scenario config (custom scenarios, overrides, active scenario)
    useScenarioStore.getState().loadScenarioConfig();
  }, [loadConfig]);

  // Settings the other window saves reach this one (scenarios, AI actions).
  useEffect(() => {
    const watching = [
      watchSavedScenarios().catch((e) => {
        console.warn("[App] Could not start watching scenarios saved by the other window:", e);
        return undefined;
      }),
      watchSavedActionConfigs().catch((e) => {
        console.warn("[App] Could not start watching AI settings saved by the other window:", e);
        return undefined;
      }),
    ];
    return () => {
      watching.forEach((w) => w.then((stop) => stop?.()));
    };
  }, []);

  // Load recent meetings on app start
  useEffect(() => {
    loadRecentMeetings();
  }, [loadRecentMeetings]);

  useEffect(() => {
    if (windowLabel === "launcher") return attachMeetingWindow();
    if (windowLabel === "overlay") {
      document.body.style.background = "transparent";
      document.documentElement.style.background = "transparent";
    }
  }, [windowLabel]);
  useStealthCursor(windowLabel);

  useEffect(() => {
    if (windowLabel !== "launcher" || currentView !== "overlay") return;
    useMeetingStore.getState().setCurrentView("launcher");
    void showMeetingOverlay().catch(() => {});
  }, [currentView, windowLabel]);

  useEffect(() => {
    if (windowLabel !== "overlay") return;
    const scope = createEventScope("Meeting overlay");
    let preparingMeetingId: string | undefined;
    let lastEndedId: string | undefined;
    let saving: Promise<[string, string][]> | undefined;
    const broadcastHidden = (hidden: boolean) => {
      const store = useMeetingStore.getState();
      if (!store.activeMeeting || store.overlayHidden === hidden) return;
      store.setOverlayHidden(hidden);
      void emit("nexq:overlay_hidden_changed", { meetingId: store.activeMeeting.id, hidden }).catch(() => {});
    };
    const show = () => {
      const store = useMeetingStore.getState();
      if (!store.activeMeeting) {
        void showLauncherWindow().catch(() => {});
        return;
      }
      if (store.currentView !== "overlay" && store.currentView !== "settings") store.setCurrentView("overlay");
      broadcastHidden(false);
      void showOverlayWindow().catch(() => {});
    };
    void scope.add((onEvent) => listen(SHOW_MEETING_OVERLAY_EVENT, onEvent), show);
    void scope.add((onEvent) => listen("tray_show_overlay", onEvent, { target: windowLabel }), show);
    void scope.add((onEvent) => listen(TOGGLE_OVERLAY_SETTINGS_EVENT, onEvent), toggleWindowSettings);
    void scope.add((onEvent) => listen("tray_toggle_stealth", onEvent, { target: windowLabel }), () => {
      const store = useMeetingStore.getState();
      if (!store.activeMeeting) return;
      if (store.overlayHidden) show();
      else {
        broadcastHidden(true);
        void getCurrentWebviewWindow().hide().catch(() => {});
      }
    });

    void scope.add<TauriEvent<MeetingStarted>>((onEvent) => listen(MEETING_STARTED, onEvent), ({ payload }) => {
      const { meeting, audioMode, aiScenario } = payload;
      const state = useMeetingStore.getState();
      if (state.activeMeeting?.id === meeting.id) {
        void emit(OVERLAY_PRESENT, { meetingId: meeting.id }).catch(() => {});
        if (state.meetingListenersReadyId === meeting.id) void emitOverlayMeetingReady(meeting.id).catch(() => {});
        return;
      }
      if (lastEndedId === meeting.id || preparingMeetingId || state.activeMeeting) return;
      preparingMeetingId = meeting.id;
      void (async () => {
        await resetMeetingScopedStores();
        if (!scope.active() || lastEndedId === meeting.id) return;
        initMeetingSpeakers(audioMode);
        useConfigStore.setState({ mutedYou: audioMode === "in_person", mutedThem: false });
        await useScenarioStore.getState().loadScenarioConfig();
        if (!scope.active() || lastEndedId === meeting.id) return;
        useScenarioStore.setState({ activeScenarioId: aiScenario });
        const parsedTime = Date.parse(meeting.start_time);
        useMeetingStore.setState({
          activeMeeting: meeting,
          currentView: "overlay",
          audioMode,
          aiScenario,
          isRecording: true,
          isEndingMeeting: false,
          meetingStartTime: Number.isFinite(parsedTime) ? parsedTime : Date.now(),
          elapsedMs: 0,
          meetingListenersReadyId: null,
          lastPersistedIndex: 0,
          selectedMeetingId: null,
          unfinishedMeeting: null,
          overlayHidden: false,
          settingsOpen: false,
        });
        useMeetingStore.getState().startTimer();
        void emit(OVERLAY_PRESENT, { meetingId: meeting.id }).catch(() => {});
      })().catch((error) => console.warn("[App] Could not prepare meeting overlay:", error)).finally(() => {
        preparingMeetingId = undefined;
      });
    });
    void scope.add<TauriEvent<OverlaySaveRequest>>((onEvent) => listen(OVERLAY_SAVE_REQUEST, onEvent), ({ payload }) => {
      if (useMeetingStore.getState().activeMeeting?.id !== payload.meetingId) return;
      useMeetingStore.setState({ isEndingMeeting: true });
      if (!saving) {
        saving = persistOverlayMeetingData(payload.meetingId);
        void saving.finally(() => { saving = undefined; }).catch(() => {});
      }
      void saving.then(
        (speakerAliases) => ({ ...payload, speakerAliases }),
        (error) => ({ ...payload, message: error instanceof Error ? error.message : String(error) }),
      ).then((result) => {
        if (scope.active()) return acknowledgeOverlaySave(result);
      }).catch(() => {});
    });
    void scope.add<TauriEvent<WindowMeetingEndedEvent>>((onEvent) => listen(MEETING_ENDED, onEvent), ({ payload }) => {
      if (payload.window !== "launcher") return;
      lastEndedId = payload.meetingId;
      useMeetingStore.getState().clearEndedMeeting(payload.meetingId);
    });
    void scope.add<TauriEvent<MeetingEndResult>>((onEvent) => listen(MEETING_END_FAILED, onEvent), ({ payload }) => {
      if (useMeetingStore.getState().activeMeeting?.id === payload.meetingId) {
        useMeetingStore.setState({ isEndingMeeting: false });
      }
    });
    return scope.dispose;
  }, [windowLabel]);

  useEffect(() => {
    if (windowLabel === "overlay" && activeMeetingId && meetingListenersReadyId === activeMeetingId) {
      void emitOverlayMeetingReady(activeMeetingId).catch(() => {});
    }
  }, [activeMeetingId, meetingListenersReadyId, windowLabel]);

  useEffect(() => {
    if (windowLabel !== "overlay") return;
    const onScreenshot = (e: Event) => {
      if (leaveSettingsForAsk()) e.preventDefault();
    };
    window.addEventListener(SCREENSHOT_EVENT, onScreenshot);
    return () => window.removeEventListener(SCREENSHOT_EVENT, onScreenshot);
  }, [windowLabel]);

  useEffect(() => {
    if (windowLabel !== "launcher") return;
    const scope = createEventScope("Meeting launcher");
    const start = (title?: string, scenario?: MeetingStarted["aiScenario"]) => {
      void useMeetingStore.getState().startMeetingFlow(title, title ? "online" : undefined, scenario).catch((error) => {
        console.error("[App] Could not start the meeting:", error);
      });
    };
    void scope.add(onStartDetectedMeeting, ({ title, scenario }) => start(title, scenario));
    void scope.add(onOverlayMeetingReady, ({ meetingId }) => useMeetingStore.getState().setOverlayMeetingId(meetingId));
    void scope.add<TauriEvent<{ meetingId: string }>>((onEvent) => listen(OVERLAY_PRESENT, onEvent), ({ payload }) => {
      useMeetingStore.getState().setOverlayMeetingId(payload.meetingId);
    });
    void scope.add((onEvent) => listen("tray_start_meeting", onEvent, { target: windowLabel }), () => start());
    void scope.add<TauriEvent<{ meetingId?: string } | null>>((onEvent) => listen(MEETING_STOP_REQUEST, onEvent, { target: windowLabel }), ({ payload }) => {
      const store = useMeetingStore.getState();
      if (!store.activeMeeting || (payload?.meetingId && payload.meetingId !== store.activeMeeting.id)) return;
      if (store.isEndingMeeting) return;
      void store.endMeetingFlow().catch((error) => {
        console.error("[App] Could not end the meeting:", error);
        showToast(error instanceof Error ? error.message : translate("onboarding:app.errors.endMeeting"), "error");
      });
    });
    void scope.add<TauriEvent<WindowMeetingEndedEvent>>((onEvent) => listen(MEETING_ENDED, onEvent), ({ payload }) => {
      if (payload.window !== "launcher" || useMeetingStore.getState().activeMeeting) return;
      void isQuitPending().catch(() => false).then((pending) => {
        if (scope.active() && pending !== true && !useMeetingStore.getState().activeMeeting) return showLauncherWindow();
      }).catch(() => {});
    });
    void scope.add((onEvent) => listen("tray_open_settings", onEvent, { target: windowLabel }), () => useMeetingStore.getState().openSettings());
    void scope.add<TauriEvent<string>>((onEvent) => listen("tray_open_meeting", onEvent, { target: windowLabel }), ({ payload }) => {
      const store = useMeetingStore.getState();
      store.setSettingsOpen(false);
      store.setCurrentView("launcher");
      store.setSelectedMeetingId(payload);
    });
    void scope.add((onEvent) => listen("tray_toggle_mic", onEvent, { target: windowLabel }), () => useConfigStore.getState().toggleMuteYou());
    void scope.add((onEvent) => listen("tray_toggle_system", onEvent, { target: windowLabel }), () => useConfigStore.getState().toggleMuteThem());
    void scope.add<TauriEvent<{ meetingId: string; hidden: boolean }>>((onEvent) => listen("nexq:overlay_hidden_changed", onEvent), ({ payload }) => {
      const store = useMeetingStore.getState();
      if (store.activeMeeting?.id === payload.meetingId) store.setOverlayHidden(payload.hidden);
    });
    return scope.dispose;
  }, [windowLabel]);

  // Toast when Claude is unavailable and requests move to the fallback provider
  useAgentFallbackToast(windowLabel);

  // The caption strip shows with a meeting and hides when it ends (answer window only).
  useCaptionsMeeting(windowLabel === "overlay");

  // Claude's model catalog: asked once per app start by the launcher (no
  // model call); the overlay gets it through the persisted config store.
  useEffect(() => {
    if (configLoaded && windowLabel === "launcher") refreshClaudeModelsOnStart();
  }, [configLoaded, windowLabel]);

  const previousView = useMeetingStore((s) => s.previousView);

  // Listen for Escape key to close settings
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (currentView === "settings") {
          // Return to the view settings was opened from
          setCurrentView(previousView || "launcher");
        } else if (settingsOpen) {
          setSettingsOpen(false);
        }
      }
    },
    [currentView, settingsOpen, setCurrentView, setSettingsOpen, previousView]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  useEffect(() => {
    if (!windowLabel) return;
    const scope = createEventScope("App");
    void scope.add((onEvent) => listen("nexq:quit_failed", onEvent), () => {
      showToast(translate("onboarding:app.errors.endMeeting"), "error");
    });
    void scope.add(onCaptureWarning, (message) => showToast(message, "warning"));
    const captureStatus = createCaptureStatusHandler();
    void scope.add(onAudioCaptureStatus, captureStatus.handle);
    void scope.add<void>((onEvent) => onAudioCaptureStopped(() => onEvent()), captureStatus.reset);
    void scope.add(onStealthModeChanged, (enabled) => useConfigStore.getState().stealthModeApplied(enabled));
    void scope.add<TauriEvent<{ source: "you" | "them"; muted: boolean; meetingId?: string }>>((onEvent) => listen("source_mute_changed", onEvent), ({ payload }) => {
      if (payload.meetingId && payload.meetingId !== useMeetingStore.getState().activeMeeting?.id) return;
      useConfigStore.setState(payload.source === "you" ? { mutedYou: payload.muted } : { mutedThem: payload.muted });
    });
    void scope.add<TauriEvent<{ kind: TrayCopyKind; window: string }>>((onEvent) => listen("tray_copy", onEvent, { target: windowLabel }), ({ payload }) => {
      if (payload.window === windowLabel) void copyFromTray(payload.kind);
    });
    return () => {
      scope.dispose();
      captureStatus.reset();
    };
  }, [windowLabel]);

  // Don't render until config is loaded from disk — prevents false wizard trigger
  if (!configLoaded) {
    const loadingBg = windowLabel === "overlay" ? "bg-transparent" : "bg-background";
    return (
      <div className={`flex h-screen w-screen items-center justify-center ${loadingBg}`}>
        {windowLabel !== "overlay" && (
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 rounded-xl bg-primary/10 flex items-center justify-center">
              <div className="h-3 w-3 rounded-full bg-primary/40 animate-pulse" />
            </div>
            <div className="text-sm text-muted-foreground">{t("app.starting")}</div>
          </div>
        )}
      </div>
    );
  }

  // Determine which view to render (first-run setup until it is finished)
  const resolvedView: AppView = resolveAppView(firstRunCompleted, currentView);
  const isOverlayWindow = windowLabel === "overlay";
  const isLauncherWindow = windowLabel === "launcher" || windowLabel === "";

  // Overlay Tauri window: always transparent, uses currentView directly (ignores firstRunCompleted)
  if (isOverlayWindow) {
    return (
      <div className="h-screen w-screen overflow-hidden bg-transparent text-foreground">
        <ErrorBoundary fallbackMessage={t("app.errors.app")}>
          {currentView === "overlay" && (
            <ErrorBoundary fallbackMessage={t("app.errors.overlay")}>
              {/* key on the meeting id → remounts overlay UI per meeting so local
                  state (open panels, tabs, layout mode) does not carry over */}
              <div key={activeMeetingId || "no-meeting"} className="flex h-full">
                <div className="flex-1 min-w-0 overflow-hidden">
                  <OverlayView />
                </div>
                <CallLogPanel />
              </div>
            </ErrorBoundary>
          )}
          {(settingsOpen || currentView === "settings") && (
            <SettingsOverlay isModal={currentView === "overlay"} />
          )}
        </ErrorBoundary>
        <ActiveMeetingProvider isLauncherWindow={false} />
        <ToastContainer />
        <SelectionToolbar key={activeMeetingId} />
        {/* Settings -> About can open here too */}
        <UpdateDialog />
        {/* macOS + stealth only: resize the overlay without macOS's resize cursors */}
        <OverlayResizeHandles />
      </div>
    );
  }

  return (
    <div className={`h-screen w-screen overflow-hidden text-foreground ${resolvedView === "overlay" ? "bg-transparent" : "bg-background"}`}>
      <ErrorBoundary fallbackMessage={t("app.errors.app")}>
        {(resolvedView === "launcher" || resolvedView === "overlay") && (
          <ErrorBoundary fallbackMessage={t("app.errors.launcher")}>
            <LauncherView />
          </ErrorBoundary>
        )}
        {resolvedView === "wizard" && (
          <ErrorBoundary fallbackMessage={t("app.errors.wizard")}>
            <FirstRunWizard />
          </ErrorBoundary>
        )}
        {resolvedView === "settings" && (
          <ErrorBoundary fallbackMessage={t("app.errors.settings")}>
            <SettingsOverlay />
          </ErrorBoundary>
        )}
        {/* Settings as a dialog over the current view (the meeting, the launcher, setup) */}
        {settingsOpen && resolvedView !== "settings" && <SettingsOverlay isModal />}
      </ErrorBoundary>
      <ActiveMeetingProvider isLauncherWindow={isLauncherWindow} />
      <ToastContainer />
      <SelectionToolbar />
      {/* Call log panel is now integrated into the overlay flex layout above */}

      {/* One-time "update ready" notice (the footer pill stays) */}
      <UpdateReadyToast />
      <UpdateDialog />

      {/* Demo mode — scenario picker modal + floating exit badge */}
      <DemoPicker />
      <DemoBadge />
    </div>
  );
}

export default App;
