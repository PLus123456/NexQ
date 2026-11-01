import { describe, expect, it } from "vitest";
import {
  ONBOARDING_STEPS,
  PROGRESS_VERSION,
  back,
  canAdvance,
  canGoTo,
  complete,
  freshProgress,
  goTo,
  next,
  normalizeProgress,
  report,
  resume,
  skip,
  skipToFinish,
  statusOf,
  type OnboardingProgress,
} from "./progress";
import { resolveAppView } from "./view";

/** Progress at `current` with the given step states. */
function at(current: OnboardingProgress["current"], steps: OnboardingProgress["steps"] = {}): OnboardingProgress {
  return { ...freshProgress(), current, steps: { ...steps, [current]: steps[current] ?? { status: "incomplete" } } };
}

describe("onboarding progress: moving between steps", () => {
  it("starts at the language step, reached but not done", () => {
    const progress = freshProgress();
    expect(progress.current).toBe("language");
    expect(statusOf(progress, "language")).toBe("incomplete");
    expect(statusOf(progress, "llm")).toBe("pending");
  });

  it("goes forward from the language without a test and marks it done", () => {
    const progress = next(freshProgress());
    expect(progress.current).toBe("llm");
    expect(statusOf(progress, "language")).toBe("ok");
    expect(statusOf(progress, "llm")).toBe("incomplete");
  });

  it("only goes forward from a step that is done or has nothing to set up", () => {
    const untested = at("llm");
    expect(canAdvance(untested)).toBe(false);
    expect(next(untested)).toBe(untested);

    const failed = report(untested, "llm", "error", "401");
    expect(canAdvance(failed)).toBe(false);

    const tested = report(untested, "llm", "ok");
    expect(canAdvance(tested)).toBe(true);
    expect(next(tested).current).toBe("stt");

    const nothingToDo = report(at("translation"), "translation", "skipped");
    expect(next(nothingToDo).current).toBe("audio");
  });

  it("goes back without changing any state", () => {
    const tested = report(at("stt", { language: { status: "ok" }, llm: { status: "ok" } }), "stt", "ok");
    const previous = back(tested);
    expect(previous.current).toBe("llm");
    expect(previous.steps).toEqual(tested.steps);
    expect(back(freshProgress())).toEqual(freshProgress());
  });

  it("skips a step: marked skipped, then on to the next one", () => {
    const progress = skip(at("llm", { language: { status: "ok" } }));
    expect(progress.current).toBe("stt");
    expect(statusOf(progress, "llm")).toBe("skipped");
  });

  it("keeps a step that is done when it is skipped", () => {
    const progress = skip(report(at("stt"), "stt", "ok"));
    expect(statusOf(progress, "stt")).toBe("ok");
    expect(progress.current).toBe("translation");
  });

  it("can't skip the language or the last step", () => {
    const language = freshProgress();
    expect(skip(language)).toBe(language);
    const last = at("finish");
    expect(skip(last)).toBe(last);
    expect(canAdvance(last)).toBe(false);
    expect(next(last)).toBe(last);
  });

  it("skips the rest: every later step not done yet, then the last step", () => {
    const progress = skipToFinish(report(at("llm", { language: { status: "ok" } }), "llm", "error", "boom"));
    expect(progress.current).toBe("finish");
    expect(statusOf(progress, "language")).toBe("ok");
    expect(statusOf(progress, "llm")).toBe("skipped");
    expect(statusOf(progress, "stt")).toBe("skipped");
    expect(statusOf(progress, "translation")).toBe("skipped");
    expect(statusOf(progress, "audio")).toBe("skipped");
    expect(statusOf(progress, "finish")).toBe("incomplete");
  });

  it("skipping the rest from the start also takes the language as chosen", () => {
    expect(statusOf(skipToFinish(freshProgress()), "language")).toBe("ok");
  });

  it("opens steps already reached from the step list, not later ones", () => {
    const progress = skip(next(freshProgress())); // language ok, llm skipped, at stt
    expect(canGoTo(progress, "language")).toBe(true);
    expect(canGoTo(progress, "llm")).toBe(true);
    expect(canGoTo(progress, "translation")).toBe(false);
    expect(goTo(progress, "translation")).toBe(progress);
    expect(goTo(progress, "language").current).toBe("language");
    expect(goTo(progress, "stt")).toBe(progress);
  });
});

