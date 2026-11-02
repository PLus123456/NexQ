import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingAudioConfig } from "../lib/types";
import type * as IPC from "../lib/ipc";

vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof IPC>()),
  listAudioDevices: async () => ({
    inputs: [{ id: 'Studio: USB "Audio"', name: 'Studio: USB "Audio"', is_input: true, is_default: false }],
    outputs: [{ id: 'Studio: USB "Audio"', name: 'Studio: USB "Audio"', is_input: false, is_default: false }],
  }),
  getAudioSessions: async () => [],
  hasApiKey: async () => false,
  listLocalSTTEngines: async () => [],
  startDeviceMonitor: async () => {},
  stopDeviceMonitor: async () => {},
  stopAudioTest: async () => false,
}));

import { MeetingAudioSettings, sonioxPairProblem } from "./MeetingAudioSettings";
import { STTSettings } from "./STTSettings";
import { PartyLanguageField } from "./stt/PartyLanguageField";
import { AudioSetupStep } from "../components/wizard/AudioSetupStep";
import { changeUiLanguage } from "../i18n";
import { useConfigStore } from "../stores/configStore";
import { DEFAULT_OPENAI_COMPAT_STT_CONFIG } from "../lib/stt/types";

const initialConfig: MeetingAudioConfig = {
  you: { role: "You", device_id: 'Studio: USB "Audio"', is_input_device: true, stt_provider: "deepgram" },
  them: { role: "Them", device_id: 'Studio: USB "Audio"', is_input_device: true, stt_provider: "deepgram" },
  recording_enabled: false,
  preset_name: null,
};

beforeEach(() => useConfigStore.setState({ meetingAudioConfig: initialConfig, sttLanguage: "en-US" }));
afterEach(async () => {
  cleanup();
  await act(() => changeUiLanguage("en"));
});

describe.each([
  { surface: "Audio & Devices", Component: MeetingAudioSettings },
  { surface: "STT Settings", Component: STTSettings },
])("Vietnamese recognition in $surface", ({ Component }) => {
  it.each([
    { party: "you" as const, label: "You", other: "them" as const },
    { party: "them" as const, label: "Them", other: "you" as const },
  ])("selects Vietnamese for $label without changing the other party", async ({ party, label, other }) => {
    const user = userEvent.setup();
    render(<Component />);
    const input = screen.getByRole("combobox", { name: `Recognition language for ${label}` });
    await user.click(input);
    const common = screen.getByRole("group", { name: "Common languages" });
    await user.click(within(common).getByRole("option", { name: /Vietnamese/ }));
    const config = useConfigStore.getState();
    expect(config.meetingAudioConfig?.[party].language).toBe("vi-VN");
    expect(config.meetingAudioConfig?.[other].language).toBeUndefined();
    expect(config.sttLanguage).toBe("en-US");
    expect(input).toHaveValue("Vietnamese");
    expect(screen.getByText("Select a Deepgram model that supports Vietnamese, such as Nova-3.")).toBeInTheDocument();
  });
});

describe.each(["vi", "vi-VN"])("Vietnamese model guidance for %s", (language) => {
  it("warns about Parakeet in English and Chinese without recommending another Parakeet model", async () => {
    useConfigStore.setState({ activeModelPerEngine: { parakeet_tdt: "parakeet-ctc-110m" } });
    render(<PartyLanguageField party={{ ...initialConfig.you, stt_provider: "parakeet_tdt", language }} onChange={() => {}} />);
    expect(screen.getByText(/The included Parakeet models do not support Vietnamese/)).toBeInTheDocument();
    expect(screen.queryByText(/Use Parakeet TDT 0.6B v3 for Russian/)).toBeNull();
    await act(() => changeUiLanguage("zh-CN"));
    expect(screen.getByRole("combobox")).toHaveValue("越南语");
    expect(screen.getByText(/内置的 Parakeet 模型不支持越南语/)).toBeInTheDocument();
    expect(screen.queryByText(/The included Parakeet models/)).toBeNull();
  });

  it("localizes the Deepgram model guidance", async () => {
    render(<PartyLanguageField party={{ ...initialConfig.you, language }} onChange={() => {}} />);
    expect(screen.getByText("Select a Deepgram model that supports Vietnamese, such as Nova-3.")).toBeInTheDocument();
    await act(() => changeUiLanguage("zh-CN"));
    expect(screen.getByText("请选择支持越南语的 Deepgram 模型，例如 Nova-3。")).toBeInTheDocument();
    expect(screen.queryByText(/Select a Deepgram model that supports Vietnamese/)).toBeNull();
  });
});

