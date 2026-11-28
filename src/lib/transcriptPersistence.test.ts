import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendTranscriptSegment } from "./ipc";
import { flushMeetingTranscript, markSegmentSaved, resetSavedSegments, segmentForSave, segmentsToSave } from "./transcriptPersistence";
import type { TranscriptSegment } from "./types";

vi.mock("./ipc", () => ({ appendTranscriptSegment: vi.fn() }));

function seg(id: string, text: string, is_final = true, speaker_tag?: string): TranscriptSegment {
  return { id, text, speaker: "Them", speaker_id: "them", speaker_tag, timestamp_ms: 1, is_final, confidence: 1 };
}

let savedSignatures: Map<string, string>;

function save(segments: TranscriptSegment[], lastIndex: number, all = false) {
  const { toSave, nextIndex } = segmentsToSave(segments, lastIndex, { all, savedSignatures });
  toSave.forEach((segment) => markSegmentSaved(savedSignatures, segment));
  return { ids: toSave.map((s) => `${s.id}:${s.text}`), nextIndex };
}

describe("transcript persistence", () => {
  beforeEach(() => { savedSignatures = new Map(); });

  it("saves new finals up to an open interim", () => {
    const segments = [seg("a", "one"), seg("b", "two"), seg("c", "thr", false), seg("d", "four")];
    expect(save(segments, 0)).toEqual({ ids: ["a:one", "b:two"], nextIndex: 2 });
    // At meeting end every final goes.
    expect(save(segments, 2, true)).toEqual({ ids: ["d:four"], nextIndex: 4 });
  });

  it("saves a line again when it grew after it was saved, once", () => {
    let segments = [seg("a", "We ship"), seg("b", "Ok")];
    expect(save(segments, 0).nextIndex).toBe(2);
    segments = [seg("a", "We ship on Friday"), seg("b", "Ok")];
    expect(save(segments, 2)).toEqual({ ids: ["a:We ship on Friday"], nextIndex: 2 });
    expect(save(segments, 2).ids).toEqual([]);
    // A changed speaker tag is saved too.
    segments = [seg("a", "We ship on Friday", true, "S2"), seg("b", "Ok")];
    expect(save(segments, 2).ids).toEqual(["a:We ship on Friday"]);
  });

  it("does not save frontend-only fields", () => {
    const json = JSON.parse(segmentForSave({ ...seg("a", "Hi", true, "S1"), pending_text: "Hi the", turn: "eager_end" }));
    expect(json.pending_text).toBeUndefined();
    expect(json.turn).toBeUndefined();
    expect(json.speaker_tag).toBe("S1");
  });

  it("serializes periodic and final snapshots without sharing state across meetings", async () => {
    resetSavedSegments();
    let finishFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => { finishFirst = resolve; });
    const append = vi.mocked(appendTranscriptSegment);
    append.mockResolvedValue(undefined).mockImplementationOnce(() => firstWrite);
    const periodic = flushMeetingTranscript("old", [seg("acc_1", "first version"), seg("acc_2", "unchanged")], 0);
    await vi.waitFor(() => expect(append).toHaveBeenCalledTimes(1));
    const final = flushMeetingTranscript("old", [seg("acc_1", "corrected"), seg("acc_2", "unchanged")], 0, { all: true });

    await flushMeetingTranscript("new", [seg("acc_1", "same ID, new meeting")], 0);
    finishFirst();
    await Promise.all([periodic, final]);
    expect(append.mock.calls.map(([meetingId, line]) => [meetingId, JSON.parse(line).text])).toEqual([
      ["old", "first version"], ["new", "same ID, new meeting"], ["old", "unchanged"], ["old", "corrected"],
    ]);
  });
});
