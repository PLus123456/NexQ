import { useEffect, useId, useState } from "react";
import { useT } from "../../i18n";
import { errorMessage } from "../../lib/llm/ipc";
import { effectiveRoute, ownTarget } from "../../lib/llm/tasks";
import type { LlmConfigView } from "../../lib/llm/types";
import type { QuestionDetectionMode, QuestionDetectionSettings } from "../../lib/questionDetection/types";
import { useQuestionDetectionStore } from "../../stores/questionDetectionStore";
import { showToast } from "../../stores/toastStore";
import { CARD, HINT, INPUT, LABEL, SECTION_TITLE, Segmented, Toggle } from "./ui";

export function QuestionDetectionCard({ view: llmView }: { view: LlmConfigView }) {
  const { t } = useT(["llm", "common"]);
  const id = useId();
  const { view, error, saving, load, update } = useQuestionDetectionStore();
  const [threshold, setThreshold] = useState("0.7");
  // Route availability can change in either window without changing these settings.
  useEffect(() => { void load(); }, [load, llmView.revision]);
  useEffect(() => {
    if (view) setThreshold(String(view.settings.confidence_threshold));
  }, [view?.settings.confidence_threshold]);

  const save = async (patch: Partial<QuestionDetectionSettings>) => {
    try {
      await update(patch);
    } catch (err) {
      showToast(t("common:errors.saveFailed", { detail: errorMessage(err) }), "error");
      if (view) setThreshold(String(view.settings.confidence_threshold));
    }
  };
  const saveThreshold = () => {
    const value = Number(threshold);
    if (!threshold.trim() || !Number.isFinite(value) || value < 0 || value > 1) {
      if (view) setThreshold(String(view.settings.confidence_threshold));
      return;
    }
    if (value !== view?.settings.confidence_threshold) void save({ confidence_threshold: value });
  };

  const route = effectiveRoute(llmView, "question_detect");
  const predictionRoute = effectiveRoute(llmView, "question_predict");
  const assistRoute = effectiveRoute(llmView, "assist:Assist");
  const missing = !ownTarget(llmView, "question_detect");
  const fallback = missing ? "route_missing" : route.error ? "connection_unavailable" : view?.fallback_reason;
  const fallbackKey = fallback === "route_missing" || fallback === "route_not_configured"
    ? "questionDetection.fallback.routeMissing"
    : fallback === "connection_unavailable" || fallback === "route_unavailable"
      ? "questionDetection.fallback.unavailable"
      : fallback === "timeout"
        ? "questionDetection.fallback.timeout"
        : fallback === "invalid_response"
          ? "questionDetection.fallback.invalidResponse"
          : "questionDetection.fallback.failed";

  return (
    <section className={CARD} aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className={SECTION_TITLE}>{t("questionDetection.title")}</h3>
      <p className={HINT}>{t("questionDetection.hint")}</p>
      {!view ? (
        <p className="mt-3 text-xs text-muted-foreground">{error ? t("questionDetection.loadFailed", { detail: error }) : t("questionDetection.loading")}</p>
      ) : (
        <>
          <div className="mt-3">
            <span id={`${id}-mode`} className={LABEL}>{t("questionDetection.modeLabel")}</span>
            <Segmented<QuestionDetectionMode>
              labelledBy={`${id}-mode`}
              value={view.settings.mode}
              disabled={saving}
              options={[
                { value: "rules", label: t("questionDetection.modes.rules") },
                { value: "hybrid", label: t("questionDetection.modes.hybrid") },
                { value: "model", label: t("questionDetection.modes.model") },
              ]}
              onChange={(mode) => { void save({ mode }); }}
            />
            <p className={HINT}>{t(`questionDetection.descriptions.${view.settings.mode}`)}</p>
          </div>
          {view.settings.mode !== "rules" && fallback && (
            <p role="status" className="mt-3 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
              {t(fallbackKey)}
            </p>
          )}
          <div className="mt-4 flex flex-wrap items-start gap-6">
            <div className="w-44">
              <label htmlFor={`${id}-threshold`} className={LABEL}>{t("questionDetection.threshold")}</label>
              <input
                id={`${id}-threshold`}
                className={INPUT}
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={threshold}
                disabled={saving || view.settings.mode === "rules"}
                aria-describedby={`${id}-threshold-hint`}
                onChange={(event) => setThreshold(event.target.value)}
                onBlur={saveThreshold}
                onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
              />
              <p id={`${id}-threshold-hint`} className={HINT}>{t("questionDetection.thresholdHint")}</p>
            </div>
            <div className="min-w-48 flex-1">
              <div className="flex items-center gap-2">
                <Toggle
                  label={t("questionDetection.logRequests")}
                  checked={view.settings.log_requests}
                  disabled={saving}
                  describedBy={`${id}-log-hint`}
                  onChange={(log_requests) => { void save({ log_requests }); }}
                />
                <span className="text-xs font-medium">{t("questionDetection.logRequests")}</span>
              </div>
              <p id={`${id}-log-hint`} className={HINT}>{t("questionDetection.logHint")}</p>
            </div>
          </div>
          <div className="mt-4 border-t border-border/30 pt-4">
            <h4 className={SECTION_TITLE}>{t("questionPrediction.title")}</h4>
            <p className={HINT}>{t("questionPrediction.hint")}</p>
            <div className="mt-3 flex items-center gap-2">
              <Toggle label={t("questionPrediction.enabled")} checked={view.settings.prediction_enabled ?? false}
                disabled={saving} onChange={(prediction_enabled) => { void save({ prediction_enabled }); }} />
              <span className="text-xs font-medium">{t("questionPrediction.enabled")}</span>
            </div>
            {view.settings.prediction_enabled && predictionRoute.error && (
              <p role="status" className="mt-2 text-xs text-warning">{t("questionPrediction.routeMissing")}</p>
            )}
            <div className="mt-3 flex items-center gap-2">
              <Toggle label={t("questionPrediction.prepare")} checked={view.settings.prediction_prepare_answers ?? true}
                disabled={saving || !view.settings.prediction_enabled}
                onChange={(prediction_prepare_answers) => { void save({ prediction_prepare_answers }); }} />
              <span className="text-xs font-medium">{t("questionPrediction.prepare")}</span>
            </div>
            <p className={HINT}>{t("questionPrediction.prepareHint")}</p>
            {view.settings.prediction_enabled && view.settings.prediction_prepare_answers && assistRoute.error && (
              <p role="status" className="mt-2 text-xs text-warning">{t("questionPrediction.assistUnavailable")}</p>
            )}
          </div>
          {error && <p role="alert" className="mt-3 text-xs text-warning">{t("questionDetection.loadFailed", { detail: error })}</p>}
        </>
      )}
    </section>
  );
}
