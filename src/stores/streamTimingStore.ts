// Timing of the live answer stream for the footer: when it started, when its
// first words came, whether the model is thinking, and how long the last
// answer took. Subscribes to the stream events itself (once per window), so
// the footer's live timer needs nothing from the stream buffer.

import { create } from "zustand";
import { onStreamEnd, onStreamError, onStreamStart, onStreamThinking, onStreamToken } from "../lib/events";
import { PAST_MEETING_MODES } from "../hooks/useStreamBuffer";

interface StreamTimingState {
  /** The live stream being timed; null when none is running. */
  requestId: string | null;
  startedAt: number | null;
  firstTokenAt: number | null;
  /** The backend reported thinking for the running stream. */
  thinking: boolean;
  /** Last finished answer: end-to-end time, and time to its first words. */
  lastLatencyMs: number | null;
  lastFirstTokenMs: number | null;
  init: () => void;
  reset: () => void;
}

let initialized = false;

const emptyTiming = {
  requestId: null,
  startedAt: null,
  firstTokenAt: null,
  thinking: false,
  lastLatencyMs: null,
  lastFirstTokenMs: null,
};

export const useStreamTimingStore = create<StreamTimingState>((set, get) => ({
  ...emptyTiming,
  reset: () => set(emptyTiming),

  init: () => {
    if (initialized) return;
    initialized = true;
    const mine = (requestId: string | null) => requestId != null && requestId === get().requestId;
    const subscriptions = [
      onStreamStart((e) => {
        if (!e.request_id || e.mode === "RagTest" || PAST_MEETING_MODES.has(e.mode)) return;
        set({ requestId: e.request_id, startedAt: Date.now(), firstTokenAt: null, thinking: false });
      }),
      onStreamThinking((e) => {
        if (mine(e.request_id)) set({ thinking: true });
      }),
      onStreamToken((e) => {
        if (mine(e.request_id) && get().firstTokenAt == null) set({ firstTokenAt: Date.now() });
      }),
      onStreamEnd((e) => {
        if (!mine(e.request_id)) return;
        const { startedAt, firstTokenAt } = get();
        const measured = startedAt != null && firstTokenAt != null ? firstTokenAt - startedAt : null;
        set({
          requestId: null,
          lastLatencyMs: e.latency_ms,
          lastFirstTokenMs: e.usage?.first_token_ms ?? measured,
        });
      }),
      onStreamError((e) => {
        if (mine(e.request_id)) set({ requestId: null });
      }),
    ];
    Promise.all(subscriptions).catch((err) => {
      initialized = false;
      console.warn("[streamTimingStore] Failed to listen for stream events:", err);
    });
  },
}));

/** Test-only: forget the subscription and the timings. */
export function resetStreamTimingForTests(): void {
  initialized = false;
  useStreamTimingStore.getState().reset();
}
