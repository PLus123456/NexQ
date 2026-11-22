import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMeetingStore } from "../stores/meetingStore";
import { useScenarioStore } from "../stores/scenarioStore";
import { useCallLogStore } from "../stores/callLogStore";
import { useTranslationStore } from "../stores/translationStore";
import { showToast } from "../stores/toastStore";
import { translateBatchForParties } from "../lib/translation/ipc";
import { translateUntranslatedLines } from "../hooks/useAutoTranslate";
import { serviceParties, TRANSLATION_PARTIES, partyTranslationMode } from "../lib/translation/nativeTranslation";
import { APP_NAME } from "../lib/brand";
import { errorMessage } from "../stores/translationStore";
import { useT } from "../i18n";
import { TranscriptPanel } from "./TranscriptPanel";
import { QuestionPanel } from "./QuestionStrip";
import { useQuestionDetectionStore } from "../stores/questionDetectionStore";
import { AIResponsePanel } from "./AIResponsePanel";
import { ModeButtons } from "./ModeButtons";
import { OverlayMoreMenu } from "./OverlayMoreMenu";
import { ServiceStatusBar } from "../components/ServiceStatusBar";
import { DevLogPanel } from "../components/DevLogPanel";
import { SpeakerStatsPanel } from "./SpeakerStatsPanel";
import { BookmarkToast } from "./BookmarkToast";
import { BookmarkPanel } from "./BookmarkPanel";
import { useBookmarkHotkey } from "../hooks/useBookmarkHotkey";
import { useMeetingShortcuts } from "../hooks/useMeetingShortcuts";
import { useConfigStore } from "../stores/configStore";
import { useSpeakerDetection } from "../hooks/useSpeakerDetection";
import { useTopicDetection } from "../hooks/useTopicDetection";
import { useNoTranscriptWarning } from "../hooks/useNoTranscriptWarning";
import { showLauncherWindow } from "../lib/windows";
import { SCREENSHOT_EVENT } from "../lib/screenCapture";
import { setCaptionsLocked, toggleCaptions } from "../lib/captions/window";
import { useCaptionsVisible } from "../lib/captions/useCaptionsVisible";
import {
  clearInitialTranscriptDrawer,
  isInitialTranscriptDrawerRequested,
} from "./transcriptDrawerInit";
import {
  Captions,
  Columns2,
  Eye,
  GripHorizontal,
  Lock,
  MoreHorizontal,
  PanelLeftClose,
  ScreenShare,
  ScreenShareOff,
  ScrollText,
  Square,
  Unlock,
  X,
} from "lucide-react";
import { toggleStealthMode } from "../hooks/useGlobalShortcut";
import { formatShortcut, isMacPlatform } from "../lib/shortcutLabel";
import { formatDuration } from "../lib/utils";

/** Window width threshold (px) where the transcript drawer can dock side-by-side. */
const SIDE_BY_SIDE_MIN_WIDTH = 720;

