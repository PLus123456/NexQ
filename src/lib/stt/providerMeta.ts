// STT engine metadata: names, quick-swap picker options and capabilities, one
// entry per STTProviderType. The footer (ServiceStatusBar), Meeting Audio and
// the STT settings read their engine names, picker options and rules from
// here. Labels are product names, so they stay plain strings (the settings
// pages word the non-product ones through the `stt` namespace).

import type { STTProviderType } from "../types";
import { currentPlatform, type Platform } from "../platform";

/** Picker icon. ServiceStatusBar maps each key to a lucide icon, so a new key needs an icon there. */
export type SttIconKey = "globe" | "monitor" | "hardDrive" | "zap" | "cpu" | "cloud";

export type SttPlatform = "macos" | "windows" | "linux";

/**
 * What the engine does with the party's language:
 * - "auto": takes a language or detects it ("auto");
 * - "noAuto": needs a language (auto-detect falls back to English);
 * - "ignored": the model decides, the setting is only a label.
 */
export type SttLanguageSupport = "auto" | "noAuto" | "ignored";

export interface SttProviderMeta {
  id: STTProviderType;
  /** Name on the status chips and in the no-transcript banner. */
  label: string;
  /** Name in the quick-swap picker (can differ from `label`, e.g. "Azure Speech"). */
  pickerLabel: string;
  icon: SttIconKey;
  /** Where the engine works; the pickers only offer it there (`STT_PROVIDER_OPTIONS`). */
  platforms: readonly SttPlatform[];
  /** Needs an API key, stored under the engine id (or `keySlot`). */
  requiresApiKey: boolean;
  /** Keychain slot of the engine's key when it isn't the engine id. */
  keySlot?: string;
  /** Usable once its server address is set (remote STT); its key is optional. */
  requiresBaseUrl?: boolean;
  /** Grouped under "Cloud" in the picker (otherwise "Local & Built-in"). */
  isCloud: boolean;
  /** Runs on this machine, as the backend's `is_local` (which counts Web Speech as local). */
  isLocal: boolean;
  /** Only works on an input (microphone) device, not on system audio. */
  inputOnly?: boolean;
  /** Local engine whose model must be downloaded before the engine is offered. */
  requiresDownload?: string;
  /** The engine translates by itself, without the translation pipeline. */
  supportsNativeTranslation: boolean;
  languageSupport: SttLanguageSupport;
  /** Not offered in the quick-swap picker. */
  hidden: boolean;
}

const ALL_PLATFORMS: readonly SttPlatform[] = ["macos", "windows", "linux"];

