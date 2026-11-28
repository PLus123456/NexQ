import { useEffect } from "react";
import { useMeetingStore } from "../stores/meetingStore";
import { useTranscriptStore } from "../stores/transcriptStore";
import { flushMeetingTranscript } from "../lib/transcriptPersistence";

const FLUSH_INTERVAL_MS = 30_000; // 30 seconds

/**
 * Hook that persists transcript segments to SQLite incrementally.
 * Every 30 seconds during an active meeting, it flushes any new
 * (not-yet-persisted) transcript segments to the database, and saves again
 * lines that grew since (same id, longer text).
 */
export function useTranscriptPersistence() {
  const meetingId = useMeetingStore((s) => s.activeMeeting?.id);

  useEffect(() => {
    if (!meetingId) return;
    let flushing = false;

    const flushSegments = async () => {
      const state = useMeetingStore.getState();
      if (flushing || state.activeMeeting?.id !== meetingId || state.isEndingMeeting) return;
      flushing = true;
      try {
        const nextIndex = await flushMeetingTranscript(
          meetingId, useTranscriptStore.getState().segments, state.lastPersistedIndex,
        );
        const current = useMeetingStore.getState();
        if (current.activeMeeting?.id === meetingId && !current.isEndingMeeting && nextIndex !== current.lastPersistedIndex) {
          current.setLastPersistedIndex(nextIndex);
        }
      } catch (err) {
        console.error("[transcriptPersistence] Failed to persist transcript:", err);
      } finally {
        flushing = false;
      }
    };

    const interval = setInterval(flushSegments, FLUSH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [meetingId]);
}
