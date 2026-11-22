import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CaptionsWindow } from "./CaptionsWindow";
import { changeUiLanguage } from "../i18n";

afterEach(async () => {
  cleanup();
  await changeUiLanguage("en");
});

describe("CaptionsWindow (placeholder)", () => {
  it("shows one placeholder line on a see-through container that fills its holder", () => {
    const { container } = render(<CaptionsWindow />);
    expect(screen.getByText("Caption strip: what is being said will show here.")).toBeInTheDocument();
    const root = container.firstElementChild as HTMLElement;
    expect(container.children).toHaveLength(1);
    expect(root.className).toContain("bg-transparent");
    expect(root.className).toContain("h-full");
    expect(root.className).toContain("w-full");
  });

  it("follows the UI language", async () => {
    await changeUiLanguage("zh-CN");
    render(<CaptionsWindow />);
    expect(screen.getByText("字幕条：这里会显示正在说的话。")).toBeInTheDocument();
  });
});
