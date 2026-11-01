import type { ParseKeys } from "i18next";
import { Radar } from "lucide-react";
import { useConfigStore } from "../stores/configStore";
import { BUILT_IN_SCENARIOS, scenarioName } from "../lib/scenarios";
import { isMacPlatform } from "../lib/shortcutLabel";
import { useT } from "../i18n";
import type { AIScenario, MeetingDetectionConfig } from "../lib/types";

type AppKey = "zoom" | "teams" | "google_meet" | "webex" | "slack" | "discord";

const APPS: Array<{ key: AppKey; labelKey: ParseKeys<"settings"> }> = [
  { key: "zoom", labelKey: "meetingDetection.apps.zoom" },
  { key: "teams", labelKey: "meetingDetection.apps.teams" },
  { key: "google_meet", labelKey: "meetingDetection.apps.googleMeet" },
  { key: "webex", labelKey: "meetingDetection.apps.webex" },
  { key: "slack", labelKey: "meetingDetection.apps.slack" },
  { key: "discord", labelKey: "meetingDetection.apps.discord" },
];

const DISMISS_OPTIONS: Array<{ value: number; labelKey: ParseKeys<"settings"> }> = [
  { value: 30, labelKey: "meetingDetection.dismiss.options.seconds30" },
  { value: 60, labelKey: "meetingDetection.dismiss.options.minute1" },
  { value: 120, labelKey: "meetingDetection.dismiss.options.minutes2" },
  { value: 0, labelKey: "meetingDetection.dismiss.options.untilCallEnds" },
];

const CHECK_OPTIONS: Array<{ value: number; labelKey: ParseKeys<"settings"> }> = [
  { value: 1, labelKey: "meetingDetection.check.options.second1" },
  { value: 2, labelKey: "meetingDetection.check.options.seconds2" },
  { value: 3, labelKey: "meetingDetection.check.options.seconds3" },
  { value: 5, labelKey: "meetingDetection.check.options.seconds5" },
  { value: 10, labelKey: "meetingDetection.check.options.seconds10" },
];

/** Settings → General: offer to start NexQ when a call app starts a meeting. */
export function MeetingDetectionSettings() {
  const { t } = useT("settings");
  const config = useConfigStore((s) => s.meetingDetection);
  const setConfig = useConfigStore((s) => s.setMeetingDetection);
  const update = (patch: Partial<MeetingDetectionConfig>) => setConfig({ ...config, ...patch });
  // Detection reads Windows audio sessions; macOS support comes later.
  const unsupported = isMacPlatform();

  return (
    <div className="rounded-xl border border-border/30 bg-card/50 p-5 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex gap-2.5">
          <Radar
            className={`mt-0.5 h-4 w-4 shrink-0 transition-colors duration-200 ${config.enabled && !unsupported ? "text-primary" : "text-muted-foreground"}`}
            aria-hidden="true"
          />
          <div>
            <label id="meeting-detection-label" className="text-sm font-medium text-foreground">
              {t("meetingDetection.label")}
            </label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("meetingDetection.description")}
            </p>
          </div>
        </div>
        <button
          onClick={() => update({ enabled: !config.enabled })}
          disabled={unsupported}
          role="switch"
          aria-checked={config.enabled && !unsupported}
          aria-labelledby="meeting-detection-label"
          className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50 ${
            config.enabled && !unsupported ? "bg-primary shadow-[0_0_0_3px_hsl(var(--primary)/0.12)]" : "bg-muted"
          }`}
        >
          <span
            className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-all duration-200 ${
              config.enabled && !unsupported ? "translate-x-5 scale-[1.05]" : "translate-x-0"
            }`}
          />
        </button>
      </div>

      {unsupported ? (
        <p className="text-meta text-muted-foreground/70">{t("meetingDetection.unsupported")}</p>
      ) : (
        config.enabled && (
          <>
            <div className="h-px bg-border/20" />
            <div>
              <span className="text-xs font-medium text-foreground/80">{t("meetingDetection.apps.label")}</span>
              <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={t("meetingDetection.apps.ariaLabel")}>
                {APPS.map(({ key, labelKey }) => {
                  const on = config[key];
                  return (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={on}
                      onClick={() => update({ [key]: !on } as Partial<MeetingDetectionConfig>)}
                      className={`rounded-full border px-3 py-1 text-xs transition-colors duration-150 cursor-pointer ${
                        on
                          ? "border-primary/30 bg-primary/10 text-primary"
                          : "border-border/40 bg-secondary/20 text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {t(labelKey)}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1.5 text-meta text-muted-foreground/60">
                {t("meetingDetection.apps.note")}
              </p>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <label className="block">
                <span className="text-xs font-medium text-foreground/80">{t("meetingDetection.startAs.label")}</span>
                <select
                  value={config.default_scenario}
                  onChange={(e) => update({ default_scenario: e.target.value as AIScenario })}
                  className="mt-1.5 w-full cursor-pointer rounded-lg border border-border/50 bg-background px-3 py-2 text-xs text-foreground focus:border-primary focus:outline-none"
                >
                  {BUILT_IN_SCENARIOS.map((s) => (
                    <option key={s.id} value={s.id}>
                      {scenarioName(s)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-xs font-medium text-foreground/80">{t("meetingDetection.dismiss.label")}</span>
                <select
                  value={config.auto_dismiss_secs}
                  onChange={(e) => update({ auto_dismiss_secs: Number(e.target.value) })}
                  className="mt-1.5 w-full cursor-pointer rounded-lg border border-border/50 bg-background px-3 py-2 text-xs text-foreground focus:border-primary focus:outline-none"
                >
                  {DISMISS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {t(o.labelKey)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-xs font-medium text-foreground/80">{t("meetingDetection.check.label")}</span>
                <select
                  value={config.check_interval_secs}
                  onChange={(e) => update({ check_interval_secs: Math.max(1, Number(e.target.value)) })}
                  className="mt-1.5 w-full cursor-pointer rounded-lg border border-border/50 bg-background px-3 py-2 text-xs text-foreground focus:border-primary focus:outline-none"
                >
                  {CHECK_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {t(o.labelKey)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="text-meta text-muted-foreground/60">
              {t("meetingDetection.check.hint")}
            </p>
          </>
        )
      )}
    </div>
  );
}
