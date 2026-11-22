// Transcription languages and what each speech-to-text provider does with them
// (upstream's module). In NexQ Plus the facts come from the fork's own sources,
// so nothing is kept twice:
// - the language list and its names: lib/languages.ts (the catalog every picker uses);
// - what an engine is called and whether it can detect the language at all:
//   lib/stt/providerMeta.ts (`pickerLabel`, `languageSupport`), which also covers
//   the fork's engines (Soniox, Remote Whisper).
// What is left here is upstream's model-by-model table and its wording, which
// Rust mirrors (see autoDetectCases.json).

import type { STTProviderType } from "./types";
import cases from "./autoDetectCases.json";
import { AUTO_LANGUAGE, STT_COMMON, baseLanguage, languageLabel } from "./languages";
import { DEFAULT_MODEL_PER_ENGINE, cartesiaSupportsLanguage, sttProviderMeta } from "./stt/providerMeta";

export { cartesiaSupportsLanguage };

export const AUTO_STT_LANGUAGE = AUTO_LANGUAGE;

/**
 * The transcription languages a short picker offers: Auto-detect, then the
 * catalog's common recognition languages. `label` is read when it is shown, so
 * it is in the UI language of that moment. A side can also be set to any other
 * catalog language (Settings > Audio & Devices); name those with
 * `languageLabel` from lib/languages.ts.
 */
export const STT_LANGUAGES: { value: string; label: string }[] = [AUTO_LANGUAGE, ...STT_COMMON].map((code) => ({
  value: code,
  get label() {
    return languageLabel(code);
  },
}));

/** The per-side picker's value for "use the shared transcription language". */
export const SAME_AS_SHARED_LANGUAGE = "";

/**
 * The language one side (You / Them / Room) is transcribed in: its own when it
 * has one, otherwise the shared transcription language. Mirrors
 * `PartyAudioConfig::effective_language` in src-tauri/src/audio/mod.rs.
 */
export function sideLanguage(
  side: { language?: string | null } | null | undefined,
  sharedLanguage: string,
): string {
  const own = side?.language?.trim();
  return own || sharedLanguage;
}

export function isDeepgramNova3(model?: string | null): boolean {
  return model === "nova-3" || model === "nova-3-general";
}

const MULTILINGUAL_WHISPER_MODELS = ["tiny", "base", "small", "medium", "large-v3-turbo"];

/** "ggml-small.bin" and "small" are the same Whisper model. */
function whisperModelId(model: string): string {
  return model.replace(/^ggml-/, "").replace(/\.bin$/, "");
}

/**
 * The Sherpa-ONNX model family that detects the language: NexQ Plus passes
 * SenseVoice "auto" (the transducers are one language each). The same test as
 * Rust's `supports_auto_language`.
 */
const isSenseVoice = (model: string | null | undefined): boolean => !!model && model.includes("sense-voice");

/**
 * Whether a provider (and its model) can detect the spoken language itself.
 * Where the model decides (Deepgram, Whisper.cpp, Parakeet, Sherpa-ONNX), the
 * table below does; for every other engine it is the engine's own
 * `languageSupport` in lib/stt/providerMeta.ts, the fork's engines included.
 * Mirrors `supports_auto_language` in src-tauri/src/commands/audio_commands.rs,
 * which refuses a meeting start for the same cases; AUTO_DETECT_CASES in the
 * tests is the table both sides are checked against.
 */
export function supportsSTTAutoDetection(
  provider: STTProviderType,
  model?: string | null,
): boolean {
  switch (provider) {
    case "deepgram":
      return isDeepgramNova3(model) || model === "flux-general-multi";
    case "whisper_cpp":
      return model == null || MULTILINGUAL_WHISPER_MODELS.includes(whisperModelId(model));
    case "parakeet_tdt":
      return !model || (!model.includes("parakeet") && !model.includes("nemo"))
        || model.startsWith("parakeet-tdt-0.6b-v3");
    case "sherpa_onnx":
      return isSenseVoice(model);
    default:
      return sttProviderMeta(provider)?.languageSupport === "auto";
  }
}

/** The models a side falls back to when its own config doesn't name one. */
export interface AutoDetectModels {
  deepgram?: string | null;
  whisperCpp?: string | null;
  parakeet?: string | null;
}

export interface AutoDetectSide {
  provider: STTProviderType;
  localModel?: string | null;
}

