// Translation providers as the settings page and the quick setup show them.
// Labels and descriptions are i18n keys (translated at render time).

import { joinEndpoint, normalizeBaseUrl, stripEndpointPath, type EndpointError } from "../../lib/endpoint";
import type { TranslationProviderType } from "../../lib/types";
import type { TranslationEndpoints } from "../../lib/translation/types";

export type CloudProvider = keyof TranslationEndpoints;

export interface ProviderOption {
  value: TranslationProviderType;
  /** Product names stay as they are; only the LLM entry has a translated name. */
  label: string;
  labelKey?: "providers.llm.label";
  descriptionKey:
    | "providers.opusMt.description"
    | "providers.llm.description"
    | "providers.microsoft.description"
    | "providers.google.description"
    | "providers.deepl.description";
  requiresApiKey: boolean;
  isLocal: boolean;
  credentialKey: string;
  needsRegion?: boolean;
  helpUrl?: string;
}

export const LOCAL_PROVIDERS: readonly ProviderOption[] = [
  {
    value: "opus-mt",
    label: "OPUS-MT",
    descriptionKey: "providers.opusMt.description",
    requiresApiKey: false,
    isLocal: true,
    credentialKey: "",
  },
  {
    value: "llm",
    label: "LLM Translation", // i18n-ignore: shown through labelKey
    labelKey: "providers.llm.label",
    descriptionKey: "providers.llm.description",
    requiresApiKey: false,
    isLocal: true,
    credentialKey: "",
  },
];

export const CLOUD_PROVIDERS: readonly ProviderOption[] = [
  {
    value: "microsoft",
    label: "Microsoft Translator", // i18n-ignore: product name
    descriptionKey: "providers.microsoft.description",
    requiresApiKey: true,
    isLocal: false,
    credentialKey: "translation_microsoft",
    needsRegion: true,
    helpUrl: "https://learn.microsoft.com/en-us/azure/cognitive-services/translator/quickstart-text-rest-api",
  },
  {
    value: "google",
    label: "Google Translate", // i18n-ignore: product name
    descriptionKey: "providers.google.description",
    requiresApiKey: true,
    isLocal: false,
    credentialKey: "translation_google",
    helpUrl: "https://cloud.google.com/translate/docs/setup",
  },
  {
    value: "deepl",
    label: "DeepL",
    descriptionKey: "providers.deepl.description",
    requiresApiKey: true,
    isLocal: false,
    credentialKey: "translation_deepl",
    helpUrl: "https://www.deepl.com/pro-api",
  },
];

export const ALL_PROVIDERS: readonly ProviderOption[] = [...LOCAL_PROVIDERS, ...CLOUD_PROVIDERS];

export function providerOption(value: string): ProviderOption | undefined {
  return ALL_PROVIDERS.find((p) => p.value === value);
}

export function isCloudProvider(value: string): value is CloudProvider {
  return value === "deepl" || value === "microsoft" || value === "google";
}

export const MICROSOFT_REGION_KEY = "translation_microsoft_region";

export const AZURE_REGIONS = [
  "global",
  "eastus",
  "eastus2",
  "westus",
  "westus2",
  "centralus",
  "northeurope",
  "westeurope",
  "southeastasia",
  "eastasia",
  "japaneast",
  "australiaeast",
  "brazilsouth",
  "canadacentral",
  "uksouth",
  "chinaeast2",
  "chinanorth3",
];

// ── Service addresses (same rules as src-tauri/src/translation/*.rs) ──

const DEEPL_FREE_URL = "https://api-free.deepl.com/v2";
const DEEPL_PRO_URL = "https://api.deepl.com/v2";
const MICROSOFT_DEFAULT_URL = "https://api.cognitive.microsofttranslator.com";
const GOOGLE_DEFAULT_URL = "https://translation.googleapis.com/language/translate/v2";

/** Pasted full addresses are cut back to these bases. */
const KNOWN_PATHS: Record<CloudProvider, readonly string[]> = {
  deepl: ["/translate", "/languages"],
  microsoft: ["/translate", "/detect", "/languages"],
  google: ["/detect", "/languages"],
};

/** The official address shown as the field's placeholder. */
export function defaultEndpoint(provider: CloudProvider, apiKey = ""): string {
  switch (provider) {
    case "deepl":
      return apiKey.trim().endsWith(":fx") ? DEEPL_FREE_URL : DEEPL_PRO_URL;
    case "microsoft":
      return MICROSOFT_DEFAULT_URL;
    case "google":
      return GOOGLE_DEFAULT_URL;
  }
}

export type EndpointPreview =
  | { ok: true; url: string; custom: boolean; trimmed?: string }
  | { ok: false; error: EndpointError };

/** Where translation requests go with this (possibly empty) custom address. */
export function previewTranslateUrl(provider: CloudProvider, custom: string, apiKey = ""): EndpointPreview {
  const input = custom.trim();
  let base = defaultEndpoint(provider, apiKey);
  let trimmed: string | undefined;
  if (input) {
    const normalized = normalizeBaseUrl(input);
    if (!normalized.ok) return { ok: false, error: normalized.error };
    const stripped = stripEndpointPath(input, KNOWN_PATHS[provider]);
    base = stripped?.base ?? normalized.base;
    trimmed = stripped?.path;
  }
  const path = provider === "google" ? "" : "/translate";
  const joined = joinEndpoint(base, path);
  if (!joined.ok) return { ok: false, error: joined.error };
  let url = joined.url;
  if (provider === "microsoft") {
    // The app sets the languages itself (a pasted sample's own to/from are dropped).
    const parsed = new URL(url);
    parsed.searchParams.delete("to");
    parsed.searchParams.delete("from");
    if (!parsed.searchParams.has("api-version")) parsed.searchParams.set("api-version", "3.0");
    url = parsed.href;
  }
  return { ok: true, url, custom: Boolean(input), trimmed };
}
