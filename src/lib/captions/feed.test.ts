import { describe, expect, it } from "vitest";
import { EMPTY_FEED, MAX_LINES, feedTranscript, feedTranslation, partyOf, stripCues, type CaptionFeed } from "./feed";
import type { TranscriptSegment, TranslationResult } from "../types";

function seg(id: string, text: string, speaker: TranscriptSegment["speaker"] = "Them"): TranscriptSegment {
  return { id, text, speaker, timestamp_ms: 0, is_final: false, confidence: 0.9 };
}

function tr(id: string, original: string, translated: string, extra: Partial<TranslationResult> = {}): TranslationResult {
  return { segment_id: id, original_text: original, translated_text: translated, source_lang: "en", target_lang: "zh", provider: "soniox", is_final: false, ...extra };
}

describe("caption feed", () => {
  it("tells the user's own lines from the other side's", () => {
    expect(partyOf({ speaker: "User" })).toBe("you");
    expect(partyOf({ speaker: "Them" })).toBe("them");
    expect(partyOf({ speaker: "Interviewer" })).toBe("them");
  });

  it("updates a line in place and marks it final", () => {
    let f = feedTranscript(EMPTY_FEED, seg("a", "Thanks"), false);
    f = feedTranscript(f, seg("a", "Thanks for"), false);
    f = feedTranscript(f, seg("a", "Thanks for joining."), true);
    expect(f.lines).toEqual([{ id: "a", party: "them", text: "Thanks for joining.", final: true }]);
  });

  it("returns the same feed for an event that changes nothing", () => {
    const f = feedTranscript(EMPTY_FEED, seg("a", "Hi"), false);
    expect(feedTranscript(f, seg("a", "Hi"), false)).toBe(f);
  });

  it("keeps only the last lines and drops their translations", () => {
    let f: CaptionFeed = EMPTY_FEED;
    for (let i = 0; i < MAX_LINES + 3; i++) {
      f = feedTranscript(f, seg(`l${i}`, `Line ${i}.`), true);
      f = feedTranslation(f, tr(`l${i}`, `Line ${i}.`, `第 ${i} 行。`, { is_final: true }));
    }
    expect(f.lines).toHaveLength(MAX_LINES);
    expect(f.lines[0].id).toBe("l3");
    expect(Object.keys(f.translations).sort()).toEqual(f.lines.map((l) => l.id).sort());
  });

  it("keeps a translation that came before its line, but only a few of those", () => {
    let f = feedTranslation(EMPTY_FEED, tr("early", "Hi.", "你好。"));
    expect(f.translations.early).toBeDefined();
    expect(f.translationSeen).toBe(true);
    for (let i = 0; i < 10; i++) f = feedTranslation(f, tr(`old${i}`, "x", "y"));
    expect(Object.keys(f.translations).length).toBeLessThanOrEqual(5);
  });

  it("ignores events without a line id", () => {
    expect(feedTranslation(EMPTY_FEED, { ...tr("x", "a", "b"), segment_id: undefined })).toBe(EMPTY_FEED);
    expect(feedTranscript(EMPTY_FEED, { ...seg("", "a") }, false)).toBe(EMPTY_FEED);
  });
});

describe("stripCues", () => {
  const conversation = (): CaptionFeed => {
    let f: CaptionFeed = EMPTY_FEED;
    f = feedTranscript(f, seg("t1", "Thanks for making the time today. I run the platform team here."), true);
    f = feedTranslation(f, tr("t1", "Thanks for making the time today. I run the platform team here.", "感谢你今天抽出时间。我负责这里的平台团队。", {
      is_final: true,
      chunks: [
        { src: "Thanks for making the time today.", dst: "感谢你今天抽出时间。" },
        { src: " I run the platform team here.", dst: "我负责这里的平台团队。" },
      ],
    }));
    f = feedTranscript(f, seg("y1", "Happy to be here.", "User"), true);
    f = feedTranscript(f, seg("t2", "What was the hardest part"), false);
    return f;
  };

  it("shows the newest captions of the other side, oldest first", () => {
    const cues = stripCues(conversation(), "them", 2);
    expect(cues.map((c) => [c.id, c.src || c.srcPending])).toEqual([
      ["t1#1", "I run the platform team here."],
      ["t2#0", "What was the hardest part"],
    ]);
    expect(cues.every((c) => c.party === "them")).toBe(true);
  });

  it("with both parties, the user's lines are in and marked", () => {
    const cues = stripCues(conversation(), "both", 3);
    expect(cues.map((c) => [c.lineId, c.party])).toEqual([["t1", "them"], ["y1", "you"], ["t2", "them"]]);
  });

  it("takes the chunk path when a translation has chunks, the whole-line path when not", () => {
    let f = feedTranscript(EMPTY_FEED, seg("w", "Okay. Let's talk about scale for a moment. How many requests per second at peak?"), true);
    f = feedTranslation(f, tr("w", "Okay. Let's talk about scale for a moment. How many requests per second at peak?", "好，我们聊一下规模。高峰期每秒多少请求？", { provider: "llm", is_final: true }));
    expect(stripCues(f, "them", 3).map((c) => [c.src, c.dst])).toEqual([
      ["Okay. Let's talk about scale for a moment.", "好，我们聊一下规模。"],
      ["How many requests per second at peak?", "高峰期每秒多少请求？"],
    ]);
  });

  it("returns the same caption objects' text for an unchanged line (cached)", () => {
    const f = conversation();
    expect(stripCues(f, "them", 3)).toEqual(stripCues(f, "them", 3));
  });
});
