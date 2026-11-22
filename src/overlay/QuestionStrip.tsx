import { HelpCircle, Sparkles, Check, Clock, X } from "lucide-react";
import { useT } from "../i18n";
import { useAIActionsStore } from "../stores/aiActionsStore";
import { useQuestionDetectionStore } from "../stores/questionDetectionStore";
import { QuestionPredictions } from "./QuestionPredictions";
import { useQuestionFlow, type FlowQuestion } from "./questionFlow";

/** Shown as answered: its answer is there or on its way. */
const isAnswered = (question: FlowQuestion) => question.status === "answered" || question.status === "answering";

/**
 * The overlay's question card, unless question detection is off. Predicted
 * questions (M2) show with detection off too, and so do their cards: a
 * prepared answer replays when its question is detected.
 */
export function QuestionPanel() {
  const questionDetection = useAIActionsStore((s) => s.configs.globalDefaults.questionDetection);
  const predictionEnabled = useQuestionDetectionStore((s) => s.view?.settings?.prediction_enabled ?? false);
  if (!questionDetection && !predictionEnabled) return null;
  return (
    <div className="shrink-0 rounded-xl border border-info/10 bg-info/5 px-4 py-3">
      <QuestionStrip />
      <QuestionPredictions />
    </div>
  );
}

/**
 * The detected questions: the newest one as a card, the ones before it as a
 * short list. What is listed and what a click does come from `useQuestionFlow()`.
 */
export function QuestionStrip() {
  const { t } = useT("overlay");
  const { questions, answer, dismiss } = useQuestionFlow();

  const latest = questions.length > 0 ? questions[0] : null;
  const latestAnswered = !!latest && isAnswered(latest);
  const previousQuestions = questions.slice(1, 4);

  return (
    <div className="flex flex-col gap-2.5" role="region" aria-label={t("question.region.ariaLabel")}>
      {/* Latest question — prominent card */}
      <div
        className={`group flex items-start gap-3 rounded-lg transition-all duration-200 ${
          latest ? "cursor-pointer hover:bg-info/10 question-card-enter" : ""
        }`}
        onClick={() => latest && answer(latest.id)}
        onKeyDown={(e) => { if (latest && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); answer(latest.id); } }}
        role={latest ? "button" : undefined}
        tabIndex={latest ? 0 : undefined}
        aria-label={
          latest
            ? t(latestAnswered ? "question.card.labelAnswered" : "question.card.labelPending", { text: latest.text })
            : undefined
        }
      >
        <div className="relative mt-0.5 shrink-0" aria-hidden="true">
          <HelpCircle className={`h-5 w-5 transition-colors ${latest ? "text-info" : "text-muted-foreground/50"}`} />
          {latest && !latestAnswered && (
            <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-info animate-pulse" />
          )}
          {latestAnswered && (
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
              onClick={(e) => { e.stopPropagation(); answer(latest.id); }}
              aria-label={latestAnswered ? t("question.button.answeredLabel") : t("question.button.assistLabel")}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all duration-150 cursor-pointer ${
                latestAnswered
                  ? "bg-success/10 border border-success/20 text-success"
                  : "bg-info/10 border border-info/20 text-info hover:bg-info/20"
              }`}
            >
              {latestAnswered ? (
                <><Check className="h-3.5 w-3.5" aria-hidden="true" />{t("question.answered")}</>
              ) : (
                <><Sparkles className="h-3.5 w-3.5" aria-hidden="true" />{t("question.assist")}</>
              )}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); dismiss(latest.id); }}
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
            const answered = isAnswered(q);
            return (
              <div
                key={`q-${realIdx}-${q.timestampMs}`}
                className={`group/q flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-all duration-150 question-card-enter ${
                  answered
                    ? "bg-success/5 border border-success/10"
                    : "bg-card/20 hover:bg-card/40 hover:border-border/20 cursor-pointer"
                }`}
                onClick={() => !answered && answer(q.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); answer(q.id); } }}
                title={q.text}
              >
                <div className="shrink-0">
                  {answered ? (
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
                  answered
                    ? "text-success/70 font-medium"
                    : "text-muted-foreground/60 group-hover/q:text-foreground/80"
                }`}>
                  {q.text}
                </span>

                {!answered && (
                  <Sparkles className="h-3 w-3 shrink-0 text-info/0 group-hover/q:text-info/60 transition-colors" />
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); dismiss(q.id); }}
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
