import { afterEach, describe, expect, it } from "vitest";
import type { STTProviderType } from "./types";
import cases from "./autoDetectCases.json";
import { changeUiLanguage } from "../i18n";
import { STT_COMMON } from "./languages";
import { STT_PROVIDERS } from "./stt/providerMeta";
import {
  AUTO_DETECT_ADVICE,
  AUTO_DETECT_REFUSAL_PREFIX,
  AUTO_DETECT_WHISPER_ADVICE,
  FLUX_MULTI_LANGUAGES,
  DEEPGRAM_MODEL_LABELS,
  WHISPER_MODEL_LABELS,
  autoDetectRefusalSentences,
  STT_LANGUAGES,
  autoDetectProblem,
  cartesiaSupportsLanguage,
  sideLanguage,
  sideLanguageHint,
  supportsSTTAutoDetection,
  AUTO_STT_LANGUAGE,
} from "./sttLanguages";

/**
 * autoDetectCases.json is the provider/model table the Rust side checks too
 * (`supports_auto_language`, in src-tauri/src/commands/audio_commands.rs).
 */
const AUTO_DETECT_CASES = cases.cases as { provider: STTProviderType; model: string; supported: boolean; name?: string }[];

describe("autoDetectCases.json (shared with Rust)", () => {
  it.each(AUTO_DETECT_CASES)("$provider / $model", ({ provider, model, supported, name }) => {
    expect(supportsSTTAutoDetection(provider, model)).toBe(supported);
    const problem = autoDetectProblem({ provider, localModel: model || undefined }, { deepgram: model }, "You");
    if (supported) {
      expect(problem).toBeNull();
    } else {
      expect(problem).not.toBeNull();
      expect(problem!.startsWith(`${AUTO_DETECT_REFUSAL_PREFIX} ${name}, used for You. `)).toBe(true);
    }
  });
});

describe("refusal wording (shared with Rust)", () => {
  it("uses the wording in autoDetectCases.json", () => {
    expect(AUTO_DETECT_REFUSAL_PREFIX).toBe(cases.refusalPrefix);
    expect(AUTO_DETECT_ADVICE).toBe(cases.advice);
    expect(AUTO_DETECT_WHISPER_ADVICE).toBe(cases.whisperAdvice);
    expect(DEEPGRAM_MODEL_LABELS).toEqual(cases.deepgramLabels);
    expect(WHISPER_MODEL_LABELS).toEqual(cases.whisperLabels);
  });

  it("picks the sentences naming each refused side out of a joined refusal", () => {
    const joined = `${autoDetectProblem({ provider: "web_speech" }, {}, "You")} ${autoDetectProblem({ provider: "whisper_cpp", localModel: "ggml-base.en.bin" }, {}, "Room")}`;
    expect(autoDetectRefusalSentences(joined)).toEqual([
      "Auto-detect doesn't work with Web Speech, used for You.",
      "Auto-detect doesn't work with the base.en Whisper model, used for Room.",
    ]);
  });
});

describe("autoDetectProblem", () => {
  it("names the side, the provider and what to change", () => {
    expect(autoDetectProblem({ provider: "web_speech" }, {}, "You")).toBe(
      "Auto-detect doesn't work with Web Speech, used for You. " +
      "Choose Deepgram Nova-3, Parakeet TDT 0.6B v3, Groq Whisper or Whisper API for that side, or pick a language."
    );
    expect(autoDetectProblem({ provider: "deepgram" }, { deepgram: "nova-2" }, "Room")).toContain(
      "Deepgram Nova 2, used for Room"
    );
  });

  it("sends a failing Whisper model to a multilingual Whisper model, not to Whisper in general", () => {
    const problem = autoDetectProblem({ provider: "whisper_cpp", localModel: "ggml-distil-large-v3.bin" }, {}, "Them");
    expect(problem).toBe(
      "Auto-detect doesn't work with the Distil Large v3 Whisper model, used for Them. " +
      "Choose a multilingual Whisper model (Tiny, Base, Small, Medium or Large v3 Turbo), or pick a language."
    );
  });

  it("uses the model a side falls back to", () => {
    expect(autoDetectProblem({ provider: "whisper_cpp" }, { whisperCpp: "small" }, "You")).toBeNull();
    expect(autoDetectProblem({ provider: "parakeet_tdt" }, { parakeet: "parakeet-tdt-ctc-110m-int8" }, "You"))
      .toContain("Parakeet CTC 110M");
    // A Parakeet model name never leaks into another provider's check.
    expect(autoDetectProblem({ provider: "web_speech" }, { parakeet: "parakeet-tdt-0.6b-v3-int8" }, "You"))
      .toContain("Web Speech");
  });
});

