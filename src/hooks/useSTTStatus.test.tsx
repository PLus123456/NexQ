// The meeting's STT status hooks: the Soniox region each party is connected
// to, and one notice per region switch — the overlay shows it, the launcher
// doesn't, so it never shows twice.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Meeting } from "../lib/types";
import type { SonioxSwitchReason } from "../lib/stt/types";

type Handler = (e: { payload: unknown }) => void;
const listeners = vi.hoisted(() => new Map<string, Set<(e: { payload: unknown }) => void>>());
const toast = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: Handler) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name)!.add(cb);
    return () => listeners.get(name)!.delete(cb);
  },
  emit: async () => {},
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));
vi.mock("../stores/toastStore", () => ({ showToast: (...args: unknown[]) => toast(...args) }));
// The meeting's other hooks aren't under test.
vi.mock("./useMeetingTimer", () => ({ useMeetingTimer: () => {} }));
vi.mock("./useTranscriptPersistence", () => ({ useTranscriptPersistence: () => {} }));
vi.mock("./useTranscript", () => ({ useTranscript: () => {} }));
vi.mock("./useSpeechRecognition", () => ({ useSpeechRecognition: () => {} }));
vi.mock("./useAudioConfigSync", () => ({ useAudioConfigSync: () => {} }));
vi.mock("./useStreamBuffer", () => ({ useStreamBuffer: () => {} }));
vi.mock("./useCallLogCapture", () => ({ useCallLogCapture: () => {} }));
vi.mock("./useDevLog", () => ({ useDevLog: () => {} }));

import { ActiveMeetingProvider } from "../components/ActiveMeetingProvider";
import { regionSwitchMessage } from "./useSTTStatus";
import { changeUiLanguage } from "../i18n";
import { useMeetingStore } from "../stores/meetingStore";
import { useSttRegionStore } from "../stores/sttRegionStore";

async function emit(name: string, payload: unknown) {
  await act(async () => {
    listeners.get(name)?.forEach((cb) => cb({ payload }));
  });
}

/** Both windows' meeting hooks, like the real app (where each window has its own JS context). */
async function mountBothWindows() {
  render(
    <>
      <ActiveMeetingProvider isLauncherWindow />
      <ActiveMeetingProvider isLauncherWindow={false} />
    </>,
  );
  await act(async () => {});
}

const switchToasts = () => toast.mock.calls.filter(([, type]) => type === "warning");

beforeEach(() => {
  listeners.clear();
  toast.mockClear();
  useSttRegionStore.getState().clear();
  useMeetingStore.setState({ activeMeeting: { id: "m1" } as Meeting });
});

afterEach(async () => {
  cleanup();
  useMeetingStore.setState({ activeMeeting: null });
  await act(() => changeUiLanguage("en"));
});

describe("Soniox region switches in a meeting", () => {
  it("shows one notice per switch, from the overlay only", async () => {
    await mountBothWindows();
    expect(listeners.get("soniox_region_switch")?.size).toBe(3); // the region in both windows, the notice in one

    await emit("soniox_region_switch", { party: "Them", from: "jp", to: "in", reason: "concurrency" });
    expect(switchToasts()).toEqual([
      ["Them: the Japan region is at its concurrency limit, switching to the India region", "warning"],
    ]);

    await emit("soniox_region_switch", { party: "You", from: "us", to: "eu", reason: "network" });
    expect(switchToasts()).toHaveLength(2);
    expect(switchToasts()[1]).toEqual(["You: can't reach the US region, switching to the EU region", "warning"]);
  });

  it("says why, in Chinese", async () => {
    await changeUiLanguage("zh-CN");
    expect(regionSwitchMessage({ party: "Them", from: "jp", to: "in", reason: "concurrency" })).toBe(
      "对方：日本区并发已满，改连印度区",
    );
    expect(regionSwitchMessage({ party: "You", from: "us", to: "eu", reason: "key_rejected" })).toBe(
      "我：美国区的 Key 被拒绝，改连欧盟区",
    );
    expect(regionSwitchMessage({ party: "Them", from: "eu", to: "jp", reason: "budget" })).toBe(
      "对方：欧盟区项目的月度预算已用完，改连日本区",
    );
  });

  it("words every reason differently, and an unknown one plainly", () => {
    const reasons: SonioxSwitchReason[] = [
      "concurrency",
      "unavailable",
      "model_not_available",
      "budget",
      "network",
      "key_rejected",
      "internal_error",
    ];
    const messages = reasons.map((reason) => regionSwitchMessage({ party: "Them", from: "jp", to: "in", reason }));
    expect(new Set(messages).size).toBe(reasons.length);
    expect(messages.every((m) => m.startsWith("Them: ") && m.endsWith("the India region"))).toBe(true);
    expect(
      regionSwitchMessage({ party: "Them", from: "jp", to: "custom", reason: "something_new" as SonioxSwitchReason }),
    ).toBe("Them: switching from the Japan region to the custom URL");
  });

  it("keeps the region each party is connected to until the meeting ends", async () => {
    await mountBothWindows();
    const regions = () => useSttRegionStore.getState().regions;
    await emit("stt_connection_status", { provider: "soniox", party: "Them", status: "connected", region: "jp" });
    expect(regions()).toEqual({ Them: "jp" });
    await emit("soniox_region_switch", { party: "Them", from: "jp", to: "in", reason: "unavailable" });
    expect(regions()).toEqual({ Them: "in" });
    await emit("stt_connection_status", { provider: "soniox", party: "Them", status: "disconnected" });
    expect(regions()).toEqual({});

    await emit("stt_connection_status", { provider: "soniox", party: "You", status: "connected", region: "us" });
    expect(regions()).toEqual({ You: "us" });
    act(() => useMeetingStore.setState({ activeMeeting: null }));
    expect(regions()).toEqual({});
  });
});
