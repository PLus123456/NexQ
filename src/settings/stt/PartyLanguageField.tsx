// A party's recognition language: LanguageCombobox with Auto-detect, plus
// what the party's engine does with it. The one language picker of a side, on
// every surface (Audio & Devices, STT Providers, the first-run setup). Writes
// `PartyAudioConfig.language` through `onChange`.
//
// What is wrong with the side's engine and its language is lib/sideLanguage's
// judgment (upstream's model-by-model check, the one Rust refuses a meeting
// start with, and the one the overlay's language picker shows), worded in the
// UI language by `sideNoticeText`. On top of it: the fork's notes on what an
// engine does with the setting.

import { AlertTriangle, Info } from "lucide-react";
import { currentUiLanguage, t as translate, useT } from "../../i18n";
import { en } from "../../i18n/resources";
import { LanguageCombobox } from "../../components/LanguageCombobox";
import { skipYouStt } from "../../lib/audioMode";
import { AUTO_LANGUAGE, languageLabel } from "../../lib/languages";
import { sideLanguageProblems, sideNotice, type SideProblems } from "../../lib/sideLanguage";
import { CARTESIA_LANGUAGES, cartesiaSupportsLanguage, sttProviderMeta } from "../../lib/stt/providerMeta";
import {
  AUTO_DETECT_ADVICE,
  AUTO_DETECT_REFUSAL_PREFIX,
  AUTO_DETECT_WHISPER_ADVICE,
  isDeepgramNova3,
} from "../../lib/sttLanguages";
import type { PartyAudioConfig, STTProviderType } from "../../lib/types";
import { useConfigStore } from "../../stores/configStore";
import { useMeetingStore } from "../../stores/meetingStore";
import { partyLanguage, sttEngineLabel } from "./sttEngines";

/** The fork's own engines, which upstream's Nova-3 tip for mixed-language speech doesn't know about. */
const NO_MIXED_LANGUAGE_TIP: readonly STTProviderType[] = ["soniox", "openai_compat"];

const NO_PROBLEMS: SideProblems = { auto: null, hint: null };

/**
 * lib/sttLanguages (upstream's module) words its hints in English. The entries
 * of `stt:language.hints` with that same English text are those hints in the
 * UI language; a hint without one is shown as it comes.
 */
type HintKey = keyof typeof en.stt.language.hints;
const HINT_KEYS = new Map(Object.entries(en.stt.language.hints).map(([key, text]) => [text, key as HintKey]));

/** "The base.en Whisper model is English-only. …": one hint, whatever the model. */
const WHISPER_ENGLISH_ONLY = /^The (.+) Whisper model is English-only\. /;

/** The Cartesia hint lists its languages in English; ours lists them in the UI language. */
const CARTESIA_UNSUPPORTED = /^Cartesia transcribes only .+\. Choose another provider for this language\.$/;

/**
 * The Auto-detect problem: Rust's refusal, word for word ("Auto-detect doesn't
 * work with <engine>, used for <side>. <advice>").
 */
const AUTO_PROBLEM = new RegExp(
  `^${AUTO_DETECT_REFUSAL_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} (.+), used for (You|Them|Room)\\. (.+)$`,
);
const SIDE_LABEL_KEYS = { You: "common:labels.you", Them: "common:labels.them", Room: "common:labels.room" } as const;

/** "the base.en Whisper model": how the refusal names a Whisper.cpp model. */
const WHISPER_MODEL_NAME = /^the (.+) Whisper model$/;

/** The languages Cartesia ink-2 detects, as a list in the UI language. */
function cartesiaLanguageList(): string {
  const names = CARTESIA_LANGUAGES.map((code) => languageLabel(code));
  return new Intl.ListFormat(currentUiLanguage(), { style: "long", type: "conjunction" }).format(names);
}

/**
 * A notice of lib/sideLanguage (`sideNotice`: a side's Auto-detect problem,
 * else the hint about its engine and language) in the UI language. In English
 * it is the same text; a notice that has no wording here is shown as it comes.
 */
export function sideNoticeText(text: string): string {
  const refusal = AUTO_PROBLEM.exec(text);
  if (refusal) {
    const [, name, side, advice] = refusal;
    const whisper = WHISPER_MODEL_NAME.exec(name);
    return translate("stt:language.autoProblem.message", {
      name: whisper ? translate("stt:language.autoProblem.whisperModel", { model: whisper[1] }) : name,
      side: translate(SIDE_LABEL_KEYS[side as keyof typeof SIDE_LABEL_KEYS]),
      advice:
        advice === AUTO_DETECT_ADVICE
          ? translate("stt:language.autoProblem.advice")
          : advice === AUTO_DETECT_WHISPER_ADVICE
            ? translate("stt:language.autoProblem.whisperAdvice")
            : advice,
    });
  }
  const key = HINT_KEYS.get(text);
  if (key) return translate(`stt:language.hints.${key}`);
  const whisper = WHISPER_ENGLISH_ONLY.exec(text);
  if (whisper) return translate("stt:language.hints.whisperEnglishOnly", { model: whisper[1] });
  if (CARTESIA_UNSUPPORTED.test(text)) {
    return translate("stt:language.hints.cartesiaUnsupported", { languages: cartesiaLanguageList() });
  }
  return text;
}

