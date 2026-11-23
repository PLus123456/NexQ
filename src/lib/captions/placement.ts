// Where the caption window sits: put it at its saved place (or the default
// one), and record where the user moves or resizes it. Runs in the caption
// window itself. Sizes are logical pixels (`captionsBounds`, SPEC 3.2).

import type { CaptionsBounds } from "./types";
import { defaultBounds, isOnScreen, sameBounds } from "./layout";
import { isMac } from "../platform";

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

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const positive = (v: unknown): v is number => finite(v) && v > 0;

/**
 * The mouse in desktop coordinates: points on macOS, pixels elsewhere. On
 * macOS Tauri scales the cursor by the main display's factor whatever screen
 * it is on, while screens are found (`monitorFromPoint`) and windows laid out
 * in points; elsewhere cursor, screens and windows are all desktop pixels.
 * Null when the position (on macOS also the main display's scale) can't be
 * read, e.g. a partial stand-in for Tauri.
 */
export async function desktopCursor(mac = isMac()): Promise<{ x: number; y: number } | null> {
  const api = await import("@tauri-apps/api/window");
  if (typeof api.cursorPosition !== "function" || (mac && typeof api.primaryMonitor !== "function")) return null;
  const [cursor, main] = await Promise.all([api.cursorPosition(), mac ? api.primaryMonitor() : null]);
  const scale = mac ? main?.scaleFactor : 1;
  if (!cursor || !finite(cursor.x) || !finite(cursor.y) || !positive(scale)) return null;
  return { x: cursor.x / scale, y: cursor.y / scale };
}

/**
 * Whether the mouse is inside this window, compared in desktop coordinates
 * (`desktopCursor`): on macOS the window's pixels go back to points by its
 * own screen's scale, so a strip on a screen scaled unlike the main one (a
 * Retina laptop next to a 1x monitor) is still judged right. Null when it
 * can't be told (no native API, tests, browser harness).
 */
export async function isCursorInsideWindow(mac = isMac()): Promise<boolean | null> {
  try {
    const api = await import("@tauri-apps/api/window");
    if (typeof api.getCurrentWindow !== "function") return null;
    const win = api.getCurrentWindow();
    if (typeof win.outerPosition !== "function" || typeof win.innerSize !== "function") return null;
    if (mac && typeof win.scaleFactor !== "function") return null;
    const [cursor, pos, size, scale] = await Promise.all([
      desktopCursor(mac),
      win.outerPosition(),
      win.innerSize(),
      mac ? win.scaleFactor() : 1,
    ]);
    if (
      !cursor || !pos || !size
      || !finite(pos.x) || !finite(pos.y)
      || !positive(size.width) || !positive(size.height)
      || !positive(scale)
    ) {
      return null;
    }
    const left = pos.x / scale;
    const top = pos.y / scale;
    return cursor.x >= left && cursor.x <= left + size.width / scale && cursor.y >= top && cursor.y <= top + size.height / scale;
  } catch {
    return null;
  }
}

/** The screen the user is on: the one under the mouse, else this window's, else the main one. */
async function currentScreen(): Promise<Monitor | null> {
  const api = await import("@tauri-apps/api/window");
  try {
    const cursor = await desktopCursor();
    const under = cursor && (await api.monitorFromPoint(cursor.x, cursor.y));
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
