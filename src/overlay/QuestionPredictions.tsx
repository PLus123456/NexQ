import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { useT } from "../i18n";
import { getQuestionPredictions, onQuestionPredictions, type PredictionView } from "../lib/questionDetection/predictions";
import { stripThinkTags } from "../lib/utils";
import { useMeetingStore } from "../stores/meetingStore";

/** Preview only. Opening a prediction does not generate or save an answer. */
export function QuestionPredictions() {
  const { t } = useT("overlay");
  const meetingId = useMeetingStore((s) => s.activeMeeting?.id);
  const [view, setView] = useState<PredictionView | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    setView(null);
    setSelected(null);
    if (!meetingId) return;
    let disposed = false;
    let receivedEvent = false;
    const apply = (next: PredictionView) => {
      if (disposed || next.meeting_id !== meetingId) return;
      setView((old) => old && old.revision > next.revision ? old : next);
    };
    const listener = onQuestionPredictions((next) => { receivedEvent = true; apply(next); });
    void listener.then(async () => {
      const next = await getQuestionPredictions();
      if (!receivedEvent) apply(next);
    }).catch(() => {});
    return () => { disposed = true; void listener.then((stop) => stop()).catch(() => {}); };
  }, [meetingId]);
  useEffect(() => {
    if (!view?.expires_at_ms) return;
    const timer = setTimeout(() => setView(null), Math.max(0, view.expires_at_ms - Date.now()));
    return () => clearTimeout(timer);
  }, [view?.expires_at_ms]);

  if (!view?.enabled || view.meeting_id !== meetingId || !view.predictions.length || view.expires_at_ms <= Date.now()) return null;
  const preview = view.predictions.find((p) => p.id === selected);
  return (
    <details className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-border/20 px-3 py-2 text-xs" key={meetingId}>
      <summary className="cursor-pointer text-muted-foreground">{t("prediction.title")} · {view.predictions.length}</summary>
      <ul className="mt-2 space-y-1">
        {view.predictions.map((p) => (
          <li key={p.id}>
            <button type="button" aria-expanded={selected === p.id}
              className="w-full rounded px-2 py-1.5 text-left hover:bg-accent/30"
              onClick={() => setSelected((id) => id === p.id ? null : p.id)}>
              {p.question} <span className="text-muted-foreground">· {t(`prediction.status.${p.status}`)}</span>
            </button>
          </li>
        ))}
      </ul>
      {preview && <div className="mt-2 border-t border-border/20 pt-2" aria-label={t("prediction.preview")}>
        {preview.answer ? <>
          <p className="mb-1 text-info">{t("prediction.prepared")}</p>
          <div className="prose prose-sm prose-invert max-w-none"><ReactMarkdown>{stripThinkTags(preview.answer)}</ReactMarkdown></div>
        </> : <p className="text-muted-foreground">{t(`prediction.status.${preview.status}`)}</p>}
      </div>}
    </details>
  );
}
