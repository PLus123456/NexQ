// The Soniox card on the translation settings page: one click per party to
// let Soniox translate while it recognizes, and back to the service.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingAudioConfig, PartyAudioConfig, STTProviderType } from "../../lib/types";

const invoke = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => undefined));

vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: Record<string, unknown>) => invoke(cmd, args) }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));

import { SonioxTranslationCard } from "./SonioxTranslationCard";
import { useTranslationStore } from "../../stores/translationStore";
import { useConfigStore } from "../../stores/configStore";
import { useMeetingStore } from "../../stores/meetingStore";

const SONIOX = "soniox" as STTProviderType;

function party(role: "You" | "Them", extra: Partial<PartyAudioConfig> = {}): PartyAudioConfig {
  return { role, device_id: "", is_input_device: role === "You", stt_provider: "deepgram", ...extra };
}

function audio(them: Partial<PartyAudioConfig> = {}): MeetingAudioConfig {
  return { you: party("You"), them: party("Them", them), recording_enabled: false, preset_name: "Free" };
}

/** Whether a region the Soniox settings may use has a key (`soniox_key_status`); the old slot always has one. */
function keySaved(saved: boolean) {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "soniox_key_status") {
      return JSON.stringify({
        regions: { us: false, eu: false, jp: saved, in: false },
        legacy: true,
        legacy_region: "us",
        any_enabled: saved,
      });
    }
    return cmd === "has_api_key" ? true : undefined;
  });
}

async function renderCard() {
  render(<SonioxTranslationCard />);
  await act(async () => {});
}

const them = () => useConfigStore.getState().meetingAudioConfig!.them;

beforeEach(() => {
  invoke.mockReset();
  keySaved(true);
  useConfigStore.setState({ meetingAudioConfig: audio() });
  useTranslationStore.setState({ targetLang: "zh-CN", translateParties: { you: false, them: false } });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SonioxTranslationCard", () => {
  it("moves a party to Soniox with its translation on", async () => {
    await renderCard();
    const [, themButton] = screen.getAllByRole("button", { name: "Switch to Soniox and translate" });
    fireEvent.click(themButton);

    expect(them().stt_provider).toBe(SONIOX);
    expect(them().native_translation).toMatchObject({ mode: "one_way", target_language: "" });
    expect(useConfigStore.getState().meetingAudioConfig!.preset_name).toBeNull();
    expect(useConfigStore.getState().meetingAudioConfig!.you.stt_provider).toBe("deepgram");
    expect(useTranslationStore.getState().translateParties).toEqual({ you: false, them: true });
    expect(screen.getByText("Translated by Soniox")).toBeInTheDocument();
  });

  it("turns on the translation of a party already on Soniox", async () => {
    useConfigStore.setState({
      meetingAudioConfig: audio({ stt_provider: SONIOX, native_translation: { mode: "off", target_language: "ja" } }),
    });
    await renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Turn on Soniox translation" }));

    expect(them().stt_provider).toBe(SONIOX);
    expect(them().native_translation).toMatchObject({ mode: "one_way", target_language: "ja" });
    expect(useTranslationStore.getState().translateParties.them).toBe(true);
  });

  it("hands a party back to the translation service and keeps Soniox recognizing", async () => {
    useConfigStore.setState({
      meetingAudioConfig: audio({ stt_provider: SONIOX, native_translation: { mode: "one_way", target_language: "" } }),
    });
    useTranslationStore.setState({ translateParties: { you: false, them: true } });
    await renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Use the translation service" }));

    expect(them().stt_provider).toBe(SONIOX);
    expect(them().native_translation?.mode).toBe("off");
    expect(useTranslationStore.getState().translateParties.them).toBe(true);
  });

  it("points to the Soniox key when no region the Soniox settings may use has one", async () => {
    keySaved(false);
    await renderCard();
    // The regions decide, with the current Soniox settings (the old slot alone doesn't).
    expect(screen.getByText(/No Soniox API key yet/)).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("soniox_key_status", {
      configJson: JSON.stringify(useConfigStore.getState().sonioxConfig),
    });

    useMeetingStore.setState({ currentView: "launcher", settingsTab: null });
    fireEvent.click(screen.getByRole("button", { name: "Add key" }));
    expect(useMeetingStore.getState().settingsTab).toBe("stt");

    // Checked again when the Soniox settings change.
    keySaved(true);
    const config = useConfigStore.getState().sonioxConfig;
    await act(async () => {
      useConfigStore.setState({ sonioxConfig: { ...config, regions: config.regions.map((r) => ({ ...r, enabled: r.id === "jp" })) } });
    });
    expect(screen.queryByText(/No Soniox API key yet/)).toBeNull();
  });

  it("says nothing about the key when one is saved", async () => {
    await renderCard();
    expect(screen.queryByText(/No Soniox API key yet/)).toBeNull();
  });
});
