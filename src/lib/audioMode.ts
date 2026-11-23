import type { AudioMode, PartyAudioConfig } from "./types";

/**
 * Whether a meeting starts no "You" transcriber. In-person meetings transcribe
 * everyone through the room mic ("Them"); "You" is muted and its lines are
 * discarded, so its provider would only cost credits or CPU.
 */
export function skipYouStt(mode: AudioMode): boolean {
  return mode === "in_person";
}

/**
 * The two sides a meeting captures. Online, as configured. In person everyone
 * comes in through the room side ("Them"); when that side is set to the
 * speaker output (right for online calls, silent in a room), the room listens
 * on "You"'s microphone instead, so the same settings work for both kinds of
 * meeting.
 */
export function captureParties(
  you: PartyAudioConfig,
  them: PartyAudioConfig,
  mode: AudioMode,
): { you: PartyAudioConfig; them: PartyAudioConfig } {
  if (mode !== "in_person" || them.is_input_device || !you.is_input_device) return { you, them };
  return { you, them: { ...them, device_id: you.device_id, is_input_device: true } };
}
