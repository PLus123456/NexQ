import { useEffect } from "react";
import { onQuestionDetectionLog } from "../lib/questionDetection/events";
import { useCallLogStore } from "../stores/callLogStore";

/** The backend emits this separate event only when diagnostic logging is on.
 * It never enters the answer stream or changes the active Assist request. */
export function useQuestionDetectionLog() {
  useEffect(() => {
    const listener = onQuestionDetectionLog((event) => {
      useCallLogStore.getState().beginEntry({
        id: event.id,
        timestamp: event.timestamp_ms,
        mode: "question_detect",
        model: event.model,
        provider: event.provider,
        status: event.error ? "error" : "complete",
        startedAt: event.timestamp_ms,
        firstTokenAt: null,
        completedAt: event.timestamp_ms + event.latency_ms,
        totalTokens: null,
        latencyMs: event.latency_ms,
        responseContent: event.response,
        responseContentClean: event.response,
        actualSystemPrompt: event.system_prompt,
        actualUserPrompt: event.user_prompt,
        includeTranscript: true,
        includeRag: false,
        includeInstructions: false,
        includeQuestion: true,
        temperature: 0,
        ragQuery: null,
        ragChunks: [],
        ragChunksFiltered: 0,
        ragTotalCandidates: 0,
        transcriptWindowSeconds: 90,
        transcriptSegmentsCount: null,
        transcriptSegmentsTotal: null,
        snapshotTranscript: "",
        snapshotContext: "",
        reconstructedSystemPrompt: "",
        errorMessage: event.error,
      });
    });
    return () => { listener.then((unlisten) => unlisten()); };
  }, []);
}
