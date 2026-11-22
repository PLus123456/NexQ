// Sizes and places of the caption strip, as plain arithmetic (logical pixels).
// placement.ts applies them to the window.

import type { CaptionsBounds, CaptionsSettings } from "./types";

/** Line heights of the original and the translation, in em. */
export const SRC_LINE_HEIGHT = 1.32;
export const DST_LINE_HEIGHT = 1.4;
/** Space between two captions and around the stack, px. */
export const CUE_GAP = 6;
export const STRIP_PADDING = 10;
/** Room at the top for the controls that show on hover, px. */
export const CONTROLS_ROOM = 26;

export const MIN_STRIP = { width: 320, height: 60 };
const MAX_WIDTH = 1000;
const WIDTH_SHARE = 0.7;
/** Distance from the bottom of the screen's work area (above the Dock), px. */
const BOTTOM_MARGIN = 56;

/** The settings, kept in their ranges (a hand-edited or older config can hold anything). */
export function clampCaptionsSettings(s: CaptionsSettings): CaptionsSettings {
  const num = (v: unknown, min: number, max: number, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  return {
    ...s,
    captionsFontSize: num(s.captionsFontSize, 12, 48, 20),
    captionsTranslationFontSize: num(s.captionsTranslationFontSize, 12, 48, 20),
    captionsBgOpacity: num(s.captionsBgOpacity, 0, 0.8, 0.35),
    captionsCueCount: Math.round(num(s.captionsCueCount, 1, 3, 2)),
    captionsFadeSeconds: num(s.captionsFadeSeconds, 0, 120, 8),
    captionsShow: s.captionsShow === "translation" || s.captionsShow === "original" ? s.captionsShow : "both",
    captionsParties: s.captionsParties === "both" ? "both" : "them",
  };
}

/**
 * A height that holds the captions without clipping in the usual case: the
 * newest caption with two lines of each language shown, the older ones with
 * one and a quarter (they are often shorter), plus the controls' room.
 */
export function recommendedHeight(s: Pick<CaptionsSettings, "captionsFontSize" | "captionsTranslationFontSize" | "captionsCueCount" | "captionsShow">): number {
  const src = s.captionsShow === "translation" ? 0 : s.captionsFontSize * SRC_LINE_HEIGHT;
  const dst = s.captionsShow === "original" ? 0 : s.captionsTranslationFontSize * DST_LINE_HEIGHT;
  const newest = 2 * (src + dst);
  const older = (s.captionsCueCount - 1) * (1.25 * (src + dst) + CUE_GAP);
  return Math.round(Math.max(MIN_STRIP.height, CONTROLS_ROOM + newest + older + 2 * STRIP_PADDING));
}

/** The default place on a screen's work area: bottom centre, 70% of its width (at most 1000px). */
export function defaultBounds(area: CaptionsBounds, height: number): CaptionsBounds {
  const width = Math.round(Math.max(MIN_STRIP.width, Math.min(MAX_WIDTH, area.width * WIDTH_SHARE)));
  const h = Math.round(Math.min(height, area.height));
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + Math.max(0, area.height - h - BOTTOM_MARGIN)),
    width,
    height: h,
  };
}

/**
 * Whether enough of `bounds` is on one of the screens to see and grab it
 * (at least 80×40 px of it). False for bounds saved on a screen that is gone
 * or at a resolution that no longer reaches there.
 */
export function isOnScreen(bounds: CaptionsBounds, screens: CaptionsBounds[]): boolean {
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return false;
  if (bounds.width < MIN_STRIP.width / 2 || bounds.height < MIN_STRIP.height / 2) return false;
  return screens.some((s) => {
    const w = Math.min(bounds.x + bounds.width, s.x + s.width) - Math.max(bounds.x, s.x);
    const h = Math.min(bounds.y + bounds.height, s.y + s.height) - Math.max(bounds.y, s.y);
    return w >= 80 && h >= 40;
  });
}

/** Same place and size, to the pixel. */
export function sameBounds(a: CaptionsBounds | null, b: CaptionsBounds | null): boolean {
  if (!a || !b) return a === b;
  return Math.round(a.x) === Math.round(b.x) && Math.round(a.y) === Math.round(b.y)
    && Math.round(a.width) === Math.round(b.width) && Math.round(a.height) === Math.round(b.height);
}
