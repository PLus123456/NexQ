// Language picker: common languages first, the whole catalog by typing, free
// input for codes the catalog doesn't know, optional "Auto-detect".
//
// Controlled: `value` is a code (or AUTO_LANGUAGE); `onChange` fires once per
// commit with a normalized code (Enter, a click on an option). Leaving the
// field (Tab, click outside) or Esc commits nothing and puts the selected
// language's name back. Typed text that isn't in the catalog is offered as
// “Use "xx-YY" as typed” when it looks like a language code (letters/digits
// and dashes, e.g. "yue", "es-MX"); other text can't be committed.
//
// Frozen after P0 (add-only props).

import { Fragment, useMemo, useRef, useState } from "react";
import type React from "react";
import { Check } from "lucide-react";
import { useT, useUiLanguage, type UiLanguage } from "../i18n";
import {
  AUTO_LANGUAGE,
  LANGUAGES,
  STT_COMMON,
  findLanguage,
  languageLabel,
  normalizeLanguageCode,
} from "../lib/languages";
import { cn } from "../lib/utils";
import { useCombobox, type ComboboxItem } from "./combobox/useCombobox";
import {
  ComboboxGroup,
  ComboboxPopover,
  ComboboxStatus,
  ComboboxToggle,
  fieldClass,
  inputClass,
  listboxClass,
  optionClass,
} from "./combobox/parts";

export interface LanguageComboboxProps {
  /** A language code, or AUTO_LANGUAGE. */
  value: string;
  /** Called with a normalized code, or AUTO_LANGUAGE. */
  onChange: (code: string) => void;
  /** Codes listed first (default STT_COMMON). Any code from the catalog can still be found by typing. */
  common?: readonly string[];
  /** Offer "Auto-detect" (AUTO_LANGUAGE) as the first option. */
  allowAuto?: boolean;
  /** When set, the Auto-detect option is shown disabled with this explanation (engine can't auto-detect). */
  autoUnavailableReason?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Put on the input (for `<label htmlFor>`). */
  id?: string;
  "aria-label"?: string;
  /** On the outer element (width, margins). */
  className?: string;
}

interface LanguageItem extends ComboboxItem {
  kind: "auto" | "language" | "custom";
  code: string;
  label: string;
  /** Endonym, shown next to the name when it differs. */
  native?: string;
  /** Why the Auto-detect option is disabled. */
  reason?: string;
  section?: "common" | "more";
  /** Lower-case code and names, for filtering. */
  terms: string[];
}

interface Section {
  key: string;
  label?: string;
  start: number;
  end: number;
}

const AUTO_KEY = "auto";
const CUSTOM_KEY = "custom";
const languageKey = (code: string) => `lang:${code}`;

/** Looks like a language tag: "yue", "es-MX", "zh-Hant-HK", "x-custom" (not "Chinese (Simplified)"). */
function isCodeLike(code: string): boolean {
  return /^(?:[a-z]{2,3}(?:-[a-z\d]{1,8})*|[xi](?:-[a-z\d]{1,8})+)$/i.test(code);
}

/** Search text: lower case, "_" → "-", single spaces. */
function searchText(text: string): string {
  return text.trim().toLowerCase().replace(/_/g, "-").replace(/\s+/g, " ");
}

/** `query` at the start of `term` or of one of its words. */
function startsWord(term: string, query: string): boolean {
  return (
    term.startsWith(query) ||
    term.includes(` ${query}`) ||
    term.includes(`(${query}`) ||
    term.includes(`（${query}`)
  );
}

function languageItem(code: string, ui: UiLanguage, section: "common" | "more"): LanguageItem {
  const info = findLanguage(code);
  const exact = info?.code === code ? info : undefined;
  return {
    key: languageKey(code),
    kind: "language",
    code,
    label: languageLabel(code, ui),
    native: exact?.native,
    section,
    terms: [code, languageLabel(code, "en"), languageLabel(code, "zh-CN"), info?.native ?? ""]
      .map(searchText)
      .filter(Boolean),
  };
}

