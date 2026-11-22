// Cutting one transcript line into captions (SPEC 3.3): short pieces of the
// original, each with the translation of exactly that piece. Pure functions;
// the caption window calls `buildCues` on every update of a line.

import type { CaptionCue, TranslationChunk } from "./types";
import { SENTENCE_END, alignSentences, isCjkText, splitLongSentence, splitSentences } from "./align";

/** One transcript line and what is known of its translation. */
export interface CueLineInput {
  segmentId: string;
  /** The line's text as last reported. */
  text: string;
  /** Words after `text` that are still being recognised, if the caller knows them apart. */
  interim?: string;
  /** The line ended (`transcript_final`): its text will not grow any more. */
  lineFinal: boolean;
  /** Aligned translation pieces (Soniox), in order; absent for whole-line translators. */
  chunks?: TranslationChunk[];
  /** The line's translation so far (`translated_text`). */
  translation?: string;
  /** The original the translation was made of (`original_text`), for whole-line translations. */
  translatedSource?: string;
  /** The translation can still change or grow. */
  translating: boolean;
}

export interface CueOptions {
  /** A sentence end closes a caption once it is this long (characters). */
  minChars: number;
  /** Longest caption in Latin script before it is closed at a piece boundary. */
  maxLatinChars: number;
  /** The same for Chinese, Japanese and Korean. */
  maxCjkChars: number;
  /**
   * A caption this long is closed after the piece that took it there, even
   * without a sentence end, as a share of the longest: the next piece would
   * usually take it past the longest anyway, and closing now (rather than
   * when that piece comes) keeps the words being said where they are.
   */
  softShare: number;
  /** Translation characters per original character, for whole-line alignment (default: measured per line). */
  ratio?: number;
}

export const DEFAULT_CUE_OPTIONS: CueOptions = { minChars: 24, maxLatinChars: 84, maxCjkChars: 30, softShare: 0.55 };

/**
 * A piece that captions are built from: a translation chunk or an aligned
 * sentence pair, or (`pending`) a clause of the original that has no
 * translation yet.
 */
interface Unit {
  src: string;
  dst: string;
  pending?: boolean;
}

interface Group {
  src: string;
  dst: string;
  /** Original after `src` that has no translation yet. */
  pending: string;
  closed: boolean;
}

const len = (s: string) => s.trim().length;

/**
 * Where `prefix` ends in `text`, comparing without whitespace (the engine's
 * pieces and the line can differ in spacing). -1 when `prefix` is not a
 * prefix of `text`.
 */
export function prefixEnd(text: string, prefix: string): number {
  let i = 0;
  for (const ch of prefix) {
    if (/\s/.test(ch)) continue;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length || text[i] !== ch) return -1;
    i++;
  }
  return i;
}

/**
 * Groups units into captions, left to right: a caption is closed after a
 * unit that ends a sentence once it is `minChars` long, or after a unit that
 * takes it to `softShare` of `max` (SPEC 3.3's longest caption, cut at the
 * first piece boundary that reaches it rather than before the piece that
 * would cross it, so nothing on screen moves when that piece comes).
 *
 * Untranslated text takes part as clause units, so the captions it will
 * land in are known before its translation comes: closed groups never change
 * as more units come, and their ids and text stay put while the line grows.
 */
function groupUnits(units: Unit[], options: CueOptions, max: number): Group[] {
  const soft = Math.round(max * options.softShare);
  const groups: Group[] = [];
  let open: Group | null = null;
  for (const unit of units) {
    if (!open) {
      open = { src: "", dst: "", pending: "", closed: false };
      groups.push(open);
    }
    if (unit.pending) open.pending += unit.src;
    else {
      // A real unit after pending text (it shouldn't happen: translations come in order) takes it in.
      open.src += open.pending + unit.src;
      open.pending = "";
      open.dst += unit.dst;
    }
    const text = open.src + open.pending;
    if ((SENTENCE_END.test(text) && len(text) >= options.minChars) || len(text) >= soft) {
      open.closed = true;
      open = null;
    }
  }
  return groups;
}

/**
 * Splits untranslated text into clauses, each ending with clause or sentence
 * punctuation (the places an engine like Soniox ends its pieces); the clause
 * still being spoken comes last, without it.
 */
export function splitClauses(text: string): string[] {
  const out: string[] = [];
  const re = /[,;:.?!]+["'”’)\]]*(?=\s|$)\s*|[，；：、。？！]+["'”’)\]）」』]*\s*/g;
  let start = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const end = m.index + m[0].length;
    if (text.slice(start, end).trim()) out.push(text.slice(start, end));
    else if (out.length > 0) out[out.length - 1] += text.slice(start, end);
    start = end;
  }
  if (start < text.length) {
    if (text.slice(start).trim()) out.push(text.slice(start));
    else if (out.length > 0) out[out.length - 1] += text.slice(start);
  }
  return out;
}

/**
 * A sentence pair longer than `max` is cut at its clauses when both sides
 * have as many (a long question and its translation, comma for comma);
 * otherwise it stays whole.
 */
