// LLM connections and task routes, owned by Rust (`llm-connections.json`).
//
// The store only mirrors what Rust sends: `llm_get_config` once, then every
// `llm_config_changed` event (from this or the other window), applied by
// revision so a stale view never replaces a newer one. Every change is a
// command; nothing is persisted here. It loads itself the first time a
// component uses it (`useLlmConfig()`), so app startup code stays untouched.

import { useEffect } from "react";
import { create } from "zustand";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  errorMessage,
  isMissingCommand,
  llmDeleteConnection,
  llmFetchModels,
  llmGetConfig,
  llmSecretStatus,
  llmSetResponseLanguage,
  llmSetRoute,
  llmSetSecret,
  llmTestConnection,
  llmUpsertConnection,
  onLlmConfigChanged,
} from "../lib/llm/ipc";
import { normalizeView } from "../lib/llm/connection";
import type {
  LlmConfigView,
  LlmConnection,
  LlmTestResult,
  ResponseLanguage,
  RouteTarget,
  SecretStatus,
  TaskRoute,
  TestMode,
} from "../lib/llm/types";
import type { ModelInfo } from "../lib/types";

/**
 * `unavailable`: this build has no LLM connection commands (the backend part
 * isn't in it); pages fall back to the old settings.
 */
export type LlmLoadState = "idle" | "loading" | "ready" | "unavailable" | "error";

interface LlmConnectionsState {
  view: LlmConfigView | null;
  loadState: LlmLoadState;
  loadError: string | null;

  /** Fetches the view (and subscribes to changes on the first call). */
  load: () => Promise<void>;
  /** Applies a view unless it is older than the one shown. Returns whether it was applied. */
  applyView: (raw: unknown) => boolean;

  upsertConnection: (connection: LlmConnection) => Promise<LlmConfigView>;
  deleteConnection: (id: string) => Promise<LlmConfigView>;
  setSecret: (id: string, secret: string | null) => Promise<SecretStatus>;
  secretStatus: (id: string) => Promise<SecretStatus>;
  /** null clears the task's route (it follows its parent again). */
  setRoute: (task: string, route: TaskRoute | null) => Promise<LlmConfigView>;
  setDefaultRoute: (target: RouteTarget) => Promise<LlmConfigView>;
  setResponseLanguage: (language: ResponseLanguage) => Promise<LlmConfigView>;
  /** Saved connection: fetches and caches its models (the view refreshes). */
  fetchModels: (id: string) => Promise<ModelInfo[]>;
  /** Unsaved edits: fetches without caching. */
  fetchDraftModels: (draft: LlmConnection, secret: string | null) => Promise<ModelInfo[]>;
  testConnection: (args: {
    draft: LlmConnection;
    secret?: string | null;
    model?: string | null;
    mode: TestMode;
  }) => Promise<LlmTestResult>;
}

let subscription: Promise<UnlistenFn> | null = null;
let inflight: Promise<void> | null = null;

function subscribe(apply: (raw: unknown) => boolean) {
  if (subscription) return;
  subscription = onLlmConfigChanged((view) => {
    apply(view);
  });
  subscription.catch((err) => {
    console.warn("[llmConnections] Failed to listen for config changes:", err);
    subscription = null;
  });
}

export const useLlmConnectionsStore = create<LlmConnectionsState>((set, get) => {
  /** Runs a command that answers with the whole view, and applies it. */
  const viaView = async (run: () => Promise<LlmConfigView>): Promise<LlmConfigView> => {
    const raw = await run();
    const view = normalizeView(raw);
    get().applyView(view);
    return get().view ?? view;
  };

  return {
    view: null,
    loadState: "idle",
    loadError: null,

    load: () => {
      if (inflight) return inflight;
      // Listen before fetching, so a change between the two isn't missed.
      subscribe(get().applyView);
      if (!get().view) set({ loadState: "loading" });
      inflight = (async () => {
        try {
          const raw = await llmGetConfig();
          get().applyView(raw);
          set({ loadState: "ready", loadError: null });
        } catch (err) {
          const message = errorMessage(err);
          if (isMissingCommand(err)) {
            set({ loadState: "unavailable", loadError: message });
          } else {
            console.warn("[llmConnections] Failed to load:", message);
            // Keep showing a view we already have.
            set({ loadState: get().view ? "ready" : "error", loadError: message });
          }
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    },

    applyView: (raw) => {
      const view = normalizeView(raw);
      const current = get().view;
      if (current && view.revision < current.revision) return false;
      set({ view, loadState: "ready", loadError: null });
      return true;
    },

    upsertConnection: (connection) => viaView(() => llmUpsertConnection(connection)),
    deleteConnection: (id) => viaView(() => llmDeleteConnection(id)),
    setSecret: (id, secret) => llmSetSecret(id, secret),
    secretStatus: (id) => llmSecretStatus(id),
    setRoute: (task, route) => viaView(() => llmSetRoute(task, route)),
    setDefaultRoute: (target) => viaView(() => llmSetRoute("default", { target, params: {} })),
    setResponseLanguage: (language) => viaView(() => llmSetResponseLanguage(language)),

    fetchModels: async (id) => {
      const models = await llmFetchModels({ id });
      // The models are cached with the connection; pick up the new revision
      // even if no change event comes.
      void get().load();
      return models;
    },
    fetchDraftModels: (draft, secret) => llmFetchModels({ draft, secret }),
    testConnection: (args) => llmTestConnection(args),
  };
});

/** The view, loading it on first use. */
export function useLlmConfig() {
  const view = useLlmConnectionsStore((s) => s.view);
  const loadState = useLlmConnectionsStore((s) => s.loadState);
  const loadError = useLlmConnectionsStore((s) => s.loadError);
  useEffect(() => {
    if (useLlmConnectionsStore.getState().loadState === "idle") void useLlmConnectionsStore.getState().load();
  }, []);
  return { view, loadState, loadError };
}

/** Tests: forget the view and the subscription. */
export function resetLlmConnectionsStoreForTests() {
  subscription = null;
  inflight = null;
  useLlmConnectionsStore.setState({ view: null, loadState: "idle", loadError: null });
}
