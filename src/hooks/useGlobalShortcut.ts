import { useEffect } from "react";
import {
  register,
  unregister,
} from "@tauri-apps/plugin-global-shortcut";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emit } from "@tauri-apps/api/event";
import { useMeetingStore } from "../stores/meetingStore";
import { useAIActionsStore } from "../stores/aiActionsStore";
import { isQuitPending } from "../lib/ipc";
import { runYourAction } from "../lib/autoAnswer";
import { isOverlayVisible, meetingShortcutAction, showLauncherWindow, showMeetingOverlay, switchShortcutTarget, TOGGLE_OVERLAY_SETTINGS_EVENT, toggleWindowSettings } from "../lib/windows";
import { endMeetingFromThisWindow } from "./useUpdater";
import { showToast } from "../stores/toastStore";
import { useConfigStore } from "../stores/configStore";
import { formatShortcut, normalizeAccelerator, reservedShortcutAction, screenCaptureSupported } from "../lib/shortcutLabel";
import { providerReadsImages } from "../lib/imageAttachments";
import { captureScreenIntoAsk } from "../lib/screenCapture";
import { t } from "../i18n";

/** Ctrl+M: end the running meeting (in every window that holds it) or start one. */
async function toggleMeetingFromShortcut(): Promise<void> {
  const store = useMeetingStore.getState();
  const quitPending = store.activeMeeting ? false : await isQuitPending().catch(() => false);
  switch (meetingShortcutAction(!!store.activeMeeting, quitPending)) {
    case "end":
      if (!(await endMeetingFromThisWindow())) {
        showToast(t("misc:shortcuts.meetingNotSaved"), "error");
      }
      break;
    case "start":
      await store.startMeetingFlow();
      break;
    case "ignore":
      break;
  }
}

/** Stealth shortcut: hide NexQ from screen sharing, or show it again. */
export async function toggleStealthMode(): Promise<void> {
  const config = useConfigStore.getState();
  const enabled = !config.stealthMode;
  try {
    await config.setStealthMode(enabled);
    showToast(enabled ? t("misc:shortcuts.stealth.hidden") : t("misc:shortcuts.stealth.visible"), "info");
  } catch (e) {
    showToast(t("misc:shortcuts.stealth.failed", { detail: e instanceof Error ? e.message : String(e) }), "error");
  }
}

function reportShortcutFailure(key: string) {
  showToast(t("misc:shortcuts.registrationFailed", { shortcut: formatShortcut(key) }), "warning");
}

/** Keys whose registration failure was already announced (once is enough). */
const announcedCaptureKeys = new Set<string>();

function announceCaptureShortcutFailure(key: string): void {
  if (announcedCaptureKeys.has(key)) return;
  announcedCaptureKeys.add(key);
  showToast(t("misc:shortcuts.captureRegistrationFailed", { shortcut: formatShortcut(key) }), "warning");
}

const shortcutWrites = new Map<string, Promise<void>>();

function changeShortcut(key: string, change: () => Promise<void>): void {
  const accelerator = normalizeAccelerator(key);
  const previous = shortcutWrites.get(accelerator) ?? Promise.resolve();
  const operation = previous.then(change).catch((error) => {
    console.warn(`[Shortcuts] Could not update ${key}:`, error);
  });
  shortcutWrites.set(accelerator, operation);
  void operation.then(() => {
    if (shortcutWrites.get(accelerator) === operation) shortcutWrites.delete(accelerator);
  });
}

function registerShortcut(key: string, pressed: () => void, report = reportShortcutFailure): () => void {
  let released = false;
  let registered = false;
  changeShortcut(key, async () => {
    if (released) return;
    try {
      await register(key, (event) => {
        if (!released && event.state === "Pressed") pressed();
      });
      registered = true;
    } catch (error) {
      if (!released) {
        console.warn(`[Shortcuts] Could not register ${key}:`, error);
        report(key);
      }
    }
  });
  return () => {
    released = true;
    changeShortcut(key, async () => {
      if (registered) await unregister(key);
    });
  };
}

