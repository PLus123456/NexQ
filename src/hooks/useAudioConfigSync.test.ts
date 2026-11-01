import { describe, expect, it } from "vitest";
import type { MeetingAudioConfig, PartyAudioConfig } from "../lib/types";
import { captureKey } from "./useAudioConfigSync";

const config = (them: Partial<PartyAudioConfig>): MeetingAudioConfig => ({
  you: { role: "You", device_id: "default", is_input_device: true, stt_provider: "whisper_cpp", language: "zh-CN" },
  them: { role: "Them", device_id: "default", is_input_device: false, stt_provider: "soniox", language: "auto", ...them },
  recording_enabled: false,
  preset_name: null,
});

describe("captureKey", () => {
  it("changes with the translation target while Soniox follows it", () => {
    const cfg = config({ native_translation: { mode: "one_way" } });
    expect(captureKey(cfg, "zh-CN")).not.toBe(captureKey(cfg, "ja"));
  });

  it("ignores the translation target otherwise", () => {
    const own = config({ native_translation: { mode: "one_way", target_language: "en" } });
    expect(captureKey(own, "zh-CN")).toBe(captureKey(own, "ja"));
    const off = config({ native_translation: { mode: "off" } });
    expect(captureKey(off, "zh-CN")).toBe(captureKey(off, "ja"));
    const deepgram = config({ stt_provider: "deepgram", native_translation: { mode: "one_way" } });
    expect(captureKey(deepgram, "zh-CN")).toBe(captureKey(deepgram, "ja"));
    // The plain config key, as before.
    expect(captureKey(off, "zh-CN")).toBe(JSON.stringify(off));
  });
});
