import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as IPC from "../../lib/ipc";
import type { LocalSTTEngineInfo, MeetingAudioConfig, STTProviderType } from "../../lib/types";
import type {
  SonioxAddKeyResult,
  SonioxConfig,
  SonioxKeyStatus,
  SonioxRegion,
  SttProbeResult,
} from "../../lib/stt/types";

// Regions with a key in their own slot, and the old `soniox` slot.
const keychain = vi.hoisted(() => ({ regions: {} as Partial<Record<string, boolean>>, legacy: false }));

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
  sonioxKeyStatus: vi.fn(async (_config: SonioxConfig): Promise<SonioxKeyStatus> => {
    throw new Error("not stubbed");
  }),
  sonioxAddKey: vi.fn(async (_key: string, _region?: SonioxRegion): Promise<SonioxAddKeyResult> => {
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
  sonioxKeyStatus: ipc.sonioxKeyStatus,
  sonioxAddKey: ipc.sonioxAddKey,
  sonioxMeasureLatency: async () => ({ regions: {}, measured_at_ms: 0, cached: true }),
  updateOpenAICompatSttConfig: async () => {},
  updateSonioxConfig: async () => {},
}));

import { SttQuickSetup } from "./SttQuickSetup";
import { rememberRegionModeChoice } from "./sonioxRegions";
import { useConfigStore } from "../../stores/configStore";
import { memoryStorage } from "../../test/memoryStorage";
import {
  DEFAULT_OPENAI_COMPAT_STT_CONFIG,
  DEFAULT_SONIOX_CONFIG,
  SONIOX_REGION_IDS,
  normalizeSonioxConfig,
  sonioxRegionList,
} from "../../lib/stt/types";

/** `soniox_key_status` for `config` (mirrors Rust `key_status`): the old key counts as `legacy_key_region`'s. */
function keyStatusFor(config: SonioxConfig): SonioxKeyStatus {
  const regions = Object.fromEntries(SONIOX_REGION_IDS.map((id) => [id, !!keychain.regions[id]])) as Record<
    SonioxRegion,
    boolean
  >;
  const legacyRegion = config.legacy_key_region ?? config.region;
  const has = (id: SonioxRegion) => regions[id] || (keychain.legacy && id === legacyRegion);
  const usable =
    config.region_mode === "fixed" ? [config.region] : sonioxRegionList(config).filter((e) => e.enabled).map((e) => e.id);
  return { regions, legacy: keychain.legacy, legacy_region: legacyRegion, any_enabled: usable.some(has) };
}

/** Auto with these regions turned on (in the default order). */
function autoWith(...enabled: SonioxRegion[]): SonioxConfig {
  return {
    ...DEFAULT_SONIOX_CONFIG,
    region_mode: "auto",
    regions: SONIOX_REGION_IDS.map((id) => ({ id, enabled: enabled.includes(id) })),
  };
}

