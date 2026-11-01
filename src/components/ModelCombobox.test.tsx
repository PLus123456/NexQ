import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { changeUiLanguage } from "../i18n";
import { ModelCombobox, type ModelComboboxProps, type ModelOption } from "./ModelCombobox";

type HarnessProps = Omit<ModelComboboxProps, "value" | "onChange" | "options"> & {
  initial?: string;
  options?: ModelComboboxProps["options"];
  onChange?: (model: string) => void;
};

const DEFAULT_OPTIONS: ModelOption[] = [
  { id: "gpt-4o", source: "fetched", detail: "128K" },
  { id: "gpt-4o-mini", source: "fetched" },
  { id: "anthropic/claude-3.5-sonnet", label: "Claude 3.5 Sonnet", source: "fetched" },
];

/** A controlled parent that stores what the combobox commits. */
function Harness({ initial = "gpt-4o", options = DEFAULT_OPTIONS, onChange, ...props }: HarnessProps) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <ModelCombobox
        aria-label="Model"
        {...props}
        options={options}
        value={value}
        onChange={(model) => {
          setValue(model);
          onChange?.(model);
        }}
      />
      <button type="button">elsewhere</button>
    </>
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

afterEach(async () => {
  cleanup();
  await act(() => changeUiLanguage("en"));
});

