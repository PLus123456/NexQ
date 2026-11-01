// src/hooks/useTranslationEvents.ts
// Translation events → translationStore, in every window (App level): results
// (the pipeline's and the STT engine's own, e.g. Soniox), errors, batch
// progress, the backend's provider status, and the saved translations of the
// active meeting. Requesting translations is useAutoTranslate's job.
import { useEffect } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  onTranslationResult,
  onTranslationError,
  onBatchTranslationProgress,
} from "../lib/events";
import { onTranslationBackendStatus } from "../lib/translation/events";
import { getMeetingTranslations } from "../lib/ipc";
import { useTranslationStore } from "../stores/translationStore";
import { useMeetingStore } from "../stores/meetingStore";

export function useTranslationEvents() {
  const meetingId = useMeetingStore((s) => s.activeMeeting?.id ?? null);
  const targetLang = useTranslationStore((s) => s.targetLang);

  // Subscribe to translation result/error/progress/status events
  useEffect(() => {
    let mounted = true;
    const unlisteners: UnlistenFn[] = [];

    const setup = async () => {
      const subscriptions = await Promise.all([
        onTranslationResult((result) => {
          if (mounted) useTranslationStore.getState().addTranslation(result);
        }),
        onTranslationError((error) => {
          if (!mounted) return;
          console.warn("[translation] Error:", error.error, error.segment_id);
          // Clears the line's spinner and shows why it failed.
          useTranslationStore.getState().handleTranslationError(error);
        }),
        onBatchTranslationProgress((progress) => {
          if (!mounted) return;
          useTranslationStore.getState().setBatchProgress(
            progress.completed >= progress.total ? null : progress,
          );
        }),
        onTranslationBackendStatus((status) => {
          if (mounted) useTranslationStore.getState().setBackendStatus(status);
        }),
      ]);
      if (mounted) unlisteners.push(...subscriptions);
      else subscriptions.forEach((unlisten) => unlisten());
    };

    setup();

    return () => {
      mounted = false;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, []);

  // Preload cached translations when meeting ID or target language changes
  useEffect(() => {
    if (!meetingId || !targetLang) return;
    getMeetingTranslations(meetingId, targetLang)
      .then((cached) => {
        if (cached.length > 0) {
          useTranslationStore.getState().addTranslations(cached);
        }
      })
      .catch((err) =>
        console.warn("[useTranslationEvents] Failed to preload translations:", err),
      );
  }, [meetingId, targetLang]);
}
