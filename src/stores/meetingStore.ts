import { create } from "zustand";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { AppView, Meeting, MeetingSummary, AudioMode, AIScenario, WindowMeetingEndedEvent } from "../lib/types";
import { endMeetingInLauncher, MEETING_ENDED, MEETING_END_FAILED, saveMeetingInOverlay, startOverlayMeeting, WINDOW_READY_TIMEOUT_MS } from "../lib/meetingWindowEvents";
import { captureParties, skipYouStt } from "../lib/audioMode";
import {
  startMeeting as ipcStartMeeting,
  endMeeting as ipcEndMeeting,
  listMeetings as ipcListMeetings,
  startCapture,
  startCapturePerParty,
  stopCapture,
} from "../lib/ipc";
import { useConfigStore } from "./configStore";
import { useCallLogStore } from "./callLogStore";
import { useStreamStore } from "./streamStore";
import { useTranscriptStore } from "./transcriptStore";
import { initMeetingSpeakers, resetMeetingScopedStores } from "./resetMeeting";
import { showToast } from "./toastStore";
import { t } from "../i18n";

interface MeetingState {
  // View state
  currentView: AppView;
  previousView: AppView | null;
  settingsOpen: boolean;
  /** Tab the settings panel opens on next (cleared when it opens). */
  settingsTab: string | null;

  // Active meeting
  activeMeeting: Meeting | null;
  isRecording: boolean;
  isEndingMeeting: boolean;
  meetingStartTime: number | null;
  elapsedMs: number;

  // Meeting history
  recentMeetings: MeetingSummary[];

  // Persistence tracking
  lastPersistedIndex: number;

  // Timer interval ID
  _timerInterval: ReturnType<typeof setInterval> | null;

  // Crash recovery
  unfinishedMeeting: MeetingSummary | null;

  // Active meeting mode / scenario
  audioMode: AudioMode;
  aiScenario: AIScenario;

  // Stealth mode (overlay hidden while recording)
  overlayHidden: boolean;

  // Launcher only: the overlay has opened this meeting and owns its edits.
  overlayMeetingId: string | null;
  meetingListenersReadyId: string | null;
  setMeetingListenersReady: (id: string) => void;
  setOverlayMeetingId: (id: string | null) => void;
  clearEndedMeeting: (id: string) => boolean;

  // Launcher detail view (past meeting selected for viewing)
  selectedMeetingId: string | null;

  // Actions
  setCurrentView: (view: AppView) => void;
  setSettingsOpen: (open: boolean) => void;
  /** Open settings (modal over the meeting, else the settings view) at `tab`. */
  openSettings: (tab?: string) => void;
  setActiveMeeting: (meeting: Meeting | null) => void;
  setIsRecording: (recording: boolean) => void;
  setMeetingStartTime: (time: number | null) => void;
  setElapsedMs: (ms: number) => void;
  setRecentMeetings: (meetings: MeetingSummary[]) => void;
  setLastPersistedIndex: (index: number) => void;
  setUnfinishedMeeting: (meeting: MeetingSummary | null) => void;
  setAudioMode: (mode: AudioMode) => void;
  setAiScenario: (scenario: AIScenario) => void;
  setOverlayHidden: (hidden: boolean) => void;
  toggleOverlayHidden: () => void;
  setSelectedMeetingId: (id: string | null) => void;

  // Async flows
  startMeetingFlow: (title?: string, audioMode?: AudioMode, scenario?: AIScenario) => Promise<void>;
  endMeetingFlow: () => Promise<void>;
  loadRecentMeetings: () => Promise<void>;

  // Timer management
  startTimer: () => void;
  stopTimer: () => void;
}

let startMeetingRun: Promise<void> | undefined;
let endMeetingRun: Promise<void> | undefined;
let meetingWindowAttached = false;

export function attachMeetingWindow(): () => void {
  meetingWindowAttached = true;
  return () => { meetingWindowAttached = false; };
}

function currentWindowLabel(): string {
  try { return getCurrentWebviewWindow().label; } catch { return ""; }
}

function waitForMeetingListeners(meetingId: string): Promise<boolean> {
  if (!meetingWindowAttached || useMeetingStore.getState().meetingListenersReadyId === meetingId) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const unsubscribe = useMeetingStore.subscribe((state) => {
      if (state.meetingListenersReadyId !== meetingId) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(true);
    });
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(false);
    }, WINDOW_READY_TIMEOUT_MS);
  });
}

