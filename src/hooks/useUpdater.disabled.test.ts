// With UPDATER_ENABLED off (the NexQ Plus builds), the update loop never runs:
// the app must not contact an update server on its own.

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/brand", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/brand")>()),
  UPDATER_ENABLED: false,
}));
const core = vi.hoisted(() => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: core.invoke }));
const events = vi.hoisted(() => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: events.listen, emit: async () => {} }));
const store = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: store.load }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: "launcher" }),
}));

import { useUpdater } from "./useUpdater";

describe("useUpdater with updates off", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts no check, no interval, no hydration and no listeners", async () => {
    const { unmount } = renderHook(() => useUpdater());
    // Past the 10 s startup check and two 4-hour intervals.
    await vi.advanceTimersByTimeAsync(10_000 + 2 * 4 * 60 * 60 * 1000);

    expect(core.invoke).not.toHaveBeenCalled();
    expect(events.listen).not.toHaveBeenCalled();
    expect(store.load).not.toHaveBeenCalled();
    unmount();
  });
});
