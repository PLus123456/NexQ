// The footer's text comes from the llm / common namespaces: the English text is
// the original UI text, and Chinese follows the UI language.

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClaudeCliStatus,
  LLMProviderType,
  LocalSTTEngineInfo,
  MeetingAudioConfig,
  STTProviderType,
} from "../lib/types";

// Whether a region the Soniox settings may use has a key (`soniox_key_status`); null = no answer.
const sonioxKeys = vi.hoisted(() => ({ anyEnabled: null as boolean | null }));

vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
// A backend without the LLM connection commands (the old provider picker shows),
// unless a test puts a view into the connections store itself.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => {
    if (cmd.startsWith("llm_")) throw `command ${cmd} not found`;
    if (cmd === "soniox_key_status" && sonioxKeys.anyEnabled !== null) {
      return JSON.stringify({
        regions: { us: false, eu: false, jp: sonioxKeys.anyEnabled, in: false },
        legacy: false,
        legacy_region: "us",
        any_enabled: sonioxKeys.anyEnabled,
      });
    }
    return null;
  },
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));

const ipc = vi.hoisted(() => ({
  claudeCliStatus: vi.fn(),
  listLocalSTTEngines: vi.fn(),
}));

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  claudeCliStatus: () => ipc.claudeCliStatus(),
  listLocalSTTEngines: () => ipc.listLocalSTTEngines(),
  claudeCliModels: async () => [],
  getAgentSessions: async () => [],
  getApiKey: async () => null,
  hasApiKey: async () => false,
  listModels: async () => [],
}));

import { ServiceStatusBar } from "./ServiceStatusBar";
import { changeUiLanguage } from "../i18n";
import { resetAgentStoreForTests } from "../stores/agentStore";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useSpeakerStore } from "../stores/speakerStore";
import { useStreamStore } from "../stores/streamStore";
import { useSttRegionStore } from "../stores/sttRegionStore";
import { useToastStore } from "../stores/toastStore";
import { useUpdaterStore } from "../stores/updaterStore";
import { resetLlmConnectionsStoreForTests, useLlmConnectionsStore } from "../stores/llmConnectionsStore";
import { emptyView, mockConnection } from "../lib/llm/testing/mockLlmBackend";

const LOGGED_IN: ClaudeCliStatus = {
  installed: true,
  binary_path: "/usr/local/bin/claude",
  version: "2.1.288",
  auth: { logged_in: true, auth_method: "claude.ai", subscription_type: "max", email: "me@example.com", login: "subscription" },
  npm_only: false,
};

const NOT_INSTALLED: ClaudeCliStatus = { installed: false, binary_path: null, version: null, auth: null, npm_only: false };

// A downloaded local engine: what the other party falls back to when an exclusive engine moves.
const SHERPA: LocalSTTEngineInfo = {
  engine: "sherpa_onnx",
  name: "Sherpa-ONNX",
  description: "",
  models: [
    {
      id: "streaming-zipformer-en-20M",
      engine: "sherpa_onnx",
      name: "Zipformer",
      size_bytes: 1,
      accuracy_rating: 3,
      speed_rating: 3,
      is_streaming: true,
      is_downloaded: true,
    },
  ],
};

function audioConfig(you: STTProviderType, them: STTProviderType): MeetingAudioConfig {
  return {
    you: { role: "You", device_id: "default", is_input_device: true, stt_provider: you },
    them: { role: "Them", device_id: "default", is_input_device: false, stt_provider: them },
    recording_enabled: false,
    preset_name: null,
  };
}

beforeEach(() => {
  resetAgentStoreForTests();
  ipc.claudeCliStatus.mockReset().mockResolvedValue(LOGGED_IN);
  ipc.listLocalSTTEngines.mockReset().mockResolvedValue([SHERPA]);
  useConfigStore.setState({
    llmProvider: "ollama",
    llmModel: "llama3.2",
    verifiedCloudProviders: ["ollama", "openai"],
    meetingAudioConfig: audioConfig("web_speech", "deepgram"),
    mutedYou: false,
    mutedThem: false,
  });
  useMeetingStore.setState({ isRecording: false, audioMode: "online" });
  useSpeakerStore.setState({ speakerOrder: [] });
  useStreamStore.setState({ isStreaming: false, currentProvider: "", currentModel: "" });
  useUpdaterStore.getState().reset();
  useToastStore.setState({ toasts: [] });
  resetLlmConnectionsStoreForTests();
  sonioxKeys.anyEnabled = null;
  useSttRegionStore.getState().clear();
});

