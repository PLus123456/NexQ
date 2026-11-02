import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  onStreamToken,
  onStreamEnd,
  onStreamError,
} from "../lib/events";
import { generateAssist, updateMeetingSummary } from "../lib/ipc";
import { assistSegments } from "../lib/assistSegments";
import { useMeetingStore, pastMeetingIdFor } from "../stores/meetingStore";
import type { Meeting } from "../lib/types";

export interface SummaryGenerationState {
  isGenerating: boolean;
  streamedContent: string;
  error: string | null;
  generate: () => Promise<void>;
  cancel: () => void;
}

export function useSummaryGeneration(
  meeting: Meeting | null,
  onSummaryGenerated?: (summary: string) => void
): SummaryGenerationState {
  const [isGenerating, setIsGenerating] = useState(false);
  const [streamedContent, setStreamedContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const contentRef = useRef("");
  // request_id of the generation this hook started (null when idle/cancelled)
  const requestIdRef = useRef<string | null>(null);
  const unlistenersRef = useRef<(() => void)[]>([]);

  // Cancel this view's request when leaving or switching meetings.
  useEffect(() => {
    setIsGenerating(false);
    setError(null);
    contentRef.current = "";
    setStreamedContent("");
    return () => {
      const requestId = requestIdRef.current;
      requestIdRef.current = null;
      if (requestId) invoke("cancel_generation", { requestId }).catch(() => {});
      unlistenersRef.current.forEach((fn) => fn());
      unlistenersRef.current = [];
    };
  }, [meeting?.id]);

  const generate = useCallback(async () => {
    if (!meeting || requestIdRef.current || isGenerating) return;

    setIsGenerating(true);
    setStreamedContent("");
    setError(null);
    contentRef.current = "";
    const requestId = crypto.randomUUID();
    requestIdRef.current = requestId;
    const isOurs = (id: string | null) =>
      id === requestId && requestIdRef.current === requestId;

    // Subscribe to stream events before triggering generation
    const cleanups: (() => void)[] = [];

    try {
      const unToken = await onStreamToken((event) => {
        if (!isOurs(event.request_id)) return;
        contentRef.current += event.token;
        setStreamedContent(contentRef.current);
      });
      cleanups.push(unToken);

      const unEnd = await onStreamEnd(async (event) => {
        if (!isOurs(event.request_id)) return;
        const content = contentRef.current;
        cleanups.forEach((fn) => fn());
        unlistenersRef.current = unlistenersRef.current.filter((fn) => !cleanups.includes(fn));

        // Persist summary to DB and refresh sidebar
        // A stopped stream is a normal stop: its partial output is not parsed or saved.
        if (!event.cancelled && meeting && content) {
          try {
            await updateMeetingSummary(meeting.id, content);
            if (!isOurs(requestId)) return;
            onSummaryGenerated?.(content);
            // Refresh sidebar so has_summary badge updates
            useMeetingStore.getState().loadRecentMeetings();
          } catch (err) {
            console.error("[summaryGeneration] Failed to persist summary:", err);
          }
        }

        if (!isOurs(requestId)) return;
        requestIdRef.current = null;
        setIsGenerating(false);
      });
      cleanups.push(unEnd);

      const unError = await onStreamError((event) => {
        if (!isOurs(event.request_id)) return;
        requestIdRef.current = null;
        setError(event.message);
        setIsGenerating(false);
        cleanups.forEach((fn) => fn());
        unlistenersRef.current = unlistenersRef.current.filter(
          (fn) => !cleanups.includes(fn)
        );
      });
      cleanups.push(unError);

      if (requestIdRef.current !== requestId) {
        cleanups.forEach((fn) => fn());
        return;
      }
      unlistenersRef.current.push(...cleanups);

      // Pass the meeting's transcript directly to bypass empty transcriptStore
      // (diarized lines labelled with their person's name)
      const segments = assistSegments(
        meeting.transcript.filter((s) => s.is_final),
        false,
        meeting.speakers
      );

      await generateAssist("MeetingSummary", undefined, {
        requestId,
        transcriptSegments: segments,
        pastMeetingId: pastMeetingIdFor(meeting),
      });
    } catch (err) {
      cleanups.forEach((fn) => fn());
      unlistenersRef.current = unlistenersRef.current.filter((fn) => !cleanups.includes(fn));
      if (requestIdRef.current !== requestId) return;
      requestIdRef.current = null;
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setIsGenerating(false);
    }
  }, [meeting, isGenerating, onSummaryGenerated]);

  const cancel = useCallback(async () => {
    const requestId = requestIdRef.current;
    requestIdRef.current = null;
    unlistenersRef.current.forEach((fn) => fn());
    unlistenersRef.current = [];
    setIsGenerating(false);
    if (!requestId) return;
    try {
      await invoke("cancel_generation", { requestId });
    } catch {
      // Non-critical
    }
  }, []);

  return {
    isGenerating,
    streamedContent,
    error,
    generate,
    cancel,
  };
}
