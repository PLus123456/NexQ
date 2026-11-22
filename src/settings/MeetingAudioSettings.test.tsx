import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingAudioConfig } from "../lib/types";
import type * as IPC from "../lib/ipc";

vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof IPC>()),
  listAudioDevices: async () => ({
    inputs: [{ id: 'Studio: USB "Audio"', name: 'Studio: USB "Audio"', is_input: true, is_default: false }],
    outputs: [{ id: 'Studio: USB "Audio"', name: 'Studio: USB "Audio"', is_input: false, is_default: false }],
  }),
  getAudioSessions: async () => [],
  hasApiKey: async () => false,
  listLocalSTTEngines: async () => [],
  startDeviceMonitor: async () => {},
  stopDeviceMonitor: async () => {},
  stopAudioTest: async () => false,
}));

import { MeetingAudioSettings, sonioxPairProblem } from "./MeetingAudioSettings";
import { STTSettings } from "./STTSettings";
import { PartyLanguageField } from "./stt/PartyLanguageField";
import { AudioSetupStep } from "../components/wizard/AudioSetupStep";
import { changeUiLanguage } from "../i18n";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";
import { DEFAULT_OPENAI_COMPAT_STT_CONFIG } from "../lib/stt/types";

const initialConfig: MeetingAudioConfig = {
  you: { role: "You", device_id: 'Studio: USB "Audio"', is_input_device: true, stt_provider: "deepgram" },
  them: { role: "Them", device_id: 'Studio: USB "Audio"', is_input_device: true, stt_provider: "deepgram" },
  recording_enabled: false,
  preset_name: null,
};

const { deepgramConfig: initialDeepgramConfig, activeModelPerEngine: initialModels } = useConfigStore.getState();
beforeEach(() => useConfigStore.setState({ meetingAudioConfig: initialConfig, sttLanguage: "en-US" }));
afterEach(async () => {
  cleanup();
  // A test's models (Flux, Parakeet CTC, say) and meeting mode must not reach the next test.
  useConfigStore.setState({ deepgramConfig: initialDeepgramConfig, activeModelPerEngine: initialModels });
  useMeetingStore.setState({ audioMode: "online" });
  await act(() => changeUiLanguage("en"));
});

/** A side's language picker (NexQ Plus: one combobox per side; "Room" is Them in an in-person meeting). */
const side = (name: "You" | "Them" | "Room") =>
  screen.getByRole<HTMLInputElement>("combobox", { name: `Recognition language for ${name}` });

/** Types a language code (or "auto") into a side's picker and commits it. */
async function pick(user: ReturnType<typeof userEvent.setup>, name: "You" | "Them" | "Room", code: string) {
  await user.click(side(name));
  await user.keyboard(code);
  await user.keyboard("{Enter}");
}

describe.each([
  { surface: "Audio & Devices", Component: MeetingAudioSettings },
  { surface: "STT Settings", Component: STTSettings },
])("Vietnamese recognition in $surface", ({ Component }) => {
  it.each([
    { party: "you" as const, label: "You", other: "them" as const },
    { party: "them" as const, label: "Them", other: "you" as const },
  ])("selects Vietnamese for $label without changing the other party", async ({ party, label, other }) => {
    const user = userEvent.setup();
    render(<Component />);
    const input = screen.getByRole("combobox", { name: `Recognition language for ${label}` });
    await user.click(input);
    const common = screen.getByRole("group", { name: "Common languages" });
    await user.click(within(common).getByRole("option", { name: /Vietnamese/ }));
    const config = useConfigStore.getState();
    expect(config.meetingAudioConfig?.[party].language).toBe("vi-VN");
    expect(config.meetingAudioConfig?.[other].language).toBeUndefined();
    expect(config.sttLanguage).toBe("en-US");
    expect(input).toHaveValue("Vietnamese");
    expect(screen.getByText("Select a Deepgram model that supports Vietnamese, such as Nova-3.")).toBeInTheDocument();
  });
});

