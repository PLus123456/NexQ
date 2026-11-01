import { afterEach, describe, expect, it } from "vitest";
import i18next from "i18next";
import {
  changeUiLanguage,
  currentUiLanguage,
  formatDate,
  formatNumber,
  normalizeUiLanguageSetting,
  resolveUiLanguage,
  t,
  useUiLanguageStore,
} from ".";
import { en, zhCN, NAMESPACES } from "./resources";

describe("resolveUiLanguage", () => {
  it("uses an explicit choice as is", () => {
    expect(resolveUiLanguage("zh-CN", "en-US")).toBe("zh-CN");
    expect(resolveUiLanguage("en", "zh-CN")).toBe("en");
  });

  it("follows a Chinese system language, else English", () => {
    expect(resolveUiLanguage("system", "zh-CN")).toBe("zh-CN");
    expect(resolveUiLanguage("system", "zh-Hans-CN")).toBe("zh-CN");
    expect(resolveUiLanguage("system", "zh-TW")).toBe("zh-CN");
    expect(resolveUiLanguage("system", "en-GB")).toBe("en");
    expect(resolveUiLanguage("system", "ja-JP")).toBe("en");
    expect(resolveUiLanguage("system", undefined)).toBe("en");
  });

  it("treats unknown stored values as system", () => {
    expect(normalizeUiLanguageSetting("zh-CN")).toBe("zh-CN");
    expect(normalizeUiLanguageSetting("en")).toBe("en");
    expect(normalizeUiLanguageSetting("fr")).toBe("system");
    expect(normalizeUiLanguageSetting(undefined)).toBe("system");
    expect(normalizeUiLanguageSetting(42)).toBe("system");
  });
});

describe("translations", () => {
  afterEach(async () => {
    await changeUiLanguage("en");
  });

  it("start in English in tests", () => {
    expect(currentUiLanguage()).toBe("en");
    expect(t("common:actions.save")).toBe("Save");
  });

  it("switch language at runtime", async () => {
    await changeUiLanguage("zh-CN");
    expect(i18next.language).toBe("zh-CN");
    expect(useUiLanguageStore.getState()).toEqual({ setting: "zh-CN", language: "zh-CN" });
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(t("common:actions.save")).toBe("保存");
    expect(t("common:errors.operationFailed", { detail: "x" })).toBe("操作失败：x");
  });

  it("pluralize per language", async () => {
    expect(t("common:units.seconds", { count: 1 })).toBe("1 second");
    expect(t("common:units.seconds", { count: 5 })).toBe("5 seconds");
    await changeUiLanguage("zh-CN");
    expect(t("common:units.seconds", { count: 1 })).toBe("1 秒");
  });

  it("format dates and numbers in the UI language", async () => {
    const date = new Date(2026, 10, 1);
    expect(formatDate(date)).toBe("Nov 1, 2026");
    expect(formatNumber(1234.5)).toBe("1,234.5");
    await changeUiLanguage("zh-CN");
    expect(formatDate(date)).toBe("2026年11月1日");
    expect(formatDate("not a date")).toBe("not a date");
  });

  it("have a resource file per namespace and language", () => {
    for (const ns of NAMESPACES) {
      expect(en[ns]).toBeTypeOf("object");
      expect(zhCN[ns]).toBeTypeOf("object");
    }
  });
});
