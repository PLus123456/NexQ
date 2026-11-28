// ============================================================================
// useCallLogCapture — Subscribes to LLM stream events and records them
// in callLogStore. Now captures ACTUAL prompt data from backend events
// instead of reconstructing from frontend stores.
// ============================================================================

import { useEffect, useState } from "react";
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
import { createEventScope } from "../lib/eventScope";
import { stripThinkTags } from "../lib/utils";
import type { AIInteraction, IntelligenceMode, LogEntry } from "../lib/types";

/**
 * With nothing at all arriving for this long, an entry shows "No response
 * yet". It is not failed: a slow answer's late tokens and end still land.
 */
export const STALL_TIMEOUT_MS = 120_000;

type CapturedAnswer = { meetingId: string; mode: IntelligenceMode; entry: LogEntry; response: string };
type PendingHistory = { entries: Map<string, AIInteraction>; write: Promise<void> };

const activeAnswers = new Map<string, CapturedAnswer>();
const pendingHistory = new Map<string, PendingHistory>();

function queueAnswer({ meetingId, mode, entry, response }: CapturedAnswer, cancelled: boolean, latency: number) {
  const clean = stripThinkTags(response) || response;
  if (cancelled && !clean) return;
  let history = pendingHistory.get(meetingId);
  if (!history) {
    history = { entries: new Map(), write: Promise.resolve() };
    pendingHistory.set(meetingId, history);
  }
  history.entries.set(entry.id, {
    id: entry.id,
    meeting_id: meetingId,
    mode,
    question_context: entry.actualUserPrompt || "",
    response: clean,
    model: entry.model,
    provider: entry.provider,
    latency_ms: latency,
    timestamp: new Date(entry.timestamp).toISOString(),
  });
}

function writePendingHistory(meetingId: string): Promise<void> {
  const history = pendingHistory.get(meetingId);
  if (!history) return Promise.resolve();
  const write = history.write.catch(() => {}).then(async () => {
    const batch = [...history.entries.values()];
    if (batch.length === 0) return;
    await saveMeetingAiInteractions(meetingId, JSON.stringify(batch));
    for (const interaction of batch) {
      if (history.entries.get(interaction.id) === interaction) history.entries.delete(interaction.id);
    }
  });
  history.write = write;
  void write.then(() => {
    if (history.write === write && history.entries.size === 0) pendingHistory.delete(meetingId);
  }, () => {});
  return write;
}

/** Flush writes already in flight and retain a partial answer if cancellation has yet to arrive. */
export async function flushMeetingAiHistory(meetingId: string): Promise<void> {
  for (const answer of activeAnswers.values()) {
    if (answer.meetingId === meetingId) queueAnswer(answer, true, Date.now() - answer.entry.startedAt);
  }
  await writePendingHistory(meetingId);
}

export function useCallLogCapture(persistHistory = true) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const scope = createEventScope("Call Log");
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

    void Promise.all([
      scope.add(onStreamStart, (event) => {
        if (event.mode === "RagTest") return;
        const requestId = event.request_id;
        if (!requestId || entryIds.has(requestId)) return;
        const id = crypto.randomUUID();
        entryIds.set(requestId, id);

        const mode = event.mode;
        const startedAt = Date.now();

        const entry: LogEntry = {
          id,
          timestamp: startedAt,
          mode,
          provider: event.provider,
          model: event.model,
          status: "sending",
          startedAt,
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

        const meetingId = useMeetingStore.getState().activeMeeting?.id;
        if (persistHistory && meetingId && !PAST_MEETING_MODES.has(mode) &&
            !["question_detect", "question_predict", "question_prepare"].includes(mode)) {
          activeAnswers.set(requestId, { meetingId, mode, entry, response: "" });
        }
        useCallLogStore.getState().beginEntry(entry);
        armStallTimer(requestId, id);
      }),

      scope.add(onStreamToken, (event) => {
        if (!event.request_id) return;
        const entryId = entryIds.get(event.request_id);
        if (entryId) {
          clearStallTimer(event.request_id);
          const answer = persistHistory ? activeAnswers.get(event.request_id) : undefined;
          if (answer) answer.response += event.token;
          useCallLogStore.getState().appendToken(entryId, event.token);
        }
      }),

      // Thinking proves the model is working: the stall clock starts over.
      scope.add(onStreamThinking, (event) => {
        if (!event.request_id) return;
        const entryId = entryIds.get(event.request_id);
        if (entryId && timers.has(event.request_id)) armStallTimer(event.request_id, entryId);
      }),

      scope.add(onStreamEnd, (event) => {
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
        const answer = persistHistory ? activeAnswers.get(event.request_id) : undefined;
        if (answer) {
          activeAnswers.delete(event.request_id);
          queueAnswer(answer, !!event.cancelled, event.latency_ms);
          void writePendingHistory(answer.meetingId).catch((error) =>
            console.error("[Call Log] Failed to persist AI interaction:", error),
          );
        }
      }),

      scope.add(onStreamError, (event) => {
        if (!event.request_id) return;
        clearStallTimer(event.request_id);
        const entryId = entryIds.get(event.request_id);
        if (entryId) {
          entryIds.delete(event.request_id);
          if (persistHistory) activeAnswers.delete(event.request_id);
          useCallLogStore.getState().failEntry(entryId, event.message);
        }
      }),
    ]).then((results) => {
      if (scope.active()) setReady(results.every(Boolean));
    });

    return () => {
      scope.dispose();
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
      if (persistHistory) {
        for (const [requestId, entryId] of entryIds) {
          if (activeAnswers.get(requestId)?.entry.id === entryId) activeAnswers.delete(requestId);
        }
      }
    };
  }, [persistHistory]);

  return ready;
}
