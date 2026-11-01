// Setup progress is saved in config.json and every window follows it. Each
// window is a fresh module graph (its own Zustand stores); they meet in the
// plugin-store, modeled by one shared map that tells every window's
// listeners about each write (the writer included, like the Rust side).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saved = vi.hoisted(() => new Map<string, unknown>());
const keyListeners = vi.hoisted(() => [] as Array<{ key: string; cb: (v: unknown) => void }>);

vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    get: async (key: string) => saved.get(key),
    set: async (key: string, value: unknown) => {
      saved.set(key, value);
      for (const l of keyListeners) if (l.key === key) l.cb(structuredClone(value));
    },
    onKeyChange: async (key: string, cb: (v: unknown) => void) => {
      keyListeners.push({ key, cb });
      return () => {};
    },
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));

/** A window: a fresh module graph that has read the saved progress. */
async function openWindow() {
  vi.resetModules();
  const { initOnboarding, useOnboardingStore } = await import("./onboardingStore");
  const { useConfigStore } = await import("./configStore");
  const { useMeetingStore } = await import("./meetingStore");
  await initOnboarding();
  return { onboarding: useOnboardingStore, config: useConfigStore, meeting: useMeetingStore };
}

/** What the store last saved under `key`, once a write has gone through. */
async function savedValue(key: string) {
  await vi.waitFor(() => expect(saved.has(key)).toBe(true));
  return saved.get(key) as Record<string, unknown>;
}

describe("onboardingStore", () => {
  beforeEach(() => {
    saved.clear();
    keyListeners.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts at the first step when nothing was saved", async () => {
    const { onboarding } = await openWindow();
    expect(onboarding.getState().loaded).toBe(true);
    expect(onboarding.getState().progress.current).toBe("language");
  });

  it("saves every change, and setup reopens at the step it was left on", async () => {
    const first = await openWindow();
    first.onboarding.getState().next();
    first.onboarding.getState().skip();
    first.onboarding.getState().report("stt", "error", "HTTP 401");
    await vi.waitFor(() =>
      expect((saved.get("onboardingProgress") as { current?: string } | undefined)?.current).toBe("stt"),
    );

    const reopened = await openWindow();
    reopened.onboarding.getState().begin();
    const progress = reopened.onboarding.getState().progress;
    expect(progress.current).toBe("stt");
    expect(progress.steps).toMatchObject({
      language: { status: "ok" },
      llm: { status: "skipped" },
      stt: { status: "error", detail: "HTTP 401" },
    });
  });

  it("doesn't write when a transition changes nothing", async () => {
    const { onboarding } = await openWindow();
    onboarding.getState().back(); // already on the first step
    onboarding.getState().begin(); // nothing to resume
    await Promise.resolve();
    expect(saved.has("onboardingProgress")).toBe(false);
  });

  it("another window follows the changes", async () => {
    const launcher = await openWindow();
    const overlay = await openWindow();
    launcher.onboarding.getState().next();
    launcher.onboarding.getState().report("llm", "ok", "DeepSeek");
    await vi.waitFor(() => expect(overlay.onboarding.getState().progress.steps.llm).toEqual({ status: "ok", detail: "DeepSeek" }));
    expect(overlay.onboarding.getState().progress.current).toBe("llm");
    expect(overlay.onboarding.getState().progress.rev).toBe(launcher.onboarding.getState().progress.rev);
  });

  it("ignores an older value coming back after a newer change", async () => {
    const { onboarding } = await openWindow();
    onboarding.getState().next();
    const older = structuredClone(onboarding.getState().progress);
    onboarding.getState().skip();
    const newer = onboarding.getState().progress;

    for (const l of keyListeners) if (l.key === "onboardingProgress") l.cb(older);
    expect(onboarding.getState().progress).toEqual(newer);
  });

  it("finishing marks setup completed and leaves it for the launcher", async () => {
    const { onboarding, config, meeting } = await openWindow();
    meeting.setState({ currentView: "wizard" });
    onboarding.getState().skipToFinish();
    onboarding.getState().complete();

    expect(config.getState().firstRunCompleted).toBe(true);
    expect(meeting.getState().currentView).toBe("launcher");
    expect(onboarding.getState().progress.completedAt).toEqual(expect.any(Number));
    expect(await savedValue("firstRunCompleted")).toBe(true);
  });

  it("opening setup again after finishing starts over", async () => {
    const first = await openWindow();
    first.onboarding.getState().skipToFinish();
    first.onboarding.getState().complete();
    await vi.waitFor(() =>
      expect((saved.get("onboardingProgress") as { completedAt?: unknown } | undefined)?.completedAt).toEqual(expect.any(Number)),
    );

    const later = await openWindow();
    later.onboarding.getState().begin();
    const progress = later.onboarding.getState().progress;
    expect(progress.current).toBe("language");
    expect(progress.completedAt).toBeNull();
    expect(progress.steps).toEqual({ language: { status: "incomplete" } });
  });

  it("running setup again from settings shows it right away", async () => {
    const { onboarding, config, meeting } = await openWindow();
    onboarding.getState().skipToFinish();
    onboarding.getState().complete();
    meeting.setState({ currentView: "settings", previousView: "launcher" });

    onboarding.getState().restart();

    expect(config.getState().firstRunCompleted).toBe(false);
    expect(meeting.getState().currentView).toBe("launcher");
    expect(onboarding.getState().progress.current).toBe("language");
    expect(onboarding.getState().progress.completedAt).toBeNull();
  });

  it("setup started again in the other window shows here without a restart", async () => {
    const launcher = await openWindow();
    const overlay = await openWindow();
    launcher.config.setState({ firstRunCompleted: true });
    overlay.config.setState({ firstRunCompleted: true, });
    overlay.meeting.setState({ currentView: "overlay", settingsOpen: true });

    overlay.onboarding.getState().restart();

    expect(overlay.meeting.getState().settingsOpen).toBe(false);
    await vi.waitFor(() => expect(launcher.config.getState().firstRunCompleted).toBe(false));
    expect(launcher.onboarding.getState().progress.current).toBe("language");
  });
});
