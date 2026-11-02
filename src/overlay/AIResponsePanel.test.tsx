import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ get: async () => undefined, set: async () => {}, onKeyChange: async () => () => {} }),
}));

import { AIResponsePanel } from "./AIResponsePanel";
import { useStreamStore } from "../stores/streamStore";
import { useMeetingStore } from "../stores/meetingStore";

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
});
