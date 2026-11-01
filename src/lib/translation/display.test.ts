import { describe, expect, it } from "vitest";
import type { TranslationResult } from "../types";
import { joinTranslatedTexts, lineTranslation, providerDisplayName } from "./display";

function result(id: string, text: string, provider = "DeepL", target = "en"): TranslationResult {
  return { segment_id: id, original_text: `orig ${id}`, translated_text: text, source_lang: "de", target_lang: target, provider };
}

describe("providerDisplayName", () => {
  it("names provider ids and keeps formatted names", () => {
    expect(providerDisplayName("soniox")).toBe("Soniox");
    expect(providerDisplayName("opus-mt")).toBe("OPUS-MT");
    expect(providerDisplayName("DeepL")).toBe("DeepL");
    expect(providerDisplayName("DeepSeek · deepseek-chat")).toBe("DeepSeek · deepseek-chat");
  });
});

describe("joinTranslatedTexts", () => {
  it("Chinese and Japanese sentences join without spaces", () => {
    expect(joinTranslatedTexts(["你好。", " 再见。"], "zh-CN")).toBe("你好。再见。");
    expect(joinTranslatedTexts(["はい。", "いいえ。"], "ja")).toBe("はい。いいえ。");
    expect(joinTranslatedTexts(["Hi.", "Bye.", " "], "en")).toBe("Hi. Bye.");
  });
});

describe("lineTranslation", () => {
  const translations = new Map([
    ["s1", result("s1", "First.")],
    ["s2", result("s2", "Second.", "soniox")],
  ]);

  it("a merged line shows every segment's translation in order", () => {
    const line = lineTranslation(["s1", "s2"], translations, new Set(), new Map());
    expect(line.text).toBe("First. Second.");
    expect(line.complete).toBe(true);
    expect(line.pending).toBe(false);
    expect(line.providers).toEqual(["DeepL", "Soniox"]);
  });

  it("a withdrawn (empty) engine translation counts as none", () => {
    const withdrawn = new Map([["s1", { ...result("s1", "", "soniox"), is_final: true }]]);
    const line = lineTranslation(["s1"], withdrawn, new Set(), new Map());
    expect(line.text).toBe("");
    expect(line.parts).toEqual([]);
    expect(line.complete).toBe(false);
  });

  it("streaming engine translations are marked", () => {
    const streaming = new Map([["s1", { ...result("s1", "早上", "soniox"), is_final: false }]]);
    expect(lineTranslation(["s1"], streaming, new Set(), new Map()).streaming).toBe(true);
    expect(lineTranslation(["s1"], translations, new Set(), new Map()).streaming).toBe(false);
  });

  it("a segment still translating marks the whole line pending", () => {
    const line = lineTranslation(["s1", "s3"], translations, new Set(["s3"]), new Map());
    expect(line.text).toBe("First.");
    expect(line.complete).toBe(false);
    expect(line.pending).toBe(true);
  });

  it("reports why a segment without a translation failed", () => {
    const errors = new Map([["s3", "HTTP 401"]]);
    const line = lineTranslation(["s3"], translations, new Set(), errors);
    expect(line.text).toBe("");
    expect(line.error).toBe("HTTP 401");
    // The newest text failed while an older translation is still shown.
    const stale = lineTranslation(["s1"], translations, new Set(), new Map([["s1", "HTTP 429"]]));
    expect(stale.text).toBe("First.");
    expect(stale.error).toBe("HTTP 429");
  });
});