describe("onboarding progress: what steps report", () => {
  it("keeps the latest report, with its detail", () => {
    let progress = report(at("llm"), "llm", "ok", "DeepSeek · deepseek-chat");
    expect(progress.steps.llm).toEqual({ status: "ok", detail: "DeepSeek · deepseek-chat" });
    progress = report(progress, "llm", "error", "HTTP 401");
    expect(progress.steps.llm).toEqual({ status: "error", detail: "HTTP 401" });
    progress = report(progress, "llm", "incomplete");
    expect(progress.steps.llm).toEqual({ status: "incomplete" });
  });

  it("returns the same progress when nothing changes", () => {
    const progress = report(at("llm"), "llm", "ok");
    expect(report(progress, "llm", "ok")).toBe(progress);
  });

  it("a step showing again (\"incomplete\") doesn't undo a skip, a real result does", () => {
    const skipped = skip(at("llm"));
    expect(statusOf(report(skipped, "llm", "incomplete"), "llm")).toBe("skipped");
    expect(statusOf(report(skipped, "llm", "ok"), "llm")).toBe("ok");
  });

  it("accepts a late report for a step the user already left", () => {
    const left = skip(at("llm"));
    const progress = report(left, "llm", "ok");
    expect(progress.current).toBe("stt");
    expect(statusOf(progress, "llm")).toBe("ok");
  });
});

describe("onboarding progress: saving, resuming and finishing", () => {
  it("resumes a saved run at its step", () => {
    const saved = skip(next(freshProgress()));
    const restored = normalizeProgress(JSON.parse(JSON.stringify(saved)));
    expect(restored).toEqual(saved);
    expect(resume(restored)).toBe(restored);
  });

  it("finishing records the time; opening setup after that starts over", () => {
    const done = complete(at("finish", { language: { status: "ok" }, llm: { status: "ok" } }), 1234);
    expect(done.completedAt).toBe(1234);
    expect(statusOf(done, "finish")).toBe("ok");
    const again = resume({ ...done, rev: 7 });
    expect(again).toEqual(freshProgress(7));
  });

  it("starts over on anything unreadable or from another version", () => {
    for (const raw of [undefined, null, "x", 3, [], {}, { version: 99, current: "stt" }]) {
      expect(normalizeProgress(raw)).toEqual(freshProgress());
    }
  });

  it("drops unknown steps and statuses, and falls back to the first step", () => {
    const progress = normalizeProgress({
      version: PROGRESS_VERSION,
      rev: 3,
      current: "nope",
      steps: { llm: { status: "ok", detail: 5 }, stt: { status: "weird" }, bogus: { status: "ok" }, audio: null },
      completedAt: "yesterday",
    });
    expect(progress).toEqual({
      version: PROGRESS_VERSION,
      rev: 3,
      current: "language",
      steps: { language: { status: "incomplete" }, llm: { status: "ok" } },
      completedAt: null,
    });
  });

  it("covers every step in order", () => {
    expect(ONBOARDING_STEPS).toEqual(["language", "llm", "stt", "translation", "audio", "finish"]);
  });
});

describe("main window view", () => {
  it("shows setup until it is finished, and settings opened from it in its place", () => {
    expect(resolveAppView(false, "launcher")).toBe("wizard");
    expect(resolveAppView(false, "overlay")).toBe("wizard");
    expect(resolveAppView(false, "wizard")).toBe("wizard");
    expect(resolveAppView(false, "settings")).toBe("settings");
  });

  it("shows the requested view once setup is finished", () => {
    expect(resolveAppView(true, "launcher")).toBe("launcher");
    expect(resolveAppView(true, "settings")).toBe("settings");
    expect(resolveAppView(true, "overlay")).toBe("overlay");
    expect(resolveAppView(true, "wizard")).toBe("launcher");
  });
});
