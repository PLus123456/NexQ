// Types of the caption strip: the `captions` window that shows what is being
// said, in short pieces with their translation. The contract is in
// docs/fork/interview-redesign/SPEC.md, sections 3.1 to 3.3.

/**
 * One aligned piece of an engine-side translation (Soniox translates clause
 * by clause): a stretch of the line and the translation of exactly that
 * stretch. `translation_result` events carry them in order (`chunks`).
 */
export interface TranslationChunk {
  /** The source text this piece translates: the final tokens as they came, spaces kept. */
  src: string;
  /** Its translation. */
  dst: string;
}

/** One caption: a short piece of a transcript line and its translation. */
export interface CaptionCue {
  /** `${segmentId}#${n}`, counting up from 0 within a line. */
  id: string;
  src: string;
  dst: string;
  /** Text after this caption that is still being recognised (shown dimmed). */
  srcPending?: string;
  /** Translation after this caption that can still change (shown dimmed). */
  dstPending?: string;
  /** It will not change any more. */
  complete: boolean;
}

/** Where the caption strip was last, and how big. */
export interface CaptionsBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Whose speech the strip shows. */
export type CaptionsParties = "them" | "both";

/** What the strip shows of each caption. */
export type CaptionsShow = "both" | "translation" | "original";

/** The caption strip's settings: the keys of the same names in the config store. */
export interface CaptionsSettings {
  /** Show the strip when a meeting starts. */
  captionsEnabled: boolean;
  captionsParties: CaptionsParties;
  captionsShow: CaptionsShow;
  /** Size of the original text, in px. */
  captionsFontSize: number;
  /** Size of the translation, in px. */
  captionsTranslationFontSize: number;
  captionsTextColor: string;
  captionsTranslationColor: string;
  /** Opacity of the black backdrop, 0 to 0.8; 0 leaves the strip see-through. */
  captionsBgOpacity: number;
  /** Captions shown at once, 1 to 3. */
  captionsCueCount: number;
  /** Seconds without anything new before the strip fades out; 0 never fades. */
  captionsFadeSeconds: number;
  /** The strip lets the mouse through (it can only be unlocked from the answer window). */
  captionsLocked: boolean;
  /** Null until the strip was placed: it then sits at the bottom centre of the screen. */
  captionsBounds: CaptionsBounds | null;
}

export const DEFAULT_CAPTIONS_SETTINGS: CaptionsSettings = {
  captionsEnabled: true,
  captionsParties: "them",
  captionsShow: "both",
  captionsFontSize: 20,
  captionsTranslationFontSize: 20,
  captionsTextColor: "#ffffff",
  captionsTranslationColor: "#ffd34d",
  captionsBgOpacity: 0.35,
  captionsCueCount: 2,
  captionsFadeSeconds: 8,
  captionsLocked: false,
  captionsBounds: null,
};