/** Auto (if allowed) → the common codes → the rest of the catalog sorted by name. */
function buildItems(
  common: readonly string[],
  allowAuto: boolean,
  autoUnavailableReason: string | undefined,
  ui: UiLanguage,
): LanguageItem[] {
  const items: LanguageItem[] = [];
  if (allowAuto) {
    items.push({
      key: AUTO_KEY,
      kind: "auto",
      code: AUTO_LANGUAGE,
      label: languageLabel(AUTO_LANGUAGE, ui),
      reason: autoUnavailableReason || undefined,
      disabled: Boolean(autoUnavailableReason),
      terms: [AUTO_LANGUAGE, languageLabel(AUTO_LANGUAGE, "en"), languageLabel(AUTO_LANGUAGE, "zh-CN")].map(
        searchText,
      ),
    });
  }
  const commonCodes = [
    ...new Set(common.map(normalizeLanguageCode).filter((c) => c && c !== AUTO_LANGUAGE)),
  ];
  const commonSet = new Set(commonCodes);
  items.push(...commonCodes.map((code) => languageItem(code, ui, "common")));
  const collator = new Intl.Collator(ui);
  const rest = LANGUAGES.filter((l) => !commonSet.has(l.code))
    .map((l) => languageItem(l.code, ui, "more"))
    .sort((a, b) => collator.compare(a.label, b.label) || a.code.localeCompare(b.code));
  items.push(...rest);
  return items;
}

/**
 * Matches (every word of the query in the code or a name), best first: the
 * exact code, then prefix matches, then “use as typed” (a code-like query
 * that isn't a listed code), then the other matches; ties keep list order.
 */
function filterItems(items: readonly LanguageItem[], query: string, useAsTyped: (code: string) => string) {
  const q = searchText(query);
  const words = q.split(" ");
  const code = normalizeLanguageCode(query);
  const codeLower = code.toLowerCase();
  const ranked: { item: LanguageItem; tier: number; index: number }[] = [];
  items.forEach((item, index) => {
    if (!words.every((w) => item.terms.some((term) => term.includes(w)))) return;
    const tier = item.code.toLowerCase() === codeLower ? 0 : item.terms.some((term) => startsWord(term, q)) ? 1 : 3;
    ranked.push({ item, tier, index });
  });
  if (!ranked.some((r) => r.tier === 0) && isCodeLike(code)) {
    ranked.push({
      item: { key: CUSTOM_KEY, kind: "custom", code, label: useAsTyped(code), terms: [] },
      tier: 2,
      index: -1,
    });
  }
  ranked.sort((a, b) => a.tier - b.tier || a.index - b.index);
  return ranked.map((r) => r.item);
}

