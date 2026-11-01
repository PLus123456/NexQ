// Typed wrappers for the LLM connection commands and the config event
// (Rust: commands/llm_connection_commands.rs). Argument names are camelCase;
// Tauri maps them to the Rust parameters.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ModelInfo } from "../types";
import type {
  EndpointPreviewView,
  LlmConfigView,
  LlmConnection,
  LlmTestResult,
  ResponseLanguage,
  SecretStatus,
  TaskRoute,
  TestMode,
} from "./types";

export const LLM_CONFIG_CHANGED = "llm_config_changed";

export function llmGetConfig(): Promise<LlmConfigView> {
  return invoke<LlmConfigView>("llm_get_config");
}

/** Creates or replaces a connection (matched by id). */
export function llmUpsertConnection(connection: LlmConnection): Promise<LlmConfigView> {
  return invoke<LlmConfigView>("llm_upsert_connection", { connection });
}

/** Deletes a connection; routes that pointed at it go back to following their parent. */
export function llmDeleteConnection(id: string): Promise<LlmConfigView> {
  return invoke<LlmConfigView>("llm_delete_connection", { id });
}

/** Stores (or with null, removes) a connection's secret. Write-only: the value never comes back. */
export function llmSetSecret(id: string, secret: string | null): Promise<SecretStatus> {
  return invoke<SecretStatus>("llm_set_secret", { id, secret });
}

export function llmSecretStatus(id: string): Promise<SecretStatus> {
  return invoke<SecretStatus>("llm_secret_status", { id });
}

/** Sets a task's route; null clears it (the task follows its parent). `"default"` takes a route with a target. */
export function llmSetRoute(task: string, route: TaskRoute | null): Promise<LlmConfigView> {
  return invoke<LlmConfigView>("llm_set_route", { task, route });
}

export function llmSetResponseLanguage(language: ResponseLanguage): Promise<LlmConfigView> {
  return invoke<LlmConfigView>("llm_set_response_language", { language });
}

/**
 * Fetches the model list. A saved connection (`id`) also caches the result;
 * a draft (unsaved edits) uses `secret` when given, else the saved secret.
 */
export function llmFetchModels(args: {
  id?: string;
  draft?: LlmConnection;
  secret?: string | null;
}): Promise<ModelInfo[]> {
  return invoke<ModelInfo[]>("llm_fetch_models", {
    id: args.id ?? null,
    draft: args.draft ?? null,
    secret: args.secret ?? null,
  });
}

/** One real request with `draft`: "chat" sends a tiny prompt to `model`, "models" lists models. */
export function llmTestConnection(args: {
  draft: LlmConnection;
  secret?: string | null;
  model?: string | null;
  mode: TestMode;
}): Promise<LlmTestResult> {
  return invoke<LlmTestResult>("llm_test_connection", {
    draft: args.draft,
    secret: args.secret ?? null,
    model: args.model ?? null,
    mode: args.mode,
  });
}

export function llmPreviewEndpoints(draft: LlmConnection): Promise<EndpointPreviewView> {
  return invoke<EndpointPreviewView>("llm_preview_endpoints", { draft });
}

/** The full view after any change, from either window. */
export function onLlmConfigChanged(handler: (view: LlmConfigView) => void): Promise<UnlistenFn> {
  return listen<LlmConfigView>(LLM_CONFIG_CHANGED, (e) => handler(e.payload));
}

/** The message of an invoke rejection (Tauri rejects with strings or objects). */
export function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err && typeof err.message === "string") return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** The app was built without these commands (the backend part isn't merged yet). */
export function isMissingCommand(err: unknown): boolean {
  const message = errorMessage(err);
  return /\bcommand\b.*\bnot found\b/i.test(message) || /unknown command/i.test(message);
}
