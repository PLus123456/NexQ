import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QuickSetupPlaceholder } from "./QuickSetupPlaceholder";
import type { QuickSetupProps } from "./quickSetup";
import { SttQuickSetup } from "./stt/SttQuickSetup";
import { useMeetingStore } from "../stores/meetingStore";

// LlmQuickSetup is the real one now (P1); its placeholder is tested directly.
const LlmPlaceholder = (props: QuickSetupProps) => <QuickSetupPlaceholder {...props} area="llm" settingsTab="llm" />;

describe("quick setup placeholders", () => {
  it.each([
    ["llm", LlmPlaceholder, "AI model"],
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
    render(<LlmPlaceholder variant="settings" onStatusChange={() => {}} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
