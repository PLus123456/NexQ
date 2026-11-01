import { describe, expect, it } from "vitest";
import type { STTProviderType } from "../types";
import {
  DEFAULT_MODEL_PER_ENGINE,
  EXCLUSIVE_FALLBACK_ORDER,
  EXCLUSIVE_PROVIDERS,
  LOCAL_MODEL_ENGINES,
  STT_LABELS,
  STT_PROVIDERS,
  STT_PROVIDER_OPTIONS,
  isExclusiveProvider,
  localModelIdOnSwitch,
  resolveLocalModelId,
  sttProviderMeta,
} from "./providerMeta";

// Every STTProviderType: tsc fails here when an id is added to or removed from the union.
const ALL_IDS = Object.keys({
  whisper_cpp: true,
  deepgram: true,
  whisper_api: true,
  azure_speech: true,
  groq_whisper: true,
  web_speech: true,
  sherpa_onnx: true,
  ort_streaming: true,
  windows_native: true,
  parakeet_tdt: true,
} satisfies Record<STTProviderType, true>);

describe("STT_PROVIDERS", () => {
  it("has exactly one entry per STTProviderType", () => {
    const ids = STT_PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...ALL_IDS].sort());
  });

  it("looks engines up by id", () => {
    expect(sttProviderMeta("azure_speech")?.pickerLabel).toBe("Azure Speech");
    expect(sttProviderMeta("not_an_engine")).toBeUndefined();
  });

  it("keeps the chip and banner labels", () => {
    // ServiceStatusBar's STT_LABELS before the extraction.
    expect(STT_LABELS).toEqual({
      web_speech: "Web Speech",
      whisper_cpp: "Whisper.cpp",
      deepgram: "Deepgram",
      whisper_api: "Whisper API",
      azure_speech: "Azure",
      groq_whisper: "Groq STT",
      sherpa_onnx: "Sherpa-ONNX",
      ort_streaming: "ORT Streaming",
      parakeet_tdt: "Parakeet TDT",
      windows_native: "Windows Speech",
    });
  });

  it("needs an API key for the cloud engines only", () => {
    const keyed = STT_PROVIDERS.filter((p) => p.requiresApiKey).map((p) => p.id);
    expect(keyed.sort()).toEqual(["azure_speech", "deepgram", "groq_whisper", "whisper_api"]);
  });

  it("runs Windows Speech on Windows only, and no engine translates by itself yet", () => {
    expect(sttProviderMeta("windows_native")?.platforms).toEqual(["windows"]);
    for (const p of STT_PROVIDERS) {
      expect(p.platforms.length).toBeGreaterThan(0);
      expect(p.supportsNativeTranslation).toBe(false);
    }
  });
});

describe("STT_PROVIDER_OPTIONS", () => {
  it("is the quick-swap picker list from before the extraction", () => {
    const picker = STT_PROVIDER_OPTIONS.map((o) => ({
      value: o.id,
      label: o.pickerLabel,
      icon: o.icon,
      requiresKey: o.requiresApiKey,
      isCloud: o.isCloud,
      inputOnly: o.inputOnly,
      requiresDownload: o.requiresDownload,
    }));
    expect(picker).toEqual([
      { value: "web_speech", label: "Web Speech", icon: "globe", requiresKey: false, isCloud: false, inputOnly: true },
      { value: "windows_native", label: "Windows Speech", icon: "monitor", requiresKey: false, isCloud: false, inputOnly: true },
      { value: "sherpa_onnx", label: "Sherpa-ONNX", icon: "hardDrive", requiresKey: false, isCloud: false, requiresDownload: "sherpa_onnx" },
      { value: "ort_streaming", label: "ORT Streaming", icon: "zap", requiresKey: false, isCloud: false, requiresDownload: "ort_streaming" },
      { value: "parakeet_tdt", label: "Parakeet TDT", icon: "cpu", requiresKey: false, isCloud: false, requiresDownload: "parakeet_tdt" },
      { value: "deepgram", label: "Deepgram", icon: "cloud", requiresKey: true, isCloud: true },
      { value: "whisper_api", label: "Whisper API", icon: "cloud", requiresKey: true, isCloud: true },
      { value: "azure_speech", label: "Azure Speech", icon: "cloud", requiresKey: true, isCloud: true },
      { value: "groq_whisper", label: "Groq Whisper", icon: "zap", requiresKey: true, isCloud: true },
    ]);
  });
});

