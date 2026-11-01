// Behaviour shared by LanguageCombobox and ModelCombobox (internal, not a
// public API): open state, the highlighted option (tracked by key, so it
// survives re-filtering), ArrowUp/Down/Enter/Esc, ARIA ids and wiring,
// opening above the input when there's no room below, and keeping the
// highlighted option scrolled into view.
//
// Mouse handling: the popover and the buttons inside the field cancel
// `mousedown`, so the input keeps focus while the user clicks options. The
// input's blur therefore always means "focus left the widget" (Tab, a click
// outside, the window losing focus).

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type React from "react";

export interface ComboboxItem {
  /** Stable key, unique in the list. */
  key: string;
  /** Can be highlighted (to read its explanation) but not picked. */
  disabled?: boolean;
}

/** The highlighted option: one by key, the first enabled one, or none. */
type Active = { key: string } | "first" | null;

export interface UseComboboxOptions<T extends ComboboxItem> {
  /** The options as listed right now, in order. */
  items: readonly T[];
  disabled?: boolean;
  /** Key of the committed value's option, highlighted when the list opens. */
  selectedKey?: string;
  /** The input holds uncommitted text (Enter and Esc act even when the list is closed). */
  dirty: boolean;
  /** Enter on the highlighted option, or a click on an option. Never called for disabled ones. */
  onPick(item: T): void;
  /** Enter with no option highlighted. Call `closeList()` when it commits. */
  onEnter(): void;
  /** Esc: drop the edit (the list is already closed). */
  onCancel(): void;
  /** Focus left the input (the list is already closed). */
  onLeave(): void;
}

/** Room the popover wants below the input before it opens above instead. */
const POPOVER_ROOM_PX = 288;

function resolveActive(active: Active, items: readonly ComboboxItem[]): number {
  if (active === null) return -1;
  if (active === "first") return items.findIndex((item) => !item.disabled);
  return items.findIndex((item) => item.key === active.key);
}

export function useCombobox<T extends ComboboxItem>(options: UseComboboxOptions<T>) {
  const { items, disabled = false, selectedKey, dirty } = options;
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (index: number) => `${baseId}-option-${index}`;

  const anchorRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<Active>(null);
  const [placement, setPlacement] = useState<"top" | "bottom">("bottom");

  const activeIndex = open ? resolveActive(active, items) : -1;
  // Always call the latest callbacks.
  const latest = useRef(options);
  latest.current = options;

  const selectedActive = (): Active => {
    if (selectedKey !== undefined && items.some((item) => item.key === selectedKey)) {
      return { key: selectedKey };
    }
    return null;
  };

  const openList = () => {
    if (disabled || open) return;
    setActive(selectedActive());
    setOpen(true);
  };

  const closeList = () => {
    setOpen(false);
    setActive(null);
  };

  /** Call when the text changes: opens the list, resets the highlight. */
  const typed = (highlightFirst: boolean) => {
    if (disabled) return;
    setActive(highlightFirst ? "first" : null);
    setOpen(true);
  };

  const pick = (item: T | undefined) => {
    if (!item || item.disabled) return;
    closeList();
    latest.current.onPick(item);
  };

  const move = (delta: 1 | -1) => {
    const count = items.length;
    if (count === 0) return;
    const from = activeIndex;
    const next = from < 0 ? (delta > 0 ? 0 : count - 1) : (from + delta + count) % count;
    setActive({ key: items[next].key });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Keys that confirm or move through an IME composition (pinyin…) aren't ours.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp": {
        if (disabled) return;
        e.preventDefault();
        if (!open) {
          setActive(selectedActive() ?? "first");
          setOpen(true);
        } else {
          move(e.key === "ArrowDown" ? 1 : -1);
        }
        return;
      }
      case "Enter": {
        if (!open && !dirty) return;
        e.preventDefault();
        if (activeIndex >= 0) {
          pick(items[activeIndex]);
          return;
        }
        latest.current.onEnter();
        return;
      }
      case "Escape": {
        if (!open && !dirty) return;
        // Don't let it close the settings window or a surrounding popover too.
        e.preventDefault();
        e.stopPropagation();
        closeList();
        latest.current.onCancel();
        return;
      }
    }
  };

  // A disabled field never shows its list.
  useEffect(() => {
    if (disabled) closeList();
  }, [disabled]);

  // Open above the input when there's no room below it (e.g. the bottom bar).
  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom;
    setPlacement(below < POPOVER_ROOM_PX && rect.top > below ? "top" : "bottom");
  }, [open]);

  // Keep the highlighted option visible (scrolls the list only, not the page).
  useEffect(() => {
    const list = listRef.current;
    if (!open || activeIndex < 0 || !list) return;
    const el = document.getElementById(optionId(activeIndex));
    if (!el) return;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }, [open, activeIndex]);

  const inputProps = {
    role: "combobox" as const,
    "aria-expanded": open,
    "aria-controls": open ? listboxId : undefined,
    "aria-autocomplete": "list" as const,
    "aria-activedescendant": activeIndex >= 0 ? optionId(activeIndex) : undefined,
    autoComplete: "off",
    autoCorrect: "off",
    autoCapitalize: "off",
    spellCheck: false,
    onKeyDown,
    onFocus: () => openList(),
    onClick: () => openList(),
    onBlur: () => {
      closeList();
      latest.current.onLeave();
    },
  };

  const getOptionProps = (index: number) => {
    const item = items[index];
    return {
      id: optionId(index),
      role: "option" as const,
      "aria-selected": index === activeIndex,
      "aria-disabled": item?.disabled ? true : undefined,
      onClick: () => pick(item),
    };
  };

  /** The chevron: opens (and focuses the input) or closes the list. */
  const toggle = () => {
    if (disabled) return;
    if (open) {
      closeList();
      return;
    }
    if (document.activeElement !== inputRef.current) inputRef.current?.focus();
    setActive(selectedActive());
    setOpen(true);
  };

  return {
    open,
    placement,
    activeIndex,
    anchorRef,
    inputRef,
    listRef,
    listboxId,
    openList,
    closeList,
    typed,
    toggle,
    inputProps,
    getOptionProps,
  };
}

/** Cancels `mousedown` so clicking inside the widget doesn't blur the input. */
export function keepInputFocus(e: React.MouseEvent) {
  e.preventDefault();
}