afterEach(async () => {
  cleanup();
  await changeUiLanguage("en");
});

describe("ServiceStatusBar text", () => {
  it("keeps the original English text", () => {
    useMeetingStore.setState({ isRecording: true });
    render(<ServiceStatusBar />);

    expect(screen.getByTitle("LLM: Ollama / llama3.2")).toBeInTheDocument();
    expect(screen.getByTitle("Your STT: Web Speech")).toBeInTheDocument();
    expect(screen.getByTitle("Their STT: Deepgram")).toBeInTheDocument();
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.getByText("Them")).toBeInTheDocument();

    // A mute button flips between Mute and Unmute.
    fireEvent.click(screen.getByTitle("Mute You"));
    expect(screen.getByTitle("Unmute You")).toBeInTheDocument();
    expect(screen.getByTitle("Mute Them")).toBeInTheDocument();
  });

  it("names the default LLM connection, not its old provider type", () => {
    const deepseek = mockConnection({ id: "c_1", name: "DeepSeek", base_url: "https://api.deepseek.com/v1", default_model: "deepseek-chat" });
    useLlmConnectionsStore.getState().applyView(
      emptyView({ revision: 5, connections: [deepseek], routing: { default: { target: { connection_id: "c_1", model: null }, params: {} }, tasks: {} } }),
    );
    render(<ServiceStatusBar />);
    expect(screen.getByTitle("LLM: DeepSeek / deepseek-chat")).toBeInTheDocument();

    // With connections, the chip opens the connection picker instead of the provider list.
    fireEvent.click(screen.getByTitle("LLM: DeepSeek / deepseek-chat"));
    expect(screen.getByRole("dialog", { name: "Switch the AI model" })).toBeInTheDocument();
  });

  it("names the room and counts the speakers in in-person mode", () => {
    useMeetingStore.setState({ audioMode: "in_person" });
    useSpeakerStore.setState({ speakerOrder: ["a"] });
    const { rerender } = render(<ServiceStatusBar />);
    expect(screen.getByText("Room")).toBeInTheDocument(); // the chip shows it in capitals
    expect(screen.getByTitle("Room STT: Deepgram")).toBeInTheDocument();
    expect(screen.getByText("1 speaker detected")).toBeInTheDocument();

    useSpeakerStore.setState({ speakerOrder: ["a", "b"] });
    rerender(<ServiceStatusBar />);
    expect(screen.getByText("2 speakers detected")).toBeInTheDocument();
  });

  it("is translated in Chinese", async () => {
    await changeUiLanguage("zh-CN");
    useMeetingStore.setState({ isRecording: true });
    render(<ServiceStatusBar />);

    expect(screen.getByTitle("AI 模型：Ollama / llama3.2")).toBeInTheDocument();
    expect(screen.getByTitle("我的语音识别：Web Speech")).toBeInTheDocument();
    expect(screen.getByTitle("对方的语音识别：Deepgram")).toBeInTheDocument();
    expect(screen.getByText("我")).toBeInTheDocument();
    expect(screen.getByText("对方")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("静音对方的声音"));
    expect(screen.getByTitle("取消静音对方的声音")).toBeInTheDocument();
    expect(screen.getByTitle("静音我的声音")).toBeInTheDocument();
  });

  it("is translated in Chinese in in-person mode", async () => {
    await changeUiLanguage("zh-CN");
    useMeetingStore.setState({ audioMode: "in_person" });
    useSpeakerStore.setState({ speakerOrder: ["a", "b", "c"] });
    render(<ServiceStatusBar />);

    expect(screen.getByText("现场")).toBeInTheDocument();
    expect(screen.getByTitle("现场语音识别：Deepgram")).toBeInTheDocument();
    expect(screen.getByText("检测到 3 位说话人")).toBeInTheDocument();
  });

  it("names the Soniox region a party is connected to in its chip's tooltip", async () => {
    useConfigStore.setState({ meetingAudioConfig: audioConfig("web_speech", "soniox") });
    useSttRegionStore.getState().setRegion("Them", "jp");
    useSttRegionStore.getState().setRegion("You", "us"); // not Soniox: nothing to name
    const { unmount } = render(<ServiceStatusBar />);
    expect(screen.getByTitle("Their STT: Soniox · Japan")).toBeInTheDocument();
    expect(screen.getByTitle("Your STT: Web Speech")).toBeInTheDocument();
    unmount();

    await changeUiLanguage("zh-CN");
    render(<ServiceStatusBar />);
    expect(screen.getByTitle("对方的语音识别：Soniox · 日本")).toBeInTheDocument();
  });

  it("translates the Custom provider, not product names", async () => {
    useConfigStore.setState({ llmProvider: "custom", llmModel: "my-model" });
    const { unmount } = render(<ServiceStatusBar />);
    expect(screen.getByTitle("LLM: Custom / my-model")).toBeInTheDocument();
    unmount();

    await changeUiLanguage("zh-CN");
    render(<ServiceStatusBar />);
    expect(screen.getByTitle("AI 模型：自定义 / my-model")).toBeInTheDocument();
  });

  it("shows the update pill with the app name", async () => {
    useUpdaterStore.setState({ phase: "ready", version: "2.30.0" });
    const { unmount } = render(<ServiceStatusBar />);
    expect(screen.getByTitle("Restart NexQ Plus to install v2.30.0")).toBeInTheDocument();
    expect(screen.getByText("Update ready · v2.30.0")).toBeInTheDocument();
    expect(screen.getByText("Restart")).toBeInTheDocument();
    unmount();

    await changeUiLanguage("zh-CN");
    render(<ServiceStatusBar />);
    expect(screen.getByTitle("重启 NexQ Plus 以安装 v2.30.0")).toBeInTheDocument();
    expect(screen.getByText("更新已就绪 · v2.30.0")).toBeInTheDocument();
    expect(screen.getByText("重启")).toBeInTheDocument();
  });
});

