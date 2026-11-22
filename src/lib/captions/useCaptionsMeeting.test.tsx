import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => [] as string[]);
vi.mock("./window", () => ({
  showCaptions: async () => void actions.push("show"),
  hideCaptions: async () => void actions.push("hide"),
  setCaptionsLocked: async (locked: boolean) => void actions.push(`lock(${locked})`),
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ get: async () => undefined, set: async () => {}, onKeyChange: async () => () => {} }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));

import { useCaptionsMeeting } from "./useCaptionsMeeting";
import { useConfigStore } from "../../stores/configStore";
import { useMeetingStore } from "../../stores/meetingStore";
import type { Meeting } from "../types";

const meeting = (id: string) => ({ id, title: "Interview" }) as unknown as Meeting;
const start = (id: string) => act(() => useMeetingStore.setState({ activeMeeting: meeting(id) }));
const end = () => act(() => useMeetingStore.setState({ activeMeeting: null }));

beforeEach(() => {
  actions.length = 0;
  useMeetingStore.setState({ activeMeeting: null });
  useConfigStore.setState({ captionsEnabled: true, captionsLocked: false });
});
afterEach(cleanup);

describe("useCaptionsMeeting", () => {
  it("shows the strip when a meeting starts and hides it when it ends", () => {
    renderHook(() => useCaptionsMeeting(true));
    start("m1");
    // Other changes to the meeting don't show it again.
    act(() => useMeetingStore.setState({ elapsedMs: 5000 }));
    end();
    expect(actions).toEqual(["show", "hide"]);
  });

  it("does not show it when the setting is off", () => {
    useConfigStore.setState({ captionsEnabled: false });
    renderHook(() => useCaptionsMeeting(true));
    start("m1");
    expect(actions).toEqual([]);
  });

  it("unlocks a locked strip when the meeting ends", () => {
    useConfigStore.setState({ captionsLocked: true });
    renderHook(() => useCaptionsMeeting(true));
    start("m1");
    end();
    expect(actions).toEqual(["show", "hide", "lock(false)"]);
  });

  it("does nothing in a window where it is not active, and stops on unmount", () => {
    renderHook(() => useCaptionsMeeting(false));
    start("m1");
    expect(actions).toEqual([]);
    const { unmount } = renderHook(() => useCaptionsMeeting(true));
    unmount();
    start("m2");
    expect(actions).toEqual([]);
  });
});