describe.each(["vi", "vi-VN"])("Vietnamese model guidance for %s", (language) => {
  it("warns about Parakeet in English and Chinese without recommending another Parakeet model", async () => {
    useConfigStore.setState({ activeModelPerEngine: { parakeet_tdt: "parakeet-ctc-110m" } });
    render(<PartyLanguageField party={{ ...initialConfig.you, stt_provider: "parakeet_tdt", language }} onChange={() => {}} />);
    expect(screen.getByText(/The included Parakeet models do not support Vietnamese/)).toBeInTheDocument();
    expect(screen.queryByText(/Parakeet TDT 0.6B v3/)).toBeNull();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    await act(() => changeUiLanguage("zh-CN"));
    expect(screen.getByRole("combobox")).toHaveValue("越南语");
    expect(screen.getByText(/内置的 Parakeet 模型不支持越南语/)).toBeInTheDocument();
    expect(screen.queryByText(/The included Parakeet models/)).toBeNull();
  });

  it("localizes the Deepgram model guidance", async () => {
    render(<PartyLanguageField party={{ ...initialConfig.you, language }} onChange={() => {}} />);
    expect(screen.getByText("Select a Deepgram model that supports Vietnamese, such as Nova-3.")).toBeInTheDocument();
    await act(() => changeUiLanguage("zh-CN"));
    expect(screen.getByText("请选择支持越南语的 Deepgram 模型，例如 Nova-3。")).toBeInTheDocument();
    expect(screen.queryByText(/Select a Deepgram model that supports Vietnamese/)).toBeNull();
  });
});

describe("Cartesia language guidance", () => {
  const renderCartesia = (language: string) =>
    render(<PartyLanguageField party={{ ...initialConfig.you, stt_provider: "cartesia", language }} onChange={() => {}} />);

  it("names the languages it detects, in the UI language", async () => {
    renderCartesia("auto");
    expect(screen.getByText("Cartesia detects English, French, Hindi, Japanese, and Spanish on its own.")).toBeInTheDocument();
    await act(() => changeUiLanguage("zh-CN"));
    expect(screen.getByText("Cartesia 会自动识别英语、法语、印地语、日语和西班牙语。")).toBeInTheDocument();
  });

  it("warns about a language it can't transcribe", async () => {
    renderCartesia("de-DE");
    expect(screen.getByText(/^Cartesia transcribes only English, French, Hindi, Japanese, and Spanish\./)).toBeInTheDocument();
    await act(() => changeUiLanguage("zh-CN"));
    expect(screen.getByText("Cartesia 只能识别英语、法语、印地语、日语和西班牙语。这种语言请换用其他识别引擎。")).toBeInTheDocument();
  });
});

