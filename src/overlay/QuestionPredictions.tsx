import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Lightbulb, X } from "lucide-react";
import { AnswerMarkdown } from "../components/AnswerMarkdown";
import { useT } from "../i18n";
import { getQuestionPredictions, onQuestionPredictions, type PredictionView } from "../lib/questionDetection/predictions";
import { stripThinkTags } from "../lib/utils";
import { useMeetingStore } from "../stores/meetingStore";
import { clampPopoverPosition, type PopoverRect } from "./popoverUtils";

const POPOVER_WIDTH = 320;
const ESTIMATED_HEIGHT = 280;

/**
 * Compact badge button for predicted questions; clicking opens a floating
 * popover preview without pushing down the answer area or generating an answer.
 */
export function QuestionPredictions() {
  const { t } = useT("overlay");
  const meetingId = useMeetingStore((s) => s.activeMeeting?.id);
  const [view, setView] = useState<PredictionView | null>(null);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [pos, setPos] = useState<PopoverRect>({ top: 0, left: 8, maxHeight: 280 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setView(null);
    setSelected(null);
    setOpen(false);
    if (!meetingId) return;
    let disposed = false;
    let receivedEvent = false;
    const apply = (next: PredictionView) => {
      if (disposed || next.meeting_id !== meetingId) return;
      setView((old) => (old && old.revision > next.revision ? old : next));
    };
    const listener = onQuestionPredictions((next) => {
      receivedEvent = true;
      apply(next);
    });
    void listener
      .then(async () => {
        const next = await getQuestionPredictions();
        if (!receivedEvent) apply(next);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      void listener.then((stop) => stop()).catch(() => {});
    };
  }, [meetingId]);

  useEffect(() => {
    if (!view?.expires_at_ms) return;
    const timer = setTimeout(() => {
      setView(null);
      setOpen(false);
    }, Math.max(0, view.expires_at_ms - Date.now()));
    return () => clearTimeout(timer);
  }, [view?.expires_at_ms]);

  const close = useCallback((refocus = false) => {
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    setPos(clampPopoverPosition(rect, POPOVER_WIDTH, ESTIMATED_HEIGHT, "below", "right"));
  }, [open, selected]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popRef.current?.contains(target) || btnRef.current?.contains(target)) return;
      close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(true);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  if (!view?.enabled || view.meeting_id !== meetingId || !view.predictions.length || view.expires_at_ms <= Date.now()) {
    return null;
  }

  const count = view.predictions.length;
  const preview = view.predictions.find((p) => p.id === selected);
  const ariaLabel = t("prediction.buttonLabel", { count });

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={ariaLabel}
        title={`${t("prediction.title")} · ${count}`}
        className={`flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-meta font-medium transition-colors cursor-pointer ${
          open
            ? "bg-warning/20 text-warning ring-1 ring-warning/30"
            : "bg-warning/10 text-warning/85 hover:bg-warning/20 hover:text-warning"
        }`}
      >
        <Lightbulb className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
        <span className="tabular-nums">{count}</span>
      </button>

      {open &&
        createPortal(
          <div
            ref={popRef}
            role="dialog"
            aria-label={t("prediction.title")}
            onKeyDown={(e) => e.stopPropagation()}
            style={{
              top: pos.top,
              left: pos.left,
              width: Math.min(POPOVER_WIDTH, Math.max(220, window.innerWidth - 16)),
              maxHeight: pos.maxHeight,
            }}
            className="scope-pop-enter fixed z-50 flex flex-col overflow-hidden rounded-xl border border-border/30 bg-popover/95 shadow-2xl backdrop-blur-md"
          >
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/20 px-3 py-1.5">
              <div className="flex items-center gap-1.5 text-meta font-semibold text-warning">
                <Lightbulb className="h-3 w-3 shrink-0" aria-hidden="true" />
                <span>{t("prediction.title")}</span>
                <span className="tabular-nums text-muted-foreground/70">· {count}</span>
              </div>
              <button
                type="button"
                onClick={() => close(true)}
                aria-label={t("prediction.close")}
                className="rounded-md p-0.5 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-2 text-xs">
              <ul className="space-y-1">
                {view.predictions.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      aria-expanded={selected === p.id}
                      className={`w-full rounded-lg px-2 py-1.5 text-left transition-colors cursor-pointer ${
                        selected === p.id ? "bg-accent/60 text-foreground" : "text-foreground/85 hover:bg-accent/35"
                      }`}
                      onClick={() => setSelected((id) => (id === p.id ? null : p.id))}
                    >
                      <span>{p.question}</span>{" "}
                      <span className="text-meta text-muted-foreground">· {t(`prediction.status.${p.status}`)}</span>
                    </button>
                  </li>
                ))}
              </ul>

              {preview && (
                <div className="mt-2 border-t border-border/20 pt-2" aria-label={t("prediction.preview")}>
                  {preview.answer ? (
                    <>
                      <p className="mb-1 text-meta font-medium text-info">{t("prediction.prepared")}</p>
                      <AnswerMarkdown content={stripThinkTags(preview.answer)} className="text-xs leading-relaxed text-foreground/90" />
                    </>
                  ) : (
                    <p className="text-meta text-muted-foreground">{t(`prediction.status.${preview.status}`)}</p>
                  )}
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
