// Unsaved edits of one connection, kept per connection while the user moves
// between them, and the checks that run before saving or testing.

import { joinEndpoint, requestHeaders } from "../../lib/endpoint";
import { sameConnection } from "../../lib/llm/connection";
import { chatUrl, secretOrigins } from "../../lib/llm/endpoints";
import type { LlmConnection } from "../../lib/llm/types";

export interface ConnectionDraft {
  connection: LlmConnection;
  /** Not saved yet (created from a template in this session). */
  isNew: boolean;
  /** A key typed in this edit; written on save (or used for a test). */
  pendingSecret: string | null;
  /** Remove the saved key on save. */
  clearSecret: boolean;
  /** Fields with invalid input that can't be saved (e.g. the extra body JSON). */
  invalid: readonly string[];
  /** Endpoint fingerprint of the last successful test, and when it ran. */
  testedFingerprint: string | null;
  testedAt: number | null;
}

export function draftOf(connection: LlmConnection, isNew = false): ConnectionDraft {
  return {
    connection,
    isNew,
    pendingSecret: null,
    clearSecret: false,
    invalid: [],
    testedFingerprint: null,
    testedAt: null,
  };
}

export function isDirty(draft: ConnectionDraft, saved: LlmConnection | null): boolean {
  if (draft.isNew || !saved) return true;
  return draft.pendingSecret !== null || draft.clearSecret || !sameConnection(draft.connection, saved);
}

/** The fields that decide where a request goes and how it's authenticated. */
export function endpointFingerprint(connection: LlmConnection): string {
  return JSON.stringify([
    connection.kind,
    connection.base_url.trim(),
    connection.chat_url_override?.trim() ?? "",
    connection.models_endpoint,
    connection.models_endpoint === "custom" ? connection.models_url?.trim() ?? "" : "",
    connection.auth,
    connection.headers.map((h) => [h.name.trim(), h.value.trim()]),
  ]);
}

/**
 * The saved key could go to a host it was never meant for: the protocol
 * changed, or the draft sends requests to an origin the saved connection
 * didn't. Then the key must be typed again (or removed) before saving or
 * testing. A path change on the same host doesn't count.
 */
export function needsSecretReentry(draft: ConnectionDraft, saved: LlmConnection | null, secretSaved: boolean): boolean {
  if (!saved || !secretSaved || draft.pendingSecret !== null || draft.clearSecret) return false;
  if (draft.connection.kind !== saved.kind) return true;
  const before = secretOrigins(saved);
  for (const origin of secretOrigins(draft.connection)) if (!before.has(origin)) return true;
  return false;
}

export type DraftProblem =
  | "baseUrlMissing"
  | "baseUrlInvalid"
  | "overrideInvalid"
  | "modelsUrlInvalid"
  | "headersInvalid"
  | "fieldsInvalid"
  | "secretReentry";

/** Why the draft can't be saved, first problem first; empty when it can. */
export function draftProblems(draft: ConnectionDraft, saved: LlmConnection | null, secretSaved: boolean): DraftProblem[] {
  const c = draft.connection;
  const problems: DraftProblem[] = [];
  if (c.kind !== "claude_cli") {
    const base = joinEndpoint(c.base_url, "");
    if (!base.ok) {
      // A chat URL override alone is enough to send requests.
      if (base.error.code === "empty") {
        if (!c.chat_url_override?.trim()) problems.push("baseUrlMissing");
      } else {
        problems.push("baseUrlInvalid");
      }
    }
    if (c.chat_url_override?.trim() && !chatUrl(c).ok) problems.push("overrideInvalid");
    if (c.models_endpoint === "custom" && !joinEndpoint(c.models_url ?? "", "").ok) problems.push("modelsUrlInvalid");
    if (!requestHeaders(c.auth, "key", c.headers).ok) problems.push("headersInvalid");
  }
  if (draft.invalid.length > 0) problems.push("fieldsInvalid");
  if (needsSecretReentry(draft, saved, secretSaved)) problems.push("secretReentry");
  return problems;
}

/** What to save: the draft with its name trimmed (Rust keeps the test time, cache and key state itself). */
export function connectionToSave(draft: ConnectionDraft): LlmConnection {
  return { ...draft.connection, name: draft.connection.name.trim() };
}

/** The key argument of the save: a typed key, "" to remove the saved one, or undefined to leave it. */
export function secretToSave(draft: ConnectionDraft): string | undefined {
  if (draft.pendingSecret !== null) return draft.pendingSecret;
  return draft.clearSecret ? "" : undefined;
}
