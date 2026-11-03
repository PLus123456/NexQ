// The "Answer completeness" section against a fake backend: each switch and
// select saves one patch at once, the LLM-backed switches start off, and
// chapter summaries can't be turned on without heading splitting.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

import { changeUiLanguage } from "../../i18n";
import type { RagSettingsView } from "../../lib/rag/types";
import { useRagStore } from "../../stores/ragStore";
import { memoryStorage } from "../../test/memoryStorage";
import { RetrievalSection } from "./RetrievalSection";

type Backend = Record<string, any>;

function defaults(): Backend {
  return {
    splitting_strategy: "headings",
    expansion: { enabled: true, neighbors: 1, section_max_tokens: 2000, max_total_tokens: 16000 },
    rewrite: { enabled: false, variants: 3, timeout_ms: 5000 },
    summaries: { enabled: false, max_input_tokens: 32000, timeout_secs: 180 },
  };
}

let backend: Backend = defaults();

function view(): RagSettingsView {
  return {
    config: { top_k: 5, ...structuredClone(backend) } as unknown as RagSettingsView["config"],
    effective: { query_prefix: "", document_prefix: "", max_input_tokens: 2048, concurrency: 4 },
    connections: [],
  };
}

async function handle(cmd: string, args?: any): Promise<unknown> {
  switch (cmd) {
    case "rag_update_config": {
      for (const [key, value] of Object.entries(args.patch)) {
        backend[key] = value !== null && typeof value === "object" ? { ...backend[key], ...value } : value;
      }
      return view();
    }
    case "rag_get_index_info":
      return { job: null, needs_rebuild: false };
    default:
      throw new Error(`unexpected command ${cmd}`);
  }
}

function patches(): any[] {
  return invoke.mock.calls.filter(([c]) => c === "rag_update_config").map(([, args]) => args.patch);
}

function lastPatch(): any {
  const all = patches();
  return all[all.length - 1];
}

beforeEach(() => {
  backend = defaults();
  vi.stubGlobal("localStorage", memoryStorage());
  invoke.mockReset();
  invoke.mockImplementation(handle);
  useRagStore.setState({ settings: view() });
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await changeUiLanguage("en");
});

describe("RetrievalSection", () => {
  it("starts with expansion on and the LLM-backed switches off", () => {
    render(<RetrievalSection />);
    expect(screen.getByLabelText("Expand results to their context")).toBeChecked();
    expect(screen.getByLabelText("Split at headings")).toBeChecked();
    expect(screen.getByLabelText("Query rewriting (multi-query)")).not.toBeChecked();
    expect(screen.getByLabelText("Chapter summaries")).not.toBeChecked();
    expect(screen.getByLabelText("Neighbouring chunks")).toHaveValue("1");
    expect(screen.getByLabelText("Whole sections up to")).toHaveValue("2000");
    expect(screen.queryByLabelText("Phrasings")).toBeNull();
  });

  it("saves expansion limits as one patch each", async () => {
    render(<RetrievalSection />);
    fireEvent.change(screen.getByLabelText("Neighbouring chunks"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Whole sections up to"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Context per search"), { target: { value: "32000" } });
    await waitFor(() => expect(patches()).toHaveLength(3));
    expect(patches()).toEqual([
      { expansion: { neighbors: 2 } },
      { expansion: { section_max_tokens: 0 } },
      { expansion: { max_total_tokens: 32000 } },
    ]);
    fireEvent.click(screen.getByLabelText("Expand results to their context"));
    await waitFor(() => expect(lastPatch()).toEqual({ expansion: { enabled: false } }));
    await waitFor(() => expect(screen.queryByLabelText("Neighbouring chunks")).toBeNull());
  });

  it("turns query rewriting on and tunes it", async () => {
    render(<RetrievalSection />);
    fireEvent.click(screen.getByLabelText("Query rewriting (multi-query)"));
    await waitFor(() => expect(screen.getByLabelText("Phrasings")).toHaveValue("3"));
    expect(patches()).toEqual([{ rewrite: { enabled: true } }]);
    fireEvent.change(screen.getByLabelText("Phrasings"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Time limit"), { target: { value: "8000" } });
    await waitFor(() => expect(patches()).toHaveLength(3));
    expect(patches().slice(1)).toEqual([{ rewrite: { variants: 5 } }, { rewrite: { timeout_ms: 8000 } }]);
    expect(screen.getByRole("option", { name: "8 seconds" })).toBeInTheDocument();
  });

  it("needs heading splitting for chapter summaries", async () => {
    render(<RetrievalSection />);
    fireEvent.click(screen.getByLabelText("Chapter summaries"));
    await waitFor(() => expect(patches()).toEqual([{ summaries: { enabled: true } }]));
    fireEvent.click(screen.getByLabelText("Split at headings"));
    await waitFor(() => expect(lastPatch()).toEqual({ splitting_strategy: "recursive" }));
    await waitFor(() => expect(screen.getByText("Needs “Split at headings”.")).toBeInTheDocument());
    // Still on: it can be turned off, not on again.
    expect(screen.getByLabelText("Chapter summaries")).toBeEnabled();
    fireEvent.click(screen.getByLabelText("Chapter summaries"));
    await waitFor(() => expect(screen.getByLabelText("Chapter summaries")).toBeDisabled());
  });

  it("shows nothing for an older backend without the sections", () => {
    useRagStore.setState({ settings: { ...view(), config: { top_k: 5 } as unknown as RagSettingsView["config"] } });
    const { container } = render(<RetrievalSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it("speaks Chinese", async () => {
    await changeUiLanguage("zh-CN");
    render(<RetrievalSection />);
    expect(screen.getByText("回答完整度")).toBeInTheDocument();
    expect(screen.getByLabelText("查询改写（多路查询）")).not.toBeChecked();
    expect(screen.getByRole("option", { name: "前后各 2 块" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "2,000 token" })).toBeInTheDocument();
  });
});
