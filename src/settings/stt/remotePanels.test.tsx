import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as IPC from "../../lib/ipc";
import type {
  SonioxAddKeyResult,
  SonioxConfig,
  SonioxKeyStatus,
  SonioxLatency,
  SonioxRegion,
  SttProbeResult,
} from "../../lib/stt/types";

// The keychain as the Soniox commands see it: per-region slots and the old `soniox` slot.
const keychain = vi.hoisted(() => ({ regions: {} as Partial<Record<string, boolean>>, legacy: false }));

const ipc = vi.hoisted(() => ({
  hasApiKey: vi.fn(async (_slot: string): Promise<boolean> => false),
  storeApiKey: vi.fn(async (_slot: string, _key: string): Promise<void> => {}),
  deleteApiKey: vi.fn(async (_slot: string): Promise<void> => {}),
  getApiKey: vi.fn(async (_slot: string): Promise<string | null> => "secret"),
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
  sonioxMeasureLatency: vi.fn(async (_force?: boolean): Promise<SonioxLatency> => {
    throw new Error("not stubbed");
  }),
  sonioxCachedLatency: vi.fn(async (): Promise<SonioxLatency> => NOT_MEASURED),
}));

// `soniox_cached_latency` before any test ran.
const NOT_MEASURED = vi.hoisted(
  (): SonioxLatency => ({
    regions: {
      us: { ms: null, error: "not measured" },
      eu: { ms: null, error: "not measured" },
      jp: { ms: null, error: "not measured" },
      in: { ms: null, error: "not measured" },
    },
    measured_at_ms: 0,
    cached: true,
  }),
);

vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));
vi.mock("../../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof IPC>()),
  hasApiKey: ipc.hasApiKey,
  storeApiKey: ipc.storeApiKey,
  deleteApiKey: ipc.deleteApiKey,
  getApiKey: ipc.getApiKey,
}));
vi.mock("../../lib/stt/ipc", () => ({
  probeSoniox: ipc.probeSoniox,
  probeOpenAICompatStt: ipc.probeOpenAICompatStt,
  sonioxKeyStatus: ipc.sonioxKeyStatus,
  sonioxAddKey: ipc.sonioxAddKey,
  sonioxMeasureLatency: ipc.sonioxMeasureLatency,
  sonioxCachedLatency: ipc.sonioxCachedLatency,
  updateOpenAICompatSttConfig: async () => {},
  updateSonioxConfig: async () => {},
}));

import { OpenAICompatSttSettings } from "./OpenAICompatSttSettings";
import { SonioxSettings, checkExtraStartParams, roundSensitivity } from "./SonioxSettings";
import { regionModeChosen } from "./sonioxRegions";
import { useConfigStore } from "../../stores/configStore";
import { memoryStorage } from "../../test/memoryStorage";
import {
  DEFAULT_OPENAI_COMPAT_STT_CONFIG,
  DEFAULT_SONIOX_CONFIG,
  SONIOX_REGION_IDS,
  normalizeSonioxConfig,
  sonioxRegionList,
} from "../../lib/stt/types";

function probe(result: Partial<SttProbeResult>): SttProbeResult {
  return { ok: false, code: "network", url: null, status: null, latency_ms: 30, detail: "", models: [], ...result };
}

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
const order = () => soniox().regions.map((r) => `${r.id}${r.enabled ? "+" : "-"}`).join(" ");

