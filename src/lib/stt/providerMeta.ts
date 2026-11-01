// STT engine metadata: names, quick-swap picker options and capabilities, one
// entry per STTProviderType. The footer (ServiceStatusBar) reads its engine
// names, picker options and rules from here. Labels are product names, so they
// stay plain strings.

import type { STTProviderType } from "../types";

/** Picker icon. ServiceStatusBar maps each key to a lucide icon, so a new key needs an icon there. */
export type SttIconKey = "globe" | "monitor" | "hardDrive" | "zap" | "cpu" | "cloud";

export type SttPlatform = "macos" | "windows" | "linux";

export interface SttProviderMeta {
  id: STTProviderType;
  /** Name on the status chips and in the no-transcript banner. */
  label: string;
  /** Name in the quick-swap picker (can differ from `label`, e.g. "Azure Speech"). */
  pickerLabel: string;
  icon: SttIconKey;
  /** Where the engine works. Not applied yet: no list is filtered by it. */
  platforms: readonly SttPlatform[];
  /** Needs an API key, stored under the engine id. */
  requiresApiKey: boolean;
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
  /** Not offered in the quick-swap picker. */
  hidden: boolean;
}

const ALL_PLATFORMS: readonly SttPlatform[] = ["macos", "windows", "linux"];

/** Every STT engine, in picker order. */
export const STT_PROVIDERS: readonly SttProviderMeta[] = [
  {
    id: "web_speech", label: "Web Speech", pickerLabel: "Web Speech", icon: "globe",
    platforms: ["macos", "windows"], // the webview's SpeechRecognition (WebKitGTK has none)
    requiresApiKey: false, isCloud: false, isLocal: true, inputOnly: true,
    supportsNativeTranslation: false, hidden: false,
  },
  {
    id: "windows_native", label: "Windows Speech", pickerLabel: "Windows Speech", icon: "monitor",
    platforms: ["windows"],
    requiresApiKey: false, isCloud: false, isLocal: true, inputOnly: true,
    supportsNativeTranslation: false, hidden: false,
  },
  {
    id: "sherpa_onnx", label: "Sherpa-ONNX", pickerLabel: "Sherpa-ONNX", icon: "hardDrive",
    platforms: ALL_PLATFORMS,
    requiresApiKey: false, isCloud: false, isLocal: true, requiresDownload: "sherpa_onnx",
    supportsNativeTranslation: false, hidden: false,
  },
  {
    id: "ort_streaming", label: "ORT Streaming", pickerLabel: "ORT Streaming", icon: "zap",
    platforms: ALL_PLATFORMS,
    requiresApiKey: false, isCloud: false, isLocal: true, requiresDownload: "ort_streaming",
    supportsNativeTranslation: false, hidden: false,
  },
  {
    id: "whisper_cpp", label: "Whisper.cpp", pickerLabel: "Whisper.cpp", icon: "hardDrive",
    platforms: ALL_PLATFORMS,
    requiresApiKey: false, isCloud: false, isLocal: true, requiresDownload: "whisper_cpp",
    supportsNativeTranslation: false, hidden: true, // not offered in the picker yet
  },
  {
    id: "parakeet_tdt", label: "Parakeet TDT", pickerLabel: "Parakeet TDT", icon: "cpu",
    platforms: ALL_PLATFORMS,
    requiresApiKey: false, isCloud: false, isLocal: true, requiresDownload: "parakeet_tdt",
    supportsNativeTranslation: false, hidden: false,
  },
  {
    id: "deepgram", label: "Deepgram", pickerLabel: "Deepgram", icon: "cloud",
    platforms: ALL_PLATFORMS,
    requiresApiKey: true, isCloud: true, isLocal: false,
    supportsNativeTranslation: false, hidden: false,
  },
  {
    id: "whisper_api", label: "Whisper API", pickerLabel: "Whisper API", icon: "cloud",
    platforms: ALL_PLATFORMS,
    requiresApiKey: true, isCloud: true, isLocal: false,
    supportsNativeTranslation: false, hidden: false,
  },
  {
    id: "azure_speech", label: "Azure", pickerLabel: "Azure Speech", icon: "cloud",
    platforms: ALL_PLATFORMS,
    requiresApiKey: true, isCloud: true, isLocal: false,
    supportsNativeTranslation: false, hidden: false,
  },
  {
    id: "groq_whisper", label: "Groq STT", pickerLabel: "Groq Whisper", icon: "zap",
    platforms: ALL_PLATFORMS,
    requiresApiKey: true, isCloud: true, isLocal: false,
    supportsNativeTranslation: false, hidden: false,
  },
];

/** The engine with this id, or undefined for an unknown id. */
export function sttProviderMeta(id: string): SttProviderMeta | undefined {
  return STT_PROVIDERS.find((p) => p.id === id);
}

// ── Human-friendly engine labels ──
export const STT_LABELS: Record<string, string> = Object.fromEntries(
  STT_PROVIDERS.map((p) => [p.id, p.label]),
);

// ── STT provider options for the quick-swap picker ──
// Mirrors MeetingAudioSettings.tsx STT_OPTIONS — same availability rules apply.
export const STT_PROVIDER_OPTIONS: readonly SttProviderMeta[] = STT_PROVIDERS.filter((p) => !p.hidden);

// ── Web Speech / Windows Speech mutual exclusion ──
// These providers capture from the OS default mic via a single SpeechRecognition instance.
// Only one can be active across both parties at any time.
export const EXCLUSIVE_PROVIDERS: readonly STTProviderType[] = ["web_speech", "windows_native"];

/** Fallback for the party that gives up an exclusive engine: the first available of these. */
export const EXCLUSIVE_FALLBACK_ORDER: readonly STTProviderType[] = [
  "deepgram", "groq_whisper", "whisper_api", "azure_speech",
  "sherpa_onnx", "ort_streaming", "parakeet_tdt",
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
 * engine's active model, else its default. Undefined leaves the party's id as
 * it is (engines without a default model, and an empty active model).
 */
export function localModelIdOnSwitch(
  provider: STTProviderType,
  activeModelPerEngine: Record<string, string>,
  activeWhisperModel: string | null,
): string | undefined {
  if (!(provider in DEFAULT_MODEL_PER_ENGINE)) return undefined;
  return (activeModelPerEngine[provider]
    ?? DEFAULT_MODEL_PER_ENGINE[provider]
    ?? activeWhisperModel) || undefined;
}
