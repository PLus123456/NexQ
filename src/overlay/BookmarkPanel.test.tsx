import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../hooks/useAudioLevel", () => ({
  useAudioLevel: () => ({ micLevel: 0.2, systemLevel: 0.2 }),
}));

beforeAll(() => {
  mockWindows("overlay");
  mockIPC(() => []);
  Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });
});

import { BookmarkPanel } from "./BookmarkPanel";
import { TranscriptPanel } from "./TranscriptPanel";
import { useBookmarkHotkey } from "../hooks/useBookmarkHotkey";
import { useMeetingShortcuts } from "../hooks/useMeetingShortcuts";
import { useBookmarkStore } from "../stores/bookmarkStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useTranscriptStore } from "../stores/transcriptStore";
import type { TranscriptSegment } from "../lib/types";

const T0 = 1_700_000_000_000;
const ROW_HEIGHT = 50;
const VIEWPORT_HEIGHT = 240;

function makeSegments(count: number): TranscriptSegment[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `seg-${i + 1}`,
    text: `Transcript line number ${i + 1}`,
    speaker: i % 2 === 0 ? "Them" : "User",
    speaker_id: i % 2 === 0 ? "them" : "you",
    timestamp_ms: T0 + (i + 1) * 5_000,
    is_final: true,
    confidence: 0.95,
  }));
}

/**
 * Installs realistic scroll geometry on HTMLElement.prototype BEFORE TranscriptPanel
 * mounts, so mount-time `scrollToBottom()` sees the real `scrollHeight`/`clientHeight`
 * just like a browser viewport (and would animate to segment 48 if not prevented).
 */
function installViewportMock() {
  const origClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  const origScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
  const origScrollIntoView = Element.prototype.scrollIntoView;
  const calls: string[] = [];

  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return this.hasAttribute?.("data-scroll-container") ? VIEWPORT_HEIGHT : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      if (!this.hasAttribute?.("data-scroll-container")) return 0;
      return this.querySelectorAll("[data-segment-id]").length * ROW_HEIGHT;
    },
  });
  Element.prototype.scrollIntoView = function () {
    const id = this.getAttribute("data-segment-id");
    if (!id) return;
    calls.push(id);
    const container = this.closest<HTMLElement>("[data-scroll-container]");
    if (!container) return;
    const rows = [...container.querySelectorAll<HTMLElement>("[data-segment-id]")];
    const idx = rows.indexOf(this as HTMLElement);
    if (idx < 0) return;
    const maxScroll = Math.max(0, rows.length * ROW_HEIGHT - VIEWPORT_HEIGHT);
    const top = idx * ROW_HEIGHT;
    container.scrollTop = Math.max(0, Math.min(maxScroll, top - (VIEWPORT_HEIGHT - ROW_HEIGHT) / 2));
    fireEvent.scroll(container);
  };

  const container = () => document.querySelector<HTMLElement>("[data-scroll-container]");
  const isInViewport = (segmentId: string) => {
    const el = container();
    if (!el) return false;
    const rows = [...el.querySelectorAll<HTMLElement>("[data-segment-id]")];
    const idx = rows.findIndex((r) => r.dataset.segmentId === segmentId);
    if (idx < 0) return false;
    const rowTop = idx * ROW_HEIGHT;
    const rowBottom = rowTop + ROW_HEIGHT;
    return rowBottom > el.scrollTop && rowTop < el.scrollTop + VIEWPORT_HEIGHT;
  };
  const restore = () => {
    if (origClientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", origClientHeight);
    else delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
    if (origScrollHeight) Object.defineProperty(HTMLElement.prototype, "scrollHeight", origScrollHeight);
    else delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
    Element.prototype.scrollIntoView = origScrollIntoView;
  };

  return { calls, container, isInViewport, restore };
}

function Harness({ initialTranscriptOpen = false }: { initialTranscriptOpen?: boolean }) {
  const [open, setOpen] = useState(initialTranscriptOpen);
  const addBookmarkAtNow = useBookmarkHotkey();
  useMeetingShortcuts({
    addBookmark: addBookmarkAtNow,
    toggleStats: () => {},
    toggleBookmarks: () => {},
    toggleMute: () => {},
    closeAllPanels: () => setOpen(false),
    toggleDevLog: () => {},
  });
  return (
    <div>
      {open && <TranscriptPanel />}
      <BookmarkPanel onOpenTranscript={() => setOpen(true)} />
    </div>
  );
}

let viewport: ReturnType<typeof installViewportMock>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0 + 245_000);
  viewport = installViewportMock();
  useMeetingStore.setState({ isRecording: true, audioMode: "online", meetingStartTime: T0 });
  useTranscriptStore.setState({ segments: [], searchQuery: "", autoScroll: true });
  useBookmarkStore.getState().clearBookmarks();
});

afterEach(() => {
  cleanup();
  viewport.restore();
  vi.useRealTimers();
  useTranscriptStore.getState().clearSegments();
  useTranscriptStore.getState().setAutoScroll(true);
  useBookmarkStore.getState().clearBookmarks();
});

