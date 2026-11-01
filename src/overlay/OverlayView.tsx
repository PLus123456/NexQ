import { useCallback, useEffect, useMemo, useState } from "react";
import { useMeetingStore } from "../stores/meetingStore";
import { useScenarioStore } from "../stores/scenarioStore";
import { useCallLogStore } from "../stores/callLogStore";
import { useAIActionsStore } from "../stores/aiActionsStore";
import { useTranslationStore } from "../stores/translationStore";
import { showToast } from "../stores/toastStore";
import { translateBatchForParties } from "../lib/translation/ipc";
import { serviceParties, TRANSLATION_PARTIES, partyTranslationMode } from "../lib/translation/nativeTranslation";
import { languageLabel } from "../lib/languages";
import { APP_NAME } from "../lib/brand";
import { useAutoTranslate } from "../hooks/useAutoTranslate";
import { errorMessage } from "../stores/translationStore";
import { useT } from "../i18n";
import { TranscriptPanel } from "./TranscriptPanel";
import { QuestionDetector } from "./QuestionDetector";
import { AIResponsePanel } from "./AIResponsePanel";
import { ModeButtons } from "./ModeButtons";
import { AskInput } from "./AskInput";
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
import { MODE_COLORS } from "../lib/speakerColors";
import { showLauncherWindow } from "../lib/windows";
import {
  GripHorizontal,
  Minus,
  Settings,
  Square,
  Activity,
  Terminal,
  BarChart3,
  Bookmark,
  Globe,
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  Columns2,
  PanelLeftClose,
  PanelRightClose,
  Eye,
  ScreenShare,
  ScreenShareOff,
  AlertTriangle,
} from "lucide-react";
import { toggleStealthMode } from "../hooks/useGlobalShortcut";
import { formatShortcut } from "../lib/shortcutLabel";
import { formatDuration } from "../lib/utils";

