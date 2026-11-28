import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { Lock, Minus, Plus, X } from "lucide-react";
import { useT } from "../i18n";
import { loadCaptionsSettings, useConfigStore } from "../stores/configStore";
import { stripCues } from "../lib/captions/feed";
import { CONTROLS_ROOM, MIN_STRIP, STRIP_PADDING, clampCaptionsSettings, recommendedHeight, sameBounds } from "../lib/captions/layout";
import { followCaptionsBounds, isCursorInsideWindow, placeCaptionsWindow, setCaptionsHeight } from "../lib/captions/placement";
import { CAPTIONS_VISIBILITY_EVENT, hideCaptions, setCaptionsLocked } from "../lib/captions/window";
import type { CaptionsSettings } from "../lib/captions/types";
import type { ResizeEdge } from "../lib/resizeRect";
import { useWindowResizeDrag } from "../hooks/useWindowResizeDrag";
import { CaptionStack } from "./CaptionStack";
import { useCaptionFeed } from "./useCaptionFeed";

const FONT_STEP = 2;

/** The caption settings of the config store. */
function useCaptionsSettings(): CaptionsSettings {
  return useConfigStore(
    useShallow((s) => ({
      captionsEnabled: s.captionsEnabled,
      captionsParties: s.captionsParties,
      captionsShow: s.captionsShow,
      captionsFontSize: s.captionsFontSize,
      captionsTranslationFontSize: s.captionsTranslationFontSize,
      captionsTextColor: s.captionsTextColor,
      captionsTranslationColor: s.captionsTranslationColor,
      captionsBgOpacity: s.captionsBgOpacity,
      captionsCueCount: s.captionsCueCount,
      captionsFadeSeconds: s.captionsFadeSeconds,
      captionsLocked: s.captionsLocked,
      captionsBounds: s.captionsBounds,
    })),
  );
}

/**
 * Loads the caption settings (the light way, SPEC 3.2), puts the window at
 * its saved place and records where the user moves it. Resolves `ready` once
 * the settings are in.
 */
function useCaptionsWindowSetup(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let mounted = true;
    const stops: Array<() => void> = [];
    const keep = (stop: () => void) => (mounted ? stops.push(stop) : stop());
    const place = async () => {
      const s = clampCaptionsSettings(useConfigStore.getState());
      const placed = await placeCaptionsWindow(s.captionsBounds, recommendedHeight(s));
      if (placed && !sameBounds(placed, useConfigStore.getState().captionsBounds)) {
        useConfigStore.getState().setCaptionsBounds(placed);
      }
    };
    void (async () => {
      try {
        keep(await loadCaptionsSettings());
      } catch (err) {
        console.warn("[captions] Could not load the caption settings:", err);
      }
      if (!mounted) return;
      setReady(true);
      await place();
      keep(await followCaptionsBounds((bounds) => {
        if (!sameBounds(bounds, useConfigStore.getState().captionsBounds)) useConfigStore.getState().setCaptionsBounds(bounds);
      }));
      // "Reset place" in Settings clears the bounds: back to the default place.
      keep(useConfigStore.subscribe((now, before) => {
        if (now.captionsBounds === null && before.captionsBounds !== null) void place();
      }));
      // A strip shown again goes back on screen if its screen is gone.
      try {
        const { listen } = await import("@tauri-apps/api/event");
        keep(await listen<{ visible: boolean }>(CAPTIONS_VISIBILITY_EVENT, (e) => {
          if (e.payload?.visible) void place();
        }));
      } catch {
        // No events (tests): nothing to follow.
      }
    })();
    return () => {
      mounted = false;
      stops.forEach((stop) => stop());
    };
  }, []);
  return ready;
}

/** The window lets the mouse through while locked; applied here too, so it holds after a restart. */
function useLockApplied(ready: boolean, locked: boolean) {
  useEffect(() => {
    if (!ready) return;
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().setIgnoreCursorEvents(locked))
      .catch((err) => console.warn("[captions] Could not apply the lock:", err));
  }, [ready, locked]);
}

