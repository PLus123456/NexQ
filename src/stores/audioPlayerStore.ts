import { create } from "zustand";
import { toElapsedMs } from "../lib/bookmarkTarget";

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

interface AudioPlayerState {
  // State
  isPlaying: boolean;
  currentTimeMs: number;
  durationMs: number;
  playbackSpeed: number;
  volume: number; // 0.0 to 3.0 (supports amplification beyond 100%)
  activeSegmentId: string | null;
  audioElement: HTMLAudioElement | null;
  gainNode: GainNode | null;

  // Sync context (set when loading a meeting)
  meetingStartMs: number;
  recordingOffsetMs: number;

  // Actions
  play: () => void;
  pause: () => void;
  /** Driven only by the <audio> element's playing/pause/ended events. */
  setIsPlaying: (playing: boolean) => void;
  toggle: () => void;
  seekToTime: (ms: number) => void;
  seekToTimestamp: (absoluteTimestampMs: number) => void;
  setPlaybackSpeed: (speed: number) => void;
  cycleSpeed: (direction: "up" | "down") => void;
  setVolume: (volume: number) => void;
  setAudioElement: (el: HTMLAudioElement | null) => void;
  setGainNode: (node: GainNode | null) => void;
  setDuration: (ms: number) => void;
  updateCurrentTime: (ms: number) => void;
  setActiveSegmentId: (id: string | null) => void;
  setSyncContext: (meetingStartMs: number, recordingOffsetMs: number) => void;
  reset: () => void;
}

export const useAudioPlayerStore = create<AudioPlayerState>((set, get) => ({
  // Initial state
  isPlaying: false,
  currentTimeMs: 0,
  durationMs: 0,
  playbackSpeed: 1,
  volume: 1.0,
  activeSegmentId: null,
  audioElement: null,
  gainNode: null,
  meetingStartMs: 0,
  recordingOffsetMs: 0,

  play: () => {
    const { audioElement } = get();
    if (audioElement) {
      // isPlaying is NOT set here: it follows the element's `playing` event, so a
      // missing/failed source never leaves the UI stuck in a "playing" state.
      audioElement.play().catch((err) => {
        console.warn("[audioPlayerStore] play() failed:", err);
      });
    }
  },

  pause: () => {
    const { audioElement } = get();
    if (audioElement) {
      // The element's `pause` event flips isPlaying.
      audioElement.pause();
    } else {
      set({ isPlaying: false });
    }
  },

  setIsPlaying: (playing: boolean) => {
    if (get().isPlaying !== playing) set({ isPlaying: playing });
  },

  toggle: () => {
    const { isPlaying } = get();
    if (isPlaying) {
      get().pause();
    } else {
      get().play();
    }
  },

  seekToTime: (ms: number) => {
    if (!Number.isFinite(ms)) return;
    const { audioElement, durationMs } = get();
    const clampedMs = Math.max(0, durationMs > 0 ? Math.min(ms, durationMs) : ms);
    if (audioElement) {
      audioElement.currentTime = clampedMs / 1000;
    }
    set({ currentTimeMs: clampedMs });
  },

  seekToTimestamp: (timestampMs: number) => {
    const { isPlaying, meetingStartMs, recordingOffsetMs } = get();
    if (!isPlaying) return;
    const audioMs = toElapsedMs(timestampMs, meetingStartMs) - recordingOffsetMs;
    get().seekToTime(audioMs);
  },

  setPlaybackSpeed: (speed: number) => {
    const { audioElement } = get();
    if (audioElement) {
      audioElement.playbackRate = speed;
    }
    set({ playbackSpeed: speed });
  },

  cycleSpeed: (direction: "up" | "down") => {
    const { playbackSpeed } = get();
    const currentIndex = SPEED_OPTIONS.indexOf(
      playbackSpeed as (typeof SPEED_OPTIONS)[number]
    );
    const idx = currentIndex === -1 ? 2 : currentIndex; // default to 1x
    let nextIndex: number;
    if (direction === "up") {
      // Wrap around: 2x → 0.5x
      nextIndex = (idx + 1) % SPEED_OPTIONS.length;
    } else {
      // Wrap around: 0.5x → 2x
      nextIndex = (idx - 1 + SPEED_OPTIONS.length) % SPEED_OPTIONS.length;
    }
    get().setPlaybackSpeed(SPEED_OPTIONS[nextIndex]);
  },

  setVolume: (volume: number) => {
    const clamped = Math.max(0, Math.min(2, volume));
    const { gainNode, audioElement } = get();
    if (gainNode) {
      // GainNode handles full range (0-2x)
      gainNode.gain.value = clamped;
    } else if (audioElement) {
      // Fallback: audio.volume only supports 0-1
      audioElement.volume = Math.min(1, clamped);
    }
    set({ volume: clamped });
  },

  setGainNode: (node: GainNode | null) => {
    const { audioElement, volume } = get();
    set({ gainNode: node });
    if (node) {
      node.gain.value = volume;
    }
    if (audioElement) audioElement.volume = node ? 1 : Math.min(1, volume);
  },

  setAudioElement: (el: HTMLAudioElement | null) => {
    set({ audioElement: el });
    if (el) {
      el.playbackRate = get().playbackSpeed;
      el.volume = get().gainNode ? 1 : Math.min(1, get().volume);
    }
  },

  setDuration: (ms: number) => {
    set({ durationMs: Number.isFinite(ms) && ms > 0 ? ms : 0 });
  },

  updateCurrentTime: (ms: number) => {
    if (Number.isFinite(ms) && ms >= 0) set({ currentTimeMs: ms });
  },

  setActiveSegmentId: (id: string | null) => {
    set({ activeSegmentId: id });
  },

  setSyncContext: (meetingStartMs: number, recordingOffsetMs: number) => {
    set({ meetingStartMs, recordingOffsetMs });
  },

  reset: () => {
    const { audioElement } = get();
    if (audioElement) {
      audioElement.pause();
      audioElement.src = "";
    }
    set({
      isPlaying: false,
      currentTimeMs: 0,
      durationMs: 0,
      playbackSpeed: 1,
      volume: 1.0,
      activeSegmentId: null,
      audioElement: null,
      gainNode: null,
      meetingStartMs: 0,
      recordingOffsetMs: 0,
    });
  },
}));
