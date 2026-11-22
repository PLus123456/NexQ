/**
 * The caption strip's window: show it, hide it and lock it, from any window
 * (the answer window's title bar, the meeting start and end).
 *
 * Nothing here throws: the strip is an extra, so a window that is missing or
 * doesn't answer leaves a warning in the log and the meeting goes on.
 */

/** Label of the caption strip's window (tauri.conf.json). */
export const CAPTIONS_WINDOW_LABEL = "captions";

/**
 * Sent to every window, with `{ visible }`, whenever the caption strip is
 * shown or hidden through this module, so a toggle button anywhere follows it.
 */
export const CAPTIONS_VISIBILITY_EVENT = "nexq:captions_visibility";

async function announce(visible: boolean): Promise<void> {
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit(CAPTIONS_VISIBILITY_EVENT, { visible });
  } catch (err) {
    console.warn("[captions] Could not announce the caption strip's state:", err);
  }
}

/** The caption strip's window; throws when the app has none. */
async function captionsWindow() {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const win = await WebviewWindow.getByLabel(CAPTIONS_WINDOW_LABEL);
  if (!win) throw new Error(`no "${CAPTIONS_WINDOW_LABEL}" window`);
  return win;
}

/** Backend command that orders the strip to the front without making it the key window (SPEC 3.2). */
export const SHOW_CAPTIONS_COMMAND = "show_captions_window";

/**
 * Shows the strip without taking the keyboard from the meeting app: through
 * the backend command, or, where the app has none (or it fails), the window's
 * own `show()`, which on macOS also makes it the key window.
 */
async function showWithoutFocus(win: Awaited<ReturnType<typeof captionsWindow>>): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke(SHOW_CAPTIONS_COMMAND);
  } catch (err) {
    console.info(`[captions] "${SHOW_CAPTIONS_COMMAND}" is not available (${String(err)}); showing the window directly`);
    await win.show();
  }
}

/** Show the caption strip. It is not given the focus: the user is in their meeting. */
export async function showCaptions(): Promise<void> {
  try {
    await showWithoutFocus(await captionsWindow());
    await announce(true);
  } catch (err) {
    console.warn("[captions] Could not show the caption strip:", err);
  }
}

/** Hide the caption strip. */
export async function hideCaptions(): Promise<void> {
  try {
    await (await captionsWindow()).hide();
    await announce(false);
  } catch (err) {
    console.warn("[captions] Could not hide the caption strip:", err);
  }
}

/** Whether the caption strip is on screen (false when that can't be told). */
export async function isCaptionsVisible(): Promise<boolean> {
  try {
    return await (await captionsWindow()).isVisible();
  } catch (err) {
    console.warn("[captions] Could not read the caption strip's state:", err);
    return false;
  }
}

/**
 * Show the caption strip when it is hidden, hide it when it is shown.
 * Resolves with whether it is shown afterwards (false when the switch failed).
 */
export async function toggleCaptions(): Promise<boolean> {
  try {
    const win = await captionsWindow();
    const show = !(await win.isVisible());
    if (show) await showWithoutFocus(win);
    else await win.hide();
    await announce(show);
    return show;
  } catch (err) {
    console.warn("[captions] Could not switch the caption strip:", err);
    return false;
  }
}

/**
 * Lock the caption strip (the mouse goes through it to what is underneath) or
 * unlock it. The config store's `captionsLocked` follows what the window
 * accepted, so every window shows the same state.
 */
export async function setCaptionsLocked(locked: boolean): Promise<void> {
  try {
    await (await captionsWindow()).setIgnoreCursorEvents(locked);
    const { useConfigStore } = await import("../../stores/configStore");
    useConfigStore.getState().setCaptionsLocked(locked);
  } catch (err) {
    console.warn(`[captions] Could not ${locked ? "lock" : "unlock"} the caption strip:`, err);
  }
}