/** When text size, caption count or what is shown change, the window takes the height that fits. */
function useHeightFollowsLook(ready: boolean, s: CaptionsSettings) {
  const height = recommendedHeight(s);
  const first = useRef<number | null>(null);
  useEffect(() => {
    if (!ready) return;
    if (first.current === null) {
      first.current = height;
      return;
    }
    if (first.current === height) return;
    first.current = height;
    void setCaptionsHeight(height);
  }, [ready, height]);
}

/** How long the strip says where it is after it comes up, while nothing has been said. */
const SHOWN_HINT_MS = 8000;

/**
 * True for a few seconds after the strip is shown or a meeting starts. With
 * nothing said yet the strip is fully see-through, so without this hint it
 * looks as if it never came up.
 */
function useShownHint(): boolean {
  const [hint, setHint] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let mounted = true;
    const stops: Array<() => void> = [];
    const flash = () => {
      if (!mounted) return;
      setHint(true);
      clearTimeout(timer);
      timer = setTimeout(() => setHint(false), SHOWN_HINT_MS);
    };
    void import("@tauri-apps/api/event")
      .then(async ({ listen }) => {
        const stopShown = await listen<{ visible: boolean }>(CAPTIONS_VISIBILITY_EVENT, (e) => {
          if (e.payload?.visible) flash();
        });
        const stopMeeting = await listen("nexq:meeting_started", flash);
        if (mounted) stops.push(stopShown, stopMeeting);
        else {
          stopShown();
          stopMeeting();
        }
      })
      .catch(() => {});
    return () => {
      mounted = false;
      clearTimeout(timer);
      stops.forEach((stop) => stop());
    };
  }, []);
  return hint;
}

/** True for `seconds` after `signature` last changed; always true when `seconds` is 0. */
function useRecentlyChanged(signature: string, seconds: number): boolean {
  const [recent, setRecent] = useState(false);
  useEffect(() => {
    if (!signature) {
      setRecent(false);
      return;
    }
    setRecent(true);
    if (seconds <= 0) return;
    const timer = setTimeout(() => setRecent(false), seconds * 1000);
    return () => clearTimeout(timer);
  }, [signature, seconds]);
  return recent;
}

/** How often to verify the pointer is still over the strip while chrome is up, ms. */
const HOVER_CHECK_MS = 120;

/**
 * Tracks whether the pointer is over the caption strip.
 *
 * On macOS transparent non-focusable windows (`focusable: false`), WKWebView
 * frequently drops `pointerleave` (fast exits, after `startDragging()`, after
 * resize drags, or when hidden/locked while hovered). While hovered we also
 * watch document/window leave events, reset on lock or visibility changes, and
 * verify against the OS cursor bounds so the outer frame never lingers once
 * the pointer has left.
 */
