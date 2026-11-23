import { describe, expect, it } from "vitest";
import { captureParties, skipYouStt } from "./audioMode";
import type { PartyAudioConfig } from "./types";

describe("skipYouStt", () => {
  it("skips the You transcriber only in in-person meetings, where the room mic is Them", () => {
    expect(skipYouStt("in_person")).toBe(true);
    expect(skipYouStt("online")).toBe(false);
  });
});

describe("captureParties", () => {
  const you = { role: "You", device_id: "MacBook mic", is_input_device: true, stt_provider: "soniox" } as PartyAudioConfig;
  const speakers = { role: "Them", device_id: "MacBook speakers", is_input_device: false, stt_provider: "soniox", language: "en-US" } as PartyAudioConfig;

  it("online meetings capture the sides as configured", () => {
    expect(captureParties(you, speakers, "online")).toEqual({ you, them: speakers });
  });

  it("in person, a room side set to the speakers listens on the microphone, keeping its own engine and language", () => {
    const { them } = captureParties(you, speakers, "in_person");
    expect(them).toEqual({ ...speakers, device_id: "MacBook mic", is_input_device: true });
  });

  it("in person, a room side already on a microphone is kept", () => {
    const roomMic = { ...speakers, device_id: "USB mic", is_input_device: true };
    expect(captureParties(you, roomMic, "in_person").them).toBe(roomMic);
  });
});
