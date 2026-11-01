// Shared pieces of the speech-recognition settings surfaces (Audio & Devices,
// STT Providers, the quick setup): engine icons and names, what decides
// whether an engine can run (downloaded models, stored keys) and the
// per-party config helpers. Engine facts come from lib/stt/providerMeta.

import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import { listen } from "@tauri-apps/api/event";
import { Cloud, Cpu, Globe, HardDrive, Monitor, Zap } from "lucide-react";
import { t } from "../../i18n";
import { hasApiKey, listLocalSTTEngines } from "../../lib/ipc";
import {
  EXCLUSIVE_FALLBACK_ORDER,
  STT_LABELS,
  STT_PROVIDERS,
  isExclusiveProvider,
  localModelIdOnSwitch,
  sttKeySlot,
  sttProviderMeta,
  type SttAvailabilityContext,
  type SttIconKey,
  type SttProviderMeta,
} from "../../lib/stt/providerMeta";
import type {
  LocalSTTEngineInfo,
  MeetingAudioConfig,
  PartyAudioConfig,
  STTProviderType,
} from "../../lib/types";

export type Party = "you" | "them";
export const PARTIES: readonly Party[] = ["you", "them"];

export function otherParty(party: Party): Party {
  return party === "you" ? "them" : "you";
}

/** "You" / "Them" in the UI language. */
export function partyLabel(party: Party): string {
  return t(party === "you" ? "common:labels.you" : "common:labels.them");
}

// ── Engine names and icons ──

const ICONS: Record<SttIconKey, React.ComponentType<{ className?: string }>> = {
  globe: Globe,
  monitor: Monitor,
  hardDrive: HardDrive,
  zap: Zap,
  cpu: Cpu,
  cloud: Cloud,
};

/** The engine's picker icon (providerMeta's icon key). */
export function SttEngineIcon({ id, className }: { id: string; className?: string }) {
  const Icon = ICONS[sttProviderMeta(id)?.icon ?? "cloud"];
  return <Icon className={className} />;
}

/** The engine's name in the UI language (product names stay as they are); unknown ids as is. */
export function sttEngineLabel(id: string): string {
  const meta = sttProviderMeta(id);
  return meta ? t(`stt:engines.${meta.id}.label`) : id;
}

/** One-line description of the engine for cards and pickers. */
export function sttEngineDescription(id: STTProviderType): string {
  return t(`stt:engines.${id}.description`);
}

/** Engines whose short name isn't a product name (worded through `stt:engines.<id>.label`). */
const WORDED_SHORT_LABELS: readonly string[] = ["openai_compat"];

/** Short engine name for banners and toasts: the product name (STT_LABELS) or its UI wording; unknown ids as is. */
export function sttShortLabel(id: string): string {
  if (WORDED_SHORT_LABELS.includes(id)) return sttEngineLabel(id);
  return STT_LABELS[id] ?? id;
}

// ── What decides availability ──

/** Keychain slots of the engines that need a key. */
export const STT_KEY_SLOTS: readonly string[] = [
  ...new Set(STT_PROVIDERS.filter((p) => p.requiresApiKey).map(sttKeySlot)),
];

/** Whether a model of this local engine is downloaded; undefined while the list isn't loaded. */
export function isModelReady(localEngines: LocalSTTEngineInfo[] | null, engine: string): boolean | undefined {
  if (!localEngines) return undefined;
  const info = localEngines.find((e) => e.engine === engine);
  if (!info) return false;
  return info.models.some((m) => !m.id.startsWith("binary-") && m.is_downloaded);
}

export interface SttReadiness {
  /** Local engines with their models; null until loaded (or when loading failed). */
  localEngines: LocalSTTEngineInfo[] | null;
  /** Keychain slot → a key is stored. */
  keys: Readonly<Record<string, boolean>>;
  /** The key check finished at least once. */
  keysLoaded: boolean;
  /** Check models and keys again (after a key was saved or a model downloaded elsewhere). */
  refresh: () => void;
}

/**
 * Loads which local models are downloaded and which engine keys are stored,
 * and reloads the models when a download completes.
 */
export function useSttReadiness(): SttReadiness {
  const [localEngines, setLocalEngines] = useState<LocalSTTEngineInfo[] | null>(null);
  const [keys, setKeys] = useState<Record<string, boolean>>({});
  const [keysLoaded, setKeysLoaded] = useState(false);
  const alive = useRef(true);

  const loadEngines = useCallback(async () => {
    try {
      const engines = await listLocalSTTEngines();
      if (alive.current) setLocalEngines(engines);
    } catch (err) {
      console.warn("[stt] Failed to load local STT engines:", err);
    }
  }, []);

  const loadKeys = useCallback(async () => {
    const entries = await Promise.all(
      STT_KEY_SLOTS.map(async (slot) => {
        try {
          return [slot, await hasApiKey(slot)] as const;
        } catch {
          return [slot, false] as const;
        }
      }),
    );
    if (!alive.current) return;
    setKeys(Object.fromEntries(entries));
    setKeysLoaded(true);
  }, []);

  useEffect(() => {
    alive.current = true;
    void loadEngines();
    void loadKeys();
    let unlisten: (() => void) | null = null;
    listen<{ status: string }>("model_download_progress", (event) => {
      if (event.payload.status === "complete") void loadEngines();
    })
      .then((fn) => {
        if (alive.current) unlisten = fn;
        else fn();
      })
      .catch(() => {});
    return () => {
      alive.current = false;
      unlisten?.();
    };
  }, [loadEngines, loadKeys]);

  const refresh = useCallback(() => {
    void loadEngines();
    void loadKeys();
  }, [loadEngines, loadKeys]);

  return { localEngines, keys, keysLoaded, refresh };
}

