import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (e: { payload: unknown }) => void;
const listeners = new Map<string, Set<Handler>>();
const emitted: Array<{ name: string; payload: unknown }> = [];

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: Handler) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name)!.add(cb);
    return () => listeners.get(name)!.delete(cb);
  },
  emit: async (name: string, payload: unknown) => {
    emitted.push({ name, payload });
  },
}));

const confirm = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: (...args: unknown[]) => confirm(...args),
}));

const installUpdateNow = vi.fn();
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  installUpdateNow: () => installUpdateNow(),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: "launcher" }),
}));

import { endMeetingFromThisWindow, restartToUpdate, MEETING_END_TIMEOUT_MS } from "./useUpdater";
import { useMeetingStore } from "../stores/meetingStore";
import { useToastStore } from "../stores/toastStore";

function receive(name: string, payload: unknown) {
  listeners.get(name)?.forEach((cb) => cb({ payload }));
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe("restartToUpdate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    listeners.clear();
    emitted.length = 0;
    confirm.mockReset();
    installUpdateNow.mockReset();
    installUpdateNow.mockResolvedValue(undefined);
    useToastStore.setState({ toasts: [] });
    useMeetingStore.setState({ activeMeeting: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("installs right away when no meeting is active", async () => {
    await restartToUpdate();

    expect(confirm).not.toHaveBeenCalled();
    expect(installUpdateNow).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the user cancels the meeting prompt", async () => {
    useMeetingStore.setState({ activeMeeting: { id: "m1" } as never });
    confirm.mockResolvedValue(false);

    await restartToUpdate();

    expect(emitted).toHaveLength(0);
    expect(installUpdateNow).not.toHaveBeenCalled();
  });

  it("waits for the launcher to finish saving the requested meeting", async () => {
    useMeetingStore.setState({ activeMeeting: { id: "m1" } as never });
    confirm.mockResolvedValue(true);

    const run = restartToUpdate();
    await flush();
    expect(emitted).toContainEqual({ name: "tray_stop_meeting", payload: { meetingId: "m1" } });

    receive("nexq:meeting_ended", { window: "overlay", meetingId: "m1" });
    receive("nexq:meeting_ended", { window: "launcher", meetingId: "other" });
    await flush();
    expect(installUpdateNow).not.toHaveBeenCalled();

    receive("nexq:meeting_ended", { window: "launcher", meetingId: "m1" });
    await run;
    expect(installUpdateNow).toHaveBeenCalledTimes(1);
  });

  it("aborts the install and warns if the launcher does not acknowledge the meeting", async () => {
    useMeetingStore.setState({ activeMeeting: { id: "m1" } as never });
    confirm.mockResolvedValue(true);

    const run = restartToUpdate();
    await flush();
    await vi.advanceTimersByTimeAsync(MEETING_END_TIMEOUT_MS);
    await run;

    expect(installUpdateNow).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts.some((t) => t.type === "error")).toBe(true);
  });

  it("aborts the install when the launcher reports a save failure", async () => {
    useMeetingStore.setState({ activeMeeting: { id: "m1" } as never });
    confirm.mockResolvedValue(true);

    const run = restartToUpdate();
    await flush();
    receive("nexq:meeting_end_failed", { meetingId: "m1", message: "Failed to save the transcript" });
    await run;

    expect(installUpdateNow).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts.some((t) => t.type === "error")).toBe(true);
  });
});

describe("endMeetingFromThisWindow", () => {
  const endMeetingFlow = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    listeners.clear();
    emitted.length = 0;
    endMeetingFlow.mockReset().mockResolvedValue(undefined);
    useMeetingStore.setState({ activeMeeting: null, overlayMeetingId: null, endMeetingFlow } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delegates to the meeting flow and waits for it to finish", async () => {
    useMeetingStore.setState({ activeMeeting: { id: "m1" } as never, overlayMeetingId: "m1" });
    let finish!: () => void;
    endMeetingFlow.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));

    let ended: boolean | undefined;
    const run = endMeetingFromThisWindow().then((ok) => (ended = ok));
    await flush();
    expect(endMeetingFlow).toHaveBeenCalledTimes(1);
    expect(ended).toBeUndefined();

    finish();
    await run;
    expect(ended).toBe(true);
  });

  it("reports failure when the meeting flow rejects", async () => {
    useMeetingStore.setState({ activeMeeting: { id: "m1" } as never, overlayMeetingId: "m1" });
    endMeetingFlow.mockRejectedValue(new Error("A window did not save"));
    expect(await endMeetingFromThisWindow()).toBe(false);
  });

  it("does nothing without a meeting", async () => {
    expect(await endMeetingFromThisWindow()).toBe(true);
    expect(endMeetingFlow).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
  });
});
