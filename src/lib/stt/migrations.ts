// NexQ Plus: first-load migrations of the STT settings in config.json.
// Pure: configStore.loadConfig runs it once per window (two windows run it
// twice), so applying it to its own output changes nothing. Old keys are only
// rewritten in place (no key is deleted), so an older build still reads them.

import type { MeetingAudioConfig, PartyAudioConfig, STTProviderType } from "../types";
import type { Platform } from "../platform";
import { isExclusiveProvider } from "./providerMeta";

export interface SttMigrationInput {
  meetingAudioConfig: MeetingAudioConfig | null | undefined;
  sttProvider: STTProviderType | null | undefined;
  sttLanguage: string | null | undefined;
  /** Legacy single-provider device fields (configs from before meetingAudioConfig). */
  micDeviceId?: string | null;
  systemDeviceId?: string | null;
  recordingEnabled?: boolean | null;
  platform: Platform;
}

export interface SttMigrationResult {
  meetingAudioConfig: MeetingAudioConfig;
  sttProvider: STTProviderType;
  /** Which values must be saved back. */
  changed: { meetingAudioConfig: boolean; sttProvider: boolean };
  /** What happened, for the console. */
  notes: string[];
}

/** Language of a party saved before per-party languages existed. */
export const DEFAULT_STT_LANGUAGE = "en-US";

/** The top-level engine used when none is saved. */
export function defaultSttProvider(platform: Platform): STTProviderType {
  return platform === "windows" ? "windows_native" : "web_speech";
}

/**
 * Engine for the remote party when nothing else fits: Whisper.cpp on macOS
 * (local, free, Metal; its model is downloaded in the first-run setup),
 * Deepgram elsewhere (as upstream).
 */
export function defaultThemProvider(platform: Platform): STTProviderType {
  return platform === "macos" ? "whisper_cpp" : "deepgram";
}

/** The config of a fresh install: Web Speech for you, the default engine for the other side. */
export function defaultMeetingAudioConfig(platform: Platform, language: string): MeetingAudioConfig {
  return {
    you: { role: "You", device_id: "default", is_input_device: true, stt_provider: "web_speech", language },
    them: { role: "Them", device_id: "default", is_input_device: false, stt_provider: defaultThemProvider(platform), language },
    recording_enabled: false,
    preset_name: null,
  };
}

function switchEngine(party: PartyAudioConfig, provider: STTProviderType): PartyAudioConfig {
  return { ...party, stt_provider: provider, local_model_id: undefined };
}

export function migrateSttConfig(input: SttMigrationInput): SttMigrationResult {
  const notes: string[] = [];
  const language = input.sttLanguage || DEFAULT_STT_LANGUAGE;
  const onWindows = input.platform === "windows";
  const themFallback = defaultThemProvider(input.platform);
  let changedConfig = false;

  // No per-party config yet: build it from the legacy device fields, or the defaults.
  let config: MeetingAudioConfig;
  if (input.meetingAudioConfig) {
    config = { ...input.meetingAudioConfig, you: { ...input.meetingAudioConfig.you }, them: { ...input.meetingAudioConfig.them } };
  } else {
    config = defaultMeetingAudioConfig(input.platform, language);
    if (input.micDeviceId || input.systemDeviceId) {
      config.you.device_id = input.micDeviceId ?? "default";
      config.them.device_id = input.systemDeviceId ?? "default";
      config.recording_enabled = input.recordingEnabled ?? false;
      notes.push("built meetingAudioConfig from the legacy device fields");
    } else {
      notes.push("created the default meetingAudioConfig");
    }
    changedConfig = true;
  }

  // Windows Speech: Windows only (elsewhere it only printed placeholders), and
  // there it can't hear system audio.
  if (!onWindows && config.you.stt_provider === "windows_native") {
    config.you = switchEngine(config.you, "web_speech");
    notes.push("You: Windows Speech → Web Speech (not on Windows)");
    changedConfig = true;
  }
  if (config.them.stt_provider === "windows_native" && (!onWindows || !config.them.is_input_device)) {
    config.them = switchEngine(config.them, themFallback);
    notes.push(`Them: Windows Speech → ${themFallback}`);
    changedConfig = true;
  }

  // Web Speech / Windows Speech serve one party at a time: keep "You".
  if (isExclusiveProvider(config.you.stt_provider) && isExclusiveProvider(config.them.stt_provider)) {
    config.them = switchEngine(config.them, themFallback);
    notes.push(`both parties on an exclusive engine: Them → ${themFallback}`);
    changedConfig = true;
  }

  // Per-party languages: a party without one keeps the language it used so far.
  for (const party of ["you", "them"] as const) {
    if (!config[party].language) {
      config[party] = { ...config[party], language };
      notes.push(`${party}: language ${language}`);
      changedConfig = true;
    }
  }

  // Top-level engine (legacy single-provider path): the platform default when
  // unset, or when it is Windows Speech off Windows. Whisper.cpp stays: it is a live engine.
  let sttProvider = input.sttProvider ?? null;
  let changedProvider = false;
  if (!sttProvider || (!onWindows && sttProvider === "windows_native")) {
    sttProvider = defaultSttProvider(input.platform);
    notes.push(`top-level sttProvider → ${sttProvider}`);
    changedProvider = true;
  }

  return {
    meetingAudioConfig: changedConfig ? config : (input.meetingAudioConfig as MeetingAudioConfig),
    sttProvider,
    changed: { meetingAudioConfig: changedConfig, sttProvider: changedProvider },
    notes,
  };
}