function useWindowHover(interactive: boolean) {
  const [hovered, setHovered] = useState(false);
  const draggingControl = useRef<"resize" | "range" | null>(null);

  // Locking stops cursor events from reaching the window: clear hover now so
  // unlocking later doesn't bring the frame back while the mouse is elsewhere.
  useEffect(() => {
    if (!interactive) {
      draggingControl.current = null;
      setHovered(false);
    }
  }, [interactive]);

  // Hiding or re-showing the strip (e.g. clicking Close while hovered) never
  // fires `pointerleave`: start every show unhovered.
  useEffect(() => {
    let mounted = true;
    let stop: (() => void) | undefined;
    void import("@tauri-apps/api/event")
      .then(async ({ listen }) => {
        const unlisten = await listen<{ visible: boolean }>(CAPTIONS_VISIBILITY_EVENT, () => {
          if (!mounted) return;
          draggingControl.current = null;
          setHovered(false);
        });
        if (mounted) stop = unlisten;
        else unlisten();
      })
      .catch(() => {});
    return () => {
      mounted = false;
      stop?.();
    };
  }, []);

  // While hovered: catch missed leave events via document/window listeners and
  // verify the OS pointer is still inside the window bounds.
  useEffect(() => {
    if (!hovered || !interactive) return;
    let cancelled = false;
    let checking = false;

    const verifyCursor = () => {
      if (cancelled || checking || draggingControl.current === "resize") return;
      checking = true;
      void isCursorInsideWindow()
        .then((inside) => {
          if (!cancelled && draggingControl.current !== "resize" && inside === false) {
            draggingControl.current = null;
            setHovered(false);
          }
        })
        .finally(() => {
          checking = false;
        });
    };

    const clearIfNotDragging = (event: MouseEvent) => {
      if (event.buttons === 0 && draggingControl.current === "range") draggingControl.current = null;
      if (!draggingControl.current) setHovered(false);
    };
    const clear = () => {
      draggingControl.current = null;
      setHovered(false);
    };
    const onVisibilityChange = () => {
      if (document.hidden) clear();
    };
    const onPointerRelease = (e: PointerEvent) => {
      if (!draggingControl.current) return;
      draggingControl.current = null;
      const insideViewport =
        e.clientX >= 0 && e.clientY >= 0 && e.clientX <= window.innerWidth && e.clientY <= window.innerHeight;
      if (!insideViewport) {
        setHovered(false);
      } else {
        verifyCursor();
      }
    };

    const docEl = document.documentElement;
    docEl.addEventListener("mouseleave", clearIfNotDragging);
    docEl.addEventListener("pointerleave", clearIfNotDragging);
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pointerup", onPointerRelease, true);
    window.addEventListener("pointercancel", onPointerRelease, true);
    window.addEventListener("lostpointercapture", onPointerRelease, true);

    const timer = setInterval(verifyCursor, HOVER_CHECK_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      docEl.removeEventListener("mouseleave", clearIfNotDragging);
      docEl.removeEventListener("pointerleave", clearIfNotDragging);
      window.removeEventListener("blur", clear);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pointerup", onPointerRelease, true);
      window.removeEventListener("pointercancel", onPointerRelease, true);
      window.removeEventListener("lostpointercapture", onPointerRelease, true);
    };
  }, [hovered, interactive]);

  const onPointerEnter = useCallback(() => {
    if (interactive) setHovered(true);
  }, [interactive]);

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!interactive) return;
      if (e.buttons === 0) draggingControl.current = null;
      const inside =
        e.clientX >= 0 && e.clientY >= 0 && e.clientX <= window.innerWidth && e.clientY <= window.innerHeight;
      if (inside) {
        setHovered(true);
      } else if (!draggingControl.current && e.buttons === 0) {
        setHovered(false);
      }
    },
    [interactive],
  );

  const onLeave = useCallback(() => {
    if (!draggingControl.current) setHovered(false);
  }, []);

  const onPointerDownCapture = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest("[data-resize-edge]")) draggingControl.current = "resize";
    else if (target?.closest('input[type="range"]')) draggingControl.current = "range";
  }, []);

  const clearHover = useCallback(() => {
    draggingControl.current = null;
    setHovered(false);
  }, []);

  return {
    hovered: hovered && interactive,
    clearHover,
    handlers: {
      onPointerEnter,
      onPointerMove,
      onPointerLeave: onLeave,
      onMouseLeave: onLeave,
      onPointerDownCapture,
    },
  };
}

/**
 * The `captions` window: the caption strip floating over the meeting. It
 * shows what the other side says (or both sides), each caption the original
 * with its translation underneath, on a see-through window. Hovering shows a
 * row of small controls; the body drags the window, the edges resize it.
 */
