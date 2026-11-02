// The embedding section with a reused LLM connection that was deleted: the
// page shows the own fields, so what it saves (or tests) must not carry the
// old connection id, and it can be saved without editing anything.

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    get: async () => undefined,
    set: async () => {},
    save: async () => {},
    onKeyChange: async () => () => {},
  }),
}));

import type { EmbeddingConfig, RagConnectionSummary, RagSettingsView } from "../../lib/rag/types";
import { useRagStore } from "../../stores/ragStore";
import { memoryStorage } from "../../test/memoryStorage";
import { EmbeddingSection } from "./EmbeddingSection";

function embeddingConfig(over: Partial<EmbeddingConfig> = {}): EmbeddingConfig {
  return {
    provider: "openai_compat",
    connection_id: "",
    base_url: "",
    auth: { mode: "bearer", header_name: "", prefix: "" },
    headers: [],
    key_saved: false,
    key_hint: "",
    model: "bge-m3",
    dimensions: null,
    request_dimensions: false,
    encoding_format: "float",
    batch_size: 32,
    max_concurrency: 0,
    max_input_tokens: 0,
    prefixes_auto: true,
    query_prefix: "",
    document_prefix: "",
    extra_body_query: {},
    extra_body_document: {},
    request_timeout_secs: 60,
    query_timeout_secs: 5,
    ...over,
  };
}

const SILICONFLOW: RagConnectionSummary = {
  id: "sf",
  name: "SiliconFlow",
  kind: "openai_compat",
  base_url: "https://api.siliconflow.cn/v1",
};

const backend = { embedding: embeddingConfig(), connections: [SILICONFLOW] as RagConnectionSummary[] };

function view(): RagSettingsView {
  return {
    config: { embedding: structuredClone(backend.embedding) } as unknown as RagSettingsView["config"],
    effective: { query_prefix: "", document_prefix: "", max_input_tokens: 8000, concurrency: 4 },
    connections: backend.connections,
  };
}

async function handle(cmd: string, args?: any): Promise<unknown> {
  switch (cmd) {
    case "rag_update_config": {
      const { key_saved: _saved, key_hint: _hint, ...patch } = args.patch.embedding ?? {};
      backend.embedding = { ...backend.embedding, ...patch };
      return view();
    }
    case "rag_test_embedding":
      return { ok: true, url: "http://localhost:8000/v1/embeddings", latency_ms: 40, dims: 1024, dimensions_respected: null, error: null, error_kind: null, hint: null };
    case "rag_get_index_info":
      return { job: null, needs_rebuild: false };
    default:
      throw new Error(`unexpected command ${cmd}`);
  }
}

const saves = () => invoke.mock.calls.filter(([c]) => c === "rag_update_config").map(([, args]) => args.patch.embedding);

function renderWith(embedding: Partial<EmbeddingConfig>) {
  backend.embedding = embeddingConfig(embedding);
  useRagStore.setState({ settings: view(), indexInfo: null, embeddingTest: null, isTestingEmbedding: false });
  render(<EmbeddingSection />);
}

const GONE = "The LLM connection reused here no longer exists. Save to use the address and key below instead.";

beforeEach(() => {
  backend.connections = [SILICONFLOW];
  vi.stubGlobal("localStorage", memoryStorage());
  invoke.mockReset();
  invoke.mockImplementation(handle);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("embedding settings: a reused connection that was deleted", () => {
  it("is shown as the own address and saved without the old connection id, no edit needed", async () => {
    const user = userEvent.setup();
    renderWith({ connection_id: "deleted-llm", base_url: "http://localhost:8000/v1" });
    expect(screen.getByLabelText("Connection")).toHaveValue("");
    expect(screen.getByText(GONE)).toBeInTheDocument();
    expect(screen.getByLabelText("Base URL")).toHaveValue("http://localhost:8000/v1");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard changes" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(saves()[0]).toMatchObject({ connection_id: "", base_url: "http://localhost:8000/v1", model: "bge-m3" });
    await waitFor(() => expect(screen.queryByText(GONE)).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(backend.embedding.connection_id).toBe("");
  });

  it("drops the old id from an edited draft too, after the privacy confirmation", async () => {
    const user = userEvent.setup();
    backend.connections = [];
    renderWith({ connection_id: "deleted-llm" });
    // No connections left: the picker is hidden, the warning still shows.
    expect(screen.queryByLabelText("Connection")).not.toBeInTheDocument();
    expect(screen.getByText(GONE)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Base URL"), "https://api.example.com/v1");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.click(await screen.findByRole("button", { name: "Send and save" }));
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(saves()[0]).toMatchObject({ connection_id: "", base_url: "https://api.example.com/v1" });
  });

  it("tests the own address, not the deleted connection", async () => {
    const user = userEvent.setup();
    renderWith({ connection_id: "deleted-llm", base_url: "http://localhost:8000/v1" });
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("rag_test_embedding", expect.anything()));
    const draft = invoke.mock.calls.find(([c]) => c === "rag_test_embedding")![1].draft;
    expect(draft.embedding).toMatchObject({ connection_id: "", base_url: "http://localhost:8000/v1" });
  });

  it("keeps a connection that still exists", async () => {
    const user = userEvent.setup();
    renderWith({ connection_id: "sf" });
    expect(screen.getByLabelText("Connection")).toHaveValue("sf");
    expect(screen.queryByText(GONE)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Base URL")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.clear(screen.getByLabelText("Model"));
    await user.type(screen.getByLabelText("Model"), "BAAI/bge-m3{Enter}");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.click(await screen.findByRole("button", { name: "Send and save" }));
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(saves()[0]).toMatchObject({ connection_id: "sf", model: "BAAI/bge-m3" });
  });
});
