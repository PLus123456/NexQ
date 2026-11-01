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
  isSttProviderAvailable,
  localModelIdOnSwitch,
  resolveLocalModelId,
  sttKeySlot,
  sttProviderMeta,
  sttProvidersFor,
  type SttAvailabilityContext,
} from "./providerMeta";
import { currentPlatform } from "../platform";

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
  openai_compat: true,
  soniox: true,
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
      openai_compat: "Remote Whisper",
      soniox: "Soniox",
    });
  });

  it("needs an API key for the keyed cloud engines; remote Whisper's key is optional", () => {
    const keyed = STT_PROVIDERS.filter((p) => p.requiresApiKey).map((p) => p.id);
    expect(keyed.sort()).toEqual(["azure_speech", "deepgram", "groq_whisper", "soniox", "whisper_api"]);
    const remote = sttProviderMeta("openai_compat")!;
    expect(remote.requiresBaseUrl).toBe(true);
    expect(sttKeySlot(remote)).toBe("openai_compat_stt");
    expect(sttKeySlot(sttProviderMeta("soniox")!)).toBe("soniox");
  });

  it("runs Windows Speech on Windows only; only Soniox translates by itself", () => {
    expect(sttProviderMeta("windows_native")?.platforms).toEqual(["windows"]);
    for (const p of STT_PROVIDERS) {
      expect(p.platforms.length).toBeGreaterThan(0);
      expect(p.supportsNativeTranslation).toBe(p.id === "soniox");
    }
  });

  it("says which engines detect the language", () => {
    const support = Object.fromEntries(STT_PROVIDERS.map((p) => [p.id, p.languageSupport]));
    expect(support).toMatchObject({
      soniox: "auto", openai_compat: "auto", whisper_cpp: "auto", groq_whisper: "auto",
      whisper_api: "auto", deepgram: "auto", sherpa_onnx: "auto",
      web_speech: "noAuto", windows_native: "noAuto", azure_speech: "noAuto",
      ort_streaming: "ignored", parakeet_tdt: "ignored",
    });
  });
});

describe("platforms", () => {
  it("never offers Windows Speech on macOS", () => {
    const mac = sttProvidersFor("macos").map((p) => p.id);
    expect(mac).not.toContain("windows_native");
    expect(mac).toContain("web_speech");
    expect(sttProvidersFor("windows").map((p) => p.id)).toContain("windows_native");
    expect(sttProvidersFor("linux").map((p) => p.id)).not.toContain("web_speech");
  });

  it("hides nothing on an unknown platform", () => {
    expect(sttProvidersFor("unknown").length).toBe(STT_PROVIDERS.filter((p) => !p.hidden).length);
  });

  it("builds the picker for the platform the app runs on", () => {
    expect(STT_PROVIDER_OPTIONS.map((o) => o.id)).toEqual(sttProvidersFor(currentPlatform()).map((p) => p.id));
  });
});

describe("STT_PROVIDER_OPTIONS", () => {
  it("is the quick-swap picker list (Windows) with whisper.cpp and the Plus engines added", () => {
    const picker = sttProvidersFor("windows").map((o) => ({
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
      { value: "whisper_cpp", label: "Whisper.cpp", icon: "hardDrive", requiresKey: false, isCloud: false, requiresDownload: "whisper_cpp" },
      { value: "parakeet_tdt", label: "Parakeet TDT", icon: "cpu", requiresKey: false, isCloud: false, requiresDownload: "parakeet_tdt" },
      { value: "deepgram", label: "Deepgram", icon: "cloud", requiresKey: true, isCloud: true },
      { value: "whisper_api", label: "Whisper API", icon: "cloud", requiresKey: true, isCloud: true },
      { value: "azure_speech", label: "Azure Speech", icon: "cloud", requiresKey: true, isCloud: true },
      { value: "groq_whisper", label: "Groq Whisper", icon: "zap", requiresKey: true, isCloud: true },
      { value: "openai_compat", label: "Remote Whisper", icon: "cloud", requiresKey: false, isCloud: true },
      { value: "soniox", label: "Soniox", icon: "cloud", requiresKey: true, isCloud: true },
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
      "deepgram", "soniox", "groq_whisper", "whisper_api", "azure_speech",
      "sherpa_onnx", "ort_streaming", "parakeet_tdt", "whisper_cpp",
    ]);
    for (const id of EXCLUSIVE_FALLBACK_ORDER) {
      expect(sttProvidersFor("macos").some((o) => o.id === id)).toBe(true);
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
    // whisper.cpp: its active model, else the active Whisper model.
    expect(localModelIdOnSwitch("whisper_cpp", active, "ggml-base")).toBe("active-whisper-engine");
    expect(localModelIdOnSwitch("whisper_cpp", {}, "ggml-base")).toBe("ggml-base");
    expect(localModelIdOnSwitch("whisper_cpp", {}, null)).toBeUndefined();
    expect(localModelIdOnSwitch("deepgram", active, "ggml-base")).toBeUndefined();
    expect(localModelIdOnSwitch("web_speech", {}, null)).toBeUndefined();
  });
});

describe("availability", () => {
  const ctx = (over: Partial<SttAvailabilityContext> = {}): SttAvailabilityContext => ({
    isInput: true,
    isEngineReady: () => true,
    hasKey: () => true,
    hasBaseUrl: false,
    ...over,
  });
  const meta = (id: string) => sttProviderMeta(id)!;

  it("needs a microphone for the input-only engines", () => {
    expect(isSttProviderAvailable(meta("web_speech"), ctx({ isInput: false }))).toBe(false);
    expect(isSttProviderAvailable(meta("web_speech"), ctx())).toBe(true);
  });

  it("needs a downloaded model, a key, or a server address", () => {
    expect(isSttProviderAvailable(meta("whisper_cpp"), ctx({ isEngineReady: () => false }))).toBe(false);
    expect(isSttProviderAvailable(meta("soniox"), ctx({ hasKey: (slot) => slot !== "soniox" }))).toBe(false);
    expect(isSttProviderAvailable(meta("openai_compat"), ctx({ hasKey: () => false, hasBaseUrl: true }))).toBe(true);
    expect(isSttProviderAvailable(meta("openai_compat"), ctx({ hasBaseUrl: false }))).toBe(false);
  });

  it("counts an unknown status as available", () => {
    expect(isSttProviderAvailable(meta("deepgram"), ctx({ hasKey: () => undefined }))).toBe(true);
    expect(isSttProviderAvailable(meta("parakeet_tdt"), ctx({ isEngineReady: () => undefined }))).toBe(true);
  });
});
