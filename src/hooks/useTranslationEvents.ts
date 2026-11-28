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
import { matchesTranslationTarget } from "../lib/translation/nativeTranslation";
import { getMeetingTranslations } from "../lib/ipc";
import { useTranslationStore } from "../stores/translationStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useConfigStore } from "../stores/configStore";

export function isCurrentTranslationScope(meetingId: string | undefined, targetLang: string | undefined): boolean {
  return !!meetingId && meetingId === useMeetingStore.getState().activeMeeting?.id
    && targetLang === useTranslationStore.getState().targetLang;
}

export function useTranslationEvents() {
  const meetingId = useMeetingStore((s) => s.activeMeeting?.id ?? null);
  const targetLang = useTranslationStore((s) => s.targetLang);

  // Subscribe to translation result/error/progress/status events
  useEffect(() => {
    let mounted = true;
    const unlisteners: UnlistenFn[] = [];

    const keep = (subscription: Promise<UnlistenFn>) => {
      void subscription.then((unlisten) => {
        if (mounted) unlisteners.push(unlisten);
        else unlisten();
      }).catch((err) => console.warn("[translation] Could not listen for events:", err));
    };
    const offMeeting = useMeetingStore.subscribe((state, previous) => {
      if (state.activeMeeting?.id !== previous.activeMeeting?.id) useTranslationStore.getState().clearTranslations();
    });

    [
      onTranslationResult((result) => {
        if (!mounted || !result.meeting_id || result.meeting_id !== useMeetingStore.getState().activeMeeting?.id) return;
        const translation = useTranslationStore.getState();
        if (matchesTranslationTarget(result, translation.targetLang, useConfigStore.getState().meetingAudioConfig)) {
          translation.addTranslation(result);
        }
      }),
      onTranslationError((error) => {
        if (!mounted || !isCurrentTranslationScope(error.meeting_id, error.target_lang)) return;
        console.warn("[translation] Error:", error.error, error.segment_id);
        useTranslationStore.getState().handleTranslationError(error);
      }),
      onBatchTranslationProgress((progress) => {
        if (!mounted || !isCurrentTranslationScope(progress.meetingId, progress.targetLang)) return;
        useTranslationStore.getState().setBatchProgress(
          progress.completed >= progress.total ? null : progress,
        );
      }),
      onTranslationBackendStatus((status) => {
        if (mounted) useTranslationStore.getState().setBackendStatus(status);
      }),
    ].forEach(keep);

    return () => {
      mounted = false;
      offMeeting();
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, []);

  // Preload cached translations when meeting ID or target language changes
  useEffect(() => {
    if (!meetingId || !targetLang) return;
    let mounted = true;
    getMeetingTranslations(meetingId, targetLang)
      .then((cached) => {
        if (mounted && cached?.length && isCurrentTranslationScope(meetingId, targetLang)) {
          const audio = useConfigStore.getState().meetingAudioConfig;
          useTranslationStore.getState().addTranslations(cached.filter((result) =>
            result.meeting_id === meetingId && matchesTranslationTarget(result, targetLang, audio),
          ));
        }
      })
      .catch((err) => {
        if (mounted) console.warn("[useTranslationEvents] Failed to preload translations:", err);
      });
    return () => { mounted = false; };
  }, [meetingId, targetLang]);
}