export function CaptionsWindow() {
  const { t } = useT("captions");
  const ready = useCaptionsWindowSetup();
  const raw = useCaptionsSettings();
  const s = useMemo(() => clampCaptionsSettings(raw), [raw]);
  const feed = useCaptionFeed();
  const shownHint = useShownHint();
  useLockApplied(ready, s.captionsLocked);
  useHeightFollowsLook(ready, s);

  const cues = useMemo(() => stripCues(feed, s.captionsParties, s.captionsCueCount), [feed, s.captionsParties, s.captionsCueCount]);
  const signature = cues.map((c) => `${c.id}:${c.src.length}:${c.dst.length}:${c.srcPending?.length ?? 0}`).join("|");
  const fresh = useRecentlyChanged(signature, s.captionsFadeSeconds);
  const interactive = !s.captionsLocked;
  const { hovered: showChrome, clearHover, handlers: hoverHandlers } = useWindowHover(interactive);
  const visible = fresh || showChrome;

  const startDrag = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest("[data-no-drag]")) return;
      void import("@tauri-apps/api/window")
        .then(({ getCurrentWindow }) => getCurrentWindow().startDragging())
        .then(() => isCursorInsideWindow())
        .then((inside) => {
          if (inside === false) clearHover();
        })
        .catch(() => {});
    },
    [clearHover],
  );

  return (
    <div
      className="no-select relative h-full w-full overflow-hidden bg-transparent"
      data-captions-root
      data-hovered={showChrome || undefined}
      {...hoverHandlers}
      onPointerDown={interactive ? startDrag : undefined}
      style={{ cursor: showChrome ? "grab" : "default" }}
    >
      {/* Only mounted while the mouse is over the strip so no outer frame exists otherwise. */}
      {showChrome && (
        <div
          aria-hidden="true"
          data-testid="captions-frame"
          className="caption-chrome-frame pointer-events-none absolute inset-[1px] rounded-[10px]"
          style={{
            border: "1px solid rgb(255 255 255 / 0.28)",
            background: "rgb(0 0 0 / 0.12)",
            boxShadow: "inset 0 0 0 1px rgb(0 0 0 / 0.25)",
          }}
        />
      )}

      <div className="caption-strip-fade absolute inset-0" data-shown={visible ? "true" : "false"} style={{ opacity: visible ? 1 : 0 }}>
        <CaptionStack
          cues={cues}
          look={s}
          showParty={s.captionsParties === "both"}
          reserveTranslation={feed.translationSeen}
          className="absolute inset-x-0 bottom-0"
          style={{ top: CONTROLS_ROOM, padding: `0 ${STRIP_PADDING + 4}px ${STRIP_PADDING}px` }}
        />
      </div>

      {!showChrome && shownHint && cues.length === 0 && (
        <div
          data-testid="captions-waiting"
          className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-center pb-3"
          style={{ top: CONTROLS_ROOM }}
        >
          <span className="rounded-lg px-3 py-1.5 text-[13px] text-white/90" style={{ background: "rgb(0 0 0 / 0.55)" }}>
            {t(s.captionsParties === "both" ? "strip.waitingBoth" : "strip.waitingThem")}
          </span>
        </div>
      )}

      {showChrome && cues.length === 0 && (
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-center px-4 pb-3 text-center text-[13px] text-white/80"
          style={{ top: CONTROLS_ROOM, textShadow: "0 1px 2px rgb(0 0 0 / 0.9)" }}
        >
          {t("strip.empty")}
        </div>
      )}

      {interactive && (
        <StripControls
          shown={showChrome}
          settings={s}
          onLock={() => {
            clearHover();
            void setCaptionsLocked(true);
          }}
          onClose={() => {
            clearHover();
            void hideCaptions();
          }}
        />
      )}
      {interactive && <ResizeHandles shown={showChrome} />}
    </div>
  );
}

