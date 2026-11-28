import type { TranscriptSegment } from "./types";
import { saveSegmentsWithRetry, unsavedTranscriptError } from "./endMeetingSave";

/**
 * The launcher owns transcript writes. Its periodic checkpoint and final
 * flush share signatures and a queue scoped to the meeting being saved.
 */
interface MeetingTranscriptPersistence {
  signatures: Map<string, string>;
  pending?: Promise<number>;
}

const persistenceByMeeting = new Map<string, MeetingTranscriptPersistence>();

function signature(segment: TranscriptSegment): string {
  return JSON.stringify([
    segment.text, segment.speaker, segment.speaker_id, segment.speaker_tag,
    segment.timestamp_ms, segment.confidence,
  ]);
}

/**
 * Segments to save now, and the new checkpoint index.
 * - Lines at or after `lastIndex`: the contiguous run of finals (all finals
 *   with `all`, at meeting end); an open interim stops the run so it is
 *   not skipped when it finalizes.
 * - Lines before the new checkpoint whose saved fields changed.
 */
export function segmentsToSave(
  segments: TranscriptSegment[],
  lastIndex: number,
  { all = false, savedSignatures }: { all?: boolean; savedSignatures?: ReadonlyMap<string, string> } = {}
): { toSave: TranscriptSegment[]; nextIndex: number } {
  let nextIndex = Math.min(lastIndex, segments.length);
  if (all) {
    nextIndex = segments.length;
  } else {
    while (nextIndex < segments.length && segments[nextIndex].is_final) nextIndex += 1;
  }
  const toSave = segments
    .slice(0, nextIndex)
    .filter((s) => s.is_final && savedSignatures?.get(s.id) !== signature(s));
  return { toSave, nextIndex };
}

/** Record that `segment` was saved as it is now. */
export function markSegmentSaved(savedSignatures: Map<string, string>, segment: TranscriptSegment): void {
  savedSignatures.set(segment.id, signature(segment));
}

/** The IPC form of a segment to save (frontend-only fields left out). */
export function segmentForSave(segment: TranscriptSegment): string {
  const { pending_text: _pending, turn: _turn, ...saved } = segment;
  return JSON.stringify(saved);
}

export function flushMeetingTranscript(
  meetingId: string,
  segments: TranscriptSegment[],
  lastIndex: number,
  { all = false }: { all?: boolean } = {},
): Promise<number> {
  const persistence: MeetingTranscriptPersistence = persistenceByMeeting.get(meetingId) ?? { signatures: new Map() };
  persistenceByMeeting.set(meetingId, persistence);

  const previous = persistence.pending?.catch(() => {}) ?? Promise.resolve();
  const flush = previous.then(async () => {
    const { toSave, nextIndex } = segmentsToSave(segments, lastIndex, {
      all,
      savedSignatures: persistence.signatures,
    });
    if (toSave.length === 0) return nextIndex;

    const { appendTranscriptSegment } = await import("./ipc");
    const save = (segment: TranscriptSegment) => appendTranscriptSegment(meetingId, segmentForSave(segment));
    const markSaved = (segment: TranscriptSegment) => markSegmentSaved(persistence.signatures, segment);
    if (all) {
      const failed = await saveSegmentsWithRetry(toSave, save, markSaved);
      if (failed > 0) throw unsavedTranscriptError(failed);
    } else {
      for (const segment of toSave) {
        await save(segment);
        markSaved(segment);
      }
    }
    return nextIndex;
  });
  persistence.pending = flush;
  return flush;
}

/** Forget what was saved (a new meeting starts). */
export function resetSavedSegments(): void {
  persistenceByMeeting.clear();
}
