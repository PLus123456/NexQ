import { describe, expect, it } from "vitest";
import { defaultEndpoint, previewTranslateUrl } from "./providers";

// Must match how src-tauri/src/translation/{deepl,microsoft,google}.rs build their URLs.
describe("previewTranslateUrl", () => {
  it("official addresses", () => {
    expect(previewTranslateUrl("deepl", "", "abc:fx")).toEqual({ ok: true, url: "https://api-free.deepl.com/v2/translate", custom: false, trimmed: undefined });
    expect(previewTranslateUrl("deepl", "", "abc")).toMatchObject({ url: "https://api.deepl.com/v2/translate" });
    expect(previewTranslateUrl("microsoft", "")).toMatchObject({
      url: "https://api.cognitive.microsofttranslator.com/translate?api-version=3.0",
    });
    expect(previewTranslateUrl("google", "")).toMatchObject({
      url: "https://translation.googleapis.com/language/translate/v2",
    });
  });

  it("custom addresses are used as typed, plus the fixed path", () => {
    expect(previewTranslateUrl("deepl", " http://deeplx.lan:1188/v2/ ")).toEqual({
      ok: true,
      url: "http://deeplx.lan:1188/v2/translate",
      custom: true,
      trimmed: undefined,
    });
    expect(previewTranslateUrl("microsoft", "https://my-res.cognitiveservices.azure.com/translator/text/v3.0")).toMatchObject({
      url: "https://my-res.cognitiveservices.azure.com/translator/text/v3.0/translate?api-version=3.0",
    });
    expect(previewTranslateUrl("microsoft", "https://api.translator.azure.cn")).toMatchObject({
      url: "https://api.translator.azure.cn/translate?api-version=3.0",
    });
    expect(previewTranslateUrl("google", "https://proxy.lan/google/v2")).toMatchObject({ url: "https://proxy.lan/google/v2" });
  });

  it("a pasted full address is cut back to its base", () => {
    expect(previewTranslateUrl("deepl", "http://deeplx.lan/v2/translate")).toMatchObject({
      url: "http://deeplx.lan/v2/translate",
      trimmed: "/translate",
    });
    expect(previewTranslateUrl("google", "https://proxy.lan/v2/detect")).toMatchObject({
      url: "https://proxy.lan/v2",
      trimmed: "/detect",
    });
    // An api-version already in the address is kept, not repeated.
    expect(previewTranslateUrl("microsoft", "https://gw.example.com/ms?api-version=3.0")).toMatchObject({
      url: "https://gw.example.com/ms/translate?api-version=3.0",
    });
  });

  it("an address without http(s) is an error with a suggestion", () => {
    const preview = previewTranslateUrl("deepl", "deeplx.lan:1188/v2");
    expect(preview.ok).toBe(false);
    if (!preview.ok) {
      expect(preview.error.code).toBe("missing_scheme");
      expect(preview.error.suggestion).toBe("http://deeplx.lan:1188/v2");
    }
  });

  it("placeholders show the official address", () => {
    expect(defaultEndpoint("deepl", "k:fx")).toBe("https://api-free.deepl.com/v2");
    expect(defaultEndpoint("google")).toBe("https://translation.googleapis.com/language/translate/v2");
  });
});
