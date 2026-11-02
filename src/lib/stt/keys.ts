// Whether an STT engine has the key it needs. Every engine uses its keychain
// slot, except Soniox: one key per region (`soniox_us`…), plus the old
// `soniox` slot counted as `region`'s. "Has a Soniox key" means a region the
// current config may use has one.

import { hasApiKey } from "../ipc";
import { useConfigStore } from "../../stores/configStore";
import { sonioxKeyStatus } from "./ipc";
import { SONIOX_KEY_SLOT } from "./types";

/**
 * `hasApiKey(slot)` for STT engines: the `soniox` slot (what `sttKeySlot`
 * gives Soniox) answers for the regions the Soniox config can connect to.
 */
export async function hasSttKeySlot(slot: string): Promise<boolean> {
  if (slot === SONIOX_KEY_SLOT) {
    const status = await sonioxKeyStatus(useConfigStore.getState().sonioxConfig);
    return status.any_enabled;
  }
  return hasApiKey(slot);
}
