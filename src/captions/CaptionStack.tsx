import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MutableRefObject } from "react";
import { useT } from "../i18n";
import type { StripCue } from "../lib/captions/feed";
import type { CaptionsSettings } from "../lib/captions/types";
import { isCjkText } from "../lib/captions/align";
import { CUE_GAP, DST_LINE_HEIGHT, SRC_LINE_HEIGHT } from "../lib/captions/layout";
import "./captions.css";

export type CaptionLook = Pick<
  CaptionsSettings,
  | "captionsShow"
  | "captionsFontSize"
  | "captionsTranslationFontSize"
  | "captionsTextColor"
  | "captionsTranslationColor"
  | "captionsBgOpacity"
>;

interface Props {
  cues: StripCue[];
  look: CaptionLook;
  /** Mark each caption with who said it (`captionsParties: "both"`). */
  showParty: boolean;
  /** Keep a translation row under every caption, also before its translation came. */
  reserveTranslation: boolean;
  className?: string;
  style?: CSSProperties;
}

/** How long a caption that left stays on screen while it fades out, ms. */
const LEAVE_MS = 300;
/** How long a new caption takes to fade in, ms (captions.css). */
const ENTER_MS = 300;
/** How long the captions take to slide to their new place, ms. */
const MOVE_MS = 260;

/**
 * Outline for text on any background: a tight dark edge and a soft halo. With
 * a darker backdrop the text needs less of it.
 */
export function textOutline(bgOpacity: number): string {
  if (bgOpacity >= 0.55) return "0 1px 2px rgb(0 0 0 / 0.6)";
  if (bgOpacity >= 0.25) {
    return "0 0 1px rgb(0 0 0 / 0.9), 0 1px 2px rgb(0 0 0 / 0.8), 0 0 6px rgb(0 0 0 / 0.35)";
  }
  return [
    "0 0 1px rgb(0 0 0 / 0.95)",
    "0 0 2px rgb(0 0 0 / 0.9)",
    "0 1px 3px rgb(0 0 0 / 0.85)",
    "0 0 8px rgb(0 0 0 / 0.5)",
  ].join(", ");
}

interface Shown extends StripCue {
  leaving?: boolean;
}

/**
 * Keeps captions that just left for LEAVE_MS so they can fade out. They leave
 * from the top (the oldest), where the stack's bottom anchoring means nothing
 * else moves when they finally go.
 */
function useLeaving(cues: StripCue[]): Shown[] {
  const [, rerender] = useState(0);
  const leaving = useRef(new Map<string, { cue: StripCue; timer: ReturnType<typeof setTimeout> }>());
  const previous = useRef<StripCue[]>([]);

  const ids = new Set(cues.map((c) => c.id));
  // A caption that came back (a line revised) is no longer leaving.
  for (const [id, item] of leaving.current) {
    if (ids.has(id)) {
      clearTimeout(item.timer);
      leaving.current.delete(id);
    }
  }
  const firstKept = previous.current.findIndex((c) => ids.has(c.id));
  const gone = previous.current.filter((c, i) => !ids.has(c.id) && (firstKept < 0 || i < firstKept));
  for (const cue of gone) {
    if (leaving.current.has(cue.id)) continue;
    const timer = setTimeout(() => {
      leaving.current.delete(cue.id);
      rerender((n) => n + 1);
    }, LEAVE_MS);
    leaving.current.set(cue.id, { cue, timer });
  }
  previous.current = cues;

  useEffect(
    () => () => {
      for (const item of leaving.current.values()) clearTimeout(item.timer);
    },
    [],
  );

  const out: Shown[] = [...leaving.current.values()].map(({ cue }) => ({ ...cue, leaving: true }));
  return out.concat(cues);
}

/** The vertical translation an element is drawn with right now (mid-slide). */
function currentShift(el: HTMLElement): number {
  const transform = getComputedStyle(el).transform;
  if (!transform || transform === "none") return 0;
  const match = /matrix(?:3d)?\(([^)]+)\)/.exec(transform);
  if (!match) return 0;
  const values = match[1].split(",").map(Number);
  return values.length === 16 ? values[13] : values[5] ?? 0;
}

/**
 * Captions slide to their new place instead of jumping (FLIP): after each
 * layout, every caption whose place changed is drawn at its old place and
 * moved to the new one.
 */
function useSlide(nodes: MutableRefObject<Map<string, HTMLElement>>) {
  const tops = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const next = new Map<string, number>();
    for (const [id, el] of nodes.current) {
      const top = el.offsetTop;
      next.set(id, top);
      const before = tops.current.get(id);
      if (before === undefined || before === top || reduce || typeof el.animate !== "function") continue;
      // Mid-slide, it starts from where it is drawn now.
      const running = el.getAnimations?.().filter((a) => a.id === "caption-slide") ?? [];
      const from = before + currentShift(el) - top;
      running.forEach((a) => a.cancel());
      const slide = el.animate([{ transform: `translateY(${from}px)` }, { transform: "translateY(0)" }], {
        duration: MOVE_MS,
        easing: "cubic-bezier(0.2, 0.7, 0.2, 1)",
      });
      slide.id = "caption-slide";
    }
    tops.current = next;
  });
}

