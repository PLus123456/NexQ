import { describe, expect, it } from "vitest";
import { buildCues, prefixEnd, splitClauses, type CueLineInput } from "./cues";
import type { CaptionCue, TranslationChunk } from "./types";

/** The engine's pieces: every piece after the first starts with the space before its first word. */
function chunks(...pairs: Array<[string, string]>): TranslationChunk[] {
  return pairs.map(([src, dst], i) => ({ src: i === 0 ? src : ` ${src}`, dst }));
}

function line(partial: Partial<CueLineInput> & { text: string }): CueLineInput {
  return { segmentId: "s1", lineFinal: false, translating: true, ...partial };
}

const brief = (cues: CaptionCue[]) =>
  cues.map((c) => [c.id, c.src, c.srcPending ?? "", c.dst, c.dstPending ?? "", c.complete] as const);

const CLAUSES: Array<[string, string]> = [
  ["Thanks for making the time today.", "感谢你今天抽出时间。"],
  ["I run the platform team here,", "我负责这里的平台团队，"],
  ["and I'd like to hear about the billing migration you led.", "想听听你主导的那次计费迁移。"],
];
const FULL = chunks(...CLAUSES).map((c) => c.src).join("");

describe("buildCues with translation chunks (Soniox)", () => {
  it("shows the first words, before any translation, as pending", () => {
    expect(brief(buildCues(line({ text: "Thanks for making" })))).toEqual([["s1#0", "", "Thanks for making", "", "", false]]);
  });

  it("breaks only at chunk boundaries: a sentence end once long enough", () => {
    const text = `${CLAUSES[0][0]} I run the`;
    const cues = buildCues(line({ text, chunks: chunks(CLAUSES[0]), translation: CLAUSES[0][1] }));
    expect(brief(cues)).toEqual([
      ["s1#0", CLAUSES[0][0], "", CLAUSES[0][1], "", true],
      ["s1#1", "", "I run the", "", "", false],
    ]);
  });

  it("closes a caption that reached the soft length after its piece, so the next words start the next caption", () => {
    const cs = chunks(...CLAUSES);
    const cues = buildCues(line({ text: FULL, chunks: cs, translation: cs.map((c) => c.dst).join(""), lineFinal: true, translating: false }));
    expect(cues.map((c) => c.src)).toEqual([CLAUSES[0][0], `${CLAUSES[1][0]} ${CLAUSES[2][0]}`]);
    expect(cues.map((c) => c.dst)).toEqual([CLAUSES[0][1], CLAUSES[1][1] + CLAUSES[2][1]]);
    expect(cues.every((c) => c.complete)).toBe(true);
  });

  it("puts untranslated words where their translation will land: after a sentence end in them, a new caption", () => {
    // The clause "because …" is spoken but not translated yet, "Last" follows.
    const text = "Let me tell you a bit about the incident that made us rethink all of this, because I think it will help you see where we are coming from. Last";
    const first: TranslationChunk[] = chunks(["Let me tell you a bit about the incident that made us rethink all of this,", "我先讲讲让我们重新思考这一切的那次事故，"]);
    const before = buildCues(line({ text, chunks: first, translation: first[0].dst }));
    expect(before.map((c) => [c.src, c.srcPending ?? ""])).toEqual([
      [first[0].src, ""],
      ["", "because I think it will help you see where we are coming from."],
      ["", "Last"],
    ]);
    // The translation comes: nothing moves to another caption.
    const both = chunks(
      ["Let me tell you a bit about the incident that made us rethink all of this,", "我先讲讲让我们重新思考这一切的那次事故，"],
      ["because I think it will help you see where we are coming from.", "因为我觉得这能帮你理解我们的出发点。"],
    );
    const after = buildCues(line({ text, chunks: both, translation: both.map((c) => c.dst).join("") }));
    expect(after.map((c) => [c.id, c.src, c.srcPending ?? ""])).toEqual([
      ["s1#0", first[0].src, ""],
      ["s1#1", "because I think it will help you see where we are coming from.", ""],
      ["s1#2", "", "Last"],
    ]);
  });

  it("keeps the ids and text of complete captions while the line grows (stable ids)", () => {
    const words = FULL.match(/\s*\S+/g)!;
    let spoken = "";
    const seen = new Map<string, CaptionCue>();
    const cs = chunks(...CLAUSES);
    for (const word of words) {
      spoken += word;
      // Chunks whose words are all spoken (and a moment later) are translated.
      const done = cs.filter((_, i) => cs.slice(0, i + 1).map((c) => c.src).join("").length <= spoken.length - 6);
      const cues = buildCues(line({ text: spoken, chunks: done, translation: done.map((c) => c.dst).join("") }));
      for (const cue of cues) {
        const earlier = seen.get(cue.id);
        if (earlier?.complete) expect(cue).toEqual(earlier);
        seen.set(cue.id, cue);
      }
      // Every word said is on screen, once.
      expect(cues.map((c) => [c.src, c.srcPending].filter(Boolean).join(" ")).join(" ").replace(/\s+/g, " ")).toBe(spoken.trim().replace(/\s+/g, " "));
    }
  });

  it("does not cut a short sentence off (under the minimum length)", () => {
    const cs = chunks(["Okay.", "好。"], ["Let me give you some context.", "我先介绍一下背景。"]);
    const cues = buildCues(line({ text: cs.map((c) => c.src).join(""), chunks: cs, translation: "好。我先介绍一下背景。" }));
    expect(cues.map((c) => c.src)).toEqual(["Okay. Let me give you some context."]);
  });

  it("shows translation beyond the chunks as pending", () => {
    const cs = chunks(CLAUSES[1]);
    const cues = buildCues(line({ text: CLAUSES[1][0], chunks: cs, translation: `${CLAUSES[1][1]}想听` }));
    expect(cues[cues.length - 1].dstPending).toBe("想听");
  });

  it("once the line and its translation are final, an untranslated end becomes part of the caption", () => {
    const cs = chunks(CLAUSES[1]);
    const cues = buildCues(line({ text: `${CLAUSES[1][0]} thanks`, chunks: cs, translation: CLAUSES[1][1], lineFinal: true, translating: false }));
    expect(brief(cues)).toEqual([["s1#0", `${CLAUSES[1][0]} thanks`, "", CLAUSES[1][1], "", true]]);
  });

  it("copes with chunks whose spacing differs from the line's", () => {
    const cs: TranslationChunk[] = [{ src: "Hello  there,", dst: "你好，" }];
    const cues = buildCues(line({ text: "Hello there, how are", chunks: cs, translation: "你好，" }));
    expect(cues.map((c) => [c.src, c.srcPending])).toEqual([["Hello  there,", "how are"]]);
  });

  it("uses the shorter limits for Chinese speech", () => {
    const cs: TranslationChunk[] = [
      { src: "我们有大约四百个服务，", dst: " We have about 400 services," },
      { src: "大部分是用Go写的，", dst: " mostly written in Go," },
      { src: "还有一个网关。", dst: " and a gateway." },
    ];
    const cues = buildCues(line({ text: cs.map((c) => c.src).join(""), chunks: cs, translation: cs.map((c) => c.dst).join("") }));
    // 30 characters at most, closed once 17 (30 × 0.55) are reached: the first two pieces, then the third.
    expect(cues.map((c) => c.src)).toEqual(["我们有大约四百个服务，大部分是用Go写的，", "还有一个网关。"]);
  });
});

