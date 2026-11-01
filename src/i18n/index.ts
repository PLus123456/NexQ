// UI translations (i18next + react-i18next).
//
// - React components: `const { t } = useT("settings")`, then `t("about.title")`.
//   Keys of other namespaces need them listed: `useT(["settings", "common"])`
//   allows `t("common:actions.save")` (the first namespace is the default).
//   Named `useT` because `useTranslation` is already the transcript-translation
//   hook in src/hooks. Markup inside a string: `<Trans>` (re-exported here).
// - Outside React: `t("settings:updates.toast.title")`, called at use time,
//   never at module top level (it would not follow language changes).
// - Dates and numbers: `formatDate()` / `formatNumber()` follow the UI language.
//
// The setting `uiLanguage` ("system" | "zh-CN" | "en", default "system") lives
// in config.json. Every window applies changes made in another window through
// the store's onKeyChange, and pushes the resolved language to Rust (tray).

import i18next from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";

export { Trans } from "react-i18next";
import { load, type Store } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { APP_NAME } from "../lib/brand";
import { DEFAULT_NS, NAMESPACES, resources } from "./resources";

export { NAMESPACES, type Namespace } from "./resources";

/** A language the UI is translated into. */
export type UiLanguage = "zh-CN" | "en";
/** The stored choice: a language, or follow the system. */
export type UiLanguageSetting = "system" | UiLanguage;

export const UI_LANGUAGES: readonly UiLanguage[] = ["zh-CN", "en"];
/** Each UI language's name in that language (shown the same in every UI language). */
export const UI_LANGUAGE_NAMES: Readonly<Record<UiLanguage, string>> = {
  "zh-CN": "简体中文",
  en: "English",
};
export const UI_LANGUAGE_KEY = "uiLanguage";
const FALLBACK_LANGUAGE: UiLanguage = "en";
const STORE_FILE = "config.json";

/** `react-i18next`'s hook under the project's name (see the header comment). */
export const useT = useTranslation;

/** Translate outside React (toasts, dialogs, stores). */
export const t = ((...args: unknown[]) =>
  (i18next.t as unknown as (...a: unknown[]) => string)(...args)) as unknown as typeof i18next.t;

export function isUiLanguage(value: unknown): value is UiLanguage {
  return value === "zh-CN" || value === "en";
}

/** A stored value as a setting; anything unknown means "system". */
export function normalizeUiLanguageSetting(value: unknown): UiLanguageSetting {
  return isUiLanguage(value) ? value : "system";
}

/** The system's preferred language (`navigator.languages[0]`), if any. */
function systemLanguage(): string | undefined {
  if (typeof navigator === "undefined") return undefined;
  return navigator.languages?.[0] ?? navigator.language;
}

/** "system" → zh-CN when the system language is Chinese, else en. */
export function resolveUiLanguage(
  setting: UiLanguageSetting,
  system: string | undefined = systemLanguage(),
): UiLanguage {
  if (setting !== "system") return setting;
  return system?.toLowerCase().startsWith("zh") ? "zh-CN" : FALLBACK_LANGUAGE;
}

interface UiLanguageState {
  setting: UiLanguageSetting;
  language: UiLanguage;
}

/** Current setting and resolved language (reactive; `useUiLanguage()` in components). */
export const useUiLanguageStore = create<UiLanguageState>(() => ({
  setting: "system",
  language: FALLBACK_LANGUAGE,
}));

export function useUiLanguage(): UiLanguageState {
  const setting = useUiLanguageStore((s) => s.setting);
  const language = useUiLanguageStore((s) => s.language);
  return { setting, language };
}

/** The language the UI is shown in right now. */
export function currentUiLanguage(): UiLanguage {
  return useUiLanguageStore.getState().language;
}

let initPromise: Promise<void> | null = null;
let storePromise: Promise<Store> | null = null;
/** Off in tests and other non-app contexts: no store, no Rust. */
let connected = false;

function getStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = load(STORE_FILE, { autoSave: true, defaults: {} });
    storePromise.catch(() => {
      storePromise = null;
    });
  }
  return storePromise;
}

function pushToRust(language: UiLanguage): void {
  invoke("set_ui_language", { lang: language }).catch((err) =>
    console.warn("[i18n] Failed to set the tray language:", err),
  );
}

/** Applies a setting in this window (no persisting). */
async function applySetting(setting: UiLanguageSetting): Promise<void> {
  const language = resolveUiLanguage(setting);
  const changed = language !== useUiLanguageStore.getState().language;
  useUiLanguageStore.setState({ setting, language });
  if (typeof document !== "undefined") document.documentElement.lang = language;
  if (i18next.language !== language) await i18next.changeLanguage(language);
  if (connected && changed) pushToRust(language);
}

export interface InitI18nOptions {
  /** Use this language and skip the stored setting, the store and Rust (tests). */
  language?: UiLanguage;
}

/**
 * Initializes translations before the first render (main.tsx awaits it).
 * Reads the stored setting, subscribes to changes from other windows and
 * pushes the language to Rust. Safe to call more than once.
 */
export function initI18n(options: InitI18nOptions = {}): Promise<void> {
  if (!initPromise) initPromise = doInit(options);
  return initPromise;
}

async function doInit({ language }: InitI18nOptions): Promise<void> {
  connected = language === undefined;
  let setting: UiLanguageSetting = language ?? "system";
  let store: Store | null = null;
  if (connected) {
    try {
      store = await getStore();
      setting = normalizeUiLanguageSetting(await store.get(UI_LANGUAGE_KEY));
    } catch (err) {
      console.warn("[i18n] Failed to read the UI language setting:", err);
    }
  }
  const resolved = resolveUiLanguage(setting);

  await i18next.use(initReactI18next).init({
    resources,
    lng: resolved,
    fallbackLng: FALLBACK_LANGUAGE,
    supportedLngs: [...UI_LANGUAGES],
    ns: [...NAMESPACES],
    defaultNS: DEFAULT_NS,
    initAsync: false,
    returnNull: false,
    interpolation: {
      // React escapes on render.
      escapeValue: false,
      defaultVariables: { appName: APP_NAME },
    },
    react: { useSuspense: false },
  });

  useUiLanguageStore.setState({ setting, language: resolved });
  if (typeof document !== "undefined") document.documentElement.lang = resolved;
  if (!connected) return;

  pushToRust(resolved);
  store
    ?.onKeyChange<string>(UI_LANGUAGE_KEY, (value) => {
      void applySetting(normalizeUiLanguageSetting(value));
    })
    .catch((err) => console.warn("[i18n] Failed to watch the UI language setting:", err));
  // "system" follows OS language changes while the app runs.
  if (typeof window !== "undefined") {
    window.addEventListener("languagechange", () => {
      if (useUiLanguageStore.getState().setting === "system") void applySetting("system");
    });
  }
}

/** Changes and stores the UI language; every window follows. */
export async function changeUiLanguage(setting: UiLanguageSetting): Promise<void> {
  await applySetting(setting);
  if (!connected) return;
  try {
    const store = await getStore();
    await store.set(UI_LANGUAGE_KEY, setting);
  } catch (err) {
    console.warn("[i18n] Failed to save the UI language setting:", err);
  }
}

function toDate(value: Date | number | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** A date in the UI language (default: medium date, e.g. "Nov 1, 2026" / "2026年11月1日"). */
export function formatDate(
  value: Date | number | string,
  options: Intl.DateTimeFormatOptions = { dateStyle: "medium" },
): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(currentUiLanguage(), options).format(date);
}

/** A number in the UI language. */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(currentUiLanguage(), options).format(value);
}
