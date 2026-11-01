// How translations are shown on transcript lines.

import { baseLanguage } from "../languages";
import type { TranslationResult } from "../types";

/** Provider ids some sources send instead of a display name. */
const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  soniox: "Soniox",
  deepl: "DeepL",
  microsoft: "Microsoft Translator",
  google: "Google Cloud Translation",
  "opus-mt": "OPUS-MT",
};

/** "soniox" → "Soniox"; names the backend already formats ("DeepL", "DeepSeek · deepseek-chat") stay as they are. */
export function providerDisplayName(provider: string): string {
  return PROVIDER_NAMES[provider.trim().toLowerCase()] ?? provider;
}

/** Languages whose sentences follow each other without a space. */
const NO_SPACE_LANGUAGES = new Set(["zh", "ja", "yue", "lzh", "wuu"]);

export function joinTranslatedTexts(texts: readonly string[], targetLang: string): string {
  const separator = NO_SPACE_LANGUAGES.has(baseLanguage(targetLang)) ? "" : " ";
  return texts.map((t) => t.trim()).filter(Boolean).join(separator);
}

/** The translation of a displayed line, which may be several merged segments. */
export interface LineTranslation {
  /** Every part's translation in line order, joined ("" when there is none yet). */
  text: string;
  parts: TranslationResult[];
  /** Every segment of the line has a translation. */
  complete: boolean;
  /** A segment of the line is being translated. */
  pending: boolean;
  /** Why a segment without a translation failed. */
  error?: string;
  /** Distinct provider names, in order of appearance. */
  providers: string[];
}

export function lineTranslation(
  ids: readonly string[],
  translations: ReadonlyMap<string, TranslationResult>,
  translating: ReadonlySet<string>,
  errors: ReadonlyMap<string, string>,
): LineTranslation {
  const parts: TranslationResult[] = [];
  let error: string | undefined;
  for (const id of ids) {
    const part = translations.get(id);
    if (part) parts.push(part);
    else if (!error && errors.has(id)) error = errors.get(id);
  }
  const target = parts[0]?.target_lang ?? "";
  return {
    text: joinTranslatedTexts(parts.map((p) => p.translated_text), target),
    parts,
    complete: ids.length > 0 && parts.length === ids.length,
    pending: ids.some((id) => translating.has(id)),
    error,
    providers: [...new Set(parts.map((p) => providerDisplayName(p.provider)).filter(Boolean))],
  };
}
