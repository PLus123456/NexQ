// NexQ Plus: Soniox region helpers shared by the Soniox panel, the quick
// setup and the meeting overlay: region names in the UI language, which
// region has a key (`soniox_key_status`), the regions a config may connect
// to (mirrors Rust `SonioxConfig::allowed_regions`) and the key test a
// meeting would pass.

import { t } from "../../i18n";
import { probeSoniox, sonioxKeyStatus } from "../../lib/stt/ipc";
import {
  SONIOX_REGION_IDS,
  sonioxRegionList,
  type SonioxConfig,
  type SonioxKeyStatus,
  type SonioxRegion,
  type SttProbeResult,
} from "../../lib/stt/types";

export function isSonioxRegion(value: unknown): value is SonioxRegion {
  return typeof value === "string" && (SONIOX_REGION_IDS as readonly string[]).includes(value);
}

/** A region's short name ("Japan" / "日本"); "custom" is a custom URL; anything else as sent. */
export function sonioxRegionName(region: string): string {
  return isSonioxRegion(region) || region === "custom" ? t(`stt:soniox.regionNames.${region}`) : region;
}

/** A region inside a sentence ("the Japan region" / "日本区"). */
export function sonioxRegionInText(region: string): string {
  return isSonioxRegion(region) || region === "custom" ? t(`stt:soniox.regionInText.${region}`) : region;
}

/** A gateway is set (Advanced): sessions use its URL with `region`'s key, without regions. */
export function usesCustomEndpoint(config: Pick<SonioxConfig, "ws_url" | "rest_url">): boolean {
  return config.ws_url.trim() !== "" || config.rest_url.trim() !== "";
}

/**
 * What decides Soniox's key status (`soniox_key_status`): the region (the
 * old key's), the mode, the region list and a gateway. Checks of "has a
 * Soniox key" run again when this changes, not on every other edit.
 */
export function sonioxKeyScope(config: SonioxConfig): string {
  return JSON.stringify([config.region, config.region_mode, config.regions, usesCustomEndpoint(config)]);
}

/** Which key a region uses: its own slot, the old `soniox` slot (the key of `legacy_region`) or none. */
export function regionKeySource(status: SonioxKeyStatus, region: SonioxRegion): "own" | "legacy" | null {
  if (status.regions[region]) return "own";
  if (status.legacy && status.legacy_region === region) return "legacy";
  return null;
}

export function regionHasKey(status: SonioxKeyStatus, region: SonioxRegion): boolean {
  return regionKeySource(status, region) !== null;
}

/** The regions `config` may connect to, in its order: Fixed (or a gateway) only `region`, else the enabled ones. */
export function sonioxUsableRegions(config: SonioxConfig): SonioxRegion[] {
  if (config.region_mode === "fixed" || usesCustomEndpoint(config)) return [config.region];
  return sonioxRegionList(config)
    .filter((entry) => entry.enabled)
    .map((entry) => entry.id);
}

/** The first region `config` may connect to that has a key, or null. */
export function firstUsableRegionWithKey(config: SonioxConfig, status: SonioxKeyStatus): SonioxRegion | null {
  return sonioxUsableRegions(config).find((region) => regionHasKey(status, region)) ?? null;
}

/**
 * Tests a key `config` can connect with: `region`'s in Fixed mode or with a
 * gateway, else the first enabled region that has one. null = no region it
 * may use has a key (nothing to test).
 */
export async function probeUsableSonioxKey(config: SonioxConfig): Promise<SttProbeResult | null> {
  const status = await sonioxKeyStatus(config);
  const region = firstUsableRegionWithKey(config, status);
  if (!region) return null;
  return probeSoniox(region === config.region ? config : { ...config, region });
}

// The quick setup turns a Fixed region into Auto when it adds a key, unless
// the mode was picked in the Soniox settings (configs saved before the
// region settings are Fixed without anyone choosing it).
const MODE_CHOSEN_KEY = "nexq_soniox_region_mode_chosen";

/** Remember that the region mode was picked in the Soniox settings. */
export function rememberRegionModeChoice(): void {
  try {
    localStorage.setItem(MODE_CHOSEN_KEY, "1");
  } catch {
    // Storage blocked: the quick setup may then switch a Fixed region to Auto.
  }
}

/** Whether the region mode was picked in the Soniox settings. */
export function regionModeChosen(): boolean {
  try {
    return localStorage.getItem(MODE_CHOSEN_KEY) === "1";
  } catch {
    return false;
  }
}
