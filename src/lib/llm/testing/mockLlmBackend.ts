// In-memory stand-in for the Rust LLM connection commands, for tests (and
// for developing the UI before the backend lands). Behaves like the planned
// commands: every change bumps the revision, returns the full view and
// broadcasts `llm_config_changed` to every listener.
//
// Usage in a test:
//   const backend = vi.hoisted(() => ({ current: null as MockLlmBackend | null }));
//   vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd, args) => backend.current!.invoke(cmd, args) }));
//   vi.mock("@tauri-apps/api/event", () => ({ listen: (name, cb) => backend.current!.listen(name, cb) }));
//   beforeEach(() => { backend.current = createMockLlmBackend(); });

import type { ModelInfo } from "../../types";
import { blankConnection } from "../connection";
import type {
  LlmConfigView,
  LlmConnection,
  LlmTestResult,
  RouteTarget,
  SecretStatus,
  TaskRoute,
} from "../types";

type Listener = (event: { event: string; id: number; payload: unknown }) => void;

export interface MockLlmBackend {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  listen: (event: string, cb: Listener) => Promise<() => void>;
  /** The current view (a copy). */
  view: () => LlmConfigView;
  /** Replace part of the state as if another window changed it, and broadcast. */
  externalChange: (patch: Partial<LlmConfigView>) => LlmConfigView;
  /** Broadcast an arbitrary payload (e.g. a stale revision). */
  emit: (payload: unknown) => void;
  secrets: Map<string, string>;
  /** Every command received, in order. */
  calls: { cmd: string; args: Record<string, unknown> | undefined }[];
  /** Models returned by `llm_fetch_models` (or an error to throw). */
  models: ModelInfo[] | Error;
  /** Result of `llm_test_connection` (a function gets the args). */
  testResult: LlmTestResult | ((args: Record<string, unknown>) => LlmTestResult);
  /** Commands that reject with "command … not found" (simulates a build without them). */
  missing: Set<string>;
}

export function mockConnection(patch: Partial<LlmConnection> & Pick<LlmConnection, "id">): LlmConnection {
  return { ...blankConnection(patch.kind ?? "openai_compat", patch.id), name: patch.id, ...patch };
}

export function emptyView(patch: Partial<LlmConfigView> = {}): LlmConfigView {
  return {
    schema_version: 1,
    revision: 1,
    read_only: false,
    connections: [],
    routing: { default: null, tasks: {} },
    response_language: "ui",
    migration: null,
    ...patch,
  };
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function hint(secret: string): string {
  return secret.slice(-4);
}

export function createMockLlmBackend(initial: Partial<LlmConfigView> = {}): MockLlmBackend {
  let state = emptyView(initial);
  const listeners = new Map<string, Set<Listener>>();
  let eventId = 0;

  const backend: MockLlmBackend = {
    secrets: new Map(),
    calls: [],
    models: [],
    testResult: { ok: true, url: "", status: 200, latency_ms: 42, sample: "pong", error_body: null },
    missing: new Set(),

    view: () => clone(state),

    emit: (payload) => {
      for (const cb of listeners.get("llm_config_changed") ?? []) {
        cb({ event: "llm_config_changed", id: ++eventId, payload: clone(payload) });
      }
    },

    externalChange: (patch) => {
      state = { ...state, ...clone(patch), revision: state.revision + 1 };
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
        state = { ...state, revision: state.revision + 1 };
        backend.emit(state);
        return clone(state);
      };

      const status = (id: string): SecretStatus => {
        const secret = backend.secrets.get(id);
        return { present: secret !== undefined, hint: secret ? hint(secret) : null };
      };

      switch (cmd) {
        case "llm_get_config":
          return clone(state);

        case "llm_upsert_connection": {
          const connection = clone(a.connection as LlmConnection);
          if (!connection?.id) throw "connection id required";
          const index = state.connections.findIndex((c) => c.id === connection.id);
          const secret = backend.secrets.get(connection.id);
          connection.secret_hint = secret ? hint(secret) : null;
          state = {
            ...state,
            connections:
              index >= 0
                ? state.connections.map((c, i) => (i === index ? connection : c))
                : [...state.connections, connection],
          };
          return commit();
        }

        case "llm_delete_connection": {
          const id = a.id as string;
          const tasks: Record<string, TaskRoute> = {};
          for (const [key, route] of Object.entries(state.routing.tasks)) {
            tasks[key] = route.target?.connection_id === id ? { ...route, target: null } : route;
          }
          backend.secrets.delete(id);
          state = {
            ...state,
            connections: state.connections.filter((c) => c.id !== id),
            routing: {
              default: state.routing.default?.connection_id === id ? null : state.routing.default,
              tasks,
            },
          };
          return commit();
        }

        case "llm_set_secret": {
          const id = a.id as string;
          const secret = (a.secret as string | null) ?? null;
          if (secret) backend.secrets.set(id, secret);
          else backend.secrets.delete(id);
          const index = state.connections.findIndex((c) => c.id === id);
          if (index >= 0) {
            state = {
              ...state,
              connections: state.connections.map((c, i) => (i === index ? { ...c, secret_hint: secret ? hint(secret) : null } : c)),
            };
            commit();
          }
          return status(id);
        }

        case "llm_secret_status":
          return status(a.id as string);

        case "llm_set_route": {
          const task = a.task as string;
          const route = (a.route as TaskRoute | null) ?? null;
          if (task === "default") {
            state = { ...state, routing: { ...state.routing, default: (route?.target as RouteTarget | null) ?? null } };
          } else {
            const tasks = { ...state.routing.tasks };
            if (route) tasks[task] = clone(route);
            else delete tasks[task];
            state = { ...state, routing: { ...state.routing, tasks } };
          }
          return commit();
        }

        case "llm_set_response_language":
          state = { ...state, response_language: a.language as string };
          return commit();

        case "llm_fetch_models": {
          if (backend.models instanceof Error) throw backend.models.message;
          const id = a.id as string | null;
          if (id) {
            state = {
              ...state,
              connections: state.connections.map((c) =>
                c.id === id
                  ? { ...c, model_cache: { models: clone(backend.models as ModelInfo[]), fetched_at_ms: Date.now(), error: null } }
                  : c,
              ),
            };
            commit();
          }
          return clone(backend.models);
        }

        case "llm_test_connection": {
          const result = typeof backend.testResult === "function" ? backend.testResult(a) : backend.testResult;
          const draft = a.draft as LlmConnection | undefined;
          if (result.ok && draft && state.connections.some((c) => c.id === draft.id)) {
            state = {
              ...state,
              connections: state.connections.map((c) => (c.id === draft.id ? { ...c, verified_at_ms: Date.now() } : c)),
            };
            commit();
          }
          return clone(result);
        }

        case "llm_preview_endpoints":
          return { chat_url: null, models_url: null, warnings: [] };

        default:
          throw `command ${cmd} not found`;
      }
    },
  };
  return backend;
}
