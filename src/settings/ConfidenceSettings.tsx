// Confidence highlighting settings — toggle & threshold for low-confidence transcript words.

import { useConfigStore } from "../stores/configStore";
import { useT } from "../i18n";

export function ConfidenceSettings() {
  const { t } = useT("settings");
  const confidenceHighlightEnabled = useConfigStore((s) => s.confidenceHighlightEnabled);
  const setConfidenceHighlightEnabled = useConfigStore((s) => s.setConfidenceHighlightEnabled);
  const confidenceThreshold = useConfigStore((s) => s.confidenceThreshold);
  const setConfidenceThreshold = useConfigStore((s) => s.setConfidenceThreshold);

  const thresholdPercent = Math.round(confidenceThreshold * 100);

  return (
    <div className="rounded-xl border border-border/30 bg-card/50 p-5 space-y-5">
      <h3 className="text-sm font-semibold text-primary/80">{t("confidence.title")}</h3>

      {/* Toggle */}
      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm font-medium text-foreground">{t("confidence.toggle.label")}</label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("confidence.toggle.hint")}
          </p>
        </div>
        <button
          onClick={() => setConfidenceHighlightEnabled(!confidenceHighlightEnabled)}
          role="switch"
          aria-checked={confidenceHighlightEnabled}
          aria-label={t("confidence.toggle.ariaLabel")}
          className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-all duration-200 ${
            confidenceHighlightEnabled
              ? "bg-primary shadow-[0_0_0_3px_hsl(var(--primary)/0.12)]"
              : "bg-muted"
          }`}
        >
          <span
            className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-all duration-200 ${
              confidenceHighlightEnabled ? "translate-x-5 scale-[1.05]" : "translate-x-0"
            }`}
          />
        </button>
      </div>

      {/* Divider */}
      <div className="h-px bg-border/20" />

      {/* Threshold Slider */}
      <div className={`transition-opacity duration-200 ${confidenceHighlightEnabled ? "opacity-100" : "opacity-40 pointer-events-none"}`}>
        <div className="flex items-center justify-between mb-3">
          <div>
            <label className="text-sm font-medium text-foreground">{t("confidence.threshold.label")}</label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("confidence.threshold.hint")}
            </p>
          </div>
          <span className="text-sm font-semibold text-primary tabular-nums">
            {thresholdPercent}%
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={confidenceThreshold}
          onChange={(e) => setConfidenceThreshold(parseFloat(e.target.value))}
          disabled={!confidenceHighlightEnabled}
          className="w-full accent-primary cursor-pointer"
          aria-label={t("confidence.threshold.ariaLabel")}
        />
        <div className="mt-1.5 flex justify-between text-meta text-muted-foreground/50">
          <span>{t("confidence.threshold.always")}</span>
          <span>50%</span>
          <span>{t("confidence.threshold.never")}</span>
        </div>
      </div>
    </div>
  );
}
