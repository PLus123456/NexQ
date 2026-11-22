// NexQ Plus: Cartesia's language check lives with the engine metadata
// (upstream's lib/sttLanguages.ts re-exports it), over the catalog in lib/languages.ts.
import { describe, expect, it } from "vitest";
import { LANGUAGES, STT_COMMON } from "../languages";
import { cartesiaSupportsLanguage } from "./providerMeta";

describe("cartesiaSupportsLanguage", () => {
  it("accepts the five languages ink-2 detects", () => {
    for (const lang of ["en", "en-US", "en-GB", "fr-FR", "hi-IN", "ja-JP", "es-ES", "ja"]) {
      expect(cartesiaSupportsLanguage(lang)).toBe(true);
    }
  });

  it("rejects the other app languages", () => {
    const codes = [...new Set([...STT_COMMON, ...LANGUAGES.map((l) => l.code)])];
    const unsupported = codes.filter((v) => !["en", "fr", "hi", "ja", "es"].includes(v.split("-")[0].toLowerCase()));
    expect(unsupported).toContain("ru-RU");
    expect(unsupported).toContain("zh-CN");
    for (const lang of unsupported) {
      expect(cartesiaSupportsLanguage(lang)).toBe(false);
    }
  });
});
