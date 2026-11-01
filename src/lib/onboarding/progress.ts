// First-run setup: its steps, the saved progress (`onboardingProgress` in
// config.json) and the transitions between steps. Pure functions; the store
// (stores/onboardingStore.ts) persists and syncs them, the wizard renders.

import type { QuickSetupStatus } from "../../settings/quickSetup";

export const ONBOARDING_STEPS = ["language", "llm", "stt", "translation", "audio", "finish"] as const;
export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number];

/**
 * "pending": not reached yet; "incomplete": reached but not done. The rest is
 * what the step reported (a quick setup's status), or "skipped" when the user
 * skipped it.
 */
export type StepStatus = "pending" | QuickSetupStatus;

export interface StepState {
  status: Exclude<StepStatus, "pending">;
  /** What the step said about its state (why a test failed, what was set up). */
  detail?: string;
}

export const PROGRESS_KEY = "onboardingProgress";
export const PROGRESS_VERSION = 1;

export interface OnboardingProgress {
  version: typeof PROGRESS_VERSION;
  /** Bumped by every change: a window ignores older values the store sends back. */
  rev: number;
  current: OnboardingStepId;
  steps: Partial<Record<OnboardingStepId, StepState>>;
  /** When setup was finished (ms). Opening it again after that starts over. */
  completedAt: number | null;
}

const STATUSES: readonly StepState["status"][] = ["incomplete", "ok", "skipped", "error"];

function isStepId(value: unknown): value is OnboardingStepId {
  return typeof value === "string" && (ONBOARDING_STEPS as readonly string[]).includes(value);
}

export function stepIndex(step: OnboardingStepId): number {
  return ONBOARDING_STEPS.indexOf(step);
}

/** The interface language always has a value; the last step is where setup ends. */
export function isSkippable(step: OnboardingStepId): boolean {
  return step !== "language" && step !== "finish";
}

export function statusOf(progress: OnboardingProgress, step: OnboardingStepId): StepStatus {
  return progress.steps[step]?.status ?? "pending";
}

function withStep(progress: OnboardingProgress, step: OnboardingStepId, state: StepState): OnboardingProgress {
  return { ...progress, steps: { ...progress.steps, [step]: state } };
}

/** Makes `step` current; a step reached for the first time becomes "incomplete". */
function enter(progress: OnboardingProgress, step: OnboardingStepId): OnboardingProgress {
  const moved = progress.current === step ? progress : { ...progress, current: step };
  return statusOf(moved, step) === "pending" ? withStep(moved, step, { status: "incomplete" }) : moved;
}

export function freshProgress(rev = 0): OnboardingProgress {
  const first = ONBOARDING_STEPS[0];
  return { version: PROGRESS_VERSION, rev, current: first, steps: { [first]: { status: "incomplete" } }, completedAt: null };
}

/** A stored value as progress. Anything unreadable, or from another version, starts over. */
export function normalizeProgress(raw: unknown): OnboardingProgress {
  if (!raw || typeof raw !== "object") return freshProgress();
  const value = raw as Record<string, unknown>;
  if (value.version !== PROGRESS_VERSION) return freshProgress();
  const steps: OnboardingProgress["steps"] = {};
  if (value.steps && typeof value.steps === "object") {
    for (const [step, state] of Object.entries(value.steps as Record<string, unknown>)) {
      if (!isStepId(step) || !state || typeof state !== "object") continue;
      const { status, detail } = state as Record<string, unknown>;
      if (!STATUSES.includes(status as StepState["status"])) continue;
      steps[step] = {
        status: status as StepState["status"],
        ...(typeof detail === "string" && detail ? { detail } : {}),
      };
    }
  }
  const rev = typeof value.rev === "number" && Number.isFinite(value.rev) ? value.rev : 0;
  const completedAt = typeof value.completedAt === "number" ? value.completedAt : null;
  const current = isStepId(value.current) ? value.current : ONBOARDING_STEPS[0];
  return enter({ version: PROGRESS_VERSION, rev, current, steps, completedAt }, current);
}

/** Next can be pressed: the step is done, or it said there is nothing to set up. */
export function canAdvance(progress: OnboardingProgress): boolean {
  if (progress.current === "finish") return false;
  if (!isSkippable(progress.current)) return true;
  const status = statusOf(progress, progress.current);
  return status === "ok" || status === "skipped";
}

export function next(progress: OnboardingProgress): OnboardingProgress {
  if (!canAdvance(progress)) return progress;
  const step = progress.current;
  const done = !isSkippable(step) && statusOf(progress, step) !== "ok" ? withStep(progress, step, { status: "ok" }) : progress;
  return enter(done, ONBOARDING_STEPS[stepIndex(step) + 1]);
}

export function back(progress: OnboardingProgress): OnboardingProgress {
  const index = stepIndex(progress.current);
  return index > 0 ? enter(progress, ONBOARDING_STEPS[index - 1]) : progress;
}

/** Leaves the current step as skipped (a step already done stays done). */
export function skip(progress: OnboardingProgress): OnboardingProgress {
  const step = progress.current;
  if (!isSkippable(step)) return progress;
  const skipped = statusOf(progress, step) === "ok" ? progress : withStep(progress, step, { status: "skipped" });
  return enter(skipped, ONBOARDING_STEPS[stepIndex(step) + 1]);
}

/** Skips the current step and every later one not done yet, and goes to the last step. */
export function skipToFinish(progress: OnboardingProgress): OnboardingProgress {
  let out = progress;
  for (const step of ONBOARDING_STEPS.slice(stepIndex(progress.current))) {
    if (step === "finish") break;
    if (statusOf(out, step) === "ok") continue;
    out = withStep(out, step, { status: isSkippable(step) ? "skipped" : "ok" });
  }
  return enter(out, "finish");
}

/** Steps already reached can be opened again from the step list. */
export function canGoTo(progress: OnboardingProgress, step: OnboardingStepId): boolean {
  return step === progress.current || statusOf(progress, step) !== "pending";
}

export function goTo(progress: OnboardingProgress, step: OnboardingStepId): OnboardingProgress {
  return step !== progress.current && canGoTo(progress, step) ? enter(progress, step) : progress;
}

/**
 * Applies what a step reported. The last report wins, except that a plain
 * "incomplete" (a step showing again) doesn't undo the user's skip.
 */
export function report(
  progress: OnboardingProgress,
  step: OnboardingStepId,
  status: QuickSetupStatus,
  detail?: string,
): OnboardingProgress {
  const previous = progress.steps[step];
  if (status === "incomplete" && previous?.status === "skipped") return progress;
  const state: StepState = detail ? { status, detail } : { status };
  if (previous?.status === state.status && previous.detail === state.detail) return progress;
  return withStep(progress, step, state);
}

/** Setup finished: the last step done and the time recorded. */
export function complete(progress: OnboardingProgress, now: number): OnboardingProgress {
  return { ...withStep(enter(progress, "finish"), "finish", { status: "ok" }), completedAt: now };
}

/** Where setup continues when it opens: the saved step, or the start after a finished run. */
export function resume(progress: OnboardingProgress): OnboardingProgress {
  return progress.completedAt != null ? freshProgress(progress.rev) : enter(progress, progress.current);
}
