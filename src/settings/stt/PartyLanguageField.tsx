// A party's recognition language: LanguageCombobox with Auto-detect, plus
// what the party's engine does with it (no auto-detect, ignores the setting,
// English-only model…). Writes `PartyAudioConfig.language` through `onChange`.

import { AlertTriangle, Info } from "lucide-react";
import { currentUiLanguage, useT } from "../../i18n";
import { LanguageCombobox } from "../../components/LanguageCombobox";
import { AUTO_LANGUAGE, baseLanguage, languageLabel } from "../../lib/languages";
import { CARTESIA_LANGUAGES, cartesiaSupportsLanguage, sttProviderMeta } from "../../lib/stt/providerMeta";
import type { PartyAudioConfig } from "../../lib/types";
import { useConfigStore } from "../../stores/configStore";
import { partyLanguage, sttEngineLabel } from "./sttEngines";

const DEFAULT_PARAKEET_MODEL = "parakeet-tdt-0.6b-v3-int8";

export interface PartyLanguageFieldProps {
  party: PartyAudioConfig;
  onChange: (code: string) => void;
  id?: string;
  "aria-label"?: string;
  className?: string;
}

interface Hint {
  tone: "info" | "warning";
  text: string;
}

/** The languages Cartesia ink-2 detects, as a list in the UI language. */
function cartesiaLanguageList(): string {
  const names = CARTESIA_LANGUAGES.map((code) => languageLabel(code));
  return new Intl.ListFormat(currentUiLanguage(), { style: "long", type: "conjunction" }).format(names);
}

export function PartyLanguageField({ party, onChange, id, "aria-label": ariaLabel, className }: PartyLanguageFieldProps) {
  const { t } = useT(["stt", "common"]);
  const sttLanguage = useConfigStore((s) => s.sttLanguage);
  const deepgramModel = useConfigStore((s) => s.deepgramConfig.model);
  const parakeetModel = useConfigStore((s) => s.activeModelPerEngine.parakeet_tdt ?? DEFAULT_PARAKEET_MODEL);

  const value = partyLanguage(party, sttLanguage);
  const isAuto = value === AUTO_LANGUAGE;
  const isVietnamese = baseLanguage(value) === "vi";
  const meta = sttProviderMeta(party.stt_provider);
  const engine = sttEngineLabel(party.stt_provider);

  let autoUnavailableReason: string | undefined;
  const hints: Hint[] = [];
  if (meta?.languageSupport === "noAuto") {
    const webSpeech = meta.id === "web_speech";
    autoUnavailableReason = webSpeech
      ? t("stt:language.autoUnavailable.webSpeech")
      : t("stt:language.autoUnavailable.needsLanguage", { engine });
    if (isAuto) {
      hints.push({
        tone: "warning",
        text: webSpeech
          ? t("stt:language.hints.autoUsesSystemLanguage")
          : t("stt:language.hints.autoFallsBackToEnglish", { engine }),
      });
    }
  } else if (meta?.languageSupport === "ignored") {
    hints.push({ tone: "info", text: t("stt:language.hints.ignored", { engine }) });
  }
  if (isAuto && meta?.id === "whisper_cpp") {
    hints.push({ tone: "info", text: t("stt:language.hints.whisperCppAuto") });
  }
  // Flux Multilingual detects the language too.
  if (isAuto && meta?.id === "deepgram" && !/^nova-[23]\b/.test(deepgramModel) && deepgramModel !== "flux-general-multi") {
    hints.push({ tone: "warning", text: t("stt:language.hints.deepgramAuto", { model: deepgramModel }) });
  }
  if (meta?.id === "cartesia") {
    // ink-2 has no language setting; the choice only matters for this check.
    const languages = cartesiaLanguageList();
    hints.push(isAuto || cartesiaSupportsLanguage(value)
      ? { tone: "info", text: t("stt:language.hints.cartesiaAuto", { languages }) }
      : { tone: "warning", text: t("stt:language.hints.cartesiaUnsupported", { languages }) });
  }
  if (isVietnamese && meta?.id === "parakeet_tdt") {
    hints.push({ tone: "warning", text: t("stt:language.hints.parakeetVietnameseUnsupported") });
  }
  if (isVietnamese && meta?.id === "deepgram") {
    hints.push({ tone: "info", text: t("stt:language.hints.deepgramVietnamese") });
  }
  if (
    meta?.id === "parakeet_tdt" &&
    parakeetModel.includes("ctc-110m") &&
    !isVietnamese &&
    !value.toLowerCase().startsWith("en")
  ) {
    hints.push({ tone: "warning", text: t("stt:language.hints.parakeetCtcEnglishOnly") });
  }

  return (
    <div className={className}>
      <LanguageCombobox
        id={id}
        aria-label={ariaLabel}
        value={value}
        onChange={onChange}
        allowAuto
        autoUnavailableReason={autoUnavailableReason}
      />
      {hints.map((hint) => (
        <p
          key={hint.text}
          className={`mt-1.5 flex items-start gap-1.5 text-meta leading-relaxed ${
            hint.tone === "warning" ? "text-warning" : "text-muted-foreground/80"
          }`}
        >
          {hint.tone === "warning" ? (
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          ) : (
            <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          )}
          <span>{hint.text}</span>
        </p>
      ))}
    </div>
  );
}
