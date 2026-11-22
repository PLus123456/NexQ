import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ParseKeys } from "i18next";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  HelpCircle,
  Loader2,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react";
import { useT } from "../i18n";
import { useAIActionsStore } from "../stores/aiActionsStore";
import { useQuestionDetectionStore } from "../stores/questionDetectionStore";
import { QuestionPredictions } from "./QuestionPredictions";
import { useQuestionFlow, type FlowQuestion } from "./questionFlow";
import { clampPopoverPosition, type PopoverRect } from "./popoverUtils";

const STATUS_META: Record<
  FlowQuestion["status"],
  {
    labelKey: ParseKeys<"overlay">; // i18n-ignore: type annotation, not text
    badgeClass: string;
  }
> = {
  detecting: {
    labelKey: "question.status.detecting",
    badgeClass: "bg-muted/50 text-muted-foreground",
  },
  open: {
    labelKey: "question.status.open",
    badgeClass: "bg-info/15 text-info",
  },
  answering: {
    labelKey: "question.status.answering",
    badgeClass: "bg-primary/15 text-primary",
  },
  answered: {
    labelKey: "question.status.answered",
    badgeClass: "bg-success/15 text-success",
  },
  held: {
    labelKey: "question.status.held",
    badgeClass: "bg-warning/15 text-warning",
  },
};

