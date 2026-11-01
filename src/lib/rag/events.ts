// Knowledge base events added by NexQ Plus. `rag_index_progress` keeps its
// upstream wrapper in ../events.ts; its payload is `IndexProgressEvent`.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { IndexProgressEvent, RagSettingsView } from "./types";

/** Settings saved in any window (both windows refresh from it). */
export function onRagConfigChanged(handler: (view: RagSettingsView) => void): Promise<UnlistenFn> {
  return listen<RagSettingsView>("rag_config_changed", (e) => handler(e.payload));
}

/** Indexing progress with the full payload. */
export function onRagIndexProgressFull(handler: (event: IndexProgressEvent) => void): Promise<UnlistenFn> {
  return listen<IndexProgressEvent>("rag_index_progress", (e) => handler(e.payload));
}
