import { create } from "zustand";
import type {
  RagConfig,
  RagIndexStatus,
  RagSearchResult,
  OllamaEmbeddingStatus,
} from "../lib/types";
import {
  getRagStatus as ipcGetRagStatus,
  rebuildRagIndex as ipcRebuildRagIndex,
  rebuildFileIndex as ipcRebuildFileIndex,
  removeFileRagIndex as ipcRemoveFileRagIndex,
  clearRagIndex as ipcClearRagIndex,
  testRagSearch as ipcTestRagSearch,
  testOllamaEmbeddingConnection,
  pullEmbeddingModel as ipcPullEmbeddingModel,
} from "../lib/ipc";
import {
  ragCancelIndexing,
  ragGetIndexInfo,
  ragGetSettings,
  ragRebuildIndex,
  ragSetSecret,
  ragSyncIndex,
  ragTestEmbedding,
  ragUpdateConfig,
} from "../lib/rag/ipc";
import { onRagConfigChanged, onRagIndexProgressFull } from "../lib/rag/events";
import {
  TERMINAL_STATUSES,
  type EmbedTestResult,
  type IndexInfo,
  type IndexProgressEvent,
  type RagConfigPatch,
  type RagSettingsView,
} from "../lib/rag/types";
import { t } from "../i18n";
import { useConfigStore } from "./configStore";
import { showToast } from "./toastStore";

interface IndexProgress {
  status: string;
  filesTotal: number;
  filesDone: number;
  chunksTotal: number;
  chunksDone: number;
}

interface PullProgress {
  status: string;
  total: number;
  completed: number;
}

interface RagState {
  // The stored settings (Rust owns them: rag/config.json). `ragConfig` is
  // the same config for components written against the upstream type.
  settings: RagSettingsView | null;
  ragConfig: RagConfig | null;
  indexInfo: IndexInfo | null;
  indexStatus: RagIndexStatus | null;
  /** The running job's latest progress (null when idle). */
  progress: IndexProgressEvent | null;
  ollamaStatus: OllamaEmbeddingStatus | null;
  isIndexing: boolean;
  indexProgress: IndexProgress | null;
  isPullingModel: boolean;
  pullProgress: PullProgress | null;
  testSearchResults: RagSearchResult[];
  isSearching: boolean;
  searchLatencyMs: number | null;
  error: string | null;
  isCheckingConnection: boolean;
  embeddingTest: EmbedTestResult | null;
  isTestingEmbedding: boolean;

  // The index needs a rebuild (model or chunk settings changed).
  indexStale: boolean;
  sourcesChangedSinceBuild: boolean;
  // Background auto-indexing (triggered by file add/remove)
  isAutoIndexing: boolean;

  // Actions
  loadSettings: () => Promise<void>;
  updateConfig: (patch: RagConfigPatch) => Promise<RagSettingsView | null>;
  setSecret: (secret: string | null) => Promise<void>;
  testEmbedding: (draft?: RagConfigPatch) => Promise<EmbedTestResult | null>;
  refreshIndexInfo: () => Promise<void>;
  syncIndex: () => Promise<void>;
  rebuildWithCurrentSettings: () => Promise<void>;
  cancelIndexing: () => Promise<void>;
  applyProgress: (event: IndexProgressEvent) => void;

