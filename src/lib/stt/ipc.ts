// NexQ Plus: IPC wrappers of the remote STT and Soniox commands (stt_commands.rs).

import { invoke } from "@tauri-apps/api/core";
import type { OpenAICompatSttConfig, SonioxConfig, SttProbeResult } from "./types";

/** Push the remote STT settings; a running engine uses them from its next request. */
export async function updateOpenAICompatSttConfig(config: OpenAICompatSttConfig): Promise<void> {
  return invoke("update_openai_compat_stt_config", { configJson: JSON.stringify(config) });
}

/** Push the Soniox settings; they apply when a session (re)connects. */
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