export const useMeetingStore = create<MeetingState>((set, get) => ({
  currentView: "launcher",
  previousView: null,
  settingsOpen: false,
  settingsTab: null,
  activeMeeting: null,
  isRecording: false,
  isEndingMeeting: false,
  meetingStartTime: null,
  elapsedMs: 0,
  recentMeetings: [],
  lastPersistedIndex: 0,
  unfinishedMeeting: null,
  _timerInterval: null,
  audioMode: "online",
  aiScenario: "team_meeting",
  overlayHidden: false,
  overlayMeetingId: null,
  meetingListenersReadyId: null,
  selectedMeetingId: null,

  setOverlayMeetingId: (id) => {
    if (id === null || get().activeMeeting?.id === id) set({ overlayMeetingId: id });
  },
  setMeetingListenersReady: (id) => {
    if (get().activeMeeting?.id === id) set({ meetingListenersReadyId: id });
  },
  clearEndedMeeting: (id) => {
    if (get().activeMeeting?.id !== id) return false;
    get().stopTimer();
    useCallLogStore.getState().clearAll();
    useCallLogStore.getState().setOpen(false);
    useStreamStore.getState().resetForMeeting();
    set({
      activeMeeting: null,
      isRecording: false,
      isEndingMeeting: false,
      meetingStartTime: null,
      elapsedMs: 0,
      lastPersistedIndex: 0,
      audioMode: "online",
      aiScenario: "team_meeting",
      overlayMeetingId: null,
      meetingListenersReadyId: null,
      overlayHidden: false,
      currentView: "launcher",
      previousView: null,
      settingsOpen: false,
    });
    return true;
  },

  setCurrentView: (view) => {
    const current = get().currentView;
    // When navigating to settings, remember where we came from
    // Guard: don't overwrite previousView if we're already on settings
    if (view === "settings" && current !== "settings") {
      set({ currentView: view, previousView: current });
    } else if (view === "settings" && current === "settings") {
      // Already on settings — don't overwrite previousView
    } else {
      set({ currentView: view, previousView: null });
    }
  },
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  openSettings: (tab) => {
    set({ settingsTab: tab ?? null });
    if (get().currentView === "overlay") set({ settingsOpen: true });
    else get().setCurrentView("settings");
  },
  setActiveMeeting: (meeting) => set({ activeMeeting: meeting }),
  setIsRecording: (recording) => set({ isRecording: recording }),
  setMeetingStartTime: (time) => set({ meetingStartTime: time }),
  setElapsedMs: (ms) => set({ elapsedMs: ms }),
  setRecentMeetings: (meetings) => set({ recentMeetings: meetings }),
  setLastPersistedIndex: (index) => set({ lastPersistedIndex: index }),
  setUnfinishedMeeting: (meeting) => set({ unfinishedMeeting: meeting }),
  setAudioMode: (mode) => set({ audioMode: mode }),
  setAiScenario: (scenario) => set({ aiScenario: scenario }),
  setOverlayHidden: (hidden) => set({ overlayHidden: hidden }),
  toggleOverlayHidden: () => {
    const next = !useMeetingStore.getState().overlayHidden;
    set({ overlayHidden: next });
  },
  setSelectedMeetingId: (id) => set({ selectedMeetingId: id }),

  startMeetingFlow: (title, audioMode, scenario) => {
    if (startMeetingRun) return startMeetingRun;
    if (get().activeMeeting || currentWindowLabel() === "overlay") return Promise.resolve();
    const run = (async () => {
      // Resolve mode and scenario (fall back to current state if not provided)
      const resolvedMode: AudioMode = audioMode ?? get().audioMode;
      let resolvedScenario: AIScenario = scenario ?? get().aiScenario;

      // 0. Set active scenario in scenarioStore + push prompts to Rust backend.
      // Before start_meeting: a Claude CLI live session starts there with the
      // scenario prompt as its system prompt.
      try {
        const { useScenarioStore } = await import("./scenarioStore");
        const scenarios = useScenarioStore.getState();
        // A custom scenario can come from another window's list, or be gone by now.
        await scenarios.loadScenarioConfig();
        resolvedScenario = scenarios.resolveScenario(resolvedScenario);
        scenarios.setActiveScenario(resolvedScenario);

        // Push scenario prompts to Rust backend for scenario-aware intelligence
        const template = useScenarioStore.getState().getActiveTemplate();
        const { setActiveScenario } = await import("../lib/ipc");
        await setActiveScenario(
          template.system_prompt,
          template.summary_prompt,
          template.question_detection_prompt
        );
      } catch { /* non-critical */ }

      // 0b. Flush ALL meeting-scoped state up-front, before the speaker store is
      // initialized below, so nothing from the previous meeting leaks in.
      // The overlay window does the same when it receives nexq:meeting_started.
      try {
        await resetMeetingScopedStores();
      } catch (e) {
        console.warn("[meetingStore] Failed to reset meeting-scoped stores:", e);
      }

      // 1. Create meeting record in SQLite
      const meeting = await ipcStartMeeting(title);

      // 1b. Store mode/scenario in state and persist to DB
      set({ audioMode: resolvedMode, aiScenario: resolvedScenario });
      try {
        const { updateMeetingMode } = await import("../lib/ipc");
        await updateMeetingMode(meeting.id, resolvedMode, resolvedScenario);
      } catch { /* non-critical */ }

      // 1c. Initialize speaker store for the resolved mode
      try {
        const hasSpeakers = initMeetingSpeakers(resolvedMode);
        // Inform user if local STT won't support speaker separation
        if (resolvedMode !== "online" && !hasSpeakers) {
          showToast(t("onboarding:meetingFlow.noSpeakerSeparation"), "info");
        }
      } catch { /* non-critical */ }

      // Set both sides before opening the microphone or a direct STT session.
      const config = useConfigStore.getState();
      const { setRecordingEnabled, setSourceMuted } = await import("../lib/ipc");
      const initializeMute = async () => {
        await Promise.all([setSourceMuted("you", false, meeting.id), setSourceMuted("them", false, meeting.id)]);
        if (resolvedMode === "in_person") await setSourceMuted("you", true, meeting.id);
        useConfigStore.setState({ mutedYou: resolvedMode === "in_person", mutedThem: false });
      };
      await Promise.all([
        setRecordingEnabled(config.recordingEnabled, meeting.id).catch((error) => {
          console.warn("[meetingStore] Could not initialize recording:", error);
        }),
        initializeMute().catch((error) => console.warn("[meetingStore] Could not initialize mute settings:", error)),
      ]);

      const parsedStartTime = Date.parse(meeting.start_time);
      const startedAt = Number.isFinite(parsedStartTime) ? parsedStartTime : Date.now();
      (await import("../lib/transcriptPersistence")).resetSavedSegments();
      set({
        activeMeeting: meeting,
        isRecording: false,
        isEndingMeeting: false,
        meetingStartTime: startedAt,
        elapsedMs: 0,
        lastPersistedIndex: 0,
        meetingListenersReadyId: null,
        overlayMeetingId: null,
        overlayHidden: false,
        selectedMeetingId: null,
        unfinishedMeeting: null,
        settingsOpen: false,
      });
      get().startTimer();

      const localReady = waitForMeetingListeners(meeting.id);
      const overlayReady = startOverlayMeeting({ meeting, audioMode: resolvedMode, aiScenario: resolvedScenario }, meetingWindowAttached)
        .catch((error) => {
          console.warn("[meetingStore] Could not prepare the meeting overlay:", error);
          return false;
        });

      try {
        const [launcherListening, overlayHasMeeting] = await Promise.all([localReady, overlayReady]);
        if (overlayHasMeeting) get().setOverlayMeetingId(meeting.id);
        if (!launcherListening) {
          void emit("capture_warning", t("onboarding:meetingFlow.listenersUnavailable")).catch(() => {});
        }
        if (get().isEndingMeeting) return;
        set({ currentView: "overlay" });

        // The first native status/transcript events can arrive before IPC returns.
        if (config.meetingAudioConfig) {
          const parties = captureParties(config.meetingAudioConfig.you, config.meetingAudioConfig.them, resolvedMode);
          await startCapturePerParty(parties.you, parties.them, {
            skipYouStt: skipYouStt(resolvedMode),
            expectedMeetingId: meeting.id,
          });
        } else {
          await startCapture(config.micDeviceId || "default", config.systemDeviceId || "default", meeting.id);
        }
      } catch (error) {
        console.warn("[meetingStore] Audio capture failed to start:", error);
        const detail = error instanceof Error ? error.message : String(error);
        void emit("capture_warning", t("onboarding:meetingFlow.captureFailed", { detail })).catch(() => {});
      }
      set({ isRecording: true });
    })();
    startMeetingRun = run;
    void run.finally(() => { startMeetingRun = undefined; }).catch(() => {});
    return run;
  },

  endMeetingFlow: () => {
    if (endMeetingRun) return endMeetingRun;
    const meeting = get().activeMeeting;
    if (!meeting) return Promise.resolve();

    const windowLabel = currentWindowLabel();
    const run = (async () => {
      set({ isEndingMeeting: true });
      if (windowLabel === "overlay") {
        await endMeetingInLauncher(meeting.id);
        return;
      }

      try {
        await startMeetingRun;
        const { stopWebSpeechRecognition } = await import("../lib/webSpeechLifecycle");
        const [nativeStop, browserStop] = await Promise.allSettled([
          stopCapture(false, meeting.id),
          stopWebSpeechRecognition(),
        ]);
        if (nativeStop.status === "rejected") throw nativeStop.reason;
        if (browserStop.status === "rejected") throw browserStop.reason;

        let speakerAliases = new Map<string, string>();
        if (meetingWindowAttached && get().overlayMeetingId === meeting.id) {
          speakerAliases = await saveMeetingInOverlay(meeting.id);
        } else {
          speakerAliases = new Map(await persistOverlayMeetingData(meeting.id));
        }

        const segments = useTranscriptStore.getState().segments.map((segment) => {
          const speaker = speakerAliases.get(segment.speaker_id ?? "");
          return speaker ? { ...segment, speaker_id: speaker } : segment;
        });
        const { flushMeetingTranscript } = await import("../lib/transcriptPersistence");
        await flushMeetingTranscript(
          meeting.id,
          segments,
          get().lastPersistedIndex,
          { all: true },
        );

        const { cancelGeneration } = await import("../lib/ipc");
        await cancelGeneration().catch(() => {});
        const { flushMeetingAiHistory } = await import("../hooks/useCallLogCapture");
        await flushMeetingAiHistory(meeting.id);
        await ipcEndMeeting(meeting.id);

        get().clearEndedMeeting(meeting.id);
        const payload: WindowMeetingEndedEvent = { meetingId: meeting.id, window: windowLabel || "launcher" };
        await emit(MEETING_ENDED, payload).catch((error) => {
          console.warn("[meetingStore] Could not notify the other window:", error);
        });
        await get().loadRecentMeetings();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await emit(MEETING_END_FAILED, { meetingId: meeting.id, message }).catch(() => {});
        throw error;
      }
    })();
    endMeetingRun = run;
    void run.finally(() => {
      endMeetingRun = undefined;
      if (get().activeMeeting?.id === meeting.id) set({ isEndingMeeting: false });
    }).catch(() => {});
    return run;
  },

  loadRecentMeetings: async () => {
    try {
      const meetings = await ipcListMeetings(50, 0);
      set({ recentMeetings: meetings });
    } catch (err) {
      console.error("[meetingStore] Failed to load meetings:", err);
    }
  },

  startTimer: () => {
    const state = get();
    // Clear existing interval if any
    if (state._timerInterval) {
      clearInterval(state._timerInterval);
    }

    const startTime = state.meetingStartTime ?? Date.now();
    const meetingId = state.activeMeeting?.id;
    const interval = setInterval(() => {
      if (get().activeMeeting?.id === meetingId) set({ elapsedMs: Math.max(0, Date.now() - startTime) });
    }, 1000);

    set({ _timerInterval: interval });
  },

  stopTimer: () => {
    const state = get();
    if (state._timerInterval) {
      clearInterval(state._timerInterval);
      set({ _timerInterval: null });
    }
  },
}));

