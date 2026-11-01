// src/hooks/useAutoTranslate.ts
// Live translation of the meeting transcript. Mounted at App level, it works
// only in the overlay window (where the meeting is shown and translation is
// switched on), so it keeps translating while that window shows settings.
// Each final line is translated once it settles (SettleScheduler), only for
// the parties chosen in the translation settings, and never for a party whose
// STT engine translates by itself (Soniox: its `translation_result` events
// are shown by useTranslationEvents).
//
// One subscription per window however many components mount the hook: two
// listeners used to translate every line twice.
import { useEffect } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { onTranscriptFinal, onTranscriptUpdate } from "../lib/events";
import { translateSegments } from "../lib/ipc";
import { LIVE_MAX_WAIT_MS } from "../lib/translation/defaults";
import {
  partyConfig,
  partyOfSpeaker,
  partySourceLanguage,
  partyUsesNativeTranslation,
} from "../lib/translation/nativeTranslation";
import { SettleScheduler, type SettleLine } from "../lib/translation/settleScheduler";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";
import {
  errorMessage,
  notifyTranslationError,
  useTranslationStore,
} from "../stores/translationStore";

/** Is this line to be translated by the pipeline right now? */
function wanted(line: SettleLine): boolean {
  const translation = useTranslationStore.getState();
  const meeting = useMeetingStore.getState();
  if (!translation.autoTranslateActive || !translation.targetLang || !meeting.activeMeeting?.id) return false;
  const party = partyOfSpeaker(line.speaker);
  // In person, the room is the only party: "User" lines aren't shown.
  if (party === "you" && meeting.audioMode === "in_person") return false;
  if (!translation.translateParties[party]) return false;
  return !partyUsesNativeTranslation(partyConfig(useConfigStore.getState().meetingAudioConfig, party));
}

function requestTranslation(line: SettleLine): void {
  const translation = useTranslationStore.getState();
  const meetingId = useMeetingStore.getState().activeMeeting?.id;
  if (!meetingId) return;
  const config = useConfigStore.getState();
  const source = partySourceLanguage(
    partyOfSpeaker(line.speaker),
    translation.sourceLang,
    config.meetingAudioConfig,
    config.sttLanguage,
  );
  translation.startLiveRequest(line.id, line.text);
  translateSegments([line.id], [line.text], meetingId, translation.targetLang, source).catch((err) => {
    const message = errorMessage(err);
    console.error("[useAutoTranslate] Auto-translate failed:", message);
    if (useTranslationStore.getState().failLiveRequest(line.id, line.text, message)) {
      notifyTranslationError(message);
    }
  });
}

/** Subscribes this window to live lines; returns the teardown. */
export function startAutoTranslate(): () => void {
  const scheduler = new SettleScheduler({
    settleMs: () => useTranslationStore.getState().liveSettleMs,
    maxWaitMs: LIVE_MAX_WAIT_MS,
    accepts: wanted,
    translate: requestTranslation,
  });
  let stopped = false;
  const unlisteners: UnlistenFn[] = [];

  void Promise.all([
    onTranscriptFinal(({ segment }) => {
      if (segment.is_final) scheduler.final({ id: segment.id, text: segment.text, speaker: segment.speaker });
    }),
    onTranscriptUpdate(({ segment }) => {
      scheduler.interim({ id: segment.id, speaker: segment.speaker });
    }),
  ]).then((subscriptions) => {
    if (stopped) subscriptions.forEach((unlisten) => unlisten());
    else unlisteners.push(...subscriptions);
  });

  // Lines of the previous meeting are dropped, not translated into the next one.
  const offMeeting = useMeetingStore.subscribe((state, previous) => {
    if (state.activeMeeting?.id !== previous.activeMeeting?.id) scheduler.dispose();
  });

  return () => {
    stopped = true;
    offMeeting();
    scheduler.dispose();
    unlisteners.forEach((unlisten) => unlisten());
  };
}

/** The window the meeting overlay runs in. */
export const AUTO_TRANSLATE_WINDOW = "overlay";

function isAutoTranslateWindow(): boolean {
  try {
    return getCurrentWebviewWindow().label === AUTO_TRANSLATE_WINDOW;
  } catch {
    return false; // not in a Tauri webview
  }
}

let users = 0;
let stop: (() => void) | null = null;

export function useAutoTranslate(): void {
  useEffect(() => {
    if (!isAutoTranslateWindow()) return;
    users += 1;
    if (users === 1) stop = startAutoTranslate();
    return () => {
      users -= 1;
      if (users === 0) {
        stop?.();
        stop = null;
      }
    };
  }, []);
}