describe("exclusive engines", () => {
  it("are Web Speech and Windows Speech", () => {
    expect(EXCLUSIVE_PROVIDERS).toEqual(["web_speech", "windows_native"]);
    expect(isExclusiveProvider("web_speech")).toBe(true);
    expect(isExclusiveProvider("windows_native")).toBe(true);
    expect(isExclusiveProvider("deepgram")).toBe(false);
    expect(isExclusiveProvider("")).toBe(false);
  });

  it("fall back, in order, to picker engines that aren't exclusive", () => {
    expect(EXCLUSIVE_FALLBACK_ORDER).toEqual([
      "deepgram", "groq_whisper", "whisper_api", "azure_speech",
      "sherpa_onnx", "ort_streaming", "parakeet_tdt",
    ]);
    for (const id of EXCLUSIVE_FALLBACK_ORDER) {
      expect(STT_PROVIDER_OPTIONS.some((o) => o.id === id)).toBe(true);
      expect(isExclusiveProvider(id)).toBe(false);
    }
  });
});

describe("local models", () => {
  const active = { sherpa_onnx: "active-sherpa", whisper_cpp: "active-whisper-engine" };

  it("are shown for the engines that run a downloaded model", () => {
    expect([...LOCAL_MODEL_ENGINES].sort()).toEqual(["ort_streaming", "parakeet_tdt", "sherpa_onnx", "whisper_cpp"]);
    expect(DEFAULT_MODEL_PER_ENGINE).toEqual({
      sherpa_onnx: "streaming-zipformer-en-20M",
      ort_streaming: "zipformer-en-20M",
      parakeet_tdt: "parakeet-tdt-0.6b-v3-int8",
    });
  });

  it("chip: the party's model, then the engine's active model, then the default", () => {
    expect(resolveLocalModelId("sherpa_onnx", "mine", active, "ggml-base")).toBe("mine");
    expect(resolveLocalModelId("sherpa_onnx", undefined, active, "ggml-base")).toBe("active-sherpa");
    expect(resolveLocalModelId("sherpa_onnx", "", active, "ggml-base")).toBe("active-sherpa");
    expect(resolveLocalModelId("sherpa_onnx", null, { sherpa_onnx: "" }, null)).toBe("streaming-zipformer-en-20M");
    expect(resolveLocalModelId("ort_streaming", undefined, active, "ggml-base")).toBe("zipformer-en-20M");
  });

  it("chip: whisper.cpp falls back to the active Whisper model, other engines don't", () => {
    expect(resolveLocalModelId("whisper_cpp", undefined, active, "ggml-base")).toBe("active-whisper-engine");
    expect(resolveLocalModelId("whisper_cpp", undefined, {}, "ggml-base")).toBe("ggml-base");
    expect(resolveLocalModelId("whisper_cpp", undefined, {}, null)).toBeUndefined();
    expect(resolveLocalModelId("whisper_cpp", "", {}, "")).toBeUndefined();
    expect(resolveLocalModelId("deepgram", undefined, {}, "ggml-base")).toBeUndefined();
  });

  it("switch: the engine's active model, else its default; other engines keep the party's id", () => {
    expect(localModelIdOnSwitch("sherpa_onnx", active, "ggml-base")).toBe("active-sherpa");
    expect(localModelIdOnSwitch("parakeet_tdt", active, "ggml-base")).toBe("parakeet-tdt-0.6b-v3-int8");
    // An empty active model isn't replaced by the default (??), so nothing is stored.
    expect(localModelIdOnSwitch("sherpa_onnx", { sherpa_onnx: "" }, "ggml-base")).toBeUndefined();
    expect(localModelIdOnSwitch("whisper_cpp", active, "ggml-base")).toBeUndefined();
    expect(localModelIdOnSwitch("deepgram", active, "ggml-base")).toBeUndefined();
    expect(localModelIdOnSwitch("web_speech", {}, null)).toBeUndefined();
  });
});
