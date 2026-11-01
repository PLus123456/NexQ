import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Clock3 } from "lucide-react";
import type { ParseKeys } from "i18next";
import { Trans, useT } from "../i18n";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";
import {
  DEFAULT_CONTEXT_SCOPE,
  MAX_MINUTES,
  MIN_MINUTES,
  MINUTE_PRESETS,
  SCOPE_KINDS,
  clampMinutes,
  scopeChipLabel,
} from "../lib/contextScope";
import type { ContextScopeKind, ContextScopeSetting } from "../lib/types";

/** Option labels; "minutes" is composed from the number (`scope.label.minutes`). */
const OPTION_LABEL_KEYS: Record<Exclude<ContextScopeKind, "minutes">, ParseKeys<"overlay">> = { // i18n-ignore: type annotation, not text
  default: "scope.label.default",
  since_last_any: "scope.label.sinceLastAny",
  since_last_same: "scope.option.sinceLastSame",
  all: "scope.label.all",
};

const OPTION_HINT_KEYS: Record<ContextScopeKind, ParseKeys<"overlay"> | null> = {
  default: "scope.optionHint.default",
  since_last_any: "scope.optionHint.sinceLastAny",
  since_last_same: "scope.optionHint.sinceLastSame",
  minutes: null,
  all: "scope.optionHint.all",
};

const POPOVER_WIDTH = 232;

/** Next/previous minute preset from `minutes` (custom values snap to the nearest step). */
function stepMinutes(minutes: number, dir: 1 | -1): number {
  const presets = [...MINUTE_PRESETS];
  if (dir === 1) return presets.find((p) => p > minutes) ?? presets[presets.length - 1];
  return [...presets].reverse().find((p) => p < minutes) ?? presets[0];
}

/**
 * Chip at the end of the overlay action row: which part of the meeting the
 * next actions focus on. Opens a small popover with the scopes, minute
 * presets (+ custom) and "Keep for next actions".
 */
