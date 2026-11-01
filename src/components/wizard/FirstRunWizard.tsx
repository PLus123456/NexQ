// First-run setup: interface language → AI model → speech recognition →
// translation → audio check → finish. Each step reports whether it is done
// (tested); any step but the language can be skipped. Progress is saved on
// every change (stores/onboardingStore.ts), so setup continues where it was
// left, and finishing it sets `firstRunCompleted`.

import { useEffect, useRef } from "react";
import { Brain, ChevronLeft, ChevronRight, FastForward, Globe, History, Mic, SkipForward } from "lucide-react";
import { useT } from "../../i18n";
import { APP_NAME } from "../../lib/brand";
import {
  ONBOARDING_STEPS,
  canAdvance,
  canGoTo,
  isSkippable,
  statusOf,
  stepIndex,
  type OnboardingStepId,
} from "../../lib/onboarding/progress";
import { LlmQuickSetup } from "../../settings/llm/LlmQuickSetup";
import { SttQuickSetup } from "../../settings/stt/SttQuickSetup";
import { TranslationQuickSetup } from "../../settings/translation/TranslationQuickSetup";
import { initOnboarding, useOnboardingStore } from "../../stores/onboardingStore";
import { AudioSetupStep } from "./AudioSetupStep";
import { FinishStep } from "./FinishStep";
import { LanguageStep } from "./LanguageStep";
import { QuickSetupStep, useStepReporter } from "./QuickSetupStep";
import { StatusIcon, StepStatusNote } from "./parts";

function AudioStep() {
  const state = useOnboardingStore((s) => s.progress.steps.audio);
  const onStatusChange = useStepReporter("audio");
  return (
    <div>
      <AudioSetupStep onStatusChange={onStatusChange} />
      <StepStatusNote status={state?.status ?? "incomplete"} detail={state?.detail} />
    </div>
  );
}

function StepContent({ step }: { step: OnboardingStepId }) {
  const reportLanguage = useStepReporter("language");
  switch (step) {
    case "language":
      return <LanguageStep onStatusChange={reportLanguage} />;
    case "llm":
      return <QuickSetupStep step="llm" icon={<Brain className="h-5 w-5" />} Component={LlmQuickSetup} />;
    case "stt":
      return <QuickSetupStep step="stt" icon={<Mic className="h-5 w-5" />} Component={SttQuickSetup} />;
    case "translation":
      return <QuickSetupStep step="translation" icon={<Globe className="h-5 w-5" />} Component={TranslationQuickSetup} />;
    case "audio":
      return <AudioStep />;
    case "finish":
      return <FinishStep />;
  }
}

export function FirstRunWizard() {
  const { t } = useT(["onboarding", "common"]);
  const progress = useOnboardingStore((s) => s.progress);
  const loaded = useOnboardingStore((s) => s.loaded);
  const resumedAt = useOnboardingStore((s) => s.resumedAt);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    void initOnboarding();
  }, []);

  useEffect(() => {
    if (loaded) useOnboardingStore.getState().begin();
  }, [loaded]);

  const { current } = progress;
  useEffect(() => {
    mainRef.current?.scrollTo?.({ top: 0 });
  }, [current]);

  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center bg-background text-sm text-muted-foreground">
        {t("wizard.loading")}
      </div>
    );
  }

  const index = stepIndex(current);
  const status = statusOf(progress, current);
  const actions = useOnboardingStore.getState();

  return (
    <div className="flex h-full bg-background">
      {/* Step list */}
      <aside className="flex w-52 shrink-0 flex-col border-r border-border/30 bg-card/50">
        <div className="border-b border-border/20 px-5 py-4">
          <p className="text-base font-bold tracking-tight text-foreground">{APP_NAME}</p>
          <p className="text-xs font-medium text-muted-foreground/70">{t("wizard.title")}</p>
        </div>

        <nav aria-label={t("wizard.stepsLabel")} className="flex-1 overflow-y-auto px-3 py-3">
          <ol className="space-y-0.5">
            {ONBOARDING_STEPS.map((step, i) => {
              const stepStatus = statusOf(progress, step);
              const active = step === current;
              const reachable = canGoTo(progress, step);
              return (
                <li key={step}>
                  <button
                    type="button"
                    onClick={() => actions.goTo(step)}
                    disabled={!reachable}
                    aria-current={active ? "step" : undefined}
                    className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors ${
                      active
                        ? "bg-primary/10"
                        : reachable
                          ? "hover:bg-accent/50 cursor-pointer"
                          : "cursor-default opacity-60"
                    }`}
                  >
                    <span
                      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                        active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {!active && (stepStatus === "ok" || stepStatus === "skipped" || stepStatus === "error") ? (
                        <StatusIcon status={stepStatus} className="h-4 w-4" />
                      ) : (
                        i + 1
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className={`block text-sm font-medium leading-tight ${active ? "text-primary" : "text-foreground"}`}>
                        {t(`steps.${step}.name`)}
                      </span>
                      {step !== "finish" && stepStatus !== "pending" && (
                        <span className="block text-meta text-muted-foreground">{t(`status.${stepStatus}`)}</span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        {current !== "finish" && (
          <div className="border-t border-border/20 px-3 py-3">
            <button
              type="button"
              onClick={actions.skipToFinish}
              title={t("wizard.skipRestHint")}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
            >
              <FastForward className="h-3.5 w-3.5" />
              {t("wizard.skipRest")}
            </button>
          </div>
        )}
      </aside>

      {/* Current step */}
      <div className="flex min-w-0 flex-1 flex-col">
        <main ref={mainRef} className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-xl px-8 py-8">
            {resumedAt === current && (
              <p className="mb-5 flex items-center gap-1.5 rounded-lg bg-info/5 px-3 py-2 text-xs text-info">
                <History className="h-3.5 w-3.5" />
                {t("wizard.resumed")}
              </p>
            )}
            <div key={current} className="animate-in fade-in-0 slide-in-from-bottom-2 duration-200">
              <StepContent step={current} />
            </div>
          </div>
        </main>

        <footer className="flex items-center justify-between border-t border-border/20 px-8 py-4">
          <div>
            {index > 0 && (
              <button
                type="button"
                onClick={actions.back}
                className="inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <ChevronLeft className="h-4 w-4" />
                {t("common:actions.previous")}
              </button>
            )}
          </div>

          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground/70">
              {t("wizard.stepCounter", { current: index + 1, total: ONBOARDING_STEPS.length })}
            </span>
            {isSkippable(current) && status !== "ok" && (
              <button
                type="button"
                onClick={actions.skip}
                className="inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <SkipForward className="h-3.5 w-3.5" />
                {t("common:actions.skip")}
              </button>
            )}
            {current !== "finish" && (
              <button
                type="button"
                onClick={actions.next}
                disabled={!canAdvance(progress)}
                className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition-all hover:bg-primary/90 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t("common:actions.next")}
                <ChevronRight className="h-4 w-4" />
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
