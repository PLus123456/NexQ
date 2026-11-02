// The rerank settings section against a fake backend: the draft is saved
// as one `rerank` patch (after the privacy confirmation for a remote host),
// the key goes to the keychain command only, the test button sends the
// draft, and only OpenAI-compatible LLM connections can be reused.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

import type { RagConnectionSummary, RagSettingsView, RerankConfig, RerankTestResult } from "../../lib/rag/types";
import { useRagStore } from "../../stores/ragStore";
import { memoryStorage } from "../../test/memoryStorage";
import { RerankSection } from "./RerankSection";

function rerankConfig(over: Partial<RerankConfig> = {}): RerankConfig {
  return {
    enabled: false,
    connection_id: "",
    base_url: "",
    auth: { mode: "bearer", header_name: "", prefix: "" },
    headers: [],
    key_saved: false,
    key_hint: "",
    model: "",
    format: "generic",
    candidates: 30,
    timeout_ms: 2500,
    ...over,
  };
}

const backend = {
  rerank: rerankConfig(),
  connections: [] as RagConnectionSummary[],
  test: null as RerankTestResult | Error | null,
};

function view(): RagSettingsView {
  return {
    config: { top_k: 5, rerank: structuredClone(backend.rerank) } as unknown as RagSettingsView["config"],
    effective: { query_prefix: "", document_prefix: "", max_input_tokens: 2048, concurrency: 4 },
    connections: backend.connections,
  };
}

/** Rust's side of the commands the section calls. */
async function handle(cmd: string, args?: any): Promise<unknown> {
  switch (cmd) {
    case "rag_update_config": {
      const { key_saved: _saved, key_hint: _hint, ...patch } = args.patch.rerank ?? {};
      backend.rerank = { ...backend.rerank, ...patch };
      return view();
    }
    case "rag_set_rerank_secret":
      backend.rerank = { ...backend.rerank, key_saved: !!args.secret, key_hint: args.secret ? String(args.secret).slice(-4) : "" };
      return view();
    case "rag_test_rerank":
      if (backend.test instanceof Error) throw backend.test;
      return backend.test;
    case "rag_get_index_info":
      return { job: null, needs_rebuild: false };
    default:
      throw new Error(`unexpected command ${cmd}`);
  }
}

function calls(cmd: string): any[] {
  return invoke.mock.calls.filter(([c]) => c === cmd).map(([, args]) => args);
}