  loadRagConfig: () => Promise<void>;
  saveRagConfig: (config: RagConfig) => Promise<void>;
  saveRagConfigWithStaleCheck: (config: RagConfig, prevConfig: RagConfig) => Promise<void>;
  refreshIndexStatus: () => Promise<void>;
  checkOllamaStatus: () => Promise<void>;
  rebuildIndex: () => Promise<void>;
  clearIndex: () => Promise<void>;
  pullModel: (model: string) => Promise<void>;
  testSearch: (query: string) => Promise<void>;
  setIndexProgress: (progress: IndexProgress | null) => void;
  setPullProgress: (progress: PullProgress | null) => void;
  setIsIndexing: (indexing: boolean) => void;
  setIsPullingModel: (pulling: boolean) => void;
  markSourcesChanged: () => void;
  resetTestSearch: () => void;
  autoIndexFile: (resourceId: string) => Promise<void>;
  autoRemoveFileIndex: (resourceId: string) => Promise<void>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Each window subscribes once, on first use: settings saved in the other
// window and indexing progress reach this one.
let listening: Promise<void> | null = null;
function ensureListeners() {
  if (listening) return;
  listening = Promise.all([
    onRagConfigChanged((view) => {
      useRagStore.setState({ settings: view, ragConfig: view.config });
    }),
    onRagIndexProgressFull((event) => useRagStore.getState().applyProgress(event)),
  ])
    .then(() => undefined)
    .catch((e) => {
      console.warn("[ragStore] Could not subscribe to RAG events:", e);
      listening = null;
    });
}

export const useRagStore = create<RagState>((set, get) => ({
  settings: null,
  ragConfig: null,
  indexInfo: null,
  indexStatus: null,
  progress: null,
  ollamaStatus: null,
  isIndexing: false,
  indexProgress: null,
  isPullingModel: false,
  pullProgress: null,
  testSearchResults: [],
  isSearching: false,
  searchLatencyMs: null,
  error: null,
  isCheckingConnection: false,
  embeddingTest: null,
  isTestingEmbedding: false,
  indexStale: false,
  sourcesChangedSinceBuild: false,
  isAutoIndexing: false,

  loadSettings: async () => {
    ensureListeners();
    try {
      let view = await ragGetSettings();
      // `enabled` follows the persisted context strategy.
      const shouldBeEnabled = useConfigStore.getState().contextStrategy === "local_rag";
      if (view.config.enabled !== shouldBeEnabled) {
        view = await ragUpdateConfig({ enabled: shouldBeEnabled });
      }
      set({ settings: view, ragConfig: view.config, error: null });
    } catch (e) {
      console.error("[ragStore] Failed to load RAG settings:", e);
      set({ error: message(e) });
    }
  },

  updateConfig: async (patch) => {
    ensureListeners();
    try {
      const view = await ragUpdateConfig(patch);
      set({ settings: view, ragConfig: view.config, error: null });
      void get().refreshIndexInfo();
      return view;
    } catch (e) {
      console.error("[ragStore] Failed to save RAG settings:", e);
      set({ error: message(e) });
      showToast(t("rag:toasts.saveFailed", { detail: message(e) }), "error");
      return null;
    }
  },

  setSecret: async (secret) => {
    try {
      const view = await ragSetSecret(secret);
      set({ settings: view, ragConfig: view.config, error: null });
      showToast(t(secret ? "rag:toasts.keySaved" : "rag:toasts.keyCleared"), "success");
    } catch (e) {
      set({ error: message(e) });
      showToast(t("rag:toasts.keyFailed", { detail: message(e) }), "error");
    }
  },

  testEmbedding: async (draft) => {
    set({ isTestingEmbedding: true, embeddingTest: null });
    try {
      const result = await ragTestEmbedding(draft);
      set({ embeddingTest: result, isTestingEmbedding: false });
      return result;
    } catch (e) {
      const result: EmbedTestResult = {
        ok: false,
        url: "",
        latency_ms: 0,
        dims: null,
        dimensions_respected: null,
        error: message(e),
        error_kind: "config",
        hint: null,
      };
      set({ embeddingTest: result, isTestingEmbedding: false });
      return result;
    }
  },

  refreshIndexInfo: async () => {
    ensureListeners();
    try {
      const info = await ragGetIndexInfo();
      const running = info.job && !TERMINAL_STATUSES.has(info.job.status) ? info.job : null;
      set((s) => ({
        indexInfo: info,
        indexStale: info.needs_rebuild,
        progress: running ?? (s.isIndexing ? s.progress : null),
      }));
    } catch (e) {
      console.warn("[ragStore] Failed to refresh index info:", e);
    }
  },

  syncIndex: async () => {
    try {
      set({ isIndexing: true, error: null });
      await ragSyncIndex();
    } catch (e) {
      set({ isIndexing: false, error: message(e) });
      showToast(message(e), "error");
    }
  },

  rebuildWithCurrentSettings: async () => {
    try {
      set({ isIndexing: true, error: null });
      await ragRebuildIndex();
    } catch (e) {
      set({ isIndexing: false, error: message(e) });
      showToast(message(e), "error");
    }
  },

  cancelIndexing: async () => {
    try {
      await ragCancelIndexing();
    } catch (e) {
      console.warn("[ragStore] Cancel failed:", e);
    }
  },

  applyProgress: (event) => {
    const terminal = TERMINAL_STATUSES.has(event.status);
    set({
      progress: terminal ? null : event,
      isIndexing: !terminal,
      indexProgress: terminal
        ? null
        : {
            status: event.status,
            filesTotal: event.files_total ?? 0,
            filesDone: event.files_done ?? 0,
            chunksTotal: event.chunks_total ?? 0,
            chunksDone: event.chunks_done ?? 0,
          },
    });
    if (terminal || event.status === "file_complete") {
      void get().refreshIndexStatus();
    }
  },

  loadRagConfig: async () => {
    await get().loadSettings();
  },

  saveRagConfig: async (config: RagConfig) => {
    set({ ragConfig: config, error: null });
    // A patch: fields the caller doesn't know keep their stored values.
    await get().updateConfig(config as unknown as RagConfigPatch);
  },

  saveRagConfigWithStaleCheck: async (config: RagConfig) => {
    // Whether a rebuild is needed now comes from the index itself.
    await get().saveRagConfig(config);
  },

  refreshIndexStatus: async () => {
    try {
      const status = await ipcGetRagStatus();
      set({ indexStatus: status });
    } catch (e) {
      console.warn("[ragStore] Failed to refresh index status:", e);
    }
    await get().refreshIndexInfo();
  },

  checkOllamaStatus: async () => {
    set({ isCheckingConnection: true });
    try {
      const status = await testOllamaEmbeddingConnection();
      set({ ollamaStatus: status, error: null, isCheckingConnection: false });
    } catch (e) {
      set({
        ollamaStatus: { connected: false, models: [] },
        error: message(e),
        isCheckingConnection: false,
      });
    }
  },

  // Builds or updates the knowledge base with the current settings and waits
  // for it (the launcher shows "building" until this resolves).
  rebuildIndex: async () => {
    try {
      set({ isIndexing: true, error: null });
      await ipcRebuildRagIndex();
      showToast(t("rag:toasts.rebuilt"), "success");
      set({ indexStale: false, sourcesChangedSinceBuild: false });
    } catch (e) {
      console.error("[ragStore] Failed to rebuild index:", e);
      const msg = message(e);
      showToast(t("rag:toasts.rebuildFailed", { detail: msg }), "error");
      set({ error: msg });
    } finally {
      set({ isIndexing: false });
      void get().refreshIndexStatus();
    }
  },

  clearIndex: async () => {
    try {
      set({ error: null });
      await ipcClearRagIndex();
      set({ indexStatus: null, indexStale: false, sourcesChangedSinceBuild: false });
      showToast(t("rag:toasts.cleared"), "info");
      void get().refreshIndexStatus();
    } catch (e) {
      console.error("[ragStore] Failed to clear index:", e);
      const msg = message(e);
      showToast(msg, "error");
      set({ error: msg });
    }
  },

  pullModel: async (model: string) => {
    try {
      set({ isPullingModel: true, error: null });
      showToast(t("rag:toasts.pulling", { model }), "info");
      await ipcPullEmbeddingModel(model);
      showToast(t("rag:toasts.pulled", { model }), "success");
      set({ isPullingModel: false, pullProgress: null });
      void get().checkOllamaStatus();
    } catch (e) {
      console.error("[ragStore] Failed to pull model:", e);
      const msg = message(e);
      showToast(t("rag:toasts.pullFailed", { detail: msg }), "error");
      set({
        isPullingModel: false,
        pullProgress: null,
        error: msg,
      });
    }
  },

  testSearch: async (query: string) => {
    try {
      const start = performance.now();
      set({ isSearching: true, error: null, testSearchResults: [], searchLatencyMs: null });
      const results = await ipcTestRagSearch(query);
      const latency = Math.round(performance.now() - start);
      set({ testSearchResults: results, isSearching: false, searchLatencyMs: latency });
    } catch (e) {
      console.error("[ragStore] Failed to test search:", e);
      set({
        isSearching: false,
        searchLatencyMs: null,
        error: message(e),
      });
    }
  },

  setIndexProgress: (progress) => set({ indexProgress: progress }),
  setPullProgress: (progress) => set({ pullProgress: progress }),
  setIsIndexing: (indexing) => set({ isIndexing: indexing }),
  setIsPullingModel: (pulling) => set({ isPullingModel: pulling }),
  markSourcesChanged: () => {
    const hasIndex = (get().indexStatus?.total_chunks ?? 0) > 0;
    if (hasIndex) {
      set({ sourcesChangedSinceBuild: true });
    }
  },

  resetTestSearch: () => set({
    testSearchResults: [],
    error: null,
    isSearching: false,
    searchLatencyMs: null,
  }),

  // Index a newly added file now and wait for it (the backend also queues
  // it on its own; unchanged text is not chunked or embedded twice).
  autoIndexFile: async (resourceId: string) => {
    set({ isAutoIndexing: true });
    try {
      await ipcRebuildFileIndex(resourceId);
      await get().refreshIndexStatus();
    } catch (e) {
      // Non-critical — index can be rebuilt manually; just log it
      console.warn("[ragStore] Auto-index failed for", resourceId, e);
    } finally {
      set({ isAutoIndexing: false });
    }
  },

  // Remove a single file's chunks from the index when the file is removed
  autoRemoveFileIndex: async (resourceId: string) => {
    set({ isAutoIndexing: true });
    try {
      await ipcRemoveFileRagIndex(resourceId);
      await get().refreshIndexStatus();
    } catch (e) {
      console.warn("[ragStore] Auto-remove index failed for", resourceId, e);
    } finally {
      set({ isAutoIndexing: false });
    }
  },
}));
