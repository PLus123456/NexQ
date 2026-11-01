import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { LlmQuickSetup } from "./llm/LlmQuickSetup";
import { SttQuickSetup } from "./stt/SttQuickSetup";
import { useMeetingStore } from "../stores/meetingStore";

describe("quick setup placeholders", () => {
  it.each([
    ["llm", LlmQuickSetup, "AI model"],
    ["stt", SttQuickSetup, "Speech recognition"],
  ] as const)("%s reports incomplete once and opens its settings tab", (tab, Component, title) => {
    const onStatusChange = vi.fn();
    const { rerender } = render(<Component variant="wizard" onStatusChange={onStatusChange} />);
    rerender(<Component variant="wizard" onStatusChange={onStatusChange} />);

    expect(screen.getByText(title)).toBeInTheDocument();
    expect(onStatusChange).toHaveBeenCalledTimes(1);
    expect(onStatusChange).toHaveBeenCalledWith("incomplete");

    useMeetingStore.setState({ currentView: "wizard", settingsTab: null });
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(useMeetingStore.getState().settingsTab).toBe(tab);
    expect(useMeetingStore.getState().currentView).toBe("settings");
  });

  it("has no settings button inside a settings page", () => {
    render(<LlmQuickSetup variant="settings" onStatusChange={() => {}} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
