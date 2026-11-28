/**
 * Real-time speech-to-text using the Web Speech API (SpeechRecognition).
 *
 * Works in Tauri's WebView2 (Chromium-based) on Windows.
 * Produces interim results that stream into the current segment,
 * and final results when the speaker pauses — creating a new block.
 *
 * Web Speech always uses the browser's default mic (overridden via
 * IPolicyConfig when needed). The speaker label is determined by which
 * party has web_speech selected — YOU and THEM are treated identically.
 */

import { useEffect, useRef } from "react";
import { emit } from "@tauri-apps/api/event";
import { useMeetingStore } from "../stores/meetingStore";
import { useTranscriptStore } from "../stores/transcriptStore";
import { useConfigStore } from "../stores/configStore";
import { AUTO_STT_LANGUAGE, sideLanguage } from "../lib/sttLanguages";
import { pushTranscript, ensureIpolicyOverride } from "../lib/ipc";
import { registerWebSpeechStop } from "../lib/webSpeechLifecycle";
import { overrideKey } from "../lib/audioConfigKeys";
import { useCaptureSyncStore } from "../stores/captureSyncStore";
import { t } from "../i18n";

// Web Speech API types (not in all TS libs)
interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionResultList {
  length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: Event & { error: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

declare global {
  interface Window {
    SpeechRecognition: new () => SpeechRecognitionInstance;
    webkitSpeechRecognition: new () => SpeechRecognitionInstance;
  }
}

/** Determine speaker label from config — whichever party has web_speech gets the label. */
function getSpeakerLabel(cfg: ReturnType<typeof useConfigStore.getState>["meetingAudioConfig"]): "User" | "Them" {
  if (!cfg) return "User";
  // If THEM has web_speech → label as "Them"
  if (cfg.them.stt_provider === "web_speech" && cfg.them.is_input_device) return "Them";
  // Default: label as "User" (You party)
  return "User";
}

/**
 * The language Web Speech recognises: that of the side it transcribes, else the shared one.
 * Web Speech can't detect the language: on Auto-detect it stays silent (see the hook).
 */
function webSpeechLanguage(state: ReturnType<typeof useConfigStore.getState>): string {
  const cfg = state.meetingAudioConfig;
  const side = cfg ? (getSpeakerLabel(cfg) === "Them" ? cfg.them : cfg.you) : null;
  return sideLanguage(side, state.sttLanguage);
}

const TERMINAL_RECOGNITION_ERRORS = new Set([
  "not-allowed", "service-not-allowed", "audio-capture", "language-not-supported", "bad-grammar",
]);

/**
 * Hook that runs browser-native speech recognition while a meeting is active.
 * Speaker label is determined by which party has web_speech configured —
 * YOU and THEM are treated identically.
 */
export function useSpeechRecognition() {
  const isRecording = useMeetingStore((s) => s.isRecording);
  const isEndingMeeting = useMeetingStore((s) => s.isEndingMeeting);
  const meetingId = useMeetingStore((s) => s.activeMeeting?.id);
  const speakerLabel = useConfigStore((s) => getSpeakerLabel(s.meetingAudioConfig));
  const speakerId = speakerLabel === "User" ? "you" : "them";
  const muted = useConfigStore((s) => speakerId === "you" ? s.mutedYou : s.mutedThem);
  // This side's own language when it has one, else the shared transcription language.
  // A change restarts recognition.
  const sttLanguage = useConfigStore(webSpeechLanguage);

  const audioMode = useMeetingStore((s) => s.audioMode);

  // Derive a stable boolean — only re-runs when web_speech status changes.
  // In in-person mode, SKIP web_speech for the "you" party — room mic captures everyone.
  // Only use web_speech if it's configured for the "them" (room) party in in-person mode.
  const usesWebSpeech = useConfigStore((s) => {
    const cfg = s.meetingAudioConfig;
    if (!cfg) return false;
    const youIsWebSpeech = cfg.you.stt_provider === "web_speech" && cfg.you.is_input_device;
    const themIsWebSpeech = cfg.them.stt_provider === "web_speech" && cfg.them.is_input_device;
    if (audioMode === "in_person") {
      // In-person: only use web_speech for the room source (them), not for mic (you)
      return themIsWebSpeech;
    }
    return youIsWebSpeech || themIsWebSpeech;
  });

  // Web Speech listens to the OS default microphone, which Rust switches to the chosen one
  // when the capture starts. Wait for the capture to settle on the config that applies to
  // this side (leaving Auto-detect, say, which skipped the override), then listen.
  const wantedOverride = useConfigStore((s) => overrideKey(s.meetingAudioConfig, s.sttLanguage, audioMode === "in_person"));
  const settledOverride = useCaptureSyncStore((s) => s.settledOverrideKey);
  const captureReady = settledOverride === null || settledOverride === wantedOverride;

  const retiring = useRef<Promise<void> | null>(null);
  const instanceStarted = useRef(false);
  const silenced = useRef(false);
  const ranOnce = useRef(false);

  useEffect(() => {
    const hadInstance = instanceStarted.current;
    instanceStarted.current = false;
    const firstRun = isRecording && !ranOnce.current;
    ranOnce.current = isRecording;

    if (!isRecording || isEndingMeeting || !usesWebSpeech) {
      silenced.current = false;
      return;
    }
    if (sttLanguage === AUTO_STT_LANGUAGE) {
      if (!firstRun && !silenced.current) {
        const side = speakerId === "you" ? t("common:labels.you")
          : audioMode === "in_person" ? t("common:labels.room") : t("common:labels.them");
        void emit("capture_warning", hadInstance
          ? t("misc:hooks.webSpeech.autoDetect.stopped", { side })
          : t("misc:hooks.webSpeech.autoDetect.notTranscribed", { side }),
        ).catch(() => {});
      }
      silenced.current = true;
      return;
    }
    silenced.current = false;
    if (muted || !captureReady) return;

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    const prefix = crypto.randomUUID();
    let counter = 0;
    let recognition: SpeechRecognitionInstance | undefined;
    let running = false;
    let disposed = false;
    let aborted = false;
    let terminalError = false;
    let acceptingResults = true;
    let restartFailures = 0;
    let restartTimer: ReturnType<typeof setTimeout> | undefined;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    let stopping: Promise<void> | undefined;
    let resolveStop: (() => void) | undefined;
    const pendingWrites = new Set<Promise<unknown>>();
    const isMuted = () => {
      const cfg = useConfigStore.getState();
      return speakerId === "you" ? cfg.mutedYou : cfg.mutedThem;
    };
    const isCurrentMeeting = () => useMeetingStore.getState().activeMeeting?.id === meetingId;
    const mayStart = () => {
      const meeting = useMeetingStore.getState();
      const config = useConfigStore.getState();
      return !disposed && !stopping && !terminalError && !isMuted() &&
        meeting.isRecording && !meeting.isEndingMeeting && isCurrentMeeting() &&
        getSpeakerLabel(config.meetingAudioConfig) === speakerLabel && webSpeechLanguage(config) === sttLanguage;
    };
    const trackWrite = (write: Promise<unknown>) => {
      const pending = write.catch(() => {});
      pendingWrites.add(pending);
      void pending.finally(() => pendingWrites.delete(pending));
    };

    const finishStop = () => {
      acceptingResults = false;
      if (stopTimer) clearTimeout(stopTimer);
      resolveStop?.();
    };
    const drain = () => {
      acceptingResults = false;
      void Promise.allSettled([...pendingWrites]).then(finishStop);
    };
    const abort = () => {
      if (aborted) return;
      aborted = true;
      recognition?.abort();
    };
    const stop = (discard = false): Promise<void> => {
      if (discard) acceptingResults = false;
      if (stopping) return stopping;
      if (restartTimer) clearTimeout(restartTimer);
      stopping = new Promise<void>((resolve) => { resolveStop = resolve; });
      stopTimer = setTimeout(() => {
        acceptingResults = false;
        if (running) {
          try { abort(); } catch {}
        }
        finishStop();
      }, 2000);
      if (!running || !recognition) {
        drain();
      } else {
        try {
          if (discard) abort();
          else recognition.stop();
        } catch {
          drain();
        }
      }
      return stopping;
    };

    const scheduleRestart = () => {
      if (!mayStart() || restartTimer || restartFailures > 5) return;
      const delay = Math.min(300 * 2 ** restartFailures, 4000);
      restartTimer = setTimeout(() => {
        restartTimer = undefined;
        if (!mayStart()) return;
        void ensureIpolicyOverride().catch(() => {}).then(start);
      }, delay);
    };
    const start = () => {
      if (!mayStart() || !recognition) return;
      try {
        running = true;
        recognition.start();
        instanceStarted.current = true;
      } catch (error) {
        running = false;
        terminalError = error instanceof DOMException &&
          ["NotAllowedError", "NotFoundError", "SecurityError", "NotSupportedError"].includes(error.name);
        restartFailures += 1;
        scheduleRestart();
      }
    };

    const initialize = () => {
      if (!mayStart()) return;
      const instance = new SpeechRecognition();
      recognition = instance;
      instance.continuous = true;
      instance.interimResults = true;
      instance.maxAlternatives = 1;
      instance.lang = sttLanguage || "en-US";
      instance.onresult = (event: SpeechRecognitionEvent) => {
        if (!acceptingResults || isMuted() || !isCurrentMeeting()) return;
        restartFailures = 0;
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          const transcript = result[0].transcript.trim();
          if (!transcript) continue;
          const segment = {
            id: `web_${prefix}_${counter + 1}`,
            text: transcript,
            speaker: speakerLabel,
            speaker_id: speakerId,
            timestamp_ms: Date.now(),
            is_final: result.isFinal,
            confidence: result.isFinal ? result[0].confidence || 0.9 : 0,
          };
          useTranscriptStore.getState().updateInterimSegment(segment);
          trackWrite(emit(result.isFinal ? "transcript_final" : "transcript_update", { segment, meeting_id: meetingId }));
          if (result.isFinal) {
            counter += 1;
            trackWrite(pushTranscript(transcript, speakerLabel, segment.timestamp_ms, true, meetingId));
          }
        }
      };
      instance.onerror = ({ error }) => {
        if (stopping || error === "no-speech") return;
        terminalError ||= TERMINAL_RECOGNITION_ERRORS.has(error);
        restartFailures += 1;
        console.warn("[STT] Web Speech recognition error:", error);
      };
      instance.onend = () => {
        running = false;
        if (stopping) drain();
        else scheduleRestart();
      };
      start();
    };

    const unregisterStop = registerWebSpeechStop(() => stop(isMuted()));
    const unsubscribeMeeting = useMeetingStore.subscribe((state) => {
      if (state.isEndingMeeting) void stop(isMuted());
    });
    const previous = retiring.current;
    if (previous) void previous.then(initialize);
    else initialize();

    return () => {
      disposed = true;
      unsubscribeMeeting();
      const drainPrevious = stop(isMuted() || !isCurrentMeeting()).finally(unregisterStop);
      const allStopped = previous ? Promise.all([previous, drainPrevious]).then(() => {}) : drainPrevious;
      retiring.current = allStopped;
      void allStopped.then(() => {
        if (retiring.current === allStopped) retiring.current = null;
      });
    };
  }, [isRecording, isEndingMeeting, meetingId, usesWebSpeech, sttLanguage, captureReady, muted, speakerId, speakerLabel, audioMode]);
}
