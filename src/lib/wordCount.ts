// Use word boundaries rather than spaces so Chinese/Japanese and mixed-language
// transcripts are measured consistently in live and saved meeting statistics.
type WordSegmenter = { segment(text: string): Iterable<{ isWordLike?: boolean }> };
type SegmenterConstructor = new (locale: string, options: { granularity: "word" }) => WordSegmenter;

const Segmenter = (Intl as typeof Intl & { Segmenter?: SegmenterConstructor }).Segmenter;
// A fixed locale makes counts independent of the UI language.
const segmenter = Segmenter ? new Segmenter("zh", { granularity: "word" }) : null;

export function countWords(text: string): number {
  if (segmenter) {
    let words = 0;
    for (const part of segmenter.segment(text)) {
      if (part.isWordLike) words++;
    }
    return words;
  }

  // Older WebViews may not expose Segmenter. Count CJK characters individually
  // there, while retaining word runs for languages that use spaces.
  const separated = text.replace(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu, " $1 ");
  return separated.match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:['’][\p{L}\p{N}\p{M}]+)*/gu)?.length ?? 0;
}
