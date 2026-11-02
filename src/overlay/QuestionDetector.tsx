import { useEffect, useState, useRef, useCallback } from "react";
import { HelpCircle, Sparkles, Check, Clock, X } from "lucide-react";
import { useT } from "../i18n";
import { onQuestionDetectionPending, onQuestionDetectionResult } from "../lib/questionDetection/events";
import { runUserAction } from "../lib/userAction";
import { useTranscriptStore } from "../stores/transcriptStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useAIActionsStore } from "../stores/aiActionsStore";
import { useStreamStore } from "../stores/streamStore";
import { useConfigStore } from "../stores/configStore";
import type { DetectedQuestion } from "../lib/types";

/**
 * Quiet time after the other party's last words before Auto-Trigger answers
 * their question, so a question still being asked isn't answered half-way.
 */
export const AUTO_TRIGGER_DELAY_MS = 1500;

const isOtherParty = (speaker: string) => ["them", "interviewer"].includes(speaker.toLowerCase());

interface TrackedQuestion extends DetectedQuestion {
  assisted: boolean;
  revision: number;
  prepared?: boolean;
}

export function QuestionDetector() {
  const { t } = useT("overlay");
  const [questions, setQuestions] = useState<TrackedQuestion[]>([]);
  const revisionRef = useRef(0);
  const [autoRevision, setAutoRevision] = useState<number | null>(null);
  const otherPartyTalking = useTranscriptStore((s) => {
    const latest = [...s.segments].reverse().find((seg) => isOtherParty(seg.speaker));
    return !!latest && (!latest.is_final || !!latest.pending_text);
  });
  const activeMeetingId = useMeetingStore((s) => s.activeMeeting?.id ?? "");
  const autoTrigger = useAIActionsStore((s) => s.configs.globalDefaults.autoTrigger);
  const busy = useStreamStore((s) => s.isStreaming || s.phase === "sending");
  const defaultScope = useConfigStore((s) => !s.contextScope || s.contextScope.kind === "default");
  // Changes whenever the other party says more (a new line, or a line growing).
  const otherPartyActivity = useTranscriptStore((s) => {
    for (let i = s.segments.length - 1; i >= 0; i--) {
      const seg = s.segments[i];
      if (isOtherParty(seg.speaker)) return `${seg.id}:${seg.text}:${seg.pending_text ?? ""}`;
    }
    return "";
  });

  // Clear detected questions when a new meeting starts so a question from the
  // previous meeting doesn't linger in the overlay.
  useEffect(() => {
    setQuestions([]);
    setAutoRevision(null);
    revisionRef.current = 0;
  }, [activeMeetingId]);

  useEffect(() => {
    const pending = onQuestionDetectionPending((event) => {
      if (event.revision < revisionRef.current) return;
      revisionRef.current = event.revision;
      setAutoRevision(null);
    });
    const result = onQuestionDetectionResult((event) => {
      if (event.revision < revisionRef.current || !isOtherParty(event.source)) return;
      revisionRef.current = event.revision;
      setAutoRevision(event.question ? event.revision : null);
      setQuestions((previous) => {
        // A growing line replaces its last decision. A model veto also removes
        // that line's provisional card; no local heuristic can bypass it.
        const existing = previous.find((q) => !q.assisted && q.timestamp_ms === event.timestamp_ms && q.source === event.source);
        const rest = previous.filter((q) => q !== existing);
        if (!event.question) return rest;
        if (previous[0]?.assisted && previous[0].text === event.question.text) return previous;
        return [{ ...event.question, prepared: event.prepared, assisted: false, revision: event.revision }, ...rest].slice(0, 10);
      });
    });
    return () => { pending.then((u) => u()); result.then((u) => u()); };
  }, [activeMeetingId]);

  const handleAssist = useCallback((index: number, preparedOnly = false) => {
    const questionText = questions[index]?.text;
    const revision = questions[index]?.revision;
    setQuestions((prev) =>
      prev.map((q, i) => i === index ? { ...q, assisted: true } : q)
    );
    const request = preparedOnly ? runUserAction("Assist", questionText, true) : runUserAction("Assist", questionText);
    request.catch(() => {
      // A settings change/expiry can invalidate a hit between confirmation and
      // replay. Leave the question available without an unwanted paid retry.
      if (preparedOnly) setQuestions((prev) => prev.map((q) => q.revision === revision ? { ...q, assisted: false, prepared: false } : q));
    });
  }, [questions]);

  const handleDismiss = useCallback((index: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setQuestions((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const latest = questions.length > 0 ? questions[0] : null;
  const previousQuestions = questions.slice(1, 4);

  // Auto-Trigger: answer the newest question once the other party has been
  // quiet for a moment. More words from them restart the wait.
  const waiting = (autoTrigger || (!!latest?.prepared && defaultScope)) && !busy && !!latest && !latest.assisted &&
    latest.revision === autoRevision && !otherPartyTalking;
  useEffect(() => {
    if (!waiting) return;
    const preparedOnly = !!latest?.prepared && defaultScope;
    const timer = setTimeout(() => handleAssist(0, preparedOnly), preparedOnly ? 0 : AUTO_TRIGGER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [waiting, latest?.text, latest?.prepared, defaultScope, otherPartyActivity, handleAssist]);

  return (
    <div className="flex flex-col gap-2.5" role="region" aria-label={t("question.region.ariaLabel")}>
      {/* Latest question — prominent card */}
      <div
        className={`group flex items-start gap-3 rounded-lg transition-all duration-200 ${
          latest ? "cursor-pointer hover:bg-info/10 question-card-enter" : ""
        }`}
        onClick={() => latest && handleAssist(0)}
        onKeyDown={(e) => { if (latest && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); handleAssist(0); } }}
        role={latest ? "button" : undefined}
        tabIndex={latest ? 0 : undefined}
        aria-label={
          latest
            ? t(latest.assisted ? "question.card.labelAnswered" : "question.card.labelPending", { text: latest.text })
            : undefined
        }
      >
        <div className="relative mt-0.5 shrink-0" aria-hidden="true">
          <HelpCircle className={`h-5 w-5 transition-colors ${latest ? "text-info" : "text-muted-foreground/50"}`} />
          {latest && !latest.assisted && (
            <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-info animate-pulse" />
          )}
          {latest?.assisted && (
            <span className="absolute -top-0.5 -right-0.5 flex h-3 w-3 items-center justify-center rounded-full bg-success">
              <Check className="h-2 w-2 text-white" />
            </span>
          )}
        </div>

        <div className="flex-1 min-w-0">
          {latest ? (
            <p className="text-sm leading-relaxed font-medium text-foreground/90">
              &ldquo;{latest.text}&rdquo;
            </p>
          ) : (
            <p className="text-xs text-muted-foreground/50">
              {t("question.empty")}
            </p>
          )}
        </div>

        {latest && (
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={(e) => { e.stopPropagation(); handleAssist(0); }}
              aria-label={latest.assisted ? t("question.button.answeredLabel") : t("question.button.assistLabel")}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all duration-150 cursor-pointer ${
                latest.assisted
                  ? "bg-success/10 border border-success/20 text-success"
                  : "bg-info/10 border border-info/20 text-info hover:bg-info/20"
              }`}
            >
              {latest.assisted ? (
                <><Check className="h-3.5 w-3.5" aria-hidden="true" />{t("question.answered")}</>
              ) : (
                <><Sparkles className="h-3.5 w-3.5" aria-hidden="true" />{t("question.assist")}</>
              )}
            </button>
            <button
              onClick={(e) => handleDismiss(0, e)}
              aria-label={t("question.dismiss")}
              className="rounded-lg p-1.5 text-muted-foreground/30 opacity-0 transition-all duration-150 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Previous questions — compact list */}
      {previousQuestions.length > 0 && (
        <div className="flex flex-col gap-1">
          {previousQuestions.map((q, idx) => {
            const realIdx = idx + 1;
            return (
              <div
                key={`q-${realIdx}-${q.timestamp_ms}`}
                className={`group/q flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-all duration-150 question-card-enter ${
                  q.assisted
                    ? "bg-success/5 border border-success/10"
                    : "bg-card/20 hover:bg-card/40 hover:border-border/20 cursor-pointer"
                }`}
                onClick={() => !q.assisted && handleAssist(realIdx)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleAssist(realIdx); } }}
                title={q.text}
              >
                <div className="shrink-0">
                  {q.assisted ? (
                    <div className="flex h-4 w-4 items-center justify-center rounded-full bg-success/20">
                      <Check className="h-2.5 w-2.5 text-success" />
                    </div>
                  ) : (
                    <div className="flex h-4 w-4 items-center justify-center rounded-full bg-muted/30">
                      <Clock className="h-2.5 w-2.5 text-muted-foreground/60" />
                    </div>
                  )}
                </div>

                <span className={`flex-1 truncate text-xs leading-snug transition-colors ${
                  q.assisted
                    ? "text-success/70 font-medium"
                    : "text-muted-foreground/60 group-hover/q:text-foreground/80"
                }`}>
                  {q.text}
                </span>

                {!q.assisted && (
                  <Sparkles className="h-3 w-3 shrink-0 text-info/0 group-hover/q:text-info/60 transition-colors" />
                )}
                <button
                  onClick={(e) => handleDismiss(realIdx, e)}
                  aria-label={t("question.dismiss")}
                  className="rounded p-0.5 text-muted-foreground/0 opacity-0 transition-all duration-150 hover:bg-destructive/10 hover:text-destructive group-hover/q:opacity-100 group-hover/q:text-muted-foreground/30 cursor-pointer"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
