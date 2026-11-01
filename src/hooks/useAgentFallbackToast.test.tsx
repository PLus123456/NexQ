import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeUiLanguage } from "../i18n";
import type { Meeting } from "../lib/types";

type Handler = (e: { payload: unknown }) => void;
const listeners = vi.hoisted(() => new Map<string, Set<(e: { payload: unknown }) => void>>());
const shown = vi.hoisted(() => ({ launcher: true, overlay: true }) as Record<string, boolean>);
const toast = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/event", () => {
  const dispatch = (name: string, payload?: unknown) =>
    listeners.get(name)?.forEach((cb) => cb({ payload }));
  return {
    listen: async (name: string, cb: Handler) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(cb);
      return () => listeners.get(name)!.delete(cb);
    },
    // Tauri delivers an emitted event to every window, the sender included.
    emit: async (name: string, payload?: unknown) => dispatch(name, payload),
  };
});
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
vi.mock("../lib/windows", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/windows")>()),
  isWindowShown: async (label: string) => shown[label] ?? false,
}));
vi.mock("../stores/toastStore", () => ({ showToast: (...args: unknown[]) => toast(...args) }));

import { fallbackMessage, shouldToastHere, useAgentFallbackToast } from "./useAgentFallbackToast";
import { useMeetingStore } from "../stores/meetingStore";

function Probe({ label }: { label: string }) {
  useAgentFallbackToast(label);
  return null;
}

const EVENT = { reason: "usage limit reached", provider: "Ollama" };

async function emitFallback(payload: unknown = EVENT) {
  await act(async () => {
    listeners.get("agent_fallback")?.forEach((cb) => cb({ payload }));
  });
}

/** Both windows mounted, like the real app. */
async function mountBoth() {
  render(
    <>
      <Probe label="launcher" />
      <Probe label="overlay" />
    </>,
  );
  await act(async () => {});
}

beforeEach(() => {
  listeners.clear();
  toast.mockClear();
  shown.launcher = true;
  shown.overlay = true;
  useMeetingStore.setState({ activeMeeting: null, currentView: "launcher" });
});
afterEach(async () => {
  cleanup();
  await act(() => changeUiLanguage("en"));
});

describe("fallbackMessage", () => {
  it("uses the usage-limit copy for rate limits", () => {
    expect(fallbackMessage(EVENT)).toBe("Claude usage limit reached — using Ollama");
  });
  it("omits the provider when nothing took over", () => {
    expect(fallbackMessage({ reason: "usage limit reached", provider: "" })).toBe("Claude usage limit reached");
  });
  it("names the reason otherwise", () => {
    expect(fallbackMessage({ reason: "not logged in", provider: "Groq" })).toBe(
      "Claude unavailable (not logged in) — using Groq",
    );
  });
  it("keeps every label the backend sends as it is in English", () => {
    for (const reason of ["not installed", "not logged in", "conversation too long", "session crashed", "unavailable"]) {
      expect(fallbackMessage({ reason, provider: "Groq" })).toBe(`Claude unavailable (${reason}) — using Groq`);
    }
  });

  describe("in Chinese", () => {
    beforeEach(async () => {
      await act(() => changeUiLanguage("zh-CN"));
    });

    it("translates the copy", () => {
      expect(fallbackMessage(EVENT)).toBe("Claude 用量已达上限，已改用 Ollama");
      expect(fallbackMessage({ reason: "usage limit reached", provider: "" })).toBe("Claude 用量已达上限");
    });
    it("translates the backend's known reasons and shows any other as it came", () => {
      expect(fallbackMessage({ reason: "not logged in", provider: "Groq" })).toBe("Claude 不可用（未登录），已改用 Groq");
      expect(fallbackMessage({ reason: "not installed", provider: "Groq" })).toBe("Claude 不可用（未安装），已改用 Groq");
      expect(fallbackMessage({ reason: "conversation too long", provider: "Groq" })).toBe(
        "Claude 不可用（对话过长），已改用 Groq",
      );
      expect(fallbackMessage({ reason: "session crashed", provider: "Groq" })).toBe(
        "Claude 不可用（会话崩溃），已改用 Groq",
      );
      expect(fallbackMessage({ reason: "unavailable", provider: "Groq" })).toBe("Claude 不可用（其他原因），已改用 Groq");
      expect(fallbackMessage({ reason: "spawn failed", provider: "Groq" })).toBe(
        "Claude 不可用（spawn failed），已改用 Groq",
      );
    });
  });
});

describe("shouldToastHere", () => {
  const base = { thisShown: true, otherShown: true };
  it("prefers the overlay in a meeting and the launcher outside one", () => {
    expect(shouldToastHere({ ...base, windowLabel: "overlay", inMeeting: true })).toBe(true);
    expect(shouldToastHere({ ...base, windowLabel: "launcher", inMeeting: true })).toBe(false);
    expect(shouldToastHere({ ...base, windowLabel: "launcher", inMeeting: false })).toBe(true);
    expect(shouldToastHere({ ...base, windowLabel: "overlay", inMeeting: false })).toBe(false);
  });
  it("yields to the other window only when this one is hidden or the other is", () => {
    expect(shouldToastHere({ windowLabel: "launcher", inMeeting: true, thisShown: true, otherShown: false })).toBe(true);
    expect(shouldToastHere({ windowLabel: "overlay", inMeeting: true, thisShown: false, otherShown: true })).toBe(false);
    expect(shouldToastHere({ windowLabel: "launcher", inMeeting: true, thisShown: false, otherShown: false })).toBe(false);
  });
});

describe("useAgentFallbackToast", () => {
  it("with no meeting, only the launcher toasts, as a warning", async () => {
    await mountBoth();
    await emitFallback();
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith("Claude usage limit reached — using Ollama", "warning");
  });

  it("shows the notice in the UI language at the time it appears", async () => {
    await mountBoth();
    await act(() => changeUiLanguage("zh-CN"));
    await emitFallback();
    expect(toast).toHaveBeenCalledExactlyOnceWith("Claude 用量已达上限，已改用 Ollama", "warning");
  });

  it("during a meeting, the overlay toasts even while its settings are open", async () => {
    useMeetingStore.setState({ activeMeeting: { id: "m1" } as Meeting, currentView: "settings" });
    shown.launcher = false;
    await mountBoth();
    await emitFallback();
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it("during a meeting with the overlay hidden, the visible launcher toasts once", async () => {
    useMeetingStore.setState({ activeMeeting: { id: "m1" } as Meeting });
    shown.overlay = false;
    await mountBoth();
    await emitFallback();
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it("holds the notice while no window is visible and shows it once one returns", async () => {
    useMeetingStore.setState({ activeMeeting: { id: "m1" } as Meeting });
    shown.launcher = false;
    shown.overlay = false;
    await mountBoth();
    await emitFallback();
    expect(toast).not.toHaveBeenCalled();

    shown.overlay = true;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(toast).toHaveBeenCalledTimes(1);

    // The other window dropped its copy: it shows nothing when it returns.
    shown.launcher = true;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(toast).toHaveBeenCalledTimes(1);
  });
});