describe.each([
  { surface: "settings", Component: MeetingAudioSettings },
  { surface: "wizard", Component: AudioSetupStep },
])("$surface audio source selection", ({ Component }) => {
  it.each(["you", "them"] as const)("keeps the %s input and output distinct when their names match", async (party) => {
    const user = userEvent.setup();
    const view = render(<Component />);
    const group = await screen.findAllByRole("group", { name: "Speakers / Output" });
    const output = within(group[party === "you" ? 0 : 1]).getByRole<HTMLOptionElement>("option");
    const select = output.closest("select")!;
    await waitFor(() => expect(select).toBeEnabled());

    await user.selectOptions(select, output);
    expect(useConfigStore.getState().meetingAudioConfig?.[party]).toMatchObject({
      device_id: 'Studio: USB "Audio"',
      is_input_device: false,
    });
    expect(output.selected).toBe(true);

    view.unmount();
    render(<Component />);
    const restoredGroups = await screen.findAllByRole("group", { name: "Speakers / Output" });
    const restoredOutput = within(restoredGroups[party === "you" ? 0 : 1]).getByRole<HTMLOptionElement>("option");
    expect(restoredOutput.selected).toBe(true);
    const restoredSelect = restoredOutput.closest("select")!;
    const micGroup = within(restoredSelect).getByRole("group", { name: "Microphones" });
    const input = within(micGroup).getByRole<HTMLOptionElement>("option");
    await waitFor(() => expect(restoredSelect).toBeEnabled());
    await user.selectOptions(restoredSelect, input);
    expect(useConfigStore.getState().meetingAudioConfig?.[party]).toMatchObject({
      device_id: 'Studio: USB "Audio"',
      is_input_device: true,
    });
    expect(input.selected).toBe(true);
  });

  it.each([
    { party: "you" as const, isInput: true },
    { party: "them" as const, isInput: false },
  ])("uses the correct direction for the $party default", async ({ party, isInput }) => {
    const user = userEvent.setup();
    render(<Component />);
    const groups = await screen.findAllByRole("group", { name: "Microphones" });
    const select = groups[party === "you" ? 0 : 1].closest("select")!;
    await waitFor(() => expect(select).toBeEnabled());
    await user.selectOptions(select, select.options[0]);
    expect(useConfigStore.getState().meetingAudioConfig?.[party]).toMatchObject({
      device_id: "default",
      is_input_device: isInput,
    });
    expect(select.options[0].selected).toBe(true);
  });
});

// ── NexQ Plus: engines from providerMeta, per-party language, Soniox translation ──

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edg/120.0";

/** The platform the engine lists are filtered for (read from the user agent at render). */
function stubUserAgent(ua: string) {
  Object.defineProperty(window.navigator, "userAgent", { value: ua, configurable: true });
}

/** Opens the "You" engine picker (both parties start on Deepgram). */
async function openYouPicker(user: ReturnType<typeof userEvent.setup>) {
  const [youTrigger] = await screen.findAllByRole("button", { name: "Deepgram" });
  await user.click(youTrigger);
}