describe("supportsSTTAutoDetection", () => {
  it("checks the selected model for model-dependent engines", () => {
    expect(supportsSTTAutoDetection("deepgram", "nova-3")).toBe(true);
    expect(supportsSTTAutoDetection("deepgram", "flux-general-multi")).toBe(true);
    expect(supportsSTTAutoDetection("deepgram", "flux-general-en")).toBe(false);
    expect(supportsSTTAutoDetection("whisper_cpp", "small")).toBe(true);
    expect(supportsSTTAutoDetection("whisper_cpp", "distil-large-v3")).toBe(false);
    expect(supportsSTTAutoDetection("parakeet_tdt", "parakeet-tdt-0.6b-v3-int8")).toBe(true);
    expect(supportsSTTAutoDetection("parakeet_tdt", "parakeet-tdt-ctc-110m-int8")).toBe(false);
    expect(supportsSTTAutoDetection("web_speech")).toBe(false);
  });
});

describe("cartesiaSupportsLanguage", () => {
  it("accepts the five languages ink-2 detects", () => {
    for (const lang of ["en-US", "en-GB", "fr-FR", "hi-IN", "ja-JP", "es-ES"]) {
      expect(cartesiaSupportsLanguage(lang)).toBe(true);
    }
  });

  it("rejects the other app languages", () => {
    const unsupported = STT_LANGUAGES.map((l) => l.value).filter(
      (v) => !["en", "fr", "hi", "ja", "es"].includes(v.split("-")[0])
    );
    expect(unsupported).toContain("ru-RU");
    expect(unsupported).toContain("uk-UA");
    expect(unsupported).toContain("vi-VN");
    for (const lang of unsupported) {
      expect(cartesiaSupportsLanguage(lang)).toBe(false);
    }
  });
});

describe("sideLanguage", () => {
  it("is the side's own language, else the shared one", () => {
    expect(sideLanguage({ language: "es-ES" }, "en-US")).toBe("es-ES");
    expect(sideLanguage({ language: "auto" }, "en-US")).toBe("auto");
    // A config saved before this setting has no language.
    expect(sideLanguage({}, "en-US")).toBe("en-US");
    expect(sideLanguage({ language: "" }, "fr-FR")).toBe("fr-FR");
    expect(sideLanguage({ language: "  " }, "fr-FR")).toBe("fr-FR");
    expect(sideLanguage(null, "de-DE")).toBe("de-DE");
    expect(sideLanguage({}, "auto")).toBe("auto");
  });
});

