import { beforeEach, describe, expect, it, vi } from "vitest";

// Two screens laid out the way macOS reports them through Tauri: the main
// display a 2x laptop at points (0,0)–(1512,982), a 1x monitor to its right at
// points (1512,0)–(4072,1440). Screen positions and sizes come in each
// screen's own pixels; the cursor in pixels of the main display's scale; a
// screen is found by a point in points (as tao does on macOS).
const laptop = { name: "laptop", position: { x: 0, y: 0 }, size: { width: 3024, height: 1964 }, scaleFactor: 2 };
const monitor = { name: "monitor", position: { x: 1512, y: 0 }, size: { width: 2560, height: 1440 }, scaleFactor: 1 };
const screens = [laptop, monitor];

const state = vi.hoisted(() => ({ cursor: { x: 0, y: 0 }, mac: true, calls: [] as string[] }));

vi.mock("../platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platform")>()),
  isMac: () => state.mac,
}));

vi.mock("@tauri-apps/api/window", () => {
  const inPoints = (s: typeof laptop) => ({
    x: s.position.x / s.scaleFactor,
    y: s.position.y / s.scaleFactor,
    width: s.size.width / s.scaleFactor,
    height: s.size.height / s.scaleFactor,
  });
  return {
    availableMonitors: async () => screens,
    primaryMonitor: async () => laptop,
    currentMonitor: async () => laptop,
    cursorPosition: async () => ({ ...state.cursor }),
    monitorFromPoint: async (x: number, y: number) =>
      screens.find((s) => {
        const b = inPoints(s);
        return x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height;
      }) ?? null,
    getCurrentWindow: () => ({
      setSize: async (size: { width: number; height: number }) => void state.calls.push(`size ${size.width}x${size.height}`),
      setPosition: async (p: { x: number; y: number }) => void state.calls.push(`position ${p.x},${p.y}`),
    }),
    LogicalSize: class { constructor(public width: number, public height: number) {} },
    LogicalPosition: class { constructor(public x: number, public y: number) {} },
  };
});

import { desktopCursor, placeCaptionsWindow } from "./placement";

beforeEach(() => {
  state.cursor = { x: 0, y: 0 };
  state.mac = true;
  state.calls.length = 0;
});

describe("desktopCursor", () => {
  it("turns the macOS cursor back into points by the main display's scale", async () => {
    state.cursor = { x: 5000, y: 1400 };
    expect(await desktopCursor()).toEqual({ x: 2500, y: 700 });
  });

  it("leaves the cursor as it is on other systems", async () => {
    state.mac = false;
    state.cursor = { x: 5000, y: 1400 };
    expect(await desktopCursor()).toEqual({ x: 5000, y: 1400 });
  });
});

describe("placeCaptionsWindow without a saved place", () => {
  it("puts the strip on the 1x monitor the mouse is on, next to a 2x main display", async () => {
    state.cursor = { x: 5000, y: 1400 }; // points (2500,700): on the monitor
    const placed = await placeCaptionsWindow(null, 200);
    expect(placed).not.toBeNull();
    expect(placed!.x).toBeGreaterThanOrEqual(1512);
    expect(placed!.x + placed!.width).toBeLessThanOrEqual(4072);
    expect(state.calls).toContain(`position ${Math.round(placed!.x)},${Math.round(placed!.y)}`);
  });

  it("puts it on the laptop when the mouse is there", async () => {
    state.cursor = { x: 1500, y: 900 }; // points (750,450)
    const placed = await placeCaptionsWindow(null, 200);
    expect(placed!.x + placed!.width).toBeLessThanOrEqual(1512);
  });
});
