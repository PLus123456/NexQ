// IPC wrappers for the knowledge base commands added by NexQ Plus
// (src-tauri/src/commands/rag_engine_commands.rs). The upstream RAG
// commands stay in ../ipc.ts.

import { invoke } from "@tauri-apps/api/core";
import type { EmbedTestResult, IndexInfo, RagConfigPatch, RagSettingsView, RerankTestResult } from "./types";

export function ragGetSettings(): Promise<RagSettingsView> {
  return invoke<RagSettingsView>("rag_get_settings");
}

/** Applies a JSON merge patch; returns the saved settings. */
export function ragUpdateConfig(patch: RagConfigPatch): Promise<RagSettingsView> {
  return invoke<RagSettingsView>("rag_update_config", { patch });
}

/** Stores the embedding API key in the keychain (null deletes it). */
export function ragSetSecret(secret: string | null): Promise<RagSettingsView> {
  return invoke<RagSettingsView>("rag_set_secret", { secret });
}

/** Tests the saved embedding settings with `draft` (unsaved fields) on top. */
export function ragTestEmbedding(draft?: RagConfigPatch): Promise<EmbedTestResult> {
  return invoke<EmbedTestResult>("rag_test_embedding", { draft: draft ?? null });
}

/** Stores the rerank API key in the keychain (null deletes it). */
export function ragSetRerankSecret(secret: string | null): Promise<RagSettingsView> {
  return invoke<RagSettingsView>("rag_set_rerank_secret", { secret });
}

/** Tests the saved rerank settings with `draft` (unsaved fields) on top. */
export function ragTestRerank(draft?: RagConfigPatch): Promise<RerankTestResult> {
  return invoke<RerankTestResult>("rag_test_rerank", { draft: draft ?? null });
}

export function ragGetIndexInfo(): Promise<IndexInfo> {
  return invoke<IndexInfo>("rag_get_index_info");
}

/** Queues an incremental sync (all documents by default); returns the job id. */
export function ragSyncIndex(resourceIds?: string[], force = false): Promise<number> {
  return invoke<number>("rag_sync_index", { resourceIds: resourceIds ?? null, force });
}

/** Queues a rebuild with the current settings; returns the job id. */
export function ragRebuildIndex(): Promise<number> {
  return invoke<number>("rag_rebuild_index");
}

/** Stops the running indexing job; false when nothing was running. */
export function ragCancelIndexing(): Promise<boolean> {
  return invoke<boolean>("rag_cancel_indexing");
}
