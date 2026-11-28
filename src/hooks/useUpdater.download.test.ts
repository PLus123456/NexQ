import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  },
  emit: async () => {},
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: "overlay" }),
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ get: async () => undefined }),
}));
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  getPendingUpdate: async () => null,
}));

import { useUpdater } from "./useUpdater";
import { useUpdaterStore } from "../stores/updaterStore";

const state = useUpdaterStore.getState;
const update = { version: "2.42.0", body: "Next release", date: null };

function broadcast(name: string, payload: unknown) {
  const listener = listeners.get(name);
  expect(listener).toBeDefined();
  act(() => listener?.({ payload }));
}

describe("update downloads in the overlay window", () => {
  beforeEach(() => {
    listeners.clear();
    state().reset();
  });

  it("tracks a download started by another window, including errors and retries", async () => {
    const { unmount } = renderHook(() => useUpdater());
    await waitFor(() => expect(listeners.has("update_download_started")).toBe(true));

    broadcast("update_download_started", update);
    broadcast("update_download_progress", { chunk_length: 25, content_length: 100 });
    expect(state()).toMatchObject({ phase: "downloading", version: update.version, progress: { received: 25, total: 100 } });

    broadcast("update_download_failed", { message: "Timed out" });
    expect(state()).toMatchObject({ phase: "error", error: "Timed out" });

    broadcast("update_download_started", update);
    expect(state().progress).toEqual({ received: 0, total: null });
    broadcast("update_downloaded", update);
    expect(state()).toMatchObject({ phase: "ready", version: update.version, notes: update.body, refresh: "idle" });

    unmount();
    expect(listeners.size).toBe(0);
  });

  it("keeps the older update ready if the background replacement fails", async () => {
    state().setReady("2.41.4");
    renderHook(() => useUpdater());
    await waitFor(() => expect(listeners.has("update_download_started")).toBe(true));

    broadcast("update_download_started", update);
    expect(state()).toMatchObject({ phase: "ready", version: "2.41.4", refresh: "downloading", refreshVersion: update.version });
    broadcast("update_download_failed", { message: "Timed out" });
    expect(state()).toMatchObject({ phase: "ready", version: "2.41.4", refresh: "idle" });
  });
});
