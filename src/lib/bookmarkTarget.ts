import { mergeConsecutiveSegments } from "./mergeSegments";
import type { MeetingBookmark, TranscriptSegment } from "./types";

const EPOCH_MS_FLOOR = 1e11;
const CLOCK_SKEW_TOLERANCE_MS = 60_000;

/**
 * Convert a meeting timestamp (either an epoch timestamp >= meetingStartTime,
 * or a legacy in-meeting elapsed offset) into elapsed milliseconds since start.
 */
export function toElapsedMs(timestampMs: number, meetingStartTime: number | null): number {
  if (!meetingStartTime) return Math.max(0, timestampMs);
  if (timestampMs >= meetingStartTime) return timestampMs - meetingStartTime;
  // Guard against slight clock skew where an epoch timestamp lands just before meetingStartTime.
  if (timestampMs > EPOCH_MS_FLOOR && meetingStartTime - timestampMs < CLOCK_SKEW_TOLERANCE_MS) {
    return 0;
  }
  return Math.max(0, timestampMs);
}

/**
 * Find the transcript segment whose in-meeting elapsed time is closest to `targetElapsedMs`.
 * On ties, the later segment wins so bookmarks taken at the live edge anchor to the newest line.
 */
export function findNearestSegment(
  segments: readonly TranscriptSegment[],
  targetElapsedMs: number,
  meetingStartTime: number | null,
): TranscriptSegment | undefined {
  if (segments.length === 0) return undefined;
  let nearest = segments[0];
  let bestDiff = Math.abs(toElapsedMs(nearest.timestamp_ms, meetingStartTime) - targetElapsedMs);
  for (let i = 1; i < segments.length; i++) {
    const diff = Math.abs(toElapsedMs(segments[i].timestamp_ms, meetingStartTime) - targetElapsedMs);
    if (diff <= bestDiff) {
      bestDiff = diff;
      nearest = segments[i];
    }
  }
  return nearest;
}

/** Map a raw segment id to the rendered TranscriptPanel row id (handling merged consecutive finals). */
function toDisplayedRowId(
  segmentId: string,
  displayed: ReadonlyArray<TranscriptSegment & { originalIds?: string[] }>,
): string | null {
  for (const row of displayed) {
    if (row.id === segmentId || row.originalIds?.includes(segmentId)) {
      return row.id;
    }
  }
  return null;
}

/**
 * Resolve a bookmark to the `data-segment-id` rendered in TranscriptPanel:
 * 1. Exact `segment_id` (or the merged row containing it).
 * 2. Fallback to the nearest transcript line by in-meeting elapsed time
 *    (supports legacy offset-only bookmarks and dropped interim segments).
 */
export function resolveBookmarkSegmentId(
  bookmark: Pick<MeetingBookmark, "segment_id" | "timestamp_ms">,
  segments: readonly TranscriptSegment[],
  meetingStartTime: number | null,
): string | null {
  if (segments.length === 0) {
    return bookmark.segment_id ?? null;
  }

  const finals = segments.filter((s) => s.is_final);
  const interims = segments.filter((s) => !s.is_final);
  const displayed = [...mergeConsecutiveSegments(finals), ...interims];

  if (bookmark.segment_id) {
    const matched = toDisplayedRowId(bookmark.segment_id, displayed);
    if (matched) return matched;
  }

  const targetElapsed = toElapsedMs(bookmark.timestamp_ms, meetingStartTime);
  const nearest = findNearestSegment(segments, targetElapsed, meetingStartTime);
  if (!nearest) return null;
  return toDisplayedRowId(nearest.id, displayed) ?? nearest.id;
}
