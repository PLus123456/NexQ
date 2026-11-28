// Discord-style updates: a single owner (the launcher window) checks 10 s after
// launch and every 4 h, downloads silently when automatic updates are on, and
// the footer pill opens the "what's new" dialog that installs it. Rust installs
// a downloaded update on quit (see updater_commands::on_exit_requested).
//
// The checks continue after a download, and opening the dialog checks again, so
// a newer release replaces the waiting one and people land on the latest version
// in one step instead of going through each release.
//
// The action functions below work from any window (Settings -> About can open
// in the overlay); only the check loop is launcher-only. Preference changes are
// broadcast so every window's store stays in sync.
//
// NexQ Plus: with UPDATER_ENABLED off (brand.ts) useUpdater() does nothing, so
// the app never contacts an update server on its own; About shows a notice
// instead of the update controls.

import { useEffect } from "react";
import { load } from "@tauri-apps/plugin-store";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useUpdaterStore } from "../stores/updaterStore";
import { useMeetingStore } from "../stores/meetingStore";
import { showToast } from "../stores/toastStore";
import { RELEASES_URL, UPDATER_ENABLED } from "../lib/brand";
import { t } from "../i18n";
import { endMeetingInLauncher, MEETING_END_TIMEOUT_MS } from "../lib/meetingWindowEvents";
import { compareVersions } from "../lib/changelog";
import {
  checkForUpdate,
  downloadUpdate,
  getPendingUpdate,
  installUpdateNow,
} from "../lib/ipc";
import {
  emitUpdaterPrefsChanged,
  onUpdateDownloadFailed,
  onUpdateDownloadProgress,
  onUpdateDownloadStarted,
  onUpdateDownloaded,
  onUpdaterPrefsChanged,
} from "../lib/events";

// Same keys are read by Rust at quit time — keep in sync with updater_commands.rs.
const STORE_NAME = "nexq-settings.json";
const SKIPPED_VERSION_KEY = "skipped_version";
const AUTO_UPDATE_KEY = "auto_update";

const STARTUP_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

export { MEETING_END_TIMEOUT_MS };

/** Never hold up an install for longer than this waiting on GitHub. */
export const UPDATE_CHECK_LIMIT_MS = 8_000;
const DOWNLOAD_ALREADY_IN_PROGRESS = "An update download is already in progress";

export { RELEASES_URL };

export function releaseNotesUrl(version: string): string {
  return `${RELEASES_URL}/tag/plus-v${version}`;
}

function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return t("common:errors.unknown");
}

function settingsStore() {
  return load(STORE_NAME, { autoSave: true, defaults: {} });
}

async function persist(key: string, value: unknown): Promise<void> {
  try {
    const store = await settingsStore();
    if (value === undefined) await store.delete(key);
    else await store.set(key, value);
  } catch (err) {
    console.warn(`[updater] Failed to persist ${key}:`, err);
  }
}

async function broadcastPrefs(): Promise<void> {
  const { autoUpdate, skippedVersion } = useUpdaterStore.getState();
  try {
    await emitUpdaterPrefsChanged({ autoUpdate, skippedVersion: skippedVersion ?? null });
  } catch (err) {
    console.warn("[updater] Failed to broadcast preferences:", err);
  }
}

/** Load persisted preferences and any update already downloaded by Rust. */
export async function hydrateUpdater(): Promise<void> {
  const updater = useUpdaterStore.getState();
  try {
    const store = await settingsStore();
    const skipped = await store.get<string>(SKIPPED_VERSION_KEY);
    const auto = await store.get<boolean>(AUTO_UPDATE_KEY);
    updater.setSkippedVersion(skipped ?? undefined);
    if (typeof auto === "boolean") updater.setAutoUpdate(auto);
  } catch (err) {
    console.warn("[updater] Failed to load preferences:", err);
  }

  try {
    const pending = await getPendingUpdate();
    // setReady ignores a skipped version
    const { phase, version } = useUpdaterStore.getState();
    if (pending && phase !== "downloading" && (!version || compareVersions(pending.version, version) >= 0)) {
      updater.setReady(pending.version, pending.body);
    }
  } catch (err) {
    console.warn("[updater] Failed to read pending update:", err);
  }
}

