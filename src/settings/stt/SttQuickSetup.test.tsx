import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as IPC from "../../lib/ipc";
import type { LocalSTTEngineInfo, MeetingAudioConfig, STTProviderType } from "../../lib/types";
import type { SttProbeResult } from "../../lib/stt/types";

const ipc = vi.hoisted(() => ({
  hasApiKey: vi.fn(async (_slot: string): Promise<boolean> => false),
  listLocalSTTEngines: vi.fn(async (): Promise<LocalSTTEngineInfo[]> => []),
  listAudioDevices: vi.fn(async () => ({
    inputs: [{ id: "mic-1", name: "Built-in Mic", is_input: true, is_default: true }],
    outputs: [{ id: "out-1", name: "Speakers", is_input: false, is_default: true }],
  })),
  probeSoniox: vi.fn(async (_config: unknown): Promise<SttProbeResult> => {
    throw new Error("not stubbed");
  }),
  probeOpenAICompatStt: vi.fn(async (_config: unknown): Promise<SttProbeResult> => {
    throw new Error("not stubbed");
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));
vi.mock("../../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof IPC>()),
  hasApiKey: ipc.hasApiKey,
  listLocalSTTEngines: ipc.listLocalSTTEngines,
  listAudioDevices: ipc.listAudioDevices,
}));
vi.mock("../../lib/stt/ipc", () => ({
  probeSoniox: ipc.probeSoniox,
  probeOpenAICompatStt: ipc.probeOpenAICompatStt,
  updateOpenAICompatSttConfig: async () => {},
  updateSonioxConfig: async () => {},
}));

import { SttQuickSetup } from "./SttQuickSetup";
import { useConfigStore } from "../../stores/configStore";
import { DEFAULT_OPENAI_COMPAT_STT_CONFIG, DEFAULT_SONIOX_CONFIG } from "../../lib/stt/types";

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";

const WHISPER_DOWNLOADED: LocalSTTEngineInfo[] = [
  {
    engine: "whisper_cpp",
    name: "Whisper.cpp",
    description: "",
    models: [
      {
        id: "ggml-base",
        engine: "whisper_cpp",
        name: "Base",
        size_bytes: 142_000_000,
        accuracy_rating: 3,
        speed_rating: 4,
        is_streaming: false,
        is_downloaded: true,
      },
    ],
  },
];

function probe(result: Partial<SttProbeResult>): SttProbeResult {
  return { ok: false, code: "network", url: null, status: null, latency_ms: 42, detail: "", models: [], ...result };
}

const SONIOX_OK = probe({
  ok: true,
  code: "ok",
  status: 200,
  url: "https://api.soniox.com/v1/models",
  models: ["stt-rt-v5"],
});

function audioConfig(you: STTProviderType, them: STTProviderType): MeetingAudioConfig {
  return {
    you: { role: "You", device_id: "default", is_input_device: true, stt_provider: you },
    them: { role: "Them", device_id: "default", is_input_device: false, stt_provider: them },
    recording_enabled: false,
    preset_name: null,
  };
}

function setup(variant: "wizard" | "settings" = "wizard") {
  const onStatusChange = vi.fn();
  const user = userEvent.setup();
  const view = render(<SttQuickSetup variant={variant} onStatusChange={onStatusChange} />);
  return { onStatusChange, user, view };
}

beforeEach(() => {
  Object.defineProperty(window.navigator, "userAgent", { value: MAC_UA, configurable: true });
  ipc.hasApiKey.mockImplementation(async () => false);
  ipc.listLocalSTTEngines.mockImplementation(async () => WHISPER_DOWNLOADED);
  ipc.probeSoniox.mockImplementation(async () => SONIOX_OK);
  useConfigStore.setState({
    meetingAudioConfig: audioConfig("whisper_cpp", "soniox"),
    sonioxConfig: { ...DEFAULT_SONIOX_CONFIG },
    openaiCompatSttConfig: { ...DEFAULT_OPENAI_COMPAT_STT_CONFIG },
    verifiedCloudProviders: [],
    activeModelPerEngine: {},
    activeWhisperModel: null,
    sttLanguage: "en-US",
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  delete (window.navigator as { userAgent?: string }).userAgent;
});

describe("SttQuickSetup", () => {
  it("reports incomplete once on mount and again only on a change", async () => {
    const { onStatusChange, view } = setup();
    view.rerender(<SttQuickSetup variant="wizard" onStatusChange={onStatusChange} />);
    await waitFor(() => expect(ipc.listLocalSTTEngines).toHaveBeenCalled());
    expect(onStatusChange).toHaveBeenCalledTimes(1);
    expect(onStatusChange).toHaveBeenCalledWith("incomplete");
  });

  it("reports ok with a summary once both parties pass the test", async () => {
    const { onStatusChange, user } = setup();
    await user.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() =>
      expect(onStatusChange).toHaveBeenLastCalledWith("ok", "Soniox for Them, Whisper.cpp for You"),
    );
    expect(ipc.probeSoniox).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Both sides are ready.")).toBeInTheDocument();
    expect(screen.getByText("Whisper.cpp model downloaded.")).toBeInTheDocument();
  });

  it("reports the failing party's reason as an error, then incomplete after a change", async () => {
    ipc.probeSoniox.mockImplementation(async () =>
      probe({ code: "unauthorized", status: 401, url: "https://api.soniox.com/v1/models", detail: '{"error":"invalid key"}' }),
    );
    const { onStatusChange, user } = setup();
    await user.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() =>
      expect(onStatusChange).toHaveBeenLastCalledWith(
        "error",
        "Them: Invalid API key (401). Check the key and its region.",
      ),
    );
    // The server's raw answer is shown with the status.
    expect(screen.getByText('{"error":"invalid key"}')).toBeInTheDocument();
    expect(screen.getByText("HTTP 401 · 42 ms")).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "Recognition engine for Them" }), "deepgram");
    expect(useConfigStore.getState().meetingAudioConfig?.them.stt_provider).toBe("deepgram");
    await waitFor(() => expect(onStatusChange).toHaveBeenLastCalledWith("incomplete"));
  });

  it("passes a Soniox key that can't list models, with a warning", async () => {
    ipc.probeSoniox.mockImplementation(async () => probe({ code: "forbidden", status: 403 }));
    const { onStatusChange, user } = setup();
    await user.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() =>
      expect(onStatusChange).toHaveBeenLastCalledWith("ok", "Soniox for Them, Whisper.cpp for You"),
    );
    expect(
      screen.getByText("The key is valid but can't list models (403). Real-time recognition may still work."),
    ).toBeInTheDocument();
  });

  it("needs a downloaded model for a local engine", async () => {
    ipc.listLocalSTTEngines.mockImplementation(async () => []);
    const { onStatusChange, user } = setup();
    await user.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() =>
      expect(onStatusChange).toHaveBeenLastCalledWith("error", "You: Download a Whisper.cpp model first."),
    );
  });

  it("counts Web Speech as ready on macOS and needs a key for other cloud engines", async () => {
    useConfigStore.setState({ meetingAudioConfig: audioConfig("web_speech", "deepgram") });
    const { onStatusChange, user } = setup();
    await user.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() =>
      expect(onStatusChange).toHaveBeenLastCalledWith(
        "error",
        "Them: No API key saved for Deepgram: add it in Settings → STT Providers.",
      ),
    );

    ipc.hasApiKey.mockImplementation(async (slot) => slot === "deepgram");
    await user.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() =>
      expect(onStatusChange).toHaveBeenLastCalledWith("ok", "Deepgram for Them, Web Speech for You"),
    );
    expect(ipc.probeSoniox).not.toHaveBeenCalled();
  });

  it("stores the default setup it tested when none was saved", async () => {
    useConfigStore.setState({ meetingAudioConfig: null, micDeviceId: null, systemDeviceId: null });
    const { user } = setup();
    expect(screen.getByRole("combobox", { name: "Recognition engine for You" })).toHaveValue("web_speech");
    await user.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() =>
      expect(useConfigStore.getState().meetingAudioConfig).toMatchObject({
        you: { stt_provider: "web_speech", is_input_device: true },
        them: { stt_provider: "deepgram", is_input_device: false },
      }),
    );
  });

  it("applies the recommended setup and keeps each party's language", async () => {
    useConfigStore.setState({
      meetingAudioConfig: {
        ...audioConfig("web_speech", "deepgram"),
        you: { ...audioConfig("web_speech", "deepgram").you, language: "zh-CN" },
      },
    });
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Use this" }));
    await waitFor(() => expect(useConfigStore.getState().meetingAudioConfig?.preset_name).toBe("Soniox for Them"));
    const config = useConfigStore.getState().meetingAudioConfig!;
    expect(config.you).toMatchObject({ stt_provider: "whisper_cpp", language: "zh-CN", device_id: "mic-1" });
    expect(config.them).toMatchObject({ stt_provider: "soniox", device_id: "out-1", is_input_device: false });
    expect(config.them.native_translation).toEqual({ mode: "one_way" });
    expect(screen.getByRole("button", { name: "In use" })).toHaveAttribute("aria-pressed", "true");
  });

  it("leaves the wizard-only text out of the settings variant", () => {
    setup("settings");
    expect(screen.getByText("Speech recognition")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open settings" })).toBeNull();
    expect(screen.queryByText(/You can change this any time in Settings/)).toBeNull();
  });
});
