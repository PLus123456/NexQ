// Decides when a live line is ready to translate.
//
// The STT segment accumulator re-sends a growing paragraph as `transcript_final`
// under one id, and interim words for that id keep arriving after a final
// (src-tauri/src/stt/segment_accumulator.rs). Translating every final would
// re-translate the whole paragraph each time and let older answers overwrite
// newer ones. So a line is translated once it has settled:
// - it hasn't changed for `settleMs` (a new final or an interim for it restarts the wait), or
// - its party started another line (that one is now the pending line), or
// - it has been pending for `maxWaitMs` (a long monologue still gets translated;
//   when it settles later with more text it is translated again).
// Each id is handed to `translate` at most once per distinct text.

import { partyOfSpeaker } from "./nativeTranslation";
import type { TranslationParty } from "./types";

export interface SettleLine {
  id: string;
  text: string;
  speaker: string;
}

export interface SettleSchedulerOptions {
  /** Read on every wait, so a settings change applies to the next line. */
  settleMs: () => number;
  maxWaitMs: number;
  /** Is this line wanted at all (translation on, party selected…)? Checked on arrival and again when it settles. */
  accepts: (line: SettleLine) => boolean;
  translate: (line: SettleLine) => void;
}

interface Pending {
  line: SettleLine;
  /** When this id started waiting (for maxWaitMs). */
  since: number;
  timer: ReturnType<typeof setTimeout>;
}

export class SettleScheduler {
  private readonly pending = new Map<TranslationParty, Pending>();
  /** Last text handed to `translate`, per id. */
  private readonly sent = new Map<string, string>();

  constructor(private readonly options: SettleSchedulerOptions) {}

  /** A `transcript_final` arrived. */
  final(line: SettleLine): void {
    if (!line.text.trim() || !this.options.accepts(line)) return;
    const party = partyOfSpeaker(line.speaker);
    const current = this.pending.get(party);
    if (current && current.line.id !== line.id) this.flush(party);
    this.hold(party, line);
  }

  /** A `transcript_update` (interim words) arrived. */
  interim(line: Pick<SettleLine, "id" | "speaker">): void {
    const party = partyOfSpeaker(line.speaker);
    const current = this.pending.get(party);
    if (!current) return;
    if (current.line.id === line.id) {
      this.hold(party, current.line); // still growing
    } else {
      this.flush(party); // the party moved on to a new line
    }
  }

  /** Translates the party's pending line now (if it changed since it was last sent). */
  flush(party: TranslationParty): void {
    const current = this.pending.get(party);
    if (!current) return;
    clearTimeout(current.timer);
    this.pending.delete(party);
    const { line } = current;
    if (this.sent.get(line.id) === line.text || !this.options.accepts(line)) return;
    this.sent.set(line.id, line.text);
    this.options.translate(line);
  }

  /** Drops pending lines without translating them (meeting over, hook unmounted). */
  dispose(): void {
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.sent.clear();
  }

  /** Lines waiting right now, for tests. */
  get pendingCount(): number {
    return this.pending.size;
  }

  private hold(party: TranslationParty, line: SettleLine): void {
    const current = this.pending.get(party);
    const now = Date.now();
    const since = current && current.line.id === line.id ? current.since : now;
    if (current) clearTimeout(current.timer);
    const untilMaxWait = since + this.options.maxWaitMs - now;
    const delay = Math.max(0, Math.min(this.options.settleMs(), untilMaxWait));
    const timer = setTimeout(() => this.flush(party), delay);
    this.pending.set(party, { line, since, timer });
  }
}
