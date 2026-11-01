// Translation commands with the arguments NexQ Plus added (all optional on
// the Rust side, so the plain wrappers in src/lib/ipc.ts keep working).

import { invoke } from "@tauri-apps/api/core";
import type { TranslationConnectionStatus, TranslationProviderType } from "../types";
import type { BatchTranslationOutcome, TranslationBackendOptions, TranslationParty } from "./types";

/**
 * Makes `provider` the active translation provider with these service
 * addresses / LLM prompts. Without `region` the backend uses the stored
 * Microsoft region. Rejects with the reason when the provider isn't ready.
 */
export function setTranslationProviderWithOptions(
  provider: TranslationProviderType,
  options?: TranslationBackendOptions,
  region?: string,
): Promise<void> {
  return invoke("set_translation_provider", { provider, region, options });
}

/** Tests `provider` with possibly unsaved settings; the active provider doesn't change. */
export function testTranslationProvider(
  provider: TranslationProviderType,
  options?: TranslationBackendOptions,
  region?: string,
): Promise<TranslationConnectionStatus> {
  return invoke<TranslationConnectionStatus>("test_translation_connection", { provider, region, options });
}

/** "Translate all" for the given parties only. */
export function translateBatchForParties(
  meetingId: string,
  targetLang: string,
  parties: TranslationParty[],
): Promise<BatchTranslationOutcome> {
  return invoke<BatchTranslationOutcome>("translate_batch", { meetingId, targetLang, parties });
}
