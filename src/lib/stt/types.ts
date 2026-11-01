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

/** Real-time models offered before `/v1/models` has been fetched (any id can be typed). */
export const SONIOX_SUGGESTED_MODELS: readonly string[] = ["stt-rt-v5"];

export interface SonioxConfig {
  region: SonioxRegion;
  model: string;
  /** 500–3000 ms. */
  max_endpoint_delay_ms: number;
  language_hints_strict: boolean;
  /** Tell remote speakers apart ("Them" only). */
  enable_speaker_diarization: boolean;
  /** Custom WebSocket URL (gateways). "" = by region. */
  ws_url: string;
  /** Custom REST base URL (gateways). "" = by region. */
  rest_url: string;
  /** JSON object merged into the start message; never api_key or the audio format. */
  extra_start_params: string;
}

export const DEFAULT_SONIOX_CONFIG: SonioxConfig = {
  region: "us",
  model: "stt-rt-v5",
  max_endpoint_delay_ms: 1500,
  language_hints_strict: false,
  enable_speaker_diarization: true,
  ws_url: "",
  rest_url: "",
  extra_start_params: "",
};

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