function StatusBadge({ status, prepared }: { status: FlowQuestion["status"]; prepared: boolean }) {
  const { t } = useT("overlay");
  const meta = STATUS_META[status];
  return (
    <span
      data-question-status={status}
      className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] leading-none font-medium ${meta.badgeClass}`}
    >
      {status === "detecting" && <Loader2 className="h-2.5 w-2.5 animate-spin" aria-hidden="true" />}
      {status === "open" && <span className="h-1.5 w-1.5 rounded-full bg-info animate-pulse" aria-hidden="true" />}
      {status === "answering" && <Loader2 className="h-2.5 w-2.5 animate-spin" aria-hidden="true" />}
      {status === "answered" && <Check className="h-2.5 w-2.5" aria-hidden="true" />}
      {status === "held" && <Clock className="h-2.5 w-2.5" aria-hidden="true" />}
      <span>{t(meta.labelKey)}</span>
      {prepared && (
        <span
          className="ml-0.5 inline-flex items-center text-info"
          title={t("prediction.prepared")}
          aria-label={t("prediction.prepared")}
        >
          <Sparkles className="h-2.5 w-2.5" aria-hidden="true" />
        </span>
      )}
    </span>
  );
}

/**
 * The overlay's compact question strip wrapper (≤ 72px), unless both question
 * detection and question prediction are off.
 */
export function QuestionPanel() {
  const questionDetection = useAIActionsStore((s) => s.configs.globalDefaults.questionDetection);
  const predictionEnabled = useQuestionDetectionStore((s) => s.view?.settings?.prediction_enabled ?? false);
  if (!questionDetection && !predictionEnabled) return null;
  return (
    <div
      data-testid="question-panel"
      className="shrink-0 max-h-[72px] rounded-lg border border-info/15 bg-info/[0.06] px-2.5 py-1"
    >
      <QuestionStrip predictionsSlot={<QuestionPredictions />} />
    </div>
  );
}

/**
 * Compact 1–2 line question strip with status indicator, prev/next navigation,
 * assist/re-answer & dismiss actions, and a hover/click floating popover for
 * the full untruncated question text.
 */
export function QuestionStrip({ predictionsSlot }: { predictionsSlot?: ReactNode } = {}) {
  const { t } = useT("overlay");
  const { questions, answer, dismiss } = useQuestionFlow();

  // Track which question the user is viewing; jump to newest when a new question arrives.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const prevNewestIdRef = useRef<string | null>(questions[0]?.id ?? null);

  useEffect(() => {
    const newestId = questions[0]?.id ?? null;
    if (newestId && newestId !== prevNewestIdRef.current) {
      setSelectedId(null);
    }
    prevNewestIdRef.current = newestId;
  }, [questions]);

  const currentIndex = (() => {
    if (questions.length === 0) return -1;
    if (!selectedId) return 0;
    const idx = questions.findIndex((q) => q.id === selectedId);
    return idx >= 0 ? idx : 0;
  })();
  const current = currentIndex >= 0 ? questions[currentIndex] : null;

  // Full-text floating popover state (hover or click-pinned).
  const [hovered, setHovered] = useState(false);
  const [pinnedOpen, setPinnedOpen] = useState(false);
  const popoverOpen = !!current && (hovered || pinnedOpen);

  const stripRef = useRef<HTMLDivElement>(null);
  const textTriggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const hoverCloseTimer = useRef<number | null>(null);
  const [pos, setPos] = useState<PopoverRect>({ top: 0, left: 8, maxHeight: 240 });

  const cancelHoverClose = useCallback(() => {
    if (hoverCloseTimer.current !== null) {
      window.clearTimeout(hoverCloseTimer.current);
      hoverCloseTimer.current = null;
    }
  }, []);

  const scheduleHoverClose = useCallback(() => {
    cancelHoverClose();
    hoverCloseTimer.current = window.setTimeout(() => {
      setHovered(false);
      hoverCloseTimer.current = null;
    }, 140);
  }, [cancelHoverClose]);

  useEffect(() => () => cancelHoverClose(), [cancelHoverClose]);

  // Close popover if the question list empties.
  useEffect(() => {
    if (!current) {
      setHovered(false);
      setPinnedOpen(false);
    }
  }, [current]);

  useLayoutEffect(() => {
    if (!popoverOpen || !stripRef.current) return;
    const anchor = stripRef.current.getBoundingClientRect();
    const width = Math.max(anchor.width, 300);
    setPos(clampPopoverPosition(anchor, width, 200, "below", "left"));
  }, [popoverOpen, current?.id, current?.text]);

  useEffect(() => {
    if (!popoverOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popRef.current?.contains(target) || textTriggerRef.current?.contains(target)) return;
      setPinnedOpen(false);
      setHovered(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setPinnedOpen(false);
        setHovered(false);
        textTriggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [popoverOpen]);

  const goPrev = () => {
    if (currentIndex > 0) setSelectedId(questions[currentIndex - 1].id);
  };
  const goNext = () => {
    if (currentIndex >= 0 && currentIndex < questions.length - 1) {
      setSelectedId(questions[currentIndex + 1].id);
    }
  };

  // Empty state: single faint placeholder line (+ predictions button if present).
  if (!current) {
    return (
      <div
        ref={stripRef}
        className="flex h-6 items-center gap-2 min-w-0"
        role="region"
        aria-label={t("question.region.ariaLabel")}
      >
        <HelpCircle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/35" aria-hidden="true" />
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground/45">{t("question.empty")}</p>
        {predictionsSlot}
      </div>
    );
  }

  const isAnswering = current.status === "answering";
  const isAnswered = current.status === "answered";

  const actionButtonLabel = isAnswered || isAnswering ? t("question.reanswer") : t("question.assist");

  const actionAriaLabel = isAnswered || isAnswering ? t("question.button.reanswerLabel") : t("question.button.assistLabel");

  return (
    <div
      ref={stripRef}
      className="flex flex-col gap-0.5 min-w-0 question-card-enter"
      role="region"
      aria-label={t("question.region.ariaLabel")}
    >
      {/* Row 1: status badge, prev/next nav, predictions badge, assist & dismiss */}
      <div className="flex h-5 items-center gap-1 min-w-0">
        <StatusBadge status={current.status} prepared={current.prepared} />

        {questions.length > 1 && (
          <div className="flex shrink-0 items-center gap-0.5 ml-0.5">
            <button
              type="button"
              onClick={goPrev}
              disabled={currentIndex <= 0}
              aria-label={t("question.nav.prev")}
              title={t("question.nav.prev")}
              className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-accent/50 hover:text-foreground disabled:opacity-25 disabled:pointer-events-none cursor-pointer"
            >
              <ChevronLeft className="h-3 w-3" aria-hidden="true" />
            </button>
            <span className="text-[10px] tabular-nums text-muted-foreground/65 px-0.5">
              {t("question.nav.counter", { current: currentIndex + 1, total: questions.length })}
            </span>
            <button
              type="button"
              onClick={goNext}
              disabled={currentIndex >= questions.length - 1}
              aria-label={t("question.nav.next")}
              title={t("question.nav.next")}
              className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-accent/50 hover:text-foreground disabled:opacity-25 disabled:pointer-events-none cursor-pointer"
            >
              <ChevronRight className="h-3 w-3" aria-hidden="true" />
            </button>
          </div>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {predictionsSlot}
          {!isAnswering && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                answer(current.id);
              }}
              aria-label={actionAriaLabel}
              className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] leading-none font-semibold transition-colors cursor-pointer ${
                isAnswered
                  ? "bg-success/10 border border-success/20 text-success hover:bg-success/20"
                  : "bg-info/15 border border-info/25 text-info hover:bg-info/25"
              }`}
            >
              {isAnswered ? (
                <RotateCcw className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
              ) : (
                <Sparkles className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
              )}
              <span>{actionButtonLabel}</span>
            </button>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              dismiss(current.id);
            }}
            aria-label={t("question.dismiss")}
            title={t("question.dismiss")}
            className="rounded p-0.5 text-muted-foreground/45 transition-colors hover:bg-destructive/15 hover:text-destructive cursor-pointer"
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Row 2: 1–2 line clamped question text; hover or click opens floating full-text popover */}
      <button
        ref={textTriggerRef}
        type="button"
        onMouseEnter={() => {
          cancelHoverClose();
          setHovered(true);
        }}
        onMouseLeave={scheduleHoverClose}
        onClick={() => setPinnedOpen((v) => !v)}
        aria-expanded={popoverOpen}
        aria-haspopup="dialog"
        aria-label={t(isAnswered || isAnswering ? "question.card.labelAnswered" : "question.card.labelPending", {
          text: current.text,
        })}
        title={t("question.popover.expandHint")}
        className="w-full min-w-0 text-left rounded px-0.5 -mx-0.5 transition-colors hover:bg-info/10 cursor-pointer"
      >
        <p className="line-clamp-2 text-xs leading-[16px] font-medium text-foreground/90">
          {current.text}
        </p>
      </button>

      {/* Full-text floating popover (never pushes answer area down) */}
      {popoverOpen &&
        createPortal(
          <div
            ref={popRef}
            role="dialog"
            aria-label={t("question.popover.label")}
            onMouseEnter={cancelHoverClose}
            onMouseLeave={scheduleHoverClose}
            onKeyDown={(e) => e.stopPropagation()}
            style={{
              top: pos.top,
              left: pos.left,
              width: Math.min(Math.max(stripRef.current?.getBoundingClientRect().width ?? 360, 300), window.innerWidth - 16),
              maxHeight: pos.maxHeight,
            }}
            className="scope-pop-enter fixed z-50 flex flex-col gap-2 overflow-y-auto rounded-xl border border-info/25 bg-popover/95 p-3 shadow-2xl backdrop-blur-md"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <StatusBadge status={current.status} prepared={current.prepared} />
                {current.prepared && (
                  <span className="text-meta text-info">{t("prediction.prepared")}</span>
                )}
              </div>
              {questions.length > 1 && (
                <span className="text-meta tabular-nums text-muted-foreground/60">
                  {t("question.nav.counter", { current: currentIndex + 1, total: questions.length })}
                </span>
              )}
            </div>

            <p className="text-xs leading-relaxed font-medium text-foreground/95 whitespace-pre-wrap break-words">
              {current.text}
            </p>

            <div className="flex items-center justify-end gap-1.5 border-t border-border/15 pt-2">
              <button
                type="button"
                onClick={() => {
                  setPinnedOpen(false);
                  setHovered(false);
                  answer(current.id);
                }}
                className="flex items-center gap-1 rounded-md bg-info/15 border border-info/25 px-2.5 py-1 text-xs font-semibold text-info transition-colors hover:bg-info/25 cursor-pointer"
              >
                {isAnswered || isAnswering ? (
                  <RotateCcw className="h-3 w-3" aria-hidden="true" />
                ) : (
                  <Sparkles className="h-3 w-3" aria-hidden="true" />
                )}
                <span>{actionButtonLabel}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setPinnedOpen(false);
                  setHovered(false);
                  dismiss(current.id);
                }}
                aria-label={t("question.dismiss")}
                className="rounded-md p-1 text-muted-foreground/60 transition-colors hover:bg-destructive/15 hover:text-destructive cursor-pointer"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