export interface PartyLanguageFieldProps {
  party: PartyAudioConfig;
  onChange: (code: string) => void;
  id?: string;
  "aria-label"?: string;
  className?: string;
}

interface Note {
  tone: "info" | "warning";
  text: string;
}

export function PartyLanguageField({ party, onChange, id, "aria-label": ariaLabel, className }: PartyLanguageFieldProps) {
  const { t } = useT(["stt", "common"]);
  const sttLanguage = useConfigStore((s) => s.sttLanguage);
  const deepgramModel = useConfigStore((s) => s.deepgramConfig.model);
  const whisperModel = useConfigStore((s) => s.activeWhisperModel);
  const parakeetModel = useConfigStore((s) => s.activeModelPerEngine.parakeet_tdt);
  // In an in-person meeting only the room microphone ("Them") is transcribed.
  const inPerson = useMeetingStore((s) => skipYouStt(s.audioMode));

  // The side is judged by its own language: its pick, else the shared one.
  const value = partyLanguage(party, sttLanguage);
  const isAuto = value === AUTO_LANGUAGE;
  const meta = sttProviderMeta(party.stt_provider);
  const engine = sttEngineLabel(party.stt_provider);
  const isYou = party.role === "You";
  // The side as Rust's refusal names it (the Auto-detect message of lib/sttLanguages repeats it).
  const sideName = isYou ? "You" : inPerson ? "Room" : "Them"; // i18n-ignore: part of the backend's wording

  const problems =
    inPerson && isYou
      ? NO_PROBLEMS
      : sideLanguageProblems(
          party,
          value,
          { deepgram: deepgramModel, whisperCpp: whisperModel, parakeet: parakeetModel },
          sideName,
        );

  let autoUnavailableReason: string | undefined;
  if (meta?.languageSupport === "noAuto") {
    autoUnavailableReason =
      meta.id === "web_speech"
        ? t("stt:language.autoUnavailable.webSpeech")
        : t("stt:language.autoUnavailable.needsLanguage", { engine });
  }

  const notes: Note[] = [];
  // The side's one notice, the same one the overlay's language picker shows:
  // Auto-detect can't work with its engine or model, else what the engine
  // can't do with its language.
  const notice = sideNotice(problems);
  if (notice) notes.push({ tone: notice.tone, text: sideNoticeText(notice.text) });

  if (meta?.id === "cartesia" && (isAuto || cartesiaSupportsLanguage(value))) {
    // ink-2 has no language setting; the choice only matters for the check above.
    notes.push({ tone: "info", text: t("stt:language.hints.cartesiaAuto", { languages: cartesiaLanguageList() }) });
  }
  if (meta?.languageSupport === "ignored") {
    notes.push({ tone: "info", text: t("stt:language.hints.ignored", { engine }) });
  }
  if (isAuto && !problems.auto) {
    if (meta?.id === "whisper_cpp") notes.push({ tone: "info", text: t("stt:language.hints.whisperCppAuto") });
    if (meta?.id === "deepgram" && isDeepgramNova3(deepgramModel)) {
      notes.push({ tone: "info", text: t("stt:language.hints.novaMixedLanguages") });
    } else if (meta && !NO_MIXED_LANGUAGE_TIP.includes(meta.id)) {
      notes.push({ tone: "info", text: t("stt:language.hints.mixedLanguagesTip") });
    }
  }

  // What stops or spoils the transcription first, tips after.
  notes.sort((a, b) => Number(b.tone === "warning") - Number(a.tone === "warning"));

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
      {notes.map((note) => (
        <p
          key={note.text}
          // A side that won't transcribe (well) is announced; tips are not.
          role={note.tone === "warning" ? "alert" : undefined}
          className={`mt-1.5 flex items-start gap-1.5 text-meta leading-relaxed ${
            note.tone === "warning" ? "text-warning" : "text-muted-foreground/80"
          }`}
        >
          {note.tone === "warning" ? (
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          ) : (
            <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          )}
          <span>{note.text}</span>
        </p>
      ))}
    </div>
  );
}
