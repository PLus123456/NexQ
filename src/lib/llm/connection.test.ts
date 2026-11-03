import { describe, expect, it } from "vitest";
import { formatTokenCount, parseTokenCount } from "./connection";

describe("context lengths", () => {
  it("reads the sizes people type", () => {
    expect(parseTokenCount("1M")).toBe(1_000_000);
    expect(parseTokenCount(" 256k ")).toBe(256_000);
    expect(parseTokenCount("1.5m")).toBe(1_500_000);
    expect(parseTokenCount("100万")).toBe(1_000_000);
    expect(parseTokenCount("1,024,000")).toBe(1_024_000);
    expect(parseTokenCount("")).toBeNull();
    expect(parseTokenCount("0")).toBeUndefined();
    expect(parseTokenCount("1x")).toBeUndefined();
    expect(parseTokenCount("-5")).toBeUndefined();
  });

  it("writes them back so they read the same", () => {
    expect(formatTokenCount(1_000_000)).toBe("1M");
    expect(formatTokenCount(1_024_000)).toBe("1024K");
    expect(formatTokenCount(262_144)).toBe("262144");
    for (const tokens of [1_000_000, 1_024_000, 262_144, 32_768]) {
      expect(parseTokenCount(formatTokenCount(tokens))).toBe(tokens);
    }
  });
});
