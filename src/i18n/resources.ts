// Every namespace of every UI language, imported statically (bundled, no
// loading step). One JSON file per namespace and language; each namespace
// belongs to one work package (see README.md). Only P0 edits this file.

import enCalllog from "./locales/en/calllog.json";
import enCommon from "./locales/en/common.json";
import enLauncher from "./locales/en/launcher.json";
import enLlm from "./locales/en/llm.json";
import enMisc from "./locales/en/misc.json";
import enOnboarding from "./locales/en/onboarding.json";
import enOverlay from "./locales/en/overlay.json";
import enRag from "./locales/en/rag.json";
import enSettings from "./locales/en/settings.json";
import enStt from "./locales/en/stt.json";
import enTranslation from "./locales/en/translation.json";
import zhCalllog from "./locales/zh-CN/calllog.json";
import zhCommon from "./locales/zh-CN/common.json";
import zhLauncher from "./locales/zh-CN/launcher.json";
import zhLlm from "./locales/zh-CN/llm.json";
import zhMisc from "./locales/zh-CN/misc.json";
import zhOnboarding from "./locales/zh-CN/onboarding.json";
import zhOverlay from "./locales/zh-CN/overlay.json";
import zhRag from "./locales/zh-CN/rag.json";
import zhSettings from "./locales/zh-CN/settings.json";
import zhStt from "./locales/zh-CN/stt.json";
import zhTranslation from "./locales/zh-CN/translation.json";

export const NAMESPACES = [
  "common",
  "settings",
  "llm",
  "stt",
  "translation",
  "rag",
  "onboarding",
  "launcher",
  "overlay",
  "calllog",
  "misc",
] as const;

export type Namespace = (typeof NAMESPACES)[number];

export const DEFAULT_NS = "common" satisfies Namespace;

/** English is the source of truth: key types are generated from it (i18next.d.ts). */
export const en = {
  common: enCommon,
  settings: enSettings,
  llm: enLlm,
  stt: enStt,
  translation: enTranslation,
  rag: enRag,
  onboarding: enOnboarding,
  launcher: enLauncher,
  overlay: enOverlay,
  calllog: enCalllog,
  misc: enMisc,
} satisfies Record<Namespace, object>;

export const zhCN = {
  common: zhCommon,
  settings: zhSettings,
  llm: zhLlm,
  stt: zhStt,
  translation: zhTranslation,
  rag: zhRag,
  onboarding: zhOnboarding,
  launcher: zhLauncher,
  overlay: zhOverlay,
  calllog: zhCalllog,
  misc: zhMisc,
} satisfies Record<Namespace, object>;

export const resources = {
  en,
  "zh-CN": zhCN,
};
