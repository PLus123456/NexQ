// The tasks a route can be set for, and how a task's route resolves. The
// resolution mirrors the Rust registry so the routing table can show what
// actually answers ("follows Default → DeepSeek / deepseek-chat").

import type { LlmConfigView, LlmConnection, RouteTarget } from "./types";

export type LlmTaskKey =
  | "default"
  | "assist"
  | "meeting_summary"
  | "action_items"
  | "bookmark_suggestions"
  | "meeting_ask"
  | "translation"
  | "translation_batch"
  | "rag_answer"
  | "claude_fallback";

export interface LlmTaskDef {
  key: LlmTaskKey;
  /** The task followed when this one has no target; null for default. */
  parent: LlmTaskKey | null;
  /** Called often during a meeting: a fast model without thinking is recommended. */
  highFrequency?: boolean;
  /** Only used when the translation service is set to the AI model. */
  translationOnly?: boolean;
  /** The temperature the feature asks for when nothing overrides it (shown as a placeholder). */
  defaultTemperature?: number;
}

/** Table order: default first, then by how often the user meets the task. */
export const LLM_TASKS: readonly LlmTaskDef[] = [
  { key: "default", parent: null },
  { key: "assist", parent: "default", defaultTemperature: 0.6 },
  { key: "meeting_summary", parent: "default", defaultTemperature: 0.4 },
  { key: "action_items", parent: "default" },
  { key: "bookmark_suggestions", parent: "default" },
  { key: "meeting_ask", parent: "default" },
  { key: "translation", parent: "default", highFrequency: true, translationOnly: true, defaultTemperature: 0.2 },
  { key: "translation_batch", parent: "translation", translationOnly: true, defaultTemperature: 0.2 },
  { key: "rag_answer", parent: "default" },
  { key: "claude_fallback", parent: "default" },
];

export function taskDef(key: string): LlmTaskDef | undefined {
  return LLM_TASKS.find((task) => task.key === key);
}

export type RouteProblem =
  /** Nothing configured up the chain (no default). */
  | "not_configured"
  /** The connection is turned off: requests fail rather than switch models. */
  | "connection_disabled"
  /** Neither the route nor the connection names a model. */
  | "no_model"
  /** claude_fallback resolving to Claude itself: there is no fallback. */
  | "no_fallback";

export interface ResolvedRoute {
  /** The task whose target applies ("default" when nothing closer is set). */
  source: LlmTaskKey;
  /** The task's own target (null = it follows its parent). */
  own: RouteTarget | null;
  connection: LlmConnection | null;
  /** The model that is sent (null for Claude, or with a problem). */
  model: string | null;
  /** The model came from the connection's default model. */
  modelFromConnection: boolean;
  problem: RouteProblem | null;
}

function liveTarget(view: LlmConfigView, target: RouteTarget | null | undefined): RouteTarget | null {
  // A target whose connection was deleted counts as not set.
  if (!target) return null;
  return view.connections.some((c) => c.id === target.connection_id) ? target : null;
}

/** The task's own (live) target, or for "default" the default route. */
export function ownTarget(view: LlmConfigView, key: LlmTaskKey): RouteTarget | null {
  if (key === "default") return liveTarget(view, view.routing.default);
  return liveTarget(view, view.routing.tasks[key]?.target);
}

/** What answers `key`: the first target up the parent chain, else the default route. */
export function resolveRoute(view: LlmConfigView, key: LlmTaskKey): ResolvedRoute {
  const own = ownTarget(view, key);
  let source: LlmTaskKey = key;
  let target = own;
  let def = taskDef(key);
  while (!target && def?.parent) {
    source = def.parent;
    target = ownTarget(view, source);
    def = taskDef(source);
  }
  const result: ResolvedRoute = { source, own, connection: null, model: null, modelFromConnection: false, problem: null };
  if (!target) return { ...result, problem: "not_configured" };
  const connection = view.connections.find((c) => c.id === target.connection_id) ?? null;
  if (!connection) return { ...result, problem: "not_configured" };
  result.connection = connection;
  if (key === "claude_fallback" && source === "default" && connection.kind === "claude_cli") {
    return { ...result, problem: "no_fallback" };
  }
  if (!connection.enabled) return { ...result, problem: "connection_disabled" };
  if (connection.kind === "claude_cli") return result;
  const model = target.model?.trim() || null;
  if (model) return { ...result, model };
  const fallback = connection.default_model?.trim() || null;
  if (fallback) return { ...result, model: fallback, modelFromConnection: true };
  return { ...result, problem: "no_model" };
}

/** Tasks that name `connectionId` themselves (default included), in table order. */
export function tasksUsing(view: LlmConfigView, connectionId: string): LlmTaskKey[] {
  return LLM_TASKS.filter((task) => ownTarget(view, task.key)?.connection_id === connectionId).map((t) => t.key);
}
