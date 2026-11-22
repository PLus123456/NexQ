import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

// The windows the app has, as the window API reports them. A test removes the
// caption window or makes one of its calls fail.
const calls: string[] = [];
const win = vi.hoisted(() => ({
  exists: true,
  visible: false,
  failing: null as string | null,
}));

function call(name: string, effect: () => void = () => {}) {
  return vi.fn(async (...args: unknown[]) => {
    calls.push(args.length ? `${name}(${args.join(", ")})` : name);
    if (win.failing === name) throw new Error(`${name} failed`);
    effect();
  });
}

const captions = {
  show: call("show", () => { win.visible = true; }),
  hide: call("hide", () => { win.visible = false; }),
  isVisible: vi.fn(async () => {
    if (win.failing === "isVisible") throw new Error("isVisible failed");
    return win.visible;
  }),
  setIgnoreCursorEvents: call("setIgnoreCursorEvents"),
  setFocus: call("setFocus"),
};
const getByLabel = vi.fn(async (label: string) => (label === "captions" && win.exists ? captions : null));

vi.mock("@tauri-apps/api/webviewWindow", () => ({ WebviewWindow: { getByLabel } }));

// What was announced to the other windows.
const announced: Array<[string, unknown]> = [];
const emit = vi.fn(async (name: string, payload: unknown) => {
  if (win.failing === "emit") throw new Error("emit failed");
  announced.push([name, payload]);
});
vi.mock("@tauri-apps/api/event", () => ({ emit }));

const saved = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    get: async (key: string) => saved.get(key),
    set: async (key: string, value: unknown) => void saved.set(key, value),
    onKeyChange: async () => () => {},
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));

import {
  CAPTIONS_VISIBILITY_EVENT, CAPTIONS_WINDOW_LABEL, hideCaptions, isCaptionsVisible, setCaptionsLocked, showCaptions,
  toggleCaptions,
} from "./window";
import { useConfigStore } from "../../stores/configStore";

let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  calls.length = 0;
  announced.length = 0;
  win.exists = true;
  win.visible = false;
  win.failing = null;
  saved.clear();
  useConfigStore.setState({ captionsLocked: false });
  getByLabel.mockClear();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the caption strip's window", () => {
  it("is the window labelled 'captions'", async () => {
    expect(CAPTIONS_WINDOW_LABEL).toBe("captions");
    await showCaptions();
    expect(getByLabel).toHaveBeenCalledExactlyOnceWith("captions");
  });

  it("shows without taking the focus, and hides", async () => {
    await showCaptions();
    expect(calls).toEqual(["show"]);
    expect(win.visible).toBe(true);

    await hideCaptions();
    expect(calls).toEqual(["show", "hide"]);
    expect(win.visible).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("toggles: shows a hidden strip, hides a shown one, and says which it did", async () => {
    await expect(toggleCaptions()).resolves.toBe(true);
    expect(win.visible).toBe(true);
    await expect(toggleCaptions()).resolves.toBe(false);
    expect(win.visible).toBe(false);
    expect(calls).toEqual(["show", "hide"]);
  });

  it("tells every window when the strip is shown or hidden", async () => {
    await showCaptions();
    await hideCaptions();
    await toggleCaptions();
    expect(announced).toEqual([
      [CAPTIONS_VISIBILITY_EVENT, { visible: true }],
      [CAPTIONS_VISIBILITY_EVENT, { visible: false }],
      [CAPTIONS_VISIBILITY_EVENT, { visible: true }],
    ]);
  });

  it("a show that failed is not announced", async () => {
    win.failing = "show";
    await showCaptions();
    expect(announced).toEqual([]);
  });

  it("an announcement that failed doesn't undo the show", async () => {
    win.failing = "emit";
    await showCaptions();
    expect(win.visible).toBe(true);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "[captions] Could not announce the caption strip's state:", expect.any(Error),
    );
  });

  it("reads whether the strip is on screen; unknown counts as hidden", async () => {
    await expect(isCaptionsVisible()).resolves.toBe(false);
    win.visible = true;
    await expect(isCaptionsVisible()).resolves.toBe(true);
    win.exists = false;
    await expect(isCaptionsVisible()).resolves.toBe(false);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "[captions] Could not read the caption strip's state:", expect.any(Error),
    );
  });

  it("locks: the window lets the mouse through and every window's store says so", async () => {
    await setCaptionsLocked(true);
    expect(calls).toEqual(["setIgnoreCursorEvents(true)"]);
    expect(useConfigStore.getState().captionsLocked).toBe(true);
    await vi.waitFor(() => expect(saved.get("captionsLocked")).toBe(true));

    await setCaptionsLocked(false);
    expect(calls).toEqual(["setIgnoreCursorEvents(true)", "setIgnoreCursorEvents(false)"]);
    expect(useConfigStore.getState().captionsLocked).toBe(false);
    await vi.waitFor(() => expect(saved.get("captionsLocked")).toBe(false));
  });

  it("a lock the window refused is not recorded", async () => {
    win.failing = "setIgnoreCursorEvents";
    await expect(setCaptionsLocked(true)).resolves.toBeUndefined();
    expect(useConfigStore.getState().captionsLocked).toBe(false);
    expect(saved.has("captionsLocked")).toBe(false);
    expect(warn).toHaveBeenCalledExactlyOnceWith("[captions] Could not lock the caption strip:", expect.any(Error));
  });

  it("an unlock the window refused leaves the strip recorded as locked", async () => {
    useConfigStore.setState({ captionsLocked: true });
    win.failing = "setIgnoreCursorEvents";
    await setCaptionsLocked(false);
    expect(useConfigStore.getState().captionsLocked).toBe(true);
    expect(warn).toHaveBeenCalledExactlyOnceWith("[captions] Could not unlock the caption strip:", expect.any(Error));
  });

  it.each([
    ["show", showCaptions, "show"],
    ["hide", hideCaptions, "hide"],
    ["switch", toggleCaptions, "isVisible"],
  ] as const)("a failed %s is logged, never thrown", async (verb, action, failing) => {
    win.failing = failing;
    // A failed switch reports the strip as not shown; the others report nothing.
    await expect(action()).resolves.toBe(verb === "switch" ? false : undefined);
    expect(warn).toHaveBeenCalledExactlyOnceWith(`[captions] Could not ${verb} the caption strip:`, expect.any(Error));
  });

  it("without a caption window every call is a logged no-op", async () => {
    win.exists = false;
    await showCaptions();
    await hideCaptions();
    await toggleCaptions();
    await setCaptionsLocked(true);
    expect(calls).toEqual([]);
    expect(useConfigStore.getState().captionsLocked).toBe(false);
    expect(warn).toHaveBeenCalledTimes(4);
  });
});
