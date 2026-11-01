import { describe, expect, it } from "vitest";
import type { MeetingAudioConfig, PartyAudioConfig, STTProviderType } from "../types";
import {
  applyPartyTranslationMode,
  engineSupportsNativeTranslation,
  partyOfSpeaker,
  partySourceLanguage,
  partyTranslationMode,
  partyUsesNativeTranslation,
  serviceParties,
} from "./nativeTranslation";

function party(role: "You" | "Them", extra: Partial<PartyAudioConfig> = {}): PartyAudioConfig {
  return { role, device_id: "", is_input_device: role === "You", stt_provider: "deepgram", ...extra };
}

function audio(you: Partial<PartyAudioConfig> = {}, them: Partial<PartyAudioConfig> = {}): MeetingAudioConfig {
  return { you: party("You", you), them: party("Them", them), recording_enabled: false, preset_name: null };
}

// Not in STTProviderType until the STT package adds the engine.
const SONIOX = "soniox" as STTProviderType;
const nativeOn = { mode: "one_way" as const, target_language: "" };

describe("parties", () => {
  it("User lines are the user's, everything else the other side's", () => {
    expect(partyOfSpeaker("User")).toBe("you");
    expect(partyOfSpeaker("Them")).toBe("them");
    expect(partyOfSpeaker("Interviewer")).toBe("them");
    expect(partyOfSpeaker(undefined)).toBe("them");
  });
});

describe("engine-side translation", () => {
  it("only engines that can translate count", () => {
    expect(engineSupportsNativeTranslation("deepgram")).toBe(false);
    expect(engineSupportsNativeTranslation("soniox")).toBe(true);
    expect(engineSupportsNativeTranslation(undefined)).toBe(false);
  });

  it("two-way counts only with two different languages", () => {
    const twoWay = (language_a?: string, language_b?: string) =>
      partyUsesNativeTranslation(party("Them", { stt_provider: SONIOX, native_translation: { mode: "two_way", language_a, language_b } }));
    expect(twoWay("zh-CN", "en-US")).toBe(true);
    expect(twoWay("zh", "ja")).toBe(true);
    expect(twoWay("zh-CN", undefined)).toBe(false);
    expect(twoWay("zh-CN", "zh-TW")).toBe(false);
    expect(twoWay("auto", "en")).toBe(false);
    expect(twoWay("", "")).toBe(false);
  });

  it("needs both the engine and native_translation switched on", () => {
    expect(partyUsesNativeTranslation(party("Them", { stt_provider: SONIOX, native_translation: nativeOn }))).toBe(true);
    expect(partyUsesNativeTranslation(party("Them", { stt_provider: SONIOX, native_translation: { mode: "off" } }))).toBe(false);
    expect(partyUsesNativeTranslation(party("Them", { stt_provider: SONIOX }))).toBe(false);
    // The engine changed to one that can't translate: the pipeline takes over.
    expect(partyUsesNativeTranslation(party("Them", { stt_provider: "deepgram", native_translation: nativeOn }))).toBe(false);
    expect(partyUsesNativeTranslation(undefined)).toBe(false);
  });
});

describe("partyTranslationMode", () => {
  const parties = { you: false, them: true };

  it("native wins, then the party switch", () => {
    expect(partyTranslationMode("them", parties, audio({}, { stt_provider: SONIOX, native_translation: nativeOn }))).toBe("native");
    expect(partyTranslationMode("them", parties, audio())).toBe("service");
    expect(partyTranslationMode("you", parties, audio())).toBe("off");
    expect(partyTranslationMode("them", parties, null)).toBe("service");
  });

  it("the service handles only switched-on, non-native parties", () => {
    expect(serviceParties({ you: true, them: true }, audio())).toEqual(["you", "them"]);
    expect(serviceParties({ you: true, them: true }, audio({}, { stt_provider: SONIOX, native_translation: nativeOn }))).toEqual(["you"]);
    expect(serviceParties({ you: false, them: false }, audio())).toEqual([]);
  });
});

