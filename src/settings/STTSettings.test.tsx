// Settings > STT Providers: each side's language and what its engine makes of it.
// NexQ Plus has one language picker per side on this page (no shared picker):
// upstream's Auto-detect checks and provider hints show under the side they
// are about.

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MeetingAudioConfig } from "../lib/types";
import type * as IPC from "../lib/ipc";

vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));
const credentialIpc = vi.hoisted(() => ({
  getApiKey: vi.fn(async (_slot: string): Promise<string | null> => null),
  testSTTConnection: vi.fn(async () => false),
  storeApiKey: vi.fn(async () => {}),
  storeAzureSpeechCredentials: vi.fn(async () => {}),
  deleteApiKey: vi.fn(async () => {}),
}));
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof IPC>()),
  ...credentialIpc,
  hasApiKey: async () => false,
  listLocalSTTEngines: async () => [],
}));

import { STTSettings } from "./STTSettings";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";

const config: MeetingAudioConfig = {
  you: { role: "You", device_id: "default", is_input_device: true, stt_provider: "web_speech" },
  them: { role: "Them", device_id: "default", is_input_device: false, stt_provider: "deepgram" },
  recording_enabled: false,
  preset_name: null,
};

type Side = "You" | "Them" | "Room";

/** A side's language picker ("Room" is Them in an in-person meeting). */
const picker = (name: Side) => screen.getByRole("combobox", { name: `Recognition language for ${name}` });

/** A side's language field: its picker and the notes under it. */
const field = (name: Side) => within(picker(name).closest(".grid > div") as HTMLElement);

beforeEach(() => {
  vi.clearAllMocks();
  credentialIpc.getApiKey.mockResolvedValue(null);
  useMeetingStore.setState({ audioMode: "online" });
  useConfigStore.setState({
    sttLanguage: "auto",
    sttProvider: "deepgram",
    meetingAudioConfig: config,
    deepgramConfig: { ...useConfigStore.getState().deepgramConfig, model: "nova-3" },
    verifiedCloudProviders: [],
  });
});
afterEach(cleanup);

it("preserves the saved Azure key and region after a candidate test fails", async () => {
  useConfigStore.setState({ verifiedCloudProviders: ["azure_speech"] });
  credentialIpc.getApiKey.mockImplementation(async (slot) => slot === "azure_speech" ? "old-key" : "eastus");
  render(<STTSettings />);
  fireEvent.click(screen.getByRole("button", { name: /^Azure Speech/ }));
  const key = await screen.findByDisplayValue("old-key");
  const region = screen.getByLabelText("Azure Region");
  fireEvent.change(key, { target: { value: "candidate-key" } });
  fireEvent.change(region, { target: { value: "westeurope" } });
  fireEvent.blur(region);
  fireEvent.click(screen.getByRole("button", { name: "Save & Test" }));
  await screen.findByText("Connection failed — key not saved");
  expect(credentialIpc.testSTTConnection).toHaveBeenCalledWith("azure_speech", { key: "candidate-key", region: "westeurope" });
  expect(credentialIpc.storeApiKey).not.toHaveBeenCalled();
  expect(credentialIpc.storeAzureSpeechCredentials).not.toHaveBeenCalled();
  expect(credentialIpc.deleteApiKey).not.toHaveBeenCalled();
  expect(useConfigStore.getState().verifiedCloudProviders).toContain("azure_speech");
  fireEvent.click(screen.getByRole("button", { name: /^Deepgram/ }));
  fireEvent.click(screen.getByRole("button", { name: /^Azure Speech/ }));
  await waitFor(() => expect(screen.getByLabelText("Azure Region")).toHaveValue("eastus"));
  await screen.findByDisplayValue("old-key");
});

it("opens on the engine You uses and names the side that can't detect the language", () => {
  render(<STTSettings />);
  // Not the stored sttProvider ("deepgram"): the You side runs Web Speech.
  expect(screen.getByRole("button", { name: /^Web Speech/ })).toHaveAttribute("aria-pressed", "true");
  expect(field("You").getByRole("alert")).toHaveTextContent(
    "Auto-detect doesn't work with Web Speech, used for You. " +
    "Choose Deepgram Nova-3, Parakeet TDT 0.6B v3, Groq Whisper or Whisper API for that side, or pick a language."
  );
  // Them runs Deepgram Nova-3, which can.
  expect(field("Them").queryByRole("alert")).toBeNull();
});