// ════════════════════════════════════════════════════════════════
export function OverlayView() {
  const { t } = useT("translation");
  const activeMeeting = useMeetingStore((s) => s.activeMeeting);
  const elapsedMs = useMeetingStore((s) => s.elapsedMs);
  const recordingEnabled = useConfigStore((s) => s.recordingEnabled);
  const audioMode = useMeetingStore((s) => s.audioMode);
  const endMeetingFlow = useMeetingStore((s) => s.endMeetingFlow);
  const setCurrentView = useMeetingStore((s) => s.setCurrentView);
  const scenarioTemplate = useScenarioStore((s) => s.getActiveTemplate());
  const [askInputVisible, setAskInputVisible] = useState(false);
  const [devLogOpen, setDevLogOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [layoutMode, setLayoutMode] = useState<"split" | "ai" | "transcript">("split");

  // The overlay window stays mounted between meetings, so reset its local UI
  // state whenever a new meeting starts (panels, layout, ask input).
  const activeMeetingId = activeMeeting?.id ?? "";
  useEffect(() => {
    setAskInputVisible(false);
    setDevLogOpen(false);
    setStatsOpen(false);
    setBookmarksOpen(false);
    setLayoutMode("split");
  }, [activeMeetingId]);
  const cycleLayout = () => setLayoutMode((m) => m === "split" ? "ai" : m === "ai" ? "transcript" : "split");
  const toggleLog = useCallLogStore((s) => s.toggleOpen);
  const logOpen = useCallLogStore((s) => s.isOpen);
  const autoTrigger = useAIActionsStore((s) => s.configs.globalDefaults.autoTrigger);

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
  const displayMode = useTranslationStore((s) => s.displayMode);
  const setDisplayMode = useTranslationStore((s) => s.setDisplayMode);
  const targetLang = useTranslationStore((s) => s.targetLang);
  const translateParties = useTranslationStore((s) => s.translateParties);
  const backendStatus = useTranslationStore((s) => s.backendStatus);
  const batchProgress = useTranslationStore((s) => s.batchProgress);
  const meetingAudioConfig = useConfigStore((s) => s.meetingAudioConfig);
  const isBatchTranslating = batchProgress !== null;
  // The provider's last switch failed (e.g. no API key): say so on the button.
  const translationNotReady = backendStatus?.ok === false ? backendStatus.error ?? "" : null;
  const nothingToTranslate = TRANSLATION_PARTIES.every(
    (party) => partyTranslationMode(party, translateParties, meetingAudioConfig) === "off",
  );

  // Live translation of the transcript (one subscription for this window)
  useAutoTranslate();

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

  const handleEndMeeting = useCallback(async () => {
    try { await endMeetingFlow(); showToast(t("overlay.end.ended"), "info"); }
    catch (err) { showToast(err instanceof Error ? err.message : t("overlay.end.failed"), "error"); }
  }, [endMeetingFlow, t]);

  const handleToggleTranslate = useCallback(() => {
    const turningOn = !autoTranslateActive;
    setAutoTranslateActive(turningOn);
    if (!turningOn) return;
    if (translationNotReady !== null) {
      showToast(t("overlay.translate.notReady", { detail: translationNotReady }), "error");
    } else if (nothingToTranslate) {
      showToast(t("overlay.translate.noParty"), "info");
    }
  }, [autoTranslateActive, setAutoTranslateActive, translationNotReady, nothingToTranslate, t]);

  const handleTranslateAll = useCallback(async () => {
    const meetingId = activeMeeting?.id;
    if (!meetingId || !targetLang) return;
    // Parties the STT engine translates (Soniox) or that are switched off are left out.
    const parties = serviceParties(translateParties, meetingAudioConfig);
    if (parties.length === 0) {
      showToast(t("overlay.translate.noServiceParty"), "info");
      return;
    }
    try {
      const { total, alreadyDone, newlyTranslated } = await translateBatchForParties(meetingId, targetLang, parties);
      if (newlyTranslated === 0) {
        showToast(t("overlay.batch.alreadyDone", { total }), "info");
      } else if (alreadyDone > 0) {
        showToast(t("overlay.batch.someNew", { count: newlyTranslated, cached: alreadyDone, total }), "success");
      } else {
        showToast(t("overlay.batch.allNew", { total }), "success");
      }
    } catch (err) {
      showToast(t("overlay.batch.failed", { detail: errorMessage(err) }), "error");
    }
  }, [activeMeeting?.id, targetLang, translateParties, meetingAudioConfig, t]);

  // Hide the overlay and show the dashboard; the overlay keeps its meeting
  // view, so RETURN, Ctrl+B or the tray bring it straight back.
  const handleMinimizeToDashboard = useCallback(() => {
    showLauncherWindow().catch(() => {});
  }, []);

  const meetingTitle = activeMeeting?.title || APP_NAME;

  return (
    <div className="overlay-bg flex h-full flex-col rounded-xl border border-border/20 shadow-xl" style={{ background: `hsl(var(--background) / ${overlayOpacity})`, backdropFilter: overlayOpacity > 0.7 ? "blur(12px) saturate(1.1)" : "none" }}>

      {/* ═══ HEADER ═══ */}
      <div
        className="no-select flex items-center justify-between gap-3 px-4 py-2 cursor-move"
        data-tauri-drag-region
        style={{ borderBottom: "1px solid hsl(var(--border) / 0.12)" }}
      >
        <div className="flex items-center gap-2.5" data-tauri-drag-region>
          <GripHorizontal className="h-3 w-3 text-muted-foreground/40" />
          <span className="text-xs font-semibold text-foreground/90 truncate max-w-[160px]" title={meetingTitle}>
            {meetingTitle}
          </span>
          {recordingEnabled && (
            <div className="flex items-center gap-1.5 rounded-full bg-destructive/20 px-2.5 py-0.5 ring-1 ring-destructive/10" role="status" aria-label={t("overlay.recording.label")}>
              <span className="relative flex h-2.5 w-2.5" aria-hidden="true">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-75" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-destructive" />
              </span>
              <span className="text-meta font-semibold text-destructive tracking-wide">{t("overlay.recording.badge")}</span>
            </div>
          )}
          {/* Mode badge */}
          <span
            className="text-[9px] font-bold tracking-wider px-1.5 py-0.5 rounded"
            style={{ color: MODE_COLORS[audioMode].text, backgroundColor: MODE_COLORS[audioMode].bg }}
          >
            {audioMode === "online" ? t("overlay.mode.online") : t("overlay.mode.inPerson")}
          </span>
          {/* Scenario chip */}
          <span className="text-[10px] text-muted-foreground px-1.5 py-0.5 rounded bg-white/5">
            {scenarioTemplate.name}
          </span>
          <span className="text-xs text-muted-foreground/60 tabular-nums font-medium">
            {elapsedMs > 0 ? formatDuration(elapsedMs) : "00:00"}
          </span>
        </div>

        <div className="flex items-center gap-1">
          {/* Mute controls */}
          <button
            onClick={toggleMuteYou}
            className={`rounded-lg p-2 transition-all duration-150 cursor-pointer ${
              mutedYou
                ? "bg-destructive/15 text-destructive hover:bg-destructive/25"
                : "text-muted-foreground/60 hover:bg-accent/60 hover:text-foreground"
            }`}
            aria-label={mutedYou ? t("overlay.mute.unmuteYou") : t("overlay.mute.muteYou")}
            aria-pressed={mutedYou}
            title={mutedYou ? t("overlay.mute.unmuteYou") : t("overlay.mute.muteYou")}
          >
            {mutedYou ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
          </button>
          <button
            onClick={toggleMuteThem}
            className={`rounded-lg p-2 transition-all duration-150 cursor-pointer ${
              mutedThem
                ? "bg-destructive/15 text-destructive hover:bg-destructive/25"
                : "text-muted-foreground/60 hover:bg-accent/60 hover:text-foreground"
            }`}
            aria-label={mutedThem ? t("overlay.mute.unmuteThem") : t("overlay.mute.muteThem")}
            aria-pressed={mutedThem}
            title={mutedThem ? t("overlay.mute.unmuteThem") : t("overlay.mute.muteThem")}
          >
            {mutedThem ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
          </button>
          <div className="w-px h-3.5 bg-border/20 mx-0.5" />
          <HeaderBtn
            icon={layoutMode === "split" ? <Columns2 className="h-3.5 w-3.5" /> : layoutMode === "ai" ? <PanelLeftClose className="h-3.5 w-3.5" /> : <PanelRightClose className="h-3.5 w-3.5" />}
            onClick={cycleLayout}
            tooltip={layoutMode === "split" ? t("overlay.layout.focusAi") : layoutMode === "ai" ? t("overlay.layout.focusTranscript") : t("overlay.layout.split")}
          />
          <div className="w-px h-3.5 bg-border/20 mx-0.5" />
          <HeaderBtn icon={<BarChart3 className="h-3.5 w-3.5" />} active={statsOpen} onClick={() => setStatsOpen(p => !p)} tooltip={t("overlay.panels.speakerStats")} />
          <HeaderBtn icon={<Bookmark className="h-3.5 w-3.5" />} active={bookmarksOpen} onClick={() => setBookmarksOpen(p => !p)} tooltip={t("overlay.panels.bookmarks")} />
          <HeaderBtn icon={<Activity className="h-3.5 w-3.5" />} active={logOpen} onClick={toggleLog} tooltip={t("overlay.panels.callLog")} />
          <HeaderBtn icon={<Terminal className="h-3.5 w-3.5" />} active={devLogOpen} onClick={() => setDevLogOpen(p => !p)} tooltip={t("overlay.panels.devLog")} />
          <HeaderBtn
            icon={stealthMode ? <ScreenShareOff className="h-3.5 w-3.5" /> : <ScreenShare className="h-3.5 w-3.5" />}
            active={stealthMode}
            onClick={() => { toggleStealthMode().catch(() => {}); }}
            tooltip={stealthMode
              ? t("overlay.stealth.hidden", { shortcut: formatShortcut(stealthShortcut) })
              : t("overlay.stealth.visible", { shortcut: formatShortcut(stealthShortcut) })}
          />
          <HeaderBtn icon={<Eye className="h-3.5 w-3.5" />} onClick={cycleOpacity} tooltip={t("overlay.transparency", { percent: Math.round(overlayOpacity * 100) })} />
          <HeaderBtn icon={<Settings className="h-3.5 w-3.5" />} onClick={() => setCurrentView("settings")} tooltip={t("overlay.settings")} />
          <HeaderBtn icon={<Minus className="h-3.5 w-3.5" />} onClick={handleMinimizeToDashboard} tooltip={t("overlay.minimize")} />

          {/* Translation controls */}
          <button
            onClick={handleToggleTranslate}
            className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-all ${
              autoTranslateActive
                ? translationNotReady !== null
                  ? "bg-warning/10 text-warning ring-1 ring-warning/30"
                  : "bg-primary/10 text-primary ring-1 ring-primary/20"
                : "text-muted-foreground hover:bg-accent"
            }`}
            title={translationNotReady !== null
              ? t("overlay.translate.notReady", { detail: translationNotReady })
              : t("overlay.translate.toggle")}
            aria-pressed={autoTranslateActive}
          >
            {translationNotReady !== null
              ? <AlertTriangle className="h-3 w-3" aria-hidden="true" />
              : <Globe className="h-3 w-3" aria-hidden="true" />}
            {t("overlay.translate.label")}
          </button>

          {autoTranslateActive && (
            <>
              <div className="flex rounded-md border border-border/30 overflow-hidden">
                <button
                  onClick={() => setDisplayMode("inline")}
                  className={`px-2 py-0.5 text-[10px] font-medium transition-all ${
                    displayMode === "inline" ? "bg-primary/15 text-primary" : "text-muted-foreground/50"
                  }`}
                >
                  {t("overlay.translate.inline")}
                </button>
                <button
                  onClick={() => setDisplayMode("hover")}
                  className={`px-2 py-0.5 text-[10px] font-medium border-l border-border/30 transition-all ${
                    displayMode === "hover" ? "bg-primary/15 text-primary" : "text-muted-foreground/50"
                  }`}
                >
                  {t("overlay.translate.hover")}
                </button>
              </div>
              <button
                onClick={handleTranslateAll}
                disabled={isBatchTranslating}
                className="flex items-center gap-1 rounded-md border border-primary/20 bg-primary/5 px-1.5 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/10 transition-colors disabled:opacity-50 cursor-pointer"
                title={t("overlay.translate.allTitle")}
              >
                {isBatchTranslating ? t("overlay.translate.allRunning") : t("overlay.translate.all")}
              </button>
              <span
                className="text-[10px] text-muted-foreground/40 flex items-center gap-1"
                title={t("overlay.translate.target", { language: languageLabel(targetLang) })}
              >
                <span className={`h-1.5 w-1.5 rounded-full inline-block ${translationNotReady !== null ? "bg-warning" : "bg-success"}`} />
                {targetLang.toUpperCase()}
              </span>
            </>
          )}

          <button
            onClick={handleEndMeeting}
            className="ml-1.5 flex items-center gap-1.5 rounded-lg bg-destructive/10 border border-destructive/20 px-3 py-1.5 text-xs font-semibold text-destructive transition-all duration-150 hover:bg-destructive/20 hover:border-destructive/30 hover:shadow-sm hover:shadow-destructive/10 cursor-pointer"
            aria-label={t("overlay.end.label")}
          >
            <Square className="h-3 w-3 fill-current" aria-hidden="true" />
            {t("overlay.end.button")}
          </button>
        </div>
      </div>

      {/* ═══ MAIN ═══ */}
      <div className="relative flex-1 min-h-0">
      <div className="absolute inset-0 flex flex-wrap gap-2.5 overflow-hidden px-3 py-2.5">

        {/* ── LEFT: TRANSCRIPT ── */}
        {layoutMode !== "ai" ? (
          <div className="flex min-w-[180px] min-h-0 flex-1 basis-[220px] flex-col overflow-hidden rounded-xl bg-card/20">
            <div className="flex shrink-0 items-center border-b border-border/20 px-3 py-1.5">
              <span className="text-meta font-semibold uppercase tracking-wider text-muted-foreground/60">{t("overlay.panels.transcript")}</span>
            </div>
            <div className="flex flex-1 flex-col min-h-0 overflow-hidden p-2.5">
              <TranscriptPanel onOpenDevLog={() => setDevLogOpen(true)} />
            </div>
          </div>
        ) : (
          <div
            className="flex min-h-0 w-8 shrink-0 cursor-pointer flex-col items-center justify-center overflow-hidden rounded-xl bg-card/20 transition-all duration-200 hover:bg-card/30"
            onClick={() => setLayoutMode("split")}
            role="button"
            aria-label={t("overlay.panels.expandTranscript")}
            title={t("overlay.panels.expandTranscriptTitle")}
          >
            <span className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground/40" style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}>
              {t("overlay.panels.transcript")}
            </span>
          </div>
        )}

        {/* ── RIGHT ── */}
        {layoutMode !== "transcript" ? (
        <div className="flex min-w-[180px] min-h-0 flex-1 basis-[220px] flex-col gap-2.5 overflow-hidden">
          {/* Question detector — only shown when auto-trigger is on */}
          {autoTrigger && (
            <div className="shrink-0 rounded-xl border border-info/10 bg-info/5 px-4 py-3">
              <QuestionDetector />
            </div>
          )}

          {/* AI Response */}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-card/20">
            <div className="flex shrink-0 items-center gap-1 border-b border-border/20 px-2.5 py-1.5">
              <ModeButtons />
            </div>
            <div className="flex min-h-0 flex-1 flex-col p-3">
              <AIResponsePanel />
            </div>
          </div>
        </div>
        ) : (
          <div
            className="flex min-h-0 w-8 shrink-0 cursor-pointer flex-col items-center justify-center overflow-hidden rounded-xl bg-card/20 transition-all duration-200 hover:bg-card/30"
            onClick={() => setLayoutMode("split")}
            role="button"
            aria-label={t("overlay.panels.expandAi")}
            title={t("overlay.panels.expandAi")}
          >
            <span className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground/40" style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}>
              {t("overlay.panels.ai")}
            </span>
          </div>
        )}
      </div>
      </div>

      {/* Ask input */}
      {askInputVisible && (
        <div className="border-t border-border/20 px-3 py-1.5 slide-down-enter">
          <AskInput visible={askInputVisible} onClose={() => setAskInputVisible(false)} />
        </div>
      )}

      {/* DevLog panel */}
      <DevLogPanel open={devLogOpen} onClose={() => setDevLogOpen(false)} />

      {/* Speaker Stats */}
      {statsOpen && (
        <div className="border-t border-border/20 px-3 py-2">
          <SpeakerStatsPanel isOpen={statsOpen} />
        </div>
      )}

      {/* Bookmark panel */}
      {bookmarksOpen && <BookmarkPanel />}

      {/* Bookmark toast (manages its own visibility) */}
      <BookmarkToast />

      {/* ═══ FOOTER: Service Status ═══ */}
      <div className="border-t border-border/20">
        <ServiceStatusBar compact />
      </div>
    </div>
  );
}

// ── Header Button ──
function HeaderBtn({ icon, active, onClick, tooltip }: { icon: React.ReactNode; active?: boolean; onClick: () => void; tooltip: string }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg p-2 transition-all duration-150 cursor-pointer ${
        active ? "bg-primary/10 text-primary" : "text-muted-foreground/60 hover:bg-accent/60 hover:text-foreground"
      }`}
      aria-label={tooltip}
      aria-pressed={active}
    >
      {icon}
    </button>
  );
}


