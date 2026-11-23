import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Tauri stand-ins: events, the current window, the config file ─────────────

const listeners = vi.hoisted(() => new Map<string, Set<(e: { payload: unknown }) => void>>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name)!.add(cb);
    return () => listeners.get(name)!.delete(cb);
  },
  emit: async () => {},
}));

const windowCalls = vi.hoisted(() => [] as string[]);
const pointerMock = vi.hoisted(() => ({
  cursor: { x: 10, y: 10 },
  /** When set, outerPosition/innerSize expose physical x/y/width/height like real Tauri. */
  physicalRect: null as { x: number; y: number; width: number; height: number } | null,
}));
vi.mock("@tauri-apps/api/window", () => {
  const record = (name: string) => async (...args: unknown[]) => {
    windowCalls.push(args.length ? `${name}(${args.map((a) => JSON.stringify(a)).join(",")})` : name);
  };
  const win = {
    setIgnoreCursorEvents: record("setIgnoreCursorEvents"),
    startDragging: record("startDragging"),
    setSize: record("setSize"),
    setPosition: record("setPosition"),
    onMoved: async () => () => {},
    onResized: async () => () => {},
    scaleFactor: async () => 2,
    outerPosition: async () => ({
      ...(pointerMock.physicalRect ? { x: pointerMock.physicalRect.x, y: pointerMock.physicalRect.y } : {}),
      toLogical: () => ({ x: 256, y: 640 }),
    }),
    innerSize: async () => ({
      ...(pointerMock.physicalRect ? { width: pointerMock.physicalRect.width, height: pointerMock.physicalRect.height } : {}),
      toLogical: () => ({ width: 1000, height: 229 }),
    }),
  };
  const monitor = { position: { x: 0, y: 0 }, size: { width: 3024, height: 1964 }, workArea: { position: { x: 0, y: 50 }, size: { width: 3024, height: 1790 } }, scaleFactor: 2 };
  return {
    getCurrentWindow: () => win,
    availableMonitors: async () => [monitor],
    currentMonitor: async () => monitor,
    primaryMonitor: async () => monitor,
    cursorPosition: async () => ({ ...pointerMock.cursor }),
    monitorFromPoint: async () => monitor,
    LogicalSize: class { constructor(public width: number, public height: number) {} toJSON() { return [this.width, this.height]; } },
    LogicalPosition: class { constructor(public x: number, public y: number) {} toJSON() { return [this.x, this.y]; } },
  };
});

const saved = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    get: async (key: string) => saved.get(key),
    set: async (key: string, value: unknown) => void saved.set(key, value),
    onKeyChange: async () => () => {},
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ WebviewWindow: { getByLabel: async () => null } }));

import { CaptionsWindow } from "./CaptionsWindow";
import { useConfigStore } from "../stores/configStore";
import { DEFAULT_CAPTIONS_SETTINGS } from "../lib/captions/types";
import { changeUiLanguage } from "../i18n";

function emit(name: string, payload: unknown) {
  act(() => {
    for (const cb of listeners.get(name) ?? []) cb({ payload });
  });
}

const say = (id: string, text: string, final = false, speaker = "Them") =>
  emit(final ? "transcript_final" : "transcript_update", { segment: { id, text, speaker, timestamp_ms: 0, is_final: final, confidence: 0.9 } });

const translate = (id: string, original: string, translated: string, extra: Record<string, unknown> = {}) =>
  emit("translation_result", { segment_id: id, original_text: original, translated_text: translated, source_lang: "en", target_lang: "zh", provider: "soniox", is_final: false, ...extra });

async function open() {
  const view = render(<CaptionsWindow />);
  // Settings loaded, window placed, listeners in.
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
  await vi.waitFor(() => expect(listeners.get("translation_result")?.size).toBe(1));
  return view;
}

/** Settings as saved in the config file, which the window loads when it opens. */
function savedSettings(values: Partial<typeof DEFAULT_CAPTIONS_SETTINGS>) {
  for (const [key, value] of Object.entries(values)) saved.set(key, value);
}

const cueTexts = () =>
  [...document.querySelectorAll<HTMLElement>(".caption-cue")].filter((el) => !el.dataset.leaving).map((el) => el.textContent);

beforeEach(() => {
  listeners.clear();
  windowCalls.length = 0;
  saved.clear();
  pointerMock.cursor = { x: 10, y: 10 };
  pointerMock.physicalRect = null;
  useConfigStore.setState({ ...DEFAULT_CAPTIONS_SETTINGS });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await changeUiLanguage("en");
});

