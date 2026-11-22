// Sentence splitting and sentence alignment for translations that come as one
// whole line (an LLM, DeepL, Microsoft...): the caption strip needs the
// original and its translation in matching pieces, and only an engine like
// Soniox says which words each piece translates (SPEC 3.3).

/** Chinese, Japanese and Korean characters (and their punctuation). */
const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿가-힯＀-￯]/g;

/** Whether `text` is mostly written in Chinese, Japanese or Korean. */
export function isCjkText(text: string): boolean {
  const letters = text.replace(/[\s\p{P}\p{S}\d]/gu, "");
  if (letters.length === 0) return false;
  const cjk = letters.match(CJK)?.length ?? 0;
  return cjk / letters.length >= 0.3;
}

/** Sentence-ending punctuation, Latin and CJK (SPEC 3.3). */
export const SENTENCE_END = /[.?!。？！]["'”’)\]）」』]*\s*$/;

/**
 * Splits `text` into sentences, each keeping its punctuation and the space
 * after it, so joining them gives `text` back. A Latin full stop ends a
 * sentence only before a space (or the end): "3.5" and "e.g.," stay whole.
 * CJK full stops end one anywhere.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  const re = /[.?!]+["'”’)\]]*(?=\s|$)\s*|[。？！]+["'”’)\]）」』]*\s*/g;
  let start = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const end = m.index + m[0].length;
    if (end > start && text.slice(start, end).trim()) {
      out.push(text.slice(start, end));
      start = end;
    }
    if (m[0].length === 0) re.lastIndex++;
  }
  if (start < text.length && text.slice(start).trim()) out.push(text.slice(start));
  else if (out.length > 0 && start < text.length) out[out.length - 1] += text.slice(start);
  return out;
}

/**
 * Splits a sentence longer than `max` characters at its clause punctuation
 * (`, ; :` and their CJK forms), into pieces of up to about `max` characters.
 * A sentence without such punctuation stays whole.
 */
export function splitLongSentence(sentence: string, max: number): string[] {
  if (sentence.trim().length <= max) return [sentence];
  const clauses: string[] = [];
  const re = /[,;:]+(?=\s)\s*|[，；：、]+\s*/g;
  let start = 0;
  for (let m = re.exec(sentence); m; m = re.exec(sentence)) {
    const end = m.index + m[0].length;
    clauses.push(sentence.slice(start, end));
    start = end;
  }
  if (start < sentence.length) {
    if (sentence.slice(start).trim() || clauses.length === 0) clauses.push(sentence.slice(start));
    else clauses[clauses.length - 1] += sentence.slice(start);
  }
  // Clauses are joined back while they fit.
  const out: string[] = [];
  for (const clause of clauses) {
    const last = out.length - 1;
    if (last >= 0 && (out[last] + clause).trim().length <= max) out[last] += clause;
    else out.push(clause);
  }
  return out;
}

/** One aligned pair: some original sentences and the translated sentences that go with them. */
export interface AlignedPair {
  src: string;
  dst: string;
}

export interface AlignOptions {
  /**
   * Characters of translation per character of original. Left out, it is the
   * ratio of the two texts' total lengths (for English to Chinese about 0.3).
   */
  ratio?: number;
}

/** Extra cost of a 1-to-2 or 2-to-1 step over a 1-to-1 step. */
const MERGE_PENALTY = 0.6;

const visibleLength = (s: string) => s.replace(/\s+/g, "").length;

/**
 * Pairs the original's sentences with the translation's (SPEC 3.3): as many
 * on both sides go one to one; otherwise a monotone alignment by length
 * (dynamic programming over 1-1, 1-2 and 2-1 steps, in the spirit of
 * Gale & Church). Returns null when the two can't be aligned that way (one
 * side has more than twice as many sentences); the caller then shows the
 * line as one piece.
 */
export function alignSentences(src: string[], dst: string[], options: AlignOptions = {}): AlignedPair[] | null {
  const m = src.length;
  const n = dst.length;
  if (m === 0 || n === 0) return null;
  if (m === n) return src.map((s, i) => ({ src: s, dst: dst[i] }));
  if (m > 2 * n || n > 2 * m) return null;

  const srcLen = src.map(visibleLength);
  const dstLen = dst.map(visibleLength);
  const totalSrc = srcLen.reduce((a, b) => a + b, 0);
  const totalDst = dstLen.reduce((a, b) => a + b, 0);
  const ratio = options.ratio ?? (totalSrc > 0 ? totalDst / totalSrc : 1);

  /** How badly `a` original characters match `b` translated ones. */
  const cost = (a: number, b: number) => {
    const expected = a * ratio;
    return Math.abs(b - expected) / Math.sqrt(expected + b + 1);
  };

  const INF = Number.POSITIVE_INFINITY;
  const best: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(INF));
  const step: Array<Array<[number, number] | null>> = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(null));
  best[0][0] = 0;
  const moves: Array<[number, number, number]> = [
    [1, 1, 0],
    [1, 2, MERGE_PENALTY],
    [2, 1, MERGE_PENALTY],
  ];
  for (let i = 0; i <= m; i++) {
    for (let j = 0; j <= n; j++) {
      if (best[i][j] === INF) continue;
      for (const [di, dj, penalty] of moves) {
        const ni = i + di;
        const nj = j + dj;
        if (ni > m || nj > n) continue;
        let a = 0;
        for (let k = i; k < ni; k++) a += srcLen[k];
        let b = 0;
        for (let k = j; k < nj; k++) b += dstLen[k];
        const total = best[i][j] + cost(a, b) + penalty;
        if (total < best[ni][nj]) {
          best[ni][nj] = total;
          step[ni][nj] = [di, dj];
        }
      }
    }
  }
  if (best[m][n] === INF) return null;

  const pairs: AlignedPair[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    const s = step[i][j];
    if (!s) return null;
    const [di, dj] = s;
    pairs.unshift({ src: src.slice(i - di, i).join(""), dst: dst.slice(j - dj, j).join("") });
    i -= di;
    j -= dj;
  }
  return pairs;
}
