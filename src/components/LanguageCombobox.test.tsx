import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { changeUiLanguage } from "../i18n";
import { STT_COMMON, TRANSLATION_COMMON } from "../lib/languages";
import { LanguageCombobox, type LanguageComboboxProps } from "./LanguageCombobox";

type HarnessProps = Omit<LanguageComboboxProps, "value" | "onChange"> & {
  initial?: string;
  onChange?: (code: string) => void;
};

/** A controlled parent that stores what the combobox commits. */
function Harness({ initial = "en-US", onChange, ...props }: HarnessProps) {
  const [value, setValue] = useState(initial);
  return (
    <LanguageCombobox
      aria-label="Language"
      {...props}
      value={value}
      onChange={(code) => {
        setValue(code);
        onChange?.(code);
      }}
    />
  );
}

function setup(props: HarnessProps = {}) {
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(<Harness onChange={onChange} {...props} />);
  const input = screen.getByRole("combobox") as HTMLInputElement;
  return { user, input, onChange };
}

const options = () => screen.getAllByRole("option");
const optionTexts = () => options().map((o) => o.textContent ?? "");
/** The codes of the language options (Auto-detect and "use as typed" rows have none). */
const optionCodes = () =>
  options()
    .map((o) => o.querySelector(".font-mono")?.textContent ?? "")
    .filter(Boolean);

afterEach(async () => {
  cleanup();
  await act(() => changeUiLanguage("en"));
});

