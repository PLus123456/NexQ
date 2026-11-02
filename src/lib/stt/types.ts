// NexQ Plus: settings of the remote STT (OpenAI-compatible) and Soniox engines.
// Mirrors src-tauri/src/stt/plus_config.rs (snake_case JSON, every field
// optional on the Rust side). Keys live in the keychain, never in these objects.

/** Keychain slot of the remote STT key (optional: no key = no auth header). */
export const OPENAI_COMPAT_STT_KEY_SLOT = "openai_compat_stt";
/** Keychain slot of the Soniox API key. */
export const SONIOX_KEY_SLOT = "soniox";

/** Remote Whisper over `{base_url}/audio/transcriptions` (speaches, vLLM, LocalAI…). */
export interface OpenAICompatSttConfig {
  /** Base URL with its version prefix, used as typed (`/v1` is never added). "" = not configured. */
  base_url: string;
  /** Full transcription URL for irregular gateways. "" = base URL + /audio/transcriptions. */
  url_override: string;
  model: string;
  temperature: number;
  /** "json" (default) | "text" | "verbose_json" */
  response_format: string;
  prompt: string;
  /** Longest audio per request (s). */
  segment_duration_secs: number;
  /** Silence that ends a segment early (ms). */
  pause_split_ms: number;
  request_timeout_secs: number;
  /** Requests at once (1–2); results stay in order. */
  max_in_flight: number;
}

export const DEFAULT_OPENAI_COMPAT_STT_CONFIG: OpenAICompatSttConfig = {
  base_url: "",
  url_override: "",
  model: "whisper-1",
  temperature: 0,
  response_format: "json",
  prompt: "",
  segment_duration_secs: 5,
  pause_split_ms: 1500,
  request_timeout_secs: 30,
  max_in_flight: 1,
};

export type SonioxRegion = "us" | "eu" | "jp" | "in";

export const SONIOX_REGIONS: readonly { id: SonioxRegion; rest: string; ws: string }[] = [
  { id: "us", rest: "https://api.soniox.com", ws: "wss://stt-rt.soniox.com/transcribe-websocket" },
  { id: "eu", rest: "https://api.eu.soniox.com", ws: "wss://stt-rt.eu.soniox.com/transcribe-websocket" },
  { id: "jp", rest: "https://api.jp.soniox.com", ws: "wss://stt-rt.jp.soniox.com/transcribe-websocket" },
  { id: "in", rest: "https://api.in.soniox.com", ws: "wss://stt-rt.in.soniox.com/transcribe-websocket" },
];

/** Region ids in the default priority order. */
export const SONIOX_REGION_IDS: readonly SonioxRegion[] = ["us", "eu", "jp", "in"];

/** Keychain slot of a region's Soniox key. The old `soniox` slot is read as the key of `region`. */
export function sonioxKeySlot(region: SonioxRegion): string {
  return `soniox_${region}`;
}

/**
 * How a Soniox session picks its region:
 * - "fixed": only `region` (what configs saved before the setting mean);
 * - "auto": enabled regions that have a key, fastest first (latency test);
 * - "ordered": enabled regions that have a key, in the list order.
 */
export type SonioxRegionMode = "fixed" | "auto" | "ordered";

/** One region of the list; the list order is the priority. */
export interface SonioxRegionSetting {
  id: SonioxRegion;
  enabled: boolean;
}

/** Real-time models offered before `/v1/models` has been fetched (any id can be typed). */
export const SONIOX_SUGGESTED_MODELS: readonly string[] = ["stt-rt-v5"];

export interface SonioxConfig {
  region: SonioxRegion;
  model: string;
  /** 500–3000 ms. */
  max_endpoint_delay_ms: number;
  /** -1.0–1.0, higher = sentences end sooner. null = server default (not sent; only stt-rt-v5 takes it). */
  endpoint_sensitivity: number | null;
  /** 0–3, higher = less wait before a sentence ends. null = server default (not sent; only stt-rt-v5 takes it). */
  endpoint_latency_adjustment_level: number | null;
  language_hints_strict: boolean;
  /** Tell remote speakers apart ("Them" only). */
  enable_speaker_diarization: boolean;
  /** Custom WebSocket URL (gateways). "" = by region. */
  ws_url: string;
  /** Custom REST base URL (gateways). "" = by region. */
  rest_url: string;
  /** JSON object merged into the start message; never api_key or the audio format. */
  extra_start_params: string;
  region_mode: SonioxRegionMode;
  /** All four regions in priority order (see `sonioxRegionList`). */
  regions: SonioxRegionSetting[];
  /** When a region is full, down or refuses the key, try the next one. */
  failover: boolean;
}