/** Every STT engine, in picker order. */
export const STT_PROVIDERS: readonly SttProviderMeta[] = [
  {
    id: "web_speech", label: "Web Speech", pickerLabel: "Web Speech", icon: "globe", // i18n-ignore: product names (the settings word the others via stt:engines.*)
    platforms: ["macos", "windows"], // the webview's SpeechRecognition (WebKitGTK has none)
    requiresApiKey: false, isCloud: false, isLocal: true, inputOnly: true,
    supportsNativeTranslation: false, languageSupport: "noAuto", hidden: false,
  },
  {
    id: "windows_native", label: "Windows Speech", pickerLabel: "Windows Speech", icon: "monitor", // i18n-ignore: product names (the settings word the others via stt:engines.*)
    platforms: ["windows"],
    requiresApiKey: false, isCloud: false, isLocal: true, inputOnly: true,
    supportsNativeTranslation: false, languageSupport: "noAuto", hidden: false,
  },
  {
    id: "sherpa_onnx", label: "Sherpa-ONNX", pickerLabel: "Sherpa-ONNX", icon: "hardDrive", // i18n-ignore: product names (the settings word the others via stt:engines.*)
    platforms: ALL_PLATFORMS,
    requiresApiKey: false, isCloud: false, isLocal: true, requiresDownload: "sherpa_onnx",
    // SenseVoice models detect; the streaming transducers ignore the language.
    supportsNativeTranslation: false, languageSupport: "auto", hidden: false,
  },
  {
    id: "ort_streaming", label: "ORT Streaming", pickerLabel: "ORT Streaming", icon: "zap", // i18n-ignore: product names (the settings word the others via stt:engines.*)
    platforms: ALL_PLATFORMS,
    requiresApiKey: false, isCloud: false, isLocal: true, requiresDownload: "ort_streaming",
    supportsNativeTranslation: false, languageSupport: "ignored", hidden: false,
  },
  {
    // Live dual-pass engine (Metal on macOS); there is no batch-only path.
    id: "whisper_cpp", label: "Whisper.cpp", pickerLabel: "Whisper.cpp", icon: "hardDrive", // i18n-ignore: product names (the settings word the others via stt:engines.*)
    platforms: ALL_PLATFORMS,
    requiresApiKey: false, isCloud: false, isLocal: true, requiresDownload: "whisper_cpp",
    supportsNativeTranslation: false, languageSupport: "auto", hidden: false,
  },
  {
    id: "parakeet_tdt", label: "Parakeet TDT", pickerLabel: "Parakeet TDT", icon: "cpu", // i18n-ignore: product names (the settings word the others via stt:engines.*)
    platforms: ALL_PLATFORMS,
    requiresApiKey: false, isCloud: false, isLocal: true, requiresDownload: "parakeet_tdt",
    supportsNativeTranslation: false, languageSupport: "ignored", hidden: false,
  },
  {
    id: "deepgram", label: "Deepgram", pickerLabel: "Deepgram", icon: "cloud", // i18n-ignore: product names (the settings word the others via stt:engines.*)
    platforms: ALL_PLATFORMS,
    requiresApiKey: true, isCloud: true, isLocal: false,
    // Nova 2/3 detect ("multi"); older models fall back to English.
    supportsNativeTranslation: false, languageSupport: "auto", hidden: false,
  },
  {
    id: "whisper_api", label: "Whisper API", pickerLabel: "Whisper API", icon: "cloud", // i18n-ignore: product names (the settings word the others via stt:engines.*)
    platforms: ALL_PLATFORMS,
    requiresApiKey: true, isCloud: true, isLocal: false,
    supportsNativeTranslation: false, languageSupport: "auto", hidden: false,
  },
  {
    id: "azure_speech", label: "Azure", pickerLabel: "Azure Speech", icon: "cloud", // i18n-ignore: product names (the settings word the others via stt:engines.*)
    platforms: ALL_PLATFORMS,
    requiresApiKey: true, isCloud: true, isLocal: false,
    supportsNativeTranslation: false, languageSupport: "noAuto", hidden: false,
  },
  {
    id: "groq_whisper", label: "Groq STT", pickerLabel: "Groq Whisper", icon: "zap", // i18n-ignore: product names (the settings word the others via stt:engines.*)
    platforms: ALL_PLATFORMS,
    requiresApiKey: true, isCloud: true, isLocal: false,
    supportsNativeTranslation: false, languageSupport: "auto", hidden: false,
  },
  {
    // NexQ Plus: faster-whisper-server / speaches, vLLM, LocalAI… on any machine.
    id: "openai_compat", label: "Remote Whisper", pickerLabel: "Remote Whisper", icon: "cloud", // i18n-ignore: product names (the settings word the others via stt:engines.*)
    platforms: ALL_PLATFORMS,
    requiresApiKey: false, keySlot: "openai_compat_stt", requiresBaseUrl: true,
    isCloud: true, isLocal: false,
    supportsNativeTranslation: false, languageSupport: "auto", hidden: false,
  },
  {
    // NexQ Plus: real-time recognition + one-way translation in the same stream.
    id: "soniox", label: "Soniox", pickerLabel: "Soniox", icon: "cloud", // i18n-ignore: product names (the settings word the others via stt:engines.*)
    platforms: ALL_PLATFORMS,
    requiresApiKey: true, isCloud: true, isLocal: false,
    supportsNativeTranslation: true, languageSupport: "auto", hidden: false,
  },
];

/** The engine with this id, or undefined for an unknown id. */
export function sttProviderMeta(id: string): SttProviderMeta | undefined {
  return STT_PROVIDERS.find((p) => p.id === id);
}

/** Whether `meta` works on `platform`; an unknown platform hides nothing. */
export function isSttProviderOnPlatform(meta: SttProviderMeta, platform: Platform): boolean {
  return platform === "unknown" || meta.platforms.includes(platform);
}

/** The engines offered on `platform`, in picker order (hidden ones left out). */
export function sttProvidersFor(platform: Platform): SttProviderMeta[] {
  return STT_PROVIDERS.filter((p) => !p.hidden && isSttProviderOnPlatform(p, platform));
}

/** Keychain slot of an engine's API key (the engine id unless it has its own slot). */
export function sttKeySlot(meta: SttProviderMeta): string {
  return meta.keySlot ?? meta.id;
}

// ── Human-friendly engine labels ──
export const STT_LABELS: Record<string, string> = Object.fromEntries(
  STT_PROVIDERS.map((p) => [p.id, p.label]),
);