describe("BookmarkPanel + TranscriptPanel regressions", () => {
  it("keeps segment 4 in the viewport after clicking its bookmark while the drawer was closed (48 segments)", () => {
    const segments = makeSegments(48);
    useTranscriptStore.setState({ segments, autoScroll: true });
    useBookmarkStore.getState().addBookmark(segments[3].timestamp_ms, "Point four", "seg-4");

    render(<Harness initialTranscriptOpen={false} />);
    expect(viewport.container()).toBeNull();

    // Click bookmark for segment 4 while transcript drawer is closed.
    fireEvent.click(screen.getByRole("button", { name: "00:20" }));
    expect(viewport.container()).not.toBeNull();

    // Let rAF jump + full scroll animation duration (> 400ms) settle.
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(viewport.calls).toContain("seg-4");
    expect(useTranscriptStore.getState().autoScroll).toBe(false);
    expect(viewport.isInViewport("seg-4")).toBe(true);
    expect(viewport.isInViewport("seg-48")).toBe(false);

    // Even when a new segment arrives afterward, the viewport stays at segment 4.
    act(() => {
      useTranscriptStore.getState().appendSegment({
        id: "seg-49",
        text: "Transcript line number 49",
        speaker: "Them",
        speaker_id: "them",
        timestamp_ms: T0 + 49 * 5_000,
        is_final: true,
        confidence: 0.95,
      });
      vi.advanceTimersByTime(600);
    });
    expect(viewport.isInViewport("seg-4")).toBe(true);
    expect(viewport.isInViewport("seg-49")).toBe(false);
  });

  it("does not re-enable auto-scroll when smooth-jumping up from the bottom of an open transcript", () => {
    const segments = makeSegments(48);
    useTranscriptStore.setState({ segments, autoScroll: true });
    useBookmarkStore.getState().addBookmark(segments[3].timestamp_ms, "Point four", "seg-4");

    render(<Harness initialTranscriptOpen={true} />);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    const el = viewport.container()!;
    const maxScroll = 48 * ROW_HEIGHT - VIEWPORT_HEIGHT;
    expect(el.scrollTop).toBe(maxScroll);

    // Simulate browser smooth scroll emitting an intermediate frame still within 30px of bottom
    // before settling on segment 4.
    const seg4 = document.querySelector<HTMLElement>('[data-segment-id="seg-4"]')!;
    seg4.scrollIntoView = vi.fn(() => {
      el.scrollTop = maxScroll - 8;
      fireEvent.scroll(el);
      el.scrollTop = 60;
      fireEvent.scroll(el);
    });

    fireEvent.click(screen.getByRole("button", { name: "00:20" }));
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(useTranscriptStore.getState().autoScroll).toBe(false);
    expect(viewport.isInViewport("seg-4")).toBe(true);
    expect(el.scrollTop).toBe(60);
  });

  it("Ctrl+B anchors a new bookmark to the current transcript line and clicking it jumps there", () => {
    const segments = makeSegments(10);
    useTranscriptStore.setState({ segments, autoScroll: true });
    // Current meeting time is 31s -> closest to seg-6 (at 30s).
    vi.setSystemTime(T0 + 31_000);

    render(<Harness initialTranscriptOpen={false} />);

    // Pressing Ctrl+B creates exactly one bookmark (not duplicated by useMeetingShortcuts).
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    const bookmarks = useBookmarkStore.getState().bookmarks;
    expect(bookmarks).toHaveLength(1);
    expect(bookmarks[0].segment_id).toBe("seg-6");
    expect(bookmarks[0].timestamp_ms).toBe(T0 + 31_000);

    // Click the created bookmark chip (00:31) to open the drawer and jump to seg-6.
    fireEvent.click(screen.getByRole("button", { name: "00:31" }));
    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(viewport.calls).toEqual(["seg-6"]);
    expect(viewport.isInViewport("seg-6")).toBe(true);
  });

  it("jumps a legacy offset-only bookmark (no segment_id) to the nearest line by in-meeting time", () => {
    const segments = makeSegments(12); // 5s, 10s, 15s, 20s, 25s, ...
    useTranscriptStore.setState({ segments, autoScroll: true });
    // Legacy Ctrl+B bookmark stored only the elapsed offset (19s) with no segment_id.
    useBookmarkStore.getState().addBookmark(19_000, "Legacy hotkey bookmark");

    render(<Harness initialTranscriptOpen={false} />);

    // Displays elapsed time properly instead of clamping to 00:00.
    fireEvent.click(screen.getByRole("button", { name: "00:19" }));
    act(() => {
      vi.advanceTimersByTime(600);
    });

    // Nearest line to 19s is seg-4 (at 20s).
    expect(viewport.calls).toEqual(["seg-4"]);
    expect(viewport.isInViewport("seg-4")).toBe(true);
  });

  it("resolves a Ctrl+B bookmark anchored to a segment that merged into an earlier line", () => {
    const mergedPair: TranscriptSegment[] = [
      { id: "s1", text: "First sentence.", speaker: "Them", speaker_id: "them", timestamp_ms: T0 + 10_000, is_final: true, confidence: 0.95 },
      { id: "s2", text: "Second sentence right after.", speaker: "Them", speaker_id: "them", timestamp_ms: T0 + 11_000, is_final: true, confidence: 0.95 },
    ];
    useTranscriptStore.setState({ segments: mergedPair, autoScroll: true });
    vi.setSystemTime(T0 + 11_500);

    render(<Harness initialTranscriptOpen={false} />);
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(useBookmarkStore.getState().bookmarks[0].segment_id).toBe("s2");

    fireEvent.click(screen.getByRole("button", { name: "00:11" }));
    act(() => {
      vi.advanceTimersByTime(600);
    });

    // s2 merged into s1's rendered DOM row, so jumping still scrolls to s1.
    expect(viewport.calls).toEqual(["s1"]);
  });
});