describe("sideLanguageHint", () => {
  const none = {};
  it("warns about Flux and Ukrainian, Cartesia languages, Parakeet CTC and Vietnamese", () => {
    expect(sideLanguageHint({ provider: "deepgram" }, "uk-UA", { deepgram: "flux-general-multi" })).toEqual({
      tone: "warning",
      text: "Switch from Flux to Nova-3 for Ukrainian transcription.",
    });
    expect(sideLanguageHint({ provider: "deepgram" }, "uk-UA", { deepgram: "nova-3" })).toBeNull();
    expect(sideLanguageHint({ provider: "cartesia" }, "de-DE", none)?.tone).toBe("warning");
    expect(sideLanguageHint({ provider: "cartesia" }, "es-ES", none)).toBeNull();
    expect(
      sideLanguageHint({ provider: "parakeet_tdt", localModel: "parakeet-tdt-ctc-110m-int8" }, "es-ES", none)?.text,
    ).toMatch(/English-only/);
    expect(
      sideLanguageHint({ provider: "parakeet_tdt", localModel: "parakeet-tdt-ctc-110m-int8" }, "en-GB", none),
    ).toBeNull();
    expect(sideLanguageHint({ provider: "parakeet_tdt" }, "vi-VN", none)?.text).toMatch(/Vietnamese/);
    expect(sideLanguageHint({ provider: "deepgram" }, "vi-VN", { deepgram: "nova-3" })?.tone).toBe("info");
  });

  it("warns when Parakeet TDT v3 isn't given one of the 25 languages on NVIDIA's model card", () => {
    const parakeet = { provider: "parakeet_tdt" as const };
    // In the app's list: English, Spanish, French, German, Italian, Portuguese, Dutch, Russian, Ukrainian, Polish, Czech, Swedish.
    for (const language of ["en-US", "en-GB", "es-ES", "fr-FR", "de-DE", "it-IT", "pt-BR", "nl-NL", "ru-RU", "uk-UA", "pl-PL", "cs-CZ", "sv-SE"]) {
      expect(sideLanguageHint(parakeet, language, none), language).toBeNull();
    }
    // Not on the card: Japanese, Chinese, Korean, Hindi, Arabic, Turkish.
    for (const language of ["ja-JP", "zh-CN", "ko-KR", "hi-IN", "ar-SA", "tr-TR"]) {
      expect(sideLanguageHint(parakeet, language, none)?.text, language).toMatch(/25 European languages/);
    }
    // The model the side runs decides; Vietnamese keeps its own wording.
    expect(sideLanguageHint(parakeet, "ja-JP", { parakeet: "parakeet-tdt-0.6b-v3-int8" })?.tone).toBe("warning");
    expect(sideLanguageHint(parakeet, "vi-VN", none)?.text).toMatch(/Vietnamese/);
    expect(
      sideLanguageHint({ ...parakeet, localModel: "parakeet-tdt-ctc-110m-int8" }, "ja-JP", none)?.text,
    ).toMatch(/English-only/);
  });

  it("warns when Flux (English) is given another language, and Flux Multilingual isn't", () => {
    expect(sideLanguageHint({ provider: "deepgram" }, "es-ES", { deepgram: "flux-general-en" })?.text).toMatch(
      /English only/,
    );
    // Flux Multilingual is only suggested for the languages it takes (Spanish: yes, Ukrainian: no).
    expect(sideLanguageHint({ provider: "deepgram" }, "es-ES", { deepgram: "flux-general-en" })?.text).toMatch(
      /Flux Multilingual or Nova-3/,
    );
    expect(sideLanguageHint({ provider: "deepgram" }, "uk-UA", { deepgram: "flux-general-en" })?.text).toBe(
      "Flux transcribes English only. Switch to Nova-3 for this language.",
    );
    expect(sideLanguageHint({ provider: "deepgram" }, "en-GB", { deepgram: "flux-general-en" })).toBeNull();
    expect(sideLanguageHint({ provider: "deepgram" }, "es-ES", { deepgram: "flux-general-multi" })).toBeNull();
    // Flux Multilingual with one of the app's languages it doesn't take.
    expect(FLUX_MULTI_LANGUAGES).toEqual(["en", "es", "fr", "de", "hi", "ru", "pt", "ja", "it", "nl"]);
    for (const language of ["zh-CN", "ko-KR", "ar-SA", "tr-TR", "pl-PL", "cs-CZ", "sv-SE", "vi-VN"]) {
      expect(sideLanguageHint({ provider: "deepgram" }, language, { deepgram: "flux-general-multi" })?.text, language)
        .toBe("Flux Multilingual doesn't cover this language. Switch to Nova-3.");
    }
    for (const language of ["en-US", "fr-FR", "hi-IN", "ja-JP", "nl-NL"]) {
      expect(sideLanguageHint({ provider: "deepgram" }, language, { deepgram: "flux-general-multi" }), language).toBeNull();
    }
    expect(sideLanguageHint({ provider: "deepgram" }, "es-ES", { deepgram: "nova-3" })).toBeNull();
    // Auto-detect on Flux (English) is the Auto-detect refusal's business.
    expect(sideLanguageHint({ provider: "deepgram" }, "auto", { deepgram: "flux-general-en" })).toBeNull();
  });

  it("warns about English-only local models given another language", () => {
    expect(sideLanguageHint({ provider: "ort_streaming" }, "es-ES", none)?.text).toMatch(/ORT Streaming models are English-only/);
    expect(sideLanguageHint({ provider: "ort_streaming" }, "en-GB", none)).toBeNull();
    // Whisper.cpp: the models that can't detect the language are the English-only ones.
    expect(
      sideLanguageHint({ provider: "whisper_cpp", localModel: "base.en" }, "fr-FR", none)?.text,
    ).toMatch(/The base\.en Whisper model is English-only/);
    expect(sideLanguageHint({ provider: "whisper_cpp" }, "fr-FR", { whisperCpp: "ggml-distil-large-v3.bin" })?.text)
      .toMatch(/The Distil Large v3 Whisper model is English-only/);
    expect(sideLanguageHint({ provider: "whisper_cpp", localModel: "base.en" }, "en-US", none)).toBeNull();
    expect(sideLanguageHint({ provider: "whisper_cpp", localModel: "small" }, "fr-FR", none)).toBeNull();
    expect(sideLanguageHint({ provider: "whisper_cpp" }, "fr-FR", none)).toBeNull();
    // Sherpa-ONNX: only the English zipformers.
    expect(sideLanguageHint({ provider: "sherpa_onnx", localModel: "streaming-zipformer-en-20M" }, "de-DE", none)?.tone).toBe("warning");
    expect(sideLanguageHint({ provider: "sherpa_onnx" }, "de-DE", none)?.tone).toBe("warning");
    // The multi model is Chinese (zh-hans), not English; SenseVoice Small covers zh, en, ja, ko.
    const multi = { provider: "sherpa_onnx" as const, localModel: "streaming-zipformer-multi" };
    const senseVoice = { provider: "sherpa_onnx" as const, localModel: "sense-voice-small" };
    expect(sideLanguageHint(multi, "de-DE", none)?.text).toMatch(/Choose another provider/);
    expect(sideLanguageHint(multi, "en-US", none)?.tone).toBe("warning");
    expect(sideLanguageHint(multi, "ja-JP", none)?.text).toMatch(/Choose SenseVoice Small/);
    expect(sideLanguageHint(multi, "zh-CN", none)).toBeNull();
    expect(sideLanguageHint(senseVoice, "de-DE", none)?.text).toMatch(/Choose another provider/);
    expect(sideLanguageHint(senseVoice, "ja-JP", none)).toBeNull();
    for (const language of ["zh-CN", "en-GB", "ko-KR"]) expect(sideLanguageHint(senseVoice, language, none)).toBeNull();
    expect(sideLanguageHint({ provider: "sherpa_onnx", localModel: "streaming-zipformer-en-20M" }, "zh-CN", none)?.text)
      .toMatch(/Choose SenseVoice Small/);
    // A model this table doesn't know gets no hint.
    expect(sideLanguageHint({ provider: "sherpa_onnx", localModel: "some-new-model" }, "de-DE", none)).toBeNull();
    expect(sideLanguageHint({ provider: "sherpa_onnx", localModel: "streaming-zipformer-en-20M" }, "en-US", none)).toBeNull();
  });

  it("leaves Auto-detect to autoDetectProblem and fine pairs alone", () => {
    expect(sideLanguageHint({ provider: "cartesia" }, "auto", none)).toBeNull();
    expect(sideLanguageHint({ provider: "web_speech" }, "uk-UA", none)).toBeNull();
    expect(sideLanguageHint({ provider: "groq_whisper" }, "es-ES", none)).toBeNull();
  });
});

