// Small building blocks shared by the AI model settings (connections, routing,
// quick setup): class names in the settings pages' style, a switch, a status
// dot and the connection icon.

import type React from "react";
import { Cloud, Server, Settings2, Terminal } from "lucide-react";
import { cn } from "../../lib/utils";
import type { LlmConnection } from "../../lib/llm/types";
import { findTemplate } from "./providerTemplates";

export const CARD = "rounded-xl border border-border/30 bg-card/50 p-5";
export const SECTION_TITLE = "text-sm font-semibold text-primary/80";
export const LABEL = "mb-1.5 block text-xs font-medium text-foreground";
export const HINT = "mt-1.5 text-xs text-muted-foreground";
export const INPUT =
  "w-full rounded-lg border border-border/50 bg-secondary/30 px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50";
export const INPUT_INVALID = "border-destructive/60 focus:border-destructive/60 focus:ring-destructive/20";
export const SELECT = cn(INPUT, "cursor-pointer");
export const BUTTON =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-border/50 bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors duration-150 hover:bg-accent cursor-pointer disabled:cursor-not-allowed disabled:opacity-50";
export const BUTTON_PRIMARY =
  "inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3.5 py-1.5 text-xs font-medium text-primary-foreground shadow-sm shadow-primary/20 transition-colors duration-150 hover:bg-primary/90 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50";
export const BUTTON_DANGER =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-1.5 text-xs font-medium text-destructive transition-colors duration-150 hover:bg-destructive/10 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50";
export const LINK_BUTTON =
  "cursor-pointer text-xs font-medium text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50";

/** Text inputs that hold addresses, ids and keys: no spell check or autocorrect. */
export const PLAIN_TEXT = { spellCheck: false, autoCapitalize: "off", autoCorrect: "off", autoComplete: "off" } as const;

export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
  describedBy,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name. */
  label: string;
  disabled?: boolean;
  describedBy?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-4 w-7 shrink-0 cursor-pointer rounded-full transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-muted",
      )}
    >
      <span
        className={cn(
          "absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-transform duration-200",
          checked ? "translate-x-3" : "translate-x-0",
        )}
      />
    </button>
  );
}

/** Segmented control (one choice of a few). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  labelledBy,
  disabled = false,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (next: T) => void;
  labelledBy?: string;
  disabled?: boolean;
}) {
  return (
    <div role="group" aria-labelledby={labelledBy} className="inline-flex flex-wrap rounded-lg border border-border/50 bg-secondary/30 p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-md px-3 py-1.5 text-xs font-medium transition-all duration-150 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50",
            value === option.value
              ? "bg-primary text-primary-foreground shadow-sm shadow-primary/20"
              : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export type ConnectionStatus = "ready" | "untested" | "error" | "disabled";

const DOT: Record<ConnectionStatus, string> = {
  ready: "bg-success",
  untested: "bg-muted-foreground/40",
  error: "bg-warning",
  disabled: "bg-muted-foreground/20",
};

/** Ready = tested OK; error = the last model fetch failed; untested otherwise. */
export function connectionStatus(connection: LlmConnection): ConnectionStatus {
  if (!connection.enabled) return "disabled";
  if (connection.verified_at_ms) return "ready";
  if (connection.model_cache?.error) return "error";
  return "untested";
}

export function StatusDot({ status, className }: { status: ConnectionStatus; className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-status={status}
      className={cn("inline-block h-2 w-2 shrink-0 rounded-full", DOT[status], className)}
    />
  );
}

/** Local servers, Claude, custom endpoints and cloud vendors each get an icon. */
export function ConnectionIcon({ connection, className }: { connection: Pick<LlmConnection, "kind" | "template">; className?: string }) {
  const template = findTemplate(connection.template);
  const Icon =
    connection.kind === "claude_cli"
      ? Terminal
      : connection.kind === "ollama" || template?.group === "local"
        ? Server
        : template?.id === "custom" || !template
          ? Settings2
          : Cloud;
  return <Icon className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground", className)} aria-hidden />;
}

/** A block of explanatory text with an icon. */
export function Notice({
  icon,
  tone = "info",
  children,
  className,
}: {
  icon?: React.ReactNode;
  tone?: "info" | "warning" | "error" | "success";
  children: React.ReactNode;
  className?: string;
}) {
  const toneClass = {
    info: "border-border/30 bg-accent/20 text-muted-foreground",
    warning: "border-warning/25 bg-warning/5 text-foreground/80",
    error: "border-destructive/25 bg-destructive/5 text-foreground/80",
    success: "border-success/25 bg-success/5 text-foreground/80",
  }[tone];
  return (
    <div className={cn("flex items-start gap-2 rounded-lg border px-3 py-2 text-xs", toneClass, className)}>
      {icon && <span className="mt-px shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
