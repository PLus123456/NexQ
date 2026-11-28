// Watches meetingAudioConfig changes during an active meeting
// and restarts the Rust audio capture pipeline with the new config.
// This enables "hot-swap" of STT provider and audio source mid-meeting.
//
// Debounce (300 ms), one restart at a time, and recheck settings after every
// restart so edits during an in-flight IPC call are never lost. A change of
// one side's language alone restarts only that side's speech-to-text.

import { useEffect } from "react";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useDevLogStore } from "../stores/devLogStore";
import { useTranslationStore } from "../stores/translationStore";
import { useCaptureSyncStore } from "../stores/captureSyncStore";
import { stopCapture, startCapturePerParty, setPartyLanguage, setTranslationLanguages } from "../lib/ipc";
import { sttProviderMeta } from "../lib/stt/providerMeta";
import { captureParties, skipYouStt } from "../lib/audioMode";
import { AUTO_DETECT_REFUSAL_PREFIX, autoDetectRefusalSentences } from "../lib/sttLanguages";
import { captureKey as audioConfigKey, languageOnlyChange, overrideKey } from "../lib/audioConfigKeys";
import type { MeetingAudioConfig } from "../lib/types";
import type { SonioxConfig } from "../lib/stt/types";
import { updateSonioxConfig } from "../lib/stt/ipc";
import { t } from "../i18n";

/**
 * What the running capture depends on besides the audio config itself: the
 * Soniox settings while a party uses Soniox, and the translation target when a
 * party's engine translates into it (Soniox with no target of its own reads the
 * translation settings' target when its session starts). Empty when neither applies.
 */
function engineSettingsKey(config: MeetingAudioConfig, translationTarget: string, sonioxConfig?: SonioxConfig): string {
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
  if (!followsTarget && !(usesSoniox && sonioxConfig)) return "";
  return JSON.stringify({
    ...(usesSoniox && sonioxConfig ? { sonioxConfig } : {}),
    ...(followsTarget ? { translationTarget } : {}),
  });
}

/**
 * What the running capture was started with: the audio config and which sides
 * are on Auto-detect (the shared language can switch that without touching the
 * config), plus the engine settings above.
 */
export function captureKey(
  config: MeetingAudioConfig,
  translationTarget: string,
  sonioxConfig?: SonioxConfig,
  sharedLanguage = "",
): string {
  return audioConfigKey(config, sharedLanguage) + engineSettingsKey(config, translationTarget, sonioxConfig);
}

/** "you=deepgram [es-ES], them=whisper_cpp(small)" for the Dev Log. */
function describeConfig(config: MeetingAudioConfig): string {
  const side = (party: MeetingAudioConfig["you"]) =>
    party.stt_provider +
    (party.local_model_id ? `(${party.local_model_id})` : "") +
    (party.language ? ` [${party.language}]` : "");
  return `you=${side(config.you)}, them=${side(config.them)}`;
}