/** A fresh install: regions chosen by latency, each enabled when its key is added. */
export const DEFAULT_SONIOX_CONFIG: SonioxConfig = {
  region: "us",
  model: "stt-rt-v5",
  max_endpoint_delay_ms: 1500,
  endpoint_sensitivity: null,
  endpoint_latency_adjustment_level: null,
  language_hints_strict: false,
  enable_speaker_diarization: true,
  ws_url: "",
  rest_url: "",
  extra_start_params: "",
  region_mode: "auto",
  regions: SONIOX_REGION_IDS.map((id) => ({ id, enabled: false })),
  failover: true,
};

function isRegion(value: unknown): value is SonioxRegion {
  return typeof value === "string" && (SONIOX_REGION_IDS as readonly string[]).includes(value);
}

/**
 * All four regions in the user's order (mirrors Rust `SonioxConfig::region_list`):
 * known ids first (first occurrence wins), then the missing ones, disabled.
 * An empty list (a config from before the setting): `region` first and enabled.
 */
export function sonioxRegionList(config: Pick<SonioxConfig, "region" | "regions">): SonioxRegionSetting[] {
  const list: SonioxRegionSetting[] = [];
  for (const entry of config.regions ?? []) {
    if (isRegion(entry?.id) && !list.some((e) => e.id === entry.id)) {
      list.push({ id: entry.id, enabled: !!entry.enabled });
    }
  }
  if (list.length === 0) list.push({ id: isRegion(config.region) ? config.region : "us", enabled: true });
  for (const id of SONIOX_REGION_IDS) {
    if (!list.some((e) => e.id === id)) list.push({ id, enabled: false });
  }
  return list;
}

/**
 * A saved Soniox config over the defaults. Nothing saved = a fresh install
 * (`DEFAULT_SONIOX_CONFIG`); a config saved before the region settings keeps
 * using its one region (`fixed`, that region enabled).
 */
export function normalizeSonioxConfig(saved: Partial<SonioxConfig> | null | undefined): SonioxConfig {
  if (!saved) return { ...DEFAULT_SONIOX_CONFIG, regions: DEFAULT_SONIOX_CONFIG.regions.map((r) => ({ ...r })) };
  const region = isRegion(saved.region) ? saved.region : "us";
  const mode: SonioxRegionMode =
    saved.region_mode === "auto" || saved.region_mode === "ordered" ? saved.region_mode : "fixed";
  return {
    ...DEFAULT_SONIOX_CONFIG,
    ...saved,
    region,
    region_mode: mode,
    regions: sonioxRegionList({ region, regions: saved.regions ?? [] }),
    failover: saved.failover ?? true,
  };
}

/** Which regions have a key (`soniox_key_status`). */
export interface SonioxKeyStatus {
  /** A key in the region's own slot. */
  regions: Record<SonioxRegion, boolean>;
  /** A key in the old `soniox` slot (it counts as `legacy_region`'s). */
  legacy: boolean;
  legacy_region: SonioxRegion;
  /** The config given can connect: a key for a region it may use. */
  any_enabled: boolean;
}

/** Latency of each region's REST host, without a key (`soniox_measure_latency`). */
export interface SonioxLatency {
  regions: Record<SonioxRegion, { ms: number | null; error: string | null }>;
  /** When it was measured (epoch ms). */
  measured_at_ms: number;
  /** Served from the ~10 min cache. */
  cached: boolean;
}

/** What `soniox_add_key` found: the key's region (null = not found or ambiguous). */
export interface SonioxAddKeyResult {
  region: SonioxRegion | null;
  /** The key was saved in that region's slot. */
  stored: boolean;
  /** Per region: HTTP status of `/v1/models` with the key (200/403 = this region, 401 = not), or the error. */
  statuses: Partial<Record<SonioxRegion, { status: number | null; error: string | null; matches: boolean }>>;
}

/** Why a session moved to another region (`soniox_region_switch`). */
export type SonioxSwitchReason =
  | "concurrency"
  | "unavailable"
  | "model_not_available"
  | "budget"
  | "network"
  | "key_rejected"
  | "internal_error";

export interface SonioxRegionSwitchEvent {
  /** "You" | "Them" */
  party: string;
  from: SonioxRegion | "custom";
  to: SonioxRegion | "custom";
  reason: SonioxSwitchReason;
}

/** Stable outcome codes of a probe (the UI words them; `detail` is the raw server text). */
export type SttProbeCode =
  | "ok"
  | "no_base_url"
  | "invalid_url"
  | "no_key"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "http_error"
  | "timeout"
  | "network"
  | "bad_response";

/** Result of testing a remote STT service from the settings page. */
export interface SttProbeResult {
  ok: boolean;
  code: SttProbeCode;
  /** The URL actually requested (secrets redacted). */
  url: string | null;
  status: number | null;
  latency_ms: number;
  /** Server response or error text (≤ 2 KB). */
  detail: string;
  /** Model ids the service listed. */
  models: string[];
}
