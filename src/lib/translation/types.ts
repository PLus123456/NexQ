// Translation package types (NexQ Plus). The older shared ones
// (TranslationResult, TranslationProviderType…) stay in src/lib/types.ts.

/** Whose lines: the user's own ("you") or everyone else's ("them", also the room in person). */
export type TranslationParty = "you" | "them";

/** Which parties the translation pipeline translates. */
export interface TranslateParties {
  you: boolean;
  them: boolean;
}

/** How one party is translated: not at all, by its STT engine (Soniox), or by the translation service. */
export type PartyTranslationMode = "off" | "native" | "service";

/** Custom service addresses; "" = the official endpoint. */
export interface TranslationEndpoints {
  /** DeepL API prefix ending in /v2 (DeepLX and other compatible servers too). */
  deepl: string;
  /** Microsoft Translator resource endpoint or regional cloud. */
  microsoft: string;
  /** Google Cloud Translation v2 base, e.g. through a proxy. */
  google: string;
}

/** LLM translation prompts; "" = the default (llmDefaults.json). */
export interface LlmTranslationSettings {
  /** System message; {source}, {target}, {glossary} are filled in. */
  systemPrompt: string;
  /** User message; {source}, {target}, {glossary}, {text} are filled in. */
  userTemplate: string;
  /** One entry per line: `source term => translation`. */
  glossary: string;
}

/** `options` of set_translation_provider / test_translation_connection; a missing part keeps the backend's. */
export interface TranslationBackendOptions {
  endpoints?: TranslationEndpoints;
  llm?: LlmTranslationSettings;
}

/** Payload of `translation_backend_status`: did the last provider switch work? */
export interface TranslationBackendStatus {
  provider: string;
  ok: boolean;
  error?: string;
}

/** Payload of `translation_error`. */
export interface TranslationErrorEvent {
  segment_id?: string;
  /** The text whose translation failed (to ignore failures of replaced requests). */
  original_text?: string;
  error: string;
  consecutive_failures?: number;
}

export interface BatchTranslationOutcome {
  total: number;
  alreadyDone: number;
  newlyTranslated: number;
  /** Lines that failed (shown on the lines); the batch carried on. */
  failed?: number;
  firstError?: string | null;
}
