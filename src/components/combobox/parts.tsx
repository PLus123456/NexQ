// Presentational pieces shared by LanguageCombobox and ModelCombobox
// (internal, not a public API). Tokens follow the settings pages.

import type React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";
import { keepInputFocus } from "./useCombobox";

/** The bordered field holding the input and its icon buttons. */
export function fieldClass(disabled?: boolean): string {
  return cn(
    "flex w-full items-center gap-1.5 rounded-lg border border-border/50 bg-secondary/30 px-3 py-2 text-sm text-foreground transition-colors",
    "focus-within:border-primary focus-within:ring-1 focus-within:ring-primary/20",
    disabled && "cursor-not-allowed opacity-50",
  );
}

export const inputClass =
  "min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/50 disabled:cursor-not-allowed";

export const iconButtonClass =
  "flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-muted-foreground";

export const listboxClass = "relative min-h-0 flex-1 overflow-y-auto";

export function optionClass(active: boolean, disabled?: boolean): string {
  return cn(
    "flex cursor-pointer select-none items-center gap-2 px-3 py-1.5 text-sm text-foreground transition-colors duration-100",
    active ? "bg-accent/70" : "hover:bg-accent/40",
    disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
  );
}

/** The chevron that opens or closes the list (not a tab stop; the input is). */
export function ComboboxToggle({
  open,
  label,
  disabled,
  onClick,
}: {
  open: boolean;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={label}
      title={label}
      disabled={disabled}
      onMouseDown={keepInputFocus}
      onClick={onClick}
      className={iconButtonClass}
    >
      <ChevronDown
        className={cn("h-3.5 w-3.5 transition-transform duration-150", open && "rotate-180")}
        aria-hidden
      />
    </button>
  );
}

/** The popover under (or above) the field. Clicks inside keep the input focused. */
export function ComboboxPopover({
  placement,
  children,
}: {
  placement: "top" | "bottom";
  children: React.ReactNode;
}) {
  return (
    <div
      onMouseDown={keepInputFocus}
      className={cn(
        "absolute left-0 right-0 z-50 flex max-h-72 flex-col overflow-hidden rounded-lg border border-border/40 bg-card py-1 shadow-lg",
        placement === "top" ? "bottom-full mb-1" : "top-full mt-1",
      )}
    >
      {children}
    </div>
  );
}

/** A labelled group of options inside the listbox. */
export function ComboboxGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={label}>
      <div
        aria-hidden
        className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60"
      >
        {label}
      </div>
      {children}
    </div>
  );
}

/** A non-selectable row: loading, error, empty state, "no matches". */
export function ComboboxStatus({
  tone = "muted",
  children,
}: {
  tone?: "muted" | "error";
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-3 py-2 text-xs",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}
