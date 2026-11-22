import { useEffect, useState } from "react";
import type { ParseKeys } from "i18next";
import { useT } from "../i18n";
import { useStreamStore, type StreamPhase } from "../stores/streamStore";
import { useAgentStore } from "../stores/agentStore";
import { getModeLabel } from "../lib/utils";
import { actionLabel } from "../lib/userAction";
import { formatDuration, linesLabel } from "./responseFormat";

const PHASE_KEYS: Record<Exclude<StreamPhase, "idle">, ParseKeys<"overlay">> = { // i18n-ignore: type annotation, not text
  sending: "progress.phase.sending",
  waiting: "progress.phase.waiting",
  thinking: "progress.phase.thinking",
  writing: "progress.phase.writing",
};

/** Elapsed ms since `start`, ticking every 100 ms while `running`. */
function useElapsed(start: number | null, running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(id);
  }, [running, start]);
  return start === null ? 0 : now - start;
}

/**
 * The calm status line above an answer in progress: action, phase, a live
 * timer, and what was sent (model, provider, scope, transcript lines).
 */
export function ResponseProgress() {
  const { t } = useT("overlay");
  const phase = useStreamStore((s) => s.phase);
  const mode = useStreamStore((s) => s.currentMode);
  const startedAt = useStreamStore((s) => s.requestStartedAt);
  const meta = useStreamStore((s) => s.streamMeta);
  const asked = useStreamStore((s) => s.requestSources);
  // An answer with a pill on waits for the with-sources session while it starts
  // (the Fast one, or the Deep one a Recap uses).
  const sourcesStarting = useAgentStore((s) =>
    Object.values(s.sessions).some((x) => x.with_sources && x.scope === "live" && x.state === "starting"),
  );
  const running = phase !== "idle";
  const elapsed = useElapsed(startedAt, running);

  if (!running) return null;

  const loadingSources =
    !!asked && (asked.notes || asked.tools) && sourcesStarting && (phase === "sending" || phase === "waiting");
  const phaseText = loadingSources ? t("progress.phase.loadingSources") : t(PHASE_KEYS[phase]);
  const label = mode ? actionLabel(mode) || getModeLabel(mode) : t("progress.answer");
  const details = meta
    ? [
        [meta.model, meta.provider].filter(Boolean).join(" · "),
        meta.scopeLabel,
        linesLabel(meta.newLines, meta.sessionKey),
      ].filter((d): d is string => !!d)
    : [];

  const detailsText = details.join(" · ");

  return (
    <div
      data-testid="response-progress"
      className="flex shrink-0 items-center gap-1.5 min-w-0 border-b border-border/15 bg-primary/[0.04] px-2.5 py-0.5"
      role="status"
      aria-live="polite"
      aria-label={t("progress.ariaLabel", { label, phase: phaseText })}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 shrink-0 rounded-full bg-primary ${phase === "writing" ? "opacity-80" : "progress-breathe"}`}
      />
      <span className="shrink-0 text-meta font-semibold text-primary">{label}</span>
      <span key={phaseText} className="progress-phase-enter shrink-0 text-meta text-foreground/70">
        {phaseText}
      </span>
      {detailsText && (
        <span
          className="progress-phase-enter min-w-0 flex-1 truncate text-meta text-muted-foreground/50"
          title={detailsText}
        >
          {detailsText}
        </span>
      )}
      <span className="ml-auto shrink-0 font-mono text-meta tabular-nums text-muted-foreground/55" aria-hidden="true">
        {formatDuration(elapsed)}
      </span>
    </div>
  );
}
