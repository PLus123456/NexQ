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

import { MeetingAudioSettings } from "./MeetingAudioSettings";
import { AudioSetupStep } from "../components/wizard/AudioSetupStep";
import { useConfigStore } from "../stores/configStore";
import { DEFAULT_OPENAI_COMPAT_STT_CONFIG } from "../lib/stt/types";

const initialConfig: MeetingAudioConfig = {
  you: { role: "You", device_id: 'Studio: USB "Audio"', is_input_device: true, stt_provider: "deepgram" },
  them: { role: "Them", device_id: 'Studio: USB "Audio"', is_input_device: true, stt_provider: "deepgram" },
  recording_enabled: false,
  preset_name: null,
};

beforeEach(() => useConfigStore.setState({ meetingAudioConfig: initialConfig }));
afterEach(cleanup);

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

  it("turns Soniox's own translation on and off for a Soniox party", async () => {
    const user = userEvent.setup();
    useConfigStore.setState({
      meetingAudioConfig: { ...initialConfig, them: { ...initialConfig.them, stt_provider: "soniox" } },
    });
    render(<MeetingAudioSettings />);
    const toggle = await screen.findByRole("switch", { name: "Translate Them with Soniox" });
    expect(screen.queryByRole("switch", { name: "Translate You with Soniox" })).toBeNull();
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await user.click(toggle);
    expect(useConfigStore.getState().meetingAudioConfig?.them.native_translation).toEqual({ mode: "one_way" });
    expect(screen.getByText("Empty: uses the target language of the Translation settings.")).toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "Translate Them with Soniox" }));
    expect(useConfigStore.getState().meetingAudioConfig?.them.native_translation).toEqual({ mode: "off" });
  });
});
