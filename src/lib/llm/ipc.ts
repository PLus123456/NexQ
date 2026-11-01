// Typed wrappers for the LLM connection commands and the config event
// (Rust: commands/llm_connection_commands.rs; contract-llm.md v1). Argument
// names are camelCase; Tauri maps them to the Rust parameters. Commands
// reject with the English error text.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  DeleteResult,
  FetchModelsResult,
  LlmConfigView,
  LlmConnectionInput,
  ResponseLanguage,
  SecretStatus,
  TaskRoute,
  TestConnectionResult,
  TestMode,
  UpsertResult,
} from "./types";

export const LLM_CONFIG_CHANGED = "llm_config_changed";

export function llmGetConfig(): Promise<LlmConfigView> {
  return invoke<LlmConfigView>("llm_get_config");
}

/**
 * Creates (`connection.id` "") or replaces a connection. `secret`: undefined
 * leaves the stored key alone, a string stores it ("" removes it). Rust drops
 * the stored key when the base URL's origin or the kind changes, so pass the
 * new key in the same call then.
 */
export function llmUpsertConnection(connection: LlmConnectionInput, secret?: string): Promise<UpsertResult> {
  return invoke<UpsertResult>("llm_upsert_connection", { connection, secret: secret ?? null });
}

/** Deletes a connection; routes that pointed at it are cleared (their keys come back). */
export function llmDeleteConnection(id: string): Promise<DeleteResult> {
  return invoke<DeleteResult>("llm_delete_connection", { id });
}

/** Stores (or with null / "", removes) a connection's key. Write-only: the value never comes back. */
export function llmSetSecret(id: string, secret: string | null): Promise<SecretStatus> {
  return invoke<SecretStatus>("llm_set_secret", { id, secret });
}

/** Reads the keychain once (may show a permission prompt): only when an editor opens. */
export function llmSecretStatus(id: string): Promise<SecretStatus> {
  return invoke<SecretStatus>("llm_secret_status", { id });
}

/** Sets a task's route; null clears it (the task follows its parent; for "default": no target). */
export function llmSetRoute(task: string, route: TaskRoute | null): Promise<LlmConfigView> {
  return invoke<LlmConfigView>("llm_set_route", { task, route });
}

export function llmSetResponseLanguage(value: ResponseLanguage): Promise<LlmConfigView> {
  return invoke<LlmConfigView>("llm_set_response_language", { value });
}

/** Which connection a fetch or test uses: a saved one (`id`) or unsaved edits (`draft`, with `secret` if typed). */
export interface ConnectionRef {
  id?: string;
  draft?: LlmConnectionInput;
  /** A typed key; without one a draft of a saved connection uses the stored key if its origin and kind are unchanged. */
  secret?: string | null;
}

/**
 * Fetches the model list. A saved connection (`id`) caches the result, good
 * or bad, and the view changes. HTTP errors come back in the result.
 */
export function llmFetchModels(ref: ConnectionRef): Promise<FetchModelsResult> {
  return invoke<FetchModelsResult>("llm_fetch_models", {
    id: ref.id ?? null,
    draft: ref.draft ?? null,
    secret: ref.secret || null,
  });
}

/** One real request: "chat" sends a tiny prompt (model → default model → first manual model), "models" lists models. */
export function llmTestConnection(ref: ConnectionRef & { model?: string | null; mode?: TestMode }): Promise<TestConnectionResult> {
  return invoke<TestConnectionResult>("llm_test_connection", {
    id: ref.id ?? null,
    draft: ref.draft ?? null,
    secret: ref.secret || null,
    model: ref.model || null,
    mode: ref.mode ?? "chat",
  });
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
