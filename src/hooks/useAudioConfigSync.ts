// Watches meetingAudioConfig changes during an active meeting
// and restarts the Rust audio capture pipeline with the new config.
// This enables "hot-swap" of STT provider and audio source mid-meeting.
//
// Debounce (300 ms), one restart at a time, and recheck settings after every
// restart so edits during an in-flight IPC call are never lost.

import { useEffect } from "react";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useDevLogStore } from "../stores/devLogStore";
import { useTranscriptStore } from "../stores/transcriptStore";
import { useTranslationStore } from "../stores/translationStore";
import { stopCapture, startCapturePerParty, setTranslationLanguages } from "../lib/ipc";
import { sttProviderMeta } from "../lib/stt/providerMeta";
import type { MeetingAudioConfig } from "../lib/types";
import type { SonioxConfig } from "../lib/stt/types";
import { updateSonioxConfig } from "../lib/stt/ipc";

/**
 * What the running capture depends on: the audio config, plus the translation
 * target when a party's engine translates into it (Soniox with no target of
 * its own reads the translation settings' target when its session starts).
 */
export function captureKey(config: MeetingAudioConfig, translationTarget: string, sonioxConfig?: SonioxConfig): string {
  const followsTarget = (["you", "them"] as const).some((role) => {
    const party = config[role];
    const native = party.native_translation;
    return (
      !!sttProviderMeta(party.stt_provider)?.supportsNativeTranslation &&
      native?.mode === "one_way" &&
      !native.target_language?.trim()
    );
  });
  const usesSoniox = config.you.stt_provider === "soniox" || config.them.stt_provider === "soniox";
  return JSON.stringify(usesSoniox && sonioxConfig
    ? { config, sonioxConfig, ...(followsTarget ? { translationTarget } : {}) }
    : followsTarget ? { config, translationTarget } : config);
}

export function useAudioConfigSync() {
  const isRecording = useMeetingStore((s) => s.isRecording);
  const isEndingMeeting = useMeetingStore((s) => s.isEndingMeeting);
  const meetingId = useMeetingStore((s) => s.activeMeeting?.id);

  useEffect(() => {
    if (!isRecording || isEndingMeeting) return;

    const snapshot = () => {
      const { meetingAudioConfig: config, sonioxConfig } = useConfigStore.getState();
      const { targetLang, sourceLang } = useTranslationStore.getState();
      return config ? { config, sonioxConfig, targetLang, sourceLang,
        key: captureKey(config, targetLang, sonioxConfig) } : null;
    };
    let appliedKey = snapshot()?.key ?? null;
    let desiredKey = appliedKey;
    let cancelled = false;
    let restarting = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const active = () => {
      const state = useMeetingStore.getState();
      return !cancelled && state.isRecording && !state.isEndingMeeting && state.activeMeeting?.id === meetingId;
    };
    const log = useDevLogStore.getState().addEntry;

    const restart = async () => {
      timer = null;
      // The in-progress restart reads the latest settings again when it finishes.
      if (restarting || !active()) return;
      restarting = true;
      try {
        while (active()) {
          const next = snapshot();
          if (!next || next.key === appliedKey) break;
          useTranscriptStore.getState().finalizeAllInterim();
          log("info", "config", "Hot-swap: stopping current capture...");
          await stopCapture(true, meetingId);
          if (!active()) break;
          // Give the native audio devices time to release before reopening them.
          await new Promise((resolve) => setTimeout(resolve, 200));
          if (!active()) break;
          const fresh = snapshot();
          if (!fresh) break;
          // Await the settings IPC too: a slow save must not start a new session
          // using the previous Soniox config or translation target.
          if ([fresh.config.you, fresh.config.them].some((party) => party.stt_provider === "soniox")) {
            await updateSonioxConfig(fresh.sonioxConfig);
            await setTranslationLanguages(fresh.targetLang, fresh.sourceLang === "auto" ? undefined : fresh.sourceLang);
          }
          if (!active()) break;
          await startCapturePerParty(fresh.config.you, fresh.config.them, meetingId);
          if (!active()) {
            // End/unmount can happen while the start IPC is in flight.
            await stopCapture(false, meetingId);
            break;
          }
          appliedKey = fresh.key;
          log("info", "config", "Hot-swap complete — new STT pipeline active");
          // An edit during stop/start is consumed here, without needing another render.
        }
      } catch (err) {
        log("error", "config", `Hot-swap FAILED: ${err instanceof Error ? err.message : String(err)}`);
        // Keep the failed config unapplied so a later edit can retry.
        appliedKey = null;
      } finally {
        restarting = false;
      }
    };
    const schedule = () => {
      const nextKey = snapshot()?.key ?? null;
      // Translation results and unrelated settings updates must not postpone
      // a pending restart indefinitely while speech keeps arriving.
      if (nextKey === desiredKey) return;
      desiredKey = nextKey;
      if (timer) clearTimeout(timer);
      timer = null;
      if (!active() || snapshot()?.key === appliedKey || restarting) return;
      timer = setTimeout(() => { void restart(); }, 300);
    };
    const unsubscribeConfig = useConfigStore.subscribe(schedule);
    const unsubscribeTranslation = useTranslationStore.subscribe(schedule);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      unsubscribeConfig();
      unsubscribeTranslation();
    };
  }, [isRecording, isEndingMeeting, meetingId]);
}
