import { describe, expect, it } from "vitest";
import { alignSentences, isCjkText, splitLongSentence, splitSentences } from "./align";

describe("splitSentences", () => {
  it("keeps punctuation and spaces, so the pieces join back to the text", () => {
    const text = "We moved billing. It took nine months! Why? Because of the ledger";
    const parts = splitSentences(text);
    expect(parts).toEqual(["We moved billing. ", "It took nine months! ", "Why? ", "Because of the ledger"]);
    expect(parts.join("")).toBe(text);
  });

  it("does not cut inside numbers or before a non-space", () => {
    expect(splitSentences("Version 3.5 shipped. Then e.g.,this.")).toEqual(["Version 3.5 shipped. ", "Then e.g.,this."]);
  });

  it("cuts Chinese at its full stops without spaces", () => {
    expect(splitSentences("感谢你来。我们开始吧！好吗？")).toEqual(["感谢你来。", "我们开始吧！", "好吗？"]);
  });

  it("keeps a closing quote with its sentence", () => {
    expect(splitSentences('He said "no." Then left.')).toEqual(['He said "no." ', "Then left."]);
  });
});

describe("splitLongSentence", () => {
  it("leaves a short sentence alone", () => {
    expect(splitLongSentence("Short one, really.", 84)).toEqual(["Short one, really."]);
  });

  it("cuts a long sentence at its commas into pieces that fit", () => {
    const s = "We have about four hundred services, most of them written in Go, and a gateway that still does rate limiting per IP address.";
    const parts = splitLongSentence(s, 60);
    expect(parts.join("")).toBe(s);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts.slice(0, -1)) expect(p.trim().length).toBeLessThanOrEqual(60);
  });
});

describe("alignSentences", () => {
  it("pairs one to one when both sides have as many sentences", () => {
    expect(alignSentences(["A b c. ", "D e f."], ["甲。", "乙。"])).toEqual([
      { src: "A b c. ", dst: "甲。" },
      { src: "D e f.", dst: "乙。" },
    ]);
  });

  it("merges two short originals translated as one sentence (2 to 1)", () => {
    const src = ["Okay. ", "Let's talk about scale for a moment. ", "How many requests per second did the new service handle at peak?"];
    const dst = ["好，我们聊一下规模。", "新服务在高峰期每秒处理多少请求？"];
    expect(alignSentences(src, dst)).toEqual([
      { src: "Okay. Let's talk about scale for a moment. ", dst: "好，我们聊一下规模。" },
      { src: "How many requests per second did the new service handle at peak?", dst: "新服务在高峰期每秒处理多少请求？" },
    ]);
  });

  it("splits one long original translated as two sentences (1 to 2)", () => {
    const src = ["We ran a shadow ledger and compared totals every hour, then every five minutes near the cut-over. ", "It worked."];
    const dst = ["我们跑了一份影子账本，每小时对一次总额。", "临近切换时改成每五分钟一次。", "很有效。"];
    const pairs = alignSentences(src, dst)!;
    expect(pairs).toHaveLength(2);
    expect(pairs[0].dst).toBe("我们跑了一份影子账本，每小时对一次总额。临近切换时改成每五分钟一次。");
    expect(pairs[1]).toEqual({ src: "It worked.", dst: "很有效。" });
  });

  it("is monotone: the joined pieces are both texts, in order", () => {
    const src = ["One. ", "Two two two two. ", "Three three three three three three. ", "Four."];
    const dst = ["一二。", "三三三三三三三三。", "四。"];
    const pairs = alignSentences(src, dst)!;
    expect(pairs.map((p) => p.src).join("")).toBe(src.join(""));
    expect(pairs.map((p) => p.dst).join("")).toBe(dst.join(""));
  });

  it("uses a given length ratio", () => {
    const src = ["Aaaa aaaa aaaa aaaa. ", "B. ", "Cccc cccc cccc cccc."];
    const dst = ["甲甲甲甲甲甲。", "丙丙丙丙丙丙。"];
    const pairs = alignSentences(src, dst, { ratio: 0.3 })!;
    expect(pairs).toHaveLength(2);
    expect(pairs.map((p) => p.src).join("")).toBe(src.join(""));
  });

  it("gives up when one side has more than twice as many sentences, or one is empty", () => {
    expect(alignSentences(["A. ", "B. ", "C. "], ["甲。"])).toBeNull();
    expect(alignSentences([], ["甲。"])).toBeNull();
    expect(alignSentences(["A."], [])).toBeNull();
  });
});

describe("isCjkText", () => {
  it("tells Chinese from English, ignoring punctuation and digits", () => {
    expect(isCjkText("我们用了九个月。")).toBe(true);
    expect(isCjkText("We moved billing in 9 months.")).toBe(false);
    expect(isCjkText("用 Go 写的服务")).toBe(true);
    expect(isCjkText("…")).toBe(false);
  });
});
