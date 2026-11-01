import { AlertTriangle, X } from "lucide-react";
import { Trans, useT } from "../i18n";
import { STT_LABELS } from "../lib/stt/providerMeta";
import { useNoTranscriptWarning } from "../hooks/useNoTranscriptWarning";
import { NO_TRANSCRIPT_AFTER_MS } from "../lib/sttWatchdog";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";

/** "Audio is coming in but this party's provider returns nothing" (per party). */
export function NoTranscriptBanner({ onOpenDevLog }: { onOpenDevLog?: () => void }) {
  const { t } = useT(["stt", "common"]);
  const { parties, dismiss } = useNoTranscriptWarning();
  const meetingAudioConfig = useConfigStore((s) => s.meetingAudioConfig);
  if (parties.length === 0) return null;

  return (
    <div className="mx-1 mb-1.5 space-y-1">
      {parties.map((party) => {
        const id = meetingAudioConfig?.[party].stt_provider ?? "";
        // Product names as they are; Remote Whisper is worded per UI language.
        const provider = !id
          ? t("stt:noTranscript.unknownEngine")
          : id === "openai_compat"
            ? t("stt:engines.openai_compat.label")
            : STT_LABELS[id] ?? id;
        const who = party === "you" ? t("common:labels.you") : t("common:labels.them");
        return (
          <div
            key={party}
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-2"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-meta leading-relaxed text-amber-200/80">
                <Trans
                  t={t}
                  i18nKey="stt:noTranscript.message"
                  values={{ party: who, seconds: NO_TRANSCRIPT_AFTER_MS / 1000, engine: provider }}
                  components={{ strong: <span className="font-semibold text-amber-400" /> }}
                />
              </p>
              <div className="mt-1 flex gap-3 text-meta font-medium">
                {onOpenDevLog && (
                  <button onClick={onOpenDevLog} className="text-amber-400 hover:text-amber-300">
                    {t("stt:noTranscript.openDevLog")}
                  </button>
                )}
                <button
                  onClick={() => useMeetingStore.getState().openSettings("meeting_audio")}
                  className="text-amber-400 hover:text-amber-300"
                >
                  {t("stt:noTranscript.changeEngine")}
                </button>
              </div>
            </div>
            <button
              onClick={() => dismiss(party)}
              className="rounded p-0.5 text-amber-200/50 hover:text-amber-200"
              aria-label={t("stt:noTranscript.dismiss", { party: who })}
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
