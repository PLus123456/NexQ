// The caption strip's settings (SPEC 3.2): set in Settings (launcher), switched
// from the answer window (overlay) and moved in the caption window itself.
// Each window has its own configStore; they meet in the plugin-store, modelled
// here like in configStore.crossWindow.test.ts: one shared map, and a write
// that every window's listeners hear.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptionsSettings } from "../lib/captions/types";

const saved = vi.hoisted(() => new Map<string, unknown>());
const keyListeners = vi.hoisted(() => [] as Array<{ key: string; cb: (v: unknown) => void }>);

vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    get: async (key: string) => saved.get(key),
    set: async (key: string, value: unknown) => {
      saved.set(key, value);
      for (const l of keyListeners) if (l.key === key) l.cb(structuredClone(value));
    },
    onKeyChange: async (key: string, cb: (v: unknown) => void) => {
      keyListeners.push({ key, cb });
      return () => {};
    },
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));

const DEFAULTS: CaptionsSettings = {
  captionsEnabled: true,
  captionsParties: "them",
  captionsShow: "both",
  captionsFontSize: 20,
  captionsTranslationFontSize: 20,
  captionsTextColor: "#ffffff",
  captionsTranslationColor: "#ffd34d",
  captionsBgOpacity: 0.35,
  captionsCueCount: 2,
  captionsFadeSeconds: 8,
  captionsLocked: false,
  captionsBounds: null,
};

/** Every setting changed from its default. */
const CHANGED: CaptionsSettings = {
  captionsEnabled: false,
  captionsParties: "both",
  captionsShow: "translation",
  captionsFontSize: 26,
  captionsTranslationFontSize: 18,
  captionsTextColor: "#f0f0f0",
  captionsTranslationColor: "#7dd3fc",
  captionsBgOpacity: 0.6,
  captionsCueCount: 3,
  captionsFadeSeconds: 0,
  captionsLocked: true,
  captionsBounds: { x: 120, y: 860, width: 1000, height: 150 },
};

const KEYS = Object.keys(DEFAULTS) as (keyof CaptionsSettings)[];

type ConfigStore = typeof import("./configStore").useConfigStore;

/** The caption settings as `store` has them. */
function captionsOf(store: ConfigStore): CaptionsSettings {
  const {
    captionsEnabled, captionsParties, captionsShow, captionsFontSize, captionsTranslationFontSize, captionsTextColor,
    captionsTranslationColor, captionsBgOpacity, captionsCueCount, captionsFadeSeconds, captionsLocked, captionsBounds,
  } = store.getState();
  return {
    captionsEnabled, captionsParties, captionsShow, captionsFontSize, captionsTranslationFontSize, captionsTextColor,
    captionsTranslationColor, captionsBgOpacity, captionsCueCount, captionsFadeSeconds, captionsLocked, captionsBounds,
  };
}

/** Changes every setting through its setter. */
function changeAll(store: ConfigStore) {
  const s = store.getState();
  s.setCaptionsEnabled(CHANGED.captionsEnabled);
  s.setCaptionsParties(CHANGED.captionsParties);
  s.setCaptionsShow(CHANGED.captionsShow);
  s.setCaptionsFontSize(CHANGED.captionsFontSize);
  s.setCaptionsTranslationFontSize(CHANGED.captionsTranslationFontSize);
  s.setCaptionsTextColor(CHANGED.captionsTextColor);
  s.setCaptionsTranslationColor(CHANGED.captionsTranslationColor);
  s.setCaptionsBgOpacity(CHANGED.captionsBgOpacity);
  s.setCaptionsCueCount(CHANGED.captionsCueCount);
  s.setCaptionsFadeSeconds(CHANGED.captionsFadeSeconds);
  s.setCaptionsLocked(CHANGED.captionsLocked);
  s.setCaptionsBounds(CHANGED.captionsBounds);
}

/** A window: a fresh module graph (own Zustand store) that has loaded its config. */
async function openWindow(): Promise<ConfigStore> {
  vi.resetModules();
  const { useConfigStore } = await import("./configStore");
  await useConfigStore.getState().loadConfig();
  return useConfigStore;
}

describe("configStore: caption strip settings", () => {
  beforeEach(() => {
    saved.clear();
    keyListeners.length = 0;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("start with the documented defaults, before and after loading a config that has none of them", async () => {
    vi.resetModules();
    const { useConfigStore } = await import("./configStore");
    expect(captionsOf(useConfigStore)).toEqual(DEFAULTS);
    await useConfigStore.getState().loadConfig();
    expect(captionsOf(useConfigStore)).toEqual(DEFAULTS);
    for (const key of KEYS) expect(saved.has(key), key).toBe(false);
  });

  it("the defaults are the ones in lib/captions/types", async () => {
    const { DEFAULT_CAPTIONS_SETTINGS } = await import("../lib/captions/types");
    expect(DEFAULT_CAPTIONS_SETTINGS).toEqual(DEFAULTS);
  });

  it("each setter changes its setting and saves it under the setting's name", async () => {
    const store = await openWindow();
    changeAll(store);
    expect(captionsOf(store)).toEqual(CHANGED);
    await vi.waitFor(() => {
      for (const key of KEYS) expect(saved.get(key), key).toEqual(CHANGED[key]);
    });
  });

  it("saved settings come back on the next start", async () => {
    for (const key of KEYS) saved.set(key, CHANGED[key]);
    const store = await openWindow();
    expect(captionsOf(store)).toEqual(CHANGED);
  });

  it("a setting saved as off or zero is kept, not replaced by its default", async () => {
    saved.set("captionsEnabled", false);
    saved.set("captionsBgOpacity", 0);
    saved.set("captionsFadeSeconds", 0);
    const store = await openWindow();
    expect(store.getState().captionsEnabled).toBe(false);
    expect(store.getState().captionsBgOpacity).toBe(0);
    expect(store.getState().captionsFadeSeconds).toBe(0);
  });

  it("a change in one window reaches the others and the next start", async () => {
    const launcher = await openWindow();
    const overlay = await openWindow();
    const captions = await openWindow();
    expect(captionsOf(overlay)).toEqual(DEFAULTS);

    changeAll(launcher);
    await vi.waitFor(() => expect(captionsOf(overlay)).toEqual(CHANGED));
    expect(captionsOf(captions)).toEqual(CHANGED);

    const nextStart = await openWindow();
    expect(captionsOf(nextStart)).toEqual(CHANGED);
  });

  it("the lock set from the answer window reaches the caption window, and so does unlocking", async () => {
    const overlay = await openWindow();
    const captions = await openWindow();
    overlay.getState().setCaptionsLocked(true);
    await vi.waitFor(() => expect(captions.getState().captionsLocked).toBe(true));
    overlay.getState().setCaptionsLocked(false);
    await vi.waitFor(() => expect(captions.getState().captionsLocked).toBe(false));
  });

  it("where the strip was dragged to reaches the other windows, and so does putting it back (null)", async () => {
    const captions = await openWindow();
    const launcher = await openWindow();
    const bounds = { x: 40, y: 700, width: 900, height: 140 };
    captions.getState().setCaptionsBounds(bounds);
    await vi.waitFor(() => expect(launcher.getState().captionsBounds).toEqual(bounds));

    launcher.getState().setCaptionsBounds(null);
    await vi.waitFor(() => expect(captions.getState().captionsBounds).toBeNull());
    expect(saved.get("captionsBounds")).toBeNull();
    const nextStart = await openWindow();
    expect(nextStart.getState().captionsBounds).toBeNull();
  });
});
