// Embedding service templates for the knowledge base settings: they only
// prefill the form, every field stays editable. Base URLs include the
// version prefix (it is never added automatically). Check a provider's
// own documentation when a request fails: these addresses and model ids
// change over time.

import type { EmbeddingProvider } from "./types";

export interface EmbeddingModelPreset {
  id: string;
  /** Vector size, shown as a hint (the settings keep "auto" unless the user sets one). */
  dims?: number;
  /** The model accepts a `dimensions` request field. */
  acceptsDimensions?: boolean;
}

export interface EmbeddingPreset {
  id: string;
  /** i18n key under `rag:embedding.presets.` (names that differ by language) or a brand name. */
  nameKey?: string;
  name?: string;
  provider: EmbeddingProvider;
  baseUrl: string;
  /** Needs an API key (bearer). */
  needsKey: boolean;
  models: EmbeddingModelPreset[];
  /** The service limits how many inputs one request may carry. */
  maxBatch?: number;
  extraBodyQuery?: Record<string, unknown>;
  extraBodyDocument?: Record<string, unknown>;
}

export const EMBEDDING_PRESETS: EmbeddingPreset[] = [
  {
    id: "custom",
    nameKey: "custom",
    provider: "openai_compat",
    baseUrl: "",
    needsKey: false,
    models: [],
  },
  {
    id: "openai",
    name: "OpenAI",
    provider: "openai_compat",
    baseUrl: "https://api.openai.com/v1",
    needsKey: true,
    models: [
      { id: "text-embedding-3-small", dims: 1536, acceptsDimensions: true },
      { id: "text-embedding-3-large", dims: 3072, acceptsDimensions: true },
      { id: "text-embedding-ada-002", dims: 1536 },
    ],
  },
  {
    id: "siliconflow",
    nameKey: "siliconflow",
    provider: "openai_compat",
    baseUrl: "https://api.siliconflow.cn/v1",
    needsKey: true,
    models: [
      { id: "BAAI/bge-m3", dims: 1024 },
      { id: "Qwen/Qwen3-Embedding-8B", dims: 4096 },
      { id: "Qwen/Qwen3-Embedding-4B", dims: 2560 },
      { id: "Qwen/Qwen3-Embedding-0.6B", dims: 1024 },
      { id: "BAAI/bge-large-zh-v1.5", dims: 1024 },
      { id: "netease-youdao/bce-embedding-base_v1", dims: 768 },
    ],
  },
  {
    id: "dashscope",
    nameKey: "dashscope",
    provider: "openai_compat",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    needsKey: true,
    maxBatch: 10,
    models: [
      { id: "text-embedding-v4", dims: 1024, acceptsDimensions: true },
      { id: "text-embedding-v3", dims: 1024, acceptsDimensions: true },
    ],
  },
  {
    id: "zhipu",
    nameKey: "zhipu",
    provider: "openai_compat",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    needsKey: true,
    models: [
      { id: "embedding-3", dims: 2048, acceptsDimensions: true },
      { id: "embedding-2", dims: 1024 },
    ],
  },
  {
    id: "volcengine",
    nameKey: "volcengine",
    provider: "openai_compat",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    needsKey: true,
    models: [],
  },
  {
    id: "jina",
    name: "Jina AI",
    provider: "openai_compat",
    baseUrl: "https://api.jina.ai/v1",
    needsKey: true,
    models: [{ id: "jina-embeddings-v3", dims: 1024, acceptsDimensions: true }],
    extraBodyQuery: { task: "retrieval.query" },
    extraBodyDocument: { task: "retrieval.passage" },
  },
  {
    id: "gemini",
    name: "Google Gemini",
    provider: "openai_compat",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    needsKey: true,
    models: [
      { id: "gemini-embedding-001", dims: 3072, acceptsDimensions: true },
      { id: "text-embedding-004", dims: 768 },
    ],
  },
  {
    id: "ollama",
    nameKey: "ollama",
    provider: "ollama",
    baseUrl: "http://localhost:11434",
    needsKey: false,
    models: [
      { id: "bge-m3", dims: 1024 },
      { id: "nomic-embed-text", dims: 768 },
      { id: "mxbai-embed-large", dims: 1024 },
      { id: "qwen3-embedding", dims: 4096 },
      { id: "all-minilm", dims: 384 },
    ],
  },
  {
    id: "selfhosted",
    nameKey: "selfhosted",
    provider: "openai_compat",
    baseUrl: "http://192.168.1.10:8000/v1",
    needsKey: false,
    models: [],
  },
];

/** Every known model id with its size, for the model field's suggestions. */
export function modelSuggestions(provider: EmbeddingProvider, presetId?: string): EmbeddingModelPreset[] {
  const fromPreset = presetId ? EMBEDDING_PRESETS.find((p) => p.id === presetId)?.models : undefined;
  if (fromPreset && fromPreset.length > 0) return fromPreset;
  const seen = new Set<string>();
  const out: EmbeddingModelPreset[] = [];
  for (const preset of EMBEDDING_PRESETS) {
    if (preset.provider !== provider) continue;
    for (const model of preset.models) {
      if (!seen.has(model.id)) {
        seen.add(model.id);
        out.push(model);
      }
    }
  }
  return out;
}

/** The template whose base URL the address starts with, if any. */
export function presetForBaseUrl(baseUrl: string): EmbeddingPreset | undefined {
  const normalized = baseUrl.trim().replace(/\/+$/, "").toLowerCase();
  if (!normalized) return undefined;
  return EMBEDDING_PRESETS.find(
    (p) => p.baseUrl && p.id !== "selfhosted" && normalized.startsWith(p.baseUrl.toLowerCase()),
  );
}

/** Whether a base URL points at this machine (no privacy prompt needed). */
export function isLocalAddress(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl.trim()).hostname.toLowerCase();
    return host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || host === "::1" || /^127\./.test(host);
  } catch {
    return false;
  }
}

/** The host a base URL sends documents to ("" when it doesn't parse). */
export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl.trim()).host;
  } catch {
    return "";
  }
}
