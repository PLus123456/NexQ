import { create } from "zustand";
import type { SpeakerIdentity, SpeakerStats, SpeakerSource } from "../lib/types";
import { getSpeakerColor, FIXED_SPEAKER_COLORS } from "../lib/speakerColors";
import { defaultRemoteSpeakerName, remoteSpeakerColor, remoteSpeakerId } from "../lib/speakerLabels";
import { t } from "../i18n";

interface SpeakerState {
  speakers: Record<string, SpeakerIdentity>;
  speakerOrder: string[];
  pendingNaming: string | null;

  // Initialization
  initForOnline: () => void;
  initForInPerson: (hasDiarization: boolean) => void;

  // Mutations
  addSpeaker: (speakerId: string) => void;
  /**
   * Track a person on the other side of an online call (diarization tag
   * "S1") as speaker `them:S1`, named "Speaker 1" until renamed. Kept out of
   * the speaker order: "Them" stays the stats/filter speaker.
   */
  ensureRemoteSpeaker: (tag: string) => void;
  renameSpeaker: (speakerId: string, newName: string) => void;
  dismissNaming: () => void;
  mergeSpeaker: (fromId: string, intoId: string) => void;
  /** Add words / talk time; `newSegment` (default true) also counts a segment. */
  updateStats: (speakerId: string, wordCount: number, durationMs: number, newSegment?: boolean) => void;

  // Getters
  getSpeaker: (speakerId: string) => SpeakerIdentity | undefined;
  getSpeakerColor: (speakerId: string) => string;
  getSpeakerDisplayName: (speakerId: string) => string;
  getAllSpeakers: () => SpeakerIdentity[];
  /** People tracked by remote speaker tag (see `ensureRemoteSpeaker`). */
  getRemoteSpeakers: () => SpeakerIdentity[];

  // Reset
  reset: () => void;
}

function makeEmptyStats(): SpeakerStats {
  return {
    segment_count: 0,
    word_count: 0,
    talk_time_ms: 0,
    last_spoke_ms: 0,
  };
}

function makeSpeaker(
  id: string,
  displayName: string,
  source: SpeakerSource,
  color?: string
): SpeakerIdentity {
  return {
    id,
    display_name: displayName,
    source,
    color,
    stats: makeEmptyStats(),
  };
}

