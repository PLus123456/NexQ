import { describe, expect, it } from "vitest";
import type { AudioDevice, MeetingAudioConfig } from "../lib/types";
import { BUILT_IN_PRESETS, applyPreset } from "./presets";

const devices: AudioDevice[] = [
  { id: "mic-1", name: "MacBook Mic", is_input: true, is_default: true },
  { id: "mic-2", name: "USB Mic", is_input: true, is_default: false },
  { id: "out-1", name: "Speakers", is_input: false, is_default: true },
];

const preset = (id: string) => {
  const found = BUILT_IN_PRESETS.find((p) => p.id === id);
  if (!found) throw new Error(`no preset ${id}`);
  return found;
};

const current: MeetingAudioConfig = {
  you: { role: "You", device_id: "mic-2", is_input_device: true, stt_provider: "deepgram", language: "zh-CN" },
  them: {
    role: "Them", device_id: "out-1", is_input_device: false, stt_provider: "deepgram", language: "auto",
    native_translation: { mode: "off", target_language: "ja" },
  },
  recording_enabled: true,
  preset_name: null,
  audio_mode: "online",
};

describe("presets", () => {
  it("have unique ids", () => {
    const ids = BUILT_IN_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("resolve devices and engines", () => {
    const cfg = applyPreset(preset("free"), devices);
    expect(cfg.you).toMatchObject({ device_id: "mic-1", is_input_device: true, stt_provider: "web_speech" });
    expect(cfg.them).toMatchObject({ device_id: "out-1", is_input_device: false, stt_provider: "parakeet_tdt" });
    expect(cfg.preset_name).toBe("Free");
    expect(cfg.recording_enabled).toBe(false);
  });

  it("keep each party's language, the recording switch and the meeting mode", () => {
    const cfg = applyPreset(preset("local_whisper"), devices, current);
    expect(cfg.you.language).toBe("zh-CN");
    expect(cfg.them.language).toBe("auto");
    expect(cfg.recording_enabled).toBe(true);
    expect(cfg.audio_mode).toBe("online");
    // A preset without translation keeps the party's translation settings.
    expect(cfg.them.native_translation).toEqual({ mode: "off", target_language: "ja" });
  });

  it("Soniox for Them: Soniox translates the other side, Whisper.cpp for you", () => {
    const cfg = applyPreset(preset("soniox_them"), devices, current);
    expect(cfg.you.stt_provider).toBe("whisper_cpp");
    expect(cfg.them.stt_provider).toBe("soniox");
    // The mode comes from the preset, the chosen target language stays.
    expect(cfg.them.native_translation).toEqual({ mode: "one_way", target_language: "ja" });
    expect(cfg.you.native_translation).toBeUndefined();
    const fresh = applyPreset(preset("soniox_them"), devices);
    expect(fresh.them.native_translation).toEqual({ mode: "one_way" });
    expect(fresh.them.language).toBeUndefined();
  });
});
