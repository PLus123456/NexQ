// Model id input with candidates: type any id, or pick one from the list.
// Pure UI: the caller merges and passes the candidates (manual ∪ fetched ∪
// suggested) and does the fetching (`onRefresh`, `loading`, `error`).
//
// Controlled: typing only changes the text; `onChange` fires on commit with
// the trimmed text: Enter, a click on an option, or leaving the field with
// changed text. Typed text is never swapped for a candidate: Enter picks an
// option only after the user moved to it with the arrow keys. Esc puts the
// committed value back.
//
// Frozen after P0 (add-only props).

import { Fragment, useId, useMemo, useState } from "react";
import type React from "react";
import { Check, Loader2, RefreshCw } from "lucide-react";
import { useT } from "../i18n";
import { cn } from "../lib/utils";
import { keepInputFocus, useCombobox, type ComboboxItem } from "./combobox/useCombobox";
import {
  ComboboxGroup,
  ComboboxPopover,
  ComboboxStatus,
  ComboboxToggle,
  fieldClass,
  iconButtonClass,
  inputClass,
  listboxClass,
  optionClass,
} from "./combobox/parts";

export interface ModelOption {
  id: string;
  /** Display name when it differs from the id. */
  label?: string;
  /** Where the candidate comes from: "manual" (the user's list), "fetched" (/models), "suggested" (template). */
  source?: "manual" | "fetched" | "suggested";
  /** Short extra text, e.g. context length. */
  detail?: string;
}

export interface ModelComboboxProps {
  value: string;
  /** Called with the trimmed text or the picked option's id (may be "" when the user clears the field). */
  onChange: (model: string) => void;
  /** Candidates: manual ∪ fetched ∪ suggested, already merged by the caller; duplicates (same id) are shown once (first wins). Plain strings are accepted. */
  options: readonly (ModelOption | string)[];
  placeholder?: string;
  disabled?: boolean;
  /** Fetching candidates (shows a spinner in the list header). */
  loading?: boolean;
  /** Last fetch error, shown in the list (doesn't block typing). */
  error?: string | null;
  /** When provided, a refresh button fetches the model list. */
  onRefresh?: () => void;
  /** Put on the input (for `<label htmlFor>`). */
  id?: string;
  "aria-label"?: string;
  /** On the outer element (width, margins). */
  className?: string;
}

type Group = "manual" | "fetched" | "suggested" | "other";

/** Group order when the list shows headers: the user's list first. */
const GROUPS: readonly Group[] = ["manual", "fetched", "suggested", "other"];

interface ModelItem extends ComboboxItem {
  id: string;
  label?: string;
  detail?: string;
  group: Group;
}

interface Section {
  group: Group;
  start: number;
  end: number;
}

const modelKey = (id: string) => `model:${id}`;

/** Trims ids, drops empty ones and duplicates (first wins). */
function toItems(options: readonly (ModelOption | string)[]): ModelItem[] {
  const seen = new Set<string>();
  const items: ModelItem[] = [];
  for (const raw of options) {
    const option: Partial<ModelOption> | null = typeof raw === "string" ? { id: raw } : raw;
    if (!option || typeof option.id !== "string") continue;
    const id = option.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = option.label?.trim();
    const group = GROUPS.find((g) => g === option.source) ?? "other";
    items.push({
      key: modelKey(id),
      id,
      label: label && label !== id ? label : undefined,
      detail: option.detail?.trim() || undefined,
      group,
    });
  }
  return items;
}

/** Every word of the query in the id or the label (case-insensitive). */
function matches(item: ModelItem, words: readonly string[]): boolean {
  const id = item.id.toLowerCase();
  const label = item.label?.toLowerCase() ?? "";
  return words.every((w) => id.includes(w) || label.includes(w));
}

