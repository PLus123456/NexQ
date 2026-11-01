// The one language catalog for speech recognition and translation.
//
// - Codes are BCP 47 style tags ("en", "en-US", "zh-TW", "zh-Hant").
//   `normalizeLanguageCode()` gives any input the canonical case; codes that
//   aren't in the catalog are still valid (kept as typed, shown as the code).
// - Each entry has an English name, a Simplified Chinese name and the endonym.
//   Names are data, not UI strings: `languageLabel()` picks one per UI
//   language at call time (only "Auto-detect" goes through i18next).
// - The catalog keeps the regional recognition codes (en-US, ja-JP…) and the
//   plain translation codes (en, ja…) as separate entries. `zh` is "Chinese"
//   in general; `zh-CN` / `zh-TW` are Simplified / Traditional.
// - Engines and providers want other formats (DeepL "EN-US"/"ZH-HANS",
//   Microsoft "zh-Hans", Whisper and Soniox two letters): map them in Rust
//   (`stt/language.rs`, `translation/lang_map.rs`), not here.
//
// Frozen after P0: add entries and functions, don't change signatures.

import { currentUiLanguage, t, type UiLanguage } from "../i18n";

export interface LanguageInfo {
  /** Canonical code, e.g. "en", "en-US", "zh-TW". */
  code: string;
  /** English name. */
  en: string;
  /** Simplified Chinese name. */
  zh: string;
  /** The language's own name for itself (endonym). */
  native: string;
}

/** Stored instead of a code: detect the language automatically. */
export const AUTO_LANGUAGE = "auto";

function entry(code: string, en: string, zh: string, native: string): LanguageInfo {
  return Object.freeze({ code, en, zh, native });
}

/** Every known language, sorted by English name (regional entries after their base). */
export const LANGUAGES: readonly LanguageInfo[] = Object.freeze([
  entry("af", "Afrikaans", "南非荷兰语", "Afrikaans"),
  entry("ar", "Arabic", "阿拉伯语", "العربية"),
  entry("ar-SA", "Arabic", "阿拉伯语", "العربية"),
  entry("bn", "Bengali", "孟加拉语", "বাংলা"),
  entry("bg", "Bulgarian", "保加利亚语", "Български"),
  entry("zh", "Chinese", "中文", "中文"),
  entry("zh-CN", "Chinese (Simplified)", "简体中文", "简体中文"),
  entry("zh-TW", "Chinese (Traditional)", "繁体中文", "繁體中文"),
  entry("cs", "Czech", "捷克语", "Čeština"),
  entry("cs-CZ", "Czech", "捷克语", "Čeština"),
  entry("da", "Danish", "丹麦语", "Dansk"),
  entry("nl", "Dutch", "荷兰语", "Nederlands"),
  entry("nl-NL", "Dutch", "荷兰语", "Nederlands"),
  entry("en", "English", "英语", "English"),
  entry("en-GB", "English (UK)", "英语（英国）", "English (UK)"),
  entry("en-US", "English (US)", "英语（美国）", "English (US)"),
  entry("et", "Estonian", "爱沙尼亚语", "Eesti"),
  entry("fa", "Farsi (Persian)", "波斯语", "فارسی"),
  entry("fi", "Finnish", "芬兰语", "Suomi"),
  entry("fr", "French", "法语", "Français"),
  entry("fr-FR", "French", "法语", "Français"),
  entry("de", "German", "德语", "Deutsch"),
  entry("de-DE", "German", "德语", "Deutsch"),
  entry("el", "Greek", "希腊语", "Ελληνικά"),
  entry("he", "Hebrew", "希伯来语", "עברית"),
  entry("hi", "Hindi", "印地语", "हिन्दी"),
  entry("hi-IN", "Hindi", "印地语", "हिन्दी"),
  entry("hu", "Hungarian", "匈牙利语", "Magyar"),
  entry("id", "Indonesian", "印度尼西亚语", "Bahasa Indonesia"),
  entry("it", "Italian", "意大利语", "Italiano"),
  entry("it-IT", "Italian", "意大利语", "Italiano"),
  entry("ja", "Japanese", "日语", "日本語"),
  entry("ja-JP", "Japanese", "日语", "日本語"),
  entry("ko", "Korean", "韩语", "한국어"),
  entry("ko-KR", "Korean", "韩语", "한국어"),
  entry("ms", "Malay", "马来语", "Bahasa Melayu"),
  entry("no", "Norwegian", "挪威语", "Norsk"),
  entry("pl", "Polish", "波兰语", "Polski"),
  entry("pl-PL", "Polish", "波兰语", "Polski"),
  entry("pt", "Portuguese", "葡萄牙语", "Português"),
  entry("pt-BR", "Portuguese (Brazil)", "葡萄牙语（巴西）", "Português (Brasil)"),
  entry("ro", "Romanian", "罗马尼亚语", "Română"),
  entry("ru", "Russian", "俄语", "Русский"),
  entry("ru-RU", "Russian", "俄语", "Русский"),
  entry("sk", "Slovak", "斯洛伐克语", "Slovenčina"),
  entry("sl", "Slovenian", "斯洛文尼亚语", "Slovenščina"),
  entry("es", "Spanish", "西班牙语", "Español"),
  entry("es-ES", "Spanish", "西班牙语", "Español"),
  entry("sv", "Swedish", "瑞典语", "Svenska"),
  entry("sv-SE", "Swedish", "瑞典语", "Svenska"),
  entry("th", "Thai", "泰语", "ไทย"),
  entry("tr", "Turkish", "土耳其语", "Türkçe"),
  entry("tr-TR", "Turkish", "土耳其语", "Türkçe"),
  entry("uk", "Ukrainian", "乌克兰语", "Українська"),
  entry("ur", "Urdu", "乌尔都语", "اردو"),
  entry("vi", "Vietnamese", "越南语", "Tiếng Việt"),
]);

