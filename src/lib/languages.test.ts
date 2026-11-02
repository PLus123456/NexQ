import { afterEach, describe, expect, it } from "vitest";
import { changeUiLanguage } from "../i18n";
import {
  AUTO_LANGUAGE,
  LANGUAGES,
  STT_COMMON,
  TRANSLATION_COMMON,
  baseLanguage,
  findLanguage,
  languageLabel,
  normalizeLanguageCode,
} from "./languages";

describe("catalog", () => {
  it("has an entry for every common recognition and translation code", () => {
    for (const code of [...STT_COMMON, ...TRANSLATION_COMMON]) {
      expect(findLanguage(code)?.code, code).toBe(code);
    }
  });

  it("keeps today's lists and order", () => {
    expect(STT_COMMON).toHaveLength(19);
    expect(STT_COMMON.slice(0, 3)).toEqual(["en-US", "en-GB", "es-ES"]);
    expect(STT_COMMON[STT_COMMON.length - 1]).toBe("vi-VN");
    expect(TRANSLATION_COMMON).toHaveLength(38);
    expect(TRANSLATION_COMMON.slice(0, 6)).toEqual(["af", "ar", "bn", "bg", "zh", "zh-TW"]);
    expect(TRANSLATION_COMMON[TRANSLATION_COMMON.length - 1]).toBe("vi");
  });

  it("merges both lists without duplicates, in canonical form", () => {
    const codes = LANGUAGES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.length).toBe(new Set([...STT_COMMON, ...TRANSLATION_COMMON]).size);
    for (const l of LANGUAGES) {
      expect(normalizeLanguageCode(l.code)).toBe(l.code);
      expect(l.en.trim(), l.code).not.toBe("");
      expect(l.zh.trim(), l.code).not.toBe("");
      expect(l.native.trim(), l.code).not.toBe("");
    }
    expect(new Set(STT_COMMON).size).toBe(STT_COMMON.length);
    expect(new Set(TRANSLATION_COMMON).size).toBe(TRANSLATION_COMMON.length);
  });

  it("keeps regional and plain codes apart", () => {
    expect(findLanguage("en")?.en).toBe("English");
    expect(findLanguage("en-US")).toMatchObject({ en: "English (US)", zh: "英语（美国）" });
    expect(findLanguage("zh-CN")).toMatchObject({
      en: "Chinese (Simplified)",
      zh: "简体中文",
      native: "简体中文",
    });
    expect(findLanguage("zh-TW")).toMatchObject({ zh: "繁体中文", native: "繁體中文" });
    expect(findLanguage("zh")?.en).toBe("Chinese");
  });
});

describe("normalizeLanguageCode", () => {
  it.each([
    ["zh_cn", "zh-CN"],
    ["ZH-hans", "zh-Hans"],
    ["EN", "en"],
    ["pt-br", "pt-BR"],
    [" Auto ", "auto"],
    ["AUTO", "auto"],
    ["x-custom", "x-custom"],
    ["X-Custom-US", "x-custom-us"],
    ["zh-hant-tw", "zh-Hant-TW"],
    ["es-419", "es-419"],
    ["en-us-x-Twain", "en-US-x-twain"],
    ["de-de-1996", "de-DE-1996"],
    ["en-", "en"],
    ["", ""],
    ["   ", ""],
  ])("%j → %j", (input, expected) => {
    expect(normalizeLanguageCode(input)).toBe(expected);
  });

  it("keeps unknown codes", () => {
    expect(normalizeLanguageCode("yue")).toBe("yue");
    expect(normalizeLanguageCode("Klingon")).toBe("klingon");
  });
});

describe("baseLanguage", () => {
  it("drops everything after the language", () => {
    expect(baseLanguage("zh-CN")).toBe("zh");
    expect(baseLanguage("en-US")).toBe("en");
    expect(baseLanguage("zh_hant_tw")).toBe("zh");
    expect(baseLanguage("ja")).toBe("ja");
    expect(baseLanguage(AUTO_LANGUAGE)).toBe("auto");
    expect(baseLanguage("")).toBe("");
  });

  it("returns a private-use code whole", () => {
    expect(baseLanguage("x-custom")).toBe("x-custom");
  });
});

describe("findLanguage", () => {
  it("matches the normalized code exactly", () => {
    expect(findLanguage("EN_us")?.code).toBe("en-US");
    expect(findLanguage(" pt-br ")?.code).toBe("pt-BR");
  });

  it("falls back to the base language", () => {
    expect(findLanguage("es-MX")?.code).toBe("es");
    expect(findLanguage("zh-Hant")?.code).toBe("zh");
    expect(findLanguage("en-AU")?.code).toBe("en");
  });

  it("knows nothing about auto, empty or unknown codes", () => {
    expect(findLanguage(AUTO_LANGUAGE)).toBeUndefined();
    expect(findLanguage("")).toBeUndefined();
    expect(findLanguage("x-custom")).toBeUndefined();
    expect(findLanguage("tlh")).toBeUndefined();
  });
});

describe("languageLabel", () => {
  afterEach(async () => {
    await changeUiLanguage("en");
  });

  it("names languages in English", () => {
    expect(languageLabel("zh-CN", "en")).toBe("Chinese (Simplified)");
    expect(languageLabel("en-US", "en")).toBe("English (US)");
    expect(languageLabel("de", "en")).toBe("German");
    expect(languageLabel("auto", "en")).toBe("Auto-detect");
  });

  it("names languages in Chinese", () => {
    expect(languageLabel("zh-CN", "zh-CN")).toBe("简体中文");
    expect(languageLabel("en-US", "zh-CN")).toBe("英语（美国）");
    expect(languageLabel("de", "zh-CN")).toBe("德语");
    expect(languageLabel(" AUTO ", "zh-CN")).toBe("自动检测");
  });

  it("adds the region to the base name for regional codes without an entry", () => {
    expect(languageLabel("es-MX", "en")).toBe("Spanish (MX)");
    expect(languageLabel("es_mx", "zh-CN")).toBe("西班牙语（MX）");
    expect(languageLabel("fa-IR", "en")).toBe("Farsi (Persian, IR)");
    expect(languageLabel("zh-Hant-HK", "en")).toBe("Chinese (Hant-HK)");
  });

  it("shows unknown codes as the (normalized) code", () => {
    expect(languageLabel("x-custom", "en")).toBe("x-custom");
    expect(languageLabel("TLH", "zh-CN")).toBe("tlh");
    expect(languageLabel("", "en")).toBe("");
  });

  it("follows the UI language by default", async () => {
    expect(languageLabel("ja-JP")).toBe("Japanese");
    expect(languageLabel(AUTO_LANGUAGE)).toBe("Auto-detect");
    await changeUiLanguage("zh-CN");
    expect(languageLabel("ja-JP")).toBe("日语");
    expect(languageLabel(AUTO_LANGUAGE)).toBe("自动检测");
  });
});