export function ContextScopePicker() {
  const { t } = useT("overlay");
  const scope = useConfigStore((s) => s.contextScope ?? DEFAULT_CONTEXT_SCOPE);
  const sticky = useConfigStore((s) => s.contextScopeSticky ?? true);
  const setScope = useConfigStore((s) => s.setContextScope);
  const setSticky = useConfigStore((s) => s.setContextScopeSticky);
  const isClaude = useConfigStore((s) => s.llmProvider === "claude_cli");
  // Claude ignores per-action windows: its session holds the whole meeting.
  const defaultHint = isClaude ? t("scope.optionHint.defaultClaude") : t("scope.optionHint.default");
  const openActionSettings = () => {
    setOpen(false);
    useMeetingStore.getState().openSettings("ai_actions");
  };

  const [open, setOpen] = useState(false);
  const [focusIdx, setFocusIdx] = useState(0);
  const [customText, setCustomText] = useState("");
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const chipRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const isCustomMinutes = !(MINUTE_PRESETS as readonly number[]).includes(scope.minutes);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) chipRef.current?.focus();
  }, []);

  const openPicker = useCallback(() => {
    setFocusIdx(Math.max(0, SCOPE_KINDS.indexOf(scope.kind)));
    setCustomText(isCustomMinutes ? String(scope.minutes) : "");
    setOpen(true);
  }, [scope, isCustomMinutes]);

  // Anchor under the chip, right-aligned, kept inside the window.
  useLayoutEffect(() => {
    if (!open || !chipRef.current) return;
    const r = chipRef.current.getBoundingClientRect();
    const left = Math.min(Math.max(8, r.right - POPOVER_WIDTH), window.innerWidth - POPOVER_WIDTH - 8);
    setPos({ top: r.bottom + 6, left: Math.max(8, left) });
  }, [open]);

  // Focus the selected option on open (and follow arrow-key focus).
  useEffect(() => {
    if (open) optionRefs.current[focusIdx]?.focus();
  }, [open, focusIdx]);

  // Click outside closes (without stealing focus back).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popRef.current?.contains(target) || chipRef.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, close]);

  const choose = useCallback(
    (next: ContextScopeSetting, keepOpen = false) => {
      setScope(next);
      if (!keepOpen) close();
    },
    [setScope, close],
  );

  const commitCustom = useCallback(() => {
    const n = Number(customText);
    if (!customText.trim() || !Number.isFinite(n)) return;
    choose({ kind: "minutes", minutes: clampMinutes(n) });
  }, [customText, choose]);

  // Keys inside the popover never reach the window-level action shortcuts.
  const onPopoverKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  const onOptionKeyDown = (e: React.KeyboardEvent, idx: number) => {
    const kind = SCOPE_KINDS[idx];
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setFocusIdx((idx + 1) % SCOPE_KINDS.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        setFocusIdx((idx - 1 + SCOPE_KINDS.length) % SCOPE_KINDS.length);
        break;
      case "Home":
        e.preventDefault();
        setFocusIdx(0);
        break;
      case "End":
        e.preventDefault();
        setFocusIdx(SCOPE_KINDS.length - 1);
        break;
      case "ArrowRight":
      case "ArrowLeft":
        if (kind === "minutes") {
          e.preventDefault();
          choose({ kind: "minutes", minutes: stepMinutes(scope.minutes, e.key === "ArrowRight" ? 1 : -1) }, true);
        }
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        choose({ kind, minutes: scope.minutes });
        break;
    }
  };

  const active = scope.kind !== "default";
  const chipLabel = scopeChipLabel(scope);
  const oneOff = active && !sticky;

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        onClick={() => (open ? close() : openPicker())}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
            e.preventDefault();
            e.stopPropagation();
            if (!open) openPicker();
          }
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t(oneOff ? "scope.chip.ariaLabelOnce" : "scope.chip.ariaLabel", { label: chipLabel })}
        title={t(oneOff ? "scope.chip.titleOnce" : "scope.chip.ariaLabel", { label: chipLabel })}
        className={`ml-auto flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-meta font-medium transition-colors duration-150 cursor-pointer ${
          active
            ? "bg-primary/10 text-primary/90 ring-1 ring-inset ring-primary/20 hover:bg-primary/15"
            : open
              ? "bg-accent/50 text-foreground"
              : "text-muted-foreground/60 hover:bg-accent/50 hover:text-foreground"
        }`}
      >
        <Clock3 className="h-3 w-3" aria-hidden="true" />
        <span className="max-w-[7.5rem] truncate">{chipLabel}</span>
        {oneOff && <span className="text-primary/50" aria-hidden="true">· {t("scope.chip.once")}</span>}
      </button>

      {open &&
        createPortal(
          <div
            ref={popRef}
            role="dialog"
            aria-label={t("scope.dialog.title")}
            onKeyDown={onPopoverKeyDown}
            style={{ top: pos.top, left: pos.left, width: POPOVER_WIDTH }}
            className="scope-pop-enter fixed z-50 rounded-xl border border-border/30 bg-popover/95 p-1.5 shadow-2xl backdrop-blur-md"
          >
            <p className="px-2 pb-1 pt-0.5 text-[0.6rem] font-medium uppercase tracking-widest text-muted-foreground/45">
              {t("scope.dialog.heading")}
            </p>
            <div role="radiogroup" aria-label={t("scope.dialog.title")} className="flex flex-col">
              {SCOPE_KINDS.map((kind, idx) => {
                const checked = scope.kind === kind;
                const hintKey = OPTION_HINT_KEYS[kind];
                const hint = kind === "default" ? defaultHint : hintKey ? t(hintKey) : "";
                return (
                  <div key={kind}>
                    <button
                      ref={(el) => {
                        optionRefs.current[idx] = el;
                      }}
                      type="button"
                      role="radio"
                      aria-checked={checked}
                      tabIndex={idx === focusIdx ? 0 : -1}
                      onClick={() => choose({ kind, minutes: scope.minutes })}
                      onKeyDown={(e) => onOptionKeyDown(e, idx)}
                      onFocus={() => setFocusIdx(idx)}
                      className={`group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-150 ${
                        checked ? "bg-primary/10" : "hover:bg-accent/40"
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className={`flex h-3 w-3 shrink-0 items-center justify-center rounded-full border transition-colors duration-150 ${
                          checked ? "border-primary/70" : "border-muted-foreground/30"
                        }`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full bg-primary transition-transform duration-200 ${
                            checked ? "scale-100" : "scale-0"
                          }`}
                        />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={`block text-xs ${checked ? "text-foreground" : "text-foreground/80"}`}>
                          {kind === "minutes"
                            ? t("scope.label.minutes", { minutes: clampMinutes(scope.minutes) })
                            : t(OPTION_LABEL_KEYS[kind])}
                        </span>
                        {hint && (
                          <span className="block truncate text-meta text-muted-foreground/50">
                            {hint}
                          </span>
                        )}
                      </span>
                    </button>

                    {kind === "minutes" && (
                      <div className="flex items-center gap-1 pb-1 pl-7 pr-2" role="group" aria-label={t("scope.minutes.group")}>
                        {MINUTE_PRESETS.map((m) => {
                          const on = scope.kind === "minutes" && scope.minutes === m;
                          return (
                            <button
                              key={m}
                              type="button"
                              tabIndex={-1}
                              onClick={() => choose({ kind: "minutes", minutes: m })}
                              aria-label={t("scope.minutes.preset", { minutes: m })}
                              aria-pressed={on}
                              className={`h-5 min-w-[1.5rem] rounded-md px-1 text-meta tabular-nums transition-colors duration-150 ${
                                on
                                  ? "bg-primary/15 text-primary"
                                  : "text-muted-foreground/60 hover:bg-accent/50 hover:text-foreground"
                              }`}
                            >
                              {m}
                            </button>
                          );
                        })}
                        <input
                          type="number"
                          inputMode="numeric"
                          min={MIN_MINUTES}
                          max={MAX_MINUTES}
                          value={customText}
                          placeholder="…"
                          onChange={(e) => setCustomText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              commitCustom();
                            }
                          }}
                          aria-label={t("scope.minutes.custom", { min: MIN_MINUTES, max: MAX_MINUTES })}
                          className={`h-5 w-9 rounded-md border bg-transparent px-1 text-center text-meta tabular-nums text-foreground/80 outline-none transition-colors duration-150 placeholder:text-muted-foreground/40 focus:border-primary/40 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none ${
                            scope.kind === "minutes" && isCustomMinutes ? "border-primary/30" : "border-border/30"
                          }`}
                        />
                        <span className="text-meta text-muted-foreground/40">{t("scope.minutes.unit")}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <p className="px-2 pb-1 pt-1.5 text-meta leading-snug text-muted-foreground/55">
              {isClaude ? (
                t("scope.note.claude")
              ) : (
                <Trans
                  t={t}
                  i18nKey="scope.note.settings"
                  components={{
                    settings: (
                      <button
                        type="button"
                        onClick={openActionSettings}
                        className="cursor-pointer text-primary/80 underline-offset-2 hover:text-primary hover:underline"
                      />
                    ),
                  }}
                />
              )}
            </p>

            <div className="mt-1 flex items-center justify-between gap-2 border-t border-border/15 px-2 pb-0.5 pt-2">
              <span className="text-xs text-foreground/75">{t("scope.sticky.label")}</span>
              <button
                type="button"
                role="switch"
                aria-checked={sticky}
                aria-label={t("scope.sticky.label")}
                onClick={() => setSticky(!sticky)}
                className={`relative h-4 w-7 shrink-0 cursor-pointer rounded-full transition-colors duration-200 ${
                  sticky ? "bg-primary/80" : "bg-muted"
                }`}
              >
                <span
                  className={`absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-transform duration-200 ${
                    sticky ? "translate-x-3" : "translate-x-0"
                  }`}
                />
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
