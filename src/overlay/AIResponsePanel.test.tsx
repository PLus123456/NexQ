import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ get: async () => undefined, set: async () => {}, onKeyChange: async () => () => {} }),
}));

import { AIResponsePanel } from "./AIResponsePanel";
import { useStreamStore } from "../stores/streamStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useConfigStore } from "../stores/configStore";

const openSourceFile = vi.hoisted(() => vi.fn());
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  openSourceFile: (...args: unknown[]) => openSourceFile(...args),
}));

const T0 = 1_700_000_000_000;
const s = () => useStreamStore.getState();

function answer(mode: string, text: string) {
  act(() => {
    const id = crypto.randomUUID();
    s().setPending(mode, id);
    s().startStream(mode as never, "haiku", "Claude CLI", { requestId: id });
    s().appendToken(text);
    s().endStream(5);
  });
}

const tabs = () => within(screen.getByRole("tablist")).getAllByRole("tab").map((t) => t.textContent);

describe("AIResponsePanel", () => {
  it("marks a consumed prepared answer and keeps the mark in response history", () => {
    s().resetForMeeting();
    render(<AIResponsePanel />);
    act(() => {
      s().startStream("Assist", "mock", "mock", { prepared: true });
      s().appendToken("Ready before the question");
      s().endStream(0);
    });
    expect(screen.getByText("Prepared in advance")).toBeInTheDocument();
    expect(s().responseHistory[0].prepared).toBe(true);
    answer("Recap", "Later answer");
    fireEvent.click(screen.getByRole("tab", { name: "Assist" }));
    expect(screen.getByText("Prepared in advance")).toBeInTheDocument();
  });
  beforeEach(() => {
    s().resetForMeeting();
    useMeetingStore.setState({ meetingStartTime: T0 });
  });
  afterEach(() => vi.useRealTimers());

  it("an answer never loads a remote image", () => {
    const { container } = render(<AIResponsePanel />);
    answer("Assist", "Look ![x](https://evil.test/p.png?d=1) here");
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("[Image: x]");
  });

  it("Current is the newest answer and is not repeated as a tab", () => {
    render(<AIResponsePanel />);
    answer("Assist", "first");
    answer("Shorten", "second");
    expect(tabs()).toEqual(["Current", "Assist"]);
    expect(screen.getByText("second")).toBeInTheDocument();
  });

  it("shows Current + the 4 previous answers; History lists them all and opens any", () => {
    render(<AIResponsePanel />);
    for (let i = 0; i < 7; i++) answer(i % 2 ? "Recap" : "Assist", `answer ${i}`);
    expect(tabs()).toHaveLength(5);

    fireEvent.click(screen.getByRole("button", { name: "History, 7 answers" }));
    const list = screen.getByRole("dialog", { name: "All answers" });
    const items = within(list).getAllByRole("button").filter((b) => b.getAttribute("aria-label") !== "Close answer history");
    expect(items).toHaveLength(7);
    expect(items[0]).toHaveAttribute("aria-current", "true"); // the answer on screen
    expect(items[6]).toHaveTextContent("answer 0");

    fireEvent.click(items[6]);
    expect(screen.queryByRole("dialog", { name: "All answers" })).toBeNull();
    expect(screen.getByText("answer 0")).toBeInTheDocument();

    // Pin it from there: it gets its own pinned tab.
    fireEvent.click(screen.getByRole("button", { name: "Pin response" }));
    expect(s().pinnedResponses.map((r) => r.content)).toEqual(["answer 0"]);
    expect(tabs()).toHaveLength(6);
  });

  it("history list: arrows move, Escape closes", () => {
    render(<AIResponsePanel />);
    answer("Assist", "a");
    answer("Recap", "b");
    fireEvent.click(screen.getByRole("button", { name: /History, 2/ }));
    const list = screen.getByRole("dialog", { name: "All answers" });
    const [newest, older] = within(list).getAllByRole("button").slice(1);
    expect(document.activeElement).toBe(newest);
    fireEvent.keyDown(newest, { key: "ArrowDown" });
    expect(document.activeElement).toBe(older);
    fireEvent.keyDown(older, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "All answers" })).toBeNull();
  });

  it("while waiting: phase, model, scope, lines sent and a live timer; then the timing", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    render(<AIResponsePanel />);

    act(() => s().setPending("FollowUp", "r1"));
    expect(screen.getByText("Sending…")).toBeInTheDocument();
    expect(screen.getByText("F/U")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(300);
      s().startStream("FollowUp", "haiku", "Claude CLI", {
        requestId: "r1",
        scopeLabel: "Last 5 min",
        newLines: 0,
        sessionKey: "live:m:fast",
      });
    });
    expect(screen.getByText("Waiting for the first words…")).toBeInTheDocument();
    expect(screen.getByText("haiku · Claude CLI · Last 5 min · no new transcript since last answer")).toBeInTheDocument();
    expect(screen.getByText("0.3 s")).toBeInTheDocument();

    act(() => s().setPhase("thinking"));
    expect(screen.getByText("Thinking…")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(300);
      s().appendToken("Hello");
    });
    expect(screen.getByText("Writing…")).toBeInTheDocument();
    expect(screen.getByText("Hello")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(600);
      s().endStream(1000);
    });
    expect(screen.queryByText("Writing…")).toBeNull();
    expect(screen.getByText("Last 5 min · 1.2 s · first words 0.6 s")).toBeInTheDocument();
  });

  it("shows activity lines while streaming and chips after; a notes chip opens the file", async () => {
    openSourceFile.mockResolvedValue(undefined);
    render(<AIResponsePanel />);
    act(() => {
      s().setPending("Assist", "r1", { notes: true, tools: false });
      s().startStream("Assist", "m", "Claude CLI", { requestId: "r1" });
      s().addActivity("r1", {
        kind: "notes",
        label: "Searching notes for 'Dana'",
        chip: { kind: "notes", label: "Dana.md", path: "D:\\V\\Dana.md" },
      });
      s().appendToken("Dana owns it.");
    });
    expect(screen.getByText("Searching notes for 'Dana'")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Dana\.md/ })).toBeNull();

    act(() => s().endStream(5));
    expect(screen.queryByText("Searching notes for 'Dana'")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Dana\.md/ }));
    expect(openSourceFile).toHaveBeenCalledWith("D:\\V\\Dana.md");
  });

  it("a sources-failure notice shows above the answer, while it streams and after", () => {
    render(<AIResponsePanel />);
    act(() => {
      s().setPending("Assist", "r2");
      // Before llm_stream_start, as the backend sends it.
      s().addActivity("r2", { kind: "notice", label: "Your sources were not used: Mira did not start.", chip: null });
      s().startStream("Assist", "m", "Claude CLI", { requestId: "r2" });
      s().appendToken("Answer text");
    });
    const notice = screen.getByText("Your sources were not used: Mira did not start.");
    const text = screen.getByText("Answer text");
    expect(notice.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    act(() => s().endStream(5));
    expect(screen.getByText("Your sources were not used: Mira did not start.")).toBeInTheDocument();
  });

  it("an answer without sources shows no chip row", () => {
    render(<AIResponsePanel />);
    answer("Assist", "plain answer");
    expect(screen.queryByLabelText("Sources used")).toBeNull();
  });

  it("pauses auto-scroll when the user scrolls up and resumes on clicking Back to latest", () => {
    render(<AIResponsePanel />);
    act(() => {
      s().startStream("Assist", "m", "p", { requestId: "r-scroll" });
      s().appendToken("Long answer text\n".repeat(30));
    });
    const scrollEl = screen.getByRole("tabpanel", { name: "AI response content" });
    Object.defineProperty(scrollEl, "scrollHeight", { value: 800, configurable: true });
    Object.defineProperty(scrollEl, "clientHeight", { value: 300, configurable: true });
    scrollEl.scrollTop = 100;

    fireEvent.scroll(scrollEl);
    const backBtn = screen.getByRole("button", { name: "Back to latest" });
    expect(backBtn).toBeInTheDocument();

    // Streaming another token does not snap the user back to bottom while paused.
    act(() => s().appendToken("More words"));
    expect(scrollEl.scrollTop).toBe(100);

    // Clicking "Back to latest" snaps to bottom and resumes following.
    fireEvent.click(backBtn);
    expect(scrollEl.scrollTop).toBe(800);
    expect(screen.queryByRole("button", { name: "Back to latest" })).toBeNull();
  });

  it("collapses typography controls into a popover and keeps the popover open while picking a color", () => {
    useConfigStore.setState({ aiResponseFontSize: 12, aiResponseTextColor: "#d4d4d8", aiResponseLineHeight: 1.6, aiResponseHPad: 0, aiResponseAlign: "left" });
    render(<AIResponsePanel />);
    // Controls are hidden behind the popover trigger by default.
    expect(screen.queryByRole("dialog", { name: "Answer typography" })).toBeNull();

    const styleBtn = screen.getByRole("button", { name: "Text & layout settings" });
    fireEvent.click(styleBtn);
    const dialog = screen.getByRole("dialog", { name: "Answer typography" });
    expect(dialog).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Larger" }));
    expect(useConfigStore.getState().aiResponseFontSize).toBe(13);

    // Open ColorPickerButton (which renders its own fixed z-[9999] portal) and click a swatch.
    fireEvent.click(within(dialog).getByTitle("AI text color"));
    const swatch = screen.getByTitle("Cyan");
    fireEvent.mouseDown(swatch);
    fireEvent.click(swatch);
    expect(useConfigStore.getState().aiResponseTextColor).toBe("#67e8f9");
    expect(screen.getByRole("dialog", { name: "Answer typography" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Answer typography" })).toBeNull();
  });

  it("combines tabs, history, copy, pin and style in the single bottom bar", () => {
    render(<AIResponsePanel />);
    answer("Assist", "first");
    answer("Shorten", "second");
    const footer = screen.getByTestId("answer-footer-bar");
    expect(within(footer).getByRole("tablist")).toBeInTheDocument();
    expect(within(footer).getByRole("button", { name: /History, 2/ })).toBeInTheDocument();
    expect(within(footer).getByRole("button", { name: "Copy to clipboard" })).toBeInTheDocument();
    expect(within(footer).getByRole("button", { name: "Pin response" })).toBeInTheDocument();
    expect(within(footer).getByRole("button", { name: "Text & layout settings" })).toBeInTheDocument();
  });
});