beforeEach(() => {
  keychain.regions = {};
  keychain.legacy = false;
  vi.stubGlobal("localStorage", memoryStorage());
  ipc.hasApiKey.mockImplementation(async () => false);
  ipc.sonioxKeyStatus.mockImplementation(async (config) => keyStatusFor(config));
  ipc.sonioxCachedLatency.mockImplementation(async () => NOT_MEASURED);
  ipc.deleteApiKey.mockImplementation(async (slot) => {
    if (slot === "soniox") keychain.legacy = false;
    else keychain.regions[slot.replace("soniox_", "")] = false;
  });
  useConfigStore.setState({
    openaiCompatSttConfig: { ...DEFAULT_OPENAI_COMPAT_STT_CONFIG },
    sonioxConfig: autoWith(),
    verifiedCloudProviders: [],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("checkExtraStartParams", () => {
  it("accepts nothing or a JSON object without api_key", () => {
    expect(checkExtraStartParams("")).toBeNull();
    expect(checkExtraStartParams("  ")).toBeNull();
    expect(checkExtraStartParams('{"context": {"terms": ["Kubernetes"]}}')).toBeNull();
  });

  it("rejects invalid JSON, non-objects and api_key at any depth", () => {
    expect(checkExtraStartParams("{")).toBe("invalidJson");
    expect(checkExtraStartParams("[1]")).toBe("notObject");
    expect(checkExtraStartParams("null")).toBe("notObject");
    expect(checkExtraStartParams('"text"')).toBe("notObject");
    expect(checkExtraStartParams('{"api_key": "x"}')).toBe("apiKey");
    expect(checkExtraStartParams('{"context": {"API_KEY": 1}}')).toBe("apiKey");
  });
});

describe("roundSensitivity", () => {
  it("keeps -1.0–1.0 with one decimal", () => {
    expect(roundSensitivity(0.30000000000000004)).toBe(0.3);
    expect(roundSensitivity(-0.04)).toBe(0);
    expect(Object.is(roundSensitivity(-0.04), -0)).toBe(false);
    expect(roundSensitivity(1.7)).toBe(1);
    expect(roundSensitivity(-3)).toBe(-1);
  });
});

/** The region row whose name is `name` (Auto / Ordered). */
function regionRow(name: string): HTMLElement {
  const row = screen.getAllByRole("listitem").find((li) => li.querySelector("p")?.textContent === name);
  if (!row) throw new Error(`No region row "${name}"`);
  return row;
}

describe("SonioxSettings", () => {
  it("saves a pasted key for the region that accepts it and turns that region on, never reading a key back", async () => {
    ipc.sonioxAddKey.mockImplementation(async () => {
      keychain.regions.jp = true;
      return {
        region: "jp",
        stored: true,
        statuses: { us: { status: 401, error: null, matches: false }, jp: { status: 200, error: null, matches: true } },
      };
    });
    const user = userEvent.setup();
    render(<SonioxSettings />);
    expect(await within(regionRow("Japan")).findByText("Key: None")).toBeInTheDocument();
    expect(screen.getByText(/Security & compliance → Request access/)).toBeInTheDocument();

    await user.type(screen.getByLabelText("API Key"), "sx-secret");
    await user.click(screen.getByRole("button", { name: "Add key" }));
    expect(ipc.sonioxAddKey).toHaveBeenCalledWith("sx-secret", undefined);
    expect(await screen.findByText("Saved for the Japan region and turned it on.")).toBeInTheDocument();
    expect(soniox().region_mode).toBe("auto");
    expect(order()).toBe("us- eu- jp+ in-");
    expect(await within(regionRow("Japan")).findByText("Key: Saved")).toBeInTheDocument();
    expect(screen.getByLabelText("API Key")).toHaveValue("");
    // Its region listed the models with it (200): the key works.
    expect(useConfigStore.getState().verifiedCloudProviders).toContain("soniox");
    expect(ipc.storeApiKey).not.toHaveBeenCalled();
    expect(ipc.getApiKey).not.toHaveBeenCalled();
  });

  it("uses the region a key was found for in Fixed mode", async () => {
    // A config saved before the region settings: Fixed on its region.
    useConfigStore.setState({ sonioxConfig: normalizeSonioxConfig({ region: "us" }) });
    ipc.sonioxAddKey.mockImplementation(async () => {
      keychain.regions.eu = true;
      return { region: "eu", stored: true, statuses: { eu: { status: 403, error: null, matches: true } } };
    });
    const user = userEvent.setup();
    render(<SonioxSettings />);
    expect(screen.getByLabelText("Region selection")).toHaveValue("fixed");
    expect(await screen.findByText("Key: None")).toBeInTheDocument();

    await user.type(screen.getByLabelText("API Key"), "sx-eu{Enter}");
    expect(await screen.findByText("Saved for the EU region, now the region in use.")).toBeInTheDocument();
    expect(soniox()).toMatchObject({ region_mode: "fixed", region: "eu" });
    expect(screen.getByLabelText("Region")).toHaveValue("eu");
    expect(await screen.findByText("Key: Saved")).toBeInTheDocument();
    // 403 (valid, can't list models) doesn't verify it by itself.
    expect(useConfigStore.getState().verifiedCloudProviders).not.toContain("soniox");
  });

  it("asks for the key's region when no single region accepted it, then saves it there", async () => {
    ipc.sonioxAddKey.mockImplementation(async (_key, region) => {
      if (!region) {
        return {
          region: null,
          stored: false,
          statuses: {
            us: { status: 401, error: null, matches: false },
            eu: { status: null, error: "timeout", matches: false },
            jp: { status: 401, error: null, matches: false },
            in: { status: null, error: "unreachable", matches: false },
          },
        };
      }
      keychain.regions[region] = true;
      return { region, stored: true, statuses: {} };
    });
    const user = userEvent.setup();
    render(<SonioxSettings />);
    await user.type(screen.getByLabelText("API Key"), "sx-new");
    await user.click(screen.getByRole("button", { name: "Add key" }));
    expect(await screen.findByText(/Couldn't tell which region this key belongs to/)).toBeInTheDocument();
    expect(screen.getByText("US: 401, not this region")).toBeInTheDocument();
    expect(screen.getByText("EU: timed out")).toBeInTheDocument();
    expect(screen.getByText("India: unreachable")).toBeInTheDocument();
    // Nothing saved or turned on yet.
    expect(order()).toBe("us- eu- jp- in-");

    await user.click(screen.getByRole("button", { name: "India" }));
    expect(ipc.sonioxAddKey).toHaveBeenLastCalledWith("sx-new", "in");
    expect(await screen.findByText("Saved for the India region and turned it on.")).toBeInTheDocument();
    expect(order()).toBe("us- eu- jp- in+");
    expect(screen.queryByText(/Couldn't tell/)).toBeNull();
    // A picked region isn't tested yet.
    expect(useConfigStore.getState().verifiedCloudProviders).not.toContain("soniox");
  });

  it("writes the region mode, explains it and remembers that it was picked", async () => {
    keychain.regions.jp = true;
    useConfigStore.setState({ sonioxConfig: autoWith("jp") });
    const user = userEvent.setup();
    render(<SonioxSettings />);
    const select = screen.getByLabelText("Region selection");
    expect(select).toHaveValue("auto");
    expect(screen.getByText(/The fastest of the enabled regions that have a key/)).toBeInTheDocument();
    expect(await within(regionRow("Japan")).findByText("Key: Saved")).toBeInTheDocument();
    expect(regionModeChosen()).toBe(false);

    await user.selectOptions(select, "Ordered");
    expect(soniox().region_mode).toBe("ordered");
    expect(screen.getByText(/in your order below/)).toBeInTheDocument();
    expect(regionModeChosen()).toBe(true);

    // Fixed on a region without a key takes the one that has a key.
    await user.selectOptions(select, "Fixed");
    expect(soniox()).toMatchObject({ region_mode: "fixed", region: "jp" });
    expect(screen.getByLabelText("Region")).toHaveValue("jp");
    expect(screen.queryByRole("button", { name: "Test latency" })).toBeNull();
    expect(screen.getByRole("button", { name: "Test key" })).toBeInTheDocument();
  });

  it("turns regions on and off and reorders them", async () => {
    const user = userEvent.setup();
    render(<SonioxSettings />);
    expect(order()).toBe("us- eu- jp- in-");
    await user.click(screen.getByRole("switch", { name: "Use Japan" }));
    expect(order()).toBe("us- eu- jp+ in-");
    await user.click(screen.getByRole("button", { name: "Move Japan up" }));
    await user.click(screen.getByRole("button", { name: "Move Japan up" }));
    expect(order()).toBe("jp+ us- eu- in-");
    expect(screen.getByRole("button", { name: "Move Japan up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move India down" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Move US down" }));
    expect(order()).toBe("jp+ eu- us- in-");
    expect(screen.getAllByRole("listitem").map((li) => li.querySelector("p")?.textContent)).toEqual([
      "Japan",
      "EU",
      "US",
      "India",
    ]);
    await user.click(screen.getByRole("switch", { name: "Use Japan" }));
    expect(order()).toBe("jp- eu- us- in-");
  });

  it("measures the latency of every region on demand", async () => {
    ipc.sonioxMeasureLatency.mockImplementation(async () => ({
      regions: {
        us: { ms: 180, error: null },
        eu: { ms: null, error: "timeout" },
        jp: { ms: 42, error: null },
        in: { ms: null, error: "unreachable" },
      },
      measured_at_ms: 1,
      cached: false,
    }));
    const user = userEvent.setup();
    render(<SonioxSettings />);
    expect(within(regionRow("Japan")).getByText("Latency: —")).toBeInTheDocument();
    expect(ipc.sonioxMeasureLatency).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Test latency" }));
    expect(ipc.sonioxMeasureLatency).toHaveBeenCalledWith(true);
    expect(await within(regionRow("Japan")).findByText("Latency: 42 ms")).toBeInTheDocument();
    expect(within(regionRow("US")).getByText("Latency: 180 ms")).toBeInTheDocument();
    expect(within(regionRow("EU")).getByText("Latency: timed out")).toBeInTheDocument();
    expect(within(regionRow("India")).getByText("Latency: unreachable")).toBeInTheDocument();
  });

  it("shows the last latency test when it opens, without measuring", async () => {
    ipc.sonioxCachedLatency.mockImplementation(async () => ({
      regions: {
        us: { ms: 150, error: null },
        eu: { ms: 90, error: null },
        jp: { ms: 40, error: null },
        in: { ms: null, error: "timeout" },
      },
      measured_at_ms: 1_700_000_000_000,
      cached: true,
    }));
    render(<SonioxSettings />);
    expect(await within(regionRow("Japan")).findByText("Latency: 40 ms")).toBeInTheDocument();
    expect(within(regionRow("India")).getByText("Latency: timed out")).toBeInTheDocument();
    expect(ipc.sonioxMeasureLatency).not.toHaveBeenCalled();
  });

  it("turns switching region on failure off and on", async () => {
    const user = userEvent.setup();
    render(<SonioxSettings />);
    const failover = screen.getByRole("switch", { name: "Switch region on failure" });
    expect(failover).toHaveAttribute("aria-checked", "true");
    await user.click(failover);
    expect(soniox().failover).toBe(false);
    expect(failover).toHaveAttribute("aria-checked", "false");
    await user.click(failover);
    expect(soniox().failover).toBe(true);
  });

  it("marks a refused key invalid, keeps it, and deletes it only when asked", async () => {
    keychain.regions.jp = true;
    useConfigStore.setState({ sonioxConfig: autoWith("jp"), verifiedCloudProviders: ["soniox"] });
    ipc.probeSoniox.mockImplementation(async () =>
      probe({ code: "unauthorized", status: 401, url: "https://api.jp.soniox.com/v1/models" }),
    );
    const user = userEvent.setup();
    render(<SonioxSettings />);
    const japan = () => within(regionRow("Japan"));
    expect(await japan().findByText("Key: Saved")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Test the US key" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Test the Japan key" }));
    // The region itself, with its own key.
    expect(ipc.probeSoniox).toHaveBeenCalledWith(expect.objectContaining({ region: "jp", ws_url: "", rest_url: "" }));
    expect(await screen.findByText("Invalid API key (401). Check the key and its region.")).toBeInTheDocument();
    expect(japan().getByText("Key: Invalid")).toBeInTheDocument();
    expect(ipc.deleteApiKey).not.toHaveBeenCalled();
    expect(useConfigStore.getState().verifiedCloudProviders).not.toContain("soniox");

    await user.click(screen.getByRole("button", { name: "Delete the Japan key" }));
    expect(ipc.deleteApiKey).toHaveBeenCalledWith("soniox_jp");
    expect(await japan().findByText("Key: None")).toBeInTheDocument();
    expect(screen.getByText(/No enabled region has a key yet/)).toBeInTheDocument();
    expect(ipc.getApiKey).not.toHaveBeenCalled();
  });

  it("shows the older key on its region and deletes it from the old slot", async () => {
    keychain.legacy = true;
    useConfigStore.setState({ sonioxConfig: { ...autoWith("eu"), region: "eu", legacy_key_region: "eu" } });
    const user = userEvent.setup();
    render(<SonioxSettings />);
    expect(await within(regionRow("EU")).findByText("Key: Saved (by an older version)")).toBeInTheDocument();
    expect(within(regionRow("US")).getByText("Key: None")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete the EU key" }));
    expect(ipc.deleteApiKey).toHaveBeenCalledWith("soniox");
    expect(await within(regionRow("EU")).findByText("Key: None")).toBeInTheDocument();
  });

  it("keeps the older key with its region when Fixed moves to another region", async () => {
    // Saved before the region settings: Fixed on the US, the key in the old slot.
    keychain.legacy = true;
    useConfigStore.setState({ sonioxConfig: normalizeSonioxConfig({ region: "us" }) });
    ipc.sonioxAddKey.mockImplementation(async () => {
      keychain.regions.jp = true;
      return { region: "jp", stored: true, statuses: { jp: { status: 200, error: null, matches: true } } };
    });
    const user = userEvent.setup();
    render(<SonioxSettings />);
    expect(await screen.findByText("Key: Saved (by an older version)")).toBeInTheDocument();

    await user.type(screen.getByLabelText("API Key"), "sx-jp{Enter}");
    expect(await screen.findByText("Saved for the Japan region, now the region in use.")).toBeInTheDocument();
    expect(soniox()).toMatchObject({ region_mode: "fixed", region: "jp", legacy_key_region: "us" });

    await user.selectOptions(screen.getByLabelText("Region selection"), "Auto");
    expect(await within(regionRow("US")).findByText("Key: Saved (by an older version)")).toBeInTheDocument();
    expect(within(regionRow("Japan")).getByText("Key: Saved")).toBeInTheDocument();
    expect(order()).toBe("us+ eu- jp+ in-");
  });

  it("starts with nothing saved as one fixed region, the US", async () => {
    useConfigStore.setState({ sonioxConfig: normalizeSonioxConfig(null) });
    render(<SonioxSettings />);
    expect(screen.getByLabelText("Region selection")).toHaveValue("fixed");
    expect(screen.getByLabelText("Region")).toHaveValue("us");
    expect(await screen.findByText("Key: None")).toBeInTheDocument();
  });

  it("tests the fixed region's key and marks Soniox verified", async () => {
    keychain.legacy = true;
    useConfigStore.setState({ sonioxConfig: normalizeSonioxConfig({ region: "us" }) });
    ipc.probeSoniox.mockImplementation(async () => probe({ ok: true, code: "ok", status: 200, models: ["stt-rt-v5"] }));
    const user = userEvent.setup();
    render(<SonioxSettings />);
    expect(await screen.findByText("Key: Saved (by an older version)")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Test key" }));
    expect(await screen.findByText("The key works — 1 real-time model available.")).toBeInTheDocument();
    expect(ipc.probeSoniox).toHaveBeenCalledWith(expect.objectContaining({ region: "us", region_mode: "fixed" }));
    expect(useConfigStore.getState().verifiedCloudProviders).toContain("soniox");
  });

  it("sends the v5 sentence-end settings only once they are set", async () => {
    const user = userEvent.setup();
    render(<SonioxSettings />);
    await user.click(screen.getByRole("button", { name: "Advanced" }));
    expect(screen.getByText(/Only stt-rt-v5 accepts these two/)).toBeInTheDocument();
    const saved = () => useConfigStore.getState().sonioxConfig;

    const level = screen.getByLabelText("Endpoint latency adjustment");
    expect(level).toHaveValue("");
    await user.selectOptions(level, "Level 2");
    expect(saved().endpoint_latency_adjustment_level).toBe(2);
    await user.selectOptions(level, "Server default");
    expect(saved().endpoint_latency_adjustment_level).toBeNull();

    const useDefault = screen.getByRole("checkbox", { name: "Use the server default" });
    const slider = screen.getByLabelText("Endpoint sensitivity");
    expect(useDefault).toBeChecked();
    expect(slider).toBeDisabled();
    await user.click(useDefault);
    expect(saved().endpoint_sensitivity).toBe(0);
    expect(slider).toBeEnabled();
    fireEvent.change(slider, { target: { value: "0.3" } });
    // Saved when the slider is let go, not while it moves.
    expect(saved().endpoint_sensitivity).toBe(0);
    fireEvent.mouseUp(slider);
    expect(saved().endpoint_sensitivity).toBe(0.3);
    expect(screen.getByText("0.3")).toBeInTheDocument();
    await user.click(useDefault);
    expect(saved().endpoint_sensitivity).toBeNull();
    expect(slider).toBeDisabled();
    expect(saved()).toEqual(autoWith());
  });

  it("refuses extra start parameters with api_key", async () => {
    const user = userEvent.setup();
    render(<SonioxSettings />);
    await user.click(screen.getByRole("button", { name: "Advanced" }));
    const field = screen.getByLabelText("Extra start parameters (JSON)");
    await user.click(field);
    await user.paste('{"api_key": "x"}');
    await user.tab();
    expect(screen.getByRole("alert")).toHaveTextContent("Don't put api_key here");
    expect(useConfigStore.getState().sonioxConfig.extra_start_params).toBe("");
  });
});

describe("OpenAICompatSttSettings", () => {
  it("saves the address on blur, tests it and offers the listed models", async () => {
    ipc.probeOpenAICompatStt.mockImplementation(async () =>
      probe({
        ok: true,
        code: "ok",
        status: 200,
        url: "http://10.0.0.5:8000/v1/models",
        models: ["Systran/faster-whisper-large-v3"],
      }),
    );
    const user = userEvent.setup();
    render(<OpenAICompatSttSettings />);
    const address = screen.getByLabelText("Base URL");
    await user.type(address, "http://10.0.0.5:8000/v1");
    // Not saved on every keystroke…
    expect(useConfigStore.getState().openaiCompatSttConfig.base_url).toBe("");
    await user.tab();
    // …but on blur.
    expect(useConfigStore.getState().openaiCompatSttConfig.base_url).toBe("http://10.0.0.5:8000/v1");

    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Connected — the server lists 1 model.")).toBeInTheDocument();
    expect(ipc.probeOpenAICompatStt).toHaveBeenCalledWith(
      expect.objectContaining({ base_url: "http://10.0.0.5:8000/v1" }),
    );
    expect(screen.getByText("http://10.0.0.5:8000/v1/models")).toBeInTheDocument();
    expect(useConfigStore.getState().verifiedCloudProviders).toContain("openai_compat");
  });

  it("keeps a stored key when a test fails and asks before dropping it for no auth", async () => {
    ipc.hasApiKey.mockImplementation(async (slot) => slot === "openai_compat_stt");
    ipc.probeOpenAICompatStt.mockImplementation(async () => probe({ code: "unauthorized", status: 401 }));
    useConfigStore.setState({
      openaiCompatSttConfig: { ...DEFAULT_OPENAI_COMPAT_STT_CONFIG, base_url: "http://10.0.0.5:8000/v1" },
      verifiedCloudProviders: ["openai_compat"],
    });
    const user = userEvent.setup();
    render(<OpenAICompatSttSettings />);
    // A stored key means Bearer.
    await waitFor(() => expect(screen.getByRole("button", { name: "Bearer token" })).toHaveAttribute("aria-pressed", "true"));

    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("The server rejected the API key (401).")).toBeInTheDocument();
    expect(ipc.deleteApiKey).not.toHaveBeenCalled();
    expect(ipc.getApiKey).not.toHaveBeenCalled();
    expect(useConfigStore.getState().verifiedCloudProviders).not.toContain("openai_compat");

    await user.click(screen.getByRole("button", { name: "None" }));
    expect(ipc.deleteApiKey).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Remove saved key" }));
    expect(ipc.deleteApiKey).toHaveBeenCalledWith("openai_compat_stt");
    await waitFor(() => expect(screen.getByRole("button", { name: "None" })).toHaveAttribute("aria-pressed", "true"));
  });
});
