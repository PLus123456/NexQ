import { describe, expect, it } from "vitest";
import { DEFAULT_SONIOX_CONFIG, normalizeSonioxConfig, sonioxKeySlot, sonioxRegionList } from "./types";

describe("Soniox region settings", () => {
  it("a fresh install picks regions by latency, each enabled once its key is added", () => {
    const fresh = normalizeSonioxConfig(undefined);
    expect(fresh).toEqual(DEFAULT_SONIOX_CONFIG);
    expect(fresh.region_mode).toBe("auto");
    expect(fresh.regions.every((r) => !r.enabled)).toBe(true);
    // A copy: changing it doesn't change the defaults.
    fresh.regions[0].enabled = true;
    expect(DEFAULT_SONIOX_CONFIG.regions[0].enabled).toBe(false);
  });

  it("a config saved before the region settings keeps its one region", () => {
    const old = normalizeSonioxConfig({ region: "jp", model: "stt-rt-v5" });
    expect(old.region_mode).toBe("fixed");
    expect(old.failover).toBe(true);
    expect(old.regions).toEqual([
      { id: "jp", enabled: true },
      { id: "us", enabled: false },
      { id: "eu", enabled: false },
      { id: "in", enabled: false },
    ]);
    // Unknown values don't break it.
    const odd = normalizeSonioxConfig({ region: "mars" as never, region_mode: "fastest" as never });
    expect(odd.region).toBe("us");
    expect(odd.region_mode).toBe("fixed");
  });

  it("the region list keeps the user's order and completes itself", () => {
    expect(
      sonioxRegionList({
        region: "us",
        regions: [
          { id: "in", enabled: true },
          { id: "xx" as never, enabled: true },
          { id: "eu", enabled: false },
          { id: "in", enabled: false },
        ],
      }),
    ).toEqual([
      { id: "in", enabled: true },
      { id: "eu", enabled: false },
      { id: "us", enabled: false },
      { id: "jp", enabled: false },
    ]);
    expect(sonioxKeySlot("jp")).toBe("soniox_jp");
  });
});
