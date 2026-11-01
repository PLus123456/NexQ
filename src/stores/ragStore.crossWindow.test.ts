// Two windows (launcher + overlay) each have their own ragStore. The
// knowledge base settings live in Rust: a save in one window makes Rust emit
// `rag_config_changed` to every window, and indexing progress
// (`rag_index_progress`) is emitted to every window too. This models Rust
// with one shared config and a broadcast to every window's listeners.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = { event: string; cb: (e: { payload: unknown }) => void };
const listeners = vi.hoisted(() => [] as Listener[]);
const backend = vi.hoisted(() => ({ config: {} as Record<string, any>, secret: null as string | null }));
const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, cb: (e: { payload: unknown }) => void) => {
    const entry = { event, cb };
    listeners.push(entry);
    return () => {
      const i = listeners.indexOf(entry);
      if (i >= 0) listeners.splice(i, 1);
    };
  },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));

vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    get: async () => undefined,
    set: async () => {},
    save: async () => {},
    onKeyChange: async () => () => {},
  }),
}));

function broadcast(event: string, payload: unknown) {
  for (const l of [...listeners]) if (l.event === event) l.cb({ payload: structuredClone(payload) });
}

function view() {
  return {
    config: structuredClone(backend.config),
    effective: { query_prefix: "", document_prefix: "", max_input_tokens: 2048, concurrency: 4 },
    connections: [],
  };
}

function freshConfig() {
  return {
    enabled: false,
    top_k: 5,
    search_mode: "hybrid",
    chunk_size: 512,
    chunk_overlap: 64,
    embedding: { provider: "openai_compat", base_url: "", model: "", key_saved: false, key_hint: "" },
  };
}

/** Rust's side of the commands this store calls. */
async function handle(cmd: string, args?: any): Promise<unknown> {
  switch (cmd) {
    case "rag_get_settings":
      return view();
    case "rag_update_config": {
      const patch = args.patch as Record<string, any>;
      for (const [k, v] of Object.entries(patch)) {
        backend.config[k] =
          v && typeof v === "object" && !Array.isArray(v) ? { ...(backend.config[k] ?? {}), ...v } : v;
      }
      const next = view();
      broadcast("rag_config_changed", next);
      return next;
    }
    case "rag_set_secret": {
      backend.secret = args.secret;
      backend.config.embedding = {
        ...backend.config.embedding,
        key_saved: !!args.secret,
        key_hint: args.secret ? String(args.secret).slice(-4) : "",
      };
      const next = view();
      broadcast("rag_config_changed", next);
      return next;
    }
    case "rag_get_index_info":
      return { needs_rebuild: false, chunks: 0, job: null, vector_state: "unconfigured" };
    case "get_rag_status":
      return JSON.stringify({ total_files: 0, indexed_files: 0, total_chunks: 0, total_tokens: 0, last_indexed_at: null });
    case "rebuild_rag_index":
      return null;
    default:
      return null;
  }
}

/** A window: a fresh module graph (own Zustand store) that has loaded its settings. */
async function openWindow() {
  vi.resetModules();
  const { useRagStore } = await import("./ragStore");
  await useRagStore.getState().loadSettings();
  return useRagStore;
}

describe("ragStore across windows", () => {
  beforeEach(() => {
    listeners.length = 0;
    backend.config = freshConfig();
    backend.secret = null;
    invoke.mockReset();
    invoke.mockImplementation(handle);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("settings saved in one window reach the other", async () => {
    const launcher = await openWindow();
    const overlay = await openWindow();
    expect(overlay.getState().settings?.config.top_k).toBe(5);

    await launcher.getState().updateConfig({ top_k: 9, embedding: { model: "bge-m3" } });

    await vi.waitFor(() => expect(overlay.getState().settings?.config.top_k).toBe(9));
    expect(overlay.getState().ragConfig?.top_k).toBe(9);
    expect(overlay.getState().settings?.config.embedding.model).toBe("bge-m3");
  });

  it("the API key never enters either window's state", async () => {
    const launcher = await openWindow();
    const overlay = await openWindow();
    await launcher.getState().setSecret("sk-secret-123456");
    await vi.waitFor(() => expect(overlay.getState().settings?.config.embedding.key_saved).toBe(true));
    expect(overlay.getState().settings?.config.embedding.key_hint).toBe("3456");
    for (const win of [launcher, overlay]) {
      expect(JSON.stringify(win.getState())).not.toContain("sk-secret");
    }
  });

  it("indexing progress shows in both windows until the queue is done", async () => {
    const launcher = await openWindow();
    const overlay = await openWindow();
    broadcast("rag_index_progress", { status: "embedding", job_id: 1, chunks_total: 10, chunks_done: 3 });
    for (const win of [launcher, overlay]) {
      expect(win.getState().isIndexing).toBe(true);
      expect(win.getState().progress?.chunks_done).toBe(3);
      expect(win.getState().indexProgress).toMatchObject({ status: "embedding", chunksTotal: 10, chunksDone: 3 });
    }
    // One job done, another queued: still indexing.
    broadcast("rag_index_progress", { status: "file_complete", job_id: 1 });
    expect(overlay.getState().isIndexing).toBe(true);

    invoke.mockClear();
    broadcast("rag_index_progress", { status: "complete", job_id: 2 });
    for (const win of [launcher, overlay]) {
      expect(win.getState().isIndexing).toBe(false);
      expect(win.getState().progress).toBeNull();
    }
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("get_rag_status", undefined));
  });

  it("enabled follows the context strategy on load", async () => {
    backend.config.enabled = true;
    const win = await openWindow();
    // The persisted strategy defaults to "stuffing": RAG gets switched off.
    expect(invoke).toHaveBeenCalledWith("rag_update_config", { patch: { enabled: false } });
    expect(win.getState().settings?.config.enabled).toBe(false);
  });

  it("the launcher's rebuild waits for the backend and clears the busy flag", async () => {
    const win = await openWindow();
    let finish: () => void = () => {};
    invoke.mockImplementation((cmd: string, args?: unknown) =>
      cmd === "rebuild_rag_index" ? new Promise<null>((r) => (finish = () => r(null))) : handle(cmd, args),
    );
    const done = win.getState().rebuildIndex();
    expect(win.getState().isIndexing).toBe(true);
    finish();
    await done;
    expect(win.getState().isIndexing).toBe(false);
    expect(win.getState().indexStale).toBe(false);
  });
});