describe("LLM picker text", () => {
  /** Opens the picker and waits for the model list to finish loading (empty here). */
  async function openPicker(chipTitle: string) {
    fireEvent.click(screen.getByTitle(chipTitle));
    return screen.findByText(/^(No models available|没有可用的模型)$/);
  }

  it("keeps the original English text", async () => {
    render(<ServiceStatusBar />);
    await openPicker("LLM: Ollama / llama3.2");

    expect(screen.getByText("Local")).toBeInTheDocument();
    expect(screen.getByText("Cloud")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByText("Model — Ollama")).toBeInTheDocument();
    // Claude is logged in, so its subscription group is offered.
    expect(await screen.findByText("Subscription")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Claude" }));
    expect(screen.getByText("Use Claude")).toBeInTheDocument();
    expect(screen.getByText(/^Fast .+, Deep /)).toBeInTheDocument();
  });

  it("is translated in Chinese", async () => {
    await changeUiLanguage("zh-CN");
    render(<ServiceStatusBar />);
    await openPicker("AI 模型：Ollama / llama3.2");

    expect(screen.getByText("本地")).toBeInTheDocument();
    expect(screen.getByText("云端")).toBeInTheDocument();
    expect(screen.getByText("使用中")).toBeInTheDocument();
    expect(screen.getByText("模型：Ollama")).toBeInTheDocument();
    expect(await screen.findByText("订阅")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Claude" }));
    expect(screen.getByText("使用 Claude")).toBeInTheDocument();
    expect(screen.getByText(/^快速 .+，深度 /)).toBeInTheDocument();
  });

  it("says when there is no verified provider", async () => {
    // Not a known provider, Claude not logged in: nothing to list.
    useConfigStore.setState({ llmProvider: "unset" as LLMProviderType, llmModel: "", verifiedCloudProviders: [] });
    ipc.claudeCliStatus.mockResolvedValue(NOT_INSTALLED);
    const { unmount } = render(<ServiceStatusBar />);
    await openPicker("LLM: unset / —");
    expect(screen.getByText("No verified providers — test connection in Settings first")).toBeInTheDocument();
    expect(screen.queryByText("Subscription")).not.toBeInTheDocument();
    unmount();

    await changeUiLanguage("zh-CN");
    render(<ServiceStatusBar />);
    await openPicker("AI 模型：unset / —");
    expect(screen.getByText("还没有验证通过的服务商，请先到设置里测试连接")).toBeInTheDocument();
  });
});

describe("STT picker keys", () => {
  beforeEach(() => {
    useConfigStore.setState({ meetingAudioConfig: audioConfig("web_speech", "deepgram") });
    useMeetingStore.setState({ isRecording: true });
  });

  it("offers Soniox once a region its settings may use has a key", async () => {
    sonioxKeys.anyEnabled = true;
    render(<ServiceStatusBar />);
    fireEvent.click(screen.getByTitle("Their STT: Deepgram"));
    expect(await screen.findByRole("button", { name: "Soniox" })).toBeInTheDocument();
  });

  it("leaves Soniox out when none of those regions has a key", async () => {
    sonioxKeys.anyEnabled = false;
    render(<ServiceStatusBar />);
    fireEvent.click(screen.getByTitle("Their STT: Deepgram"));
    expect(await screen.findByRole("button", { name: /^Sherpa-ONNX/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Soniox" })).toBeNull();
  });
});

describe("STT picker text", () => {
  // You: Web Speech, Them: Windows Speech. Both can only run on one source, so
  // the You picker locks them and offers the hand-over.
  beforeEach(() => {
    useConfigStore.setState({ meetingAudioConfig: audioConfig("web_speech", "windows_native") });
    useMeetingStore.setState({ isRecording: true });
  });

  async function openYouPicker(chipTitle: string) {
    fireEvent.click(screen.getByTitle(chipTitle));
    await waitFor(() => expect(screen.getAllByText(/^(In use by Them|对方正在使用)$/)).toHaveLength(2));
  }

  it("keeps the original English text", async () => {
    render(<ServiceStatusBar />);
    await openYouPicker("Your STT: Web Speech");
    expect(screen.getByText("Local & Built-in")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Windows Speech/ }));
    const prompt = screen.getByText(/can only run on one source at a time/);
    expect(prompt).toHaveTextContent(
      "Windows Speech can only run on one source at a time. Switch to this party? The other party will fall back to Sherpa-ONNX.",
    );
    expect(within(prompt).getByText("Windows Speech")).toHaveClass("font-semibold");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Switch" }));
    await waitFor(() =>
      expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
        "Windows Speech moved to You. Them fell back to Sherpa-ONNX.",
      ]),
    );
    expect(useConfigStore.getState().meetingAudioConfig?.you.stt_provider).toBe("windows_native");
    expect(useConfigStore.getState().meetingAudioConfig?.them.stt_provider).toBe("sherpa_onnx");
  });

  it("is translated in Chinese", async () => {
    await changeUiLanguage("zh-CN");
    render(<ServiceStatusBar />);
    await openYouPicker("我的语音识别：Web Speech");
    expect(screen.getByText("本地与内置")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Windows Speech/ }));
    const prompt = screen.getByText(/同一时间只能用于一个音频来源/);
    expect(prompt).toHaveTextContent(
      "Windows Speech 同一时间只能用于一个音频来源。要改由这一方使用吗？另一方将改用 Sherpa-ONNX。",
    );
    expect(within(prompt).getByText("Sherpa-ONNX")).toHaveClass("font-medium");
    expect(screen.getByRole("button", { name: "取消" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "切换" }));
    await waitFor(() =>
      expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
        "Windows Speech 已改由“我”使用，“对方”已自动改用 Sherpa-ONNX。",
      ]),
    );
  });

  it("explains that no fallback engine is available", async () => {
    ipc.listLocalSTTEngines.mockResolvedValue([]); // nothing downloaded, no API keys
    render(<ServiceStatusBar />);
    await openYouPicker("Your STT: Web Speech");

    fireEvent.click(screen.getByRole("button", { name: /^Windows Speech/ }));
    expect(screen.getByText(/can only run on one source at a time/)).toHaveTextContent(
      "Windows Speech can only run on one source at a time. Switch to this party? The other party will fall back to no available engine.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Switch" }));
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
      "No fallback STT engine available. Configure an API key or download a local model first.",
    ]);
  });

  it("explains that no fallback engine is available, in Chinese", async () => {
    await changeUiLanguage("zh-CN");
    ipc.listLocalSTTEngines.mockResolvedValue([]);
    render(<ServiceStatusBar />);
    await openYouPicker("我的语音识别：Web Speech");

    fireEvent.click(screen.getByRole("button", { name: /^Windows Speech/ }));
    expect(screen.getByText(/同一时间只能用于一个音频来源/)).toHaveTextContent(
      "Windows Speech 同一时间只能用于一个音频来源。要改由这一方使用吗？另一方目前没有可用的引擎可改用。",
    );
    fireEvent.click(screen.getByRole("button", { name: "切换" }));
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
      "没有可用的备用语音识别引擎，请先配置 API Key 或下载本地模型。",
    ]);
  });
});