export function useGlobalShortcut() {
  const stealthShortcut = useConfigStore((s) => s.stealthShortcut);
  const assistShortcut = useConfigStore((s) => s.assistShortcut);
  const captureShortcut = useConfigStore((s) => s.captureShortcut);
  const canReadImages = useConfigStore((s) => providerReadsImages(s.llmProvider));
  const meetingActive = useMeetingStore((s) => !!s.activeMeeting);
  let windowLabel = "";
  try { windowLabel = getCurrentWebviewWindow().label; } catch { /* browser preview */ }

  // Assist from any app (Space only works while the overlay has focus). Held
  // only during a meeting, by the overlay window, so the key combination
  // stays free for other apps the rest of the time.
  useEffect(() => {
    const key = assistShortcut;
    if (!meetingActive || !key || windowLabel !== "overlay") return;
    if (reservedShortcutAction(key) || normalizeAccelerator(key) === normalizeAccelerator(stealthShortcut)) {
      console.warn(`[useGlobalShortcut] Assist shortcut ${key} collides with another shortcut; not registered`);
      return;
    }
    return registerShortcut(key, () => {
      const visible = useAIActionsStore.getState().configs.actions.Assist?.visible !== false;
      if (visible) void runYourAction("Assist").catch(() => {});
    });
  }, [assistShortcut, stealthShortcut, meetingActive, windowLabel]);

  // Capture the screen under the mouse into the Ask box. Held only during a
  // meeting, by the overlay window, and only while the chosen AI can read
  // images, so the key combination stays free for other apps otherwise.
  // Assist and Hide from screen share win a collision.
  useEffect(() => {
    const key = captureShortcut;
    if (!screenCaptureSupported() || !meetingActive || !canReadImages || !key) return;
    if (windowLabel !== "overlay") return;
    const wanted = normalizeAccelerator(key);
    if (
      reservedShortcutAction(key) ||
      wanted === normalizeAccelerator(stealthShortcut) ||
      wanted === normalizeAccelerator(assistShortcut)
    ) {
      console.warn(`[useGlobalShortcut] Capture shortcut ${key} collides with another shortcut; not registered`);
      return;
    }
    return registerShortcut(key, () => { void captureScreenIntoAsk().catch(() => {}); }, announceCaptureShortcutFailure);
  }, [captureShortcut, assistShortcut, stealthShortcut, meetingActive, canReadImages, windowLabel]);

  // Stealth mode shortcut (user-configurable, re-registered when it changes)
  useEffect(() => {
    if (windowLabel !== "launcher") return;
    const key = stealthShortcut;
    // Never take over a built-in shortcut (e.g. a binding saved before it was
    // reserved): registering it would unregister that action's handler.
    if (!key || reservedShortcutAction(key)) {
      if (key) console.warn(`[useGlobalShortcut] Stealth shortcut ${key} collides with a built-in shortcut; not registered`);
      return;
    }
    return registerShortcut(key, () => { void toggleStealthMode().catch(() => {}); });
  }, [stealthShortcut, windowLabel]);

  // Global shortcuts (work even when window is not focused)
  useEffect(() => {
    if (windowLabel !== "launcher") return;
    const remove = [
      registerShortcut("CmdOrCtrl+M", () => { void toggleMeetingFromShortcut().catch(() => {}); }),
      registerShortcut("CmdOrCtrl+B", () => {
        void (async () => {
          const target = switchShortcutTarget(await isOverlayVisible(), !!useMeetingStore.getState().activeMeeting);
          if (target === "launcher") await showLauncherWindow();
          else await showMeetingOverlay();
        })().catch(() => {});
      }),
      registerShortcut("CmdOrCtrl+,", () => {
        void (async () => {
          if (await isOverlayVisible()) {
            await emit(TOGGLE_OVERLAY_SETTINGS_EVENT);
          } else {
            toggleWindowSettings();
            await showLauncherWindow();
          }
        })().catch(() => {});
      }),
    ];
    return () => remove.forEach((release) => release());
  }, [windowLabel]);

  // Window-level shortcuts (work when window is active/focused)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const store = useMeetingStore.getState();
      if (!store.activeMeeting) return;

      if (e.defaultPrevented || e.isComposing || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target;
      if (target instanceof Element && target.closest(
        "input, textarea, select, button, a[href], [contenteditable]:not([contenteditable='false']), [role='button'], [role='textbox']",
      )) return;

      // Check action visibility from the AI actions store
      const actions = useAIActionsStore.getState().configs.actions;
      const isVisible = (mode: string) => actions[mode]?.visible !== false;

      switch (e.code) {
        case "Space":
          if (isVisible("Assist")) {
            e.preventDefault();
            runYourAction("Assist").catch(() => {});
          }
          break;
        case "Numpad1":
        case "Digit1":
          if (isVisible("WhatToSay")) {
            e.preventDefault();
            runYourAction("WhatToSay").catch(() => {});
          }
          break;
        case "Numpad2":
        case "Digit2":
          if (isVisible("Shorten")) {
            e.preventDefault();
            runYourAction("Shorten").catch(() => {});
          }
          break;
        case "Numpad3":
        case "Digit3":
          if (isVisible("FollowUp")) {
            e.preventDefault();
            runYourAction("FollowUp").catch(() => {});
          }
          break;
        case "Numpad4":
        case "Digit4":
          if (isVisible("Recap")) {
            e.preventDefault();
            runYourAction("Recap").catch(() => {});
          }
          break;
        case "Numpad5":
        case "Digit5":
          if (isVisible("AskQuestion")) {
            e.preventDefault();
            // Open/focus the Ask input instead of triggering generation directly
            window.dispatchEvent(new Event("nexq:toggle-ask-input"));
          }
          break;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
