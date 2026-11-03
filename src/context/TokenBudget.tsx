import { useEffect } from "react";
import type { ParseKeys } from "i18next";
import { useContextStore } from "../stores/contextStore";
import { AlertTriangle } from "lucide-react";
import { useT } from "../i18n";
import { onLlmConfigChanged } from "../lib/llm/ipc";

/**
 * The segment labels the backend sends (src-tauri/src/context/token_counter.rs),
 * shown translated. Any other label is shown as it comes.
 */
const SEGMENT_LABEL_KEYS = new Map<string, ParseKeys<"rag">>([
  ["Resume", "context.tokenBudget.segment.labels.resume"],
  ["JD", "context.tokenBudget.segment.labels.jd"],
  ["Notes", "context.tokenBudget.segment.labels.notes"],
  ["Notes (PDF)", "context.tokenBudget.segment.labels.notesPdf"],
  ["Notes (MD)", "context.tokenBudget.segment.labels.notesMd"],
  ["Custom Instructions", "context.tokenBudget.segment.labels.customInstructions"],
  ["System Prompt", "context.tokenBudget.segment.labels.systemPrompt"],
  ["Transcript", "context.tokenBudget.segment.labels.transcript"],
]);

export function TokenBudget() {
  const { t } = useT("rag");
  const tokenBudget = useContextStore((s) => s.tokenBudget);
  const refreshTokenBudget = useContextStore((s) => s.refreshTokenBudget);

  // The limit is the assist model's context length: follow route and model changes.
  useEffect(() => {
    const unlisten = onLlmConfigChanged(() => void refreshTokenBudget()).catch(() => null);
    return () => {
      void unlisten.then((fn) => fn?.());
    };
  }, [refreshTokenBudget]);

  if (!tokenBudget) {
    return null;
  }

  const segmentLabel = (label: string) => {
    const key = SEGMENT_LABEL_KEYS.get(label);
    return key ? t(key) : label;
  };

  const usedTokens = tokenBudget.total;
  const limit = tokenBudget.limit;
  const model = tokenBudget.model;

  if (limit === 0) {
    return (
      <div className="w-full rounded-xl border border-border/50 bg-secondary/30 p-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-semibold text-muted-foreground">
            {t("context.tokenBudget.title")}
          </span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {t("context.tokenBudget.usageUnknown", { used: formatNumber(usedTokens) })}
          </span>
        </div>
        <p className="mt-1.5 text-meta text-muted-foreground">
          {model
            ? t("context.tokenBudget.limitUnknown", { model })
            : t("context.tokenBudget.noModel")}
        </p>
      </div>
    );
  }

  const usagePercent = Math.min((usedTokens / limit) * 100, 100);
  const isWarning = usagePercent > 80;
  const isCritical = usagePercent > 95;

  // Filter out headroom for the visual bar segments
  const visibleSegments = tokenBudget.segments.filter(
    (s) => s.category !== "headroom" && s.tokens > 0
  );

  const borderClass = isCritical
    ? "border-destructive/60"
    : isWarning
      ? "border-warning/60"
      : "border-border/50";

  return (
    <div
      className={`w-full rounded-xl border ${borderClass} bg-secondary/30 p-4`}
    >
      {/* Header row */}
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-xs font-semibold text-muted-foreground">
            {t("context.tokenBudget.title")}
          </span>
          {model && (
            <span
              className="max-w-[12rem] truncate font-mono text-meta text-muted-foreground/80"
              title={t("context.tokenBudget.model", { model, limit: formatNumber(limit) })}
            >
              {model}
            </span>
          )}
          {(isWarning || isCritical) && (
            <AlertTriangle
              className={`h-3.5 w-3.5 ${
                isCritical ? "text-destructive" : "text-warning"
              }`}
            />
          )}
        </div>
        <span className="text-xs tabular-nums text-muted-foreground">
          {t("context.tokenBudget.usage", {
            used: formatNumber(usedTokens),
            limit: formatNumber(limit),
            percent: usagePercent.toFixed(0),
          })}
        </span>
      </div>

      {/* Stacked bar */}
      <div
        className="h-2.5 w-full overflow-hidden rounded-full bg-muted/40"
        role="meter"
        aria-label={t("context.tokenBudget.meter.ariaLabel")}
        aria-valuenow={usedTokens}
        aria-valuemin={0}
        aria-valuemax={limit}
      >
        <div className="flex h-full">
          {visibleSegments.map((segment, i) => {
            const widthPercent = (segment.tokens / limit) * 100;
            if (widthPercent < 0.1) return null;
            return (
              <div
                key={`${segment.category}-${i}`}
                className="h-full transition-all duration-300"
                style={{
                  width: `${widthPercent}%`,
                  backgroundColor: segment.color,
                  minWidth: widthPercent > 0 ? "2px" : "0",
                }}
                title={t("context.tokenBudget.segment.title", {
                  label: segmentLabel(segment.label),
                  tokens: formatNumber(segment.tokens),
                })}
              />
            );
          })}
        </div>
      </div>

      {/* Legend */}
      {visibleSegments.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-3">
          {visibleSegments.map((segment, i) => (
            <div
              key={`legend-${segment.category}-${i}`}
              className="flex items-center gap-1.5"
            >
              <div
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: segment.color }}
              />
              <span className="text-meta tabular-nums text-muted-foreground">
                {t("context.tokenBudget.segment.legend", {
                  label: segmentLabel(segment.label),
                  tokens: formatNumber(segment.tokens),
                })}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}k`;
  }
  return n.toString();
}
