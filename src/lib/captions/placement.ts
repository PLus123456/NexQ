// Where the caption window sits: put it at its saved place (or the default
// one), and record where the user moves or resizes it. Runs in the caption
// window itself. Sizes are logical pixels (`captionsBounds`, SPEC 3.2).

import type { CaptionsBounds } from "./types";
import { defaultBounds, isOnScreen, sameBounds } from "./layout";

type Monitor = NonNullable<Awaited<ReturnType<typeof import("@tauri-apps/api/window").currentMonitor>>>;

/** A screen's work area (without menu bar and Dock) in logical pixels. */
function workArea(monitor: Monitor): CaptionsBounds {
  const area = monitor.workArea ?? { position: monitor.position, size: monitor.size };
  const scale = monitor.scaleFactor || 1;
  return {
    x: area.position.x / scale,
    y: area.position.y / scale,
    width: area.size.width / scale,
    height: area.size.height / scale,
  };
}

/** The screen the user is on: the one under the mouse, else this window's, else the main one. */
async function currentScreen(): Promise<Monitor | null> {
  const api = await import("@tauri-apps/api/window");
  try {
    const cursor = await api.cursorPosition();
    const under = await api.monitorFromPoint(cursor.x, cursor.y);
    if (under) return under;
  } catch {
    // Not available on this platform: fall through.
  }
  return (await api.currentMonitor().catch(() => null)) ?? (await api.primaryMonitor().catch(() => null));
}

/**
 * Puts the caption window at `saved` when that is still on a screen,
 * otherwise at the bottom centre of the current screen with `height`.
 * Resolves with where it went (null when the window could not be placed).
 */
export async function placeCaptionsWindow(saved: CaptionsBounds | null, height: number): Promise<CaptionsBounds | null> {
  try {
    const api = await import("@tauri-apps/api/window");
    const monitors = await api.availableMonitors();
    const screens = monitors.map(workArea);
    let target: CaptionsBounds | null = saved && screens.length > 0 && isOnScreen(saved, screens) ? saved : null;
    if (!target) {
      const screen = (await currentScreen()) ?? monitors[0];
      if (!screen) return null;
      target = defaultBounds(workArea(screen), height);
    }
    const win = api.getCurrentWindow();
    await win.setSize(new api.LogicalSize(Math.round(target.width), Math.round(target.height)));
    await win.setPosition(new api.LogicalPosition(Math.round(target.x), Math.round(target.y)));
    return target;
  } catch (err) {
    console.warn("[captions] Could not place the caption strip:", err);
    return null;
  }
}

/** Where the caption window is now, in logical pixels. */
export async function currentCaptionsBounds(): Promise<CaptionsBounds | null> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    const [scale, position, size] = await Promise.all([win.scaleFactor(), win.outerPosition(), win.innerSize()]);
    const p = position.toLogical(scale);
    const s = size.toLogical(scale);
    return { x: Math.round(p.x), y: Math.round(p.y), width: Math.round(s.width), height: Math.round(s.height) };
  } catch {
    return null;
  }
}

/**
 * Changes the window's height, keeping its bottom edge where it is (the
 * captions sit at the bottom, so they stay put).
 */
export async function setCaptionsHeight(height: number): Promise<CaptionsBounds | null> {
  const now = await currentCaptionsBounds();
  if (!now || Math.round(now.height) === Math.round(height)) return now;
  try {
    const api = await import("@tauri-apps/api/window");
    const win = api.getCurrentWindow();
    const next = { ...now, y: now.y + now.height - height, height };
    await win.setPosition(new api.LogicalPosition(next.x, next.y));
    await win.setSize(new api.LogicalSize(next.width, next.height));
    return next;
  } catch (err) {
    console.warn("[captions] Could not resize the caption strip:", err);
    return null;
  }
}

/**
 * Calls `onSettled` with the window's bounds once it has stopped moving or
 * changing size for `quietMs` (a drag fires many events). Resolves with a
 * function that stops following.
 */
export async function followCaptionsBounds(onSettled: (bounds: CaptionsBounds) => void, quietMs = 500): Promise<() => void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last: CaptionsBounds | null = null;
  const settle = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      const bounds = await currentCaptionsBounds();
      if (bounds && !sameBounds(bounds, last)) {
        last = bounds;
        onSettled(bounds);
      }
    }, quietMs);
  };
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    const stops = await Promise.all([win.onMoved(settle), win.onResized(settle)]);
    return () => {
      if (timer) clearTimeout(timer);
      stops.forEach((stop) => stop());
    };
  } catch (err) {
    console.warn("[captions] Could not follow the caption strip's place:", err);
    return () => {};
  }
}
