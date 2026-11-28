import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** config.json, which other windows may have written since this one read it. */
const saved = vi.hoisted(() => ({ config: {} as Record<string, unknown> }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    get: async (key: string) => saved.config[key],
    set: async () => {},
  }),
}));
vi.mock("../lib/meetingWindowEvents", async (original) => {
  const events = await original<typeof import("../lib/meetingWindowEvents")>();
  return { ...events, startOverlayMeeting: vi.fn(events.startOverlayMeeting) };
});

import { BUILT_IN_SCENARIOS } from "../lib/scenarios";
import { attachMeetingWindow, useMeetingStore } from "./meetingStore";
import { startOverlayMeeting } from "../lib/meetingWindowEvents";
import { useScenarioStore } from "./scenarioStore";
import { useConfigStore } from "./configStore";
import type { MeetingAudioConfig } from "../lib/types";

const boardReview = {
  id: "custom_1",
  name: "Board review",
  description: "Custom scenario",
  system_prompt: "Board system prompt",
  summary_prompt: "Board summary prompt",
  question_detection_prompt: "Board question prompt",
  is_custom: true,
};

const calls = new Map<string, Record<string, unknown>>();
/** Every IPC call in order (`calls` keeps only the last one per command). */
const log: Array<[string, Record<string, unknown>]> = [];

beforeAll(() => {
  mockWindows("launcher");
  mockIPC((cmd, args) => {
    calls.set(cmd, args as Record<string, unknown>);
    log.push([cmd, args as Record<string, unknown>]);
    return cmd === "start_meeting" ? JSON.stringify({ id: "meeting-1", title: "Standup" }) : [];
  });
});

beforeEach(() => {
  calls.clear();
  log.length = 0;
  saved.config = {};
});

afterEach(() => {
  const meetings = useMeetingStore.getState();
  meetings.stopTimer();
  useMeetingStore.setState({ activeMeeting: null, currentView: "launcher", isRecording: false, aiScenario: "team_meeting" });
  useScenarioStore.setState({ activeScenarioId: "team_meeting", customScenarios: [], scenarioOverrides: {} });
});

describe("startMeetingFlow's scenario", () => {
  it("uses a custom scenario's prompts, even one saved by another window", async () => {
    saved.config.customScenarios = [boardReview];
    await useMeetingStore.getState().startMeetingFlow("Standup", "online", "custom_1");

    expect(calls.get("set_active_scenario")).toEqual({
      systemPrompt: "Board system prompt",
      summaryPrompt: "Board summary prompt",
      questionDetectionPrompt: "Board question prompt",
    });
    expect(calls.get("update_meeting_mode")).toMatchObject({ aiScenario: "custom_1" });
    await vi.waitFor(() => {
      expect(calls.get("plugin:event|emit")).toMatchObject({ payload: { aiScenario: "custom_1" } });
    });
  });

  it("runs as Team Meeting when its custom scenario was deleted", async () => {
    await useMeetingStore.getState().startMeetingFlow("Standup", "online", "custom_1");

    expect(calls.get("set_active_scenario")).toMatchObject({ systemPrompt: BUILT_IN_SCENARIOS[0].system_prompt });
    expect(calls.get("update_meeting_mode")).toMatchObject({ aiScenario: "team_meeting" });
    expect(useMeetingStore.getState().aiScenario).toBe("team_meeting");
  });
});

describe("startMeetingFlow's audio", () => {
  const audio = {
    preset_name: null,
    recording_enabled: false,
    you: { role: "You", device_id: "MacBook mic", is_input_device: true, stt_provider: "soniox", language: "auto" },
    them: { role: "Them", device_id: "MacBook speakers", is_input_device: false, stt_provider: "soniox", language: "en-US" },
  } as unknown as MeetingAudioConfig;
  const muteCalls = () => log.filter(([cmd]) => cmd === "set_source_muted").map(([, a]) => a);
  /** The "Them" side the capture was started with (sent as JSON). */
  const capturedThem = () => {
    const args = log.find(([cmd]) => cmd === "start_capture_per_party")?.[1];
    return args ? JSON.parse(String(args.themConfig)) : undefined;
  };

  beforeEach(() => {
    useConfigStore.setState({ meetingAudioConfig: audio, mutedYou: true, mutedThem: true });
  });

  it("an online meeting starts with both sides unmuted, whatever the last meeting left", async () => {
    await useMeetingStore.getState().startMeetingFlow("Interview", "online", "team_meeting");
    expect(muteCalls()).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "you", muted: false }),
      expect.objectContaining({ source: "them", muted: false }),
    ]));
    expect(muteCalls().some((a) => a.muted === true)).toBe(false);
    expect(useConfigStore.getState()).toMatchObject({ mutedYou: false, mutedThem: false });
    expect(capturedThem()).toMatchObject({ device_id: "MacBook speakers", is_input_device: false });
  });

  it("in person, the room listens on the microphone and You is muted after the reset", async () => {
    await useMeetingStore.getState().startMeetingFlow("Workshop", "in_person", "team_meeting");
    expect(capturedThem()).toMatchObject({ device_id: "MacBook mic", is_input_device: true, language: "en-US" });
    const mutes = muteCalls();
    expect(mutes[mutes.length - 1]).toMatchObject({ source: "you", muted: true });
    expect(useConfigStore.getState().mutedYou).toBe(true);
  });

  it("starts capture once after both windows can receive its first events", async () => {
    const detach = attachMeetingWindow();
    let overlayReady!: (ready: boolean) => void;
    vi.mocked(startOverlayMeeting).mockImplementationOnce(() => new Promise((resolve) => { overlayReady = resolve; }));
    try {
      const meeting = useMeetingStore.getState().startMeetingFlow("Workshop", "online");
      expect(useMeetingStore.getState().startMeetingFlow()).toBe(meeting);
      await vi.waitFor(() => expect(overlayReady).toBeDefined());
      expect(calls.has("start_capture_per_party")).toBe(false);
      useMeetingStore.getState().setMeetingListenersReady("a-previous-meeting");
      overlayReady(true);
      await Promise.resolve();
      expect(calls.has("start_capture_per_party")).toBe(false);
      useMeetingStore.getState().setMeetingListenersReady("meeting-1");
      await meeting;
      expect(log.filter(([command]) => command === "start_meeting")).toHaveLength(1);
      expect(log.filter(([command]) => command === "start_capture_per_party")).toHaveLength(1);
      expect(useMeetingStore.getState().overlayMeetingId).toBe("meeting-1");
    } finally {
      detach();
    }
  });
});
