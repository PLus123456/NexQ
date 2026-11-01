import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as IPC from "../../lib/ipc";
import type { SttProbeResult } from "../../lib/stt/types";

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
}));

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
  updateOpenAICompatSttConfig: async () => {},
  updateSonioxConfig: async () => {},
}));

import { OpenAICompatSttSettings } from "./OpenAICompatSttSettings";
import { SonioxSettings, checkExtraStartParams } from "./SonioxSettings";
import { useConfigStore } from "../../stores/configStore";
import { DEFAULT_OPENAI_COMPAT_STT_CONFIG, DEFAULT_SONIOX_CONFIG } from "../../lib/stt/types";

function probe(result: Partial<SttProbeResult>): SttProbeResult {
  return { ok: false, code: "network", url: null, status: null, latency_ms: 30, detail: "", models: [], ...result };
}

beforeEach(() => {
  ipc.hasApiKey.mockImplementation(async () => false);
  useConfigStore.setState({
    openaiCompatSttConfig: { ...DEFAULT_OPENAI_COMPAT_STT_CONFIG },
    sonioxConfig: { ...DEFAULT_SONIOX_CONFIG },
    verifiedCloudProviders: [],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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

describe("SonioxSettings", () => {
  it("saves the key without ever reading it back, and keeps it when a test fails", async () => {
    ipc.probeSoniox.mockImplementation(async () => probe({ code: "unauthorized", status: 401 }));
    const user = userEvent.setup();
    render(<SonioxSettings />);
    expect(await screen.findByText("No key saved yet.")).toBeInTheDocument();

    await user.type(screen.getByLabelText("API Key"), "sx-secret");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(ipc.storeApiKey).toHaveBeenCalledWith("soniox", "sx-secret");
    expect(await screen.findByText("Saved securely on this computer. It's never shown again.")).toBeInTheDocument();
    expect(screen.getByLabelText("API Key")).toHaveValue("");

    await user.click(screen.getByRole("button", { name: "Test key" }));
    expect(await screen.findByText("Invalid API key (401). Check the key and its region.")).toBeInTheDocument();
    expect(ipc.deleteApiKey).not.toHaveBeenCalled();
    expect(ipc.getApiKey).not.toHaveBeenCalled();
    expect(useConfigStore.getState().verifiedCloudProviders).not.toContain("soniox");
  });

  it("marks Soniox verified after a successful test", async () => {
    ipc.hasApiKey.mockImplementation(async (slot) => slot === "soniox");
    ipc.probeSoniox.mockImplementation(async () => probe({ ok: true, code: "ok", status: 200, models: ["stt-rt-v5"] }));
    const user = userEvent.setup();
    render(<SonioxSettings />);
    await user.click(screen.getByRole("button", { name: "Test key" }));
    expect(await screen.findByText("The key works — 1 real-time model available.")).toBeInTheDocument();
    expect(useConfigStore.getState().verifiedCloudProviders).toContain("soniox");
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
