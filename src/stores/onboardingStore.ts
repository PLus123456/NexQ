// First-run setup progress: the current step and each step's state, saved to
// config.json (`onboardingProgress`) on every change so setup continues where
// it was left. Every window follows changes another window makes (the store's
// onKeyChange). It also mirrors `firstRunCompleted` into this window's config
// store, so setup started again from another window shows without a restart.

import { create } from "zustand";
import { load, type Store } from "@tauri-apps/plugin-store";
import type { QuickSetupStatus } from "../settings/quickSetup";
import { UNTESTED_AUDIO_CHECKS, type AudioChecks } from "../lib/onboarding/audioChecks";
import {
  ONBOARDING_STEPS,
  PROGRESS_KEY,
  back,
  complete,
  freshProgress,
  goTo,
  next,
  normalizeProgress,
  report,
  resume,
  skip,
  skipToFinish,
  type OnboardingProgress,
  type OnboardingStepId,
} from "../lib/onboarding/progress";
import { useConfigStore } from "./configStore";
import { useMeetingStore } from "./meetingStore";

const STORE_FILE = "config.json";
const FIRST_RUN_KEY = "firstRunCompleted";

interface OnboardingState {
  progress: OnboardingProgress;
  /** The saved progress has been read (the wizard waits for it). */
  loaded: boolean;
  /** Setup reopened at this step (a run left unfinished earlier), until the user moves on. */
  resumedAt: OnboardingStepId | null;
  /** The audio step's test results in this session (not saved: devices change between runs). */
  audioChecks: AudioChecks;

  next: () => void;
  back: () => void;
  skip: () => void;
  skipToFinish: () => void;
  goTo: (step: OnboardingStepId) => void;
  /** A step's own report (QuickSetupProps.onStatusChange). */
  report: (step: OnboardingStepId, status: QuickSetupStatus, detail?: string) => void;
  setAudioChecks: (checks: AudioChecks) => void;
  /** The wizard opened: continue the saved run, or start over after a finished one. */
  begin: () => void;
  /** Setup finished: sets `firstRunCompleted` and leaves the wizard for the launcher. */
  complete: () => void;
  /** Runs setup again from the start, now (Settings → General). */
  restart: () => void;
}

let storePromise: Promise<Store> | null = null;
/** The wizard has opened in this window since the app started. */
let begun = false;

function getStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = load(STORE_FILE, { autoSave: true, defaults: {} });
    storePromise.catch(() => {
      storePromise = null;
    });
  }
  return storePromise;
}

function persist(progress: OnboardingProgress): void {
  getStore()
    .then((store) => store.set(PROGRESS_KEY, progress))
    .catch((err) => console.warn("[onboardingStore] Failed to save the setup progress:", err));
}

/** Stores a transition's result (unchanged progress is not written). */
function apply(change: (progress: OnboardingProgress) => OnboardingProgress): void {
  const current = useOnboardingStore.getState().progress;
  const changed = change(current);
  if (changed === current) return;
  const stamped = { ...changed, rev: current.rev + 1 };
  useOnboardingStore.setState({ progress: stamped });
  persist(stamped);
}

/** A move the user made: also ends the "continued where you left off" notice. */
function navigate(change: (progress: OnboardingProgress) => OnboardingProgress): void {
  apply(change);
  if (useOnboardingStore.getState().resumedAt) useOnboardingStore.setState({ resumedAt: null });
}

/** Back to the launcher when a view other than it was left open (settings, "wizard"). */
function leaveForLauncher(): void {
  const meeting = useMeetingStore.getState();
  if (meeting.settingsOpen) meeting.setSettingsOpen(false);
  if (meeting.currentView === "settings" || meeting.currentView === "wizard") meeting.setCurrentView("launcher");
}

export const useOnboardingStore = create<OnboardingState>((set, get) => ({
  progress: freshProgress(),
  loaded: false,
  resumedAt: null,
  audioChecks: UNTESTED_AUDIO_CHECKS,

  next: () => navigate(next),
  back: () => navigate(back),
  skip: () => navigate(skip),
  skipToFinish: () => navigate(skipToFinish),
  goTo: (step) => navigate((progress) => goTo(progress, step)),
  report: (step, status, detail) => apply((progress) => report(progress, step, status, detail)),
  setAudioChecks: (checks) => set({ audioChecks: checks }),
  begin: () => {
    // A finished run starts over, its audio results included.
    if (get().progress.completedAt != null) set({ audioChecks: UNTESTED_AUDIO_CHECKS });
    apply(resume);
    // Only the first opening continues an earlier run; later ones (back from
    // settings opened during setup) just show the current step.
    if (begun) return;
    begun = true;
    const { current } = get().progress;
    set({ resumedAt: current === ONBOARDING_STEPS[0] ? null : current });
  },
  complete: () => {
    apply((progress) => complete(progress, Date.now()));
    useConfigStore.getState().setFirstRunCompleted(true);
    leaveForLauncher();
  },
  restart: () => {
    apply((progress) => freshProgress(progress.rev));
    set({ audioChecks: UNTESTED_AUDIO_CHECKS });
    leaveForLauncher();
    useConfigStore.getState().setFirstRunCompleted(false);
  },
}));

let initPromise: Promise<void> | null = null;

/** Reads the saved progress and follows other windows' changes. Safe to call more than once. */
export function initOnboarding(): Promise<void> {
  if (!initPromise) initPromise = doInit();
  return initPromise;
}

async function doInit(): Promise<void> {
  try {
    const store = await getStore();
    const saved = normalizeProgress(await store.get(PROGRESS_KEY));
    // A change made while reading (none in practice) is newer than the saved value.
    if (useOnboardingStore.getState().progress.rev === 0) useOnboardingStore.setState({ progress: saved });
    useOnboardingStore.setState({ loaded: true });
    await store.onKeyChange<unknown>(PROGRESS_KEY, (value) => {
      const incoming = normalizeProgress(value);
      // Older values include this window's own writes coming back.
      if (incoming.rev > useOnboardingStore.getState().progress.rev) useOnboardingStore.setState({ progress: incoming });
    });
    await store.onKeyChange<unknown>(FIRST_RUN_KEY, (value) => {
      if (typeof value === "boolean" && useConfigStore.getState().firstRunCompleted !== value) {
        useConfigStore.setState({ firstRunCompleted: value });
      }
    });
  } catch (err) {
    console.warn("[onboardingStore] Failed to load the setup progress:", err);
    useOnboardingStore.setState({ loaded: true });
  }
}

/** Tests: forget the loaded state so the next initOnboarding() reads the store again. */
export function resetOnboardingStoreForTests(): void {
  initPromise = null;
  storePromise = null;
  begun = false;
  useOnboardingStore.setState({ progress: freshProgress(), loaded: false, resumedAt: null, audioChecks: UNTESTED_AUDIO_CHECKS });
}
