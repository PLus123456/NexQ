import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuickSetupProps } from "../../settings/quickSetup";
import type { STTProviderType } from "../../lib/types";
import type * as IPC from "../../lib/ipc";

const saved = vi.hoisted(() => new Map<string, unknown>());
const keyListeners = vi.hoisted(() => [] as Array<{ key: string; cb: (v: unknown) => void }>);
const audio = vi.hoisted(() => ({ detected: true, failNext: false, started: [] as Array<[string, boolean]> }));
const savedKeys = vi.hoisted(() => new Set<string>());
const invoke = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null));

vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    get: async (key: string) => saved.get(key),
    set: async (key: string, value: unknown) => {
      saved.set(key, value);
      for (const l of keyListeners) if (l.key === key) l.cb(structuredClone(value));
    },
    onKeyChange: async (key: string, cb: (v: unknown) => void) => {
      keyListeners.push({ key, cb });
      return () => {};
    },
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));
vi.mock("../../lib/platform", () => ({ isMac: () => true, isWindows: () => false, currentPlatform: () => "macos" }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
vi.mock("../../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof IPC>()),
  listAudioDevices: async () => ({ inputs: [], outputs: [] }),
  startAudioTest: async (deviceId: string, isInput: boolean) => {
    if (audio.failNext) {
      audio.failNext = false;
      throw new Error("permission denied");
    }
    audio.started.push([deviceId, isInput]);
  },
  stopAudioTest: async () => audio.detected,
  hasApiKey: async (slot: string) => savedKeys.has(slot),
  listLocalSTTEngines: async () => [],
}));
// The knowledge base panel talks to the backend; a stand-in shows it opened.
vi.mock("../../context/ContextPanel", () => ({
  ContextPanel: () => <div data-testid="context-panel">Meeting Context</div>,
}));
// The LLM step's quick setup, as a component that reports what the test asks.
vi.mock("../../settings/llm/LlmQuickSetup", () => ({
  LlmQuickSetup: ({ onStatusChange }: QuickSetupProps) => (
    <div>
      <button type="button" onClick={() => onStatusChange("ok", "DeepSeek · deepseek-chat")}>
        Report ok
      </button>
      <button type="button" onClick={() => onStatusChange("error", "HTTP 401")}>
        Report error
      </button>
    </div>
  ),
}));

import { FirstRunWizard } from "./FirstRunWizard";
import { changeUiLanguage, useUiLanguageStore } from "../../i18n";
import { freshProgress, type OnboardingProgress } from "../../lib/onboarding/progress";
import { resetOnboardingStoreForTests, useOnboardingStore } from "../../stores/onboardingStore";
import { useConfigStore } from "../../stores/configStore";
import { useMeetingStore } from "../../stores/meetingStore";

function audioConfig(you: string, them: string) {
  return {
    you: { role: "You" as const, device_id: "default", is_input_device: true, stt_provider: you as STTProviderType },
    them: { role: "Them" as const, device_id: "default", is_input_device: false, stt_provider: them as STTProviderType },
    recording_enabled: false,
    preset_name: null,
  };
}

function heading() {
  return screen.getByRole("heading", { level: 2 });
}

function stepButton(name: RegExp) {
  return within(screen.getByRole("navigation", { name: "Setup steps" })).getByRole("button", { name });
}

async function renderWizard() {
  const user = userEvent.setup();
  render(<FirstRunWizard />);
  await screen.findByRole("heading", { level: 2 });
  return user;
}

beforeEach(() => {
  saved.clear();
  keyListeners.length = 0;
  audio.detected = true;
  audio.started = [];
  audio.failNext = false;
  invoke.mockClear();
  savedKeys.clear();
  resetOnboardingStoreForTests();
  useConfigStore.setState({ firstRunCompleted: false, meetingAudioConfig: audioConfig("web_speech", "deepgram") });
  useMeetingStore.setState({ currentView: "launcher", previousView: null, settingsOpen: false, settingsTab: null });
});

afterEach(async () => {
  cleanup();
  await act(() => changeUiLanguage("en"));
});