// NexQ Plus: the module judges the fork's engines and language catalog too.
describe("NexQ Plus engines and languages", () => {
  afterEach(() => changeUiLanguage("en"));

  it("lists Auto-detect and the catalog's recognition languages, named in the UI language", async () => {
    expect(STT_LANGUAGES.map((l) => l.value)).toEqual([AUTO_STT_LANGUAGE, ...STT_COMMON]);
    const label = (value: string) => STT_LANGUAGES.find((l) => l.value === value)?.label;
    expect(label("auto")).toBe("Auto-detect");
    expect(label("en-US")).toBe("English (US)");
    expect(label("uk-UA")).toBe("Ukrainian");
    await changeUiLanguage("zh-CN");
    expect(label("auto")).toBe("自动检测");
    expect(label("zh-CN")).toBe("简体中文");
    // A copy made for a picker's own list still follows the language.
    expect([...STT_LANGUAGES].find((l) => l.value === "ja-JP")?.label).toBe("日语");
  });

  it("lets Soniox and Remote Whisper detect the language", () => {
    for (const provider of ["soniox", "openai_compat"] as const) {
      expect(supportsSTTAutoDetection(provider), provider).toBe(true);
      expect(autoDetectProblem({ provider }, {}, "Them"), provider).toBeNull();
      expect(sideLanguageHint({ provider }, "zh-CN", {}), provider).toBeNull();
    }
  });

  it("lets SenseVoice detect, and no other Sherpa-ONNX model", () => {
    expect(autoDetectProblem({ provider: "sherpa_onnx", localModel: "sense-voice-small" }, {}, "Them")).toBeNull();
    // No model of its own: Rust runs the English zipformer.
    expect(autoDetectProblem({ provider: "sherpa_onnx" }, {}, "Them")).toContain("Sherpa-ONNX, used for Them.");
    expect(autoDetectProblem({ provider: "sherpa_onnx", localModel: "streaming-zipformer-multi" }, {}, "You"))
      .toContain("Sherpa-ONNX, used for You.");
  });

  it("judges every engine the app has, and names the ones it refuses", () => {
    // What each engine does with Auto-detect when the side names no model.
    const expected: Record<STTProviderType, boolean> = {
      web_speech: false, windows_native: false, azure_speech: false, ort_streaming: false, sherpa_onnx: false,
      whisper_cpp: true, parakeet_tdt: true, whisper_api: true, groq_whisper: true, cartesia: true,
      openai_compat: true, soniox: true,
      // No Deepgram model known: nothing says it can detect.
      deepgram: false,
    };
    for (const { id, pickerLabel } of STT_PROVIDERS) {
      const problem = autoDetectProblem({ provider: id }, {}, "You");
      expect(problem === null, id).toBe(expected[id]);
      if (problem && id !== "deepgram") expect(problem, id).toContain(`${pickerLabel}, used for You.`);
      expect(problem ?? "", id).not.toContain("this speech-to-text provider");
    }
    // An engine can't detect at all exactly where the catalog says so.
    for (const { id, languageSupport } of STT_PROVIDERS) {
      if (languageSupport === "noAuto") expect(supportsSTTAutoDetection(id, "any-model"), id).toBe(false);
    }
  });

  it("reads plain language codes like regional ones", () => {
    expect(sideLanguageHint({ provider: "parakeet_tdt" }, "vi", {})?.text).toMatch(/Vietnamese/);
    expect(sideLanguageHint({ provider: "parakeet_tdt" }, "zh", {})?.text).toMatch(/25 European languages/);
    expect(sideLanguageHint({ provider: "parakeet_tdt" }, "uk", {})).toBeNull();
    expect(sideLanguageHint({ provider: "deepgram" }, "uk", { deepgram: "flux-general-multi" })?.text)
      .toBe("Switch from Flux to Nova-3 for Ukrainian transcription.");
    expect(sideLanguageHint({ provider: "cartesia" }, "ja", {})).toBeNull();
    expect(sideLanguageHint({ provider: "cartesia" }, "zh-TW", {})?.tone).toBe("warning");
    expect(sideLanguageHint({ provider: "sherpa_onnx", localModel: "sense-voice-small" }, "zh", {})).toBeNull();
    expect(sideLanguageHint({ provider: "ort_streaming" }, "en", {})).toBeNull();
  });
});
