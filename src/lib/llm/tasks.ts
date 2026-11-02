// The tasks a route can be set for, and how a task's route resolves. Rust
// sends the resolution with every view (`effective`); the resolver here
// mirrors its rules and fills in `effective` when a view comes without it
// (older backend, tests).

import type { EffectiveRoute, LlmConfigView, RouteError, RouteTarget, TaskInfo } from "./types";

export type LlmTaskKey =
  | "default"
  | "assist"
  | "question_detect"
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
  /** The task followed without a target; null means an explicit route is required. */
  parent: LlmTaskKey | null;
  /** Called often during a meeting: a fast model without thinking is recommended. */
  highFrequency?: boolean;
  /** Only used when the translation service is set to the AI model. */
  translationOnly?: boolean;
  /** The temperature the feature asks for when nothing overrides it (shown as a placeholder). */
  defaultTemperature?: number;
}

/** Table order (the contract's `known_tasks` order): default first. */
export const LLM_TASKS: readonly LlmTaskDef[] = [
  { key: "default", parent: null },
  { key: "assist", parent: "default", defaultTemperature: 0.6 },
  { key: "question_detect", parent: null, highFrequency: true, defaultTemperature: 0 },
  { key: "meeting_summary", parent: "default", defaultTemperature: 0.4 },
  { key: "action_items", parent: "default" },
  { key: "bookmark_suggestions", parent: "default" },
  { key: "meeting_ask", parent: "default" },
  { key: "translation", parent: "default", highFrequency: true, translationOnly: true, defaultTemperature: 0.2 },
  { key: "translation_batch", parent: "translation", translationOnly: true, defaultTemperature: 0.2 },
  { key: "rag_answer", parent: "default" },
  { key: "claude_fallback", parent: "default" },
];

export const KNOWN_TASKS: readonly TaskInfo[] = LLM_TASKS.map(({ key, parent }) => ({ key, parent }));

export function taskDef(key: string): LlmTaskDef | undefined {
  return LLM_TASKS.find((task) => task.key === key);
}

export function isLlmTaskKey(key: string): key is LlmTaskKey {
  return LLM_TASKS.some((task) => task.key === key);
}

type RoutingSource = Pick<LlmConfigView, "connections" | "routing"> & { known_tasks?: readonly TaskInfo[] };

/** The parent of a task: the view's `known_tasks`, else the built-in table; `assist:<action>` → assist. */
function parentOf(view: RoutingSource, key: string): string | null {
  if (key === "default" || key === "question_detect") return null;
  const known = view.known_tasks?.find((task) => task.key === key) ?? KNOWN_TASKS.find((task) => task.key === key);
  if (known) return known.parent;
  if (key.startsWith("assist:")) return "assist";
  return "default";
}

function liveTarget(view: RoutingSource, target: RouteTarget | null | undefined): RouteTarget | null {
  // A target whose connection was deleted counts as not set.
  if (!target) return null;
  return view.connections.some((c) => c.id === target.connection_id) ? target : null;
}

/** The task's own (live) target; for "default" the default route's. */
export function ownTarget(view: RoutingSource, key: string): RouteTarget | null {
  if (key === "default") return liveTarget(view, view.routing.default.target);
  return liveTarget(view, view.routing.tasks[key]?.target);
}

/** What answers `key`: the first target up the parent chain, else the default route. */
export function resolveRoute(view: RoutingSource, key: string): EffectiveRoute {
  const result: EffectiveRoute = {
    source: null,
    connection_id: null,
    connection_name: null,
    kind: null,
    model: null,
    via_fallback: false,
    error: null,
  };
  const fail = (error: RouteError): EffectiveRoute => ({ ...result, error });

  let source: string | null = key;
  let target: RouteTarget | null = null;
  while (source !== null) {
    target = ownTarget(view, source);
    if (target) break;
    source = parentOf(view, source);
  }
  if (!target || !source) {
    if (key === "question_detect") {
      return fail(view.routing.tasks[key]?.target ? "connection_missing" : "not_configured");
    }
    // The default route points at a deleted connection.
    return fail(view.routing.default.target ? "connection_missing" : "not_configured");
  }
  const connection = view.connections.find((c) => c.id === target.connection_id)!;
  Object.assign(result, {
    source,
    connection_id: connection.id,
    connection_name: connection.name,
    kind: connection.kind,
  });
  if (key === "claude_fallback" && source === "default" && connection.kind === "claude_cli") return fail("no_fallback");
  if (!connection.enabled) return fail("connection_disabled");
  if (key === "question_detect" && connection.kind === "claude_cli") return fail("not_configured");
  if (connection.kind === "claude_cli") return result;
  if (!connection.base_url.trim() && !connection.chat_url_override?.trim()) return fail("base_url_missing");
  const model = target.model?.trim() || connection.default_model?.trim() || null;
  if (!model) return fail("no_model");
  return { ...result, model };
}

/** `effective` for every known task and every routed key. */
export function computeEffective(view: RoutingSource): Record<string, EffectiveRoute> {
  const keys = new Set<string>([...(view.known_tasks ?? KNOWN_TASKS).map((t) => t.key), ...Object.keys(view.routing.tasks)]);
  const effective: Record<string, EffectiveRoute> = {};
  for (const key of keys) effective[key] = resolveRoute(view, key);
  return effective;
}

/** What answers `key`, as Rust resolved it (computed here when the view lacks it). */
export function effectiveRoute(view: LlmConfigView, key: string): EffectiveRoute {
  // Sentence-by-sentence detection is opt-in: an older backend's inherited
  // default must never look like an explicitly configured detector route.
  if (key === "question_detect") {
    const local = resolveRoute(view, key);
    if (local.error) return local;
  }
  return view.effective[key] ?? resolveRoute(view, key);
}

/** Tasks that name `connectionId` themselves (default included), in table order. */
export function tasksUsing(view: RoutingSource, connectionId: string): LlmTaskKey[] {
  return LLM_TASKS.filter((task) => ownTarget(view, task.key)?.connection_id === connectionId).map((t) => t.key);
}