describe("ModelCombobox", () => {
  it("shows the value and lists every candidate on focus", async () => {
    const { user, input } = setup();
    expect(input.value).toBe("gpt-4o");
    expect(screen.queryByRole("listbox")).toBeNull();
    await user.click(input);
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(input).toHaveAttribute("aria-controls", screen.getByRole("listbox").id);
    expect(optionTexts()).toEqual(["gpt-4o128K", "gpt-4o-mini", "Claude 3.5 Sonnetanthropic/claude-3.5-sonnet"]);
    // The committed value is highlighted.
    expect(input).toHaveAttribute("aria-activedescendant", options()[0].id);
  });

  it("typing changes only the text; Enter commits it trimmed", async () => {
    const { user, input, onChange } = setup();
    await user.clear(input);
    await user.type(input, "  my-model  ");
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe("  my-model  ");
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith("my-model");
    expect(input.value).toBe("my-model");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("never swaps typed text for a matching candidate", async () => {
    const { user, input, onChange } = setup({ initial: "" });
    await user.type(input, "gpt-4");
    expect(optionTexts()).toEqual(["gpt-4o128K", "gpt-4o-mini"]);
    expect(input).not.toHaveAttribute("aria-activedescendant");
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith("gpt-4");
  });

  it("commits changed text on blur, and nothing when unchanged", async () => {
    const { user, input, onChange } = setup();
    await user.click(input);
    await user.tab();
    expect(onChange).not.toHaveBeenCalled();
    await user.clear(input);
    await user.type(input, "llama3 ");
    await user.click(screen.getByRole("button", { name: "elsewhere" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("llama3");
    expect(input.value).toBe("llama3");
  });

  it("filters on id and label, case-insensitively", async () => {
    const { user, input } = setup({ options: [...DEFAULT_OPTIONS, "qwen2.5:14b"] });
    await user.clear(input);
    await user.type(input, "SONNET");
    expect(optionTexts()).toEqual(["Claude 3.5 Sonnetanthropic/claude-3.5-sonnet"]);
    await user.clear(input);
    await user.type(input, "Qwen");
    expect(optionTexts()).toEqual(["qwen2.5:14b"]);
    await user.clear(input);
    await user.type(input, "claude sonnet");
    expect(options()).toHaveLength(1);
  });

  it("says when nothing matches, and Enter still uses the text", async () => {
    const { user, input, onChange } = setup();
    await user.clear(input);
    await user.type(input, "deepseek-chat");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No matching models — press Enter to use “deepseek-chat” as is")).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith("deepseek-chat");
  });

  it("picks an option with the arrow keys and Enter", async () => {
    const { user, input, onChange } = setup();
    await user.click(input);
    await user.keyboard("{ArrowDown}");
    expect(input).toHaveAttribute("aria-activedescendant", options()[1].id);
    expect(options()[1]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowDown}{ArrowDown}");
    // Wraps around to the first option.
    expect(input).toHaveAttribute("aria-activedescendant", options()[0].id);
    await user.keyboard("{ArrowUp}{Enter}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith("anthropic/claude-3.5-sonnet");
    expect(input.value).toBe("anthropic/claude-3.5-sonnet");
  });

  it("arrows after typing pick the highlighted candidate", async () => {
    const { user, input, onChange } = setup({ initial: "" });
    await user.type(input, "mini");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith("gpt-4o-mini");
  });

  it("opens and closes with the chevron, keeping focus in the input", async () => {
    const { user, input } = setup();
    const toggle = screen.getByRole("button", { name: "Show models" });
    await user.click(toggle);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(input).toHaveFocus();
    await user.click(toggle);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input).toHaveFocus();
  });

  it("picks an option with a click", async () => {
    const { user, input, onChange } = setup();
    await user.click(input);
    await user.click(screen.getByRole("option", { name: /gpt-4o-mini/ }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("gpt-4o-mini");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input).toHaveFocus();
  });

  it("Esc puts the committed value back", async () => {
    const { user, input, onChange } = setup();
    await user.clear(input);
    await user.type(input, "abc");
    await user.keyboard("{Escape}");
    expect(input.value).toBe("gpt-4o");
    expect(screen.queryByRole("listbox")).toBeNull();
    await user.tab();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("hints that a value outside the list is sent as is", () => {
    setup({ initial: "my-finetune" });
    const hint = screen.getByText("Not in the list — it will be sent as is.");
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-describedby", hint.id);
  });

  it.each([
    ["the value is listed", "gpt-4o", DEFAULT_OPTIONS],
    ["the value is empty", "", DEFAULT_OPTIONS],
    ["there are no candidates", "my-finetune", []],
  ])("has no hint when %s", (_, initial, list) => {
    setup({ initial, options: list });
    expect(screen.queryByText("Not in the list — it will be sent as is.")).toBeNull();
  });

  it("groups by source when there is more than one, the user's list first", async () => {
    const { user, input } = setup({
      options: [
        { id: "fetched-1", source: "fetched" },
        { id: "manual-1", source: "manual" },
        { id: "suggested-1", source: "suggested" },
        { id: "fetched-2", source: "fetched" },
      ],
    });
    await user.click(input);
    const groups = screen.getAllByRole("group");
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual(["Manual", "Fetched", "Suggested"]);
    expect(within(groups[1]).getAllByRole("option").map((o) => o.textContent)).toEqual(["fetched-1", "fetched-2"]);
    expect(optionTexts()).toEqual(["manual-1", "fetched-1", "fetched-2", "suggested-1"]);
  });

  it("has no group headers for a single source", async () => {
    const { user, input } = setup();
    await user.click(input);
    expect(screen.queryAllByRole("group")).toHaveLength(0);
  });

  it("shows each id once (first wins) and accepts plain strings", async () => {
    const { user, input } = setup({
      options: ["gpt-4o", { id: "gpt-4o", label: "Duplicate" }, " gpt-4o ", "", { id: " o3 ", detail: "200K" }],
    });
    await user.click(input);
    expect(optionTexts()).toEqual(["gpt-4o", "o3200K"]);
  });

  it("is a plain text input with an empty-state row when there are no candidates", async () => {
    const { user, input, onChange } = setup({ initial: "", options: [] });
    expect(screen.queryByRole("button", { name: "Show models" })).toBeNull();
    await user.click(input);
    expect(screen.getByText("No models yet — type a model ID")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Fetch the list" })).toBeNull();
    await user.type(input, "llama3.1:8b{Enter}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith("llama3.1:8b");
  });

  it("offers to fetch the list when it can", async () => {
    const onRefresh = vi.fn();
    const { user, input } = setup({ initial: "", options: [], onRefresh });
    await user.click(input);
    await user.click(screen.getByRole("button", { name: "Fetch the list" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(input).toHaveFocus();
  });

  it("has a refresh button, disabled while loading", async () => {
    const onRefresh = vi.fn();
    const { user } = setup({ onRefresh });
    await user.click(screen.getByRole("button", { name: "Refresh the model list" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    cleanup();
    setup({ onRefresh, loading: true });
    expect(screen.getByRole("button", { name: "Refresh the model list" })).toBeDisabled();
  });

  it("shows loading and the last error in the list without blocking typing", async () => {
    const { user, input, onChange } = setup({ loading: true, error: "HTTP 401: invalid key" });
    await user.click(input);
    expect(screen.getByText("Fetching models…")).toBeInTheDocument();
    expect(screen.getByText("Couldn't fetch the model list: HTTP 401: invalid key")).toBeInTheDocument();
    expect(options()).toHaveLength(3);
    await user.clear(input);
    await user.type(input, "o1{Enter}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith("o1");
  });

  it("shows only the spinner while the first fetch runs", async () => {
    const { user, input } = setup({ initial: "", options: [], loading: true, onRefresh: () => {} });
    await user.click(input);
    expect(screen.getByText("Fetching models…")).toBeInTheDocument();
    expect(screen.queryByText("No models yet — type a model ID")).toBeNull();
  });

  it("does nothing when disabled", async () => {
    const { user, input } = setup({ disabled: true, onRefresh: () => {} });
    expect(input).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh the model list" })).toBeDisabled();
    await user.click(input);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("follows the UI language", async () => {
    await act(() => changeUiLanguage("zh-CN"));
    const { user, input } = setup({
      initial: "my-finetune",
      options: [
        { id: "a", source: "manual" },
        { id: "b", source: "fetched" },
      ],
    });
    expect(screen.getByText("不在列表中，将按原样发送。")).toBeInTheDocument();
    expect(input).toHaveAttribute("placeholder", "选择或输入模型 ID");
    await user.click(input);
    expect(screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["手动添加", "已拉取"]);
  });
});
