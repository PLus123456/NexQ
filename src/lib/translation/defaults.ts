// Translation defaults for a new install of NexQ Plus.

import type { UiLanguage } from "../../i18n";
import type { TranslationProviderType } from "../types";
import llmDefaults from "./llmDefaults.json";
import type { LlmTranslationSettings, TranslateParties, TranslationEndpoints } from "./types";

/** The prompts the backend uses when a field is left empty (the same JSON is compiled into Rust). */
export const LLM_PROMPT_DEFAULTS: Readonly<Pick<LlmTranslationSettings, "systemPrompt" | "userTemplate">> = {
  systemPrompt: llmDefaults.systemPrompt,
  userTemplate: llmDefaults.userTemplate,
};

export const DEFAULT_PROVIDER: TranslationProviderType = "llm";

/** Only the other side is translated until the user says otherwise. */
export const DEFAULT_TRANSLATE_PARTIES: Readonly<TranslateParties> = { you: false, them: true };

export const DEFAULT_ENDPOINTS: Readonly<TranslationEndpoints> = { deepl: "", microsoft: "", google: "" };

export const DEFAULT_LLM_SETTINGS: Readonly<LlmTranslationSettings> = { systemPrompt: "", userTemplate: "", glossary: "" };

/** A line counts as finished once it hasn't changed for this long. */
export const DEFAULT_LIVE_SETTLE_MS = 1200;
export const MIN_LIVE_SETTLE_MS = 300;
export const MAX_LIVE_SETTLE_MS = 10_000;

/** A line that keeps growing is translated at least this often (it is re-translated when it settles). */
export const LIVE_MAX_WAIT_MS = 8000;

/** Target language until the user picks one: the UI language. */
export function defaultTargetLanguage(ui: UiLanguage): string {
  return ui === "zh-CN" ? "zh-CN" : "en";
}

export function clampSettleMs(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_LIVE_SETTLE_MS;
  return Math.min(MAX_LIVE_SETTLE_MS, Math.max(MIN_LIVE_SETTLE_MS, Math.round(ms)));
}