const soniox = () => useConfigStore.getState().sonioxConfig;
const enabledRegions = () => soniox().regions.filter((r) => r.enabled).map((r) => r.id);

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
  vi.stubGlobal("localStorage", memoryStorage());
  // A US key, the US region turned on.
  keychain.regions = { us: true };
  keychain.legacy = false;
  ipc.hasApiKey.mockImplementation(async () => false);
  ipc.listLocalSTTEngines.mockImplementation(async () => WHISPER_DOWNLOADED);
  ipc.probeSoniox.mockImplementation(async () => SONIOX_OK);
  ipc.sonioxKeyStatus.mockImplementation(async (config) => keyStatusFor(config));
  useConfigStore.setState({
    meetingAudioConfig: audioConfig("whisper_cpp", "soniox"),
    sonioxConfig: autoWith("us"),
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
  vi.unstubAllGlobals();
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
    useConfigStore.setState({ meetingAudioConfig: null, micDeviceId: null, systemDeviceId: null, sttLanguage: "zh-CN" });
    const { user } = setup();
    expect(screen.getByRole("combobox", { name: "Recognition engine for You" })).toHaveValue("web_speech");
    await user.click(screen.getByRole("button", { name: "Test" }));
    // The fresh-install default on macOS (lib/stt/migrations): Whisper.cpp for the other side.
    await waitFor(() =>
      expect(useConfigStore.getState().meetingAudioConfig).toMatchObject({
        you: { stt_provider: "web_speech", is_input_device: true, language: "zh-CN" },
        them: { stt_provider: "whisper_cpp", is_input_device: false, language: "zh-CN" },
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

  it("tests the key of a region the Soniox settings may use", async () => {
    keychain.regions = { jp: true };
    useConfigStore.setState({ sonioxConfig: autoWith("eu", "jp") });
    const { onStatusChange, user } = setup();
    await user.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() =>
      expect(onStatusChange).toHaveBeenLastCalledWith("ok", "Soniox for Them, Whisper.cpp for You"),
    );
    // The EU is on but has no key: Japan's key is the one a meeting would use.
    expect(ipc.probeSoniox).toHaveBeenCalledTimes(1);
    expect(ipc.probeSoniox).toHaveBeenCalledWith(expect.objectContaining({ region: "jp" }));
  });

  it("needs a key for a region the Soniox settings may use", async () => {
    keychain.regions = { jp: true }; // Japan has a key but is off
    const { onStatusChange, user } = setup();
    await user.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() =>
      expect(onStatusChange).toHaveBeenLastCalledWith(
        "error",
        "Them: No Soniox key for the regions in use: add one above.",
      ),
    );
    expect(ipc.probeSoniox).not.toHaveBeenCalled();
  });

  it("adds a pasted key for the region that accepts it: the region goes on, a Fixed region nobody picked becomes Auto", async () => {
    // Set up before the region settings: Fixed on the US, with the old key.
    keychain.regions = {};
    keychain.legacy = true;
    useConfigStore.setState({ sonioxConfig: normalizeSonioxConfig({ region: "us" }) });
    ipc.sonioxAddKey.mockImplementation(async () => {
      keychain.regions.jp = true;
      return { region: "jp", stored: true, statuses: { jp: { status: 200, error: null, matches: true } } };
    });
    const { onStatusChange, user } = setup();
    expect(await screen.findByText("Keys saved for: US (saved by an older version)")).toBeInTheDocument();
    // One key field, no region settings.
    expect(screen.queryByLabelText("Region selection")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() => expect(onStatusChange).toHaveBeenLastCalledWith("ok", expect.any(String)));

    await user.type(screen.getByLabelText("API Key"), "sx-jp");
    await user.click(screen.getByRole("button", { name: "Add key" }));
    expect(ipc.sonioxAddKey).toHaveBeenCalledWith("sx-jp", undefined);
    expect(await screen.findByText("Saved for the Japan region and turned it on.")).toBeInTheDocument();
    expect(soniox().region_mode).toBe("auto");
    expect(enabledRegions()).toEqual(["us", "jp"]);
    expect(await screen.findByText("Keys saved for: US (saved by an older version), Japan")).toBeInTheDocument();
    // A new key: the last test no longer counts.
    await waitFor(() => expect(onStatusChange).toHaveBeenLastCalledWith("incomplete"));
  });

  it("with nothing saved and no key, Auto keeps only the region of the added key on", async () => {
    keychain.regions = {};
    useConfigStore.setState({ sonioxConfig: normalizeSonioxConfig(null) });
    ipc.sonioxAddKey.mockImplementation(async () => {
      keychain.regions.jp = true;
      return { region: "jp", stored: true, statuses: { jp: { status: 200, error: null, matches: true } } };
    });
    const { user } = setup();
    expect(await screen.findByText("No key saved yet.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("API Key"), "sx-jp{Enter}");
    expect(await screen.findByText("Saved for the Japan region and turned it on.")).toBeInTheDocument();
    expect(soniox().region_mode).toBe("auto");
    expect(enabledRegions()).toEqual(["jp"]);
  });

  it("keeps a Fixed region picked in the Soniox settings and moves it to the key's region", async () => {
    rememberRegionModeChoice();
    useConfigStore.setState({ sonioxConfig: normalizeSonioxConfig({ region: "us", region_mode: "fixed" }) });
    ipc.sonioxAddKey.mockImplementation(async () => {
      keychain.regions.eu = true;
      return { region: "eu", stored: true, statuses: {} };
    });
    const { user } = setup();
    await user.type(screen.getByLabelText("API Key"), "sx-eu{Enter}");
    expect(await screen.findByText("Saved for the EU region, now the region in use.")).toBeInTheDocument();
    expect(soniox()).toMatchObject({ region_mode: "fixed", region: "eu" });
  });

  it("asks which region a key belongs to when that is unclear", async () => {
    ipc.sonioxAddKey.mockImplementation(async (_key, region) => {
      if (!region) {
        return {
          region: null,
          stored: false,
          statuses: {
            us: { status: 403, error: null, matches: true },
            eu: { status: 403, error: null, matches: true },
          },
        };
      }
      keychain.regions[region] = true;
      return { region, stored: true, statuses: {} };
    });
    const { user } = setup();
    await user.type(screen.getByLabelText("API Key"), "sx-x");
    await user.click(screen.getByRole("button", { name: "Add key" }));
    expect(await screen.findByText("US: 403, accepts the key (can't list models)")).toBeInTheDocument();
    expect(screen.getByText("Japan: no answer")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "EU" }));
    expect(ipc.sonioxAddKey).toHaveBeenLastCalledWith("sx-x", "eu");
    expect(await screen.findByText("Saved for the EU region and turned it on.")).toBeInTheDocument();
    expect(enabledRegions()).toEqual(["us", "eu"]);
  });

  it("leaves the wizard-only text out of the settings variant", () => {
    setup("settings");
    expect(screen.getByText("Speech recognition")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open settings" })).toBeNull();
    expect(screen.queryByText(/You can change this any time in Settings/)).toBeNull();
  });
});
