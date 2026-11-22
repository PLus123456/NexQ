// The notices of lib/sideLanguage (`sideNotice`) in the UI language. Shared by
// Settings (PartyLanguageField) and the overlay's language picker.

import { currentUiLanguage, t as translate } from "../i18n";
import { en } from "../i18n/resources";
import { languageLabel } from "./languages";
import { CARTESIA_LANGUAGES } from "./stt/providerMeta";
import {
  AUTO_DETECT_ADVICE,
  AUTO_DETECT_REFUSAL_PREFIX,
  AUTO_DETECT_WHISPER_ADVICE,
} from "./sttLanguages";

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
export function cartesiaLanguageList(): string {
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
