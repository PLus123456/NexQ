// Soniox translates while it recognizes. This card puts that option where
// people look for translation providers: per party, whether Soniox
// translates it, and one click to move the party's recognition to Soniox
// with its translation on. It edits the same fields as the party picker
// (translateParties and the party's native_translation).

import { useEffect, useState } from "react";
import { CheckCircle, KeyRound, Languages } from "lucide-react";
import { useT } from "../../i18n";
import { useConfigStore } from "../../stores/configStore";
import { useTranslationStore } from "../../stores/translationStore";
import { useMeetingStore } from "../../stores/meetingStore";
import { hasApiKey } from "../../lib/ipc";
import { sttKeySlot, sttProviderMeta } from "../../lib/stt/providerMeta";
import {
  TRANSLATION_PARTIES,
  applyPartyTranslationMode,
  engineSupportsNativeTranslation,
  partyConfig,
  partyTranslationMode,
} from "../../lib/translation/nativeTranslation";
import type { TranslationParty } from "../../lib/translation/types";
import { withPartyEngine } from "../stt/sttEngines";
import { engineName } from "./PartyTranslationPicker";

const SONIOX = "soniox";

const PARTY_KEYS = {
  you: "common:labels.you",
  them: "common:labels.them",
} as const;

/** Whether a Soniox key is saved (undefined until known, or when it can't be read). */
function useSonioxKeySaved(): boolean | undefined {
  const [saved, setSaved] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    const meta = sttProviderMeta(SONIOX);
    hasApiKey(meta ? sttKeySlot(meta) : SONIOX)
      .then((ok) => !cancelled && setSaved(ok))
      .catch(() => !cancelled && setSaved(undefined));
    return () => {
      cancelled = true;
    };
  }, []);
  return saved;
}

export function SonioxTranslationCard() {
  const { t } = useT(["translation", "common"]);
  const translateParties = useTranslationStore((s) => s.translateParties);
  const setTranslateParties = useTranslationStore((s) => s.setTranslateParties);
  const audio = useConfigStore((s) => s.meetingAudioConfig);
  const setMeetingAudioConfig = useConfigStore((s) => s.setMeetingAudioConfig);
  const keySaved = useSonioxKeySaved();

  /** `mode` for `party`; `switchEngine` first moves its recognition to Soniox. */
  const apply = (party: TranslationParty, mode: "native" | "service", switchEngine: boolean) => {
    if (!audio) return;
    const { activeModelPerEngine, activeWhisperModel } = useConfigStore.getState();
    const base = switchEngine
      ? withPartyEngine(audio, party, SONIOX, { activeModelPerEngine, activeWhisperModel })
      : audio;
    const next = applyPartyTranslationMode(party, mode, translateParties, base);
    setTranslateParties(next.parties);
    const nextAudio = next.audio ?? (switchEngine ? base : null);
    if (nextAudio) setMeetingAudioConfig(nextAudio);
  };

  const modes = TRANSLATION_PARTIES.map((party) => partyTranslationMode(party, translateParties, audio));
  const allNative = modes.every((mode) => mode === "native");
  const anySoniox = TRANSLATION_PARTIES.some((party) => partyConfig(audio, party)?.stt_provider === SONIOX);

  const button =
    "shrink-0 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors cursor-pointer";

  return (
    <div className="rounded-xl border border-primary/25 bg-primary/5 p-4">
      <div className="mb-1.5 flex items-center gap-2">
        <Languages className="h-4 w-4 shrink-0 text-primary" />
        <h3 className="text-sm font-semibold text-primary/90">{t("soniox.title")}</h3>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">{t("soniox.description")}</p>

      {!audio ? (
        <p className="text-xs text-muted-foreground">{t("soniox.noAudio")}</p>
      ) : (
        <div className="space-y-2.5">
          {TRANSLATION_PARTIES.map((party, i) => {
            const engine = partyConfig(audio, party)?.stt_provider;
            const mode = modes[i];
            return (
              <div key={party} className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{t(PARTY_KEYS[party])}</p>
                  {mode === "native" ? (
                    <p className="flex items-center gap-1 text-[11px] text-success">
                      <CheckCircle className="h-3 w-3" />
                      {t("soniox.state.native")}
                    </p>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">
                      {t("parties.engine", { engine: engineName(engine) || "—" })}
                    </p>
                  )}
                </div>
                {mode === "native" ? (
                  <button
                    type="button"
                    onClick={() => apply(party, "service", false)}
                    className={`${button} border-border/40 text-muted-foreground hover:bg-accent/60 hover:text-foreground`}
                  >
                    {t("soniox.actions.useService")}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => apply(party, "native", !engineSupportsNativeTranslation(engine))}
                    className={`${button} border-primary/30 text-primary hover:bg-primary/10`}
                  >
                    {engineSupportsNativeTranslation(engine)
                      ? t("soniox.actions.turnOn")
                      : t("soniox.actions.switch")}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {keySaved === false && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-warning/10 px-3 py-2">
          <p className="flex items-center gap-1.5 text-xs text-warning">
            <KeyRound className="h-3.5 w-3.5 shrink-0" />
            {t("soniox.noKey")}
          </p>
          <button
            type="button"
            onClick={() => useMeetingStore.getState().openSettings("stt")}
            className="shrink-0 text-xs font-medium text-primary/80 underline-offset-2 hover:text-primary hover:underline cursor-pointer"
          >
            {t("soniox.actions.addKey")}
          </button>
        </div>
      )}

      {audio && (allNative || anySoniox) && (
        <p className="mt-3 text-xs text-muted-foreground">
          {allNative ? t("soniox.allNative") : t("soniox.twoWayHint")}
        </p>
      )}
    </div>
  );
}
