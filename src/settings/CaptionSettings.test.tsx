import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ get: async () => undefined, set: async () => {}, onKeyChange: async () => () => {} }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
const locks = vi.hoisted(() => [] as boolean[]);
vi.mock("../lib/captions/window", () => ({ setCaptionsLocked: async (v: boolean) => void locks.push(v) }));

import { CaptionSettings } from "./CaptionSettings";
import { useConfigStore } from "../stores/configStore";
import { DEFAULT_CAPTIONS_SETTINGS } from "../lib/captions/types";
import { changeUiLanguage } from "../i18n";

beforeEach(() => {
  locks.length = 0;
  useConfigStore.setState({ ...DEFAULT_CAPTIONS_SETTINGS });
});
afterEach(async () => {
  cleanup();
  await changeUiLanguage("en");
});

describe("CaptionSettings", () => {
  it("has a live preview that follows the settings", () => {
    render(<CaptionSettings />);
    const preview = screen.getByTestId("caption-preview");
    expect(preview.querySelectorAll(".caption-cue").length).toBe(4); // two captions, on two backgrounds
    fireEvent.click(screen.getByRole("radio", { name: "Translation only" }));
    expect(useConfigStore.getState().captionsShow).toBe("translation");
    expect(preview.querySelector('[data-part="src"]')).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "1" }));
    expect(preview.querySelectorAll(".caption-cue:not([data-leaving])").length).toBe(2);
  });

  it("changes every setting of the table", () => {
    render(<CaptionSettings />);
    fireEvent.click(screen.getByRole("switch", { name: "Show when a meeting starts" }));
    fireEvent.click(screen.getByRole("radio", { name: "Both sides" }));
    fireEvent.change(screen.getByRole("slider", { name: "Original text size" }), { target: { value: "26" } });
    fireEvent.change(screen.getByRole("slider", { name: "Translation size" }), { target: { value: "18" } });
    fireEvent.click(screen.getByRole("button", { name: "Translation color #7dd3fc" }));
    fireEvent.change(screen.getByLabelText("Original color", { selector: "input" }), { target: { value: "#f0f0f0" } });
    fireEvent.change(screen.getByRole("slider", { name: "Backdrop" }), { target: { value: "0" } });
    fireEvent.change(screen.getByRole("slider", { name: "Fade out after" }), { target: { value: "0" } });
    expect(useConfigStore.getState()).toMatchObject({
      captionsEnabled: false,
      captionsParties: "both",
      captionsFontSize: 26,
      captionsTranslationFontSize: 18,
      captionsTranslationColor: "#7dd3fc",
      captionsTextColor: "#f0f0f0",
      captionsBgOpacity: 0,
      captionsFadeSeconds: 0,
    });
    expect(screen.getByText("Never")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Restore defaults" }));
    expect(useConfigStore.getState()).toMatchObject({ captionsParties: "them", captionsFontSize: 20, captionsBgOpacity: 0.35 });
  });

  it("unlocks a locked strip and puts it back at its default place", () => {
    useConfigStore.setState({ captionsLocked: true, captionsBounds: { x: 1, y: 2, width: 900, height: 200 } });
    render(<CaptionSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    expect(locks).toEqual([false]);
    fireEvent.click(screen.getByRole("button", { name: "Reset place" }));
    expect(useConfigStore.getState().captionsBounds).toBeNull();
  });

  it("follows the UI language", async () => {
    await changeUiLanguage("zh-CN");
    render(<CaptionSettings />);
    expect(screen.getByText("会议开始时显示")).toBeInTheDocument();
  });
});