/** Saves the data owned by the meeting view and returns its speaker merges. */
export async function persistOverlayMeetingData(meetingId: string): Promise<[string, string][]> {
  const [
    { useSpeakerStore }, { useBookmarkStore }, { useActionItemStore }, { useTopicSectionStore }, ipc,
  ] = await Promise.all([
    import("./speakerStore"), import("./bookmarkStore"), import("./actionItemStore"), import("./topicSectionStore"), import("../lib/ipc"),
  ]);
  if (useMeetingStore.getState().activeMeeting?.id !== meetingId) return [];
  const speakerState = useSpeakerStore.getState();
  const speakerAliases = [...speakerState.speakerAliases];
  const speakers = [...speakerState.getAllSpeakers(), ...speakerState.getRemoteSpeakers()].map((speaker) => ({
    id: crypto.randomUUID(),
    meeting_id: meetingId,
    speaker_id: speaker.id,
    display_name: speaker.display_name,
    source: speaker.source,
    color: speaker.color ?? null,
    segment_count: speaker.stats.segment_count,
    word_count: speaker.stats.word_count,
    talk_time_ms: speaker.stats.talk_time_ms,
  }));
  const bookmarks = useBookmarkStore.getState().bookmarks.map((record) => ({ ...record, meeting_id: meetingId }));
  const items = useActionItemStore.getState().items.map((record) => ({ ...record, meeting_id: meetingId }));
  const sections = useTopicSectionStore.getState().sections.map((record) => ({ ...record, meeting_id: meetingId }));
  const saved = await Promise.allSettled([
    speakers.length && ipc.saveMeetingSpeakers(meetingId, JSON.stringify(speakers)),
    bookmarks.length && ipc.saveMeetingBookmarks(meetingId, JSON.stringify(bookmarks)),
    items.length && ipc.saveMeetingActionItems(meetingId, JSON.stringify(items)),
    sections.length && ipc.saveMeetingTopicSections(meetingId, JSON.stringify(sections)),
  ]);
  const failed = saved.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  return speakerAliases;
}

/**
 * Meeting id that routes a meeting-view AI request (summary, action items,
 * bookmark suggestions) to that past meeting's Claude session. Undefined for
 * the running meeting, which uses the live session.
 */
export function pastMeetingIdFor(meeting: { id: string } | null): string | undefined {
  if (!meeting) return undefined;
  return useMeetingStore.getState().activeMeeting?.id === meeting.id ? undefined : meeting.id;
}