const BY_CODE: ReadonlyMap<string, LanguageInfo> = new Map(LANGUAGES.map((l) => [l.code, l]));

/** The 18 recognition languages, in today's STT list order. */
export const STT_COMMON: readonly string[] = Object.freeze([
  "en-US",
  "en-GB",
  "es-ES",
  "fr-FR",
  "de-DE",
  "it-IT",
  "pt-BR",
  "ja-JP",
  "zh-CN",
  "ko-KR",
  "nl-NL",
  "hi-IN",
  "ru-RU",
  "ar-SA",
  "tr-TR",
  "pl-PL",
  "cs-CZ",
  "sv-SE",
]);

/** The 38 translation targets, in today's order. */
export const TRANSLATION_COMMON: readonly string[] = Object.freeze([
  "af",
  "ar",
  "bn",
  "bg",
  "zh",
  "zh-TW",
  "cs",
  "da",
  "nl",
  "en",
  "et",
  "fa",
  "fi",
  "fr",
  "de",
  "el",
  "he",
  "hi",
  "hu",
  "id",
  "it",
  "ja",
  "ko",
  "ms",
  "no",
  "pl",
  "pt",
  "ro",
  "ru",
  "sk",
  "sl",
  "es",
  "sv",
  "th",
  "tr",
  "uk",
  "ur",
  "vi",
]);

/**
 * Trim, "_" → "-", canonical case per subtag: language lower ("ZH" → "zh"),
 * script title ("hans" → "Hans"), region upper ("cn" → "CN"); "auto" (any
 * case) → "auto"; "" → "". Unknown codes are kept (normalized), never
 * rejected. Empty subtags are dropped ("en-" → "en"); everything after a
 * singleton ("x-…", "u-…") stays lower case.
 */
export function normalizeLanguageCode(code: string): string {
  if (typeof code !== "string") return "";
  const subtags = code.trim().replace(/_/g, "-").split("-").filter(Boolean);
  let afterSingleton = false;
  return subtags
    .map((subtag, i) => {
      const lower = subtag.toLowerCase();
      if (i === 0 || afterSingleton) {
        if (lower.length === 1) afterSingleton = true;
        return lower;
      }
      if (lower.length === 1) {
        afterSingleton = true;
        return lower;
      }
      if (/^[a-z]{4}$/.test(lower)) return lower[0].toUpperCase() + lower.slice(1);
      if (/^(?:[a-z]{2}|\d{3})$/.test(lower)) return lower.toUpperCase();
      return lower;
    })
    .join("-");
}

/**
 * "zh-CN" → "zh", "en-US" → "en", "auto" → "auto". A private-use code
 * ("x-custom") has no base language and is returned whole.
 */
export function baseLanguage(code: string): string {
  const normalized = normalizeLanguageCode(code);
  const dash = normalized.indexOf("-");
  if (dash === -1 || dash === 1) return normalized;
  return normalized.slice(0, dash);
}

/** Exact (normalized) match, else the base language entry, else undefined. */
export function findLanguage(code: string): LanguageInfo | undefined {
  const normalized = normalizeLanguageCode(code);
  if (!normalized) return undefined;
  return BY_CODE.get(normalized) ?? BY_CODE.get(baseLanguage(normalized));
}

/** "Spanish" + "MX" → "Spanish (MX)"; "Farsi (Persian)" + "IR" → "Farsi (Persian, IR)". */
function qualify(name: string, qualifier: string, uiLanguage: UiLanguage): string {
  if (uiLanguage === "zh-CN") {
    return name.endsWith("）") ? `${name.slice(0, -1)}，${qualifier}）` : `${name}（${qualifier}）`;
  }
  return name.endsWith(")") ? `${name.slice(0, -1)}, ${qualifier})` : `${name} (${qualifier})`;
}

/**
 * Display name in the UI language (default `currentUiLanguage()`): zh → `zh`,
 * en → `en`; "auto" → the localized "Auto-detect" (common:labels.autoDetect);
 * unknown → the code itself (normalized); "" → "". For a regional code
 * without its own entry but with a base entry, the base name plus the rest
 * of the code, e.g. "Spanish (MX)" / "西班牙语（MX）".
 */
export function languageLabel(code: string, uiLanguage: UiLanguage = currentUiLanguage()): string {
  const normalized = normalizeLanguageCode(code);
  if (!normalized) return "";
  if (normalized === AUTO_LANGUAGE) return t("common:labels.autoDetect", { lng: uiLanguage });
  const field = uiLanguage === "zh-CN" ? "zh" : "en";
  const exact = BY_CODE.get(normalized);
  if (exact) return exact[field];
  const base = baseLanguage(normalized);
  const baseEntry = base !== normalized ? BY_CODE.get(base) : undefined;
  if (baseEntry) return qualify(baseEntry[field], normalized.slice(base.length + 1), uiLanguage);
  return normalized;
}
