// Embedding service templates for the knowledge base settings: they only
// prefill the form, every field stays editable. Base URLs include the
// version prefix (it is never added automatically). Templates name no
// models, since lists written into the app go stale. Check a provider's
// own documentation when a request fails: addresses change over time.

import type { EmbeddingProvider } from "./types";

export interface EmbeddingPreset {
  id: string;
  /** i18n key under `rag:embedding.presets.` (names that differ by language) or a brand name. */
  nameKey?: string;
  name?: string;
  provider: EmbeddingProvider;
  baseUrl: string;
  /** Needs an API key (bearer). */
  needsKey: boolean;
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
  },
  {
    id: "openai",
    name: "OpenAI",
    provider: "openai_compat",
    baseUrl: "https://api.openai.com/v1",
    needsKey: true,
  },
  {
    id: "siliconflow",
    nameKey: "siliconflow",
    provider: "openai_compat",
    baseUrl: "https://api.siliconflow.cn/v1",
    needsKey: true,
  },
  {
    id: "dashscope",
    nameKey: "dashscope",
    provider: "openai_compat",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    needsKey: true,
    maxBatch: 10,
  },
  {
    id: "zhipu",
    nameKey: "zhipu",
    provider: "openai_compat",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    needsKey: true,
  },
  {
    id: "volcengine",
    nameKey: "volcengine",
    provider: "openai_compat",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    needsKey: true,
  },
  {
    id: "jina",
    name: "Jina AI",
    provider: "openai_compat",
    baseUrl: "https://api.jina.ai/v1",
    needsKey: true,
    extraBodyQuery: { task: "retrieval.query" },
    extraBodyDocument: { task: "retrieval.passage" },
  },
  {
    id: "gemini",
    name: "Google Gemini",
    provider: "openai_compat",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    needsKey: true,
  },
  {
    id: "ollama",
    nameKey: "ollama",
    provider: "ollama",
    baseUrl: "http://localhost:11434",
    needsKey: false,
  },
  {
    id: "selfhosted",
    nameKey: "selfhosted",
    provider: "openai_compat",
    baseUrl: "http://192.168.1.10:8000/v1",
    needsKey: false,
  },
];

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