/** The model that will actually run for a side, as far as the settings know. */
export function autoDetectModelFor(side: AutoDetectSide, models: AutoDetectModels): string | null | undefined {
  switch (side.provider) {
    case "deepgram":
      return models.deepgram;
    case "whisper_cpp":
      return side.localModel ?? models.whisperCpp;
    case "parakeet_tdt":
      return side.localModel ?? models.parakeet;
    case "sherpa_onnx":
      // Rust runs the side's own model, else this one.
      return side.localModel ?? DEFAULT_MODEL_PER_ENGINE.sherpa_onnx;
    default:
      return undefined;
  }
}

/** Whisper.cpp models as people know them; other models show their id. */
export const WHISPER_MODEL_LABELS: Record<string, string> = { "distil-large-v3": "Distil Large v3" };
const whisperLabel = (id: string): string => WHISPER_MODEL_LABELS[id] ?? id;

/** Deepgram models as the STT Providers picker names them. */
export const DEEPGRAM_MODEL_LABELS: Record<string, string> = {
  "nova-3": "Nova 3",
  "nova-3-general": "Nova 3",
  "flux-general-en": "Flux",
  "flux-general-multi": "Flux Multilingual",
  "nova-2": "Nova 2",
  nova: "Nova",
  enhanced: "Enhanced",
  base: "Base",
};

/**
 * How Rust starts every message that refuses Auto-detect for a side
 * (AUTO_DETECT_REFUSAL in src-tauri/src/commands/audio_commands.rs).
 */
export const AUTO_DETECT_REFUSAL_PREFIX = "Auto-detect doesn't work with";

export const AUTO_DETECT_ADVICE =
  "Choose Deepgram Nova-3, Parakeet TDT 0.6B v3, Groq Whisper or Whisper API for that side, or pick a language.";
export const AUTO_DETECT_WHISPER_ADVICE =
  "Choose a multilingual Whisper model (Tiny, Base, Small, Medium or Large v3 Turbo), or pick a language.";

/**
 * Plain-language reason Auto-detect won't work for one side, or null when it
 * will. `label` is what the person calls that side: "You", "Them" or "Room".
 * The wording is Rust's refusal, word for word (it is matched by its prefix),
 * so it is not translated here.
 */
export function autoDetectProblem(
  side: AutoDetectSide,
  models: AutoDetectModels,
  label: string,
): string | null {
  const model = autoDetectModelFor(side, models);
  if (supportsSTTAutoDetection(side.provider, model)) return null;
  // An engine goes by its picker name ("Azure Speech"), as in Rust's refusal.
  let name = sttProviderMeta(side.provider)?.pickerLabel ?? "this speech-to-text provider";
  if (side.provider === "deepgram") name = `Deepgram ${(model && DEEPGRAM_MODEL_LABELS[model]) || model || "(this model)"}`;
  if (side.provider === "whisper_cpp") name = `the ${model ? whisperLabel(whisperModelId(model)) : "selected"} Whisper model`;
  if (side.provider === "parakeet_tdt") name = "Parakeet CTC 110M";
  const advice = side.provider === "whisper_cpp" ? AUTO_DETECT_WHISPER_ADVICE : AUTO_DETECT_ADVICE;
  return `${AUTO_DETECT_REFUSAL_PREFIX} ${name}, used for ${label}. ${advice}`;
}

/**
 * The 25 languages NVIDIA's model card lists for parakeet-tdt-0.6b-v3
 * (huggingface.co/nvidia/parakeet-tdt-0.6b-v3): bg hr cs da nl en et fi fr de el
 * hu it lv lt mt pl pt ro sk sl es sv ru uk.
 */
const PARAKEET_V3_LANGUAGES = [
  "bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "hu", "it",
  "lv", "lt", "mt", "pl", "pt", "ro", "sk", "sl", "es", "sv", "ru", "uk",
];

/**
 * The languages Deepgram's Flux Multilingual takes (en es fr de hi ru pt ja it nl).
 * One list for both sides: `MULTI_LANGUAGES` in src-tauri/src/stt/deepgram_flux.rs is
 * checked against autoDetectCases.json by a Rust test.
 */
export const FLUX_MULTI_LANGUAGES: string[] = cases.fluxMultiLanguages;

/** SenseVoice Small: Chinese, English, Japanese, Korean (and Cantonese, which the app has no entry for). */
const SENSE_VOICE_LANGUAGES = ["zh", "en", "ja", "ko"];

/** The languages a Sherpa-ONNX model covers; undefined for a model this table doesn't know. */
function sherpaModelLanguages(model: string): string[] | undefined {
  if (model.includes("-en-")) return ["en"]; // streaming-zipformer-en-20M, -en-compact
  if (model === "streaming-zipformer-multi") return ["zh"]; // zh-hans, not English
  if (isSenseVoice(model)) return SENSE_VOICE_LANGUAGES;
  return undefined;
}

