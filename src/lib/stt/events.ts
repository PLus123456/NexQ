// NexQ Plus: STT event listeners (Soniox region changes).

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { SonioxRegionSwitchEvent } from "./types";

/** A Soniox session moved to another region (full, down, key refused…). */
export function onSonioxRegionSwitch(handler: (event: SonioxRegionSwitchEvent) => void): Promise<UnlistenFn> {
  return listen<SonioxRegionSwitchEvent>("soniox_region_switch", (e) => handler(e.payload));
}
