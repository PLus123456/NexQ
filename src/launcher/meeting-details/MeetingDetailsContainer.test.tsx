import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MeetingDetails } from "./MeetingDetailsContainer";
import { getAllMeetingTranslations, getMeeting, getRecordingInfo, renameSpeaker } from "../../lib/ipc";
import { onTranslationResult } from "../../lib/events";
import { useTranslationStore } from "../../stores/translationStore";
import type { Meeting, RecordingInfo, TranslationResult } from "../../lib/types";

vi.mock("../../lib/ipc", async (original) => ({
  ...await original<typeof import("../../lib/ipc")>(),
  getMeeting: vi.fn(),
  getRecordingInfo: vi.fn(),
  getAllMeetingTranslations: vi.fn(),
  renameSpeaker: vi.fn(),
  startPastMeetingSession: vi.fn(async () => {}),
  closePastMeetingSession: vi.fn(async () => {}),
}));

vi.mock("../../lib/events", async (original) => ({
  ...await original<typeof import("../../lib/events")>(),
  onRecordingReady: vi.fn(async () => () => {}),
  onTranslationResult: vi.fn(async () => () => {}),
  onTranslationError: vi.fn(async () => () => {}),
}));

vi.mock("../../hooks/useMeetingChat", () => ({
  useMeetingChat: () => ({ items: [] }),
  answeredExchanges: () => [],
}));
vi.mock("../../components/AudioPlayer", () => ({
  AudioPlayer: ({ recordingPath }: { recordingPath: string }) => <div>{recordingPath}</div>,
}));
vi.mock("./TranscriptView", () => ({
  TranscriptView: ({ translations, initialScrollToIndex }: {
    translations: Map<string, TranslationResult>;
    initialScrollToIndex?: number | null;
  }) => (
    <div data-testid="transcript" data-scroll-index={initialScrollToIndex ?? undefined}>
      {translations.get("acc_1")?.translated_text}
    </div>
  ),
}));
vi.mock("./MeetingTabBar", () => ({
  MeetingTabBar: ({ setActiveTab }: { setActiveTab: (tab: string) => void }) => (
    <div>
      <button onClick={() => setActiveTab("transcript")}>Transcript tab</button>
      <button onClick={() => setActiveTab("speakers")}>Speakers tab</button>
      <button onClick={() => setActiveTab("bookmarks")}>Bookmarks tab</button>
    </div>
  ),
}));

function meeting(id: string): Meeting {
  return {
    id, title: id, start_time: "2026-11-27T00:00:00Z", end_time: null, duration_seconds: 30,
    summary: null, config_snapshot: null, ai_interactions: [],
    transcript: [{
      id: "acc_1", text: "Hello", speaker: "Them", speaker_id: "them", speaker_tag: "S1",
      is_final: true, confidence: 1, timestamp_ms: Date.parse("2026-11-27T00:00:01Z"),
    }],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const onBack = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMeeting).mockImplementation(async (id) => meeting(id));
  vi.mocked(getRecordingInfo).mockResolvedValue(null);
  vi.mocked(getAllMeetingTranslations).mockResolvedValue([]);
  vi.mocked(renameSpeaker).mockResolvedValue(undefined);
  useTranslationStore.setState({ targetLang: "fr" });
});

describe("meeting history detail", () => {
  it("discards a previous meeting's slow recording and filters translation events", async () => {
    const delayedRecording = deferred<RecordingInfo | null>();
    vi.mocked(getRecordingInfo).mockImplementation((id) => id === "First meeting" ? delayedRecording.promise : Promise.resolve(null));
    const { rerender } = render(<MeetingDetails meetingId="First meeting" onBack={onBack} />);
    await waitFor(() => expect(getRecordingInfo).toHaveBeenCalledWith("First meeting"));
    rerender(<MeetingDetails meetingId="Second meeting" onBack={onBack} />);
    await screen.findByText("Second meeting");
    await act(async () => {
      delayedRecording.resolve({
        path: "/recordings/first.ogg", size_bytes: 100, offset_ms: 1000,
        waveform_path: "", duration_ms: 3000,
      });
    });
    expect(screen.queryByText("/recordings/first.ogg")).toBeNull();

    const callback = vi.mocked(onTranslationResult).mock.lastCall![0];
    const base = {
      segment_id: "acc_1", target_lang: "fr", source_lang: "en",
      original_text: "Hello", provider: "test",
    };
    act(() => callback({ ...base, meeting_id: "First meeting", translated_text: "Wrong meeting" }));
    act(() => callback({ ...base, meeting_id: "Second meeting", target_lang: "de", translated_text: "Wrong language" }));
    expect(screen.queryByText("Wrong meeting")).toBeNull();
    expect(screen.queryByText("Wrong language")).toBeNull();
    act(() => callback({ ...base, meeting_id: "Second meeting", translated_text: "Bonjour" }));
    expect(screen.getByText("Bonjour")).toBeTruthy();
  });

  it("saves a speaker name to the meeting and retains it when changing tabs", async () => {
    render(<MeetingDetails meetingId="Speaker meeting" onBack={onBack} />);
    fireEvent.click(await screen.findByRole("button", { name: "Speakers tab" }));
    fireEvent.click(screen.getByRole("button", { name: /Rename Speaker 1/i }));
    const name = screen.getByRole("textbox");
    fireEvent.change(name, { target: { value: "Alex" } });
    fireEvent.keyDown(name, { key: "Enter" });
    expect(renameSpeaker).toHaveBeenCalledWith("Speaker meeting", "them:S1", "Alex");
    await screen.findByText("Alex");

    fireEvent.click(screen.getByRole("button", { name: "Transcript tab" }));
    fireEvent.click(screen.getByRole("button", { name: "Speakers tab" }));
    expect(screen.getByText("Alex")).toBeTruthy();
  });

  it("navigates a legacy elapsed bookmark to the matching epoch transcript line", async () => {
    const saved = meeting("Legacy bookmark");
    saved.transcript.push({ ...saved.transcript[0], id: "second", timestamp_ms: Date.parse(saved.start_time) + 5_000 });
    saved.bookmarks = [{ id: "bookmark", timestamp_ms: 5_000, created_at: saved.start_time }];
    vi.mocked(getMeeting).mockResolvedValue(saved);
    render(<MeetingDetails meetingId={saved.id} onBack={onBack} />);
    fireEvent.click(await screen.findByRole("button", { name: "Bookmarks tab" }));
    fireEvent.click(screen.getByRole("button", { name: "0:05" }));
    expect(screen.getByTestId("transcript")).toHaveAttribute("data-scroll-index", "1");
  });
});