describe("FirstRunWizard", () => {
  it("goes forward, back and skips, and the step list shows each step's state", async () => {
    const user = await renderWizard();
    expect(heading()).toHaveTextContent("Welcome to NexQ Plus");

    await user.click(screen.getByRole("button", { name: /^Next/ }));
    expect(heading()).toHaveTextContent("Connect an AI model");
    const next = screen.getByRole("button", { name: /^Next/ });
    expect(next).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Report ok" }));
    expect(next).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("This step is done");
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
    await user.click(next);

    expect(heading()).toHaveTextContent("Set up speech recognition");
    expect(screen.getByRole("button", { name: /^Next/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Skip" }));
    expect(heading()).toHaveTextContent("Set up translation");

    await user.click(screen.getByRole("button", { name: "Previous" }));
    expect(heading()).toHaveTextContent("Set up speech recognition");

    expect(stepButton(/AI model.*Done/)).toBeEnabled();
    expect(stepButton(/Speech recognition.*Skipped/)).toHaveAttribute("aria-current", "step");
    expect(stepButton(/Audio check/)).toBeDisabled();

    await user.click(stepButton(/Language/));
    expect(heading()).toHaveTextContent("Welcome to NexQ Plus");
  });

  it("applies the chosen interface language at once", async () => {
    const user = await renderWizard();
    expect(screen.getByRole("radio", { name: "English" })).toHaveAttribute("aria-checked", "true");

    await user.click(screen.getByRole("radio", { name: "简体中文" }));

    expect(useUiLanguageStore.getState().setting).toBe("zh-CN");
    await waitFor(() => expect(heading()).toHaveTextContent("欢迎使用 NexQ Plus"));
    expect(screen.getByRole("button", { name: /下一步/ })).toBeEnabled();
  });

  it("a failed test shows why, and the step can still be skipped", async () => {
    const user = await renderWizard();
    await user.click(screen.getByRole("button", { name: /^Next/ }));

    await user.click(screen.getByRole("button", { name: "Report error" }));

    expect(screen.getByRole("status")).toHaveTextContent("The test failed: HTTP 401");
    expect(screen.getByRole("button", { name: /^Next/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Skip" }));
    expect(useOnboardingStore.getState().progress.steps.llm).toEqual({ status: "skipped" });
  });

  it("reopens at the step it was left on", async () => {
    const left: OnboardingProgress = {
      ...freshProgress(5),
      current: "translation",
      steps: { language: { status: "ok" }, llm: { status: "ok" }, stt: { status: "skipped" }, translation: { status: "incomplete" } },
    };
    saved.set("onboardingProgress", left);

    const user = await renderWizard();

    expect(heading()).toHaveTextContent("Set up translation");
    expect(screen.getByText("Picked up where you left off.")).toBeInTheDocument();
    expect(stepButton(/Speech recognition.*Skipped/)).toBeEnabled();

    // The notice is about reopening: it goes once the user moves on.
    await user.click(screen.getByRole("button", { name: "Previous" }));
    await user.click(screen.getByRole("button", { name: /^Next/ }));
    expect(screen.queryByText("Picked up where you left off.")).toBeNull();
  });

  it("a quick setup's settings button opens that settings tab, and setup comes back at the same step", async () => {
    const user = await renderWizard();
    await user.click(screen.getByRole("button", { name: /^Next/ }));
    await user.click(screen.getByRole("button", { name: "Skip" }));

    await user.click(screen.getByRole("button", { name: "Open settings" }));
    expect(useMeetingStore.getState()).toMatchObject({ currentView: "settings", settingsTab: "stt" });

    // Back from settings: the same step, and not announced as a reopened run.
    cleanup();
    await renderWizard();
    expect(heading()).toHaveTextContent("Set up speech recognition");
    expect(screen.queryByText("Picked up where you left off.")).toBeNull();
  });

  it("the audio step is done when both the microphone and the system audio are heard", async () => {
    useConfigStore.setState({
      meetingAudioConfig: {
        you: { role: "You", device_id: "Built-in Mic", is_input_device: true, stt_provider: "web_speech" },
        them: { role: "Them", device_id: "Speakers", is_input_device: false, stt_provider: "deepgram" },
        recording_enabled: false,
        preset_name: null,
      },
    });
    const user = await renderWizard();
    await user.click(screen.getByRole("button", { name: /^Next/ }));
    await user.click(screen.getByRole("button", { name: "Skip" }));
    await user.click(screen.getByRole("button", { name: "Skip" }));
    await user.click(screen.getByRole("button", { name: "Skip" }));
    expect(heading()).toHaveTextContent("Audio Setup");
    const micTest = screen.getByRole("region", { name: "Microphone Test" });
    const systemTest = screen.getByRole("region", { name: "System Audio Test" });
    const next = () => screen.getByRole("button", { name: /^Next/ });

    await user.click(within(micTest).getByRole("button", { name: "Test Audio" }));
    expect(within(systemTest).getByRole("button", { name: "Test Audio" })).toBeDisabled();
    await user.click(within(micTest).getByRole("button", { name: /^Stop/ }));
    await within(micTest).findByText("Your microphone works.");
    expect(useOnboardingStore.getState().progress.steps.audio?.status).toBe("incomplete");
    expect(next()).toBeDisabled();

    // Nothing heard from the system audio: what to check, and the permission page.
    audio.detected = false;
    await user.click(within(systemTest).getByRole("button", { name: "Test Audio" }));
    await user.click(within(systemTest).getByRole("button", { name: /^Stop/ }));
    await within(systemTest).findByText("No system audio was heard.");
    expect(audio.started).toEqual([["Built-in Mic", true], ["Speakers", false]]);
    expect(useOnboardingStore.getState().progress.steps.audio).toEqual({
      status: "error",
      detail: "No system audio from the other side.",
    });
    expect(within(systemTest).getByText(/Screen & System Audio Recording/)).toBeInTheDocument();
    await user.click(within(systemTest).getByRole("button", { name: "Open system audio recording settings" }));
    expect(invoke).toHaveBeenCalledWith("open_privacy_settings", { pane: "system_audio" });

    audio.detected = true;
    await user.click(within(systemTest).getByRole("button", { name: "Test Audio" }));
    await user.click(within(systemTest).getByRole("button", { name: /^Stop/ }));
    await waitFor(() => expect(next()).toBeEnabled());
    expect(useOnboardingStore.getState().progress.steps.audio).toEqual({ status: "ok" });

    // The results survive leaving the step; another source needs a new test.
    await user.click(screen.getByRole("button", { name: "Previous" }));
    await user.click(screen.getByRole("button", { name: "Skip" }));
    expect(within(screen.getByRole("region", { name: "System Audio Test" })).getByText("The other side's audio comes through.")).toBeInTheDocument();
    const themSource = screen.getAllByRole("combobox")[1];
    await waitFor(() => expect(themSource).toBeEnabled());
    await user.selectOptions(themSource, JSON.stringify([false, "default"]));
    expect(useOnboardingStore.getState().progress.steps.audio).toEqual({ status: "incomplete" });
  });

  it("a microphone that can't be opened says why and links to its permission page", async () => {
    const user = await renderWizard();
    await user.click(screen.getByRole("button", { name: "Skip the remaining steps" }));
    await user.click(screen.getByRole("button", { name: /^Change · Audio check/ }));

    const micTest = screen.getByRole("region", { name: "Microphone Test" });
    audio.failNext = true;
    await user.click(within(micTest).getByRole("button", { name: "Test Audio" }));

    await within(micTest).findByText("The test couldn't start: permission denied");
    expect(useOnboardingStore.getState().progress.steps.audio?.status).toBe("error");
    await user.click(within(micTest).getByRole("button", { name: "Open microphone settings" }));
    expect(invoke).toHaveBeenCalledWith("open_privacy_settings", { pane: "microphone" });
  });

  it("\"Upload your resume\" opens the personal knowledge base", async () => {
    const user = await renderWizard();
    await user.click(screen.getByRole("button", { name: "Skip the remaining steps" }));
    expect(heading()).toHaveTextContent("Review your setup");

    await user.click(screen.getByRole("button", { name: "Upload your resume" }));
    const dialog = screen.getByRole("dialog", { name: "Personal knowledge base" });
    expect(within(dialog).getByTestId("context-panel")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Search and embedding settings" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useMeetingStore.getState()).toMatchObject({ currentView: "settings", settingsTab: "context_strategy" });
    // Setup is still open: going back from settings returns to it.
    expect(useConfigStore.getState().firstRunCompleted).toBe(false);
  });

  it("before finishing, checks that speech recognition can run for at least one side", async () => {
    const user = await renderWizard();
    await user.click(screen.getByRole("button", { name: "Skip the remaining steps" }));

    const check = screen.getByRole("region", { name: "Before your first meeting" });
    await within(check).findByText("API key missing");
    expect(within(check).getByText("Ready")).toBeInTheDocument();
    expect(within(check).getByText(/Web Speech/)).toBeInTheDocument();
    expect(within(check).getByText(/Deepgram/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Start Meeting/ })).toBeEnabled();

    // Neither side can run: no meeting until one is set up (the launcher stays open).
    act(() => useConfigStore.setState({ meetingAudioConfig: audioConfig("deepgram", "groq_whisper") }));
    expect(await within(check).findByRole("alert")).toHaveTextContent("Neither side's speech recognition can run yet");
    expect(screen.getByRole("button", { name: /Start Meeting/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Go to Launcher" })).toBeEnabled();

    savedKeys.add("groq_whisper");
    await user.click(within(check).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(within(check).queryByRole("alert")).toBeNull());
    expect(screen.getByRole("button", { name: /Start Meeting/ })).toBeEnabled();

    // A change in the audio settings is checked again by itself.
    savedKeys.clear();
    act(() => useConfigStore.setState({ meetingAudioConfig: audioConfig("deepgram", "groq_whisper") }));
    await user.click(await within(check).findByRole("button", { name: "Set up speech recognition" }));
    expect(heading()).toHaveTextContent("Set up speech recognition");
  });

  it("counts Soniox as ready when a region its settings may use has a key", async () => {
    useConfigStore.setState({ meetingAudioConfig: audioConfig("deepgram", "soniox") });
    // No key in the old `soniox` slot (savedKeys is empty), one for Japan.
    invoke.mockImplementation(async (cmd) =>
      cmd === "soniox_key_status"
        ? JSON.stringify({ regions: { us: false, eu: false, jp: true, in: false }, legacy: false, legacy_region: "us", any_enabled: true })
        : null,
    );
    try {
      const user = await renderWizard();
      await user.click(screen.getByRole("button", { name: "Skip the remaining steps" }));
      const check = screen.getByRole("region", { name: "Before your first meeting" });
      expect(await within(check).findByText("Ready")).toBeInTheDocument();
      expect(within(check).getByText("API key missing")).toBeInTheDocument(); // Deepgram
      expect(invoke).toHaveBeenCalledWith("soniox_key_status", expect.anything());
    } finally {
      invoke.mockImplementation(async () => null);
    }
  });

  it("speech recognition tested in its step needs no further check", async () => {
    useConfigStore.setState({ meetingAudioConfig: audioConfig("deepgram", "groq_whisper") });
    saved.set("onboardingProgress", {
      ...freshProgress(2),
      current: "finish",
      steps: { language: { status: "ok" }, stt: { status: "ok" }, finish: { status: "incomplete" } },
    });
    await renderWizard();
    const check = screen.getByRole("region", { name: "Before your first meeting" });
    expect(within(check).getByText("Speech recognition passed its test in step 3.")).toBeInTheDocument();
    expect(within(check).queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: /Start Meeting/ })).toBeEnabled();
  });

  it("finishing marks setup completed", async () => {
    const user = await renderWizard();
    await user.click(screen.getByRole("button", { name: "Skip the remaining steps" }));

    await user.click(screen.getByRole("button", { name: "Go to Launcher" }));

    expect(useConfigStore.getState().firstRunCompleted).toBe(true);
    await waitFor(() => expect(saved.get("firstRunCompleted")).toBe(true));
    expect((saved.get("onboardingProgress") as OnboardingProgress).completedAt).toEqual(expect.any(Number));
  });
});
