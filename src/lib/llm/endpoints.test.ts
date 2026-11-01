import { describe, expect, it } from "vitest";
import { blankConnection } from "./connection";
import { chatPath, chatUrl, looksLikeOpenAiPath, modelsUrl, secretOrigins } from "./endpoints";
import type { LlmConnection, LlmKind } from "./types";

function conn(kind: LlmKind, base_url: string, patch: Partial<LlmConnection> = {}): LlmConnection {
  return { ...blankConnection(kind, "c_test0001"), base_url, ...patch };
}

const url = (preview: ReturnType<typeof chatUrl>) => (preview.ok ? preview.url : preview.reason);

describe("chat and models URLs by protocol", () => {
  it("OpenAI-compatible: base as typed + fixed path, /v1 never added", () => {
    expect(url(chatUrl(conn("openai_compat", "https://open.bigmodel.cn/api/paas/v4/")))).toBe(
      "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    );
    expect(url(chatUrl(conn("openai_compat", "http://192.168.1.10:8000")))).toBe("http://192.168.1.10:8000/chat/completions");
    expect(url(modelsUrl(conn("openai_compat", "https://ark.cn-beijing.volces.com/api/v3")))).toBe(
      "https://ark.cn-beijing.volces.com/api/v3/models",
    );
  });

  it("Anthropic: /v1/messages, without repeating a /v1 the base already has", () => {
    expect(url(chatUrl(conn("anthropic", "https://api.anthropic.com")))).toBe("https://api.anthropic.com/v1/messages");
    expect(url(chatUrl(conn("anthropic", "https://api.anthropic.com/v1/")))).toBe("https://api.anthropic.com/v1/messages");
    expect(url(chatUrl(conn("anthropic", "https://api.deepseek.com/anthropic")))).toBe(
      "https://api.deepseek.com/anthropic/v1/messages",
    );
    expect(url(modelsUrl(conn("anthropic", "https://api.anthropic.com/v1")))).toBe("https://api.anthropic.com/v1/models");
    expect(chatPath("anthropic", "https://api.anthropic.com/v1")).toBe("/messages");
  });

  it("Gemini: the model in the path and ?alt=sse; {model} until one is chosen", () => {
    const gemini = conn("gemini", "https://generativelanguage.googleapis.com");
    expect(url(chatUrl(gemini, "gemini-2.5-flash"))).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
    );
    expect(url(chatUrl(gemini))).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse",
    );
    expect(url(modelsUrl(conn("gemini", "https://generativelanguage.googleapis.com/v1beta")))).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models",
    );
  });

  it("Ollama: native paths, and a hint when the base looks OpenAI-compatible", () => {
    expect(url(chatUrl(conn("ollama", "http://192.168.1.20:11434")))).toBe("http://192.168.1.20:11434/api/chat");
    expect(url(modelsUrl(conn("ollama", "http://localhost:11434")))).toBe("http://localhost:11434/api/tags");
    expect(looksLikeOpenAiPath("ollama", "http://localhost:11434/v1")).toBe(true);
    expect(looksLikeOpenAiPath("ollama", "http://localhost:11434")).toBe(false);
  });

  it("chat URL override wins and gets the model filled in", () => {
    const azure = conn("openai_compat", "https://x.openai.azure.com/openai/v1", {
      chat_url_override: "https://x.openai.azure.com/openai/deployments/{model}/chat/completions?api-version=2024-10-21",
    });
    expect(url(chatUrl(azure, "gpt 4o"))).toBe(
      "https://x.openai.azure.com/openai/deployments/gpt%204o/chat/completions?api-version=2024-10-21",
    );
    expect(url(chatUrl({ ...azure, chat_url_override: "not a url" }))).toBe("invalid");
  });

  it("models address: custom, or off", () => {
    expect(url(modelsUrl(conn("openai_compat", "https://h.example/v1", { models_endpoint: { mode: "disabled" } })))).toBe(
      "none",
    );
    expect(
      url(
        modelsUrl(conn("openai_compat", "https://h.example/v1", { models_endpoint: { mode: "custom", url: "https://h.example/catalog" } })),
      ),
    ).toBe("https://h.example/catalog");
  });

  it("empty and invalid bases", () => {
    expect(url(chatUrl(conn("openai_compat", "")))).toBe("empty");
    expect(url(chatUrl(conn("openai_compat", "api.example.com/v1")))).toBe("invalid");
    expect(url(chatUrl(conn("claude_cli", "")))).toBe("none");
  });
});

describe("secretOrigins", () => {
  it("collects every host the key would be sent to", () => {
    const origins = secretOrigins(
      conn("openai_compat", "https://api.example.com/v1", {
        chat_url_override: "https://gw.example.com/{model}/chat",
        models_endpoint: { mode: "custom", url: "http://10.0.0.5:8000/models" },
      }),
    );
    expect([...origins].sort()).toEqual(["http://10.0.0.5:8000", "https://api.example.com", "https://gw.example.com"]);
  });

  it("a path change keeps the origin", () => {
    const a = secretOrigins(conn("openai_compat", "https://api.example.com"));
    const b = secretOrigins(conn("openai_compat", "https://API.example.com:443/v1/"));
    expect([...a]).toEqual([...b]);
  });
});
