import { describe, expect, it } from "vitest";
import { clampCaptionsSettings, defaultBounds, isOnScreen, recommendedHeight, sameBounds } from "./layout";
import { DEFAULT_CAPTIONS_SETTINGS } from "./types";

const SCREEN = { x: 0, y: 25, width: 1512, height: 895 }; // a MacBook's work area, logical px

describe("caption strip layout", () => {
  it("places the strip at the bottom centre, 70% of the screen wide, at most 1000px", () => {
    const b = defaultBounds(SCREEN, 200);
    expect(b.width).toBe(1000);
    expect(b.x).toBe(256);
    expect(b.y + b.height).toBeLessThan(SCREEN.y + SCREEN.height);
    expect(b.y + b.height).toBeGreaterThan(SCREEN.y + SCREEN.height - 100);
    expect(defaultBounds({ x: 1512, y: 0, width: 1000, height: 800 }, 200)).toMatchObject({ x: 1512 + 150, width: 700 });
  });

  it("knows a place that is off every screen", () => {
    expect(isOnScreen({ x: 256, y: 600, width: 1000, height: 200 }, [SCREEN])).toBe(true);
    // Saved on a second screen that is gone.
    expect(isOnScreen({ x: 2000, y: 600, width: 1000, height: 200 }, [SCREEN])).toBe(false);
    // Only a sliver is still visible.
    expect(isOnScreen({ x: 1500, y: 600, width: 1000, height: 200 }, [SCREEN])).toBe(false);
    expect(isOnScreen({ x: Number.NaN, y: 0, width: 900, height: 140 }, [SCREEN])).toBe(false);
  });

  it("recommends a height that grows with text size and caption count", () => {
    const base = recommendedHeight(DEFAULT_CAPTIONS_SETTINGS);
    expect(base).toBeGreaterThan(150);
    expect(base).toBeLessThan(260);
    expect(recommendedHeight({ ...DEFAULT_CAPTIONS_SETTINGS, captionsCueCount: 3 })).toBeGreaterThan(base);
    expect(recommendedHeight({ ...DEFAULT_CAPTIONS_SETTINGS, captionsShow: "translation" })).toBeLessThan(base);
    expect(recommendedHeight({ ...DEFAULT_CAPTIONS_SETTINGS, captionsFontSize: 28 })).toBeGreaterThan(base);
  });

  it("keeps settings in range", () => {
    const s = clampCaptionsSettings({
      ...DEFAULT_CAPTIONS_SETTINGS,
      captionsBgOpacity: 3,
      captionsCueCount: 9,
      captionsFontSize: Number.NaN,
      captionsShow: "nonsense" as never,
    });
    expect(s).toMatchObject({ captionsBgOpacity: 0.8, captionsCueCount: 3, captionsFontSize: 20, captionsShow: "both" });
  });

  it("compares bounds to the pixel", () => {
    expect(sameBounds({ x: 1, y: 2, width: 3, height: 4 }, { x: 1.2, y: 2, width: 3, height: 4 })).toBe(true);
    expect(sameBounds(null, null)).toBe(true);
    expect(sameBounds(null, { x: 1, y: 2, width: 3, height: 4 })).toBe(false);
  });
});
