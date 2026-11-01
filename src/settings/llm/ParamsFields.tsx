// Request parameter fields (temperature, max tokens, extra request body) for a
// connection's defaults and for a task route's overrides. Empty = not set at
// this level. Numbers commit on blur / Enter; the JSON body commits once it is
// a valid object.

import { useEffect, useId, useState } from "react";
import { useT } from "../../i18n";
import { cn } from "../../lib/utils";
import type { LlmParams } from "../../lib/llm/types";
import { HINT, INPUT, INPUT_INVALID, LABEL, LINK_BUTTON, PLAIN_TEXT } from "./ui";

/** Keys the backend never lets the extra body override. */
const RESERVED_KEYS = ["model", "messages", "stream"] as const;

type JsonCheck =
  | { ok: true; value: Record<string, unknown> | null }
  | { ok: false; error: "invalid" | "notObject" | "reserved"; key?: string };

/** Parses the extra body field: blank = none; otherwise a JSON object without reserved keys. */
export function parseExtraBody(text: string): JsonCheck {
  if (!text.trim()) return { ok: true, value: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "invalid" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false, error: "notObject" };
  const reserved = RESERVED_KEYS.find((key) => key in (parsed as Record<string, unknown>)); // i18n-ignore: a type, not text
  if (reserved) return { ok: false, error: "reserved", key: reserved };
  return { ok: true, value: parsed as Record<string, unknown> };
}

const pretty = (value: Record<string, unknown> | null | undefined) =>
  value && Object.keys(value).length > 0 ? JSON.stringify(value, null, 2) : "";

/** Merges `patch` into a JSON object one level deep (objects inside are merged too). */
function mergeObjects(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> { // i18n-ignore: a type, not text
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    out[key] =
      value && typeof value === "object" && !Array.isArray(value) && current && typeof current === "object" && !Array.isArray(current)
        ? mergeObjects(current as Record<string, unknown>, value as Record<string, unknown>) // i18n-ignore: a type, not text
        : value;
  }
  return out;
}

export function JsonObjectField({
  id,
  value,
  onChange,
  onValidityChange,
  disabled = false,
  disableThinking,
}: {
  id: string;
  value: Record<string, unknown> | null | undefined;
  onChange: (next: Record<string, unknown> | null) => void;
  /** Reported whenever the text becomes valid or invalid (Save stays off while invalid). */
  onValidityChange?: (valid: boolean) => void;
  disabled?: boolean;
  /** The vendor's "turn thinking off" body, offered as a one-click merge. */
  disableThinking?: Record<string, unknown>;
}) {
  const { t } = useT("llm");
  const [text, setText] = useState(() => pretty(value));
  const check = parseExtraBody(text);
  const errorId = `${id}-error`;

  // Follow outside changes (another window, a discarded draft) while the text is valid.
  const external = pretty(value);
  useEffect(() => {
    setText((current) => {
      const parsed = parseExtraBody(current);
      return parsed.ok && pretty(parsed.value) === external ? current : parsed.ok ? external : current;
    });
  }, [external]);

  useEffect(() => {
    onValidityChange?.(check.ok);
  }, [check.ok, onValidityChange]);

  const edit = (next: string) => {
    setText(next);
    const parsed = parseExtraBody(next);
    if (parsed.ok) onChange(parsed.value);
  };

  const thinkingAlreadyOff =
    !!disableThinking && check.ok && JSON.stringify(mergeObjects(check.value ?? {}, disableThinking)) === JSON.stringify(check.value ?? {});

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-xs font-medium text-foreground">
          {t("params.extraBody.label")}
        </label>
        {disableThinking && !thinkingAlreadyOff && (
          <button
            type="button"
            disabled={disabled || !check.ok}
            onClick={() => edit(pretty(mergeObjects(check.ok ? check.value ?? {} : {}, disableThinking)))}
            className={LINK_BUTTON}
          >
            {t("params.extraBody.disableThinking")}
          </button>
        )}
      </div>
      <textarea
        id={id}
        {...PLAIN_TEXT}
        rows={Math.min(8, Math.max(2, text.split("\n").length))}
        value={text}
        onChange={(e) => edit(e.target.value)}
        placeholder={t("params.extraBody.placeholder")}
        disabled={disabled}
        aria-invalid={check.ok ? undefined : true}
        aria-describedby={check.ok ? undefined : errorId}
        className={cn(INPUT, "font-mono leading-relaxed", !check.ok && INPUT_INVALID)}
      />
      {check.ok ? (
        <p className={HINT}>{t("params.extraBody.hint")}</p>
      ) : (
        <p id={errorId} className="mt-1.5 text-xs text-destructive">
          {check.error === "reserved"
            ? t("params.extraBody.errors.reserved", { key: check.key ?? "" })
            : check.error === "notObject"
              ? t("params.extraBody.errors.notObject")
              : t("params.extraBody.errors.invalid")}
        </p>
      )}
    </div>
  );
}

