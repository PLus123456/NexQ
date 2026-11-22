import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioLevelEvent, MeetingAudioConfig } from "../lib/types";

const { levelHandlers, logToFile } = vi.hoisted(() => ({
  levelHandlers: new Set<(e: AudioLevelEvent) => void>(),
  logToFile: vi.fn(),
}));

vi.mock("../lib/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/events")>()),
  onAudioLevel: (handler: (e: AudioLevelEvent) => void) => {
    levelHandlers.add(handler);
    return Promise.resolve(() => {
      levelHandlers.delete(handler);
    });
  },
}));
vi.mock("../lib/logger", () => ({ logToFile }));

import { NoTranscriptBanner } from "./NoTranscriptBanner";
import { OverlayView } from "./OverlayView";
import { addLevel, EMPTY_WATCH, NO_TRANSCRIPT_AFTER_MS, shouldWarn } from "../lib/sttWatchdog";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useTranscriptStore } from "../stores/transcriptStore";

beforeAll(() => {
  mockWindows("overlay");
  mockIPC(() => []);
  Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollTo = () => {};
});

const audioConfig: MeetingAudioConfig = {
  you: { role: "You", device_id: "mic", is_input_device: true, stt_provider: "web_speech" },
  them: { role: "Them", device_id: "out", is_input_device: false, stt_provider: "parakeet_tdt" },
  recording_enabled: false,
  preset_name: null,
};

/** Feed `seconds` of audio for a source, one level event every 150 ms. */
function hear(source: AudioLevelEvent["source"], seconds: number, level = 0.4) {
  for (let t = 0; t < seconds * 1000; t += 150) {
    act(() => {
      vi.advanceTimersByTime(150);
      for (const handler of [...levelHandlers]) {
        handler({ source, level, peak: level });
      }
    });
  }
}

describe("sttWatchdog", () => {
  it("counts only loud audio, and caps gaps between events", () => {
    let watch = addLevel(EMPTY_WATCH, 0.4, 0);
    watch = addLevel(watch, 0.4, 500);
    watch = addLevel(watch, 0.01, 1000); // quiet: not counted
    watch = addLevel(watch, 0.4, 61_000); // a minute-long gap counts as 1 s at most
    expect(watch.heardMs).toBe(1500);
    expect(shouldWarn({ heardMs: NO_TRANSCRIPT_AFTER_MS, lastAt: 0 }, false, false)).toBe(true);
    expect(shouldWarn({ heardMs: NO_TRANSCRIPT_AFTER_MS, lastAt: 0 }, true, false)).toBe(false);
    expect(shouldWarn({ heardMs: NO_TRANSCRIPT_AFTER_MS, lastAt: 0 }, false, true)).toBe(false);
  });
});

describe("NoTranscriptBanner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    logToFile.mockClear();
    useMeetingStore.setState({ isRecording: true, activeMeeting: { id: "m1" } as never });
    useConfigStore.setState({ meetingAudioConfig: audioConfig, mutedYou: false, mutedThem: false });
    useTranscriptStore.setState({ segments: [] });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("warns about a party heard for 30 s without any transcript, and logs it once", async () => {
    render(<NoTranscriptBanner />);
    await act(async () => {}); // listener registered
    hear("System", 20);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    hear("System", 12);
    expect(screen.getByRole("alert")).toHaveTextContent("No transcript from Them");
    expect(screen.getByRole("alert")).toHaveTextContent("Parakeet TDT");
    hear("System", 5);
    expect(logToFile).toHaveBeenCalledTimes(1);
    expect(logToFile.mock.calls[0][2]).toMatch(/'Them' audio heard .* parakeet_tdt returned no transcript/);
  });

  it("stays quiet when that party has transcript lines, or is muted", async () => {
    useTranscriptStore.setState({
      segments: [{ id: "1", text: "hello", speaker: "Them", timestamp_ms: 0, is_final: true, confidence: 1 }],
    });
    useConfigStore.setState({ mutedYou: true });
    render(<NoTranscriptBanner />);
    await act(async () => {});
    hear("System", 35);
    hear("Mic", 35);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("can be dismissed, and goes away once text arrives", async () => {
    render(<NoTranscriptBanner />);
    await act(async () => {});
    hear("System", 31);
    hear("Mic", 31);
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: /Dismiss the You/ }));
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    act(() => {
      useTranscriptStore.setState({
        segments: [{ id: "1", text: "hi", speaker: "Them", timestamp_ms: 0, is_final: false, confidence: 1 }],
      });
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("tracks 30s of audio while the OverlayView transcript drawer stays closed, logs once, shows immediately on open, and never re-logs across drawer toggles", async () => {
    useMeetingStore.setState({
      isRecording: true,
      audioMode: "online",
      currentView: "overlay",
      activeMeeting: { id: "m-closed-drawer", title: "Standup" } as never,
    });

    render(<OverlayView />);
    await act(async () => {});

    // Transcript drawer starts closed.
    expect(screen.queryByTestId("transcript-drawer")).toBeNull();

    // Feed 31 seconds of audio with no transcript while the drawer remains closed.
    hear("System", 31);
    expect(logToFile).toHaveBeenCalledTimes(1);
    expect(logToFile.mock.calls[0][2]).toMatch(/'Them' audio heard .* parakeet_tdt returned no transcript/);

    // Open the drawer: warning banner appears immediately without needing more audio.
    fireEvent.click(screen.getByRole("button", { name: "Show transcript" }));
    expect(screen.getByTestId("transcript-drawer")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("No transcript from Them");
    expect(screen.getByRole("alert")).toHaveTextContent("Parakeet TDT");
    expect(logToFile).toHaveBeenCalledTimes(1);

    // Repeatedly close and reopen the drawer: alert stays visible and never logs again.
    for (let i = 0; i < 3; i++) {
      fireEvent.click(screen.getByRole("button", { name: "Hide transcript" }));
      expect(screen.queryByTestId("transcript-drawer")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Show transcript" }));
      expect(screen.getByRole("alert")).toHaveTextContent("No transcript from Them");
    }
    expect(logToFile).toHaveBeenCalledTimes(1);

    // Dismissing persists across drawer toggles, and closing the drawer keeps watching the other party.
    fireEvent.click(screen.getByRole("button", { name: /Dismiss the Them/ }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide transcript" }));
    hear("Mic", 31);
    expect(logToFile).toHaveBeenCalledTimes(2);
    expect(logToFile.mock.calls[1][2]).toMatch(/'You' audio heard .* web_speech returned no transcript/);
    fireEvent.click(screen.getByRole("button", { name: "Show transcript" }));
    expect(screen.getByRole("alert")).toHaveTextContent("No transcript from You");
    expect(logToFile).toHaveBeenCalledTimes(2);
  });
});
