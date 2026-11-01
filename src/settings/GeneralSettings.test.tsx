import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));
// Cards with their own files (and translations, owned elsewhere).
vi.mock("./StealthSettings", () => ({ StealthSettings: () => null }));
vi.mock("./MeetingDetectionSettings", () => ({ MeetingDetectionSettings: () => null }));

import { GeneralSettings } from "./GeneralSettings";
import { changeUiLanguage, useUiLanguageStore } from "../i18n";

/** Latin words in the page's text and labels that aren't in `keep`. */
function untranslatedWords(root: HTMLElement, keep: readonly string[]): string[] {
  const texts: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) texts.push(walker.currentNode.textContent ?? "");
  root.querySelectorAll("*").forEach((el) => {
    for (const attr of ["title", "aria-label", "alt", "placeholder"]) {
      const value = el.getAttribute(attr);
      if (value) texts.push(value);
    }
  });
  return texts.flatMap((text) => text.match(/[A-Za-z]{2,}/g) ?? []).filter((w) => !keep.includes(w));
}

afterEach(async () => {
  cleanup();
  await changeUiLanguage("en");
});

describe("GeneralSettings", () => {
  it("offers the interface languages, each named in its own language", () => {
    render(<GeneralSettings />);
    const group = screen.getByRole("group", { name: "Interface language" });
    const options = within(group).getAllByRole("button");
    expect(options.map((b) => b.textContent)).toEqual(["Follow system", "简体中文", "English"]);
    // Tests start with the setting "en" (src/test/setup.ts).
    expect(within(group).getByRole("button", { name: "English" })).toHaveAttribute("aria-pressed", "true");
    expect(within(group).getByRole("button", { name: "简体中文" })).toHaveAttribute("lang", "zh-CN");
  });

  it("switches the interface language, and back to following the system", async () => {
    const user = userEvent.setup();
    render(<GeneralSettings />);

    await user.click(screen.getByRole("button", { name: "简体中文" }));
    expect(useUiLanguageStore.getState()).toEqual({ setting: "zh-CN", language: "zh-CN" });
    const group = await screen.findByRole("group", { name: "界面语言" });
    expect(within(group).getByRole("button", { name: "简体中文" })).toHaveAttribute("aria-pressed", "true");

    // jsdom's system language is English.
    await user.click(within(group).getByRole("button", { name: "跟随系统" }));
    expect(useUiLanguageStore.getState()).toEqual({ setting: "system", language: "en" });
    const english = await screen.findByRole("group", { name: "Interface language" });
    expect(within(english).getByRole("button", { name: "Follow system" })).toHaveAttribute("aria-pressed", "true");
  });

  it("no longer shows the Data Directory setting", () => {
    render(<GeneralSettings />);
    expect(screen.queryByText("Data Directory")).not.toBeInTheDocument();
    expect(screen.queryByText("Default app data directory")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change" })).not.toBeInTheDocument();
  });

  it("keeps the original English text, with the product name filled in", () => {
    render(<GeneralSettings />);
    expect(screen.getByText("Launch NexQ Plus automatically when you log in")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Toggle start on login" })).toBeInTheDocument();
    expect(screen.getByText("AI Actions").tagName).toBe("STRONG");
    expect(screen.getByText(/have moved to the/)).toHaveTextContent(
      "Context Window, Auto-Trigger, and AI instructions have moved to the AI Actions tab.",
    );
  });

  it("is fully translated in Chinese", async () => {
    await changeUiLanguage("zh-CN");
    const { container } = render(<GeneralSettings />);
    expect(screen.getByText("登录系统时自动启动 NexQ Plus")).toBeInTheDocument();
    expect(screen.getByText("AI 动作").tagName).toBe("STRONG");
    expect(untranslatedWords(container, ["English", "AI", "NexQ", "Plus"])).toEqual([]);
  });
});