/** "fr" for "fr-FR" and for "fr": the catalog has both regional and plain codes. */
const languageCode = (language: string): string => baseLanguage(language);

export interface SideLanguageHint {
  /** "warning": the side won't transcribe well. "info": a tip. */
  tone: "warning" | "info";
  text: string;
}

/**
 * What to tell the person about a side's provider and language together
 * (the same hints the STT Providers page shows for the shared language), or
 * null. Auto-detect has its own message, `autoDetectProblem`.
 */
export function sideLanguageHint(
  side: AutoDetectSide,
  language: string,
  models: AutoDetectModels,
): SideLanguageHint | null {
  if (language === AUTO_STT_LANGUAGE) return null;
  const model = autoDetectModelFor(side, models);
  const code = languageCode(language);
  switch (side.provider) {
    case "parakeet_tdt":
      if (code === "vi") {
        return {
          tone: "warning",
          text: "The included Parakeet models do not support Vietnamese. Choose a multilingual Whisper model, Deepgram Nova-3, or Azure Speech.",
        };
      }
      if ((model ?? DEFAULT_MODEL_PER_ENGINE.parakeet_tdt).includes("ctc-110m") && code !== "en") {
        return {
          tone: "warning",
          text: "Parakeet CTC 110M is English-only. Choose Parakeet TDT 0.6B v3 for multilingual transcription.",
        };
      }
      if (!PARAKEET_V3_LANGUAGES.includes(code)) {
        return {
          tone: "warning",
          text: "Parakeet TDT 0.6B v3 transcribes 25 European languages only. Choose a multilingual Whisper model, Deepgram Nova-3, or Azure Speech for this language.",
        };
      }
      return null;
    case "deepgram": {
      // Every language in the app's list is on Deepgram's Nova-3 language page.
      const inFluxMulti = FLUX_MULTI_LANGUAGES.includes(code);
      if (model === "flux-general-en" && code !== "en") {
        return {
          tone: "warning",
          text: inFluxMulti
            ? "Flux transcribes English only. Switch to Flux Multilingual or Nova-3 for this language."
            : "Flux transcribes English only. Switch to Nova-3 for this language.",
        };
      }
      if (model === "flux-general-multi" && !inFluxMulti) {
        return {
          tone: "warning",
          text: code === "uk"
            ? "Switch from Flux to Nova-3 for Ukrainian transcription."
            : "Flux Multilingual doesn't cover this language. Switch to Nova-3.",
        };
      }
      if (code === "vi") {
        return { tone: "info", text: "Select a Deepgram model that supports Vietnamese, such as Nova-3." };
      }
      return null;
    }
    case "ort_streaming":
      // Both ORT Streaming models (zipformer-en-20M, zipformer-en-compact) are English.
      return code === "en"
        ? null
        : {
            tone: "warning",
            text: "ORT Streaming models are English-only. Choose another provider for this language.",
          };
    case "sherpa_onnx": {
      // What each Sherpa-ONNX model transcribes (model_registry.rs); an unknown model gets no hint.
      const covered = sherpaModelLanguages(model ?? DEFAULT_MODEL_PER_ENGINE.sherpa_onnx);
      if (!covered || covered.includes(code)) return null;
      return {
        tone: "warning",
        text: SENSE_VOICE_LANGUAGES.includes(code)
          ? "This Sherpa-ONNX model doesn't cover this language. Choose SenseVoice Small, or another provider for this language."
          : "This Sherpa-ONNX model doesn't cover this language. Choose another provider for this language.",
      };
    }
    case "whisper_cpp":
      // The same models that can't detect the language are the English-only ones.
      return code !== "en" && model && !supportsSTTAutoDetection("whisper_cpp", model)
        ? {
            tone: "warning",
            text: `The ${whisperLabel(whisperModelId(model))} Whisper model is English-only. Choose a multilingual Whisper model (Tiny, Base, Small, Medium or Large v3 Turbo) for this language.`,
          }
        : null;
    case "cartesia":
      return cartesiaSupportsLanguage(language)
        ? null
        : {
            tone: "warning",
            text: "Cartesia transcribes only English, French, Hindi, Japanese and Spanish. Choose another provider for this language.",
          };
    default:
      return null;
  }
}

const REFUSAL_SENTENCE = new RegExp(
  `${AUTO_DETECT_REFUSAL_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} .+?, used for (?:You|Them|Room)\\.`,
  "g",
);

/** The "Auto-detect doesn't work with X, used for Y." sentences of a refusal (without the advice). */
export function autoDetectRefusalSentences(message: string): string[] {
  return message.match(REFUSAL_SENTENCE) ?? [];
}
