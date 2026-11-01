import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettleScheduler, type SettleLine } from "./settleScheduler";

const SETTLE = 1200;
const MAX_WAIT = 8000;

function setup(accepts: (line: SettleLine) => boolean = () => true) {
  const translate = vi.fn<(line: SettleLine) => void>();
  const scheduler = new SettleScheduler({ settleMs: () => SETTLE, maxWaitMs: MAX_WAIT, accepts, translate });
  return { scheduler, translate, sent: () => translate.mock.calls.map(([l]) => `${l.id}:${l.text}`) };
}

const them = (id: string, text: string): SettleLine => ({ id, text, speaker: "Them" });
const you = (id: string, text: string): SettleLine => ({ id, text, speaker: "User" });

describe("SettleScheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("translates a final once it has settled", () => {
    const { scheduler, sent } = setup();
    scheduler.final(them("a", "Hello"));
    vi.advanceTimersByTime(SETTLE - 1);
    expect(sent()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent()).toEqual(["a:Hello"]);
    vi.advanceTimersByTime(10_000);
    expect(sent()).toEqual(["a:Hello"]);
  });

  it("a paragraph re-sent as it grows is translated once, with its last text", () => {
    const { scheduler, sent } = setup();
    scheduler.final(them("acc_1", "Hello"));
    vi.advanceTimersByTime(500);
    scheduler.final(them("acc_1", "Hello there"));
    vi.advanceTimersByTime(500);
    scheduler.final(them("acc_1", "Hello there, everyone"));
    vi.advanceTimersByTime(SETTLE);
    expect(sent()).toEqual(["acc_1:Hello there, everyone"]);
  });

  it("interim words for the pending line restart the wait", () => {
    const { scheduler, sent } = setup();
    scheduler.final(them("acc_1", "Hello"));
    vi.advanceTimersByTime(1000);
    scheduler.interim({ id: "acc_1", speaker: "Them" });
    vi.advanceTimersByTime(1000);
    expect(sent()).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(sent()).toEqual(["acc_1:Hello"]);
  });

  it("a new line of the same party sends the previous one at once", () => {
    const { scheduler, sent } = setup();
    scheduler.final(them("acc_1", "First"));
    scheduler.final(them("acc_2", "Second"));
    expect(sent()).toEqual(["acc_1:First"]);
    vi.advanceTimersByTime(SETTLE);
    expect(sent()).toEqual(["acc_1:First", "acc_2:Second"]);
  });

  it("interim words of a new line also end the previous one", () => {
    const { scheduler, sent } = setup();
    scheduler.final(them("acc_1", "First"));
    scheduler.interim({ id: "acc_2", speaker: "Them" });
    expect(sent()).toEqual(["acc_1:First"]);
  });

  it("the parties wait independently", () => {
    const { scheduler, sent } = setup();
    scheduler.final(them("t1", "Theirs"));
    scheduler.final(you("y1", "Mine"));
    expect(sent()).toEqual([]);
    vi.advanceTimersByTime(SETTLE);
    expect(sent().sort()).toEqual(["t1:Theirs", "y1:Mine"]);
  });

  it("a line that keeps growing is translated after maxWait, then again when it settles", () => {
    const { scheduler, sent } = setup();
    let text = "word";
    scheduler.final(them("acc_1", text));
    for (let elapsed = 0; elapsed < MAX_WAIT; elapsed += 1000) {
      vi.advanceTimersByTime(1000);
      text += " word";
      if (elapsed + 1000 < MAX_WAIT) scheduler.final(them("acc_1", text));
    }
    expect(sent()).toHaveLength(1);
    scheduler.final(them("acc_1", `${text} end`));
    vi.advanceTimersByTime(SETTLE);
    expect(sent()).toHaveLength(2);
    expect(sent()[1]).toBe(`acc_1:${text} end`);
  });

  it("the same text is never sent twice", () => {
    const { scheduler, sent } = setup();
    scheduler.final(them("a", "Same"));
    vi.advanceTimersByTime(SETTLE);
    scheduler.final(them("a", "Same"));
    vi.advanceTimersByTime(SETTLE);
    expect(sent()).toEqual(["a:Same"]);
  });

  it("lines that aren't wanted are never held or sent", () => {
    let wanted = false;
    const { scheduler, sent } = setup(() => wanted);
    scheduler.final(them("a", "Skip me"));
    expect(scheduler.pendingCount).toBe(0);
    wanted = true;
    scheduler.final(them("b", "Keep me"));
    wanted = false; // switched off while it settles
    vi.advanceTimersByTime(SETTLE);
    expect(sent()).toEqual([]);
  });

  it("flushAll sends every pending line at once", () => {
    const { scheduler, sent } = setup();
    scheduler.final(them("t1", "Theirs"));
    scheduler.final(you("y1", "Mine"));
    scheduler.flushAll();
    expect(sent().sort()).toEqual(["t1:Theirs", "y1:Mine"]);
    expect(scheduler.pendingCount).toBe(0);
    vi.advanceTimersByTime(SETTLE);
    expect(sent()).toHaveLength(2);
  });

  it("ignores empty finals and drops pending lines on dispose", () => {
    const { scheduler, sent } = setup();
    scheduler.final(them("a", "   "));
    expect(scheduler.pendingCount).toBe(0);
    scheduler.final(them("b", "Pending"));
    scheduler.dispose();
    vi.advanceTimersByTime(SETTLE * 2);
    expect(sent()).toEqual([]);
  });
});