describe("what an engine can't do with a side's language, in the UI language", () => {
  // The hints of lib/sttLanguages (upstream's wording): each has wording of its own in Chinese.
  it.each([
    ["parakeet_tdt", undefined, "zh-CN", "Parakeet TDT 0.6B v3 transcribes 25 European languages only. Choose a multilingual Whisper model, Deepgram Nova-3, or Azure Speech for this language.", "Parakeet TDT 0.6B v3 只能识别 25 种欧洲语言。这种语言请选择多语言 Whisper 模型、Deepgram Nova-3 或 Azure Speech。"],
    ["parakeet_tdt", "parakeet-ctc-110m", "de-DE", "Parakeet CTC 110M is English-only. Choose Parakeet TDT 0.6B v3 for multilingual transcription.", "Parakeet CTC 110M 只支持英语。需要识别其他语言时请选择 Parakeet TDT 0.6B v3。"],
    ["deepgram", "flux-general-en", "es-ES", "Flux transcribes English only. Switch to Flux Multilingual or Nova-3 for this language.", "Flux 只能识别英语。这种语言请改用 Flux Multilingual 或 Nova-3。"],
    ["deepgram", "flux-general-en", "zh-CN", "Flux transcribes English only. Switch to Nova-3 for this language.", "Flux 只能识别英语。这种语言请改用 Nova-3。"],
    ["deepgram", "flux-general-multi", "uk-UA", "Switch from Flux to Nova-3 for Ukrainian transcription.", "识别乌克兰语请从 Flux 改用 Nova-3。"],
    ["deepgram", "flux-general-multi", "zh-CN", "Flux Multilingual doesn't cover this language. Switch to Nova-3.", "Flux Multilingual 不支持这种语言，请改用 Nova-3。"],
    ["ort_streaming", undefined, "zh-CN", "ORT Streaming models are English-only. Choose another provider for this language.", "ORT Streaming 的模型只支持英语。这种语言请换用其他识别引擎。"],
    ["sherpa_onnx", undefined, "zh-CN", "This Sherpa-ONNX model doesn't cover this language. Choose SenseVoice Small, or another provider for this language.", "这个 Sherpa-ONNX 模型不支持这种语言。请选择 SenseVoice Small，或换用其他识别引擎。"],
    ["sherpa_onnx", undefined, "de-DE", "This Sherpa-ONNX model doesn't cover this language. Choose another provider for this language.", "这个 Sherpa-ONNX 模型不支持这种语言，请换用其他识别引擎。"],
    ["whisper_cpp", "ggml-base.en.bin", "zh-CN", "The base.en Whisper model is English-only. Choose a multilingual Whisper model (Tiny, Base, Small, Medium or Large v3 Turbo) for this language.", "Whisper 模型 base.en 只支持英语。这种语言请选择多语言 Whisper 模型（Tiny、Base、Small、Medium 或 Large v3 Turbo）。"],
  ] as const)("%s (%s) with %s", async (stt_provider, model, language, english, chinese) => {
    // Deepgram's model is a setting of its own; a local engine's is the side's.
    if (stt_provider === "deepgram") {
      useConfigStore.setState({ deepgramConfig: { ...useConfigStore.getState().deepgramConfig, model: model! } });
    }
    const local_model_id = stt_provider === "deepgram" ? undefined : model;
    render(<PartyLanguageField party={{ ...initialConfig.them, stt_provider, local_model_id, language }} onChange={() => {}} />);
    expect(screen.getByRole("alert")).toHaveTextContent(english);
    await act(() => changeUiLanguage("zh-CN"));
    expect(screen.getByRole("alert")).toHaveTextContent(chinese);
    expect(screen.queryByText(english)).toBeNull();
  });

  // The Auto-detect problem is Rust's refusal, word for word, in English; in Chinese it has wording of its own.
  it.each([
    [
      "azure_speech", undefined, "You",
      "Auto-detect doesn't work with Azure Speech, used for You. Choose Deepgram Nova-3, Parakeet TDT 0.6B v3, Groq Whisper or Whisper API for that side, or pick a language.",
      "“我”使用的 Azure Speech 不支持自动检测。请为这一侧选择 Deepgram Nova-3、Parakeet TDT 0.6B v3、Groq Whisper 或 Whisper API，或者指定一种语言。",
    ],
    [
      "deepgram", "nova-2", "Them",
      "Auto-detect doesn't work with Deepgram Nova 2, used for Them. Choose Deepgram Nova-3, Parakeet TDT 0.6B v3, Groq Whisper or Whisper API for that side, or pick a language.",
      "“对方”使用的 Deepgram Nova 2 不支持自动检测。请为这一侧选择 Deepgram Nova-3、Parakeet TDT 0.6B v3、Groq Whisper 或 Whisper API，或者指定一种语言。",
    ],
    [
      "whisper_cpp", "ggml-base.en.bin", "Them",
      "Auto-detect doesn't work with the base.en Whisper model, used for Them. Choose a multilingual Whisper model (Tiny, Base, Small, Medium or Large v3 Turbo), or pick a language.",
      "“对方”使用的 Whisper 模型 base.en 不支持自动检测。请选择多语言 Whisper 模型（Tiny、Base、Small、Medium 或 Large v3 Turbo），或者指定一种语言。",
    ],
    [
      "parakeet_tdt", "parakeet-ctc-110m", "Them",
      "Auto-detect doesn't work with Parakeet CTC 110M, used for Them. Choose Deepgram Nova-3, Parakeet TDT 0.6B v3, Groq Whisper or Whisper API for that side, or pick a language.",
      "“对方”使用的 Parakeet CTC 110M 不支持自动检测。请为这一侧选择 Deepgram Nova-3、Parakeet TDT 0.6B v3、Groq Whisper 或 Whisper API，或者指定一种语言。",
    ],
  ] as const)("Auto-detect on %s (%s) for %s", async (stt_provider, model, role, english, chinese) => {
    if (stt_provider === "deepgram") {
      useConfigStore.setState({ deepgramConfig: { ...useConfigStore.getState().deepgramConfig, model: model! } });
    }
    const local_model_id = stt_provider === "deepgram" ? undefined : model;
    render(
      <PartyLanguageField
        party={{ ...initialConfig.you, role, stt_provider, local_model_id, language: "auto" }}
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(english);
    await act(() => changeUiLanguage("zh-CN"));
    expect(screen.getByRole("alert")).toHaveTextContent(chinese);
  });

  it("names the room in the Auto-detect problem of an in-person meeting, in Chinese too", async () => {
    useMeetingStore.setState({ audioMode: "in_person" });
    await act(() => changeUiLanguage("zh-CN"));
    render(
      <PartyLanguageField party={{ ...initialConfig.them, stt_provider: "azure_speech", language: "auto" }} onChange={() => {}} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/^“现场”使用的 Azure Speech 不支持自动检测。/);
  });
});

describe("mixed-language speech with Auto-detect", () => {
  it("says what Nova-3 does, and points other engines to it, in the UI language", async () => {
    const view = render(<PartyLanguageField party={{ ...initialConfig.you, language: "auto" }} onChange={() => {}} />);
    expect(screen.getByText("Nova-3 can transcribe multiple languages within the same sentence.")).toBeInTheDocument();
    await act(() => changeUiLanguage("zh-CN"));
    expect(screen.getByText("Nova-3 可以识别同一句话里夹杂的多种语言。")).toBeInTheDocument();
    await act(() => changeUiLanguage("en"));
    view.unmount();

    render(
      <PartyLanguageField party={{ ...initialConfig.you, stt_provider: "groq_whisper", language: "auto" }} onChange={() => {}} />,
    );
    expect(screen.getByText("For speech that switches languages mid-sentence, use Deepgram Nova-3.")).toBeInTheDocument();
    await act(() => changeUiLanguage("zh-CN"));
    expect(screen.getByText("如果说话时会在一句话里切换语言，请使用 Deepgram Nova-3。")).toBeInTheDocument();
  });

  it("leaves the tip out for the fork's own engines and for a side with a language", () => {
    for (const party of [
      { ...initialConfig.them, stt_provider: "soniox" as const, language: "auto" },
      { ...initialConfig.them, stt_provider: "openai_compat" as const, language: "auto" },
      { ...initialConfig.them, stt_provider: "groq_whisper" as const, language: "en-US" },
    ]) {
      const view = render(<PartyLanguageField party={party} onChange={() => {}} />);
      expect(screen.queryByText(/Nova-3/)).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      view.unmount();
    }
  });
});

it("names the side whose engine can't detect the language, on that side's card only", async () => {
  // Both sides follow the shared language, which is Auto-detect.
  useConfigStore.setState({
    sttLanguage: "auto",
    meetingAudioConfig: {
      ...initialConfig,
      you: { ...initialConfig.you, stt_provider: "web_speech" },
      them: { ...initialConfig.them, stt_provider: "groq_whisper" },
    },
  });
  const user = userEvent.setup();
  render(<MeetingAudioSettings />);
  expect(side("You")).toHaveValue("Auto-detect");
  // Only the affected side's card carries the explanation.
  const alerts = screen.getAllByRole("alert");
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toHaveTextContent(
    "Auto-detect doesn't work with Web Speech, used for You. " +
    "Choose Deepgram Nova-3, Parakeet TDT 0.6B v3, Groq Whisper or Whisper API for that side, or pick a language."
  );
  // Web Speech can never detect the language, so its picker doesn't offer Auto-detect.
  await user.click(side("You"));
  expect(screen.getByRole("option", { name: /Auto-detect/ })).toHaveAttribute("aria-disabled", "true");
  await user.keyboard("{Escape}");

  await pick(user, "You", "en-US");
  expect(useConfigStore.getState().meetingAudioConfig?.you.language).toBe("en-US");
  // The shared language is not what the picker changes.
  expect(useConfigStore.getState().sttLanguage).toBe("auto");
  expect(screen.queryByRole("alert")).toBeNull();
});

describe.each([
  { surface: "settings", Component: MeetingAudioSettings },
  { surface: "wizard", Component: AudioSetupStep },
])("$surface audio source selection", ({ Component }) => {
  it.each(["you", "them"] as const)("keeps the %s input and output distinct when their names match", async (party) => {
    const user = userEvent.setup();
    const view = render(<Component />);
    const group = await screen.findAllByRole("group", { name: "Speakers / Output" });
    const output = within(group[party === "you" ? 0 : 1]).getByRole<HTMLOptionElement>("option");
    const select = output.closest("select")!;
    await waitFor(() => expect(select).toBeEnabled());

    await user.selectOptions(select, output);
    expect(useConfigStore.getState().meetingAudioConfig?.[party]).toMatchObject({
      device_id: 'Studio: USB "Audio"',
      is_input_device: false,
    });
    expect(output.selected).toBe(true);

    view.unmount();
    render(<Component />);
    const restoredGroups = await screen.findAllByRole("group", { name: "Speakers / Output" });
    const restoredOutput = within(restoredGroups[party === "you" ? 0 : 1]).getByRole<HTMLOptionElement>("option");
    expect(restoredOutput.selected).toBe(true);
    const restoredSelect = restoredOutput.closest("select")!;
    const micGroup = within(restoredSelect).getByRole("group", { name: "Microphones" });
    const input = within(micGroup).getByRole<HTMLOptionElement>("option");
    await waitFor(() => expect(restoredSelect).toBeEnabled());
    await user.selectOptions(restoredSelect, input);
    expect(useConfigStore.getState().meetingAudioConfig?.[party]).toMatchObject({
      device_id: 'Studio: USB "Audio"',
      is_input_device: true,
    });
    expect(input.selected).toBe(true);
  });

  it.each([
    { party: "you" as const, isInput: true },
    { party: "them" as const, isInput: false },
  ])("uses the correct direction for the $party default", async ({ party, isInput }) => {
    const user = userEvent.setup();
    render(<Component />);
    const groups = await screen.findAllByRole("group", { name: "Microphones" });
    const select = groups[party === "you" ? 0 : 1].closest("select")!;
    await waitFor(() => expect(select).toBeEnabled());
    await user.selectOptions(select, select.options[0]);
    expect(useConfigStore.getState().meetingAudioConfig?.[party]).toMatchObject({
      device_id: "default",
      is_input_device: isInput,
    });
    expect(select.options[0].selected).toBe(true);
  });
});

// ── NexQ Plus: engines from providerMeta, per-party language, Soniox translation ──

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edg/120.0";

/** The platform the engine lists are filtered for (read from the user agent at render). */
function stubUserAgent(ua: string) {
  Object.defineProperty(window.navigator, "userAgent", { value: ua, configurable: true });
}

/** Opens the "You" engine picker (both parties start on Deepgram). */
async function openYouPicker(user: ReturnType<typeof userEvent.setup>) {
  const [youTrigger] = await screen.findAllByRole("button", { name: "Deepgram" });
  await user.click(youTrigger);
}

describe("MeetingAudioSettings engines and languages", () => {
  beforeEach(() => {
    stubUserAgent(MAC_UA);
    useConfigStore.setState({ openaiCompatSttConfig: { ...DEFAULT_OPENAI_COMPAT_STT_CONFIG } });
  });
  afterEach(() => {
    delete (window.navigator as { userAgent?: string }).userAgent;
  });

  it("writes the party's own recognition language and keeps the other party's", async () => {
    const user = userEvent.setup();
    useConfigStore.setState({ meetingAudioConfig: { ...initialConfig, preset_name: "All Cloud" } });
    render(<MeetingAudioSettings />);
    const input = await screen.findByRole("combobox", { name: "Recognition language for You" });
    await user.click(input);
    await user.keyboard("ja-JP");
    await user.keyboard("{Enter}");
    const config = useConfigStore.getState().meetingAudioConfig!;
    expect(config.you.language).toBe("ja-JP");
    expect(config.them.language).toBeUndefined();
    // The language isn't part of a preset.
    expect(config.preset_name).toBe("All Cloud");
    expect(screen.getByRole("combobox", { name: "Recognition language for Them" })).toHaveValue("English (US)");
  });

  it("hides Remote Whisper from the picker until a server address is set", async () => {
    const user = userEvent.setup();
    render(<MeetingAudioSettings />);
    await openYouPicker(user);
    expect(screen.getByRole("button", { name: "Web Speech" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remote Whisper" })).toBeNull();

    act(() => {
      useConfigStore.setState({
        openaiCompatSttConfig: { ...DEFAULT_OPENAI_COMPAT_STT_CONFIG, base_url: "http://10.0.0.5:8000/v1" },
      });
    });
    await user.click(screen.getByRole("button", { name: "Remote Whisper" }));
    expect(useConfigStore.getState().meetingAudioConfig?.you.stt_provider).toBe("openai_compat");
  });

  it("offers Windows Speech only on Windows", async () => {
    const user = userEvent.setup();
    const view = render(<MeetingAudioSettings />);
    await openYouPicker(user);
    expect(screen.getByRole("button", { name: "Web Speech" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Windows Speech" })).toBeNull();
    view.unmount();

    stubUserAgent(WINDOWS_UA);
    render(<MeetingAudioSettings />);
    await openYouPicker(user);
    expect(screen.getByRole("button", { name: "Windows Speech" })).toBeInTheDocument();
  });

  it("switches Soniox's own translation between off, one-way and two-way, keeping each mode's fields", async () => {
    const user = userEvent.setup();
    useConfigStore.setState({
      meetingAudioConfig: { ...initialConfig, them: { ...initialConfig.them, stt_provider: "soniox" } },
    });
    render(<MeetingAudioSettings />);
    const native = () => useConfigStore.getState().meetingAudioConfig?.them.native_translation;
    const mode = await screen.findByRole("combobox", { name: "Translate Them with Soniox" });
    expect(screen.queryByRole("combobox", { name: "Translate You with Soniox" })).toBeNull();
    expect(mode).toHaveValue("off");

    await user.selectOptions(mode, "One-way");
    expect(native()).toEqual({ mode: "one_way" });
    expect(screen.getByText("Empty: uses the target language of the Translation settings.")).toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Translate into" }));
    await user.keyboard("ja{Enter}");
    expect(native()).toEqual({ mode: "one_way", target_language: "ja" });

    await user.selectOptions(mode, "Two-way");
    expect(native()).toEqual({ mode: "two_way", target_language: "ja" });
    expect(screen.queryByRole("combobox", { name: "Translate into" })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Pick both languages to turn two-way translation on.");
    await user.click(screen.getByRole("combobox", { name: "Two-way language A for Them" }));
    await user.keyboard("zh-CN{Enter}");
    await user.click(screen.getByRole("combobox", { name: "Two-way language B for Them" }));
    await user.keyboard("zh-TW{Enter}");
    expect(screen.getByRole("status")).toHaveTextContent("Pick two different languages.");
    await user.click(screen.getByRole("combobox", { name: "Two-way language B for Them" }));
    await user.keyboard("en{Enter}");
    expect(native()).toEqual({ mode: "two_way", target_language: "ja", language_a: "zh-CN", language_b: "en" });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText(/any other language is only transcribed/)).toBeInTheDocument();

    // Off and back: nothing is lost on the way.
    await user.selectOptions(mode, "Off");
    expect(native()).toEqual({ mode: "off", target_language: "ja", language_a: "zh-CN", language_b: "en" });
    expect(screen.queryByRole("combobox", { name: "Two-way language A for Them" })).toBeNull();
    await user.selectOptions(mode, "One-way");
    expect(native()).toEqual({ mode: "one_way", target_language: "ja", language_a: "zh-CN", language_b: "en" });
  });
});

describe("sonioxPairProblem", () => {
  it("wants two different languages with two-letter codes", () => {
    expect(sonioxPairProblem("", "en")).toBe("incomplete");
    expect(sonioxPairProblem("zh-CN", "  ")).toBe("incomplete");
    expect(sonioxPairProblem("yue", "en")).toBe("unsupported");
    expect(sonioxPairProblem("zh-CN", "zh-TW")).toBe("same");
    expect(sonioxPairProblem("zh-CN", "en-US")).toBeNull();
  });
});

describe("meeting audio preset prerequisites", () => {
  it("shows missing keys, models and addresses before selection and does not report incomplete setup as success", async () => {
    const user = userEvent.setup();
    useConfigStore.setState({ openaiCompatSttConfig: { ...DEFAULT_OPENAI_COMPAT_STT_CONFIG, base_url: "" } });
    const { useToastStore } = await import("../stores/toastStore");
    useToastStore.setState({ toasts: [] });
    render(<MeetingAudioSettings />);
    const soniox = screen.getByRole("button", { name: "Soniox for Them" });
    await waitFor(() => expect(soniox).toHaveTextContent("Needs Soniox API key"));
    expect(soniox).toHaveTextContent("Download a Whisper.cpp model");
    const remote = screen.getByRole("button", { name: "Self-hosted Whisper" });
    expect(remote).toHaveTextContent("Set the Remote Whisper server URL");
    await user.click(remote);
    expect(useConfigStore.getState().meetingAudioConfig?.you.stt_provider).toBe("openai_compat");
    expect(useToastStore.getState().toasts.slice(-1)[0]).toMatchObject({
      type: "warning",
      message: expect.stringContaining("setup still needed: Set the Remote Whisper server URL"),
    });
  });
});

describe("a language for each side", () => {
  it("starts each side on the shared language for a config saved by an older version, and saves nothing", () => {
    // initialConfig has no `language`, like every config saved before this setting.
    render(<MeetingAudioSettings />);
    for (const name of ["You", "Them"] as const) expect(side(name)).toHaveValue("English (US)");
    // Showing the pickers saved nothing.
    expect(useConfigStore.getState().meetingAudioConfig).toEqual(initialConfig);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a side without a language of its own follows the shared one", async () => {
    useConfigStore.setState({ sttLanguage: "es-ES" });
    render(<MeetingAudioSettings />);
    expect(side("You")).toHaveValue("Spanish");
    await act(async () => useConfigStore.setState({ sttLanguage: "auto" }));
    expect(side("Them")).toHaveValue("Auto-detect");
  });

  it("saves a side's language into meetingAudioConfig and leaves the shared language and the other side alone", async () => {
    const user = userEvent.setup();
    render(<MeetingAudioSettings />);

    await pick(user, "Them", "es-ES");
    const saved = useConfigStore.getState().meetingAudioConfig!;
    expect(saved.them.language).toBe("es-ES");
    expect("language" in saved.you).toBe(false);
    expect(useConfigStore.getState().sttLanguage).toBe("en-US");
    expect(side("Them")).toHaveValue("Spanish");

    // Auto-detect is one of the choices of a side whose engine can detect the language.
    await pick(user, "You", "auto");
    expect(useConfigStore.getState().meetingAudioConfig!.you.language).toBe("auto");
    expect(side("You")).toHaveValue("Auto-detect");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers Ukrainian among the common recognition languages", async () => {
    const user = userEvent.setup();
    render(<MeetingAudioSettings />);
    await user.click(side("Them"));
    await user.click(within(screen.getByRole("group", { name: "Common languages" })).getByRole("option", { name: /Ukrainian/ }));
    expect(useConfigStore.getState().meetingAudioConfig?.them.language).toBe("uk-UA");
    expect(side("Them")).toHaveValue("Ukrainian");
  });

  it("names the room side Room in in-person meetings and has no picker for You", () => {
    useMeetingStore.setState({ audioMode: "in_person" });
    render(<MeetingAudioSettings />);
    expect(side("Room")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Recognition language for You" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Recognition language for Them" })).toBeNull();
  });

  it("names the room in the Auto-detect warning of an in-person meeting, and doesn't judge You", () => {
    useMeetingStore.setState({ audioMode: "in_person" });
    useConfigStore.setState({
      sttLanguage: "auto",
      meetingAudioConfig: {
        ...initialConfig,
        you: { ...initialConfig.you, stt_provider: "web_speech" },
        them: { ...initialConfig.them, stt_provider: "azure_speech" },
      },
    });
    render(<MeetingAudioSettings />);
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent("Auto-detect doesn't work with Azure Speech, used for Room.");
  });

  it("checks Auto-detect with each side's own language", async () => {
    // Shared Auto-detect, but You speaks English: only Them is judged.
    const config: MeetingAudioConfig = {
      ...initialConfig,
      you: { ...initialConfig.you, stt_provider: "web_speech", language: "en-US" },
      them: { ...initialConfig.them, stt_provider: "azure_speech" },
    };
    useConfigStore.setState({ sttLanguage: "auto", meetingAudioConfig: config });
    const user = userEvent.setup();
    render(<MeetingAudioSettings />);
    let alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent("Auto-detect doesn't work with Azure Speech, used for Them.");

    // Them picks a language: nothing left to refuse.
    await pick(user, "Them", "es-ES");
    expect(useConfigStore.getState().meetingAudioConfig?.them.language).toBe("es-ES");
    expect(screen.queryByRole("alert")).toBeNull();

    // A fixed shared language, but You is on Auto-detect with an engine that can't
    // (set elsewhere: this picker doesn't offer Auto-detect for Web Speech).
    await act(async () =>
      useConfigStore.setState({
        sttLanguage: "en-US",
        meetingAudioConfig: { ...config, you: { ...config.you, language: "auto" }, them: { ...config.them, language: "es-ES" } },
      }),
    );
    alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent("Auto-detect doesn't work with Web Speech, used for You.");
  });

  it("uses the side's language for the provider hints", async () => {
    useConfigStore.setState({
      deepgramConfig: { ...useConfigStore.getState().deepgramConfig, model: "flux-general-multi" },
      meetingAudioConfig: {
        ...initialConfig,
        you: { ...initialConfig.you, stt_provider: "cartesia" },
        them: { ...initialConfig.them, stt_provider: "deepgram" },
      },
    });
    const user = userEvent.setup();
    render(<MeetingAudioSettings />);
    expect(screen.queryByRole("alert")).toBeNull();

    // Ukrainian is a problem for Flux on Them only.
    await pick(user, "Them", "uk-UA");
    expect(screen.getByRole("alert")).toHaveTextContent("Switch from Flux to Nova-3 for Ukrainian transcription.");
    await pick(user, "You", "ru-RU");
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    // Said once, in the fork's own wording (it names the languages in the UI language).
    expect(
      screen.getAllByText(/Cartesia transcribes only English, French, Hindi, Japanese,? and Spanish/),
    ).toHaveLength(1);

    // Sides with a language of their own ignore the shared one.
    await pick(user, "You", "es-ES");
    await pick(user, "Them", "en-US");
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => useConfigStore.setState({ sttLanguage: "uk-UA" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the chosen languages when a preset is applied", async () => {
    useConfigStore.setState({
      meetingAudioConfig: {
        ...initialConfig,
        you: { ...initialConfig.you, language: "en-US" },
        them: { ...initialConfig.them, language: "es-ES" },
      },
    });
    const user = userEvent.setup();
    render(<MeetingAudioSettings />);
    await user.click(screen.getByRole("button", { name: "All Cloud" }));
    const saved = useConfigStore.getState().meetingAudioConfig!;
    expect(saved.preset_name).toBe("All Cloud");
    expect([saved.you.language, saved.them.language]).toEqual(["en-US", "es-ES"]);
  });
});