describe("applyPartyTranslationMode", () => {
  it("native turns the engine on and keeps its target", () => {
    const config = audio({}, { stt_provider: SONIOX, native_translation: { mode: "off", target_language: "ja" } });
    const out = applyPartyTranslationMode("them", "native", { you: false, them: false }, config);
    expect(out.parties).toEqual({ you: false, them: true });
    expect(out.audio?.them.native_translation).toEqual({ mode: "one_way", target_language: "ja" });
    expect(out.audio?.you).toBe(config.you);
  });

  it("native without an earlier setting follows the translation target", () => {
    const out = applyPartyTranslationMode("them", "native", { you: false, them: true }, audio({}, { stt_provider: SONIOX }));
    expect(out.audio?.them.native_translation).toEqual({ mode: "one_way", target_language: "" });
  });

  it("off and service switch the engine's translation off", () => {
    const config = audio({}, { stt_provider: SONIOX, native_translation: nativeOn });
    const off = applyPartyTranslationMode("them", "off", { you: false, them: true }, config);
    expect(off.parties.them).toBe(false);
    expect(off.audio?.them.native_translation?.mode).toBe("off");
    const service = applyPartyTranslationMode("them", "service", { you: false, them: true }, config);
    expect(service.parties.them).toBe(true);
    expect(service.audio?.them.native_translation?.mode).toBe("off");
  });

  it("a two-way setting without a language pair becomes one-way when the engine is chosen", () => {
    const config = audio({}, { stt_provider: SONIOX, native_translation: { mode: "two_way", language_a: "zh-CN" } });
    expect(partyTranslationMode("them", { you: false, them: true }, config)).toBe("service");
    const out = applyPartyTranslationMode("them", "native", { you: false, them: true }, config);
    expect(out.audio?.them.native_translation).toEqual({ mode: "one_way", language_a: "zh-CN", target_language: "" });
    // ...and is switched off when the service is chosen.
    const service = applyPartyTranslationMode("them", "service", { you: false, them: true }, config);
    expect(service.audio?.them.native_translation?.mode).toBe("off");
  });

  it("a working two-way setting is kept when the engine is chosen again", () => {
    const config = audio({}, { stt_provider: SONIOX, native_translation: { mode: "two_way", language_a: "zh-CN", language_b: "en" } });
    expect(partyTranslationMode("them", { you: false, them: false }, config)).toBe("native");
    expect(applyPartyTranslationMode("them", "native", { you: false, them: false }, config).audio).toBeNull();
  });

  it("leaves the audio config alone when nothing changes there", () => {
    expect(applyPartyTranslationMode("you", "service", { you: false, them: true }, audio()).audio).toBeNull();
    expect(applyPartyTranslationMode("you", "off", { you: true, them: true }, null)).toEqual({
      parties: { you: false, them: true },
      audio: null,
    });
  });
});

describe("partySourceLanguage", () => {
  it("an explicit translation source wins", () => {
    expect(partySourceLanguage("them", "de", audio({}, { language: "en-US" }), "fr-FR")).toBe("de");
  });

  it("otherwise the party's recognition language, else the global one", () => {
    expect(partySourceLanguage("them", "auto", audio({}, { language: "ja-JP" }), "en-US")).toBe("ja-JP");
    expect(partySourceLanguage("you", "auto", audio({ language: "zh_cn" }), "en-US")).toBe("zh-CN");
    expect(partySourceLanguage("them", "auto", audio(), "en-US")).toBe("en-US");
  });

  it("auto-detect stays auto-detect", () => {
    expect(partySourceLanguage("them", "auto", audio({}, { language: "auto" }), "en-US")).toBeUndefined();
    expect(partySourceLanguage("them", "auto", null, undefined)).toBeUndefined();
  });
});
