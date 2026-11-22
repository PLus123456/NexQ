// Parties heard for a while this meeting without any transcript (see
// lib/sttWatchdog.ts). Logged once per party so a bug report's log shows it.
//
// State and the audio_level subscription are shared across mounted callers:
// OverlayView keeps watching while the transcript drawer is closed, and
// NoTranscriptBanner reads the same state as the drawer opens and closes.

import { useCallback, useEffect } from "react";
import { create } from "zustand";
import { onAudioLevel } from "../lib/events";
import { logToFile } from "../lib/logger";
import {
  EMPTY_WATCH,
  NO_TRANSCRIPT_AFTER_MS,
  addLevel,
  partyOfSource,
  partyOfSpeaker,
  shouldWarn,
  type Party,
  type PartyWatch,
} from "../lib/sttWatchdog";
import type { AudioLevelEvent } from "../lib/types";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useTranscriptStore } from "../stores/transcriptStore";

const NONE: Record<Party, boolean> = { you: false, them: false };

interface WatchUiState {
  heard: Record<Party, boolean>;
  dismissed: Record<Party, boolean>;
}

const useWatchUiStore = create<WatchUiState>(() => ({
  heard: { ...NONE },
  dismissed: { ...NONE },
}));

let watches: Record<Party, PartyWatch> = { you: EMPTY_WATCH, them: EMPTY_WATCH };
let logged: Record<Party, boolean> = { ...NONE };
let trackedMeetingId: string | null | undefined = undefined;
let consumerCount = 0;
let listenerGeneration = 0;
let listenerActive = false;
let unlistenAudio: (() => void) | null = null;

function resetWatchState(nextMeetingId: string | null | undefined = undefined) {
  watches = { you: EMPTY_WATCH, them: EMPTY_WATCH };
  logged = { ...NONE };
  trackedMeetingId = nextMeetingId;
  useWatchUiStore.setState({ heard: { ...NONE }, dismissed: { ...NONE } });
}

function handleAudioLevel(event: AudioLevelEvent) {
  const party = partyOfSource(event.source);
  const watch = addLevel(watches[party], event.level, Date.now());
  watches[party] = watch;
  if (watch.heardMs >= NO_TRANSCRIPT_AFTER_MS && !useWatchUiStore.getState().heard[party]) {
    useWatchUiStore.setState((s) => (s.heard[party] ? s : { heard: { ...s.heard, [party]: true } }));
  }
}

function stopAudioListener() {
  listenerGeneration++;
  listenerActive = false;
  const fn = unlistenAudio;
  unlistenAudio = null;
  fn?.();
}

function syncAudioListener() {
  const shouldListen = consumerCount > 0 && useMeetingStore.getState().isRecording;
  if (!shouldListen) {
    if (listenerActive) stopAudioListener();
    return;
  }
  if (listenerActive) return;
  listenerActive = true;
  const gen = ++listenerGeneration;
  onAudioLevel((event) => {
    if (gen !== listenerGeneration) return;
    handleAudioLevel(event);
  }).then((fn) => {
    if (gen === listenerGeneration && listenerActive) {
      unlistenAudio = fn;
    } else {
      fn();
    }
  });
}

export function useNoTranscriptWarning(): { parties: Party[]; dismiss: (party: Party) => void } {
  const isRecording = useMeetingStore((s) => s.isRecording);
  const meetingId = useMeetingStore((s) => s.activeMeeting?.id ?? null);
  const transcribedYou = useTranscriptStore((s) =>
    s.segments.some((segment) => partyOfSpeaker(segment.speaker) === "you"),
  );
  const transcribedThem = useTranscriptStore((s) =>
    s.segments.some((segment) => partyOfSpeaker(segment.speaker) === "them"),
  );
  const mutedYou = useConfigStore((s) => s.mutedYou);
  const mutedThem = useConfigStore((s) => s.mutedThem);
  const meetingAudioConfig = useConfigStore((s) => s.meetingAudioConfig);
  const heard = useWatchUiStore((s) => s.heard);
  const dismissed = useWatchUiStore((s) => s.dismissed);

  useEffect(() => {
    consumerCount++;
    syncAudioListener();
    return () => {
      consumerCount = Math.max(0, consumerCount - 1);
      if (consumerCount === 0) {
        stopAudioListener();
        resetWatchState(undefined);
      }
    };
  }, []);

  useEffect(() => {
    if (trackedMeetingId === undefined) {
      trackedMeetingId = meetingId;
    } else if (trackedMeetingId !== meetingId) {
      resetWatchState(meetingId);
    }
  }, [meetingId]);

  useEffect(() => {
    syncAudioListener();
  }, [isRecording, meetingId]);

  const parties = (["you", "them"] as Party[]).filter((party) => {
    const transcribed = party === "you" ? transcribedYou : transcribedThem;
    const muted = party === "you" ? mutedYou : mutedThem;
    return isRecording && heard[party] && !dismissed[party] && shouldWarn(watches[party], transcribed, muted);
  });

  const key = parties.join(",");
  useEffect(() => {
    for (const party of parties) {
      if (logged[party]) continue;
      logged[party] = true;
      const provider = meetingAudioConfig?.[party]?.stt_provider ?? "unknown";
      logToFile(
        "warn",
        "transcript",
        `'${party === "you" ? "You" : "Them"}' audio heard for ${NO_TRANSCRIPT_AFTER_MS / 1000}s but ${provider} returned no transcript`,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const dismiss = useCallback((party: Party) => {
    useWatchUiStore.setState((s) => (s.dismissed[party] ? s : { dismissed: { ...s.dismissed, [party]: true } }));
  }, []);

  return { parties, dismiss };
}
