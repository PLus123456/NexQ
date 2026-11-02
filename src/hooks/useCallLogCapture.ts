// ============================================================================
// useCallLogCapture — Subscribes to LLM stream events and records them
// in callLogStore. Now captures ACTUAL prompt data from backend events
// instead of reconstructing from frontend stores.
// ============================================================================

import { useEffect } from "react";
import { PAST_MEETING_MODES } from "./useStreamBuffer";
import {
  onStreamStart,
  onStreamToken,
  onStreamThinking,
  onStreamEnd,
  onStreamError,
} from "../lib/events";
import { useCallLogStore } from "../stores/callLogStore";
import { useMeetingStore } from "../stores/meetingStore";
import { saveMeetingAiInteractions } from "../lib/ipc";
import type { IntelligenceMode, LogEntry } from "../lib/types";

/**
 * With nothing at all arriving for this long, an entry shows "No response
 * yet". It is not failed: a slow answer's late tokens and end still land.
 */
export const STALL_TIMEOUT_MS = 120_000;

/** Entries worth keeping with the meeting: answered, or stopped part-way. */
function isPersistable(e: LogEntry): boolean {
  return !["question_detect", "question_predict", "question_prepare"].includes(e.mode) && !PAST_MEETING_MODES.has(e.mode) &&
    (e.status === "complete" || (e.status === "cancelled" && !!(e.responseContentClean || e.responseContent)));
}

export function useCallLogCapture() {
  useEffect(() => {
    const unlisteners: Array<Promise<() => void>> = [];
    // request_id → log entry id, kept until the stream's end or error.
    const entryIds = new Map<string, string>();
    // request_id → "no response yet" timer
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    const clearStallTimer = (requestId: string) => {
      const timer = timers.get(requestId);
      if (timer) {
        clearTimeout(timer);
        timers.delete(requestId);
      }
    };

    const armStallTimer = (requestId: string, entryId: string) => {
      clearStallTimer(requestId);
      timers.set(
        requestId,
        setTimeout(() => {
          timers.delete(requestId);
          useCallLogStore.getState().markStalled(entryId);
        }, STALL_TIMEOUT_MS)
      );
    };

    const persist = () => {
      const meetingId = useMeetingStore.getState().activeMeeting?.id;
      if (!meetingId) return;
      const interactions = useCallLogStore
        .getState()
        .entries.filter(isPersistable)
        .map((e) => ({
          id: e.id,
          meeting_id: meetingId,
          mode: e.mode,
          question_context: e.actualUserPrompt || "",
          response: e.responseContentClean || e.responseContent,
          model: e.model,
          provider: e.provider,
          latency_ms: e.latencyMs ?? 0,
          timestamp: new Date(e.timestamp).toISOString(),
        }));
      if (interactions.length > 0) {
        saveMeetingAiInteractions(meetingId, JSON.stringify(interactions)).catch((err) =>
          console.error("[callLogCapture] Failed to persist AI interactions:", err)
        );
      }
    };

    unlisteners.push(
      onStreamStart((event) => {
        const requestId = event.request_id;
        if (!requestId) return;
        const id = crypto.randomUUID();
        entryIds.set(requestId, id);

        const mode = event.mode as IntelligenceMode;

        const entry: LogEntry = {
          id,
          timestamp: Date.now(),
          mode,
          provider: event.provider,
          model: event.model,
          status: "sending",
          startedAt: Date.now(),
          firstTokenAt: null,
          completedAt: null,
          totalTokens: null,
          latencyMs: null,
          usage: null,
          sessionKey: event.session_key ?? null,
          scopeLabel: event.scope_label ?? null,
          responseContent: "",
          responseContentClean: "",
          // Actual prompt data from backend
          actualSystemPrompt: event.system_prompt,
          actualUserPrompt: event.user_prompt,
          // Context source flags
          includeTranscript: event.include_transcript,
          includeRag: event.include_rag,
          includeInstructions: event.include_instructions,
          includeQuestion: event.include_question,
          // Enriched metadata
          temperature: event.temperature ?? null,
          ragQuery: event.rag_query ?? null,
          ragChunks: event.rag_chunks ?? [],
          ragChunksFiltered: event.rag_chunks_filtered ?? 0,
          ragTotalCandidates: event.rag_total_candidates ?? 0,
          transcriptWindowSeconds: event.transcript_window_seconds ?? null,
          transcriptSegmentsCount: event.transcript_segments_count ?? null,
          transcriptSegmentsTotal: event.transcript_segments_total ?? null,
          // Legacy fields (empty for new entries)
          snapshotTranscript: "",
          snapshotContext: "",
          reconstructedSystemPrompt: "",
          errorMessage: null,
        };

        useCallLogStore.getState().beginEntry(entry);
        armStallTimer(requestId, id);
      })
    );

    unlisteners.push(
      onStreamToken((event) => {
        if (!event.request_id) return;
        const entryId = entryIds.get(event.request_id);
        if (entryId) {
          clearStallTimer(event.request_id);
          useCallLogStore.getState().appendToken(entryId, event.token);
        }
      })
    );

    // Thinking proves the model is working: the stall clock starts over.
    unlisteners.push(
      onStreamThinking((event) => {
        if (!event.request_id) return;
        const entryId = entryIds.get(event.request_id);
        if (entryId && timers.has(event.request_id)) armStallTimer(event.request_id, entryId);
      })
    );

    unlisteners.push(
      onStreamEnd((event) => {
        if (!event.request_id) return;
        clearStallTimer(event.request_id);
        const entryId = entryIds.get(event.request_id);
        if (!entryId) return;
        entryIds.delete(event.request_id);
        const store = useCallLogStore.getState();
        if (event.cancelled) {
          store.cancelEntry(entryId, event.latency_ms);
        } else {
          store.completeEntry(entryId, event.total_tokens, event.latency_ms, event.usage ?? null);
        }
        // Immediately persist all answered AI interactions to DB (crash protection)
        persist();
      })
    );

    unlisteners.push(
      onStreamError((event) => {
        if (!event.request_id) return;
        clearStallTimer(event.request_id);
        const entryId = entryIds.get(event.request_id);
        if (entryId) {
          entryIds.delete(event.request_id);
          useCallLogStore.getState().failEntry(entryId, event.message);
        }
      })
    );

    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
      entryIds.clear();
      unlisteners.forEach((p) => p.then((unlisten) => unlisten()));
    };
  }, []);
}
