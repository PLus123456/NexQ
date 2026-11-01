import { useEffect, useRef } from "react";
import { Pin, X } from "lucide-react";
import { useT } from "../i18n";
import type { AIResponse } from "../lib/types";
import { getModeLabel } from "../lib/utils";
import { formatAnswerTime, formatDuration, previewLine } from "./responseFormat";

/**
 * Every answer of the meeting, newest first, sliding in over the response
 * area. Arrow keys move between answers, Enter opens one, Escape closes.
 */
export function ResponseHistoryList({
  responses,
  pinnedIds,
  selectedId,
  meetingStart,
  onSelect,
  onClose,
}: {
  responses: AIResponse[];
  pinnedIds: Set<string>;
  selectedId: string | null;
  meetingStart: number | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useT("overlay");
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Focus the answer on screen (or the newest) when the list opens.
  useEffect(() => {
    const idx = Math.max(0, responses.findIndex((r) => r.id === selectedId));
    itemRefs.current[idx]?.focus();
    // Only on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    const idx = itemRefs.current.findIndex((el) => el === document.activeElement);
    const move = (to: number) => {
      e.preventDefault();
      itemRefs.current[(to + responses.length) % responses.length]?.focus();
    };
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        onClose();
        break;
      case "ArrowDown":
        move(idx + 1);
        break;
      case "ArrowUp":
        move(idx - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(responses.length - 1);
        break;
    }
  };

  return (
    <div
      className="history-slide-enter absolute inset-0 z-10 flex flex-col rounded-lg bg-card/95 backdrop-blur-md"
      role="dialog"
      aria-label={t("history.title")}
      onKeyDown={onKeyDown}
    >
      <div className="flex shrink-0 items-center justify-between px-1 pb-1.5">
        <span className="text-[0.6rem] font-medium uppercase tracking-widest text-muted-foreground/50">
          {t("history.title")} · {responses.length}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
          aria-label={t("history.close")}
        >
          <X className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>
      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-0.5">
        {responses.map((r, idx) => {
          const selected = r.id === selectedId;
          const timing = r.total_ms || r.latency_ms;
          return (
            <li key={r.id}>
              <button
                ref={(el) => {
                  itemRefs.current[idx] = el;
                }}
                type="button"
                onClick={() => onSelect(r.id)}
                aria-current={selected ? "true" : undefined}
                className={`w-full rounded-lg px-2 py-1.5 text-left transition-colors duration-150 ${
                  selected ? "bg-primary/10" : "hover:bg-accent/40"
                }`}
              >
                <span className="flex items-center gap-2">
                  <span className={`text-meta font-semibold ${selected ? "text-primary" : "text-foreground/80"}`}>
                    {getModeLabel(r.mode)}
                  </span>
                  {pinnedIds.has(r.id) && <Pin className="h-2.5 w-2.5 text-warning/70" aria-label={t("history.pinned")} />}
                  <span className="ml-auto shrink-0 font-mono text-meta tabular-nums text-muted-foreground/50">
                    {formatAnswerTime(r.timestamp, meetingStart)}
                    {timing ? ` · ${formatDuration(timing)}` : ""}
                  </span>
                </span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground/70">{previewLine(r.content)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