export const useSpeakerStore = create<SpeakerState>((set, get) => ({
  speakers: {},
  speakerOrder: [],
  pendingNaming: null,

  initForOnline: () => {
    // The default names are stored with the speaker (and saved with the
    // meeting), so they are translated here, when the speaker is created.
    const you = makeSpeaker("you", t("common:labels.you"), "fixed", FIXED_SPEAKER_COLORS.you);
    const them = makeSpeaker("them", t("common:labels.them"), "fixed", FIXED_SPEAKER_COLORS.them);
    set({
      speakers: { you, them },
      speakerOrder: ["you", "them"],
      pendingNaming: null,
    });
  },

  initForInPerson: (hasDiarization) => {
    if (hasDiarization) {
      // In-person with diarization: start empty, speakers added dynamically via speaker_detected events
      set({ speakers: {}, speakerOrder: [], pendingNaming: null });
    } else {
      // In-person without diarization: single "Room" label for all audio
      const room = makeSpeaker("room", t("common:labels.room"), "room", FIXED_SPEAKER_COLORS.room);
      set({ speakers: { room }, speakerOrder: ["room"], pendingNaming: null });
    }
  },

  addSpeaker: (speakerId) => {
    const state = get();
    // Don't add duplicates
    if (speakerId in state.speakers) return;

    const orderIndex = state.speakerOrder.length;
    const color = getSpeakerColor(speakerId, orderIndex);

    // Parse numeric part of speaker ID for a friendlier display name
    // Deepgram returns IDs like "0", "1", "2" or "speaker_0", etc.
    const numMatch = speakerId.match(/(\d+)/);
    const speakerNum = numMatch ? parseInt(numMatch[1], 10) + 1 : orderIndex + 1;
    const displayName = t("misc:speakerLabels.defaultName", { n: speakerNum });

    const speaker = makeSpeaker(speakerId, displayName, "diarization", color);

    set((s) => ({
      speakers: { ...s.speakers, [speakerId]: speaker },
      speakerOrder: [...s.speakerOrder, speakerId],
      pendingNaming: speakerId,
    }));
  },

  ensureRemoteSpeaker: (tag) => {
    const id = remoteSpeakerId(tag);
    if (id in get().speakers) return;
    const speaker = makeSpeaker(id, defaultRemoteSpeakerName(tag), "remote_tag", remoteSpeakerColor(tag));
    set((s) => ({ speakers: { ...s.speakers, [id]: speaker } }));
  },

  renameSpeaker: (speakerId, newName) => {
    set((s) => {
      const existing = s.speakers[speakerId];
      if (!existing) return s;
      return {
        speakers: {
          ...s.speakers,
          [speakerId]: { ...existing, display_name: newName },
        },
        pendingNaming: s.pendingNaming === speakerId ? null : s.pendingNaming,
      };
    });
  },

  dismissNaming: () => {
    set({ pendingNaming: null });
  },

  mergeSpeaker: (fromId, intoId) => {
    set((s) => {
      const source = s.speakers[fromId];
      const target = s.speakers[intoId];
      if (!source || !target) return s;

      // Transfer stats from source into target
      const mergedStats = {
        segment_count: target.stats.segment_count + source.stats.segment_count,
        word_count: target.stats.word_count + source.stats.word_count,
        talk_time_ms: target.stats.talk_time_ms + source.stats.talk_time_ms,
        last_spoke_ms: Math.max(target.stats.last_spoke_ms, source.stats.last_spoke_ms),
      };

      // Remove source, update target stats
      const { [fromId]: _removed, ...remainingSpeakers } = s.speakers;
      return {
        speakers: {
          ...remainingSpeakers,
          [intoId]: { ...target, stats: mergedStats },
        },
        speakerOrder: s.speakerOrder.filter((id) => id !== fromId),
        pendingNaming: s.pendingNaming === fromId ? null : s.pendingNaming,
      };
    });
  },

  updateStats: (speakerId, wordCount, durationMs, newSegment = true) => {
    set((s) => {
      const existing = s.speakers[speakerId];
      if (!existing) return s;
      const stats: SpeakerStats = {
        segment_count: existing.stats.segment_count + (newSegment ? 1 : 0),
        word_count: existing.stats.word_count + wordCount,
        talk_time_ms: existing.stats.talk_time_ms + durationMs,
        last_spoke_ms: Date.now(),
      };
      return {
        speakers: {
          ...s.speakers,
          [speakerId]: { ...existing, stats },
        },
      };
    });
  },

  getSpeaker: (speakerId) => {
    return get().speakers[speakerId];
  },

  getSpeakerColor: (speakerId) => {
    const state = get();
    const speaker = state.speakers[speakerId];
    if (speaker?.color) return speaker.color;
    const orderIndex = state.speakerOrder.indexOf(speakerId);
    return getSpeakerColor(speakerId, orderIndex >= 0 ? orderIndex : 0);
  },

  getSpeakerDisplayName: (speakerId) => {
    const speaker = get().speakers[speakerId];
    return speaker?.display_name ?? speakerId;
  },

  getAllSpeakers: () => {
    const { speakers, speakerOrder } = get();
    return speakerOrder
      .filter((id) => id in speakers)
      .map((id) => speakers[id]);
  },

  getRemoteSpeakers: () => {
    return Object.values(get().speakers).filter((s) => s.source === "remote_tag");
  },

  reset: () => {
    set({ speakers: {}, speakerOrder: [], pendingNaming: null });
  },
}));
