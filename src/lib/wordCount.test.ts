import { describe, expect, it, vi } from "vitest";
import { countWords } from "./wordCount";

describe("countWords", () => {
  it("segments Chinese without needing spaces", () => {
    expect(countWords("你好，世界！")).toBe(2);
    expect(countWords("你好世界")).toBe(2);
  });

  it("counts mixed text, numbers and contractions but ignores punctuation", () => {
    expect(countWords("你好，world! 123")).toBe(3);
    expect(countWords("We don't stop." )).toBe(3);
    expect(countWords("\n ！？... 👋 ")).toBe(0);
    expect(countWords("")).toBe(0);
  });

  it("still counts CJK text on WebViews without Intl.Segmenter", async () => {
    const original = Object.getOwnPropertyDescriptor(Intl, "Segmenter");
    Object.defineProperty(Intl, "Segmenter", { value: undefined, configurable: true });
    vi.resetModules();
    try {
      const fallback = await import("./wordCount");
      expect(fallback.countWords("你好，world! 123")).toBe(4);
      expect(fallback.countWords("你好世界")).toBe(4);
      expect(fallback.countWords("... 👋")).toBe(0);
    } finally {
      if (original) Object.defineProperty(Intl, "Segmenter", original);
      else Reflect.deleteProperty(Intl, "Segmenter");
      vi.resetModules();
    }
  });
});
