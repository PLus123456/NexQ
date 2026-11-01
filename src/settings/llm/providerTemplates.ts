// Built-in provider templates for new LLM connections. A template only fills
// in the form: every field stays editable, and adding a vendor never needs a
// Rust change (OpenAI-compatible vendors share one protocol). Names and notes
// are in the `llm` namespace (`templates.items.<id>.*`).
//
// Addresses, auth styles, model ids and thinking switches were checked
// against each vendor's documentation on 2026-11-01; suggested models are
// only candidates (any id can be typed) and age quickly.

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
   * Extra request body that turns thinking off (or to its lowest level where
   * it can't be off) on this vendor's API, offered for fast tasks such as
   * live translation. Not every model of a vendor accepts it.
   */
  disableThinking?: Record<string, unknown>;
  /** The vendor documents its base URL without a version prefix (no "/v1" hint). */
  noVersionPrefix?: boolean;
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
    // Documented without a version prefix.
    baseUrl: "https://api.deepseek.com",
    noVersionPrefix: true,
    auth: BEARER,
    suggestedModels: ["deepseek-flash", "deepseek-v4-pro"],
    defaultModel: "deepseek-flash",
    disableThinking: THINKING_TYPE_DISABLED,
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
    suggestedModels: ["qwen-plus", "qwen-flash", "qwen3.8-max", "qwen3.7-plus", "qwen3.8-flash"],
    // A rolling alias whose thinking is off by default.
    defaultModel: "qwen-plus",
    disableThinking: ENABLE_THINKING_FALSE,
    needsKey: true,
    keyUrl: "https://bailian.console.aliyun.com/model/settings/api-key",
  },
  {
    id: "zhipu",
    group: "china",
    kind: "openai_compat",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    altBaseUrls: [{ id: "international", url: "https://api.z.ai/api/paas/v4" }],
    auth: BEARER,
    // No documented model list on the data plane.
    modelsEndpoint: "disabled",
    suggestedModels: ["glm-5.2", "glm-5.3", "glm-5.3-flash", "glm-5.3-flashx", "glm-4.7-flash"],
    // glm-5.3* always think; glm-5.2 can turn it off.
    defaultModel: "glm-5.2",
    disableThinking: THINKING_TYPE_DISABLED,
    needsKey: true,
    keyUrl: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
  },
  {
    id: "kimi",
    group: "china",
    kind: "openai_compat",
    baseUrl: "https://api.moonshot.cn/v1",
    altBaseUrls: [{ id: "international", url: "https://api.moonshot.ai/v1" }],
    auth: BEARER,
    suggestedModels: ["kimi-k3.1-pro-highspeed", "kimi-k3.1-pro", "kimi-k3", "kimi-k2.6"],
    defaultModel: "kimi-k3.1-pro-highspeed",
    // Temperature is fixed on current Kimi models: any other value is an error.
    compat: { temperature: "omit" },
    // K3 models always reason; the lowest effort is "low".
    disableThinking: { reasoning_effort: "low" },
    needsKey: true,
    keyUrl: "https://platform.kimi.com/console/api-keys",
  },
  {
    id: "volcengine",
    group: "china",
    kind: "openai_compat",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    auth: BEARER,
    // Model listing is a signed control-plane API, not this endpoint.
    modelsEndpoint: "disabled",
    suggestedModels: ["doubao-seed-2-1-lite-260915", "doubao-seed-2-1-pro-260915", "doubao-seed-2-1-turbo-260628", "doubao-seed-2-0-lite-260428"],
    defaultModel: "doubao-seed-2-1-lite-260915",
    disableThinking: THINKING_TYPE_DISABLED,
    needsKey: true,
    keyUrl: "https://console.volcengine.com/ark",
  },
  {
    id: "siliconflow",
    group: "china",
    kind: "openai_compat",
    baseUrl: "https://api.siliconflow.cn/v1",
    altBaseUrls: [{ id: "international", url: "https://api.siliconflow.com/v1" }],
    auth: BEARER,
    suggestedModels: ["deepseek-ai/DeepSeek-V4-Flash", "Pro/deepseek-ai/DeepSeek-V4", "Pro/zai-org/GLM-5.2", "Qwen/Qwen3.6-27B"],
    defaultModel: "deepseek-ai/DeepSeek-V4-Flash",
    disableThinking: ENABLE_THINKING_FALSE,
    needsKey: true,
    keyUrl: "https://cloud.siliconflow.cn/account/ak",
  },
  {
    id: "minimax",
    group: "china",
    kind: "openai_compat",
    baseUrl: "https://api.minimax.cn/v1",
    altBaseUrls: [{ id: "international", url: "https://api.minimax.io/v1" }],
    auth: BEARER,
    suggestedModels: ["MiniMax-M3", "MiniMax-M3.1-Flash"],
    defaultModel: "MiniMax-M3",
    disableThinking: THINKING_TYPE_DISABLED,
    needsKey: true,
    keyUrl: "https://platform.minimax.cn/user-center/basic-information/interface-key",
  },
  {
    id: "qianfan",
    group: "china",
    kind: "openai_compat",
    baseUrl: "https://qianfan.baidubce.com/v2",
    auth: BEARER,
    suggestedModels: ["ernie-5.1", "deepseek-v4.1-flash", "deepseek-v4-pro", "glm-5.3", "qwen3.5-397b-a17b"],
    defaultModel: "ernie-5.1",
    needsKey: true,
    keyUrl: "https://console.bce.baidu.com/iam/#/iam/apikey/list",
  },
  {
    id: "hunyuan",
    group: "china",
    kind: "openai_compat",
    // Tencent is moving Hunyuan to TokenHub (the old host keeps working for existing users).
    baseUrl: "https://tokenhub.tencentmaas.com/v1",
    altBaseUrls: [{ id: "international", url: "https://tokenhub-intl.tencentmaas.com/v1" }],
    auth: BEARER,
    suggestedModels: ["hy3", "hy4-preview"],
    defaultModel: "hy3",
    disableThinking: THINKING_TYPE_DISABLED,
    needsKey: true,
    keyUrl: "https://console.cloud.tencent.com/tokenhub/apikey",
  },
  {
    id: "stepfun",
    group: "china",
    kind: "openai_compat",
    baseUrl: "https://api.stepfun.com/v1",
    altBaseUrls: [{ id: "international", url: "https://api.stepfun.ai/v1" }],
    auth: BEARER,
    suggestedModels: ["step-3.5-flash", "step-3.7-flash", "step-5-preview"],
    defaultModel: "step-3.5-flash",
    // Reasoning models without an off switch: the lowest effort.
    disableThinking: { reasoning_effort: "low" },
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
    suggestedModels: ["gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna", "gpt-4.1-mini"],
    defaultModel: "gpt-6.1-terra",
    // Reasoning models take only max_completion_tokens and reject temperature.
    compat: { max_tokens_field: "max_completion_tokens", temperature: "omit" },
    disableThinking: { reasoning_effort: "none" },
    needsKey: true,
    keyUrl: "https://platform.openai.com/settings/organization/api-keys",
  },
  {
    id: "anthropic",
    group: "international",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com",
    auth: header("x-api-key"),
    suggestedModels: ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5", "claude-fable-5-1"],
    defaultModel: "claude-sonnet-5-5",
    // Claude 5 models reject sampling parameters (see llm/anthropic.rs).
    compat: { temperature: "omit" },
    needsKey: true,
    keyUrl: "https://platform.claude.com/settings/keys",
  },
  {
    id: "gemini",
    group: "international",
    kind: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    auth: header("x-goog-api-key"),
    suggestedModels: ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-4-argon", "gemini-3.6-flash"],
    defaultModel: "gemini-3.8-flash",
    needsKey: true,
    keyUrl: "https://aistudio.google.com/apikey",
  },
  {
    id: "openrouter",
    group: "international",
    kind: "openai_compat",
    baseUrl: "https://openrouter.ai/api/v1",
    auth: BEARER,
    // Optional app attribution.
    headers: [
      { name: "HTTP-Referer", value: REPO_URL },
      { name: "X-OpenRouter-Title", value: APP_NAME },
    ],
    suggestedModels: ["openrouter/auto", "deepseek/deepseek-v4.1-flash", "google/gemini-3.8-flash", "anthropic/claude-sonnet-5.5", "openai/gpt-6.1-sol"],
    defaultModel: "openrouter/auto",
    disableThinking: { reasoning: { enabled: false } },
    needsKey: true,
    keyUrl: "https://openrouter.ai/keys",
  },
  {
    id: "groq",
    group: "international",
    kind: "openai_compat",
    baseUrl: "https://api.groq.com/openai/v1",
    auth: BEARER,
    suggestedModels: ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "openai/gpt-oss-20b", "llama-3.1-8b-instant"],
    defaultModel: "llama-3.3-70b-versatile",
    compat: { max_tokens_field: "max_completion_tokens" },
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
    // Lists the catalogue, not your deployments.
    modelsEndpoint: "disabled",
    suggestedModels: [],
    compat: { max_tokens_field: "max_completion_tokens", temperature: "omit" },
    needsKey: true,
    keyUrl: "https://portal.azure.com/",
  },
  {
    id: "xai",
    group: "international",
    kind: "openai_compat",
    baseUrl: "https://api.x.ai/v1",
    auth: BEARER,
    suggestedModels: ["grok-4.7", "grok-4.3", "grok-4.20-0309-non-reasoning", "grok-4.6"],
    defaultModel: "grok-4.7",
    needsKey: true,
    keyUrl: "https://console.x.ai/team/default/api-keys",
  },
  {
    id: "mistral",
    group: "international",
    kind: "openai_compat",
    baseUrl: "https://api.mistral.ai/v1",
    auth: BEARER,
    suggestedModels: ["mistral-small-2603", "mistral-large-4", "ministral-14b-2512", "codestral-2508"],
    defaultModel: "mistral-small-2603",
    disableThinking: { reasoning_effort: "none" },
    needsKey: true,
    keyUrl: "https://admin.mistral.ai/organization/api-keys",
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
    disableThinking: { think: false },
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
    // vLLM serving Qwen3 and similar hybrid models.
    disableThinking: { chat_template_kwargs: { enable_thinking: false } },
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
  "kimi",
  "volcengine",
  "minimax",
  "hunyuan",
  "openai",
  "anthropic",
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
