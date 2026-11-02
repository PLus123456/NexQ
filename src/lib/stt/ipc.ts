// NexQ Plus: IPC wrappers of the remote STT and Soniox commands (stt_commands.rs).

import { invoke } from "@tauri-apps/api/core";
import type {
  OpenAICompatSttConfig,
  SonioxAddKeyResult,
  SonioxConfig,
  SonioxKeyStatus,
  SonioxLatency,
  SonioxRegion,
  SttProbeResult,
} from "./types";

/** Push the remote STT settings; a running engine uses them from its next request. */
export async function updateOpenAICompatSttConfig(config: OpenAICompatSttConfig): Promise<void> {
  return invoke("update_openai_compat_stt_config", { configJson: JSON.stringify(config) });
}

/** Push the Soniox settings; the active capture hook restarts the session to apply them. */
export async function updateSonioxConfig(config: SonioxConfig): Promise<void> {
  return invoke("update_soniox_config", { configJson: JSON.stringify(config) });
}

/**
 * Test a remote STT service with these (possibly unsaved) settings and the
 * stored key: lists the models, else transcribes one second of silence.
 */
export async function probeOpenAICompatStt(config: OpenAICompatSttConfig): Promise<SttProbeResult> {
  const json = await invoke<string>("probe_openai_compat_stt", { configJson: JSON.stringify(config) });
  return JSON.parse(json) as SttProbeResult;
}

/** Test the stored Soniox key (`GET /v1/models` of the region); lists the real-time models. */
export async function probeSoniox(config: SonioxConfig): Promise<SttProbeResult> {
  const json = await invoke<string>("probe_soniox", { configJson: JSON.stringify(config) });
  return JSON.parse(json) as SttProbeResult;
}

/** Run whisper.cpp on the GPU (Metal on macOS) or the CPU; applies when a party next starts. */
export async function setWhisperUseGpu(enabled: boolean): Promise<void> {
  return invoke("set_whisper_use_gpu", { enabled });
}

/** Which regions have a Soniox key, and whether `config` can connect with them. Keys are never returned. */
export async function sonioxKeyStatus(config: SonioxConfig): Promise<SonioxKeyStatus> {
  const json = await invoke<string>("soniox_key_status", { configJson: JSON.stringify(config) });
  return JSON.parse(json) as SonioxKeyStatus;
}

/**
 * Latency of the four regions (no key needed); cached ~10 min unless `force`.
 * The first request of each region includes DNS and TLS; the minimum of 3 counts.
 */
export async function sonioxMeasureLatency(force = false): Promise<SonioxLatency> {
  const json = await invoke<string>("soniox_measure_latency", { force });
  return JSON.parse(json) as SonioxLatency;
}

/**
 * Save a Soniox key in its region's slot. Without `region`, finds the region
 * first (`/v1/models` of each: 200 or 403 = its region, 401 = not); when that
 * is unclear nothing is saved and the caller asks the user to pick.
 */
export async function sonioxAddKey(key: string, region?: SonioxRegion): Promise<SonioxAddKeyResult> {
  const json = await invoke<string>("soniox_add_key", { key, region: region ?? null });
  return JSON.parse(json) as SonioxAddKeyResult;
}
