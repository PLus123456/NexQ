// Built-in provider templates for new LLM connections. A template only fills
// in the form: every field stays editable, and adding a vendor never needs a
// Rust change (OpenAI-compatible vendors share one protocol). Names and notes
// are in the `llm` namespace (`templates.items.<id>.*`).
//
// Addresses and auth styles were checked against each vendor's documentation
// on 2026-11-01; suggested models are only candidates (any id can be typed).

import type { AuthConfig, CustomHeader } from "../../lib/endpoint";
import { blankConnection, uniqueName } from "../../lib/llm/connection";
import type { LlmCompat, LlmConnection, LlmKind, ModelsEndpointMode } from "../../lib/llm/types";
import { APP_NAME, REPO_URL } from "../../lib/brand";

export type TemplateGroup = "international" | "china" | "local" | "other";

export const TEMPLATE_GROUPS: readonly TemplateGroup[] = ["china", "international", "local", "other"];

export type TemplateId =
  | "openai"
  | "anthropic"
  | "gemini"
  | "openrouter"
  | "groq"
  | "azure"
  | "xai"
  | "mistral"
  | "deepseek"
  | "kimi"
  | "zhipu"
  | "qwen"
  | "volcengine"
  | "siliconflow"
  | "minimax"
  | "qianfan"
  | "hunyuan"
  | "stepfun"
  | "ollama"
  | "lmstudio"
  | "selfhosted"
  | "claude_cli"
  | "custom";

export interface ProviderTemplate {
  id: TemplateId;
  group: TemplateGroup;
  kind: LlmKind;
  /** Pre-filled base URL ("" when the user must supply a host of their own). */
  baseUrl: string;
  /** Placeholder for the base URL field when `baseUrl` is empty or site-specific. */
  baseUrlPlaceholder?: string;
  /** Other official addresses (e.g. the international site), offered as one-click switches. */
  altBaseUrls?: { id: "international" | "china"; url: string }[];
  auth: AuthConfig;
  headers?: CustomHeader[];
  modelsEndpoint?: ModelsEndpointMode;
  /** Candidates shown in model inputs until a list is fetched. */
  suggestedModels: readonly string[];
  /** Pre-filled default model. */
  defaultModel?: string;
  compat?: Partial<LlmCompat>;
  /**
   * Extra request body that turns thinking off on this vendor's
   * OpenAI-compatible API (offered for fast tasks such as live translation).
   */
  disableThinking?: Record<string, unknown>;
  /** Whether an API key is normally needed (local servers usually don't). */
  needsKey: boolean;
  /** Where to get an API key. */
  keyUrl?: string;
}

const BEARER: AuthConfig = { mode: "bearer", header_name: "", prefix: "" };
const NONE: AuthConfig = { mode: "none", header_name: "", prefix: "" };
const header = (name: string): AuthConfig => ({ mode: "header", header_name: name, prefix: "" });

const THINKING_TYPE_DISABLED = { thinking: { type: "disabled" } };
const ENABLE_THINKING_FALSE = { enable_thinking: false };

