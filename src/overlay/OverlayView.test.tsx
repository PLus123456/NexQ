import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Intercept the launcher-window helper so Minus-button tests can assert
// whether the stealth branch avoided it. Dynamically imported in the
// factory to preserve everything else exported by the module.
vi.mock("../lib/windows", async () => {
  const actual = await vi.importActual<typeof import("../lib/windows")>("../lib/windows");
  return {
    ...actual,
    showLauncherWindow: vi.fn().mockResolvedValue(undefined),
  };
});

// Intercept caption window helpers so header & More-menu toggle tests can assert calls.
const captionsMocks = vi.hoisted(() => ({
  toggleCaptions: vi.fn().mockResolvedValue(true),
  setCaptionsLocked: vi.fn().mockResolvedValue(undefined),
  visible: false,
}));
vi.mock("../lib/captions/window", async () => {
  const actual = await vi.importActual<typeof import("../lib/captions/window")>("../lib/captions/window");
  return {
    ...actual,
    toggleCaptions: captionsMocks.toggleCaptions,
    setCaptionsLocked: captionsMocks.setCaptionsLocked,
  };
});
vi.mock("../lib/captions/useCaptionsVisible", () => ({
  useCaptionsVisible: () => captionsMocks.visible,
}));

// Intercept the dynamic webviewWindow import inside the stealth-hide branch
// so we can assert it tried to hide the overlay (and not show the launcher).
const overlayHide = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: {
    getByLabel: vi.fn(async (label: string) => (label === "overlay" ? { hide: overlayHide } : null)),
  },
}));

import { OverlayView } from "./OverlayView";
import { CallLogPanel } from "../calllog";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useScenarioStore } from "../stores/scenarioStore";
import { useSpeakerStore } from "../stores/speakerStore";
import { useTranslationStore } from "../stores/translationStore";
import { showLauncherWindow } from "../lib/windows";
import type { AIScenario, AudioMode, Meeting, SpeakerIdentity } from "../lib/types";

// Mounts the real overlay and every store behind it: a selector that returns a
// new value on each read only shows up as a crash in a real render.
function renderOverlay(audioMode: AudioMode, scenario: AIScenario) {
  useMeetingStore.setState({
    activeMeeting: { id: "meeting-1", title: "Standup" } as Meeting,
    currentView: "overlay",
    audioMode,
    aiScenario: scenario,
    isRecording: true,
  });
  return render(
    <div>
      <OverlayView />
      <CallLogPanel />
    </div>,
  );
}

function openMoreMenu() {
  fireEvent.click(screen.getByRole("button", { name: "More options" }));
  return screen.getByRole("menu", { name: "More meeting controls" });
}

// Kept for the whole file: listeners unsubscribe asynchronously, after cleanup.
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

afterEach(() => {
  cleanup();
  captionsMocks.visible = false;
  captionsMocks.toggleCaptions.mockClear();
  captionsMocks.setCaptionsLocked.mockClear();
  useMeetingStore.setState({ activeMeeting: null, currentView: "launcher", isRecording: false });
  useScenarioStore.setState({ activeScenarioId: "team_meeting", customScenarios: [], scenarioOverrides: {} });
  useSpeakerStore.getState().reset();
  useConfigStore.setState({ stealthMode: false, captionsLocked: false, mutedYou: false, mutedThem: false });
  useTranslationStore.setState({ autoTranslateActive: false, displayMode: "inline", targetLang: "zh" });
});