describe("MeetingAudioSettings engines and languages", () => {
  beforeEach(() => {
    stubUserAgent(MAC_UA);
    useConfigStore.setState({ openaiCompatSttConfig: { ...DEFAULT_OPENAI_COMPAT_STT_CONFIG } });
  });
  afterEach(() => {
    delete (window.navigator as { userAgent?: string }).userAgent;
  });

  it("writes the party's own recognition language and keeps the other party's", async () => {
    const user = userEvent.setup();
    useConfigStore.setState({ meetingAudioConfig: { ...initialConfig, preset_name: "All Cloud" } });
    render(<MeetingAudioSettings />);
    const input = await screen.findByRole("combobox", { name: "Recognition language for You" });
    await user.click(input);
    await user.keyboard("ja-JP");
    await user.keyboard("{Enter}");
    const config = useConfigStore.getState().meetingAudioConfig!;
    expect(config.you.language).toBe("ja-JP");
    expect(config.them.language).toBeUndefined();
    // The language isn't part of a preset.
    expect(config.preset_name).toBe("All Cloud");
    expect(screen.getByRole("combobox", { name: "Recognition language for Them" })).toHaveValue("English (US)");
  });

  it("hides Remote Whisper from the picker until a server address is set", async () => {
    const user = userEvent.setup();
    render(<MeetingAudioSettings />);
    await openYouPicker(user);
    expect(screen.getByRole("button", { name: "Web Speech" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remote Whisper" })).toBeNull();

    act(() => {
      useConfigStore.setState({
        openaiCompatSttConfig: { ...DEFAULT_OPENAI_COMPAT_STT_CONFIG, base_url: "http://10.0.0.5:8000/v1" },
      });
    });
    await user.click(screen.getByRole("button", { name: "Remote Whisper" }));
    expect(useConfigStore.getState().meetingAudioConfig?.you.stt_provider).toBe("openai_compat");
  });

  it("offers Windows Speech only on Windows", async () => {
    const user = userEvent.setup();
    const view = render(<MeetingAudioSettings />);
    await openYouPicker(user);
    expect(screen.getByRole("button", { name: "Web Speech" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Windows Speech" })).toBeNull();
    view.unmount();

    stubUserAgent(WINDOWS_UA);
    render(<MeetingAudioSettings />);
    await openYouPicker(user);
    expect(screen.getByRole("button", { name: "Windows Speech" })).toBeInTheDocument();
  });

  it("switches Soniox's own translation between off, one-way and two-way, keeping each mode's fields", async () => {
    const user = userEvent.setup();
    useConfigStore.setState({
      meetingAudioConfig: { ...initialConfig, them: { ...initialConfig.them, stt_provider: "soniox" } },
    });
    render(<MeetingAudioSettings />);
    const native = () => useConfigStore.getState().meetingAudioConfig?.them.native_translation;
    const mode = await screen.findByRole("combobox", { name: "Translate Them with Soniox" });
    expect(screen.queryByRole("combobox", { name: "Translate You with Soniox" })).toBeNull();
    expect(mode).toHaveValue("off");

    await user.selectOptions(mode, "One-way");
    expect(native()).toEqual({ mode: "one_way" });
    expect(screen.getByText("Empty: uses the target language of the Translation settings.")).toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Translate into" }));
    await user.keyboard("ja{Enter}");
    expect(native()).toEqual({ mode: "one_way", target_language: "ja" });

    await user.selectOptions(mode, "Two-way");
    expect(native()).toEqual({ mode: "two_way", target_language: "ja" });
    expect(screen.queryByRole("combobox", { name: "Translate into" })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Pick both languages to turn two-way translation on.");
    await user.click(screen.getByRole("combobox", { name: "Two-way language A for Them" }));
    await user.keyboard("zh-CN{Enter}");
    await user.click(screen.getByRole("combobox", { name: "Two-way language B for Them" }));
    await user.keyboard("zh-TW{Enter}");
    expect(screen.getByRole("status")).toHaveTextContent("Pick two different languages.");
    await user.click(screen.getByRole("combobox", { name: "Two-way language B for Them" }));
    await user.keyboard("en{Enter}");
    expect(native()).toEqual({ mode: "two_way", target_language: "ja", language_a: "zh-CN", language_b: "en" });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText(/any other language is only transcribed/)).toBeInTheDocument();

    // Off and back: nothing is lost on the way.
    await user.selectOptions(mode, "Off");
    expect(native()).toEqual({ mode: "off", target_language: "ja", language_a: "zh-CN", language_b: "en" });
    expect(screen.queryByRole("combobox", { name: "Two-way language A for Them" })).toBeNull();
    await user.selectOptions(mode, "One-way");
    expect(native()).toEqual({ mode: "one_way", target_language: "ja", language_a: "zh-CN", language_b: "en" });
  });
});

describe("sonioxPairProblem", () => {
  it("wants two different languages with two-letter codes", () => {
    expect(sonioxPairProblem("", "en")).toBe("incomplete");
    expect(sonioxPairProblem("zh-CN", "  ")).toBe("incomplete");
    expect(sonioxPairProblem("yue", "en")).toBe("unsupported");
    expect(sonioxPairProblem("zh-CN", "zh-TW")).toBe("same");
    expect(sonioxPairProblem("zh-CN", "en-US")).toBeNull();
  });
});

describe("meeting audio preset prerequisites", () => {
  it("shows missing keys, models and addresses before selection and does not report incomplete setup as success", async () => {
    const user = userEvent.setup();
    useConfigStore.setState({ openaiCompatSttConfig: { ...DEFAULT_OPENAI_COMPAT_STT_CONFIG, base_url: "" } });
    const { useToastStore } = await import("../stores/toastStore");
    useToastStore.setState({ toasts: [] });
    render(<MeetingAudioSettings />);
    const soniox = screen.getByRole("button", { name: "Soniox for Them" });
    await waitFor(() => expect(soniox).toHaveTextContent("Needs Soniox API key"));
    expect(soniox).toHaveTextContent("Download a Whisper.cpp model");
    const remote = screen.getByRole("button", { name: "Self-hosted Whisper" });
    expect(remote).toHaveTextContent("Set the Remote Whisper server URL");
    await user.click(remote);
    expect(useConfigStore.getState().meetingAudioConfig?.you.stt_provider).toBe("openai_compat");
    expect(useToastStore.getState().toasts.slice(-1)[0]).toMatchObject({
      type: "warning",
      message: expect.stringContaining("setup still needed: Set the Remote Whisper server URL"),
    });
  });
});