export const PROVIDER_TEMPLATES: readonly ProviderTemplate[] = [
  // ── China ──
  {
    id: "deepseek",
    group: "china",
    kind: "openai_compat",
    baseUrl: "https://api.deepseek.com/v1",
    auth: BEARER,
    suggestedModels: ["deepseek-chat", "deepseek-reasoner"],
    defaultModel: "deepseek-chat",
    needsKey: true,
    keyUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "qwen",
    group: "china",
    kind: "openai_compat",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    altBaseUrls: [{ id: "international", url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" }],
    auth: BEARER,
    suggestedModels: ["qwen-plus", "qwen-max", "qwen-flash", "qwen-turbo", "qwen3-max"],
    defaultModel: "qwen-plus",
    disableThinking: ENABLE_THINKING_FALSE,
    needsKey: true,
    keyUrl: "https://bailian.console.aliyun.com/?tab=model#/api-key",
  },
  {
    id: "zhipu",
    group: "china",
    kind: "openai_compat",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    altBaseUrls: [{ id: "international", url: "https://api.z.ai/api/paas/v4" }],
    auth: BEARER,
    suggestedModels: ["glm-4.6", "glm-4.5-air", "glm-4.5-flash"],
    defaultModel: "glm-4.6",
    disableThinking: THINKING_TYPE_DISABLED,
    needsKey: true,
    keyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
  },
  {
    id: "kimi",
    group: "china",
    kind: "openai_compat",
    baseUrl: "https://api.moonshot.cn/v1",
    altBaseUrls: [{ id: "international", url: "https://api.moonshot.ai/v1" }],
    auth: BEARER,
    suggestedModels: ["kimi-k2-0905-preview", "kimi-k2-turbo-preview", "kimi-latest", "moonshot-v1-32k"],
    defaultModel: "kimi-k2-0905-preview",
    needsKey: true,
    keyUrl: "https://platform.moonshot.cn/console/api-keys",
  },
  {
    id: "volcengine",
    group: "china",
    kind: "openai_compat",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    auth: BEARER,
    suggestedModels: ["doubao-seed-1-6-250615", "doubao-seed-1-6-flash-250828", "deepseek-v3-1-terminus"],
    disableThinking: THINKING_TYPE_DISABLED,
    needsKey: true,
    keyUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
  },
  {
    id: "siliconflow",
    group: "china",
    kind: "openai_compat",
    baseUrl: "https://api.siliconflow.cn/v1",
    altBaseUrls: [{ id: "international", url: "https://api.siliconflow.com/v1" }],
    auth: BEARER,
    suggestedModels: ["deepseek-ai/DeepSeek-V3.1", "Qwen/Qwen3-235B-A22B-Instruct-2507", "zai-org/GLM-4.5", "moonshotai/Kimi-K2-Instruct-0905"],
    defaultModel: "deepseek-ai/DeepSeek-V3.1",
    disableThinking: ENABLE_THINKING_FALSE,
    needsKey: true,
    keyUrl: "https://cloud.siliconflow.cn/account/ak",
  },
  {
    id: "minimax",
    group: "china",
    kind: "openai_compat",
    baseUrl: "https://api.minimaxi.com/v1",
    altBaseUrls: [{ id: "international", url: "https://api.minimax.io/v1" }],
    auth: BEARER,
    suggestedModels: ["MiniMax-M2"],
    defaultModel: "MiniMax-M2",
    needsKey: true,
    keyUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
  },
  {
    id: "qianfan",
    group: "china",
    kind: "openai_compat",
    baseUrl: "https://qianfan.baidubce.com/v2",
    auth: BEARER,
    suggestedModels: ["ernie-4.5-turbo-128k", "ernie-x1-turbo-32k", "deepseek-v3"],
    needsKey: true,
    keyUrl: "https://console.bce.baidu.com/iam/#/iam/apikey/list",
  },
  {
    id: "hunyuan",
    group: "china",
    kind: "openai_compat",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    auth: BEARER,
    suggestedModels: ["hunyuan-turbos-latest", "hunyuan-t1-latest", "hunyuan-lite"],
    needsKey: true,
    keyUrl: "https://console.cloud.tencent.com/hunyuan/api-key",
  },
  {
    id: "stepfun",
    group: "china",
    kind: "openai_compat",
    baseUrl: "https://api.stepfun.com/v1",
    auth: BEARER,
    suggestedModels: ["step-2-mini", "step-2-16k", "step-1-8k"],
    needsKey: true,
    keyUrl: "https://platform.stepfun.com/interface-key",
  },

  // ── International ──
  {
    id: "openai",
    group: "international",
    kind: "openai_compat",
    baseUrl: "https://api.openai.com/v1",
    auth: BEARER,
    suggestedModels: ["gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-4.1", "gpt-4o-mini"],
    defaultModel: "gpt-5-mini",
    // Reasoning models only take `max_completion_tokens` and the default temperature.
    compat: { max_tokens_field: "max_completion_tokens" },
    needsKey: true,
    keyUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "anthropic",
    group: "international",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com",
    auth: header("x-api-key"),
    suggestedModels: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-fable-5-1"],
    defaultModel: "claude-sonnet-5-5",
    // Current Claude models reject sampling parameters (see llm/anthropic.rs).
    compat: { temperature: "omit" },
    needsKey: true,
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "gemini",
    group: "international",
    kind: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    auth: header("x-goog-api-key"),
    suggestedModels: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite"],
    defaultModel: "gemini-2.5-flash",
    compat: { web_search: "none" },
    needsKey: true,
    keyUrl: "https://aistudio.google.com/apikey",
  },
  {
    id: "openrouter",
    group: "international",
    kind: "openai_compat",
    baseUrl: "https://openrouter.ai/api/v1",
    auth: BEARER,
    headers: [
      { name: "HTTP-Referer", value: REPO_URL },
      { name: "X-Title", value: APP_NAME },
    ],
    suggestedModels: ["openrouter/auto", "deepseek/deepseek-chat-v3.1", "google/gemini-2.5-flash", "anthropic/claude-sonnet-4.5"],
    needsKey: true,
    keyUrl: "https://openrouter.ai/settings/keys",
  },
  {
    id: "groq",
    group: "international",
    kind: "openai_compat",
    baseUrl: "https://api.groq.com/openai/v1",
    auth: BEARER,
    suggestedModels: ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "openai/gpt-oss-20b", "llama-3.1-8b-instant"],
    defaultModel: "llama-3.3-70b-versatile",
    needsKey: true,
    keyUrl: "https://console.groq.com/keys",
  },
  {
    id: "azure",
    group: "international",
    kind: "openai_compat",
    baseUrl: "",
    baseUrlPlaceholder: "https://<resource>.openai.azure.com/openai/v1",
    auth: header("api-key"),
    suggestedModels: [],
    compat: { max_tokens_field: "max_completion_tokens" },
    needsKey: true,
    keyUrl: "https://portal.azure.com/",
  },
  {
    id: "xai",
    group: "international",
    kind: "openai_compat",
    baseUrl: "https://api.x.ai/v1",
    auth: BEARER,
    suggestedModels: ["grok-4", "grok-4-fast-non-reasoning", "grok-3-mini"],
    needsKey: true,
    keyUrl: "https://console.x.ai/",
  },
  {
    id: "mistral",
    group: "international",
    kind: "openai_compat",
    baseUrl: "https://api.mistral.ai/v1",
    auth: BEARER,
    suggestedModels: ["mistral-medium-latest", "mistral-large-latest", "mistral-small-latest"],
    needsKey: true,
    keyUrl: "https://console.mistral.ai/api-keys",
  },

  // ── Local and self-hosted ──
  {
    id: "ollama",
    group: "local",
    kind: "ollama",
    baseUrl: "http://localhost:11434",
    auth: NONE,
    suggestedModels: [],
    compat: { keep_alive: "30m" },
    needsKey: false,
  },
  {
    id: "lmstudio",
    group: "local",
    kind: "openai_compat",
    baseUrl: "http://localhost:1234/v1",
    auth: NONE,
    suggestedModels: [],
    needsKey: false,
  },
  {
    id: "selfhosted",
    group: "local",
    kind: "openai_compat",
    baseUrl: "",
    baseUrlPlaceholder: "http://192.168.1.10:8000/v1",
    auth: BEARER,
    suggestedModels: [],
    needsKey: false,
  },

  // ── Subscription and custom ──
  {
    id: "claude_cli",
    group: "other",
    kind: "claude_cli",
    baseUrl: "",
    auth: NONE,
    modelsEndpoint: "disabled",
    suggestedModels: [],
    needsKey: false,
  },
  {
    id: "custom",
    group: "other",
    kind: "openai_compat",
    baseUrl: "",
    baseUrlPlaceholder: "https://api.example.com/v1",
    auth: BEARER,
    suggestedModels: [],
    needsKey: false,
  },
];

/** Templates with a note (`templates.items.<id>.note`) shown in the editor. */
const NOTE_IDS = [
  "deepseek",
  "qwen",
  "zhipu",
  "volcengine",
  "openai",
  "openrouter",
  "azure",
  "ollama",
  "selfhosted",
  "claude_cli",
] as const satisfies readonly TemplateId[];

export type TemplateNoteId = (typeof NOTE_IDS)[number];

export function hasTemplateNote(id: TemplateId): id is TemplateNoteId {
  return (NOTE_IDS as readonly string[]).includes(id);
}

export function findTemplate(id: string | null | undefined): ProviderTemplate | undefined {
  return id ? PROVIDER_TEMPLATES.find((t) => t.id === id) : undefined;
}

/** Templates the quick setup offers, in its order. */
export const QUICK_SETUP_TEMPLATES: readonly TemplateId[] = [
  "custom",
  "deepseek",
  "qwen",
  "siliconflow",
  "zhipu",
  "kimi",
  "volcengine",
  "ollama",
  "openai",
  "anthropic",
  "gemini",
  "openrouter",
];

/**
 * A new, unsaved connection from a template. `name` is the template's display
 * name (translated by the caller), made unique among `takenNames`.
 */
export function connectionFromTemplate(
  template: ProviderTemplate,
  name: string,
  takenNames: Iterable<string>,
): LlmConnection {
  const connection = blankConnection(template.kind);
  return {
    ...connection,
    name: uniqueName(name, takenNames),
    template: template.id,
    base_url: template.baseUrl,
    auth: { ...template.auth },
    headers: (template.headers ?? []).map((h) => ({ ...h, secret: false })),
    models_endpoint: template.modelsEndpoint ?? connection.models_endpoint,
    default_model: template.defaultModel ?? null,
    compat: { ...connection.compat, ...template.compat },
  };
}
