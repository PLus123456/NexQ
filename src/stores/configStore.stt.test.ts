// NexQ Plus STT settings in configStore: first-load migrations through
// loadConfig, the remote STT / Soniox / GPU settings pushed to the backend,
// and both windows (launcher + overlay) following each other's changes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingAudioConfig } from "../lib/types";
import { DEFAULT_SONIOX_CONFIG } from "../lib/stt/types";

const saved = vi.hoisted(() => new Map<string, unknown>());
const keyListeners = vi.hoisted(() => [] as Array<{ key: string; cb: (v: unknown) => void }>);
const invoke = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null));

vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    get: async (key: string) => structuredClone(saved.get(key)),
    set: async (key: string, value: unknown) => {
      saved.set(key, structuredClone(value));
      for (const l of keyListeners) if (l.key === key) l.cb(structuredClone(value));
    },
    onKeyChange: async (key: string, cb: (v: unknown) => void) => {
      keyListeners.push({ key, cb });
      return () => {};
    },
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));

/** A window: a fresh module graph (own Zustand store) that has loaded its config. */
async function openWindow() {
  vi.resetModules();
  const { useConfigStore } = await import("./configStore");
  await useConfigStore.getState().loadConfig();
  return useConfigStore;
}

function calls(cmd: string) {
  return invoke.mock.calls.filter(([c]) => c === cmd).map(([, args]) => args as Record<string, unknown>);
}

const userAgent = Object.getOwnPropertyDescriptor(window.navigator, "userAgent");
function onMac() {
  Object.defineProperty(window.navigator, "userAgent", {
    configurable: true,
    get: () => "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
  });
}

describe("configStore: STT migrations and NexQ Plus engine settings", () => {
  beforeEach(() => {
    saved.clear();
    keyListeners.length = 0;
    invoke.mockClear();
    vi.spyOn(console, "log").mockImplementation(() => {});
    onMac();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (userAgent) Object.defineProperty(window.navigator, "userAgent", userAgent);
    else delete (window.navigator as { userAgent?: string }).userAgent;
  });

  it("fresh install on macOS: Web Speech for you, Whisper.cpp for them, languages set, saved once", async () => {
    const launcher = await openWindow();
    const cfg = launcher.getState().meetingAudioConfig!;
    expect(cfg.you).toMatchObject({ stt_provider: "web_speech", language: "en-US" });
    expect(cfg.them).toMatchObject({ stt_provider: "whisper_cpp", language: "en-US" });
    expect(saved.get("meetingAudioConfig")).toEqual(cfg);
    expect(launcher.getState().sttProvider).toBe("web_speech");

    // The overlay window runs the same migration on what was saved: nothing changes.
    const before = JSON.stringify(saved.get("meetingAudioConfig"));
    const overlay = await openWindow();
    expect(JSON.stringify(saved.get("meetingAudioConfig"))).toBe(before);
    expect(overlay.getState().meetingAudioConfig).toEqual(cfg);
  });

  it("keeps a saved Whisper.cpp party and gives each party the saved global language", async () => {
    const old: MeetingAudioConfig = {
      you: { role: "You", device_id: "default", is_input_device: true, stt_provider: "whisper_cpp", local_model_id: "small" },
      them: { role: "Them", device_id: "default", is_input_device: false, stt_provider: "whisper_cpp", local_model_id: "base" },
      recording_enabled: false,
      preset_name: null,
    };
    saved.set("meetingAudioConfig", old);
    saved.set("sttProvider", "whisper_cpp");
    saved.set("sttLanguage", "zh-CN");
    const store = await openWindow();
    const cfg = store.getState().meetingAudioConfig!;
    expect(cfg.you).toMatchObject({ stt_provider: "whisper_cpp", local_model_id: "small", language: "zh-CN" });
    expect(cfg.them).toMatchObject({ stt_provider: "whisper_cpp", local_model_id: "base", language: "zh-CN" });
    expect(store.getState().sttProvider).toBe("whisper_cpp");
    expect(saved.get("sttProvider")).toBe("whisper_cpp");
  });

  it("macOS: a saved Windows Speech party moves to Web Speech", async () => {
    saved.set("meetingAudioConfig", {
      you: { role: "You", device_id: "default", is_input_device: true, stt_provider: "windows_native", language: "en-US" },
      them: { role: "Them", device_id: "default", is_input_device: false, stt_provider: "deepgram", language: "auto" },
      recording_enabled: false,
      preset_name: null,
    });
    const store = await openWindow();
    expect(store.getState().meetingAudioConfig!.you.stt_provider).toBe("web_speech");
    expect(store.getState().meetingAudioConfig!.them).toMatchObject({ stt_provider: "deepgram", language: "auto" });
  });

  it("pushes the remote STT, Soniox and GPU settings on load and on change", async () => {
    saved.set("sonioxConfig", { region: "eu" });
    saved.set("whisperUseGpu", false);
    const store = await openWindow();
    // Saved fields over the defaults.
    expect(store.getState().sonioxConfig).toEqual({ ...DEFAULT_SONIOX_CONFIG, region: "eu" });
    const pushed = (cmd: string) => calls(cmd).map((args) => JSON.parse(args.configJson as string));
    await vi.waitFor(() => expect(pushed("update_soniox_config")).toContainEqual(expect.objectContaining({ region: "eu" })));
    await vi.waitFor(() => expect(calls("update_openai_compat_stt_config").length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(calls("set_whisper_use_gpu")).toContainEqual({ enabled: false }));

    store.getState().setOpenAICompatSttConfig({ ...store.getState().openaiCompatSttConfig, base_url: "http://10.0.0.5:8000/v1" });
    await vi.waitFor(() =>
      expect(pushed("update_openai_compat_stt_config")).toContainEqual(
        expect.objectContaining({ base_url: "http://10.0.0.5:8000/v1" }),
      ),
    );
    expect((saved.get("openaiCompatSttConfig") as { base_url: string }).base_url).toBe("http://10.0.0.5:8000/v1");
  });

  it("a change in one window reaches the other", async () => {
    const launcher = await openWindow();
    const overlay = await openWindow();

    launcher.getState().setSonioxConfig({ ...launcher.getState().sonioxConfig, model: "stt-rt-v6", region: "jp" });
    launcher.getState().setOpenAICompatSttConfig({ ...launcher.getState().openaiCompatSttConfig, model: "large-v3" });
    launcher.getState().setWhisperUseGpu(false);

    await vi.waitFor(() => expect(overlay.getState().sonioxConfig).toMatchObject({ model: "stt-rt-v6", region: "jp" }));
    await vi.waitFor(() => expect(overlay.getState().openaiCompatSttConfig.model).toBe("large-v3"));
    await vi.waitFor(() => expect(overlay.getState().whisperUseGpu).toBe(false));
  });
});
