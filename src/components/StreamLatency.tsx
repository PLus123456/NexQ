// Footer latency indicator: a live "Thinking 2.3 s" / "Writing 3.1 s" timer
// while an answer streams, then the last answer's time ("1.2 s") with its
// time to first words in the tooltip.

import { useEffect, useState } from "react";
import { Zap } from "lucide-react";
import { useT } from "../i18n";
import { useStreamStore } from "../stores/streamStore";
import { useStreamTimingStore } from "../stores/streamTimingStore";
import { formatDuration, lastAnswerTooltip } from "../lib/agentUsage";

/** Re-render every `ms` while `active`; returns the current time. */
function useNow(active: boolean, ms = 100): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [active, ms]);
  return now;
}

/** `null` when there is nothing to show (no answer yet). */
export function StreamLatency({ divider }: { divider?: React.ReactNode }) {
  const { t } = useT("misc");
  const isStreaming = useStreamStore((s) => s.isStreaming);
  const latencyMs = useStreamStore((s) => s.latencyMs);
  const startedAt = useStreamTimingStore((s) => s.startedAt);
  const firstTokenAt = useStreamTimingStore((s) => s.firstTokenAt);
  const running = useStreamTimingStore((s) => s.requestId != null);
  const lastFirstTokenMs = useStreamTimingStore((s) => s.lastFirstTokenMs);
  const live = isStreaming && running && startedAt != null;
  const now = useNow(live);

  useEffect(() => {
    useStreamTimingStore.getState().init();
  }, []);

  if (!isStreaming && latencyMs == null) return null;

  let text: string;
  let title: string | undefined;
  if (live) {
    const seconds = (Math.max(0, now - startedAt) / 1000).toFixed(1);
    text = firstTokenAt == null
      ? t("streamLatency.thinking", { seconds })
      : t("streamLatency.writing", { seconds });
  } else if (isStreaming) {
    text = t("streamLatency.answering");
  } else {
    text = formatDuration(latencyMs ?? 0);
    title = lastAnswerTooltip(latencyMs ?? 0, lastFirstTokenMs);
  }

  return (
    <>
      {divider}
      <div className="flex items-center gap-1" title={title} data-testid="stream-latency">
        <Zap className={`h-3 w-3 ${isStreaming ? "text-primary animate-pulse" : "text-muted-foreground/60"}`} />
        <span
          className={`text-xs tabular-nums font-medium ${isStreaming ? "text-primary" : "text-muted-foreground"}`}
          aria-live="off"
        >
          {text}
        </span>
      </div>
    </>
  );
}
