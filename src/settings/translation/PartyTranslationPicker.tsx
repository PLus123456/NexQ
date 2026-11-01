// Who is translated, and by whom: per party, off / by its STT engine (Soniox
// translates while it recognizes) / by the translation service.
// "Off" and "service" live in translateParties; the engine's own translation
// is the party's native_translation in the meeting audio config.

import { useT } from "../../i18n";
import { useConfigStore } from "../../stores/configStore";
import { useTranslationStore } from "../../stores/translationStore";
import { sttProviderMeta } from "../../lib/stt/providerMeta";
import {
  TRANSLATION_PARTIES,
  applyPartyTranslationMode,
  engineSupportsNativeTranslation,
  partyConfig,
  partyTranslationMode,
} from "../../lib/translation/nativeTranslation";
import type { PartyTranslationMode, TranslationParty } from "../../lib/translation/types";

const MODES: readonly PartyTranslationMode[] = ["off", "native", "service"];

const MODE_KEYS = {
  off: "parties.mode.off",
  native: "parties.mode.native",
  service: "parties.mode.service",
} as const;

const PARTY_KEYS = {
  you: "common:labels.you",
  them: "common:labels.them",
} as const;

export function engineName(provider: string | undefined): string {
  if (!provider) return "";
  return sttProviderMeta(provider)?.label ?? provider;
}

export function PartyTranslationPicker() {
  const { t } = useT(["translation", "common"]);
  const translateParties = useTranslationStore((s) => s.translateParties);
  const setTranslateParties = useTranslationStore((s) => s.setTranslateParties);
  const audio = useConfigStore((s) => s.meetingAudioConfig);
  const setMeetingAudioConfig = useConfigStore((s) => s.setMeetingAudioConfig);

  const choose = (party: TranslationParty, mode: PartyTranslationMode) => {
    const next = applyPartyTranslationMode(party, mode, translateParties, audio);
    setTranslateParties(next.parties);
    if (next.audio) setMeetingAudioConfig(next.audio);
  };

  return (
    <div className="space-y-3">
      {TRANSLATION_PARTIES.map((party) => {
        const engine = partyConfig(audio, party)?.stt_provider;
        const current = partyTranslationMode(party, translateParties, audio);
        const nativeAvailable = engineSupportsNativeTranslation(engine);
        return (
          <div key={party} className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{t(PARTY_KEYS[party])}</p>
              {engine && (
                <p className="text-[11px] text-muted-foreground">{t("parties.engine", { engine: engineName(engine) })}</p>
              )}
            </div>
            <div
              role="radiogroup"
              aria-label={t("parties.groupLabel", { party: t(PARTY_KEYS[party]) })}
              className="flex overflow-hidden rounded-lg border border-border/40"
            >
              {MODES.map((mode) => {
                const disabled = mode === "native" && !nativeAvailable && current !== "native";
                const selected = current === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={disabled}
                    onClick={() => choose(party, mode)}
                    title={
                      disabled
                        ? t("parties.nativeUnavailable", { engine: engineName(engine) || "—" })
                        : undefined
                    }
                    className={`px-2.5 py-1.5 text-xs font-medium transition-colors border-l border-border/30 first:border-l-0 ${
                      selected
                        ? "bg-primary/15 text-primary"
                        : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                    } disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent cursor-pointer`}
                  >
                    {t(MODE_KEYS[mode])}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">{t("parties.hint")}</p>
    </div>
  );
}