function StripControls({
  shown,
  settings,
  onLock,
  onClose,
}: {
  shown: boolean;
  settings: CaptionsSettings;
  onLock: () => void;
  onClose: () => void;
}) {
  const { t } = useT("captions");
  const store = useConfigStore.getState;
  const resize = (step: number) => {
    const clamp = (v: number) => Math.min(48, Math.max(12, v + step));
    store().setCaptionsFontSize(clamp(settings.captionsFontSize));
    store().setCaptionsTranslationFontSize(clamp(settings.captionsTranslationFontSize));
  };
  const button = "flex h-6 w-6 items-center justify-center rounded-md text-white/85 hover:bg-white/15 hover:text-white focus-visible:outline focus-visible:outline-1 focus-visible:outline-white/60";
  return (
    <div
      role="toolbar"
      aria-label={t("strip.controls.label")}
      data-no-drag
      className="caption-controls absolute right-2 top-1 flex items-center gap-0.5 rounded-lg px-1 py-0.5"
      style={{
        opacity: shown ? 1 : 0,
        pointerEvents: shown ? "auto" : "none",
        background: "rgb(24 24 27 / 0.82)",
        boxShadow: "0 1px 3px rgb(0 0 0 / 0.4)",
        cursor: "default",
      }}
    >
      <button type="button" className={button} title={t("strip.controls.smaller")} aria-label={t("strip.controls.smaller")} onClick={() => resize(-FONT_STEP)}>
        <Minus className="h-3.5 w-3.5" />
      </button>
      <span className="px-0.5 text-[11px] font-semibold tabular-nums text-white/70" aria-hidden="true">
        A
      </span>
      <button type="button" className={button} title={t("strip.controls.larger")} aria-label={t("strip.controls.larger")} onClick={() => resize(FONT_STEP)}>
        <Plus className="h-3.5 w-3.5" />
      </button>
      <span className="mx-1 h-4 w-px bg-white/20" aria-hidden="true" />
      <label className="flex items-center gap-1 px-1" title={t("strip.controls.backdrop")}>
        <span
          aria-hidden="true"
          className="h-3 w-3 rounded-sm border border-white/50"
          style={{ background: `rgb(0 0 0 / ${Math.max(0.08, settings.captionsBgOpacity)})` }}
        />
        <input
          type="range"
          min={0}
          max={0.8}
          step={0.05}
          value={settings.captionsBgOpacity}
          aria-label={t("strip.controls.backdrop")}
          onChange={(e) => store().setCaptionsBgOpacity(Number(e.target.value))}
          className="h-1 w-16 cursor-pointer accent-white"
        />
      </label>
      <span className="mx-1 h-4 w-px bg-white/20" aria-hidden="true" />
      <button type="button" className={button} title={t("strip.controls.lock")} aria-label={t("strip.controls.lock")} onClick={onLock}>
        <Lock className="h-3.5 w-3.5" />
      </button>
      <button type="button" className={button} title={t("strip.controls.close")} aria-label={t("strip.controls.close")} onClick={onClose}>
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

const EDGE = 6;
const HANDLES: Array<{ edge: ResizeEdge; className: string; grip?: "x" | "y" }> = [
  { edge: "w", className: "left-0 top-3 bottom-3", grip: "x" },
  { edge: "e", className: "right-0 top-3 bottom-3", grip: "x" },
  { edge: "n", className: "top-0 left-3 right-3" },
  { edge: "s", className: "bottom-0 left-3 right-3" },
  { edge: "nw", className: "left-0 top-0" },
  { edge: "ne", className: "right-0 top-0" },
  { edge: "sw", className: "left-0 bottom-0" },
  { edge: "se", className: "right-0 bottom-0" },
];

const CURSORS: Record<ResizeEdge, string> = {
  n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize",
  ne: "nesw-resize", sw: "nesw-resize", nw: "nwse-resize", se: "nwse-resize",
};

function ResizeHandles({ shown }: { shown: boolean }) {
  return (
    <>
      {HANDLES.map((h) => (
        <ResizeHandle key={h.edge} edge={h.edge} className={h.className} grip={h.grip} shown={shown} />
      ))}
    </>
  );
}

function ResizeHandle({ edge, className, grip, shown }: { edge: ResizeEdge; className: string; grip?: "x" | "y"; shown: boolean }) {
  const handlers = useWindowResizeDrag(edge, MIN_STRIP);
  const corner = edge.length === 2;
  const vertical = edge === "e" || edge === "w";
  return (
    <div
      aria-hidden="true"
      data-no-drag
      data-resize-edge={edge}
      className={`absolute z-10 flex items-center justify-center ${className}`}
      style={{
        width: corner ? 12 : vertical ? EDGE : undefined,
        height: corner ? 12 : vertical ? undefined : EDGE,
        cursor: CURSORS[edge],
        touchAction: "none",
      }}
      {...handlers}
    >
      {grip && shown && (
        <span
          data-testid={`resize-grip-${edge}`}
          className="caption-chrome-frame block rounded-full"
          style={{ width: 3, height: 26, background: "rgb(255 255 255 / 0.55)" }}
        />
      )}
    </div>
  );
}