describe("CaptionsWindow", () => {
  it("is a see-through window that fills its holder", async () => {
    const { container } = await open();
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("bg-transparent");
    expect(root.className).toContain("h-full");
    expect(root.className).toContain("w-full");
  });

  it("puts itself at the bottom centre of the screen the first time and records that place", async () => {
    await open();
    await vi.waitFor(() => expect(useConfigStore.getState().captionsBounds).not.toBeNull());
    expect(useConfigStore.getState().captionsBounds).toMatchObject({ width: 1000, x: 256 });
    expect(windowCalls.some((c) => c.startsWith("setSize([1000,"))).toBe(true);
  });

  it("shows the other side's words as they come, and the translation of each clause under them", async () => {
    await open();
    say("a", "Thanks for making");
    expect(cueTexts()).toEqual(["Thanks for making"]);
    expect(document.querySelector("[data-pending]")?.textContent).toContain("Thanks for making");

    say("a", "Thanks for making the time today. I run");
    translate("a", "Thanks for making the time today.", "感谢你今天抽出时间。", {
      chunks: [{ src: "Thanks for making the time today.", dst: "感谢你今天抽出时间。" }],
    });
    expect(cueTexts()).toEqual(["Thanks for making the time today.感谢你今天抽出时间。", "I run"]);
    // The older caption is dimmed.
    expect(document.querySelector('[data-cue-id="a#0"]')!.hasAttribute("data-old")).toBe(true);
  });

  it("aligns a whole-line translation without chunks by sentences", async () => {
    await open();
    const text = "Thanks for making the time today. I'd like to hear about the billing migration you led.";
    say("a", text, true);
    translate("a", text, "感谢你今天抽出时间。想听听你主导的那次计费迁移。", { provider: "llm", is_final: true });
    expect(cueTexts()).toEqual([
      "Thanks for making the time today.感谢你今天抽出时间。",
      "I'd like to hear about the billing migration you led.想听听你主导的那次计费迁移。",
    ]);
  });

  it("leaves out the user's own words unless both parties are shown, then marks who spoke", async () => {
    await open();
    say("t", "What was the hardest part?", true);
    say("u", "Keeping both systems consistent.", true, "User");
    expect(cueTexts()).toEqual(["What was the hardest part?"]);

    act(() => useConfigStore.setState({ captionsParties: "both" }));
    expect(cueTexts()).toEqual(["ThemWhat was the hardest part?", "YouKeeping both systems consistent."]);
    expect(document.querySelector('[data-party="you"]')).not.toBeNull();
  });

  it("shows only the translation when asked, with dots while it hasn't come", async () => {
    savedSettings({ captionsShow: "translation" });
    await open();
    say("a", "Thanks for making");
    expect(cueTexts()).toEqual(["…"]);
    say("a", "Thanks for making the time today.");
    translate("a", "Thanks for making the time today.", "感谢你今天抽出时间。", {
      chunks: [{ src: "Thanks for making the time today.", dst: "感谢你今天抽出时间。" }],
    });
    expect(cueTexts()).toEqual(["感谢你今天抽出时间。"]);
    expect(document.querySelector('[data-part="src"]')).toBeNull();
  });

  it("shows at most the set number of captions", async () => {
    savedSettings({ captionsCueCount: 1 });
    await open();
    say("a", "First line here, long enough to stand alone.", true);
    say("b", "Second line.", true);
    expect(cueTexts()).toEqual(["Second line."]);
  });

  it("shows A, B, A on a 1-cue both-party strip when A continues on the original segment after B interjects", async () => {
    savedSettings({ captionsParties: "both", captionsCueCount: 1 });
    await open();
    say("a1", "We need to talk about the latency budget.", true, "Them");
    expect(cueTexts()).toEqual(["ThemWe need to talk about the latency budget."]);

    say("b1", "Sure, go ahead.", true, "User");
    expect(cueTexts()).toEqual(["YouSure, go ahead."]);

    say("a1", "We need to talk about the latency budget. Specifically the p99 spike.", false, "Them");
    expect(cueTexts()).toEqual(["ThemSpecifically the p99 spike."]);
  });

  it("draws a backdrop with the set opacity, none at 0", async () => {
    savedSettings({ captionsBgOpacity: 0.5 });
    await open();
    say("a", "Hello there.");
    const cue = () => document.querySelector<HTMLElement>(".caption-cue")!;
    expect(cue().style.background).toContain("0.5");
    act(() => useConfigStore.setState({ captionsBgOpacity: 0 }));
    expect(cue().style.background).not.toContain("rgb");
    expect(cue().style.textShadow).not.toBe("");
  });

  it("fades out after the set seconds without anything new, and comes back with new words", async () => {
    savedSettings({ captionsFadeSeconds: 2 });
    await open();
    vi.useFakeTimers();
    say("a", "Hello there.");
    const layer = () => document.querySelector<HTMLElement>(".caption-strip-fade")!;
    expect(layer().style.opacity).toBe("1");
    act(() => void vi.advanceTimersByTime(2100));
    expect(layer().style.opacity).toBe("0");
    say("a", "Hello there. Again");
    expect(layer().style.opacity).toBe("1");
  });

  it("shows its controls on hover; they change the text size and backdrop, lock and close", async () => {
    await open();
    expect(screen.getByRole("toolbar").style.opacity).toBe("0");
    fireEvent.pointerEnter(document.querySelector("[data-captions-root]")!);
    expect(screen.getByRole("toolbar").style.opacity).toBe("1");

    fireEvent.click(screen.getByRole("button", { name: "Larger text" }));
    expect(useConfigStore.getState().captionsFontSize).toBe(22);
    expect(useConfigStore.getState().captionsTranslationFontSize).toBe(22);
    fireEvent.change(screen.getByRole("slider", { name: "Backdrop" }), { target: { value: "0.6" } });
    expect(useConfigStore.getState().captionsBgOpacity).toBe(0.6);
    expect(screen.getByRole("button", { name: /Lock/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide the caption strip" })).toBeInTheDocument();
  });

  it("when locked, lets the mouse through and shows no controls", async () => {
    savedSettings({ captionsLocked: true });
    await open();
    await vi.waitFor(() => expect(windowCalls).toContain("setIgnoreCursorEvents(true)"));
    fireEvent.pointerEnter(document.querySelector("[data-captions-root]")!);
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(document.querySelector("[data-resize-edge]")).toBeNull();
  });

  it("is dragged by its body, not by its controls", async () => {
    await open();
    const root = document.querySelector("[data-captions-root]")!;
    fireEvent.pointerDown(root, { button: 0 });
    await vi.waitFor(() => expect(windowCalls).toContain("startDragging"));
    windowCalls.length = 0;
    fireEvent.pointerEnter(root);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Larger text" }), { button: 0 });
    await Promise.resolve();
    expect(windowCalls).not.toContain("startDragging");
  });

  it("says where it is for a few seconds when it comes up with nothing said yet", async () => {
    await open();
    await vi.waitFor(() => expect(listeners.get("nexq:captions_visibility")?.size ?? 0).toBeGreaterThan(0));
    expect(screen.queryByTestId("captions-waiting")).toBeNull();
    vi.useFakeTimers();
    emit("nexq:captions_visibility", { visible: true });
    expect(screen.getByTestId("captions-waiting")).toHaveTextContent("What the other side says will show here");
    act(() => void vi.advanceTimersByTime(8100));
    expect(screen.queryByTestId("captions-waiting")).toBeNull();
    // A new meeting brings it back; the first words replace it.
    emit("nexq:meeting_started", {});
    expect(screen.getByTestId("captions-waiting")).toBeInTheDocument();
    say("a", "Hello there.");
    expect(screen.queryByTestId("captions-waiting")).toBeNull();
  });

  it("starts empty with a new meeting", async () => {
    await open();
    say("a", "Hello there.");
    emit("nexq:meeting_started", {});
    expect(cueTexts()).toEqual([]);
  });

  it("follows the UI language", async () => {
    await changeUiLanguage("zh-CN");
    await open();
    fireEvent.pointerEnter(document.querySelector("[data-captions-root]")!);
    expect(screen.getByText("字幕会显示在这里。拖动可以移动，拖边缘可以改大小。")).toBeInTheDocument();
  });

  it("centers captions horizontally and centers the empty hover hint", async () => {
    await open();
    const stack = document.querySelector<HTMLElement>(".caption-stack")!;
    expect(stack.className).toContain("items-center");

    fireEvent.pointerEnter(document.querySelector("[data-captions-root]")!);
    const emptyHint = screen.getByText("Captions will show here. Drag to move it, drag an edge to resize.");
    expect(emptyHint.className).toContain("justify-center");
    expect(emptyHint.className).toContain("text-center");

    say("a", "Hello there.");
    const cue = document.querySelector<HTMLElement>(".caption-cue")!;
    expect(cue.className).toContain("text-center");
  });

  it("does not mount the outer transparent frame or side grips when unhovered, and removes them on leave", async () => {
    await open();
    const root = document.querySelector("[data-captions-root]")!;

    expect(screen.queryByTestId("captions-frame")).toBeNull();
    expect(screen.queryByTestId("resize-grip-w")).toBeNull();
    expect(screen.queryByTestId("resize-grip-e")).toBeNull();

    fireEvent.pointerEnter(root);
    expect(screen.getByTestId("captions-frame")).toBeInTheDocument();
    expect(screen.getByTestId("resize-grip-w")).toBeInTheDocument();
    expect(screen.getByTestId("resize-grip-e")).toBeInTheDocument();

    fireEvent.pointerLeave(root);
    expect(screen.queryByTestId("captions-frame")).toBeNull();
    expect(screen.queryByTestId("resize-grip-w")).toBeNull();
    expect(screen.queryByTestId("resize-grip-e")).toBeNull();
    expect(screen.getByRole("toolbar").style.opacity).toBe("0");

    // Also clears on mouseLeave, document mouseleave, and window blur.
    fireEvent.pointerEnter(root);
    expect(screen.getByTestId("captions-frame")).toBeInTheDocument();
    fireEvent.mouseLeave(root);
    expect(screen.queryByTestId("captions-frame")).toBeNull();

    fireEvent.pointerEnter(root);
    expect(screen.getByTestId("captions-frame")).toBeInTheDocument();
    act(() => void document.documentElement.dispatchEvent(new MouseEvent("mouseleave")));
    expect(screen.queryByTestId("captions-frame")).toBeNull();

    fireEvent.pointerEnter(root);
    expect(screen.getByTestId("captions-frame")).toBeInTheDocument();
    act(() => void window.dispatchEvent(new Event("blur")));
    expect(screen.queryByTestId("captions-frame")).toBeNull();
  });

  it("clears the outer transparent frame when the OS cursor leaves even if WKWebView drops pointerleave", async () => {
    pointerMock.physicalRect = { x: 512, y: 1280, width: 2000, height: 458 };
    pointerMock.cursor = { x: 1000, y: 1500 }; // inside the window
    await open();
    vi.useFakeTimers();

    const root = document.querySelector("[data-captions-root]")!;
    fireEvent.pointerEnter(root);
    expect(screen.getByTestId("captions-frame")).toBeInTheDocument();

    // Still inside after several poll ticks → frame stays.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(screen.getByTestId("captions-frame")).toBeInTheDocument();

    // Cursor moves outside with no DOM pointerleave → poll catches it and removes the frame.
    pointerMock.cursor = { x: 10, y: 10 };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(screen.queryByTestId("captions-frame")).toBeNull();
    expect(screen.getByRole("toolbar").style.opacity).toBe("0");
  });

  it("does not bring the outer frame back stuck after locking/unlocking or hiding/showing while hovered", async () => {
    await open();
    await vi.waitFor(() => expect(listeners.get("nexq:captions_visibility")?.size ?? 0).toBeGreaterThan(0));
    const root = document.querySelector("[data-captions-root]")!;

    // Hover then lock (e.g. from the strip or overlay), then unlock later while pointer is away.
    fireEvent.pointerEnter(root);
    expect(screen.getByTestId("captions-frame")).toBeInTheDocument();
    act(() => useConfigStore.setState({ captionsLocked: true }));
    expect(screen.queryByTestId("captions-frame")).toBeNull();
    act(() => useConfigStore.setState({ captionsLocked: false }));
    expect(screen.queryByTestId("captions-frame")).toBeNull();

    // Hover then hide and re-show via visibility event.
    fireEvent.pointerEnter(root);
    expect(screen.getByTestId("captions-frame")).toBeInTheDocument();
    emit("nexq:captions_visibility", { visible: false });
    expect(screen.queryByTestId("captions-frame")).toBeNull();
    emit("nexq:captions_visibility", { visible: true });
    expect(screen.queryByTestId("captions-frame")).toBeNull();
  });

  it("keeps the outer frame during a resize drag and removes it once released outside", async () => {
    await open();
    const root = document.querySelector("[data-captions-root]")!;
    const eastEdge = document.querySelector<HTMLElement>('[data-resize-edge="e"]')!;
    eastEdge.setPointerCapture = vi.fn();
    eastEdge.hasPointerCapture = () => false;
    eastEdge.releasePointerCapture = vi.fn();

    fireEvent.pointerEnter(root);
    expect(screen.getByTestId("captions-frame")).toBeInTheDocument();

    fireEvent.pointerDown(eastEdge, { button: 0, pointerId: 1 });
    fireEvent.pointerLeave(root);
    expect(screen.getByTestId("captions-frame")).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new MouseEvent("pointerup", { clientX: -20, clientY: 50 }));
    });
    expect(screen.queryByTestId("captions-frame")).toBeNull();
  });

  it("clears the outer frame after body drag if the cursor ends outside the window", async () => {
    pointerMock.physicalRect = { x: 512, y: 1280, width: 2000, height: 458 };
    pointerMock.cursor = { x: 10, y: 10 }; // outside when drag finishes
    await open();
    const root = document.querySelector("[data-captions-root]")!;

    fireEvent.pointerEnter(root);
    expect(screen.getByTestId("captions-frame")).toBeInTheDocument();

    await act(async () => {
      fireEvent.pointerDown(root, { button: 0 });
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
    expect(windowCalls).toContain("startDragging");
    expect(screen.queryByTestId("captions-frame")).toBeNull();
  });
});