export function useAudioConfigSync() {
  const isRecording = useMeetingStore((s) => s.isRecording);
  const isEndingMeeting = useMeetingStore((s) => s.isEndingMeeting);
  const meetingId = useMeetingStore((s) => s.activeMeeting?.id);

  useEffect(() => {
    if (!isRecording || isEndingMeeting) return;

    const snapshot = () => {
      const { meetingAudioConfig: config, sttLanguage: shared, sonioxConfig } = useConfigStore.getState();
      const { targetLang, sourceLang } = useTranslationStore.getState();
      if (!config) return null;
      // Recording is toggled directly in Rust. It shares the running capture.
      const captureConfig = { ...config, recording_enabled: false };
      return {
        config: captureConfig,
        // The shared language decides which sides are on Auto-detect, so it can call for a restart too.
        shared,
        sonioxConfig,
        targetLang,
        sourceLang,
        engineKey: engineSettingsKey(config, targetLang, sonioxConfig),
        key: captureKey(captureConfig, targetLang, sonioxConfig, shared),
      };
    };
    type Snapshot = NonNullable<ReturnType<typeof snapshot>>;
    const youSkipped = () => skipYouStt(useMeetingStore.getState().audioMode);
    // Web Speech listens once the capture has settled on the config that applies to its side.
    const settle = (settled: Snapshot) =>
      useCaptureSyncStore.getState().setSettledOverrideKey(overrideKey(settled.config, settled.shared, youSkipped()));

    // What the capture runs with (the meeting just started with it); null when
    // that is unknown: no config yet, or the last restart failed.
    let applied: Snapshot | null = snapshot();
    let desiredKey = applied?.key ?? null;
    if (applied) settle(applied);
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
      let attempted: Snapshot | null = null;
      try {
        while (active()) {
          const next = snapshot();
          if (!next) break;
          if (next.key === applied?.key) {
            // The edit was taken back: what runs is what is wanted.
            settle(next);
            break;
          }
          attempted = next;
          log("info", "config", `STT config changed → ${describeConfig(next.config)}`);
          const skipYou = youSkipped();
          // Only one side's language changed: restart just that side's speech-to-text, so the
          // other side and the recording keep going. Anything else (the engine settings
          // included), or a side Rust can't restart on its own, takes the full swap below.
          const side = applied && applied.engineKey === next.engineKey
            ? languageOnlyChange({ cfg: applied.config, shared: applied.shared }, { cfg: next.config, shared: next.shared })
            : null;
          let swapped = false;
          if (side) {
            try {
              log("info", "config", `Language change: restarting only the ${side} side's STT...`);
              const sides = captureParties(next.config.you, next.config.them, useMeetingStore.getState().audioMode);
              swapped = await setPartyLanguage(side, sides[side], { skipYouStt: skipYou, expectedMeetingId: meetingId });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              // A refusal would be the same for a full swap, and nothing was stopped.
              if (msg.startsWith(AUTO_DETECT_REFUSAL_PREFIX)) throw err;
              log("warn", "config", `One-side restart failed (${msg}) — restarting the whole capture`);
            }
            if (!active()) break;
          }
          if (!swapped) {
            // Await the settings IPC too: a slow save must not start a new session
            // using the previous Soniox config or translation target.
            if ([next.config.you, next.config.them].some((party) => party.stt_provider === "soniox")) {
              await updateSonioxConfig(next.sonioxConfig);
              await setTranslationLanguages(next.targetLang, next.sourceLang === "auto" ? undefined : next.sourceLang);
            }
            if (!active()) break;
            // Rust checks the new STT configuration before it replaces the running capture
            // (and stops that one itself), so a refused swap leaves the meeting as it was.
            log("info", "config", "Hot-swap: starting new capture pipeline...");
            const sides = captureParties(next.config.you, next.config.them, useMeetingStore.getState().audioMode);
            await startCapturePerParty(sides.you, sides.them, {
              skipYouStt: skipYou,
              ...(meetingId ? { expectedMeetingId: meetingId } : {}),
            });
            if (!active()) {
              // End/unmount can happen while the start IPC is in flight.
              await stopCapture(false, meetingId);
              break;
            }
          }
          applied = next;
          // Web Speech may listen again now.
          settle(next);
          log("info", "config", swapped
            ? `Language change complete — ${side} STT restarted`
            : "Hot-swap complete — new STT pipeline active");
          // An edit during the swap is consumed here, without needing another render.
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("error", "config", `Hot-swap FAILED: ${msg}`);
        // Rust says "Auto-detect doesn't work with ..." before it stops anything, so the
        // old capture is still running: `applied` stays, and switching back to that config
        // won't restart capture. Any other failure may have stopped the capture: what runs
        // is unknown, so the next change restarts the whole capture.
        const refused = msg.startsWith(AUTO_DETECT_REFUSAL_PREFIX);
        if (!refused) applied = null;
        if (active()) {
          // Web Speech may start again, whether or not the swap went through.
          if (attempted) settle(attempted);
          const warning = refused
            ? t("misc:hooks.audioConfigSync.autoDetectRefused", { detail: autoDetectRefusalSentences(msg).join(" ") || msg })
            : t("misc:hooks.audioConfigSync.switchFailed", { detail: msg });
          import("@tauri-apps/api/event")
            .then(({ emit }) => emit("capture_warning", warning))
            .catch(() => {});
        }
      } finally {
        restarting = false;
        // A change that arrived while a failed swap was running is still to be applied.
        const latestKey = snapshot()?.key ?? null;
        if (active() && !timer && latestKey && latestKey !== applied?.key && latestKey !== attempted?.key) {
          timer = setTimeout(() => { void restart(); }, 300);
        }
      }
    };
    const schedule = () => {
      const current = snapshot();
      const nextKey = current?.key ?? null;
      // Translation results and unrelated settings updates must not postpone
      // a pending restart indefinitely while speech keeps arriving.
      if (nextKey === desiredKey) return;
      desiredKey = nextKey;
      if (timer) clearTimeout(timer);
      timer = null;
      if (!active() || restarting) return;
      if (nextKey === (applied?.key ?? null)) {
        // Back on what is running: nothing to restart, and Web Speech need not wait.
        if (current) settle(current);
        return;
      }
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

  // Once the meeting is over nothing keeps Web Speech in step with the capture.
  useEffect(() => {
    if (!isRecording) useCaptureSyncStore.getState().setSettledOverrideKey(null);
  }, [isRecording]);
}
