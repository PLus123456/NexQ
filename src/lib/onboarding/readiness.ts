// Before the first meeting: can each party's speech recognition run as it is
// configured? A check of the settings (engine available here, key saved,
// model downloaded); the speech-recognition step's own test is the real one.
// A meeting needs at least one party that can run.

import type { MeetingAudioConfig, PartyAudioConfig } from "../types";
import type { Platform } from "../platform";
import { resolveLocalModelId, sttProviderMeta } from "../stt/providerMeta";

export type PartyReadiness =
  | "ready"
  /** The engine needs an API key and none is saved. */
  | "needs_key"
  /** The engine's model isn't downloaded. */
  | "needs_model"
  /** The engine doesn't run on this platform. */
  | "unsupported"
  /** The engine only hears the microphone, but the party captures an output device. */
  | "input_only"
  /** The check doesn't know the engine (or couldn't read what it needs): not held against it. */
  | "unknown";

export type Party = "you" | "them";
export type SttReadiness = Record<Party, PartyReadiness>;

export interface ReadinessContext {
  platform: Platform;
  /** Whether a key is saved in this credential slot. */
  hasKey: (slot: string) => Promise<boolean>;
  /** Downloaded model ids of a local engine; undefined when they couldn't be read. */
  downloadedModels: (engine: string) => Promise<string[] | undefined>;
  activeModelPerEngine: Record<string, string>;
  activeWhisperModel: string | null;
}

export async function checkParty(party: PartyAudioConfig, ctx: ReadinessContext): Promise<PartyReadiness> {
  const meta = sttProviderMeta(party.stt_provider);
  if (!meta) return "unknown";
  if (ctx.platform !== "unknown" && !meta.platforms.includes(ctx.platform)) return "unsupported";
  if (meta.inputOnly && !party.is_input_device) return "input_only";
  if (meta.requiresApiKey) {
    try {
      if (!(await ctx.hasKey(meta.id))) return "needs_key";
    } catch {
      return "unknown";
    }
  }
  if (meta.requiresDownload) {
    const downloaded = await ctx.downloadedModels(meta.requiresDownload).catch(() => undefined);
    if (!downloaded) return "unknown";
    const model = resolveLocalModelId(meta.id, party.local_model_id, ctx.activeModelPerEngine, ctx.activeWhisperModel);
    const ok = model ? downloaded.includes(model) : downloaded.length > 0;
    if (!ok) return "needs_model";
  }
  return "ready";
}

export async function checkSttReadiness(config: MeetingAudioConfig | null, ctx: ReadinessContext): Promise<SttReadiness> {
  if (!config) return { you: "unknown", them: "unknown" };
  const [you, them] = await Promise.all([checkParty(config.you, ctx), checkParty(config.them, ctx)]);
  return { you, them };
}

/** A meeting can start when at least one party can (or may) run. */
export function canStartMeeting(readiness: SttReadiness): boolean {
  return readiness.you === "ready" || readiness.you === "unknown" || readiness.them === "ready" || readiness.them === "unknown";
}