describe("LanguageCombobox", () => {
  it("shows the selected language's name with its code", () => {
    const { input } = setup({ initial: "zh-CN" });
    expect(input.value).toBe("Chinese (Simplified)");
    expect(screen.getByText("zh-CN")).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("normalizes the shown value and shows unknown codes as typed", () => {
    setup({ initial: "x-Custom" });
    expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("x-custom");
  });

  it("lists Auto-detect, then the common languages, then the rest", async () => {
    const { user, input } = setup({ allowAuto: true });
    await user.click(input);
    const listbox = screen.getByRole("listbox");
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(input).toHaveAttribute("aria-controls", listbox.id);
    expect(optionTexts()[0]).toContain("Auto-detect");
    expect(optionCodes().slice(0, STT_COMMON.length)).toEqual([...STT_COMMON]);
    const common = screen.getByRole("group", { name: "Common languages" });
    expect(within(common).getAllByRole("option")).toHaveLength(STT_COMMON.length);
    const more = screen.getByRole("group", { name: "More languages" });
    expect(within(more).getAllByRole("option")[0]).toHaveTextContent("Afrikaans");
    // The current value is highlighted.
    const current = options()[1];
    expect(current).toHaveTextContent("English (US)");
    expect(input).toHaveAttribute("aria-activedescendant", current.id);
    expect(current).toHaveAttribute("aria-selected", "true");
  });

  it("uses the given common codes", async () => {
    const { user, input } = setup({ initial: "zh", common: TRANSLATION_COMMON });
    await user.click(input);
    expect(optionCodes().slice(0, 3)).toEqual(["af", "ar", "bn"]);
    expect(within(screen.getByRole("group", { name: "Common languages" })).getAllByRole("option")).toHaveLength(38);
  });

  it("typing replaces the shown name and filters", async () => {
    const { user, input } = setup();
    await user.click(input);
    await user.keyboard("fre");
    expect(input.value).toBe("fre");
    expect(optionCodes()).toEqual(["fr-FR", "fr"]);
    // A code-like query also gets a "use as typed" row after the name matches.
    expect(optionTexts()).toHaveLength(3);
    expect(optionTexts()[2]).toBe("Use “fre” as typed");
  });

  it.each([
    ["日本", ["ja-JP", "ja"]],
    ["deutsch", ["de-DE", "de"]],
    ["繁体", ["zh-TW"]],
    ["SPAN", ["es-ES", "es"]],
    ["zh_tw", ["zh-TW"]],
    ["portuguese brazil", ["pt-BR"]],
  ])("filters by code, English, Chinese and native names: %j", async (query, codes) => {
    const { user, input } = setup();
    await user.click(input);
    await user.keyboard(query);
    expect(optionCodes()).toEqual(codes);
  });

  it("moves with the arrow keys and commits with Enter", async () => {
    const { user, input, onChange } = setup();
    await user.click(input);
    await user.keyboard("japan");
    expect(input).toHaveAttribute("aria-activedescendant", options()[0].id);
    await user.keyboard("{ArrowDown}");
    expect(input).toHaveAttribute("aria-activedescendant", options()[1].id);
    expect(options()[1]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith("ja");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input.value).toBe("Japanese");
    expect(screen.getByText("ja")).toBeInTheDocument();
  });

  it("puts an exact code first", async () => {
    const { user, input, onChange } = setup();
    await user.click(input);
    await user.keyboard("de");
    expect(optionCodes()[0]).toBe("de");
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith("de");
  });

  it("commits an unknown code as typed, normalized", async () => {
    const { user, input, onChange } = setup();
    await user.click(input);
    await user.keyboard("es_mx");
    expect(optionTexts()).toEqual(["Use “es-MX” as typed"]);
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith("es-MX");
    expect(input.value).toBe("Spanish (MX)");
  });

  it("offers a code-like query as typed before weaker matches", async () => {
    const { user, input, onChange } = setup();
    await user.click(input);
    await user.keyboard("ta");
    expect(optionTexts()[0]).toBe("Use “ta” as typed");
    expect(optionTexts().slice(1).join(" ")).toContain("Italian");
    await user.click(screen.getByRole("option", { name: "Use “ta” as typed" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("ta");
  });

  it("with the list closed, Enter commits a typed code or reopens the list for a name", async () => {
    const { user, input, onChange } = setup();
    const toggle = screen.getByRole("button", { name: "Show languages" });
    await user.click(toggle);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(input).toHaveFocus();
    await user.keyboard("japan");
    await user.click(toggle);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input.value).toBe("japan");
    await user.keyboard("{Enter}");
    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveAttribute("aria-activedescendant", options()[0].id);
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("ja-JP");

    await user.keyboard("YUE");
    await user.click(toggle);
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("yue");
    expect(input.value).toBe("yue");
  });

  it("doesn't commit text that matches nothing and isn't a code", async () => {
    const { user, input, onChange } = setup();
    await user.click(input);
    await user.keyboard("no such language");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No matching languages")).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("Esc closes and puts the name back", async () => {
    const { user, input, onChange } = setup();
    await user.click(input);
    await user.keyboard("fre");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input.value).toBe("English (US)");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps Esc from window listeners while it's in use, not otherwise", async () => {
    const onWindowKey = vi.fn();
    window.addEventListener("keydown", onWindowKey);
    try {
      const { user, input } = setup();
      await user.click(input);
      await user.keyboard("{Escape}");
      expect(onWindowKey).not.toHaveBeenCalled();
      await user.keyboard("{Escape}");
      expect(onWindowKey).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", onWindowKey);
    }
  });

  it("a click outside commits nothing and reverts", async () => {
    const { user, input, onChange } = setup();
    await user.click(input);
    await user.keyboard("de");
    await user.click(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input.value).toBe("English (US)");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("clears and reverts on Enter with empty text", async () => {
    const { user, input, onChange } = setup();
    await user.clear(input);
    await user.keyboard("{Enter}");
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe("English (US)");
  });

  it("picks Auto-detect", async () => {
    const { user, input, onChange } = setup({ allowAuto: true });
    await user.click(input);
    await user.click(screen.getByRole("option", { name: /Auto-detect/ }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("auto");
    expect(input.value).toBe("Auto-detect");
    expect(screen.queryByText("auto")).toBeNull();
  });

  it("shows Auto-detect disabled with the reason when unavailable", async () => {
    const reason = "This engine can't detect the language";
    const { user, input, onChange } = setup({ allowAuto: true, autoUnavailableReason: reason });
    await user.click(input);
    const auto = screen.getByRole("option", { name: /Auto-detect/ });
    expect(auto).toHaveAttribute("aria-disabled", "true");
    expect(auto).toHaveTextContent(reason);
    await user.click(auto);
    expect(onChange).not.toHaveBeenCalled();
    // Typing "auto" finds it but can't pick it, and "auto" isn't taken as a code.
    await user.keyboard("auto");
    expect(input).not.toHaveAttribute("aria-activedescendant");
    await user.keyboard("{Enter}");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("has no Auto-detect unless allowed", async () => {
    const { user, input, onChange } = setup();
    await user.click(input);
    expect(screen.queryByRole("option", { name: /Auto-detect/ })).toBeNull();
    await user.keyboard("auto{Enter}");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does nothing when disabled", async () => {
    const { user, input } = setup({ disabled: true });
    expect(input).toBeDisabled();
    await user.click(input);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("follows the UI language", async () => {
    await act(() => changeUiLanguage("zh-CN"));
    const { user, input, onChange } = setup({ initial: "ja-JP", allowAuto: true });
    expect(input.value).toBe("日语");
    expect(input).toHaveAttribute("placeholder", "选择或输入语言代码");
    await user.click(input);
    expect(optionTexts()[0]).toContain("自动检测");
    expect(screen.getByRole("group", { name: "常用语言" })).toBeInTheDocument();
    await user.keyboard("西班牙");
    expect(optionCodes()).toEqual(["es-ES", "es"]);
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith("es-ES");
    expect(input.value).toBe("西班牙语");
  });
});
