// Steps 2–4: a package's quick-setup component (LLM, speech recognition,
// translation). The wizard goes by what the component reports through
// onStatusChange and shows where the step stands below it.

import { useCallback, type ComponentType, type ReactNode } from "react";
import { useT } from "../../i18n";
import type { OnboardingStepId } from "../../lib/onboarding/progress";
import type { QuickSetupProps, QuickSetupStatus } from "../../settings/quickSetup";
import { useOnboardingStore } from "../../stores/onboardingStore";
import { StepHeader, StepStatusNote } from "./parts";

interface QuickSetupStepProps {
  step: Extract<OnboardingStepId, "llm" | "stt" | "translation">;
  icon: ReactNode;
  Component: ComponentType<QuickSetupProps>; // i18n-ignore (a type, not text)
}

/** A step's onStatusChange: stable, so components reporting from an effect don't loop. */
export function useStepReporter(step: OnboardingStepId): QuickSetupProps["onStatusChange"] {
  return useCallback(
    (status: QuickSetupStatus, detail?: string) => useOnboardingStore.getState().report(step, status, detail),
    [step],
  );
}

export function QuickSetupStep({ step, icon, Component }: QuickSetupStepProps) {
  const { t } = useT("onboarding");
  const state = useOnboardingStore((s) => s.progress.steps[step]);
  const onStatusChange = useStepReporter(step);

  return (
    <div>
      <StepHeader icon={icon} title={t(`steps.${step}.title`)} description={t(`steps.${step}.description`)} />
      <Component key={step} variant="wizard" onStatusChange={onStatusChange} />
      <StepStatusNote status={state?.status ?? "incomplete"} detail={state?.detail} />
    </div>
  );
}
