import { useCallback } from "react";
import type { ParseKeys } from "i18next";
import { formatDate, useT } from "../i18n";
import { useCallLogStore } from "../stores/callLogStore";
import { getModeLabel } from "../lib/utils";
import { formatDuration } from "../lib/agentUsage";
import { entryFirstTokenMs, isClaudeEntry } from "./stats";
import type { LogEntry, IntelligenceMode } from "../lib/types";
import {
  CheckCircle2,
  AlertCircle,
  Clock,
  Loader2,
} from "lucide-react";

// -- Mode color coding -------------------------------------------------------

const MODE_COLORS: Record<
  IntelligenceMode,
  { badge: string; dot: string }
> = {
  Assist: { badge: "bg-info/20 text-info", dot: "bg-info" },
  WhatToSay: {
    badge: "bg-primary/20 text-primary",
    dot: "bg-primary",
  },
  Shorten: { badge: "bg-warning/20 text-warning", dot: "bg-warning" },
  FollowUp: { badge: "bg-info/20 text-info", dot: "bg-info" },
  Recap: {
    badge: "bg-success/20 text-success",
    dot: "bg-success",
  },
  AskQuestion: { badge: "bg-destructive/20 text-destructive", dot: "bg-destructive" },
  MeetingSummary: { badge: "bg-primary/20 text-primary", dot: "bg-primary" },
  ActionItemsExtraction: { badge: "bg-warning/20 text-warning", dot: "bg-warning" },
  BookmarkSuggestions: { badge: "bg-info/20 text-info", dot: "bg-info" },
  MeetingAsk: { badge: "bg-primary/20 text-primary", dot: "bg-primary" },
};

// -- Context source badges ---------------------------------------------------

const SOURCE_BADGES: {
  key: "includeTranscript" | "includeRag" | "includeInstructions" | "includeQuestion";
  labelKey: ParseKeys<"calllog">;
  color: string;
  titleKey: ParseKeys<"calllog">;
}[] = [
  { key: "includeTranscript", labelKey: "entry.sources.transcript.label", color: "text-success/70 bg-success/10", titleKey: "entry.sources.transcript.title" },
  { key: "includeRag", labelKey: "entry.sources.rag.label", color: "text-info/70 bg-info/10", titleKey: "entry.sources.rag.title" },
  { key: "includeInstructions", labelKey: "entry.sources.instructions.label", color: "text-warning/70 bg-warning/10", titleKey: "entry.sources.instructions.title" },
  { key: "includeQuestion", labelKey: "entry.sources.question.label", color: "text-destructive/70 bg-destructive/10", titleKey: "entry.sources.question.title" },
];

// -- Compact entry row -------------------------------------------------------

interface Props {
  entry: LogEntry;
  isSelected: boolean;
}

export function CallLogEntry({ entry, isSelected }: Props) {
  const { t } = useT("calllog");
  const setExpanded = useCallLogStore((s) => s.setExpandedEntry);
  const colors = MODE_COLORS[entry.mode] ?? MODE_COLORS.Assist;

  const handleClick = useCallback(() => {
    setExpanded(entry.id);
  }, [entry.id, setExpanded]);

  const firstTokenMs = entryFirstTokenMs(entry);
  const timeStr = formatDate(entry.timestamp, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  // The store keeps STALLED_MESSAGE (English) in errorMessage of a stalled entry; show it in the UI language.
  const errorText = entry.stalled ? t("entry.stalled") : entry.errorMessage;

  return (
    <button
      onClick={handleClick}
      className={`flex w-full items-center gap-1.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-100 ${
        isSelected
          ? "bg-primary/10 ring-1 ring-primary/20"
          : "hover:bg-accent/30"
      }`}
    >
      {/* Status indicator */}
      <span className="flex shrink-0" title={errorText ?? undefined}>
        <StatusDot status={entry.status} dotColor={colors.dot} />
      </span>

      {/* Mode badge */}
      <span
        className={`shrink-0 max-w-[100px] truncate rounded px-1.5 py-0.5 text-xs font-semibold ${colors.badge}`}
        title={getModeLabel(entry.mode)}
      >
        {getModeLabel(entry.mode)}
      </span>

      {/* Context source badges */}
      <div className="flex items-center gap-px shrink-0">
        {SOURCE_BADGES.map(({ key, labelKey, color, titleKey }) =>
          entry[key] ? (
            <span
              key={key}
              className={`rounded px-1 py-px text-meta font-bold ${color}`}
              title={t(titleKey)}
            >
              {t(labelKey)}
            </span>
          ) : null
        )}
      </div>

      {/* Provider/Model */}
      <span
        className="min-w-0 flex-1 max-w-[80px] truncate text-xs text-muted-foreground"
        title={`${entry.provider}/${entry.model.split(":")[0].split("/").pop()}`}
      >
        {entry.provider}/{entry.model.split(":")[0].split("/").pop()}
      </span>

      {entry.stalled && (
        <span className="shrink-0 text-meta text-destructive/70">{errorText}</span>
      )}

      {/* Latency: first words · whole answer */}
      {entry.latencyMs != null && (
        <span
          className="shrink-0 text-xs tabular-nums text-muted-foreground/70"
          title={
            firstTokenMs != null
              ? t("entry.latency.titleWithFirst", {
                  total: formatDuration(entry.latencyMs),
                  first: formatDuration(firstTokenMs),
                })
              : t("entry.latency.title", { total: formatDuration(entry.latencyMs) })
          }
          data-testid="entry-latency"
        >
          {firstTokenMs != null && (
            <span className="text-muted-foreground/50">{formatDuration(firstTokenMs)} · </span>
          )}
          {formatDuration(entry.latencyMs)}
        </span>
      )}

      {/* Timestamp */}
      <span className="shrink-0 text-meta text-muted-foreground/60">
        {timeStr}
      </span>

      {/* Temperature (Claude ignores it) */}
      {entry.temperature != null && !isClaudeEntry(entry) && (
        <span
          className="shrink-0 text-meta tabular-nums text-muted-foreground/50"
          title={t("entry.temperature.title", { value: entry.temperature })}
        >
          {entry.temperature.toFixed(1)}&deg;{/* i18n-ignore: 度数符号 */}
        </span>
      )}
    </button>
  );
}

// -- Status dot --------------------------------------------------------------

function StatusDot({
  status,
  dotColor,
}: {
  status: LogEntry["status"];
  dotColor: string;
}) {
  if (status === "sending") {
    return (
      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground/50" />
    );
  }
  if (status === "streaming") {
    return (
      <span className="relative flex h-3 w-3 shrink-0">
        <span
          className={`absolute inline-flex h-full w-full animate-pulse rounded-full ${dotColor} opacity-40`}
        />
        <span
          className={`relative inline-flex h-3 w-3 rounded-full ${dotColor}`}
        />
      </span>
    );
  }
  if (status === "complete") {
    return (
      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success/70" />
    );
  }
  if (status === "error") {
    return <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive/70" />;
  }
  // cancelled
  return <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />;
}
