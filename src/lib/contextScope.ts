// Which part of the meeting a user action focuses on: the picker's setting
// (configStore) resolved into a concrete scope at request time.

import type { ContextScopeKind, ContextScopeSetting, ResolvedScope } from "./types";
import { t } from "../i18n";

export const DEFAULT_CONTEXT_SCOPE: ContextScopeSetting = { kind: "default", minutes: 5 };

/** One-click minute choices in the picker (a custom value is also allowed). */
export const MINUTE_PRESETS = [2, 5, 10, 15] as const;
export const MIN_MINUTES = 1;
export const MAX_MINUTES = 120;

/** Start times (epoch ms) of the previous user requests in this meeting. */
export interface LastUserRequests {
  anyAt: number | null;
  byMode: Record<string, number>;
}

export const NO_USER_REQUESTS: LastUserRequests = { anyAt: null, byMode: {} };

/** A whole number of minutes within 1–120 (5 when not a number). */
export function clampMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return DEFAULT_CONTEXT_SCOPE.minutes;
  return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(minutes)));
}

/** Picker order. */
export const SCOPE_KINDS: ContextScopeKind[] = ["default", "since_last_any", "since_last_same", "minutes", "all"];

/** Label on the picker chip and options. */
export function scopeChipLabel(setting: ContextScopeSetting): string {
  switch (setting.kind) {
    case "default":
      return t("overlay:scope.label.default");
    case "since_last_any":
      return t("overlay:scope.label.sinceLastAny");
    case "since_last_same":
      return t("overlay:scope.label.sinceLastSame");
    case "minutes":
      return t("overlay:scope.label.minutes", { minutes: clampMinutes(setting.minutes) });
    case "all":
      return t("overlay:scope.label.all");
  }
}

/** Short scope hint for an action button ("F/U · last 5 min"); null for the default. */
export function scopeHint(setting: ContextScopeSetting, actionLabel: string): string | null {
  switch (setting.kind) {
    case "default":
      return null;
    case "since_last_any":
      return t("overlay:scope.actionHint.sinceLastAny");
    case "since_last_same":
      return t("overlay:scope.actionHint.sinceLastSame", { action: actionLabel });
    case "minutes":
      return t("overlay:scope.actionHint.minutes", { minutes: clampMinutes(setting.minutes) });
    case "all":
      return t("overlay:scope.actionHint.all");
  }
}

/**
 * The scope to send with a request for `mode`, or null for the action's
 * default (the backend then behaves exactly as before). "Since last …" with
 * no earlier request in this meeting falls back to the whole meeting.
 * `label` is shown to the user (answer header, call log) in the UI language
 * at request time.
 */
export function resolveScope(
  setting: ContextScopeSetting,
  mode: string,
  actionLabel: string,
  last: LastUserRequests,
  now: number,
): ResolvedScope | null {
  switch (setting.kind) {
    case "default":
      return null;
    case "all":
      return { kind: "all", since_ms: null, label: t("overlay:scope.label.all") };
    case "minutes": {
      const minutes = clampMinutes(setting.minutes);
      return {
        kind: "minutes",
        since_ms: now - minutes * 60_000,
        minutes,
        label: t("overlay:scope.label.minutes", { minutes }),
      };
    }
    case "since_last_any":
      return last.anyAt != null
        ? { kind: "since_last_any", since_ms: last.anyAt, label: t("overlay:scope.label.sinceLastAny") }
        : { kind: "all", since_ms: null, label: t("overlay:scope.resolved.firstAny") };
    case "since_last_same": {
      const at = last.byMode[mode];
      return at != null
        ? {
            kind: "since_last_same",
            since_ms: at,
            label: t("overlay:scope.resolved.sinceLastSame", { action: actionLabel }),
          }
        : { kind: "all", since_ms: null, label: t("overlay:scope.resolved.firstSame", { action: actionLabel }) };
    }
  }
}