// ════════════════════════════════════════════════════════════════
export function OverlayView() {
  const { t } = useT(["translation", "overlay"]);
  const activeMeeting = useMeetingStore((s) => s.activeMeeting);
  const elapsedMs = useMeetingStore((s) => s.elapsedMs);
  const recordingEnabled = useConfigStore((s) => s.recordingEnabled);
  const audioMode = useMeetingStore((s) => s.audioMode);
  const endMeetingFlow = useMeetingStore((s) => s.endMeetingFlow);
  const setCurrentView = useMeetingStore((s) => s.setCurrentView);
  const scenarioName = useScenarioStore((s) => s.getActiveTemplate().name);

  const [devLogOpen, setDevLogOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState<boolean>(() => isInitialTranscriptDrawerRequested());
  const [transcriptDocked, setTranscriptDocked] = useState(false);

  // Clear the one-shot harness flag after commit (safe under React StrictMode double-init).
  useEffect(() => {
    clearInitialTranscriptDrawer();
  }, []);
  const [containerWidth, setContainerWidth] = useState<number>(() =>
    typeof window !== "undefined" ? window.innerWidth : 500,
  );

  const rootRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);

  // Measure overlay width so side-by-side docking unlocks at ≥ 720px.
  useEffect(() => {
    const el = rootRef.current;
    const syncWidth = () => {
      const measured = el?.clientWidth || window.innerWidth;
      if (measured > 0) setContainerWidth(measured);
    };
    syncWidth();
    window.addEventListener("resize", syncWidth);
    let ro: ResizeObserver | null = null;
    if (el && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver((entries) => {
        const w = entries[0]?.contentRect?.width;
        if (w && w > 0) setContainerWidth(w);
      });
      ro.observe(el);
    }
    return () => {
      window.removeEventListener("resize", syncWidth);
      ro?.disconnect();
    };
  }, []);

  const canDockTranscript = containerWidth >= SIDE_BY_SIDE_MIN_WIDTH;
  const isSideBySide = transcriptOpen && transcriptDocked && canDockTranscript;

  // The overlay window stays mounted between meetings: reset local UI state
  // (answer-first layout, transcript closed, panels closed) when a new meeting starts.
  const activeMeetingId = activeMeeting?.id ?? "";
  const prevMeetingIdRef = useRef(activeMeetingId);
  useEffect(() => {
    if (prevMeetingIdRef.current === activeMeetingId) return;
    prevMeetingIdRef.current = activeMeetingId;
    setDevLogOpen(false);
    setStatsOpen(false);
    setBookmarksOpen(false);
    setMoreMenuOpen(false);
    setTranscriptOpen(false);
    setTranscriptDocked(false);
  }, [activeMeetingId]);

  // If a screenshot arrives while the floating transcript drawer is covering
  // the answer area, close the drawer so the Ask box is immediately visible.
  const drawerCoveringRef = useRef(false);
  drawerCoveringRef.current = transcriptOpen && !isSideBySide;
  useEffect(() => {
    const onScreenshot = () => {
      if (drawerCoveringRef.current) {
        setTranscriptOpen(false);
      }
    };
    window.addEventListener(SCREENSHOT_EVENT, onScreenshot);
    return () => window.removeEventListener(SCREENSHOT_EVENT, onScreenshot);
  }, []);

  const toggleLog = useCallLogStore((s) => s.toggleOpen);
  const logOpen = useCallLogStore((s) => s.isOpen);

  // Question detection settings (mode, predictions) for the question panel.
  const loadQuestionSettings = useQuestionDetectionStore((s) => s.load);
  useEffect(() => {
    void loadQuestionSettings();
  }, [loadQuestionSettings]);

  const captionsVisible = useCaptionsVisible();
  const captionsLocked = useConfigStore((s) => s.captionsLocked);

  const mutedYou = useConfigStore((s) => s.mutedYou);
  const mutedThem = useConfigStore((s) => s.mutedThem);
  const toggleMuteYou = useConfigStore((s) => s.toggleMuteYou);
  const toggleMuteThem = useConfigStore((s) => s.toggleMuteThem);
  const overlayOpacity = useConfigStore((s) => s.overlayOpacity);
  const stealthMode = useConfigStore((s) => s.stealthMode);
  const stealthShortcut = useConfigStore((s) => s.stealthShortcut);
  const setOverlayOpacity = useConfigStore((s) => s.setOverlayOpacity);
  const OPACITY_PRESETS = [0.9, 0.65, 0.35, 0.1];
  const cycleOpacity = () => {
    const idx = OPACITY_PRESETS.findIndex((p) => Math.abs(p - overlayOpacity) < 0.08); // i18n-ignore: a comparison, not text
    setOverlayOpacity(OPACITY_PRESETS[(idx + 1) % OPACITY_PRESETS.length]);
  };

  const autoTranslateActive = useTranslationStore((s) => s.autoTranslateActive);
  const setAutoTranslateActive = useTranslationStore((s) => s.setAutoTranslateActive);
  const setAutoTranslateEnabled = useTranslationStore((s) => s.setAutoTranslateEnabled);
  const displayMode = useTranslationStore((s) => s.displayMode);
  const setDisplayMode = useTranslationStore((s) => s.setDisplayMode);
  const targetLang = useTranslationStore((s) => s.targetLang);
  const translateParties = useTranslationStore((s) => s.translateParties);
  const backendStatus = useTranslationStore((s) => s.backendStatus);
  const batchProgress = useTranslationStore((s) => s.batchProgress);
  const meetingAudioConfig = useConfigStore((s) => s.meetingAudioConfig);
  const [translatingAll, setTranslatingAll] = useState(false);
  const isBatchTranslating = batchProgress !== null || translatingAll;
  // The provider's last switch failed (e.g. no API key): say so on the button.
  const translationNotReady = backendStatus?.ok === false ? backendStatus.error ?? "" : null;
  const nothingToTranslate = TRANSLATION_PARTIES.every(
    (party) => partyTranslationMode(party, translateParties, meetingAudioConfig) === "off",
  );

  // Bookmark hotkey (Ctrl+B) — also returns addBookmarkAtNow for shortcut hook
  const addBookmarkAtNow = useBookmarkHotkey();

  // Consolidated keyboard shortcuts for live meeting
  const shortcutActions = useMemo(
    () => ({
      addBookmark: addBookmarkAtNow,
      toggleStats: () => setStatsOpen((p) => !p),
      toggleBookmarks: () => setBookmarksOpen((p) => !p),
      toggleMute: () => useConfigStore.getState().toggleMuteYou(),
      closeAllPanels: () => {
        setStatsOpen(false);
        setBookmarksOpen(false);
        setDevLogOpen(false);
        setMoreMenuOpen(false);
        if (drawerCoveringRef.current) setTranscriptOpen(false);
      },
      toggleDevLog: () => setDevLogOpen((p) => !p),
    }),
    [addBookmarkAtNow],
  );
  useMeetingShortcuts(shortcutActions);

  // Speaker detection from Deepgram diarization events
  useSpeakerDetection();

  // Live topic detection from backend events
  useTopicDetection();

  // Keep watching for "audio heard without transcript" even while the transcript drawer is closed
  useNoTranscriptWarning();

  const handleEndMeeting = useCallback(async () => {
    try {
      await endMeetingFlow();
      showToast(t("overlay.end.ended"), "info");
    } catch (err) {
      showToast(err instanceof Error ? err.message : t("overlay.end.failed"), "error");
    }
  }, [endMeetingFlow, t]);

  const handleToggleTranslate = useCallback(() => {
    const turningOn = !autoTranslateActive;
    setAutoTranslateActive(turningOn);
    // The next meeting starts the same way.
    setAutoTranslateEnabled(turningOn);
    if (!turningOn) return;
    if (translationNotReady !== null) {
      showToast(t("overlay.translate.notReady", { detail: translationNotReady }), "error");
    } else if (nothingToTranslate) {
      showToast(t("overlay.translate.noParty"), "info");
    }
  }, [autoTranslateActive, setAutoTranslateActive, setAutoTranslateEnabled, translationNotReady, nothingToTranslate, t]);

  const handleTranslateAll = useCallback(async () => {
    const meetingId = activeMeeting?.id;
    if (!meetingId || !targetLang) return;
    // Parties the STT engine translates (Soniox) or that are switched off are left out.
    const parties = serviceParties(translateParties, meetingAudioConfig);
    if (parties.length === 0) {
      showToast(t("overlay.translate.noServiceParty"), "info");
      return;
    }
    setTranslatingAll(true);
    try {
      const batch = await translateBatchForParties(meetingId, targetLang, parties);
      // Then the lines not saved yet (failures show on their lines).
      const recent = await translateUntranslatedLines(parties, new Set(batch.handledIds ?? []));
      const total = batch.total + recent.translated + recent.failed;
      const newlyTranslated = batch.newlyTranslated + recent.translated;
      const alreadyDone = batch.alreadyDone;
      if (batch.failed) {
        showToast(
          t("overlay.batch.partial", { count: newlyTranslated, failed: batch.failed, detail: batch.firstError ?? "" }),
          "warning",
        );
      } else if (newlyTranslated === 0 && recent.failed === 0) {
        showToast(t("overlay.batch.alreadyDone", { total }), "info");
      } else if (alreadyDone > 0) {
        showToast(t("overlay.batch.someNew", { count: newlyTranslated, cached: alreadyDone, total }), "success");
      } else if (recent.failed === 0) {
        showToast(t("overlay.batch.allNew", { total }), "success");
      }
    } catch (err) {
      showToast(t("overlay.batch.failed", { detail: errorMessage(err) }), "error");
    } finally {
      setTranslatingAll(false);
    }
  }, [activeMeeting?.id, targetLang, translateParties, meetingAudioConfig, t]);

  const stealthHide = stealthMode && !!activeMeeting;
  const minimizeLabel = stealthHide
    ? t(isMacPlatform() ? "overlay.hideToMenuBar" : "overlay.hideToTray", { shortcut: formatShortcut("CmdOrCtrl+B") })
    : t("overlay.minimize");

  const handleMinimizeToDashboard = useCallback(async () => {
    if (stealthHide) {
      try {
        const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const overlay = await WebviewWindow.getByLabel("overlay");
        await overlay?.hide();
      } catch (e) {
        console.warn("[overlay] stealth-hide fell through, overlay stays visible:", e);
      }
      return;
    }
    showLauncherWindow().catch(() => {});
  }, [stealthHide]);

  const handleToggleCaptions = useCallback(() => {
    void toggleCaptions();
  }, []);

  const handleToggleCaptionsLock = useCallback(() => {
    void setCaptionsLocked(!captionsLocked);
  }, [captionsLocked]);

  const closeMoreMenu = useCallback((refocus = false) => {
    setMoreMenuOpen(false);
    if (refocus) moreButtonRef.current?.focus();
  }, []);

  const meetingTitle = activeMeeting?.title || APP_NAME;
  const moreHasIndicator =
    statsOpen || bookmarksOpen || logOpen || devLogOpen || mutedYou || mutedThem || translationNotReady !== null;

  const transcriptHeader = (
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/15 px-3 py-1.5">
      <span className="text-meta font-semibold uppercase tracking-wider text-muted-foreground/70">
        {t("overlay:transcriptDrawer.title")}
      </span>
      <div className="flex items-center gap-1">
        {canDockTranscript && (
          <button
            type="button"
            onClick={() => setTranscriptDocked((d) => !d)}
            aria-pressed={transcriptDocked}
            aria-label={
              transcriptDocked
                ? t("overlay:transcriptDrawer.switchToDrawer")
                : t("overlay:transcriptDrawer.dockSideBySide")
            }
            title={
              transcriptDocked
                ? t("overlay:transcriptDrawer.switchToDrawer")
                : t("overlay:transcriptDrawer.dockSideBySide")
            }
            className="rounded-md p-1 text-muted-foreground/65 transition-colors hover:bg-accent/60 hover:text-foreground cursor-pointer"
          >
            {transcriptDocked ? (
              <PanelLeftClose className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Columns2 className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </button>
        )}
        <button
          type="button"
          onClick={() => setTranscriptOpen(false)}
          aria-label={t("overlay:transcriptDrawer.close")}
          title={t("overlay:transcriptDrawer.close")}
          className="rounded-md p-1 text-muted-foreground/65 transition-colors hover:bg-accent/60 hover:text-foreground cursor-pointer"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );

  return (
    <div
      ref={rootRef}
      data-testid="overlay-root"
      className="overlay-bg flex h-full w-full flex-col overflow-x-hidden rounded-xl border border-border/20 shadow-xl"
      style={{
        background: `hsl(var(--background) / ${overlayOpacity})`,
        backdropFilter: overlayOpacity > 0.7 ? "blur(12px) saturate(1.1)" : "none",
      }}
    >
      {/* ═══ COMPACT SINGLE-ROW TITLE BAR (~32px) ═══ */}
      <div
        data-testid="overlay-header"
        className="no-select flex h-8 shrink-0 items-center justify-between gap-1.5 px-2.5 cursor-move"
        data-tauri-drag-region
        style={{ borderBottom: "1px solid hsl(var(--border) / 0.12)" }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5" data-tauri-drag-region>
          <GripHorizontal className="h-3 w-3 shrink-0 text-muted-foreground/40" aria-hidden="true" />
          <span className="min-w-0 truncate text-xs font-semibold text-foreground/90" title={meetingTitle}>
            {meetingTitle}
          </span>
          {recordingEnabled && (
            <div
              className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-destructive/20 px-1.5 py-0.5 ring-1 ring-destructive/15"
              role="status"
              aria-label={t("overlay.recording.label")}
            >
              <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-destructive" />
              </span>
              <span className="text-[10px] leading-none font-semibold text-destructive tracking-wide">
                {t("overlay.recording.badge")}
              </span>
            </div>
          )}
          <span className="shrink-0 text-[11px] text-muted-foreground/60 tabular-nums font-medium">
            {elapsedMs > 0 ? formatDuration(elapsedMs) : "00:00"}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {/* Captions strip toggle */}
          <HeaderBtn
            icon={<Captions className="h-3.5 w-3.5" aria-hidden="true" />}
            active={captionsVisible}
            onClick={handleToggleCaptions}
            tooltip={captionsVisible ? t("overlay:header.captions.hide") : t("overlay:header.captions.show")}
          />

          {/* Quick captions lock/unlock button when captions are active or locked */}
          {(captionsVisible || captionsLocked) && (
            <HeaderBtn
              icon={captionsLocked ? <Lock className="h-3.5 w-3.5" aria-hidden="true" /> : <Unlock className="h-3.5 w-3.5" aria-hidden="true" />}
              active={captionsLocked}
              tone={captionsLocked ? "warning" : undefined}
              onClick={handleToggleCaptionsLock}
              tooltip={captionsLocked ? t("overlay:header.captions.unlock") : t("overlay:header.captions.lock")}
            />
          )}

          {/* Transcript drawer toggle */}
          <HeaderBtn
            icon={<ScrollText className="h-3.5 w-3.5" aria-hidden="true" />}
            active={transcriptOpen}
            onClick={() => setTranscriptOpen((open) => !open)}
            tooltip={transcriptOpen ? t("overlay:header.transcript.hide") : t("overlay:header.transcript.show")}
          />

          {/* Stealth mode */}
          <HeaderBtn
            icon={stealthMode ? <ScreenShareOff className="h-3.5 w-3.5" aria-hidden="true" /> : <ScreenShare className="h-3.5 w-3.5" aria-hidden="true" />}
            active={stealthMode}
            onClick={() => {
              toggleStealthMode().catch(() => {});
            }}
            tooltip={
              stealthMode
                ? t("overlay.stealth.hidden", { shortcut: formatShortcut(stealthShortcut) })
                : t("overlay.stealth.visible", { shortcut: formatShortcut(stealthShortcut) })
            }
          />

          {/* Transparency cycle */}
          <HeaderBtn
            icon={<Eye className="h-3.5 w-3.5" aria-hidden="true" />}
            onClick={cycleOpacity}
            tooltip={t("overlay.transparency", { percent: Math.round(overlayOpacity * 100) })}
          />

          {/* "More" overflow menu */}
          <button
            ref={moreButtonRef}
            type="button"
            onClick={() => setMoreMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={moreMenuOpen}
            aria-label={t("overlay:header.more.label")}
            title={t("overlay:header.more.label")}
            className={`relative rounded-md p-1 transition-all duration-150 cursor-pointer ${
              moreMenuOpen
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground/65 hover:bg-accent/60 hover:text-foreground"
            }`}
          >
            <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
            {moreHasIndicator && !moreMenuOpen && (
              <span
                className={`absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full ${
                  translationNotReady !== null ? "bg-warning" : "bg-primary"
                }`}
                aria-hidden="true"
              />
            )}
          </button>

          {/* End meeting */}
          <button
            type="button"
            onClick={handleEndMeeting}
            className="ml-0.5 flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md bg-destructive/15 border border-destructive/25 px-2 py-0.5 text-[11px] font-semibold text-destructive transition-all duration-150 hover:bg-destructive/25 hover:border-destructive/35 cursor-pointer"
            aria-label={t("overlay.end.label")}
          >
            <Square className="h-2.5 w-2.5 fill-current shrink-0" aria-hidden="true" />
            <span>{t("overlay.end.button")}</span>
          </button>
        </div>
      </div>

      <OverlayMoreMenu
        open={moreMenuOpen}
        anchorRef={moreButtonRef}
        onClose={closeMoreMenu}
        audioMode={audioMode}
        scenarioName={scenarioName}
        mutedYou={mutedYou}
        mutedThem={mutedThem}
        onToggleMuteYou={toggleMuteYou}
        onToggleMuteThem={toggleMuteThem}
        captionsLocked={captionsLocked}
        onToggleCaptionsLock={handleToggleCaptionsLock}
        autoTranslateActive={autoTranslateActive}
        translationNotReady={translationNotReady}
        displayMode={displayMode}
        targetLang={targetLang}
        isBatchTranslating={isBatchTranslating}
        onToggleTranslate={handleToggleTranslate}
        onSetDisplayMode={setDisplayMode}
        onTranslateAll={handleTranslateAll}
        statsOpen={statsOpen}
        bookmarksOpen={bookmarksOpen}
        logOpen={logOpen}
        devLogOpen={devLogOpen}
        onToggleStats={() => setStatsOpen((p) => !p)}
        onToggleBookmarks={() => setBookmarksOpen((p) => !p)}
        onToggleLog={toggleLog}
        onToggleDevLog={() => setDevLogOpen((p) => !p)}
        onOpenSettings={() => setCurrentView("settings")}
        minimizeLabel={minimizeLabel}
        onMinimize={handleMinimizeToDashboard}
      />

      {/* ═══ MAIN: ANSWER-FIRST WORKSPACE + ON-DEMAND TRANSCRIPT DRAWER ═══ */}
      <div className="relative flex flex-1 min-h-0 overflow-hidden">
        <div className="flex h-full w-full min-w-0 gap-2 px-2 py-1">
          {/* Side-by-side transcript column (≥ 720px when docked) */}
          {isSideBySide && (
            <aside
              data-testid="transcript-side-panel"
              aria-label={t("overlay.panels.transcript")}
              className="flex w-[42%] min-w-[260px] max-w-[420px] shrink-0 flex-col overflow-hidden rounded-xl border border-border/20 bg-card/30"
            >
              {transcriptHeader}
              <div className="flex flex-1 flex-col min-h-0 overflow-hidden px-1.5 pb-1.5 pt-1">
                <TranscriptPanel onOpenDevLog={() => setDevLogOpen(true)} />
              </div>
            </aside>
          )}

          {/* Answer column: compact question strip + full-height answer card */}
          <div className="flex min-w-0 flex-1 flex-col gap-1 min-h-0">
            <QuestionPanel />

            <div
              data-testid="answer-card"
              className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/15 bg-card/20"
            >
              <div className="flex shrink-0 items-center border-b border-border/15 px-1.5 py-1">
                <ModeButtons />
              </div>
              <AIResponsePanel />
            </div>
          </div>
        </div>

        {/* Floating transcript drawer covering the answer area */}
        {transcriptOpen && !isSideBySide && (
          <div
            data-testid="transcript-drawer"
            role="region"
            aria-label={t("overlay.panels.transcript")}
            className="absolute inset-0 z-30 flex"
          >
            <div className="flex h-full w-[92%] max-w-[420px] flex-col overflow-hidden border-r border-border/25 bg-card/95 shadow-2xl backdrop-blur-md">
              {transcriptHeader}
              <div className="flex flex-1 flex-col min-h-0 overflow-hidden px-1.5 pb-1.5 pt-1">
                <TranscriptPanel onOpenDevLog={() => setDevLogOpen(true)} />
              </div>
            </div>
            <div
              className="flex-1 bg-background/45 backdrop-blur-[1px]"
              onClick={() => setTranscriptOpen(false)}
              aria-hidden="true"
            />
          </div>
        )}
      </div>

      {/* DevLog panel */}
      <DevLogPanel open={devLogOpen} onClose={() => setDevLogOpen(false)} />

      {/* Speaker Stats */}
      {statsOpen && (
        <div className="shrink-0 border-t border-border/20 px-3 py-2">
          <SpeakerStatsPanel isOpen={statsOpen} />
        </div>
      )}

      {/* Bookmark panel */}
      {bookmarksOpen && (
        <div className="shrink-0 border-t border-border/20">
          <BookmarkPanel onOpenTranscript={() => setTranscriptOpen(true)} />
        </div>
      )}

      {/* Bookmark toast (manages its own visibility) */}
      <BookmarkToast />

      {/* ═══ FOOTER: SINGLE-LINE THIN SERVICE STATUS BAR ═══ */}
      <div
        data-testid="overlay-status-bar"
        className="shrink-0 border-t border-border/20 [&>div]:flex-nowrap [&>div]:gap-1 [&>div]:px-2 [&>div]:py-1 [&>div>div]:min-w-0 [&>div>div>.relative]:min-w-0 [&_.relative>div:first-child]:max-w-full [&_.relative>div:first-child]:min-w-0 [&_.relative>div:first-child]:gap-1 [&_.relative>div:first-child]:px-1.5 [&_.relative>div:first-child]:py-0.5 [&_.relative>div:first-child_span]:text-[11px] [&_button.rounded-full]:p-0.5 [&_[data-testid=stream-latency]]:shrink-0 [&_[data-testid=stream-latency]_span]:whitespace-nowrap [&_[data-testid=stream-latency]_span]:text-[11px]"
      >
        <ServiceStatusBar compact />
      </div>
    </div>
  );
}

// ── Header Button ──
function HeaderBtn({
  icon,
  active,
  tone,
  onClick,
  tooltip,
}: {
  icon: React.ReactNode;
  active?: boolean;
  tone?: "warning";
  onClick: () => void;
  tooltip: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md p-1 transition-all duration-150 cursor-pointer ${
        active
          ? tone === "warning"
            ? "bg-warning/15 text-warning hover:bg-warning/25"
            : "bg-primary/15 text-primary"
          : "text-muted-foreground/65 hover:bg-accent/60 hover:text-foreground"
      }`}
      aria-label={tooltip}
      title={tooltip}
      aria-pressed={active}
    >
      {icon}
    </button>
  );
}