/**
 * Check for an update; download it when automatic updates are on.
 * Automatic checks ignore a skipped version, manual checks don't (and a
 * download after a manual check counts as explicit).
 */
export async function checkForUpdates(opts?: { manual?: boolean }): Promise<void> {
  const { phase, startCheck } = useUpdaterStore.getState();
  if (phase === "checking" || phase === "downloading") return;
  if (phase === "ready") {
    await refreshReadyUpdate();
    return;
  }

  startCheck();
  let update;
  try {
    const found = await checkForUpdate();
    const updater = useUpdaterStore.getState();
    if (updater.phase !== "checking") return;
    update = updater.finishCheck(found, opts);
  } catch (err) {
    const updater = useUpdaterStore.getState();
    if (updater.phase === "checking") updater.failCheck(errorMessage(err));
    return;
  }

  if (update && useUpdaterStore.getState().autoUpdate) {
    await downloadUpdateNow({ explicit: opts?.manual });
  }
}

function withinLimit<T>(work: Promise<T>, limitMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Timed out")), limitMs);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/**
 * With an update already downloaded, look for a newer one and swap it in. The
 * waiting update stays ready throughout and is kept if anything goes wrong.
 * `explicit` means the user is about to install, which counts even with
 * automatic updates off. A skipped version is never fetched.
 */
export async function refreshReadyUpdate(opts?: { explicit?: boolean }): Promise<void> {
  const { phase, refresh, setRefresh } = useUpdaterStore.getState();
  if (phase !== "ready" || refresh !== "idle") return;

  setRefresh("checking");
  let requestedDownload = false;
  let joinedDownload = false;
  try {
    const found = await withinLimit(checkForUpdate(), UPDATE_CHECK_LIMIT_MS);
    const { refresh, version, skippedVersion, autoUpdate } = useUpdaterStore.getState();
    if (refresh !== "checking") return;
    if (!found || !version || compareVersions(found.version, version) <= 0) return;
    if (found.version === skippedVersion) return;
    if (!autoUpdate && !opts?.explicit) return;

    setRefresh("downloading", found.version);
    requestedDownload = true;
    const info = await downloadUpdate();
    useUpdaterStore.getState().setReady(info.version, info.body);
  } catch (err) {
    joinedDownload = errorMessage(err) === DOWNLOAD_ALREADY_IN_PROGRESS;
    if (!joinedDownload) console.warn("[updater] Keeping the downloaded update:", err);
  } finally {
    if (!joinedDownload && (requestedDownload || useUpdaterStore.getState().refresh === "checking")) {
      setRefresh("idle");
    }
  }
}

/** Show what's in the update, and make sure it's the newest one. */
export function openUpdateDialog(): void {
  useUpdaterStore.getState().setDialogOpen(true);
  void refreshReadyUpdate({ explicit: true });
}

/**
 * Download the available update in the background (no install). An explicit
 * download of a skipped version clears the skip, so Rust's install-on-quit
 * agrees with what the user chose.
 */
export async function downloadUpdateNow(opts?: { explicit?: boolean }): Promise<void> {
  const { phase, version, skippedVersion, startDownload } = useUpdaterStore.getState();
  if (phase === "downloading" || phase === "ready") return;

  if (opts?.explicit && version && version === skippedVersion) {
    useUpdaterStore.getState().setSkippedVersion(undefined);
    await persist(SKIPPED_VERSION_KEY, undefined);
    await broadcastPrefs();
  }

  startDownload();
  try {
    const info = await downloadUpdate();
    useUpdaterStore.getState().setReady(info.version, info.body, opts);
  } catch (err) {
    const message = errorMessage(err);
    if (message !== DOWNLOAD_ALREADY_IN_PROGRESS) useUpdaterStore.getState().failDownload(message);
  }
}

/** Wait for the launcher's acknowledgement after both windows have saved. */
export async function endMeetingInAllWindows(timeoutMs = MEETING_END_TIMEOUT_MS): Promise<boolean> {
  const meetingId = useMeetingStore.getState().activeMeeting?.id;
  if (!meetingId) return true;
  try {
    await endMeetingInLauncher(meetingId, timeoutMs);
    return true;
  } catch (error) {
    console.error("[updater] Failed to end the meeting:", error);
    return false;
  }
}

export async function endMeetingFromThisWindow(): Promise<boolean> {
  const state = useMeetingStore.getState();
  if (!state.activeMeeting) return true;
  try {
    await state.endMeetingFlow();
    return true;
  } catch (error) {
    console.error("[updater] Failed to end the meeting:", error);
    return false;
  }
}

/**
 * Install the downloaded update now; NexQ exits and relaunches on the new
 * version. If a meeting is running, confirm first and end it in every window
 * before installing. Never installs if the meeting didn't end cleanly.
 */
export async function restartToUpdate(): Promise<void> {
  if (useMeetingStore.getState().activeMeeting) {
    const { confirm } = await import("@tauri-apps/plugin-dialog");
    const ok = await confirm(t("settings:updates.restartDialog.message"), {
      title: t("settings:updates.restartDialog.title"),
      kind: "warning",
      okLabel: t("settings:updates.restartDialog.confirm"),
      cancelLabel: t("common:actions.cancel"),
    });
    if (!ok) return;

    if (!(await endMeetingInAllWindows())) {
      showToast(t("settings:updates.errors.meetingNotSaved"), "error");
      return;
    }
  }

  try {
    await installUpdateNow();
  } catch (err) {
    showToast(t("settings:updates.errors.notInstalled", { detail: errorMessage(err) }), "error");
  }
}

export async function setAutoUpdate(enabled: boolean): Promise<void> {
  useUpdaterStore.getState().setAutoUpdate(enabled);
  await persist(AUTO_UPDATE_KEY, enabled);
  await broadcastPrefs();
}

/**
 * Skip a version: automatic checks stop offering it, it never becomes ready on
 * its own, and Rust won't install it on quit. A manual check still finds it.
 */
export async function skipVersion(version: string): Promise<void> {
  useUpdaterStore.getState().skip(version);
  await persist(SKIPPED_VERSION_KEY, version);
  await broadcastPrefs();
}

/**
 * Both app windows listen for downloads. The launcher schedules update checks.
 */
export function useUpdater(): void {
  useEffect(() => {
    // No startup check, no 4-hour interval, no hydration, no listeners.
    if (!UPDATER_ENABLED) return;

    let label = "";
    try {
      label = getCurrentWebviewWindow().label;
    } catch {
      label = "";
    }
    const isLauncher = label === "launcher";
    if (!isLauncher && label !== "overlay") return;

    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    const keep = (fn: UnlistenFn) => {
      if (disposed) fn();
      else unlisteners.push(fn);
    };

    // Every window: keep preferences in sync (About can open in either window).
    onUpdaterPrefsChanged((prefs) => {
      const updater = useUpdaterStore.getState();
      updater.setAutoUpdate(prefs.autoUpdate);
      if (prefs.skippedVersion) updater.skip(prefs.skippedVersion);
      else updater.setSkippedVersion(undefined);
    }).then(keep);

    onUpdateDownloadStarted((info) => {
      const updater = useUpdaterStore.getState();
      if (updater.phase === "ready") updater.setRefresh("downloading", info.version);
      else updater.startDownload(info);
    }).then(keep);

    onUpdateDownloadProgress((e) => {
      useUpdaterStore.getState().addProgress(e.chunk_length, e.content_length);
    }).then(keep);

    // Downloads may be started from any window (e.g. About in the overlay).
    onUpdateDownloaded((info) => {
      const updater = useUpdaterStore.getState();
      updater.setReady(info.version, info.body);
      updater.setRefresh("idle");
    }).then(keep);

    onUpdateDownloadFailed((e) => {
      const updater = useUpdaterStore.getState();
      if (updater.phase === "downloading") updater.failDownload(e.message);
      updater.setRefresh("idle");
    }).then(keep);

    void hydrateUpdater();
    const startupTimer = isLauncher ? setTimeout(() => checkForUpdates(), STARTUP_DELAY_MS) : undefined;
    const intervalId = isLauncher ? setInterval(() => checkForUpdates(), CHECK_INTERVAL_MS) : undefined;

    return () => {
      disposed = true;
      unlisteners.forEach((fn) => fn());
      clearTimeout(startupTimer);
      clearInterval(intervalId);
    };
  }, []);
}
