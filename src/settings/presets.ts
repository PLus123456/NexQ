// Meeting Audio Presets — one-click configuration profiles.

import type {
  AudioDevice,
  MeetingAudioConfig,
  NativeTranslationConfig,
  PartyAudioConfig,
  STTProviderType,
} from "../lib/types";

export interface MeetingPreset {
  /** Stable id; the UI words the preset with `stt:presets.<id>.name` / `.description`. */
  id: string;
  /** English name, stored as the config's `preset_name`. */
  name: string;
  description: string;
  badge?: string;
  you: PresetParty;
  them: PresetParty;
  /** Keychain slot of the key the preset needs. */
  requiresKey?: string;
  requiresDownload?: string;
  /** Needs the remote STT server's address (`openaiCompatSttConfig.base_url`). */
  requiresBaseUrl?: boolean;
  windowsOnly?: boolean;
}

export interface PresetParty {
  hint: DeviceHint;
  stt: STTProviderType;
  /** Engine-side translation the preset turns on (merged over the party's current one). */
  nativeTranslation?: NativeTranslationConfig;
}

/** Hints for resolving device IDs at apply time. */
export type DeviceHint =
  | "default_mic"    // Default input device
  | "default_output" // Default output device
  | "mic_2";         // Second mic (for in-person with two mics)

export const BUILT_IN_PRESETS: MeetingPreset[] = [
  {
    // Windows Speech can't transcribe system audio (it only listens to the
    // default mic), so the other side uses a local model instead.
    id: "free",
    name: "Free",
    description: "Web Speech for you, Parakeet TDT for the other side — free and private (one-time model download)", // i18n-ignore: worded via stt:presets.<id>
    badge: "Default",
    you: { hint: "default_mic", stt: "web_speech" },
    them: { hint: "default_output", stt: "parakeet_tdt" },
    requiresDownload: "parakeet_tdt",
  },
  {
    // NexQ Plus: Soniox only where it pays off (the other side, with live
    // translation into the translation target language); local Whisper for you.
    id: "soniox_them",
    name: "Soniox for Them",
    description: "Soniox transcribes and translates the other side in real time; Whisper.cpp on this Mac for you", // i18n-ignore: worded via stt:presets.<id>
    badge: "Plus",
    you: { hint: "default_mic", stt: "whisper_cpp" },
    them: { hint: "default_output", stt: "soniox", nativeTranslation: { mode: "one_way" } },
    requiresKey: "soniox",
    requiresDownload: "whisper_cpp",
  },
  {
    // NexQ Plus: a Whisper server of your own (faster-whisper-server / speaches,
    // vLLM, LocalAI...) for both parties, once its address is set.
    id: "remote_whisper",
    name: "Self-hosted Whisper",
    description: "Your own Whisper server (OpenAI-compatible) for both parties", // i18n-ignore: worded via stt:presets.<id>
    you: { hint: "default_mic", stt: "openai_compat" },
    them: { hint: "default_output", stt: "openai_compat" },
    requiresBaseUrl: true,
  },
  {
    id: "best_quality",
    name: "Best Quality",
    description: "Deepgram cloud — fastest, most accurate", // i18n-ignore: worded via stt:presets.<id>
    badge: "Recommended",
    you: { hint: "default_mic", stt: "web_speech" },
    them: { hint: "default_output", stt: "deepgram" },
    requiresKey: "deepgram",
  },
  {
    id: "fully_offline",
    name: "Fully Offline",
    description: "Sherpa-ONNX — no internet needed", // i18n-ignore: worded via stt:presets.<id>
    badge: "Free",
    you: { hint: "default_mic", stt: "sherpa_onnx" },
    them: { hint: "default_output", stt: "sherpa_onnx" },
    requiresDownload: "sherpa_onnx",
  },
  {
    id: "all_cloud",
    name: "All Cloud",
    description: "Deepgram for both parties", // i18n-ignore: worded via stt:presets.<id>
    you: { hint: "default_mic", stt: "deepgram" },
    them: { hint: "default_output", stt: "deepgram" },
    requiresKey: "deepgram",
  },
  {
    id: "local_whisper",
    name: "Local Only (Whisper)",
    description: "Whisper.cpp for both parties — offline, free", // i18n-ignore: worded via stt:presets.<id>
    you: { hint: "default_mic", stt: "whisper_cpp" },
    them: { hint: "default_output", stt: "whisper_cpp" },
    requiresDownload: "whisper_cpp",
  },
  {
    id: "in_person",
    name: "In-Person",
    description: "Both parties use mic input — Web Speech + Whisper.cpp", // i18n-ignore: worded via stt:presets.<id>
    you: { hint: "default_mic", stt: "web_speech" },
    them: { hint: "mic_2", stt: "whisper_cpp" },
    requiresDownload: "whisper_cpp",
  },
];

/** Resolve a device hint to an actual device ID. */
function resolveHint(hint: DeviceHint, devices: AudioDevice[]): { device_id: string; is_input: boolean } {
  switch (hint) {
    case "default_mic": {
      const mic = devices.find((d) => d.is_input && d.is_default)
        ?? devices.find((d) => d.is_input);
      return { device_id: mic?.id ?? "default", is_input: true };
    }
    case "default_output": {
      const out = devices.find((d) => !d.is_input && d.is_default)
        ?? devices.find((d) => !d.is_input);
      return { device_id: out?.id ?? "default", is_input: false };
    }
    case "mic_2": {
      // Second microphone — skip the default
      const mics = devices.filter((d) => d.is_input);
      const second = mics.find((d) => !d.is_default) ?? mics[0];
      return { device_id: second?.id ?? "default", is_input: true };
    }
  }
}

/** One party of a preset; keeps what the preset doesn't decide (language, translation target). */
function presetParty(
  role: PartyAudioConfig["role"],
  party: PresetParty,
  devices: AudioDevice[],
  current: PartyAudioConfig | undefined,
): PartyAudioConfig {
  const device = resolveHint(party.hint, devices);
  const config: PartyAudioConfig = {
    role,
    device_id: device.device_id,
    is_input_device: device.is_input,
    stt_provider: party.stt,
  };
  if (current?.language) config.language = current.language;
  const translation = party.nativeTranslation
    ? { ...current?.native_translation, ...party.nativeTranslation }
    : current?.native_translation;
  if (translation) config.native_translation = translation;
  return config;
}

/**
 * Apply a preset using the current list of audio devices. Engines and devices
 * come from the preset; each party's language and translation target, the
 * recording switch and the meeting mode carry over from `current`.
 */
export function applyPreset(
  preset: MeetingPreset,
  devices: AudioDevice[],
  current?: MeetingAudioConfig | null,
): MeetingAudioConfig {
  const config: MeetingAudioConfig = {
    you: presetParty("You", preset.you, devices, current?.you),
    them: presetParty("Them", preset.them, devices, current?.them),
    recording_enabled: current?.recording_enabled ?? false,
    preset_name: preset.name,
  };
  if (current?.audio_mode) config.audio_mode = current.audio_mode;
  if (current?.noise_preset) config.noise_preset = current.noise_preset;
  return config;
}