// ── STT provider options for the quick-swap picker (this platform's engines) ──
// Mirrors the Meeting Audio picker — same availability rules apply.
export const STT_PROVIDER_OPTIONS: readonly SttProviderMeta[] = sttProvidersFor(currentPlatform());

// ── Web Speech / Windows Speech mutual exclusion ──
// These providers capture from the OS default mic via a single SpeechRecognition instance.
// Only one can be active across both parties at any time.
export const EXCLUSIVE_PROVIDERS: readonly STTProviderType[] = ["web_speech", "windows_native"];

/**
 * Fallback for the party that gives up an exclusive engine: the first available
 * of these. Remote Whisper is left out: the footer can't tell whether its
 * server address is set.
 */
export const EXCLUSIVE_FALLBACK_ORDER: readonly STTProviderType[] = [
  "deepgram", "soniox", "groq_whisper", "whisper_api", "azure_speech",
  "sherpa_onnx", "ort_streaming", "parakeet_tdt", "whisper_cpp",
];

export function isExclusiveProvider(provider: string): boolean {
  return EXCLUSIVE_PROVIDERS.includes(provider as STTProviderType);
}

// ── Local model ids ──

/** Engines that run a downloaded model; their chip shows which one. */
export const LOCAL_MODEL_ENGINES: readonly STTProviderType[] = STT_PROVIDERS
  .filter((p) => p.requiresDownload)
  .map((p) => p.id);

/** Model used until one is activated for the engine (whisper.cpp has activeWhisperModel instead). */
export const DEFAULT_MODEL_PER_ENGINE: Readonly<Record<string, string>> = {
  sherpa_onnx: "streaming-zipformer-en-20M",
  ort_streaming: "zipformer-en-20M",
  parakeet_tdt: "parakeet-tdt-0.6b-v3-int8",
};

/**
 * The model a party's chip shows: the party's own `local_model_id`, else the
 * engine's active model, else its default (whisper.cpp: the active Whisper
 * model). Empty ids count as unset. Only LOCAL_MODEL_ENGINES display it.
 */
export function resolveLocalModelId(
  provider: string,
  explicitId: string | null | undefined,
  activeModelPerEngine: Record<string, string>,
  activeWhisperModel: string | null,
): string | undefined {
  return explicitId
    || activeModelPerEngine[provider]
    || DEFAULT_MODEL_PER_ENGINE[provider]
    || (provider === "whisper_cpp" ? activeWhisperModel : undefined)
    || undefined;
}

/**
 * The `local_model_id` to store when a party switches to `provider`: the
 * engine's active model, else its default (whisper.cpp: the active Whisper
 * model). Undefined leaves the party's id as it is (engines without a model,
 * and an empty active model).
 */
export function localModelIdOnSwitch(
  provider: STTProviderType,
  activeModelPerEngine: Record<string, string>,
  activeWhisperModel: string | null,
): string | undefined {
  if (provider === "whisper_cpp") {
    return (activeModelPerEngine.whisper_cpp ?? activeWhisperModel) || undefined;
  }
  if (!(provider in DEFAULT_MODEL_PER_ENGINE)) return undefined;
  return (activeModelPerEngine[provider]
    ?? DEFAULT_MODEL_PER_ENGINE[provider]
    ?? activeWhisperModel) || undefined;
}

// ── Availability ──

/** What decides whether an engine can run right now (loaded by each picker). */
export interface SttAvailabilityContext {
  /** The party's device is an input (microphone). */
  isInput: boolean;
  /** Whether a model of this local engine is downloaded (undefined = not known yet). */
  isEngineReady: (engine: string) => boolean | undefined;
  /** Whether this keychain slot has a key (undefined = not known yet). */
  hasKey: (slot: string) => boolean | undefined;
  /** Remote STT: whether a server address is set. */
  hasBaseUrl: boolean;
}

/**
 * Whether `meta` can be picked: right device kind, model downloaded, key or
 * server address set. Unknown status counts as available, so a slow check
 * never triggers a fallback.
 */
export function isSttProviderAvailable(meta: SttProviderMeta, ctx: SttAvailabilityContext): boolean {
  if (meta.inputOnly && !ctx.isInput) return false;
  if (meta.requiresDownload) return ctx.isEngineReady(meta.requiresDownload) ?? true;
  if (meta.requiresBaseUrl) return ctx.hasBaseUrl;
  if (meta.requiresApiKey) return ctx.hasKey(sttKeySlot(meta)) ?? true;
  return true;
}