export function LanguageCombobox({
  value,
  onChange,
  common = STT_COMMON,
  allowAuto = false,
  autoUnavailableReason,
  placeholder,
  disabled = false,
  id,
  "aria-label": ariaLabel,
  className,
}: LanguageComboboxProps) {
  const { t } = useT("common");
  const { language: ui } = useUiLanguage();
  /** What the user typed since the list opened; null shows the selected language's name. */
  const [query, setQuery] = useState<string | null>(null);
  const selectOnMouseUp = useRef(false);

  const current = normalizeLanguageCode(value);
  const currentLabel = current ? languageLabel(current, ui) : "";
  const showCode = query === null && current !== "" && current !== AUTO_LANGUAGE && currentLabel !== current;

  // `common` by content: callers may pass a new array on every render.
  const commonKey = common.join("|");
  const allItems = useMemo(
    () => buildItems(common, allowAuto, autoUnavailableReason, ui),
    [commonKey, allowAuto, autoUnavailableReason, ui, t],
  );
  const filtering = query !== null && query.trim() !== "";
  const items = useMemo(
    () =>
      filtering
        ? filterItems(allItems, query, (code) => t("components.languageCombobox.useAsTyped", { value: code }))
        : allItems,
    [allItems, filtering, query, t],
  );

  const sections = useMemo((): Section[] => {
    if (filtering) return [{ key: "results", start: 0, end: items.length }];
    const out: Section[] = [];
    let i = 0;
    const take = (key: string, matches: (item: LanguageItem) => boolean, label?: string) => {
      const start = i;
      while (i < items.length && matches(items[i])) i++;
      if (i > start) out.push({ key, label, start, end: i });
    };
    take("auto", (item) => item.kind === "auto");
    take("common", (item) => item.section === "common", t("components.languageCombobox.commonGroup"));
    const hasCommon = out.some((s) => s.key === "common");
    take("more", (item) => item.section === "more", hasCommon ? t("components.languageCombobox.moreGroup") : undefined);
    return out;
  }, [filtering, items, t]);

  const commit = (code: string) => {
    setQuery(null);
    if (code !== value) onChange(code);
  };

  const cb = useCombobox<LanguageItem>({
    items,
    disabled,
    selectedKey: current === AUTO_LANGUAGE ? AUTO_KEY : current ? languageKey(current) : undefined,
    dirty: query !== null,
    onPick: (item) => commit(item.code),
    onEnter: () => {
      // Nothing highlighted: the typed text itself if it can be a code;
      // otherwise (a name) show what it matches.
      const code = normalizeLanguageCode(query ?? "");
      if (code === "") {
        setQuery(null);
        cb.closeList();
      } else if (isCodeLike(code)) {
        cb.closeList();
        commit(code);
      } else {
        cb.typed(true);
      }
    },
    onCancel: () => setQuery(null),
    onLeave: () => setQuery(null),
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let next = e.target.value;
    // Typed after the shown name (caret at the end): start a new search.
    if (query === null && currentLabel && next.length > currentLabel.length && next.startsWith(currentLabel)) {
      next = next.slice(currentLabel.length);
    }
    setQuery(next);
    cb.typed(next.trim() !== "");
  };

  const codeId = `${cb.listboxId}-code`;

  const renderOption = (item: LanguageItem, index: number) => {
    const active = index === cb.activeIndex;
    const selected = item.kind !== "custom" && item.code === current;
    return (
      <div key={item.key} {...cb.getOptionProps(index)} title={item.reason} className={optionClass(active, item.disabled)}>
        <Check className={cn("h-3.5 w-3.5 shrink-0 text-primary", !selected && "invisible")} aria-hidden />
        {item.kind === "language" ? (
          <>
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.native && item.native !== item.label && (
              <span dir="auto" className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground/70">
                {item.native}
              </span>
            )}
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{item.code}</span>
          </>
        ) : (
          <span className={cn("min-w-0 flex-1", item.kind === "custom" && "text-muted-foreground")}>
            <span className="block truncate">{item.label}</span>
            {item.reason && (
              <span className="block text-[11px] leading-snug text-muted-foreground">{item.reason}</span>
            )}
          </span>
        )}
      </div>
    );
  };

  return (
    <div ref={cb.anchorRef} className={cn("relative w-full", className)}>
      <div className={fieldClass(disabled)}>
        <input
          ref={cb.inputRef}
          id={id}
          type="text"
          aria-label={ariaLabel}
          aria-describedby={showCode ? codeId : undefined}
          {...cb.inputProps}
          value={query ?? currentLabel}
          placeholder={placeholder ?? t("components.languageCombobox.placeholder")}
          disabled={disabled}
          onChange={handleChange}
          onMouseDown={(e) => {
            if (document.activeElement !== e.currentTarget) selectOnMouseUp.current = true;
          }}
          onFocus={(e) => {
            cb.inputProps.onFocus();
            // Typing replaces the shown name.
            e.currentTarget.select();
          }}
          onMouseUp={(e) => {
            // The click that focused the field would otherwise drop the selection.
            if (!selectOnMouseUp.current) return;
            selectOnMouseUp.current = false;
            e.preventDefault();
            if (query === null) e.currentTarget.select();
          }}
          className={inputClass}
        />
        {showCode && (
          <span id={codeId} className="shrink-0 font-mono text-[11px] text-muted-foreground">
            {current}
          </span>
        )}
        <ComboboxToggle
          open={cb.open}
          label={t("components.languageCombobox.toggle")}
          disabled={disabled}
          onClick={cb.toggle}
        />
      </div>
      {cb.open && (
        <ComboboxPopover placement={cb.placement}>
          <div ref={cb.listRef} id={cb.listboxId} role="listbox" aria-label={ariaLabel} className={listboxClass}>
            {sections.map((section) => {
              const options = items.slice(section.start, section.end).map((item, i) => renderOption(item, section.start + i));
              return section.label ? (
                <ComboboxGroup key={section.key} label={section.label}>
                  {options}
                </ComboboxGroup>
              ) : (
                <Fragment key={section.key}>{options}</Fragment>
              );
            })}
          </div>
          {items.length === 0 && <ComboboxStatus>{t("components.languageCombobox.noMatches")}</ComboboxStatus>}
        </ComboboxPopover>
      )}
    </div>
  );
}
