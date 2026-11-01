import { describe, expect, it } from "vitest";
import { UNTESTED_AUDIO_CHECKS, audioStepState, type AudioChecks } from "./audioChecks";

const checks = (mic: AudioChecks["mic"]["state"], system: AudioChecks["system"]["state"]): AudioChecks => ({
  mic: { state: mic },
  system: { state: system },
});

describe("audio step state", () => {
  it("is done only when both the microphone and the system audio were heard", () => {
    expect(audioStepState(checks("ok", "ok"))).toEqual({ status: "ok", problems: [] });
    expect(audioStepState(checks("ok", "untested"))).toEqual({ status: "incomplete", problems: [] });
    expect(audioStepState(UNTESTED_AUDIO_CHECKS)).toEqual({ status: "incomplete", problems: [] });
  });

  it("fails when a test heard nothing or couldn't start, naming which", () => {
    expect(audioStepState(checks("silent", "ok"))).toEqual({ status: "error", problems: ["mic"] });
    expect(audioStepState(checks("ok", "failed"))).toEqual({ status: "error", problems: ["system"] });
    expect(audioStepState(checks("failed", "silent"))).toEqual({ status: "error", problems: ["mic", "system"] });
    expect(audioStepState(checks("untested", "silent"))).toEqual({ status: "error", problems: ["system"] });
  });
});
