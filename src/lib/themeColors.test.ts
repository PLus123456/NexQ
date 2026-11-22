import { describe, expect, it } from "vitest";
import { textColor } from "./themeColors";

describe("textColor", () => {
  it("lets the shipped defaults follow the theme", () => {
    expect(textColor("#d4d4d8", "#d4d4d8")).toBe("hsl(var(--foreground) / 0.88)");
    expect(textColor(undefined, "#e4e4e7")).toBe("hsl(var(--foreground))");
    expect(textColor("#FBBF24", "#fbbf24")).toBe("hsl(var(--translation-text))");
  });

  it("keeps a colour the user picked", () => {
    expect(textColor("#22c55e", "#d4d4d8")).toBe("#22c55e");
  });
});
