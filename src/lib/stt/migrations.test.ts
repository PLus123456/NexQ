import { describe, expect, it } from "vitest";
import type { MeetingAudioConfig } from "../types";
import { defaultMeetingAudioConfig, migrateSttConfig, type SttMigrationInput } from "./migrations";

const base = (over: Partial<SttMigrationInput> = {}): SttMigrationInput => ({
  meetingAudioConfig: null,
  sttProvider: undefined,
  sttLanguage: undefined,
  platform: "macos",
  ...over,
});

const saved = (you: Partial<MeetingAudioConfig["you"]>, them: Partial<MeetingAudioConfig["them"]>): MeetingAudioConfig => ({
  you: { role: "You", device_id: "mic", is_input_device: true, stt_provider: "web_speech", ...you },
  them: { role: "Them", device_id: "out", is_input_device: false, stt_provider: "deepgram", ...them },
  recording_enabled: true,
  preset_name: "Mine",
});

/** Running the migration on its own output changes nothing (two windows run it). */
function expectIdempotent(input: SttMigrationInput) {
  const first = migrateSttConfig(input);
  const second = migrateSttConfig({ ...input, meetingAudioConfig: first.meetingAudioConfig, sttProvider: first.sttProvider });
  expect(second.changed).toEqual({ meetingAudioConfig: false, sttProvider: false });
  expect(second.meetingAudioConfig).toEqual(first.meetingAudioConfig);
  return first;
}

describe("STT config migration", () => {
  it("fresh install: defaults per platform, with the global language on both parties", () => {
    const mac = expectIdempotent(base());
    expect(mac.meetingAudioConfig).toEqual(defaultMeetingAudioConfig("macos", "en-US"));
    expect(mac.meetingAudioConfig.you.stt_provider).toBe("web_speech");
    expect(mac.meetingAudioConfig.them.stt_provider).toBe("whisper_cpp");
    expect(mac.sttProvider).toBe("web_speech");
    expect(mac.changed).toEqual({ meetingAudioConfig: true, sttProvider: true });

    const win = migrateSttConfig(base({ platform: "windows", sttLanguage: "de-DE" }));
    expect(win.meetingAudioConfig.them.stt_provider).toBe("deepgram");
    expect(win.meetingAudioConfig.them.language).toBe("de-DE");
    expect(win.sttProvider).toBe("windows_native");
  });

  it("legacy devices: builds the per-party config from them", () => {
    const r = expectIdempotent(base({ micDeviceId: "usb-mic", systemDeviceId: null, recordingEnabled: true, sttLanguage: "zh-CN" }));
    expect(r.meetingAudioConfig.you).toMatchObject({ device_id: "usb-mic", stt_provider: "web_speech", language: "zh-CN" });
    expect(r.meetingAudioConfig.them).toMatchObject({ device_id: "default", language: "zh-CN" });
    expect(r.meetingAudioConfig.recording_enabled).toBe(true);
  });

  it("keeps Whisper.cpp: it is a live engine now (no more silent switch to Deepgram)", () => {
    const cfg = saved({ stt_provider: "whisper_cpp", local_model_id: "small", language: "en-US" },
      { stt_provider: "whisper_cpp", local_model_id: "base", language: "en-US" });
    const r = expectIdempotent(base({ meetingAudioConfig: cfg, sttProvider: "whisper_cpp" }));
    expect(r.changed).toEqual({ meetingAudioConfig: false, sttProvider: false });
    expect(r.meetingAudioConfig).toBe(cfg);
    expect(r.sttProvider).toBe("whisper_cpp");
  });

  it("incomplete old config: fills in each party's language from the global one", () => {
    const cfg = saved({}, {});
    const r = expectIdempotent(base({ meetingAudioConfig: cfg, sttProvider: "web_speech", sttLanguage: "ja-JP" }));
    expect(r.meetingAudioConfig.you.language).toBe("ja-JP");
    expect(r.meetingAudioConfig.them.language).toBe("ja-JP");
    expect(r.meetingAudioConfig.preset_name).toBe("Mine");
    expect(r.changed.sttProvider).toBe(false);
    // The input object isn't modified.
    expect(cfg.you.language).toBeUndefined();
  });

  it("already migrated: a party's own language (auto included) is kept", () => {
    const cfg = saved({ language: "zh-CN" }, { language: "auto" });
    const r = migrateSttConfig(base({ meetingAudioConfig: cfg, sttProvider: "web_speech", sttLanguage: "en-US" }));
    expect(r.changed).toEqual({ meetingAudioConfig: false, sttProvider: false });
    expect(r.meetingAudioConfig.them.language).toBe("auto");
  });

  it("macOS: moves Windows Speech away (You → Web Speech, Them → Whisper.cpp)", () => {
    const cfg = saved({ stt_provider: "windows_native", language: "en-US" }, { stt_provider: "windows_native", is_input_device: true, language: "en-US" });
    const r = expectIdempotent(base({ meetingAudioConfig: cfg, sttProvider: "windows_native" }));
    expect(r.meetingAudioConfig.you.stt_provider).toBe("web_speech");
    expect(r.meetingAudioConfig.them.stt_provider).toBe("whisper_cpp");
    expect(r.sttProvider).toBe("web_speech");
  });

  it("Windows: Windows Speech stays on the mic but not on system audio", () => {
    const cfg = saved({ stt_provider: "windows_native", language: "en-US" }, { stt_provider: "windows_native", language: "en-US" });
    const r = expectIdempotent(base({ meetingAudioConfig: cfg, sttProvider: "windows_native", platform: "windows" }));
    expect(r.meetingAudioConfig.you.stt_provider).toBe("windows_native");
    expect(r.meetingAudioConfig.them.stt_provider).toBe("deepgram");
    expect(r.sttProvider).toBe("windows_native");
  });

  it("two exclusive engines: You keeps its engine, Them falls back", () => {
    const cfg = saved({ stt_provider: "web_speech", language: "en-US" }, { stt_provider: "web_speech", is_input_device: true, language: "en-US" });
    const r = expectIdempotent(base({ meetingAudioConfig: cfg, sttProvider: "web_speech" }));
    expect(r.meetingAudioConfig.you.stt_provider).toBe("web_speech");
    expect(r.meetingAudioConfig.them.stt_provider).toBe("whisper_cpp");
  });
});
