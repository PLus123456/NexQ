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
  type ConnectionRef,
} from "../lib/llm/ipc";
import { normalizeView, toInput } from "../lib/llm/connection";
import type {
  FetchModelsResult,
  LlmConfigView,
  LlmConnection,
  ResponseLanguage,
  RouteTarget,
  SecretStatus,
  TaskRoute,
  TestConnectionResult,
  TestMode,
} from "../lib/llm/types";

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

  /**
   * Saves a connection; `isNew` creates it (Rust assigns the id). `secret`:
   * undefined leaves the key alone, a string stores it ("" removes it).
   * Resolves to the connection's id.
   */
  upsertConnection: (connection: LlmConnection, options?: { isNew?: boolean; secret?: string }) => Promise<string>;
  /** Resolves to the task keys whose routes were cleared. */
  deleteConnection: (id: string) => Promise<string[]>;
  setSecret: (id: string, secret: string | null) => Promise<SecretStatus>;
  secretStatus: (id: string) => Promise<SecretStatus>;
  /** null clears the task's route (it follows its parent again). */
  setRoute: (task: string, route: TaskRoute | null) => Promise<LlmConfigView>;
  /** Points the default route at `target`, keeping its parameters. */
  setDefaultRoute: (target: RouteTarget) => Promise<LlmConfigView>;
  setResponseLanguage: (value: ResponseLanguage) => Promise<LlmConfigView>;
  fetchModels: (ref: ConnectionRef) => Promise<FetchModelsResult>;
  testConnection: (ref: ConnectionRef & { model?: string | null; mode?: TestMode }) => Promise<TestConnectionResult>;
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
  /** Applies a view a command answered with; returns the view shown afterwards. */
  const take = (raw: LlmConfigView): LlmConfigView => {
    get().applyView(raw);
    return get().view ?? normalizeView(raw);
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

    upsertConnection: async (connection, options = {}) => {
      const input = toInput(connection);
      const result = await llmUpsertConnection(options.isNew ? { ...input, id: "" } : input, options.secret);
      take(result.config);
      return result.id;
    },
    deleteConnection: async (id) => {
      const result = await llmDeleteConnection(id);
      take(result.config);
      return result.cleared_routes ?? [];
    },
    setSecret: (id, secret) => llmSetSecret(id, secret),
    secretStatus: (id) => llmSecretStatus(id),
    setRoute: async (task, route) => take(await llmSetRoute(task, route)),
    setDefaultRoute: async (target) => {
      const params = get().view?.routing.default.params ?? {};
      return take(await llmSetRoute("default", { target, params }));
    },
    setResponseLanguage: async (value) => take(await llmSetResponseLanguage(value)),
    // A saved connection's fetch / test also updates the view through the change event.
    fetchModels: (ref) => llmFetchModels(ref),
    testConnection: (ref) => llmTestConnection(ref),
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
