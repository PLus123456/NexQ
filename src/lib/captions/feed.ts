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

interface CueTrack {
  order: number;
  text: string;
}

export interface CaptionFeed {
  /** Oldest first, at most MAX_LINES. */
  lines: CaptionLine[];
  /** Latest translation per line id. */
  translations: Record<string, TranslationResult>;
  /** A translation came this meeting: the strip keeps a row for it under every caption. */
  translationSeen: boolean;
  /** Monotonic counter incremented when a line adds or changes spoken text. */
  seq?: number;
  /** Initial `seq` of each line id, used as fallback order for its cues. */
  lineOrder?: Record<string, number>;
  /** Latest `seq` and spoken text key per cue id (`lineId#n`). */
  cueOrder?: Record<string, CueTrack>;
}

/** Lines kept (both parties); enough for three captions of either party. */
export const MAX_LINES = 12;

export const EMPTY_FEED: CaptionFeed = { lines: [], translations: {}, translationSeen: false };

const isVisibleCue = (cue: CaptionCue) => !!(cue.src || cue.dst || cue.srcPending || cue.dstPending);
const cueSpokenKey = (cue: CaptionCue) => (cue.src + (cue.srcPending ?? "")).replace(/\s+/g, "");

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

  let seq = feed.seq ?? feed.lines.length;
  let lineOrder = feed.lineOrder;
  let cueOrder = feed.cueOrder;

  if (dropped || !before || before.text !== line.text) {
    lineOrder = { ...(lineOrder ?? {}) };
    cueOrder = { ...(cueOrder ?? {}) };
    if (dropped) {
      delete lineOrder[dropped];
      for (const key of Object.keys(cueOrder)) {
        if (key.startsWith(`${dropped}#`)) delete cueOrder[key];
      }
    }
    const cues = lineCues(line, translations[line.id]);
    const validIds = new Set<string>();
    let stepSeq: number | null = null;
    const nextStep = () => (stepSeq ??= ++seq);

    if (!(line.id in lineOrder)) {
      lineOrder[line.id] = nextStep();
    }
    for (const cue of cues) {
      if (!isVisibleCue(cue)) continue;
      validIds.add(cue.id);
      const textKey = cueSpokenKey(cue);
      const prev = cueOrder[cue.id];
      if (!prev || prev.text !== textKey) {
        cueOrder[cue.id] = { order: nextStep(), text: textKey };
      }
    }
    for (const key of Object.keys(cueOrder)) {
      if (key.startsWith(`${line.id}#`) && !validIds.has(key)) delete cueOrder[key];
    }
  }

  return { ...feed, lines, translations, seq, lineOrder, cueOrder };
}

/** A `translation_result`. Results for lines no longer kept (batch re-translations of old lines) are dropped. */
export function feedTranslation(feed: CaptionFeed, result: TranslationResult): CaptionFeed {
  const id = result?.segment_id;
  if (!id) return feed;
  const line = feed.lines.find((l) => l.id === id);
  // A translation can come just before its line's first event reaches this window: keep a few of those.
  const pending = Object.keys(feed.translations).filter((key) => !feed.lines.some((l) => l.id === key));
  if (!line && pending.length >= 4) return { ...feed, translationSeen: true };
  const translations = { ...feed.translations, [id]: result };
  let cueOrder = feed.cueOrder;
  if (line && cueOrder) {
    // Keep cue text keys synced after translation-driven regrouping without advancing recency.
    const nextCueOrder = { ...cueOrder };
    const cues = lineCues(line, result);
    const validIds = new Set<string>();
    let lastOrder = feed.lineOrder?.[line.id] ?? feed.lines.indexOf(line);
    for (const cue of cues) {
      if (!isVisibleCue(cue)) continue;
      validIds.add(cue.id);
      const existing = nextCueOrder[cue.id];
      const order = existing ? existing.order : lastOrder;
      lastOrder = order;
      nextCueOrder[cue.id] = { order, text: cueSpokenKey(cue) };
    }
    for (const key of Object.keys(nextCueOrder)) {
      if (key.startsWith(`${line.id}#`) && !validIds.has(key)) delete nextCueOrder[key];
    }
    cueOrder = nextCueOrder;
  }
  return { ...feed, translations, translationSeen: true, cueOrder };
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
  if (count <= 0) return [];
  const ranked: Array<{ cue: StripCue; order: number; lineIdx: number; cueIdx: number }> = [];
  for (let i = 0; i < feed.lines.length; i++) {
    const line = feed.lines[i];
    if (parties === "them" && line.party !== "them") continue;
    const cues = lineCues(line, feed.translations[line.id]);
    let lastOrder = feed.lineOrder?.[line.id] ?? i;
    for (let c = 0; c < cues.length; c++) {
      const cue = cues[c];
      if (!isVisibleCue(cue)) continue;
      const order = feed.cueOrder?.[cue.id]?.order ?? lastOrder;
      lastOrder = order;
      ranked.push({ cue: { ...cue, lineId: line.id, party: line.party }, order, lineIdx: i, cueIdx: c });
    }
  }
  ranked.sort((a, b) => a.order - b.order || a.lineIdx - b.lineIdx || a.cueIdx - b.cueIdx);
  return ranked.slice(-count).map((r) => r.cue);
}
