// Last step: where every step stands, the personal knowledge base (upload a
// resume) and the shortcuts; finishing marks setup completed.

import { useState } from "react";
import { AlertTriangle, ArrowRight, ChevronRight, FileText, Keyboard, Mic, PartyPopper, Rocket } from "lucide-react";
import { UI_LANGUAGE_NAMES, resolveUiLanguage, useT, useUiLanguage } from "../../i18n";
import { ONBOARDING_STEPS, statusOf } from "../../lib/onboarding/progress";
import { useConfigStore } from "../../stores/configStore";
import { useMeetingStore } from "../../stores/meetingStore";
import { useOnboardingStore } from "../../stores/onboardingStore";
import { showToast } from "../../stores/toastStore";
import { KnowledgeBaseDialog } from "./KnowledgeBaseDialog";
import { StatusBadge, StepHeader } from "./parts";

const SUMMARY_STEPS = ONBOARDING_STEPS.filter((step) => step !== "finish");

function useShortcuts() {
  const hotkeys = useConfigStore((s) => s.hotkeys);
  return [
    { keys: hotkeys.toggle_assist, action: "assist", context: "meeting" },
    { keys: hotkeys.start_end_meeting, action: "startEnd", context: "global" },
    { keys: hotkeys.show_hide, action: "showHide", context: "global" },
    { keys: hotkeys.mode_say, action: "modeSay", context: "meeting" },
    { keys: hotkeys.mode_shorten, action: "modeShorten", context: "meeting" },
    { keys: hotkeys.mode_followup, action: "modeFollowup", context: "meeting" },
    { keys: hotkeys.mode_recap, action: "modeRecap", context: "meeting" },
    { keys: hotkeys.mode_ask, action: "modeAsk", context: "meeting" },
    { keys: hotkeys.open_settings, action: "openSettings", context: "global" },
    { keys: hotkeys.escape, action: "escape", context: "global" },
  ] as const;
}

export function FinishStep() {
  const { t } = useT(["onboarding", "common"]);
  const progress = useOnboardingStore((s) => s.progress);
  const { setting: languageSetting } = useUiLanguage();
  const shortcuts = useShortcuts();
  const [knowledgeBaseOpen, setKnowledgeBaseOpen] = useState(false);
  const [starting, setStarting] = useState(false);

  const languageName =
    languageSetting === "system"
      ? `${t("steps.language.system")} · ${UI_LANGUAGE_NAMES[resolveUiLanguage("system")]}`
      : UI_LANGUAGE_NAMES[languageSetting];

  const handleStartMeeting = async () => {
    setStarting(true);
    useOnboardingStore.getState().complete();
    try {
      await useMeetingStore.getState().startMeetingFlow();
    } catch (err) {
      console.error("[FinishStep] Failed to start meeting:", err);
      showToast(t("steps.finish.startFailed", { detail: err instanceof Error ? err.message : String(err) }), "error");
    }
  };

  return (
    <div>
      <StepHeader
        icon={<PartyPopper className="h-5 w-5" />}
        title={t("steps.finish.title")}
        description={t("steps.finish.description")}
      />

      <div className="space-y-5">
        {/* Where each step stands */}
        <section aria-label={t("steps.finish.summary")} className="rounded-xl border border-border/40 bg-card/50">
          <ul className="divide-y divide-border/20">
            {SUMMARY_STEPS.map((step) => {
              const state = progress.steps[step];
              return (
                <li key={step} className="flex items-center gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground">{t(`steps.${step}.name`)}</p>
                    {step === "language" ? (
                      <p className="truncate text-xs text-muted-foreground">{languageName}</p>
                    ) : (
                      state?.detail && <p className="truncate text-xs text-muted-foreground">{state.detail}</p>
                    )}
                  </div>
                  {step !== "language" && <StatusBadge status={statusOf(progress, step)} />}
                  <button
                    type="button"
                    onClick={() => useOnboardingStore.getState().goTo(step)}
                    aria-label={`${t("common:actions.change")} · ${t(`steps.${step}.name`)}`}
                    className="rounded-lg px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    {t("common:actions.change")}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        {statusOf(progress, "stt") !== "ok" && (
          <div role="note" className="flex items-start gap-2 rounded-lg border border-warning/20 bg-warning/5 px-3 py-2 text-xs text-warning">
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
            <span>{t("steps.finish.sttWarning")}</span>
          </div>
        )}

        {/* Personal knowledge base */}
        <section className="flex items-center gap-4 rounded-xl border border-border/40 bg-card/50 p-4">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">{t("steps.finish.knowledgeBase.title")}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("steps.finish.knowledgeBase.hint")}</p>
          </div>
          <button
            type="button"
            onClick={() => setKnowledgeBaseOpen(true)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border/40 bg-secondary/40 px-3.5 py-2 text-xs font-medium text-foreground transition-colors hover:bg-secondary"
          >
            <FileText className="h-3.5 w-3.5" />
            {t("steps.finish.knowledgeBase.upload")}
          </button>
        </section>

        {/* Keyboard shortcuts */}
        <details className="group rounded-xl border border-border/40 bg-card/50">
          <summary className="flex cursor-pointer list-none items-center gap-2.5 px-4 py-3 text-sm font-medium text-foreground">
            <Keyboard className="h-4 w-4 text-muted-foreground" />
            {t("steps.finish.shortcuts.title")}
            <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden />
          </summary>
          <div className="max-h-52 overflow-y-auto border-t border-border/20 p-1.5">
            <table className="w-full">
              <tbody>
                {shortcuts.map((s) => (
                  <tr key={s.action} className="border-b border-border/20 last:border-0">
                    <td className="px-3 py-1.5">
                      <kbd className="inline-flex items-center rounded border border-border/50 bg-background px-1.5 py-0.5 font-mono text-xs text-foreground">
                        {s.keys}
                      </kbd>
                    </td>
                    <td className="px-2 py-1.5 text-xs text-foreground">
                      {t(`steps.finish.shortcuts.actions.${s.action}`)}
                    </td>
                    <td className="px-3 py-1.5 text-right text-meta text-muted-foreground/60">
                      {t(`steps.finish.shortcuts.contexts.${s.context}`)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>

        {/* Finish */}
        <div className="space-y-3 pt-1">
          <button
            type="button"
            onClick={handleStartMeeting}
            disabled={starting}
            className="group flex w-full items-center justify-center gap-3 rounded-2xl bg-primary px-6 py-3.5 text-base font-semibold text-primary-foreground shadow-md shadow-primary/10 transition-all duration-200 hover:shadow-lg hover:shadow-primary/20 disabled:opacity-60"
          >
            <Mic className="h-5 w-5" />
            {t("steps.finish.startMeeting")}
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </button>
          <button
            type="button"
            onClick={() => useOnboardingStore.getState().complete()}
            disabled={starting}
            className="flex w-full items-center justify-center gap-2.5 rounded-2xl border border-border/40 bg-secondary/20 px-6 py-3 text-sm font-semibold text-foreground transition-all duration-200 hover:bg-secondary/40 disabled:opacity-60"
          >
            <Rocket className="h-4 w-4 text-muted-foreground" />
            {t("steps.finish.goToLauncher")}
          </button>
        </div>
      </div>

      {knowledgeBaseOpen && <KnowledgeBaseDialog onClose={() => setKnowledgeBaseOpen(false)} />}
    </div>
  );
}