describe("OverlayView", () => {
  const setups: Array<[AudioMode, AIScenario]> = [
    ["online", "interview"],
    ["online", "team_meeting"],
    ["in_person", "interview"],
    ["in_person", "team_meeting"],
  ];

  it.each(setups)("opens for a %s %s meeting with answer-first layout and transcript closed", (audioMode, scenario) => {
    renderOverlay(audioMode, scenario);
    expect(screen.getByRole("button", { name: "End meeting" })).toBeTruthy();
    expect(screen.queryByTestId("transcript-drawer")).toBeNull();
    expect(screen.queryByTestId("transcript-side-panel")).toBeNull();
    expect(screen.getByTestId("answer-card")).toBeInTheDocument();
  });

  it.each(setups)("opens for a %s %s meeting when the scenario's prompts were edited", (audioMode, scenario) => {
    useScenarioStore.setState({
      activeScenarioId: scenario,
      scenarioOverrides: { [scenario]: { system_prompt: "Edited prompt" } },
    });
    renderOverlay(audioMode, scenario);
    expect(screen.getByRole("button", { name: "End meeting" })).toBeTruthy();
  });

  it("shows the edited scenario name and mode badge at the top of the More menu", () => {
    useScenarioStore.setState({
      activeScenarioId: "interview",
      scenarioOverrides: { interview: { name: "My interview" } },
    });
    renderOverlay("online", "interview");
    const menu = openMoreMenu();
    expect(within(menu).getByText("My interview")).toBeTruthy();
    expect(within(menu).getByText("ONLINE")).toBeTruthy();
  });

  it("a captured screenshot closes an open transcript drawer and attaches to the Ask box", async () => {
    const { deliverScreenshot, discardPendingScreenshots } = await import("../lib/screenCapture");
    useConfigStore.setState({ llmProvider: "claude_cli" });
    const realBitmap = (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
    (globalThis as { createImageBitmap?: unknown }).createImageBitmap = async () => ({ width: 100, height: 100, close: () => {} });
    renderOverlay("online", "team_meeting");

    // Open transcript drawer over the answer area.
    fireEvent.click(screen.getByRole("button", { name: "Show transcript" }));
    expect(screen.getByTestId("transcript-drawer")).toBeInTheDocument();

    act(() => deliverScreenshot(new File(["shot"], "screen.png", { type: "image/png" })));

    expect(screen.queryByTestId("transcript-drawer")).toBeNull();
    expect(await screen.findByRole("group", { name: "Attached images" })).toBeTruthy();
    discardPendingScreenshots();
    (globalThis as { createImageBitmap?: unknown }).createImageBitmap = realBitmap;
  });

  it("Minimize menu item says 'Minimize to Dashboard' when stealth is off", () => {
    useConfigStore.setState({ stealthMode: false });
    renderOverlay("online", "team_meeting");
    const menu = openMoreMenu();
    expect(within(menu).getByRole("button", { name: "Minimize to Dashboard (Ctrl+B brings it back)" })).toBeTruthy();
  });

  it("Minimize menu item switches to 'Hide to tray' when stealth is on during a meeting", () => {
    useConfigStore.setState({ stealthMode: true });
    renderOverlay("online", "team_meeting");
    const menu = openMoreMenu();
    expect(within(menu).getByRole("button", { name: "Hide to tray (Ctrl+B brings it back)" })).toBeTruthy();
  });

  it("Minimize menu item uses the menu bar and ⌘B on macOS", () => {
    const userAgent = Object.getOwnPropertyDescriptor(window.navigator, "userAgent");
    Object.defineProperty(window.navigator, "userAgent", { value: "Mozilla/5.0 (Macintosh)", configurable: true });
    try {
      useConfigStore.setState({ stealthMode: true });
      renderOverlay("online", "team_meeting");
      const menu = openMoreMenu();
      expect(within(menu).getByRole("button", { name: "Hide to menu bar (⌘B brings it back)" })).toBeTruthy();
    } finally {
      if (userAgent) Object.defineProperty(window.navigator, "userAgent", userAgent);
      else delete (window.navigator as { userAgent?: string }).userAgent;
    }
  });

  it("Minimize click shows the launcher when stealth is off", async () => {
    vi.mocked(showLauncherWindow).mockClear();
    overlayHide.mockClear();
    useConfigStore.setState({ stealthMode: false });
    renderOverlay("online", "team_meeting");
    const menu = openMoreMenu();
    act(() => {
      fireEvent.click(within(menu).getByRole("button", { name: /Minimize to Dashboard/ }));
    });
    await waitFor(() => expect(showLauncherWindow).toHaveBeenCalledTimes(1));
    expect(overlayHide).not.toHaveBeenCalled();
  });

  it("Minimize click hides the overlay and does NOT reveal the launcher when stealth + meeting are on", async () => {
    vi.mocked(showLauncherWindow).mockClear();
    overlayHide.mockClear();
    useConfigStore.setState({ stealthMode: true });
    renderOverlay("online", "team_meeting");
    const menu = openMoreMenu();
    act(() => {
      fireEvent.click(within(menu).getByRole("button", { name: /Hide to tray/ }));
    });
    await waitFor(() => expect(overlayHide).toHaveBeenCalledTimes(1));
    expect(showLauncherWindow).not.toHaveBeenCalled();
  });

  it("opens Speaker Stats from the More menu and shows the speakers", () => {
    useSpeakerStore.setState({
      speakers: { you: { id: "you", display_name: "You", stats: { word_count: 3 } } as SpeakerIdentity },
      speakerOrder: ["you"],
    });
    renderOverlay("online", "team_meeting");
    const menu = openMoreMenu();
    act(() => {
      fireEvent.click(within(menu).getByRole("button", { name: "Speaker Stats (S)" }));
    });
    expect(screen.getByText("Speaker Stats")).toBeTruthy();
    expect(screen.getByText("1 speaker")).toBeTruthy();
  });

  it("toggles the caption strip from the title bar and locks/unlocks it via captions helpers", () => {
    captionsMocks.visible = false;
    const { rerender } = renderOverlay("online", "interview");
    const capBtn = screen.getByRole("button", { name: "Show caption strip" });
    expect(capBtn).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(capBtn);
    expect(captionsMocks.toggleCaptions).toHaveBeenCalledTimes(1);

    // Lock is always accessible inside the More menu.
    const menu = openMoreMenu();
    fireEvent.click(within(menu).getByRole("button", { name: /Lock caption strip/ }));
    expect(captionsMocks.setCaptionsLocked).toHaveBeenCalledWith(true);

    // When captions are visible or locked, the quick lock/unlock button also shows in the title bar.
    captionsMocks.visible = true;
    useConfigStore.setState({ captionsLocked: true });
    rerender(
      <div>
        <OverlayView />
        <CallLogPanel />
      </div>,
    );
    const unlockBtn = screen.getByRole("button", { name: "Unlock caption strip" });
    expect(unlockBtn).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(unlockBtn);
    expect(captionsMocks.setCaptionsLocked).toHaveBeenCalledWith(false);
  });

  it("opens the transcript drawer on demand and allows docking side-by-side at width ≥ 720px", () => {
    Object.defineProperty(window, "innerWidth", { value: 420, configurable: true });
    renderOverlay("online", "interview");
    expect(screen.queryByTestId("transcript-drawer")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show transcript" }));
    expect(screen.getByTestId("transcript-drawer")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dock side by side" })).toBeNull();

    // Widen to 800px: docking becomes available.
    Object.defineProperty(window, "innerWidth", { value: 800, configurable: true });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    fireEvent.click(screen.getByRole("button", { name: "Dock side by side" }));
    expect(screen.getByTestId("transcript-side-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("transcript-drawer")).toBeNull();

    // Shrinking below 720px falls back to drawer overlay.
    Object.defineProperty(window, "innerWidth", { value: 500, configurable: true });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(screen.getByTestId("transcript-drawer")).toBeInTheDocument();
    expect(screen.queryByTestId("transcript-side-panel")).toBeNull();
  });

  it("exposes mute, translation (inline/hover/translate all), panels and settings inside the More menu", () => {
    useTranslationStore.setState({ autoTranslateActive: true, displayMode: "inline", targetLang: "zh" });
    renderOverlay("online", "interview");
    const menu = openMoreMenu();

    expect(within(menu).getByRole("button", { name: "Mute mic (You)" })).toBeInTheDocument();
    expect(within(menu).getByRole("button", { name: "Mute them" })).toBeInTheDocument();
    expect(within(menu).getByRole("button", { name: "Translate" })).toHaveAttribute("aria-pressed", "true");
    expect(within(menu).getByRole("button", { name: "Inline" })).toBeInTheDocument();
    expect(within(menu).getByRole("button", { name: "Hover" })).toBeInTheDocument();
    expect(within(menu).getByRole("button", { name: "Translate All" })).toBeInTheDocument();
    expect(within(menu).getByText("ZH")).toBeInTheDocument();
    expect(within(menu).getByRole("button", { name: "Bookmarks (K)" })).toBeInTheDocument();
    expect(within(menu).getByRole("button", { name: "AI Call Log" })).toBeInTheDocument();
    expect(within(menu).getByRole("button", { name: "Dev Log (Ctrl+Shift+L)" })).toBeInTheDocument();
    expect(within(menu).getByRole("button", { name: "Settings" })).toBeInTheDocument();
  });

  it("resets back to answer-first layout with transcript closed when a new meeting starts", () => {
    renderOverlay("online", "interview");
    fireEvent.click(screen.getByRole("button", { name: "Show transcript" }));
    expect(screen.getByTestId("transcript-drawer")).toBeInTheDocument();

    act(() => {
      useMeetingStore.setState({
        activeMeeting: { id: "meeting-2", title: "Next Interview" } as Meeting,
      });
    });

    expect(screen.queryByTestId("transcript-drawer")).toBeNull();
    expect(screen.getByTestId("answer-card")).toBeInTheDocument();
  });

  it("enforces compact layout structure for answer dominance and no horizontal overflow", () => {
    renderOverlay("online", "interview");
    expect(screen.getByTestId("overlay-root").className).toContain("overflow-x-hidden");
    expect(screen.getByTestId("overlay-header").className).toContain("h-8");
    expect(screen.getByTestId("answer-card").className).toContain("flex-1");
    expect(screen.getByTestId("answer-card").className).toContain("min-h-0");
    expect(screen.getByTestId("question-panel").className).toContain("max-h-[72px]");
  });
});