/**
 * The captions, newest at the bottom: each the original and/or its
 * translation (`captionsShow`), at most two lines each, the part still being
 * recognised or translated dimmed. Older captions are dimmed too.
 */
export function CaptionStack({ cues, look, showParty, reserveTranslation, className, style }: Props) {
  const { t } = useT("captions");
  const shown = useLeaving(cues);
  const nodes = useRef(new Map<string, HTMLElement>());
  // When each caption first showed: it fades in during its first moments.
  const firstSeen = useRef(new Map<string, number>());
  const now = Date.now();
  for (const cue of cues) if (!firstSeen.current.has(cue.id)) firstSeen.current.set(cue.id, now);
  if (firstSeen.current.size > 200) {
    for (const id of [...firstSeen.current.keys()].slice(0, 100)) firstSeen.current.delete(id);
  }
  useSlide(nodes);

  const showSrc = look.captionsShow !== "translation";
  const showDst = look.captionsShow !== "original";
  const shadow = textOutline(look.captionsBgOpacity);
  const newestId = cues.length > 0 ? cues[cues.length - 1].id : null;

  return (
    <div className={`caption-stack items-center ${className ?? ""}`} style={{ gap: CUE_GAP, ...style }} aria-live="polite">
      {shown.map((cue) => {
        const old = cue.id !== newestId;
        const srcGlue = cue.src && cue.srcPending && !isCjkText(cue.src) ? " " : "";
        const dstGlue = cue.dst && cue.dstPending && !isCjkText(cue.dst) ? " " : "";
        const hasSrc = !!(cue.src || cue.srcPending);
        const hasDst = !!(cue.dst || cue.dstPending);
        // Translation only, and none yet: three dots say something is being said.
        const waiting = !showSrc && !hasDst && hasSrc;
        if (!showSrc && !hasDst && !waiting) return null;
        return (
          <div
            key={cue.id}
            ref={(el) => {
              if (el) nodes.current.set(cue.id, el);
              else nodes.current.delete(cue.id);
            }}
            className="caption-cue text-center"
            data-cue-id={cue.id}
            data-old={old || undefined}
            data-leaving={cue.leaving || undefined}
            data-entering={!cue.leaving && now - (firstSeen.current.get(cue.id) ?? 0) < ENTER_MS ? "" : undefined}
            style={{
              opacity: old ? 0.62 : 1,
              background: look.captionsBgOpacity > 0 ? `rgb(0 0 0 / ${look.captionsBgOpacity})` : "transparent",
              borderRadius: "0.4em",
              padding: look.captionsBgOpacity > 0 ? "0.12em 0.55em 0.16em" : "0 0.1em",
              textShadow: shadow,
              fontWeight: 600,
              letterSpacing: "0.005em",
            }}
          >
            {showSrc && (
              <div
                className="caption-text"
                data-part="src"
                data-reserved={!hasSrc || undefined}
                style={{
                  fontSize: look.captionsFontSize,
                  color: look.captionsTextColor,
                  ["--caption-line-height" as string]: `${SRC_LINE_HEIGHT}em`,
                }}
              >
                <span>
                  {showParty && <PartyMark party={cue.party} label={t(cue.party === "you" ? "strip.you" : "strip.them")} />}
                  {cue.src}
                  {cue.srcPending && (
                    <span data-pending style={{ color: dim(look.captionsTextColor) }}>
                      {srcGlue}
                      {cue.srcPending}
                    </span>
                  )}
                </span>
              </div>
            )}
            {showDst && (hasDst || reserveTranslation || waiting) && (
              <div
                className="caption-text"
                data-part="dst"
                data-reserved={!hasDst || undefined}
                style={{
                  fontSize: look.captionsTranslationFontSize,
                  color: look.captionsTranslationColor,
                  ["--caption-line-height" as string]: `${DST_LINE_HEIGHT}em`,
                }}
              >
                <span>
                  {!showSrc && showParty && (
                    <PartyMark party={cue.party} label={t(cue.party === "you" ? "strip.you" : "strip.them")} />
                  )}
                  {cue.dst}
                  {cue.dstPending && (
                    <span data-pending style={{ color: dim(look.captionsTranslationColor) }}>
                      {dstGlue}
                      {cue.dstPending}
                    </span>
                  )}
                  {waiting && <span data-pending style={{ color: dim(look.captionsTranslationColor) }}>…</span>}
                </span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The colour of text still being recognised or translated: the same hue,
 * greyer. Opaque, so with its outline it stays readable on a light picture.
 */
function dim(color: string): string {
  return `color-mix(in srgb, ${color} 55%, #7c7c7c)`;
}

function PartyMark({ party, label }: { party: "them" | "you"; label: string }) {
  return (
    <span
      data-party={party}
      style={{
        display: "inline-block",
        verticalAlign: "0.12em",
        marginRight: "0.45em",
        padding: "0 0.4em",
        borderRadius: "0.3em",
        fontSize: "0.6em",
        lineHeight: 1.5,
        fontWeight: 600,
        textShadow: "none",
        color: party === "you" ? "#0b1220" : "#ffffff",
        background: party === "you" ? "rgb(125 211 252 / 0.9)" : "rgb(255 255 255 / 0.22)",
      }}
    >
      {label}
    </span>
  );
}
