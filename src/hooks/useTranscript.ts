import { countWords } from "../lib/wordCount";
// Sub-PRD 4: Subscribe to transcript_update + transcript_final events
// Connects the Tauri IPC event stream to the Zustand transcript store.
// Also processes speaker_id through speakerStore for enrichment and stats.

import { useEffect, useState } from "react";
import { onTranscriptUpdate, onTranscriptFinal } from "../lib/events";
import { createEventScope } from "../lib/eventScope";
import { useTranscriptStore } from "../stores/transcriptStore";
import { useSpeakerStore } from "../stores/speakerStore";
import { useConfigStore } from "../stores/configStore";
import type { TranscriptSegment, TranscriptUpdateEvent } from "../lib/types";

const STALE_INTERIM_CHECK_MS = 2_000;

// Cache reference to avoid repeated imports
let _meetingStoreRef: typeof import("../stores/meetingStore") | null = null;

// Dev log helper — imported lazily to avoid circular deps
function devLog(msg: string) {
  import("../stores/devLogStore").then(({ useDevLogStore }) => {
    useDevLogStore.getState().addEntry("info", "speaker", msg);
  }).catch(() => {});
}

/**
 * Process a transcript segment through the speaker store:
 * - Resolve speaker_id from segment metadata (mode-aware)
 * - In in-person mode, discard mic-only "User" segments (room captures everything)
 * - Auto-create speaker if not already tracked
 * - Update speaker stats on final segments
 * - Return enriched segment with speaker_id set, or null to discard
 */
/** Words already counted in speaker stats, per final segment id. */
const countedWords = new Map<string, { words: number; speakerId: string }>();

// Initializing/clearing the speaker store starts a new meeting. Reused segment
// IDs must not inherit the previous meeting's counts, or retain them forever.
useSpeakerStore.subscribe((state, previous) => {
  if (state.speakers !== previous.speakers &&
      Object.values(state.speakers).every((speaker) => speaker.stats.segment_count === 0)) {
    countedWords.clear();
  }
});

function currentIsInPerson(): boolean {
  try {
    if (_meetingStoreRef) {
      return _meetingStoreRef.useMeetingStore.getState().audioMode === "in_person";
    }
  } catch { /* fallback to online mode */ }
  return false;
}

export function processSpeaker(
  segment: TranscriptSegment,
  isInPerson: boolean = currentIsInPerson()
): TranscriptSegment | null {
  const speakerStore = useSpeakerStore.getState();

  // In in-person mode, discard "User" segments — the room mic captures everyone,
  // so mic/Web Speech transcription is redundant and confusing.
  if (isInPerson && segment.speaker === "User") {
    return null;
  }

  let speakerId: string;

  if (!isInPerson) {
    // Online: the parties are fixed You / Them. A diarized remote line keeps
    // "them" (stats, filters, question detection) and is told apart by its
    // speaker_tag, tracked as the remote speaker `them:<tag>`; the raw
    // diarized speaker_id ("speaker_0") is not used here.
    speakerId = segment.speaker === "User" ? "you" : "them";
    if (speakerId === "them" && segment.speaker_tag) {
      speakerStore.ensureRemoteSpeaker(segment.speaker_tag);
    }
  } else if (segment.speaker_id) {
    speakerId = speakerStore.resolveSpeakerId(segment.speaker_id);
  } else {
    // In-person mode interim without diarization data
    const diarizationEnabled = useConfigStore.getState().diarizationEnabled;
    if (diarizationEnabled) {
      // Pending: diarization will resolve speaker on the final result
      speakerId = "__pending";
    } else {
      // No diarization: everything is "room"
      speakerId = "room";
    }
  }

  // Debug: log speaker assignment for final segments
  if (segment.is_final) {
    devLog(
      `[speaker] "${segment.text.slice(0, 40)}" | raw_speaker=${segment.speaker ?? "?"} raw_speaker_id=${segment.speaker_id ?? "none"} mode=${isInPerson ? "in_person" : "online"} → speakerId=${speakerId}`
    );
  }

  // Skip registration and stats for pending segments
  if (speakerId !== "__pending") {
    if (!speakerStore.getSpeaker(speakerId)) {
      speakerStore.addSpeaker(speakerId);
    }
    if (segment.is_final) {
      // A line that grows is re-sent as a final under the same id: count
      // its current words (including downward corrections), and the line once.
      const wordCount = countWords(segment.text);
      const counted = countedWords.get(segment.id);
      const previousId = counted && speakerStore.resolveSpeakerId(counted.speakerId);
      if (counted === undefined) {
        speakerStore.updateStats(speakerId, wordCount, 0);
      } else if (previousId !== undefined && previousId !== speakerId) {
        // Diarization can correct the owner of an already-final line. Move
        // this line's contribution rather than subtracting from its new owner.
        useSpeakerStore.setState((state) => {
          const previous = state.speakers[previousId];
          if (!previous) return state;
          return {
            speakers: {
              ...state.speakers,
              [previousId]: {
                ...previous,
                stats: {
                  ...previous.stats,
                  word_count: Math.max(0, previous.stats.word_count - counted.words),
                  segment_count: Math.max(0, previous.stats.segment_count - 1),
                },
              },
            },
          };
        });
        speakerStore.updateStats(speakerId, wordCount, 0);
      } else if (wordCount !== counted.words) {
        speakerStore.updateStats(speakerId, wordCount - counted.words, 0, false);
      }
      countedWords.set(segment.id, { words: wordCount, speakerId });
    }
  }

  return { ...segment, speaker_id: speakerId };
}

/**
 * Hook that subscribes to transcript IPC events and routes them
 * to the transcript store.
 *
 * - "transcript_update" events (interim results) -> updateInterimSegment
 * - "transcript_final" events (final results) -> appendSegment
 *
 * All segments are processed through the speaker store for enrichment.
 * In in-person mode, "User" segments from mic are discarded.
 */
export function useTranscript() {
  const [ready, setReady] = useState(false);

  // Lazy-load meetingStore reference for mode-aware speaker processing
  if (!_meetingStoreRef) {
    import("../stores/meetingStore").then((mod) => { _meetingStoreRef = mod; });
  }

  // Runs in each window: the launcher and the overlay keep their own transcript.
  useEffect(() => {
    const timer = setInterval(
      () => useTranscriptStore.getState().dropStaleInterim(),
      STALE_INTERIM_CHECK_MS
    );
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const scope = createEventScope("transcript");
    const handle = ({ segment, meeting_id }: TranscriptUpdateEvent) => {
      if (meeting_id && _meetingStoreRef && _meetingStoreRef.useMeetingStore.getState().activeMeeting?.id !== meeting_id) return;
      const enriched = processSpeaker(segment);
      if (enriched) useTranscriptStore.getState().updateInterimSegment(enriched);
    };
    void Promise.all([
      scope.add(onTranscriptUpdate, handle),
      scope.add(onTranscriptFinal, handle),
    ]).then((results) => {
      if (scope.active()) setReady(results.every(Boolean));
    });
    return scope.dispose;
  }, []);

  return ready;
}
