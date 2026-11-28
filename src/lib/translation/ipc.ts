// Translation provider configuration and batching commands.

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
  apiKey?: string,
): Promise<TranslationConnectionStatus> {
  return invoke<TranslationConnectionStatus>("test_translation_connection", { provider, region, options, apiKey });
}

export function storeMicrosoftTranslationCredentials(key: string, region: string): Promise<void> {
  return invoke("store_microsoft_translation_credentials", { key, region });
}

/** "Translate all", optionally restricted to the given parties. */
export function translateBatch(
  meetingId: string,
  targetLang: string,
  parties?: TranslationParty[],
): Promise<BatchTranslationOutcome> {
  return invoke<BatchTranslationOutcome>("translate_batch", { meetingId, targetLang, parties });
}