describe("buildCues without chunks (whole-line translators)", () => {
  it("before a translation: whole sentences plainly, the one being said pending", () => {
    const cues = buildCues(line({ text: "Makes sense. And what would you" }));
    expect(brief(cues)).toEqual([["s1#0", "Makes sense.", "And what would you", "", "", false]]);
  });

  it("pairs sentences one to one when the counts match", () => {
    const text = "Thanks for making the time today. I'd like to hear about the billing migration you led.";
    const translation = "感谢你今天抽出时间。想听听你主导的那次计费迁移。";
    const cues = buildCues(line({ text, translation, translatedSource: text, lineFinal: true, translating: false }));
    expect(brief(cues)).toEqual([
      ["s1#0", "Thanks for making the time today.", "", "感谢你今天抽出时间。", "", true],
      ["s1#1", "I'd like to hear about the billing migration you led.", "", "想听听你主导的那次计费迁移。", "", true],
    ]);
  });

  it("aligns by length when the counts differ", () => {
    const text = "Okay. Let's talk about scale for a moment. How many requests per second did the new service handle at peak?";
    const translation = "好，我们聊一下规模。新服务在高峰期每秒处理多少请求？";
    const cues = buildCues(line({ text, translation, translatedSource: text, lineFinal: true, translating: false }));
    expect(cues.map((c) => [c.src, c.dst])).toEqual([
      ["Okay. Let's talk about scale for a moment.", "好，我们聊一下规模。"],
      ["How many requests per second did the new service handle at peak?", "新服务在高峰期每秒处理多少请求？"],
    ]);
  });

  it("shows the whole line as one caption when the sentences can't be aligned", () => {
    const text = "One. Two. Three. Four. Five.";
    const cues = buildCues(line({ text, translation: "一二三四五。", translatedSource: text, lineFinal: true, translating: false }));
    expect(cues.map((c) => [c.src, c.dst])).toEqual([[text, "一二三四五。"]]);
  });

  it("words recognised after the translated text are pending", () => {
    const translated = "Thanks for making the time today.";
    const cues = buildCues(line({ text: `${translated} I run`, translation: "感谢你今天抽出时间。", translatedSource: translated }));
    expect(brief(cues)).toEqual([
      ["s1#0", translated, "", "感谢你今天抽出时间。", "", false],
      ["s1#1", "", "I run", "", "", false],
    ]);
  });

  it("cuts a long sentence pair at its clauses when both sides have as many", () => {
    const text = "That's impressive. So when you say no downtime, do you mean customers never saw an error, or that the errors stayed inside your retry budget?";
    const translation = "很厉害。那你说的不停机，是指客户从没看到过报错，还是说错误都在重试预算之内？";
    const cues = buildCues(line({ text, translation, translatedSource: text, lineFinal: true, translating: false }));
    expect(cues.map((c) => [c.src, c.dst])).toEqual([
      ["That's impressive. So when you say no downtime,", "很厉害。那你说的不停机，"],
      ["do you mean customers never saw an error, or that the errors stayed inside your retry budget?", "是指客户从没看到过报错，还是说错误都在重试预算之内？"],
    ]);
  });

  it("is not complete before the translation is final", () => {
    const text = "Thanks for making the time today.";
    const cues = buildCues(line({ text, translation: "感谢你", translatedSource: text, lineFinal: true, translating: true }));
    expect(cues.every((c) => !c.complete)).toBe(true);
  });

  it("a long line without punctuation is cut at its commas", () => {
    const text = "So when you say no downtime, do you mean customers never saw an error, or that the errors stayed inside your retry budget";
    const cues = buildCues(line({ text, lineFinal: true, translating: false }));
    expect(cues.length).toBeGreaterThan(1);
    expect(cues.map((c) => c.src).join(" ")).toBe(text);
  });
});

describe("helpers", () => {
  it("prefixEnd ignores whitespace and says where the prefix ends", () => {
    expect(prefixEnd("Hello there, you", "Hello  there,")).toBe(12);
    expect(prefixEnd("Hello there", "Help")).toBe(-1);
    expect(prefixEnd("abc", "")).toBe(0);
  });

  it("splitClauses cuts after clause punctuation and keeps the clause being said last", () => {
    expect(splitClauses(" which sounds right, except that a few")).toEqual([" which sounds right, ", "except that a few"]);
    expect(splitClauses("一个，两个。三")).toEqual(["一个，", "两个。", "三"]);
    expect(splitClauses("4,000 requests")).toEqual(["4,000 requests"]);
  });
});
