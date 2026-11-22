// What the caption window keeps of the meeting: the last few transcript lines
// and their translations, in memory only (SPEC 3.2), and the captions shown
// from them. Pure functions over an immutable state, fed by the window's own
// `transcript_update` / `transcript_final` / `translation_result` listeners.

import type { TranscriptSegment, TranslationResult } from "../types";
import type { CaptionCue, CaptionsParties } from "./types";
import { DEFAULT_CUE_OPTIONS, buildCues, type CueOptions } from "./cues";

export type CaptionParty = "them" | "you";

export interface CaptionLine {
  id: string;
  party: CaptionParty;
  text: string;
  /** The line ended (`transcript_final`). */
  final: boolean;
}

export interface CaptionFeed {
  /** Oldest first, at most MAX_LINES. */
  lines: CaptionLine[];
  /** Latest translation per line id. */
  translations: Record<string, TranslationResult>;
  /** A translation came this meeting: the strip keeps a row for it under every caption. */
  translationSeen: boolean;
}

/** Lines kept (both parties); enough for three captions of either party. */
export const MAX_LINES = 12;

export const EMPTY_FEED: CaptionFeed = { lines: [], translations: {}, translationSeen: false };

/** The user's own lines come from the microphone ("User"); everything else is the other side. */
export function partyOf(segment: Pick<TranscriptSegment, "speaker">): CaptionParty {
  return segment.speaker === "User" ? "you" : "them";
}

/** A transcript event (update or final) for one line. */
export function feedTranscript(feed: CaptionFeed, segment: TranscriptSegment, final: boolean): CaptionFeed {
  if (!segment?.id || typeof segment.text !== "string") return feed;
  const index = feed.lines.findIndex((l) => l.id === segment.id);
  const before = index >= 0 ? feed.lines[index] : null;
  // Words that come after the line ended extend it: it is growing again.
  const line: CaptionLine = { id: segment.id, party: partyOf(segment), text: segment.text, final };
  if (before && before.text === line.text && before.final === line.final && before.party === line.party) return feed;
  let lines: CaptionLine[];
  if (index >= 0) {
    lines = feed.lines.slice();
    lines[index] = line;
  } else {
    lines = [...feed.lines, line].slice(-MAX_LINES);
  }
  const dropped = feed.lines.length > 0 && lines[0] !== feed.lines[0] && index < 0 ? feed.lines[0].id : null;
  let translations = feed.translations;
  if (dropped && dropped in translations) {
    translations = { ...translations };
    delete translations[dropped];
  }
  return { ...feed, lines, translations };
}

/** A `translation_result`. Results for lines no longer kept (batch re-translations of old lines) are dropped. */
export function feedTranslation(feed: CaptionFeed, result: TranslationResult): CaptionFeed {
  const id = result?.segment_id;
  if (!id) return feed;
  const known = feed.lines.some((l) => l.id === id);
  // A translation can come just before its line's first event reaches this window: keep a few of those.
  const pending = Object.keys(feed.translations).filter((key) => !feed.lines.some((l) => l.id === key));
  if (!known && pending.length >= 4) return { ...feed, translationSeen: true };
  return { ...feed, translations: { ...feed.translations, [id]: result }, translationSeen: true };
}

/** A caption as the strip shows it: which line and party it belongs to. */
export interface StripCue extends CaptionCue {
  lineId: string;
  party: CaptionParty;
}

const cueCache = new WeakMap<CaptionLine, { translation: TranslationResult | undefined; cues: CaptionCue[] }>();

/** The captions of one line (cached while neither the line nor its translation changes). */
export function lineCues(line: CaptionLine, translation: TranslationResult | undefined, options: CueOptions = DEFAULT_CUE_OPTIONS): CaptionCue[] {
  const cached = cueCache.get(line);
  if (cached && cached.translation === translation && options === DEFAULT_CUE_OPTIONS) return cached.cues;
  const cues = buildCues(
    {
      segmentId: line.id,
      text: line.text,
      lineFinal: line.final,
      chunks: translation?.chunks,
      translation: translation?.translated_text,
      translatedSource: translation?.original_text,
      // Before any translation the line can still get one; after, until it says it's final.
      translating: translation ? translation.is_final === false : !line.final,
    },
    options,
  );
  if (options === DEFAULT_CUE_OPTIONS) cueCache.set(line, { translation, cues });
  return cues;
}

/** The newest `count` captions of the parties shown, oldest first. */
export function stripCues(feed: CaptionFeed, parties: CaptionsParties, count: number): StripCue[] {
  const out: StripCue[] = [];
  for (let i = feed.lines.length - 1; i >= 0 && out.length < count; i--) {
    const line = feed.lines[i];
    if (parties === "them" && line.party !== "them") continue;
    const cues = lineCues(line, feed.translations[line.id]);
    for (let c = cues.length - 1; c >= 0 && out.length < count; c--) {
      const cue = cues[c];
      if (!cue.src && !cue.dst && !cue.srcPending && !cue.dstPending) continue;
      out.push({ ...cue, lineId: line.id, party: line.party });
    }
  }
  return out.reverse();
}
