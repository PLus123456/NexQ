// Translation events NexQ Plus added (the older ones are in src/lib/events.ts).

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { TranslationBackendStatus } from "./types";

/** After every set_translation_provider, in every window. */
export function onTranslationBackendStatus(
  handler: (status: TranslationBackendStatus) => void,
): Promise<UnlistenFn> {
  return listen<TranslationBackendStatus>("translation_backend_status", (e) => handler(e.payload));
}
