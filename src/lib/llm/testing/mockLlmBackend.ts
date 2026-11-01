// In-memory stand-in for the Rust LLM connection commands (contract-llm.md
// v1), for tests and for developing the UI before the backend lands. Every
// change bumps the revision, answers like the real command and broadcasts
// `llm_config_changed` to every listener.
//
// Usage in a test:
//   const backend = vi.hoisted(() => ({ current: null as MockLlmBackend | null }));
//   vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd, args) => backend.current!.invoke(cmd, args) }));
//   vi.mock("@tauri-apps/api/event", () => ({ listen: (name, cb) => backend.current!.listen(name, cb) }));
//   beforeEach(() => { backend.current = createMockLlmBackend(); });

import type { ModelInfo } from "../../types";
import { blankConnection, newConnectionId, normalizeConnection } from "../connection";
import { secretOrigins } from "../endpoints";
import { computeEffective, KNOWN_TASKS } from "../tasks";
import type {
  FetchModelsResult,
  LlmConfigView,
  LlmConnection,
  SecretStatus,
  TaskRoute,
  TestConnectionResult,
} from "../types";

type Listener = (event: { event: string; id: number; payload: unknown }) => void;

/** What the tests may set up: the view's stored parts (`effective` is always computed). */
export type MockState = Partial<Omit<LlmConfigView, "effective" | "known_tasks">>;

export interface MockLlmBackend {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  listen: (event: string, cb: Listener) => Promise<() => void>;
  /** The current view (a copy). */
  view: () => LlmConfigView;
  /** Replace part of the state as if another window changed it, and broadcast. */
  externalChange: (patch: MockState) => LlmConfigView;
  /** Broadcast an arbitrary payload (e.g. a stale revision). */
  emit: (payload: unknown) => void;
  secrets: Map<string, string>;
  /** Every command received, in order. */
  calls: { cmd: string; args: Record<string, unknown> | undefined }[];
  /** Models `llm_fetch_models` finds (or an error result). */
  models: ModelInfo[] | Partial<FetchModelsResult>;
  /** Result of `llm_test_connection` (a function gets the args). */
  testResult: Partial<TestConnectionResult> | ((args: Record<string, unknown>) => Partial<TestConnectionResult>);
  /** Commands that reject with "command … not found" (simulates a build without them). */
  missing: Set<string>;
}

export function mockConnection(patch: Partial<LlmConnection> & Pick<LlmConnection, "id">): LlmConnection {
  return { ...blankConnection(patch.kind ?? "openai_compat", patch.id), name: patch.id, ...patch };
}