it("checks the Them side too, and says nothing when both can detect the language", () => {
  useConfigStore.setState({
    meetingAudioConfig: { ...config, you: { ...config.you, stt_provider: "deepgram" }, them: { ...config.them, stt_provider: "azure_speech" } },
  });
  render(<STTSettings />);
  expect(field("Them").getByRole("alert")).toHaveTextContent(/doesn't work with Azure Speech, used for Them\. Choose /);
  expect(screen.queryByText(/used for You/)).toBeNull();

  cleanup();
  useConfigStore.setState({ meetingAudioConfig: { ...config, you: { ...config.you, stt_provider: "deepgram" } } });
  render(<STTSettings />);
  expect(screen.queryByText(/Auto-detect doesn't work/)).toBeNull();
  expect(screen.getAllByText("Nova-3 can transcribe multiple languages within the same sentence.")).toHaveLength(2);
});

const deepgramYou: MeetingAudioConfig = { ...config, you: { ...config.you, stt_provider: "deepgram" } };

it("judges each side's engine by the language that side is transcribed in", () => {
  const flux = { ...useConfigStore.getState().deepgramConfig, model: "flux-general-multi" };
  // Shared Ukrainian, but You has its own English: Flux is fine for You, not for Them.
  useConfigStore.setState({
    sttLanguage: "uk-UA",
    deepgramConfig: flux,
    meetingAudioConfig: { ...deepgramYou, you: { ...deepgramYou.you, language: "en-US" } },
  });
  render(<STTSettings />);
  expect(field("You").queryByText(/Switch from Flux to Nova-3/)).toBeNull();
  expect(field("Them").getByText("Switch from Flux to Nova-3 for Ukrainian transcription.")).toBeInTheDocument();

  // Shared English, but You has its own Ukrainian: not fine.
  cleanup();
  useConfigStore.setState({
    sttLanguage: "en-US",
    meetingAudioConfig: { ...deepgramYou, you: { ...deepgramYou.you, language: "uk-UA" } },
  });
  render(<STTSettings />);
  expect(field("You").getByText("Switch from Flux to Nova-3 for Ukrainian transcription.")).toBeInTheDocument();
  expect(field("Them").queryByText(/Switch from Flux to Nova-3/)).toBeNull();

  // Without a language of its own, the shared one counts, as before.
  cleanup();
  useConfigStore.setState({ sttLanguage: "uk-UA", meetingAudioConfig: deepgramYou });
  render(<STTSettings />);
  expect(field("You").getByText("Switch from Flux to Nova-3 for Ukrainian transcription.")).toBeInTheDocument();
});

it("keeps the Cartesia line and the other provider hints", () => {
  useConfigStore.setState({
    sttLanguage: "es-ES",
    meetingAudioConfig: { ...config, you: { ...config.you, stt_provider: "cartesia" } },
  });
  render(<STTSettings />);
  expect(screen.getByText("Cartesia detects English, French, Hindi, Japanese, and Spanish on its own.")).toBeInTheDocument();
  cleanup();
  useConfigStore.setState({ sttLanguage: "de-DE" });
  render(<STTSettings />);
  expect(screen.getByText(/Cartesia transcribes only English, French, Hindi, Japanese, and Spanish/)).toBeInTheDocument();
  cleanup();
  useConfigStore.setState({
    sttLanguage: "vi-VN",
    meetingAudioConfig: { ...config, you: { ...config.you, stt_provider: "parakeet_tdt" } },
  });
  render(<STTSettings />);
  expect(screen.getByText(/The included Parakeet models do not support Vietnamese/)).toBeInTheDocument();
});

it("shows each side's own language in its picker, and only the room's in an in-person meeting", () => {
  useConfigStore.setState({ sttLanguage: "en-US" });
  render(<STTSettings />);
  expect(picker("You")).toHaveValue("English (US)");
  expect(picker("Them")).toHaveValue("English (US)");

  cleanup();
  useConfigStore.setState({
    meetingAudioConfig: {
      ...config,
      you: { ...config.you, language: "en-GB" },
      them: { ...config.them, language: "es-ES" },
    },
  });
  render(<STTSettings />);
  expect(picker("You")).toHaveValue("English (UK)");
  expect(picker("Them")).toHaveValue("Spanish");

  // In-person meetings transcribe the room only.
  cleanup();
  useMeetingStore.setState({ audioMode: "in_person" });
  render(<STTSettings />);
  expect(picker("Room")).toHaveValue("Spanish");
  expect(screen.queryByRole("combobox", { name: "Recognition language for You" })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Recognition language for Them" })).toBeNull();
});

it("warns about a side that picked Auto-detect itself, though the shared language is fixed", () => {
  useConfigStore.setState({
    sttLanguage: "en-US",
    meetingAudioConfig: { ...config, you: { ...config.you, language: "auto" } },
  });
  render(<STTSettings />);
  expect(field("You").getByRole("alert")).toHaveTextContent(/Auto-detect doesn't work with Web Speech, used for You\./);
  // The Nova-3 tip belongs to a side that is on Auto-detect and can detect.
  expect(screen.queryByText(/Nova-3 can transcribe|For speech that switches/)).toBeNull();
});

it("keeps the Nova-3 tip for a side on Auto-detect and drops the warning for a side that picked a language", () => {
  useConfigStore.setState({
    sttLanguage: "auto",
    meetingAudioConfig: { ...config, you: { ...config.you, language: "en-US" } },
  });
  render(<STTSettings />);
  // You (Web Speech) has its own language, so Auto-detect doesn't concern it; Them runs Deepgram Nova-3.
  expect(screen.queryByText(/Auto-detect doesn't work/)).toBeNull();
  expect(field("Them").getByText("Nova-3 can transcribe multiple languages within the same sentence.")).toBeInTheDocument();
  expect(field("You").queryByText(/Nova-3/)).toBeNull();
});