/** providerMeta's availability inputs for one party. */
export function availabilityContext(
  readiness: Pick<SttReadiness, "localEngines" | "keys" | "keysLoaded">,
  isInput: boolean,
  hasBaseUrl: boolean,
): SttAvailabilityContext {
  return {
    isInput,
    isEngineReady: (engine) => isModelReady(readiness.localEngines, engine),
    hasKey: (slot) => (readiness.keysLoaded ? readiness.keys[slot] ?? false : undefined),
    hasBaseUrl,
  };
}

/** Why `meta` can't run for a party right now (the first rule that fails), or null. */
export type SttUnavailableReason = "needsInput" | "needsModel" | "needsBaseUrl" | "needsKey";

export function unavailableReason(meta: SttProviderMeta, ctx: SttAvailabilityContext): SttUnavailableReason | null {
  if (meta.inputOnly && !ctx.isInput) return "needsInput";
  if (meta.requiresDownload) return ctx.isEngineReady(meta.requiresDownload) === false ? "needsModel" : null;
  if (meta.requiresBaseUrl) return ctx.hasBaseUrl ? null : "needsBaseUrl";
  if (meta.requiresApiKey) return ctx.hasKey(sttKeySlot(meta)) === false ? "needsKey" : null;
  return null;
}

// ── Per-party config ──

/** The config the pages show before one is saved (same defaults as before NexQ Plus). */
export function defaultMeetingAudioConfig(state: {
  micDeviceId: string | null;
  systemDeviceId: string | null;
  recordingEnabled: boolean;
}): MeetingAudioConfig {
  return {
    you: {
      role: "You",
      device_id: state.micDeviceId ?? "default",
      is_input_device: true,
      stt_provider: "web_speech",
    },
    them: {
      role: "Them",
      device_id: state.systemDeviceId ?? "default",
      is_input_device: false,
      stt_provider: "deepgram",
    },
    recording_enabled: state.recordingEnabled,
    preset_name: null,
  };
}

/** A party's recognition language: its own, else the global one. */
export function partyLanguage(party: PartyAudioConfig, sttLanguage: string): string {
  return party.language || sttLanguage;
}

export interface ActiveModels {
  activeModelPerEngine: Record<string, string>;
  activeWhisperModel: string | null;
}

/** `config` with `party` on `engine`: the engine's model id (none for engines without one), preset cleared. */
export function withPartyEngine(
  config: MeetingAudioConfig,
  party: Party,
  engine: STTProviderType,
  models: ActiveModels,
): MeetingAudioConfig {
  return {
    ...config,
    [party]: {
      ...config[party],
      stt_provider: engine,
      local_model_id: localModelIdOnSwitch(engine, models.activeModelPerEngine, models.activeWhisperModel),
    },
    preset_name: null,
  };
}

/**
 * Engine for the party that gives up Web Speech / Windows Speech: the first of
 * EXCLUSIVE_FALLBACK_ORDER that is offered here and available. Never another
 * exclusive engine.
 */
export function exclusiveFallback(
  offered: readonly SttProviderMeta[],
  isAvailable: (meta: SttProviderMeta) => boolean,
): STTProviderType | null {
  for (const id of EXCLUSIVE_FALLBACK_ORDER) {
    const meta = offered.find((o) => o.id === id);
    if (meta && !isExclusiveProvider(meta.id) && isAvailable(meta)) return meta.id;
  }
  return null;
}

/** Putting an exclusive engine on `party` while the other party holds one. */
export function needsExclusiveSwap(config: MeetingAudioConfig, party: Party, engine: string): boolean {
  return isExclusiveProvider(engine) && isExclusiveProvider(config[otherParty(party)].stt_provider);
}

export interface PartyAssignment {
  config: MeetingAudioConfig;
  /** The other party had to give up its exclusive engine. */
  fallback?: { party: Party; engine: STTProviderType };
}

/**
 * Puts `engine` on `party`. An exclusive engine moves the other party off its
 * exclusive one onto `fallback`; null when that's needed and there is none.
 */
export function assignPartyEngine(
  config: MeetingAudioConfig,
  party: Party,
  engine: STTProviderType,
  models: ActiveModels,
  fallback: STTProviderType | null,
): PartyAssignment | null {
  const next = withPartyEngine(config, party, engine, models);
  if (!needsExclusiveSwap(config, party, engine)) return { config: next };
  if (!fallback) return null;
  const other = otherParty(party);
  return { config: withPartyEngine(next, other, fallback, models), fallback: { party: other, engine: fallback } };
}

// ── Presets ──

/** Built-in preset ids the `stt` namespace words (`stt:presets.<id>`). */
const PRESET_IDS = [
  "free",
  "soniox_them",
  "best_quality",
  "fully_offline",
  "all_cloud",
  "local_whisper",
  "in_person",
] as const;
type PresetId = (typeof PRESET_IDS)[number];

function isPresetId(id: string): id is PresetId {
  return (PRESET_IDS as readonly string[]).includes(id);
}

/** A preset's name in the UI language (its English name for an unknown id). */
export function presetName(preset: { id: string; name: string }): string {
  return isPresetId(preset.id) ? t(`stt:presets.${preset.id}.name`) : preset.name;
}

/** A preset's description in the UI language. */
export function presetDescription(preset: { id: string; description: string }): string {
  return isPresetId(preset.id) ? t(`stt:presets.${preset.id}.description`) : preset.description;
}
