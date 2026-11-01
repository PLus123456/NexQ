// The audio step's two checks: the microphone ("you") and the system audio
// ("them"). The step is done when both were heard.

import type { QuickSetupStatus } from "../../settings/quickSetup";

export type AudioCheckKind = "mic" | "system";

export interface AudioCheck {
  /** "silent": the test ran and heard nothing; "failed": it couldn't start. */
  state: "untested" | "ok" | "silent" | "failed";
  /** Why it couldn't start (state "failed"). */
  error?: string;
}

export type AudioChecks = Record<AudioCheckKind, AudioCheck>;

export const AUDIO_CHECK_KINDS: readonly AudioCheckKind[] = ["mic", "system"];

export const UNTESTED_AUDIO_CHECKS: AudioChecks = { mic: { state: "untested" }, system: { state: "untested" } };

/** The step's state, and the checks that heard nothing or couldn't run. */
export function audioStepState(checks: AudioChecks): { status: QuickSetupStatus; problems: AudioCheckKind[] } {
  const problems = AUDIO_CHECK_KINDS.filter((kind) => checks[kind].state === "silent" || checks[kind].state === "failed");
  if (problems.length > 0) return { status: "error", problems };
  const done = AUDIO_CHECK_KINDS.every((kind) => checks[kind].state === "ok");
  return { status: done ? "ok" : "incomplete", problems };
}
