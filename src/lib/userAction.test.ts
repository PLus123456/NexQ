import { beforeEach, describe, expect, it, vi } from "vitest";

const generateAssist = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));
vi.mock("./ipc", () => ({ generateAssist: (...args: unknown[]) => generateAssist(...args) }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ get: async () => undefined, set: async () => {}, onKeyChange: async () => () => {} }),
}));

import { runUserAction } from "./userAction";
import { useConfigStore } from "../stores/configStore";
import { useStreamStore } from "../stores/streamStore";

const T0 = 1_700_000_000_000;

describe("runUserAction", () => {
  it("marks replay-only requests and clears Sending when the preparation expired", async () => {
    useStreamStore.getState().startStream("Assist", "mock", "mock");
    useStreamStore.getState().appendToken("Previous answer");
    useStreamStore.getState().endStream(10);
    generateAssist.mockRejectedValueOnce(new Error("Prepared answer no longer available"));
    await expect(runUserAction("Assist", "When can we ship?", true)).rejects.toThrow("no longer available");
    expect(generateAssist.mock.calls[0][2]).toMatchObject({ preparedOnly: true, scope: null });
    expect(useStreamStore.getState().phase).toBe("idle");
    expect(useStreamStore.getState().currentContent).toBe("Previous answer");
    expect(generateAssist).toHaveBeenCalledTimes(1);
  });
  beforeEach(() => {
    generateAssist.mockReset();
    generateAssist.mockResolvedValue(undefined);
    useStreamStore.getState().resetForMeeting();
    useConfigStore.setState({ contextScope: { kind: "default", minutes: 5 }, contextScopeSticky: true });
    vi.spyOn(Date, "now").mockReturnValue(T0);
  });

  it("default scope sends no scope and shows Sending… at once", async () => {
    const p = runUserAction("FollowUp");
    expect(useStreamStore.getState().phase).toBe("sending");
    await p;
    const [mode, question, opts] = generateAssist.mock.calls[0] as [string, unknown, { scope: unknown; requestId: string }];
    expect([mode, question, opts.scope]).toEqual(["FollowUp", undefined, null]);
    expect(useStreamStore.getState().pendingRequestId).toBe(opts.requestId);
  });

  it("resolves since-last-same from this meeting's previous request of that action", async () => {
    useConfigStore.setState({ contextScope: { kind: "since_last_same", minutes: 5 } });
    await runUserAction("FollowUp");
    expect((generateAssist.mock.calls[0][2] as { scope: unknown }).scope).toEqual({
      kind: "all",
      since_ms: null,
      label: "Whole meeting (first F/U)",
    });

    useStreamStore.getState().recordUserRequest("FollowUp", T0 - 90_000);
    await runUserAction("FollowUp", "custom?");
    expect(generateAssist.mock.calls[1][1]).toBe("custom?");
    expect((generateAssist.mock.calls[1][2] as { scope: unknown }).scope).toEqual({
      kind: "since_last_same",
      since_ms: T0 - 90_000,
      label: "Since last F/U",
    });
  });

  it("a sticky scope stays; a non-sticky one reverts to the default after one action", async () => {
    // generate_assist resolves once its stream ended (no events in this test).
    const finished = () => useStreamStore.setState({ phase: "idle", pendingRequestId: null });
    useConfigStore.setState({ contextScope: { kind: "minutes", minutes: 10 }, contextScopeSticky: true });
    await runUserAction("Recap");
    finished();
    expect(useConfigStore.getState().contextScope).toEqual({ kind: "minutes", minutes: 10 });

    useConfigStore.setState({ contextScopeSticky: false });
    await runUserAction("Recap");
    finished();
    expect((generateAssist.mock.calls[1][2] as { scope: { label: string } }).scope.label).toBe("Last 10 min");
    expect(useConfigStore.getState().contextScope).toEqual({ kind: "default", minutes: 10 });
    await runUserAction("Recap");
    expect((generateAssist.mock.calls[2][2] as { scope: unknown }).scope).toBeNull();
  });

  it("a second press while the first is still sending keeps the first's progress and scope", async () => {
    useConfigStore.setState({ contextScope: { kind: "minutes", minutes: 5 }, contextScopeSticky: false });
    useStreamStore.setState({ phase: "sending", pendingRequestId: "first", isStreaming: false });
    generateAssist.mockRejectedValueOnce(new Error("Generation already in progress"));
    await expect(runUserAction("Assist")).rejects.toThrow("already in progress");
    expect(useStreamStore.getState().pendingRequestId).toBe("first");
    expect(useStreamStore.getState().phase).toBe("sending");
    expect(useConfigStore.getState().contextScope).toEqual({ kind: "minutes", minutes: 5 });
    useStreamStore.setState({ phase: "idle", pendingRequestId: null });
  });

  it("a failed request clears its Sending… state", async () => {
    generateAssist.mockRejectedValueOnce(new Error("Generation already in progress"));
    await expect(runUserAction("Assist")).rejects.toThrow("already in progress");
    expect(useStreamStore.getState().phase).toBe("idle");
  });
});