export function emptyView(patch: MockState = {}): LlmConfigView {
  const base = {
    schema_version: 1,
    revision: 1,
    read_only: false,
    load_warning: null,
    connections: [] as LlmConnection[],
    routing: { default: { target: null, params: {} }, tasks: {} },
    response_language: "ui",
    migration: null,
    known_tasks: [...KNOWN_TASKS],
    claude_available: true,
    ...patch,
  };
  return { ...base, effective: computeEffective(base) };
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const hint = (secret: string) => `…${secret.slice(-4)}`;

const OK_TEST: TestConnectionResult = {
  ok: true,
  url: null,
  status: 200,
  latency_ms: 42,
  model: null,
  sample: "pong",
  error: null,
  error_body: null,
  hint: null,
};

export function createMockLlmBackend(initial: MockState = {}): MockLlmBackend {
  let state = emptyView(initial);
  const listeners = new Map<string, Set<Listener>>();
  let eventId = 0;

  const backend: MockLlmBackend = {
    secrets: new Map(),
    calls: [],
    models: [],
    testResult: {},
    missing: new Set(),

    view: () => clone(state),

    emit: (payload) => {
      for (const cb of listeners.get("llm_config_changed") ?? []) {
        cb({ event: "llm_config_changed", id: ++eventId, payload: clone(payload) });
      }
    },

    externalChange: (patch) => {
      const next = { ...state, ...clone(patch), revision: state.revision + 1 };
      state = { ...next, effective: computeEffective(next) };
      backend.emit(state);
      return clone(state);
    },

    listen: async (event, cb) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(cb);
      return () => listeners.get(event)?.delete(cb);
    },

    invoke: async (cmd, args) => {
      backend.calls.push({ cmd, args: args ? clone(args) : undefined });
      if (backend.missing.has(cmd)) throw `command ${cmd} not found`;
      const a = args ?? {};

      /** Saves, bumps the revision, broadcasts, and answers with the view. */
      const commit = () => {
        const next = { ...state, revision: state.revision + 1 };
        state = { ...next, effective: computeEffective(next) };
        backend.emit(state);
        return clone(state);
      };
      const status = (id: string): SecretStatus => {
        const secret = backend.secrets.get(id);
        return { present: secret !== undefined, hint: secret ? hint(secret) : null };
      };
      const writeSecret = (id: string, secret: string | null) => {
        if (secret) backend.secrets.set(id, secret);
        else backend.secrets.delete(id);
        state = {
          ...state,
          connections: state.connections.map((c) =>
            c.id === id ? { ...c, secret_hint: secret ? hint(secret) : null, secret_ref: secret ? `llm:${id}` : null } : c,
          ),
        };
      };
      const connectionOf = (): LlmConnection | null => {
        if (a.draft) return normalizeConnection(a.draft);
        return state.connections.find((c) => c.id === a.id) ?? null;
      };

      switch (cmd) {
        case "llm_get_config":
          return clone(state);

        case "llm_upsert_connection": {
          const input = normalizeConnection(a.connection);
          const isNew = !input.id;
          const id = isNew ? newConnectionId() : input.id;
          const existing = state.connections.find((c) => c.id === id);
          const connection: LlmConnection = {
            ...input,
            id,
            // Kept by Rust: ignored on input.
            secret_ref: existing?.secret_ref ?? null,
            secret_hint: existing?.secret_hint ?? null,
            model_cache: existing?.model_cache ?? null,
            verified_at_ms: existing?.verified_at_ms ?? null,
            created_at_ms: existing?.created_at_ms ?? Date.now(),
            legacy_type: existing?.legacy_type ?? null,
          };
          state = {
            ...state,
            connections: existing
              ? state.connections.map((c) => (c.id === id ? connection : c))
              : [...state.connections, connection],
          };
          // A new origin or kind drops the stored key.
          if (existing && backend.secrets.has(id)) {
            const before = secretOrigins(existing);
            const moved = existing.kind !== connection.kind || [...secretOrigins(connection)].some((o) => !before.has(o));
            if (moved) writeSecret(id, null);
          }
          if (typeof a.secret === "string") writeSecret(id, a.secret);
          return { id, config: commit() };
        }

        case "llm_delete_connection": {
          const id = a.id as string;
          const cleared: string[] = [];
          const tasks: Record<string, TaskRoute> = {};
          for (const [key, route] of Object.entries(state.routing.tasks)) {
            if (route.target?.connection_id === id) {
              cleared.push(key);
              if (Object.keys(route.params).length > 0) tasks[key] = { ...route, target: null };
            } else {
              tasks[key] = route;
            }
          }
          let def = state.routing.default;
          if (def.target?.connection_id === id) {
            cleared.unshift("default");
            def = { ...def, target: null };
          }
          backend.secrets.delete(id);
          state = { ...state, connections: state.connections.filter((c) => c.id !== id), routing: { default: def, tasks } };
          return { cleared_routes: cleared, config: commit() };
        }

        case "llm_set_secret": {
          const id = a.id as string;
          writeSecret(id, (a.secret as string | null) || null);
          commit();
          return status(id);
        }

        case "llm_secret_status":
          return status(a.id as string);

        case "llm_set_route": {
          const task = a.task as string;
          const route = (a.route as TaskRoute | null) ?? null;
          if (task === "default") {
            state = { ...state, routing: { ...state.routing, default: route ? clone(route) : { target: null, params: {} } } };
          } else {
            const tasks = { ...state.routing.tasks };
            if (route) tasks[task] = clone(route);
            else delete tasks[task];
            state = { ...state, routing: { ...state.routing, tasks } };
          }
          return commit();
        }

        case "llm_set_response_language":
          state = { ...state, response_language: a.value as string };
          return commit();

        case "llm_fetch_models": {
          const connection = connectionOf();
          const failure = Array.isArray(backend.models) ? null : backend.models;
          const result: FetchModelsResult = {
            ok: !failure,
            url: connection ? `${connection.base_url}/models` : null,
            status: failure ? failure.status ?? 500 : 200,
            latency_ms: 30,
            models: failure ? [] : clone(backend.models as ModelInfo[]),
            error: failure?.error ?? null,
            error_body: failure?.error_body ?? null,
            hint: failure?.hint ?? null,
            ...(failure ?? {}),
          };
          if (a.id) {
            state = {
              ...state,
              connections: state.connections.map((c) =>
                c.id === a.id
                  ? {
                      ...c,
                      model_cache: {
                        models: result.ok ? result.models : c.model_cache?.models ?? [],
                        fetched_at_ms: Date.now(),
                        url: result.url,
                        error: result.ok ? null : result.error,
                      },
                    }
                  : c,
              ),
            };
            commit();
          }
          return result;
        }

        case "llm_test_connection": {
          const connection = connectionOf();
          const custom = typeof backend.testResult === "function" ? backend.testResult(a) : backend.testResult;
          const result: TestConnectionResult = {
            ...OK_TEST,
            url: connection ? `${connection.base_url}/chat/completions` : null,
            model: (a.model as string | null) || connection?.default_model || connection?.manual_models[0] || null,
            ...custom,
          };
          if (result.ok && a.id) {
            state = {
              ...state,
              connections: state.connections.map((c) => (c.id === a.id ? { ...c, verified_at_ms: Date.now() } : c)),
            };
            commit();
          }
          return result;
        }

        default:
          throw `command ${cmd} not found`;
      }
    },
  };
  return backend;
}
