import { describe, expect, it } from "vitest";
import { DEFAULT_SONIOX_CONFIG, normalizeSonioxConfig, sonioxKeySlot, sonioxRegionList } from "./types";

describe("Soniox region settings", () => {
  it("nothing saved reads like an old config: the US alone, so a key saved without settings keeps working", () => {
    const fresh = normalizeSonioxConfig(undefined);
    expect(fresh).toEqual(DEFAULT_SONIOX_CONFIG);
    expect(fresh).toEqual(normalizeSonioxConfig({}));
    expect(fresh.region_mode).toBe("fixed");
    expect(fresh.regions.filter((r) => r.enabled).map((r) => r.id)).toEqual(["us"]);
    expect(fresh.legacy_key_region).toBe("us");
    // A copy: changing it doesn't change the defaults.
    fresh.regions[0].enabled = false;
    expect(DEFAULT_SONIOX_CONFIG.regions[0].enabled).toBe(true);
  });

  it("pins the old key's region once and keeps it when the region changes", () => {
    const old = normalizeSonioxConfig({ region: "jp" });
    expect(old.legacy_key_region).toBe("jp");
    const moved = normalizeSonioxConfig({ ...old, region: "eu" });
    expect(moved).toMatchObject({ region: "eu", legacy_key_region: "jp" });
    expect(normalizeSonioxConfig({ region: "in", legacy_key_region: "mars" as never }).legacy_key_region).toBe("in");
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
