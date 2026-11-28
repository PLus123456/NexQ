import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { save } from "@tauri-apps/plugin-dialog";
import { copyFile } from "@tauri-apps/plugin-fs";
import { AudioPlayer, formatTime } from "./AudioPlayer";
import { WaveformCanvas } from "./WaveformCanvas";
import { getRecordingFileUrl } from "../lib/ipc";
import { useAudioPlayerStore } from "../stores/audioPlayerStore";
import { showToast } from "../stores/toastStore";

vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => `asset://${path}` }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ copyFile: vi.fn() }));
vi.mock("../lib/ipc", () => ({ getRecordingFileUrl: vi.fn() }));
vi.mock("../stores/toastStore", () => ({ showToast: vi.fn() }));

const player = {
  meetingId: "meeting",
  meetingStartMs: Date.parse("2026-11-27T00:00:00Z"),
  recordingSize: 2048,
  recordingOffsetMs: 0,
  durationMs: 60_000,
  waveformData: null,
};

describe("recording playback", () => {
  beforeEach(() => {
    useAudioPlayerStore.getState().reset();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps the media graph registered across sources and closes it once on unmount", () => {
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    const gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
    const close = vi.fn(async () => {});
    const createMediaElementSource = vi.fn(() => source);
    vi.stubGlobal("AudioContext", class {
      destination = {};
      createMediaElementSource = createMediaElementSource;
      createGain = () => gain;
      close = close;
    });

    const view = (path: string) => <StrictMode><AudioPlayer {...player} recordingPath={path} /></StrictMode>;
    const { container, rerender, unmount } = render(view("/first.ogg"));
    const audio = container.querySelector("audio")!;
    fireEvent.play(audio);
    fireEvent.change(screen.getByRole("slider"), { target: { value: "0" } });
    expect(gain.gain.value).toBe(0);

    rerender(view("/second.ogg"));
    fireEvent.change(screen.getByRole("slider"), { target: { value: "170" } });
    expect(gain.gain.value).toBe(1.7);
    expect(audio.volume).toBe(1);
    expect(createMediaElementSource).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();

    unmount();
    expect(close).toHaveBeenCalledTimes(1);
    expect(useAudioPlayerStore.getState().audioElement).toBeNull();
  });

  it("formats unknown durations and falls back to media metadata", () => {
    const { container } = render(<AudioPlayer {...player} durationMs={NaN} recordingPath="/second.ogg" />);
    const audio = container.querySelector("audio")!;
    expect(formatTime(Infinity)).toBe("00:00");
    expect(formatTime(NaN)).toBe("00:00");
    expect(useAudioPlayerStore.getState().durationMs).toBe(0);
    Object.defineProperty(audio, "duration", { value: 120 });
    fireEvent.durationChange(audio);
    expect(screen.getByText("02:00")).toBeTruthy();
  });

  it("keeps the playback position and resumes when that meeting's WAV is archived", () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const { container, rerender } = render(<AudioPlayer {...player} recordingPath="/meeting.wav" />);
    const audio = container.querySelector("audio")!;
    audio.currentTime = 12;
    fireEvent.playing(audio);
    rerender(<AudioPlayer {...player} recordingPath="/meeting.ogg" />);
    audio.currentTime = 0;
    fireEvent.loadedMetadata(audio);
    expect(audio.currentTime).toBe(12);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("reports an archive format change during the save dialog without writing the wrong format", async () => {
    vi.mocked(getRecordingFileUrl).mockResolvedValueOnce("/meeting.wav").mockResolvedValueOnce("/meeting.ogg");
    vi.mocked(save).mockResolvedValue("/recording.wav");
    render(<AudioPlayer {...player} recordingPath="/meeting.wav" />);
    fireEvent.click(screen.getByRole("button", { name: "Download recording" }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      "The recording finished processing. Choose Download again to save the current format.", "warning",
    ));
    expect(copyFile).not.toHaveBeenCalled();
  });
});

it("draws bookmark and topic markers in recording time", () => {
  const arc = vi.fn();
  const moveTo = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    arc, moveTo, setTransform: vi.fn(), beginPath: vi.fn(), roundRect: vi.fn(),
    fill: vi.fn(), clearRect: vi.fn(), drawImage: vi.fn(), save: vi.fn(), restore: vi.fn(),
    setLineDash: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(100);
  vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(32);
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
  });
  try {
    const start = player.meetingStartMs;
    render(<WaveformCanvas
      waveformData={{ peaks: [[-0.5, 0.5], [-0.8, 0.8]], duration_ms: 10_000, sample_rate: 16_000 }}
      currentTimeMs={0}
      durationMs={10_000}
      meetingStartMs={start}
      recordingOffsetMs={4_000}
      onSeek={vi.fn()}
      topicSections={[{ id: "topic", title: "Discussion", start_ms: 8_000 }]}
      bookmarks={[
        { id: "before", timestamp_ms: start + 1_000, created_at: "" },
        { id: "absolute", timestamp_ms: start + 6_000, created_at: "" },
        { id: "legacy", timestamp_ms: 9_000, created_at: "" },
      ]}
    />);
    expect(arc.mock.calls.map(([x]) => x)).toEqual([20, 50]);
    expect(moveTo).toHaveBeenCalledWith(40, 0);
  } finally {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