export function ModelCombobox({
  value,
  onChange,
  options,
  placeholder,
  disabled = false,
  loading = false,
  error,
  onRefresh,
  id,
  "aria-label": ariaLabel,
  className,
}: ModelComboboxProps) {
  const { t } = useT("common");
  const hintId = useId();
  /** The text being edited; null shows `value`. */
  const [draft, setDraft] = useState<string | null>(null);

  const all = useMemo(() => toItems(options), [options]);
  const grouped = useMemo(() => new Set(all.map((item) => item.group)).size > 1, [all]);
  const ordered = useMemo(
    () => (grouped ? GROUPS.flatMap((g) => all.filter((item) => item.group === g)) : all),
    [all, grouped],
  );
  const query = draft?.trim().toLowerCase() ?? "";
  const items = useMemo(() => {
    if (!query) return ordered;
    const words = query.split(/\s+/);
    return ordered.filter((item) => matches(item, words));
  }, [ordered, query]);

  const sections = useMemo((): Section[] => {
    if (!grouped) return [{ group: "other", start: 0, end: items.length }];
    const out: Section[] = [];
    items.forEach((item, index) => {
      const last = out[out.length - 1];
      if (last && last.group === item.group) last.end = index + 1;
      else out.push({ group: item.group, start: index, end: index + 1 });
    });
    return out;
  }, [grouped, items]);

  const committed = value.trim();
  const showHint = committed !== "" && all.length > 0 && !all.some((item) => item.id === committed);

  const commitText = () => {
    if (draft === null) return;
    const next = draft.trim();
    setDraft(null);
    if (next !== value) onChange(next);
  };

  const cb = useCombobox<ModelItem>({
    items,
    disabled,
    selectedKey: committed ? modelKey(committed) : undefined,
    dirty: draft !== null,
    onPick: (item) => {
      setDraft(null);
      if (item.id !== value) onChange(item.id);
    },
    onEnter: () => {
      cb.closeList();
      commitText();
    },
    onCancel: () => setDraft(null),
    onLeave: () => commitText(),
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setDraft(e.target.value);
    cb.typed(false);
  };

  const refresh = () => {
    if (!onRefresh) return;
    onRefresh();
    if (document.activeElement === cb.inputRef.current) cb.openList();
  };

  const groupLabel = (group: Group) => t(`components.modelCombobox.groups.${group}`);

  const renderOption = (item: ModelItem, index: number) => {
    const active = index === cb.activeIndex;
    const selected = item.id === committed;
    return (
      <div
        key={item.key}
        {...cb.getOptionProps(index)}
        title={item.label ? `${item.label} (${item.id})` : item.id}
        className={optionClass(active)}
      >
        <Check className={cn("h-3.5 w-3.5 shrink-0 text-primary", !selected && "invisible")} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{item.label ?? item.id}</span>
          {item.label && (
            <span className="block truncate font-mono text-[11px] text-muted-foreground">{item.id}</span>
          )}
        </span>
        {item.detail && <span className="shrink-0 text-[11px] text-muted-foreground">{item.detail}</span>}
      </div>
    );
  };

  return (
    <div className={cn("w-full", className)}>
      <div ref={cb.anchorRef} className="relative">
        <div className={fieldClass(disabled)}>
          <input
            ref={cb.inputRef}
            id={id}
            type="text"
            aria-label={ariaLabel}
            aria-describedby={showHint ? hintId : undefined}
            {...cb.inputProps}
            value={draft ?? value}
            placeholder={placeholder ?? t("components.modelCombobox.placeholder")}
            disabled={disabled}
            onChange={handleChange}
            className={inputClass}
          />
          {onRefresh && (
            <button
              type="button"
              aria-label={t("components.modelCombobox.refresh")}
              title={t("components.modelCombobox.refresh")}
              disabled={disabled || loading}
              onMouseDown={keepInputFocus}
              onClick={refresh}
              className={iconButtonClass}
            >
              {loading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              )}
            </button>
          )}
          {all.length > 0 && (
            <ComboboxToggle
              open={cb.open}
              label={t("components.modelCombobox.toggle")}
              disabled={disabled}
              onClick={cb.toggle}
            />
          )}
        </div>
        {cb.open && (
          <ComboboxPopover placement={cb.placement}>
            {loading && (
              <ComboboxStatus>
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
                {t("components.modelCombobox.loading")}
              </ComboboxStatus>
            )}
            {error && (
              <ComboboxStatus tone="error">
                <span className="min-w-0 break-words">
                  {t("components.modelCombobox.fetchFailed", { detail: error })}
                </span>
              </ComboboxStatus>
            )}
            <div ref={cb.listRef} id={cb.listboxId} role="listbox" aria-label={ariaLabel} className={listboxClass}>
              {sections.map((section) => {
                const rows = items
                  .slice(section.start, section.end)
                  .map((item, i) => renderOption(item, section.start + i));
                return grouped ? (
                  <ComboboxGroup key={section.group} label={groupLabel(section.group)}>
                    {rows}
                  </ComboboxGroup>
                ) : (
                  <Fragment key={section.group}>{rows}</Fragment>
                );
              })}
            </div>
            {all.length === 0
              ? !loading && (
                  <ComboboxStatus>
                    <span className="min-w-0 flex-1">{t("components.modelCombobox.empty")}</span>
                    {onRefresh && (
                      <button
                        type="button"
                        onClick={refresh}
                        disabled={disabled}
                        className="shrink-0 cursor-pointer font-medium text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {t("components.modelCombobox.fetchList")}
                      </button>
                    )}
                  </ComboboxStatus>
                )
              : items.length === 0 && (
                  <ComboboxStatus>
                    {t("components.modelCombobox.noMatches", { value: draft?.trim() ?? "" })}
                  </ComboboxStatus>
                )}
          </ComboboxPopover>
        )}
      </div>
      {showHint && (
        <p id={hintId} className="mt-1 text-xs text-muted-foreground">
          {t("components.modelCombobox.notInList")}
        </p>
      )}
    </div>
  );
}
