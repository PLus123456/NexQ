import { describe, expect, it } from "vitest";
import type { MeetingAudioConfig } from "../lib/types";
import { webSpeechLanguage } from "./useSpeechRecognition";

const config = (you: Partial<MeetingAudioConfig["you"]>, them: Partial<MeetingAudioConfig["them"]>): MeetingAudioConfig => ({
  you: { role: "You", device_id: "default", is_input_device: true, stt_provider: "web_speech", ...you },
  them: { role: "Them", device_id: "default", is_input_device: false, stt_provider: "deepgram", ...them },
  recording_enabled: false,
  preset_name: null,
});

describe("Web Speech language", () => {
  it("is the language of the party that uses Web Speech", () => {
    expect(webSpeechLanguage(config({ language: "zh-CN" }, { language: "en-US" }), "fr-FR")).toBe("zh-CN");
    expect(
      webSpeechLanguage(
        config({ stt_provider: "deepgram", language: "zh-CN" }, { stt_provider: "web_speech", is_input_device: true, language: "ja-JP" }),
        "fr-FR",
      ),
    ).toBe("ja-JP");
  });

  it("falls back to the global language, and to the system language for auto", () => {
    expect(webSpeechLanguage(config({}, {}), "de-DE")).toBe("de-DE");
    expect(webSpeechLanguage(null, "de-DE")).toBe("de-DE");
    expect(webSpeechLanguage(config({ language: "auto" }, {}), "de-DE")).toBe(navigator.language || "en-US");
  });
});