function splitLongPair(pair: Unit, max: number): Unit[] {
  if (len(pair.src) <= max) return [pair];
  const src = splitClauses(pair.src);
  const dst = splitClauses(pair.dst);
  if (src.length < 2 || src.length !== dst.length) return [pair];
  return src.map((s, i) => ({ src: s, dst: dst[i] }));
}

const pendingUnits = (rest: string): Unit[] => splitClauses(rest).map((src) => ({ src, dst: "", pending: true }));

/** Joins pieces of a translation: CJK pieces without spaces, others as they come. */
const joinDst = (parts: string[]) => parts.join("");

/**
 * The captions of one line (SPEC 3.3).
 *
 * With `chunks`, captions break only between chunks, so the original and its
 * translation always match; the original after the last chunk is shown as
 * pending (dimmed) on the last caption. Without, the original and the
 * translation are split into sentences and aligned (`align.ts`); when they
 * can't be, the line is one caption.
 *
 * Ids are `${segmentId}#${n}`. A caption that is `complete` keeps its id and
 * text for good; the last one grows.
 */
export function buildCues(input: CueLineInput, options: CueOptions = DEFAULT_CUE_OPTIONS): CaptionCue[] {
  const full = input.text + (input.interim ?? "");
  const max = isCjkText(full) ? options.maxCjkChars : options.maxLatinChars;
  const settled = input.lineFinal && !input.translating;
  return input.chunks && input.chunks.length > 0
    ? chunkCues(input, full, max, settled, options)
    : wholeLineCues(input, full, max, settled, options);
}

function chunkCues(input: CueLineInput, full: string, max: number, settled: boolean, options: CueOptions): CaptionCue[] {
  const chunks = input.chunks!;
  const covered = chunks.map((c) => c.src).join("");
  const end = prefixEnd(full, covered);
  // The chunks are final tokens, so they can only run ahead of a stale line text.
  const srcRest = end < 0 ? (full.length > covered.length ? full.slice(covered.length) : "") : full.slice(end);
  const dstJoined = joinDst(chunks.map((c) => c.dst));
  const translation = input.translation ?? "";
  const dstRest = translation.startsWith(dstJoined) ? translation.slice(dstJoined.length) : "";

  const groups = groupUnits([...chunks, ...pendingUnits(srcRest)], options, max);
  return finish(input.segmentId, groups, dstRest, settled, true);
}

function wholeLineCues(input: CueLineInput, full: string, max: number, settled: boolean, options: CueOptions): CaptionCue[] {
  const translation = input.translation?.trim() ? input.translation : "";
  if (!translation) {
    // Nothing translated yet: whole sentences show plainly, the sentence still
    // being spoken is pending.
    const sentences = splitSentences(full);
    let rest = "";
    if (!input.lineFinal && sentences.length > 0 && !SENTENCE_END.test(sentences[sentences.length - 1])) {
      rest = sentences.pop()!;
    }
    const units = sentences.flatMap((s) => splitLongSentence(s, max)).map((src) => ({ src, dst: "" }));
    return finish(input.segmentId, groupUnits([...units, ...pendingUnits(rest)], options, max), "", settled, false);
  }

  // The translation was made of `translatedSource`; words recognised since are pending.
  const source = input.translatedSource ?? full;
  const end = prefixEnd(full, source);
  const base = end < 0 ? full : full.slice(0, end);
  const rest = end < 0 ? "" : full.slice(end);
  const pairs = (alignSentences(splitSentences(base), splitSentences(translation), { ratio: options.ratio })
    ?? [{ src: base, dst: translation }]).flatMap((pair) => splitLongPair(pair, max));
  return finish(input.segmentId, groupUnits([...pairs, ...pendingUnits(rest)], options, max), "", settled, false);
}

/**
 * Turns groups into captions. The untranslated part of each shows as pending
 * (dimmed), and the translation beyond the chunks (`dstRest`) on the last
 * one; once the line and its translation are settled, everything is plain
 * and complete. `closedIsFinal`: a closed group can't change any more (true
 * for chunks; whole-line translations may still regroup until the line
 * settles).
 */
function finish(
  segmentId: string,
  groups: Group[],
  dstRest: string,
  settled: boolean,
  closedIsFinal: boolean,
): CaptionCue[] {
  if (dstRest.trim() && (groups.length === 0 || groups[groups.length - 1].closed)) {
    groups.push({ src: "", dst: "", pending: "", closed: false });
  }
  return groups.map((group, n): CaptionCue => {
    const last = n === groups.length - 1;
    const extraDst = last ? dstRest : "";
    if (settled) {
      // The engine left the end untranslated: it is part of the caption now.
      return {
        id: `${segmentId}#${n}`,
        src: (group.src + group.pending).trim(),
        dst: (group.dst + extraDst).trim(),
        complete: true,
      };
    }
    const cue: CaptionCue = {
      id: `${segmentId}#${n}`,
      src: group.src.trim(),
      dst: group.dst.trim(),
      complete: closedIsFinal && group.closed && !group.pending.trim(),
    };
    if (group.pending.trim()) cue.srcPending = group.pending.trim();
    if (extraDst.trim()) cue.dstPending = extraDst.trim();
    return cue;
  });
}