export function NumberField({
  id,
  label,
  value,
  onChange,
  min,
  max,
  integer = false,
  placeholder,
  disabled = false,
}: {
  id: string;
  label: string;
  value: number | null | undefined;
  onChange: (next: number | null) => void;
  min: number;
  max: number;
  integer?: boolean;
  placeholder?: string;
  disabled?: boolean;
}) {
  const { t } = useT("llm");
  const shown = value === null || value === undefined ? "" : String(value);
  const [text, setText] = useState<string | null>(null);
  const current = text ?? shown;
  const parsed = current.trim() === "" ? null : Number(current);
  const invalid =
    parsed !== null && (!Number.isFinite(parsed) || parsed < min || parsed > max || (integer && !Number.isInteger(parsed)));

  const commit = () => {
    if (text === null) return;
    setText(null);
    if (invalid) return;
    if (parsed !== (value ?? null)) onChange(parsed);
  };

  return (
    <div>
      <label htmlFor={id} className={LABEL}>
        {label}
      </label>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        {...PLAIN_TEXT}
        value={current}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setText(null);
        }}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={invalid ? true : undefined}
        className={cn(INPUT, invalid && INPUT_INVALID)}
      />
      {invalid && (
        <p className="mt-1 text-xs text-destructive">
          {integer ? t("params.errors.integerRange", { min, max }) : t("params.errors.range", { min, max })}
        </p>
      )}
    </div>
  );
}

export function ParamsFields({
  value,
  onChange,
  idPrefix,
  temperaturePlaceholder,
  maxTokensPlaceholder,
  disableThinking,
  onValidityChange,
  disabled = false,
}: {
  value: LlmParams;
  onChange: (next: LlmParams) => void;
  idPrefix?: string;
  temperaturePlaceholder?: string;
  maxTokensPlaceholder?: string;
  disableThinking?: Record<string, unknown>;
  onValidityChange?: (valid: boolean) => void;
  disabled?: boolean;
}) {
  const { t } = useT("llm");
  const autoId = useId();
  const id = idPrefix ?? `params${autoId}`;

  const set = (patch: Partial<LlmParams>) => {
    const next: LlmParams = { ...value, ...patch };
    // Unset values are left out rather than sent as null.
    for (const key of Object.keys(next) as (keyof LlmParams)[]) {
      if (next[key] === null || next[key] === undefined) delete next[key];
    }
    onChange(next);
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <NumberField
          id={`${id}-temperature`}
          label={t("params.temperature.label")}
          value={value.temperature}
          onChange={(temperature) => set({ temperature })}
          min={0}
          max={2}
          placeholder={temperaturePlaceholder ?? t("params.notSet")}
          disabled={disabled}
        />
        <NumberField
          id={`${id}-max-tokens`}
          label={t("params.maxTokens.label")}
          value={value.max_tokens}
          onChange={(max_tokens) => set({ max_tokens })}
          min={1}
          max={1_000_000}
          integer
          placeholder={maxTokensPlaceholder ?? t("params.notSet")}
          disabled={disabled}
        />
      </div>
      <JsonObjectField
        id={`${id}-extra-body`}
        value={value.extra_body}
        onChange={(extra_body) => set({ extra_body })}
        onValidityChange={onValidityChange}
        disableThinking={disableThinking}
        disabled={disabled}
      />
    </div>
  );
}
