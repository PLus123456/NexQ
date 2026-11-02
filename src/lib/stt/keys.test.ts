import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ get: async () => undefined, set: async () => {}, onKeyChange: async () => () => {} }),
}));

import { hasSttKeySlot } from "./keys";
import { useConfigStore } from "../../stores/configStore";
import { DEFAULT_SONIOX_CONFIG } from "./types";

describe("hasSttKeySlot", () => {
  beforeEach(() => invoke.mockReset());

  it("asks the regions for Soniox, with the current Soniox config", async () => {
    const config = { ...DEFAULT_SONIOX_CONFIG, region_mode: "ordered" as const };
    useConfigStore.setState({ sonioxConfig: config });
    invoke.mockImplementation(async (cmd) =>
      cmd === "soniox_key_status"
        ? JSON.stringify({ regions: { us: false, eu: false, jp: true, in: false }, legacy: false, legacy_region: "us", any_enabled: true })
        : null,
    );
    expect(await hasSttKeySlot("soniox")).toBe(true);
    expect(invoke).toHaveBeenCalledWith("soniox_key_status", { configJson: JSON.stringify(config) });
  });

  it("uses the engine's own slot for every other engine", async () => {
    invoke.mockImplementation(async (cmd, args) => cmd === "has_api_key" && (args as { provider: string }).provider === "deepgram");
    expect(await hasSttKeySlot("deepgram")).toBe(true);
    expect(await hasSttKeySlot("openai_compat_stt")).toBe(false);
    expect(invoke).not.toHaveBeenCalledWith("soniox_key_status", expect.anything());
  });
});
