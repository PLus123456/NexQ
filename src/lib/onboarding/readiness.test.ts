import { describe, expect, it } from "vitest";
import type { PartyAudioConfig, STTProviderType } from "../types";
import { canStartMeeting, checkParty, checkSttReadiness, type ReadinessContext } from "./readiness";

function party(stt_provider: string, extra: Partial<PartyAudioConfig> = {}): PartyAudioConfig {
  return { role: "You", device_id: "default", is_input_device: true, stt_provider: stt_provider as STTProviderType, ...extra };
}

function context(overrides: Partial<ReadinessContext> = {}): ReadinessContext {
  return {
    platform: "macos",
    hasKey: async () => false,
    downloadedModels: async () => [],
    activeModelPerEngine: {},
    activeWhisperModel: null,
    ...overrides,
  };
}

describe("speech recognition readiness", () => {
  it("a built-in engine on its platform is ready", async () => {
    expect(await checkParty(party("web_speech"), context())).toBe("ready");
  });

  it("an engine that doesn't run here is unsupported", async () => {
    expect(await checkParty(party("windows_native"), context({ platform: "macos" }))).toBe("unsupported");
    expect(await checkParty(party("windows_native"), context({ platform: "windows" }))).toBe("ready");
  });

  it("a microphone-only engine on an output device can't hear anything", async () => {
    expect(await checkParty(party("web_speech", { is_input_device: false }), context())).toBe("input_only");
  });

  it("a remote engine needs its server address", async () => {
    const remote = party("openai_compat");
    expect(await checkParty(remote, context({ hasBaseUrl: () => false }))).toBe("needs_address");
    expect(await checkParty(remote, context({ hasBaseUrl: () => true }))).toBe("ready");
  });

  it("a cloud engine needs its key, looked up under the engine id", async () => {
    const asked: string[] = [];
    const hasKey = async (slot: string) => {
      asked.push(slot);
      return slot === "deepgram";
    };
    expect(await checkParty(party("deepgram"), context({ hasKey }))).toBe("ready");
    expect(await checkParty(party("groq_whisper"), context({ hasKey }))).toBe("needs_key");
    expect(asked).toEqual(["deepgram", "groq_whisper"]);
  });

  it("a local engine needs the party's model downloaded (or any model when none is chosen)", async () => {
    const downloadedModels = async (engine: string) => (engine === "sherpa_onnx" ? ["streaming-zipformer-en-20M"] : []);
    expect(await checkParty(party("sherpa_onnx"), context({ downloadedModels }))).toBe("ready");
    expect(await checkParty(party("sherpa_onnx", { local_model_id: "other-model" }), context({ downloadedModels }))).toBe("needs_model");
    expect(await checkParty(party("parakeet_tdt"), context({ downloadedModels }))).toBe("needs_model");

    const whisper = context({ downloadedModels: async () => ["base"], activeWhisperModel: "base" });
    expect(await checkParty(party("whisper_cpp"), whisper)).toBe("ready");
    expect(await checkParty(party("whisper_cpp"), { ...whisper, activeWhisperModel: "large-v3" })).toBe("needs_model");
  });

  it("doesn't hold what it can't check against the engine", async () => {
    expect(await checkParty(party("some_new_engine"), context())).toBe("unknown");
    expect(await checkParty(party("parakeet_tdt"), context({ downloadedModels: async () => undefined }))).toBe("unknown");
    const broken = context({ hasKey: async () => Promise.reject(new Error("keychain locked")) });
    expect(await checkParty(party("deepgram"), broken)).toBe("unknown");
  });

  it("a meeting can start when at least one party can run", async () => {
    const config = {
      you: party("web_speech"),
      them: party("deepgram", { role: "Them", is_input_device: false }),
      recording_enabled: false,
      preset_name: null,
    };
    const readiness = await checkSttReadiness(config, context());
    expect(readiness).toEqual({ you: "ready", them: "needs_key" });
    expect(canStartMeeting(readiness)).toBe(true);
    expect(canStartMeeting({ you: "needs_model", them: "needs_key" })).toBe(false);
    expect(canStartMeeting({ you: "unsupported", them: "unknown" })).toBe(true);
    expect(await checkSttReadiness(null, context())).toEqual({ you: "unknown", them: "unknown" });
  });
});
