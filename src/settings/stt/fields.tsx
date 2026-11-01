// Form fields of the Remote Whisper and Soniox panels. Text and numbers are
// kept as a draft while typing and saved on blur or Enter (Esc puts the
// saved value back), so a settings write doesn't happen on every keystroke.

import { useEffect, useId, useRef, useState } from "react";
import type React from "react";
import { cn } from "../../lib/utils";

export const FIELD_LABEL = "mb-1.5 block text-xs font-medium text-foreground";
export const FIELD_HINT = "mt-1.5 text-meta leading-relaxed text-muted-foreground";
export const FIELD_INPUT =
  "w-full rounded-lg border border-border/50 bg-secondary/30 px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50";
export const FIELD_INVALID = "border-destructive/60 focus:border-destructive/60 focus:ring-destructive/20";

/** Addresses, ids and JSON: no spell check or autocorrect. */
export const PLAIN_TEXT = { spellCheck: false, autoCapitalize: "off", autoCorrect: "off", autoComplete: "off" } as const;

/** A draft of `value` that follows outside changes while the field isn't being edited. */
function useDraft(value: string) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);
  return { draft, setDraft, editing };
}

type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "defaultValue">;

/** Text input saved on blur / Enter. `onCommit` gets the trimmed text, only when it changed. */
export function CommitTextInput({
  value,
  onCommit,
  className,
  invalid,
  ...props
}: InputProps & { value: string; onCommit: (value: string) => void; invalid?: boolean }) {
  const { draft, setDraft, editing } = useDraft(value);
  const commit = () => {
    editing.current = false;
    const next = draft.trim();
    if (next !== value) onCommit(next);
    else setDraft(value);
  };
  return (
    <input
      type="text"
      {...PLAIN_TEXT}
      {...props}
      value={draft}
      onChange={(e) => {
        editing.current = true;
        setDraft(e.target.value);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") {
          editing.current = false;
          setDraft(value);
        }
      }}
      aria-invalid={invalid ? true : undefined}
      className={cn(FIELD_INPUT, invalid && FIELD_INVALID, className)}
    />
  );
}

/**
 * Multi-line text saved on blur and Enter (Shift+Enter adds a line).
 * `validate` can refuse the text: it returns an error message and nothing is saved.
 */
export function CommitTextarea({
  value,
  onCommit,
  validate,
  className,
  rows = 2,
  ...props
}: Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange" | "defaultValue"> & {
  value: string;
  onCommit: (value: string) => void;
  /** Error message for invalid text, or null. */
  validate?: (text: string) => string | null;
}) {
  const { draft, setDraft, editing } = useDraft(value);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const commit = () => {
    const problem = validate?.(draft) ?? null;
    setError(problem);
    if (problem) return;
    editing.current = false;
    if (draft !== value) onCommit(draft);
  };
  return (
    <div>
      <textarea
        {...PLAIN_TEXT}
        {...props}
        rows={rows}
        value={draft}
        onChange={(e) => {
          editing.current = true;
          setDraft(e.target.value);
          if (error) setError(null);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            editing.current = false;
            setError(null);
            setDraft(value);
          }
        }}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : props["aria-describedby"]}
        className={cn(FIELD_INPUT, "resize-y", error && FIELD_INVALID, className)}
      />
      {error && (
        <p id={errorId} role="alert" className="mt-1.5 text-meta text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** Number input saved on blur / Enter, clamped to [min, max]; text that isn't a number puts the saved value back. */
export function CommitNumberInput({
  value,
  onCommit,
  min,
  max,
  step = 1,
  integer = false,
  className,
  ...props
}: Omit<InputProps, "min" | "max" | "step"> & {
  value: number;
  onCommit: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  integer?: boolean;
}) {
  const { draft, setDraft, editing } = useDraft(String(value));
  const commit = () => {
    editing.current = false;
    const parsed = Number(draft.trim().replace(",", "."));
    if (draft.trim() === "" || !Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    let next = Math.min(max, Math.max(min, parsed));
    if (integer) next = Math.round(next);
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <input
      type="number"
      inputMode={integer ? "numeric" : "decimal"}
      {...props}
      min={min}
      max={max}
      step={step}
      value={draft}
      onChange={(e) => {
        editing.current = true;
        setDraft(e.target.value);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") {
          editing.current = false;
          setDraft(String(value));
        }
      }}
      className={cn(FIELD_INPUT, "tabular-nums", className)}
    />
  );
}

/** A labelled switch row (label, hint, switch on the right). */
export function SwitchRow({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-xs font-medium text-foreground">{label}</p>
        {hint && <p className="mt-0.5 text-meta leading-relaxed text-muted-foreground">{hint}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 h-5 w-9 shrink-0 cursor-pointer rounded-full transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50",
          checked ? "bg-primary shadow-[0_0_0_3px_hsl(var(--primary)/0.12)]" : "bg-muted",
        )}
      >
        <span
          className={cn(
            "absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-all duration-200",
            checked ? "translate-x-4 scale-105" : "translate-x-0",
          )}
        />
      </button>
    </div>
  );
}
