import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));
vi.mock("../../settings/StealthSettings", () => ({ StealthSettings: () => null }));
vi.mock("../../settings/MeetingDetectionSettings", () => ({ MeetingDetectionSettings: () => null }));

import { GeneralSettings } from "../../settings/GeneralSettings";
import { complete, freshProgress, skipToFinish } from "../../lib/onboarding/progress";
import { resolveAppView } from "../../lib/onboarding/view";
import { resetOnboardingStoreForTests, useOnboardingStore } from "../../stores/onboardingStore";
import { useConfigStore } from "../../stores/configStore";
import { useMeetingStore } from "../../stores/meetingStore";
import type { Meeting } from "../../lib/types";

beforeEach(() => {
  resetOnboardingStoreForTests();
  useOnboardingStore.setState({ progress: complete(skipToFinish(freshProgress(4)), 1000), loaded: true });
  useConfigStore.setState({ firstRunCompleted: true });
  useMeetingStore.setState({ currentView: "settings", previousView: "launcher", settingsOpen: false, activeMeeting: null });
});

afterEach(cleanup);

describe("Run setup again (Settings → General)", () => {
  it("sits under the interface language card", () => {
    render(<GeneralSettings />);
    const language = screen.getByRole("group", { name: "Interface language" });
    const rerun = screen.getByRole("button", { name: "Run setup again" });
    expect(language.compareDocumentPosition(rerun) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("First-run setup")).toBeInTheDocument();
  });

  it("opens setup from the start right away, without a restart", async () => {
    const user = userEvent.setup();
    render(<GeneralSettings />);

    await user.click(screen.getByRole("button", { name: "Run setup again" }));

    expect(useConfigStore.getState().firstRunCompleted).toBe(false);
    const { currentView } = useMeetingStore.getState();
    expect(currentView).toBe("launcher");
    expect(resolveAppView(false, currentView)).toBe("wizard");
    const { progress } = useOnboardingStore.getState();
    expect(progress.current).toBe("language");
    expect(progress.completedAt).toBeNull();
    expect(progress.rev).toBeGreaterThan(4);
  });

  it("waits until the meeting has ended", () => {
    useMeetingStore.setState({ activeMeeting: { id: "m1" } as Meeting });
    render(<GeneralSettings />);
    expect(screen.getByRole("button", { name: "Run setup again" })).toBeDisabled();
    expect(screen.getByText("Available once the meeting has ended.")).toBeInTheDocument();
  });
});