beforeEach(() => {
  backend.rerank = rerankConfig();
  backend.connections = [];
  backend.test = null;
  vi.stubGlobal("localStorage", memoryStorage());
  invoke.mockReset();
  invoke.mockImplementation(handle);
  useRagStore.setState({ settings: view(), rerankTest: null, isTestingRerank: false });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("rerank settings", () => {
  it("saves the switch and the endpoint as one rerank patch after the privacy confirmation", async () => {
    const user = userEvent.setup();
    render(<RerankSection />);
    const toggle = screen.getByRole("switch", { name: "Rerank search results" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(screen.getByText(/Set a Base URL \(or pick a connection\) and a model/)).toBeInTheDocument();
    expect(screen.getByText(/sends up to 30 retrieved chunks/)).toBeInTheDocument();

    await user.type(screen.getByLabelText("Base URL"), "https://api.siliconflow.cn/v1");
    // The model field commits on Enter (or when it loses focus).
    await user.type(screen.getByLabelText("Model"), "BAAI/bge-reranker-v2-m3{Enter}");
    expect(screen.queryByText(/Set a Base URL/)).not.toBeInTheDocument();
    expect(screen.getByText("https://api.siliconflow.cn/v1/rerank")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Candidates"), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("Timeout (ms)"), { target: { value: "1500" } });

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(
      screen.getByText("Retrieved document chunks and your questions will be sent to api.siliconflow.cn for reranking."),
    ).toBeInTheDocument();
    expect(calls("rag_update_config")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Send and save" }));
    await waitFor(() => expect(calls("rag_update_config")).toHaveLength(1));
    const patch = calls("rag_update_config")[0].patch;
    expect(Object.keys(patch)).toEqual(["rerank"]);
    expect(patch.rerank).toEqual({
      enabled: true,
      connection_id: "",
      base_url: "https://api.siliconflow.cn/v1",
      auth: { mode: "bearer", header_name: "", prefix: "" },
      headers: [],
      model: "BAAI/bge-reranker-v2-m3",
      format: "generic",
      candidates: 20,
      timeout_ms: 1500,
    });
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument());
    expect(screen.getByRole("switch", { name: "Rerank search results" })).toHaveAttribute("aria-checked", "true");

    // The host is remembered: the next save doesn't ask again.
    fireEvent.change(screen.getByLabelText("Timeout (ms)"), { target: { value: "2000" } });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls("rag_update_config")).toHaveLength(2));
    expect(calls("rag_update_config")[1].patch.rerank.timeout_ms).toBe(2000);
  });

  it("asks nothing while reranking stays off, and Discard restores the saved values", async () => {
    const user = userEvent.setup();
    render(<RerankSection />);
    await user.type(screen.getByLabelText("Base URL"), "https://api.jina.ai/v1");
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.getByLabelText("Base URL")).toHaveValue("");
    await user.type(screen.getByLabelText("Base URL"), "https://api.jina.ai/v1");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls("rag_update_config")).toHaveLength(1));
    expect(screen.queryByText(/will be sent to/)).not.toBeInTheDocument();
    expect(backend.rerank).toMatchObject({ enabled: false, base_url: "https://api.jina.ai/v1" });
  });

  it("sends the key to the keychain command only", async () => {
    const user = userEvent.setup();
    render(<RerankSection />);
    await user.type(screen.getByLabelText("API Key"), "rk-test-key-9876");
    await user.tab();
    await waitFor(() => expect(calls("rag_set_rerank_secret")).toEqual([{ secret: "rk-test-key-9876" }]));
    await waitFor(() => expect(screen.getByLabelText("API Key")).toHaveAttribute("placeholder", "Saved …9876"));
    expect(screen.getByLabelText("API Key")).toHaveValue("");

    await user.type(screen.getByLabelText("Model"), "rerank-v3.5{Enter}");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls("rag_update_config")).toHaveLength(1));
    expect(JSON.stringify(calls("rag_update_config")[0])).not.toContain("rk-test-key");

    await user.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(calls("rag_set_rerank_secret")[1]).toEqual({ secret: null }));
  });

  it("tests the saved settings, or the draft on top of them, and shows the result", async () => {
    const user = userEvent.setup();
    backend.rerank = rerankConfig({ enabled: true, base_url: "http://localhost:8080", format: "tei", timeout_ms: 2500 });
    useRagStore.setState({ settings: view() });
    backend.test = {
      ok: true,
      url: "http://localhost:8080/rerank",
      latency_ms: 120,
      ranked_correctly: true,
      error: null,
      error_kind: null,
    };
    render(<RerankSection />);
    expect(screen.getByText("TEI serves a single model: the name can stay empty.")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "TEI" })).toHaveAttribute("aria-checked", "true");

    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Connected · 120 ms")).toBeInTheDocument();
    expect(calls("rag_test_rerank")).toEqual([{ draft: null }]);
    const result = screen.getByRole("status");
    expect(within(result).getByText("The relevant test passage came out on top.")).toBeInTheDocument();
    expect(within(result).getByText("http://localhost:8080/rerank")).toBeInTheDocument();

    // A draft is tested as typed; a slower answer than the timeout is flagged.
    fireEvent.change(screen.getByLabelText("Timeout (ms)"), { target: { value: "300" } });
    backend.test = { ...backend.test, latency_ms: 900, ranked_correctly: false };
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Connected · 900 ms")).toBeInTheDocument();
    expect(calls("rag_test_rerank")[1].draft.rerank).toMatchObject({ timeout_ms: 300, format: "tei" });
    expect(screen.getByText(/did not come out on top/)).toBeInTheDocument();
    expect(screen.getByText(/This took 900 ms, longer than the 300 ms timeout/)).toBeInTheDocument();

    // Failures show the service's answer.
    backend.test = {
      ok: false,
      url: "http://localhost:8080/rerank",
      latency_ms: 15,
      ranked_correctly: null,
      error: "HTTP 401 from http://localhost:8080/rerank: the API key was rejected or lacks access",
      error_kind: "auth",
    };
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Test failed")).toBeInTheDocument();
    expect(screen.getByText(/the API key was rejected/)).toBeInTheDocument();

    // Settings the backend refuses before sending anything.
    backend.test = new Error("No rerank model is set");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("No rerank model is set")).toBeInTheDocument();
    expect(screen.getByText("Test failed")).toBeInTheDocument();
  });

  it("reuses OpenAI-compatible LLM connections only, and drops one that is gone", async () => {
    const user = userEvent.setup();
    backend.connections = [
      { id: "sf", name: "SiliconFlow", kind: "openai_compat", base_url: "https://api.siliconflow.cn/v1" },
      { id: "local", name: "Local Ollama", kind: "ollama", base_url: "http://localhost:11434" },
    ];
    backend.rerank = rerankConfig({ connection_id: "gone", base_url: "", model: "m" });
    useRagStore.setState({ settings: view() });
    render(<RerankSection />);
    const select = screen.getByLabelText("Connection");
    expect(select).toHaveValue("");
    expect(screen.getByRole("option", { name: "SiliconFlow — https://api.siliconflow.cn/v1" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Local Ollama/ })).not.toBeInTheDocument();

    await user.selectOptions(select, "sf");
    expect(screen.queryByLabelText("Base URL")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls("rag_update_config")).toHaveLength(1));
    expect(calls("rag_update_config")[0].patch.rerank.connection_id).toBe("sf");

    // Back to own fields: the saved id is cleared, not kept behind the scenes.
    await user.selectOptions(screen.getByLabelText("Connection"), "");
    await user.type(screen.getByLabelText("Base URL"), "http://localhost:9997/v1");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls("rag_update_config")).toHaveLength(2));
    expect(calls("rag_update_config")[1].patch.rerank).toMatchObject({ connection_id: "", base_url: "http://localhost:9997/v1" });
  });

  it("follows settings saved in another window unless there are unsaved edits", async () => {
    const user = userEvent.setup();
    render(<RerankSection />);
    backend.rerank = rerankConfig({ enabled: true, base_url: "http://localhost:8080", format: "tei" });
    act(() => useRagStore.setState({ settings: view() }));
    expect(screen.getByRole("switch", { name: "Rerank search results" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("Base URL")).toHaveValue("http://localhost:8080");

    await user.clear(screen.getByLabelText("Base URL"));
    await user.type(screen.getByLabelText("Base URL"), "http://localhost:8081");
    backend.rerank = rerankConfig({ enabled: false });
    act(() => useRagStore.setState({ settings: view() }));
    expect(screen.getByLabelText("Base URL")).toHaveValue("http://localhost:8081");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });
});
