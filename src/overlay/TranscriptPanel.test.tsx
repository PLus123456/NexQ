import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../hooks/useAudioLevel", () => ({
  useAudioLevel: () => ({ micLevel: 0.4, systemLevel: 0.2 }),
}));

beforeAll(() => {
  mockWindows("overlay");
  mockIPC(() => []);
  Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });
});

import { TranscriptPanel } from "./TranscriptPanel";
import { useTranscriptStore } from "../stores/transcriptStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useConfigStore } from "../stores/configStore";
import { useTranslationStore } from "../stores/translationStore";
import type { TranscriptSegment } from "../lib/types";

const segment = (id: string, text: string): TranscriptSegment => ({
  id,
  text,
  speaker: "Them",
  speaker_id: "them",
  timestamp_ms: Date.now(),
  is_final: true,
  confidence: 0.95,
});

beforeEach(() => {
  useMeetingStore.setState({ isRecording: true, audioMode: "online" });
  useConfigStore.setState({
    transcriptFontSize: 13,
    translationFontSize: 12,
    transcriptTextColor: "#e4e4e7",
    translationTextColor: "#fbbf24",
    mutedYou: false,
    mutedThem: false,
  });
  useTranscriptStore.setState({
    segments: [segment("s1", "How did you handle rate limiting?")],
    searchQuery: "",
    autoScroll: true,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  useTranslationStore.getState().clearTranslations();
  useTranscriptStore.setState({ segments: [], searchQuery: "", autoScroll: true });
});

describe("TranscriptPanel", () => {
  it("follows content that grows as a translation arrives, unless the user scrolled up", async () => {
    vi.useFakeTimers();
    let resize!: () => void;
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect() {}
    });
    useTranslationStore.setState({ displayMode: "inline" });
    const { container } = render(<TranscriptPanel />);
    const scroll = container.querySelector<HTMLDivElement>("[data-scroll-container]")!;
    let height = 200;
    Object.defineProperty(scroll, "scrollHeight", { get: () => height });
    Object.defineProperty(scroll, "clientHeight", { value: 100 });
    scroll.scrollTop = 100;
    fireEvent.scroll(scroll);

    act(() => {
      useTranslationStore.getState().addTranslation({
        segment_id: "s1", original_text: "How did you handle rate limiting?", translated_text: "如何限流？",
        source_lang: "en", target_lang: "zh-CN", provider: "soniox",
      });
    });
    expect(screen.getByText("如何限流？")).toBeInTheDocument();
    height += 60;
    resize();
    await act(async () => { await vi.advanceTimersByTimeAsync(450); });
    expect(scroll.scrollTop).toBe(160);

    scroll.scrollTop = 100;
    fireEvent.scroll(scroll);
    expect(useTranscriptStore.getState().autoScroll).toBe(false);
    height += 80;
    resize();
    await act(async () => { await vi.advanceTimersByTimeAsync(450); });
    expect(scroll.scrollTop).toBe(100);
  });

  it("collapses typography controls into a popover while keeping search and audio bars", () => {
    render(<TranscriptPanel />);
    expect(screen.getByPlaceholderText("Search transcript...")).toBeInTheDocument();
    expect(screen.getByText("How did you handle rate limiting?")).toBeInTheDocument();
    // Typography controls are hidden behind the popover button initially.
    expect(screen.queryByRole("dialog", { name: "Transcript typography" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Transcript typography" }));
    const dialog = screen.getByRole("dialog", { name: "Transcript typography" });
    expect(dialog).toBeInTheDocument();

    const largerButtons = within(dialog).getAllByRole("button", { name: "Larger" });
    fireEvent.click(largerButtons[0]);
    expect(useConfigStore.getState().transcriptFontSize).toBe(14);
    fireEvent.click(largerButtons[1]);
    expect(useConfigStore.getState().translationFontSize).toBe(13);

    // Picking a color inside ColorPickerButton's portal does not close the popover prematurely.
    fireEvent.click(within(dialog).getByTitle("Text color"));
    const swatch = screen.getByTitle("Sky");
    fireEvent.mouseDown(swatch);
    fireEvent.click(swatch);
    expect(useConfigStore.getState().transcriptTextColor).toBe("#7dd3fc");
    expect(screen.getByRole("dialog", { name: "Transcript typography" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Transcript typography" })).toBeNull();
  });
});
