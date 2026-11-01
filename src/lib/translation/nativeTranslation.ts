// Which party is translated, and by whom.
//
// A party's lines are translated either by its STT engine (Soniox does it in
// the recognition stream and sends `translation_result` itself) or by the
// translation pipeline. The engine path is on when the engine supports it
// (providerMeta `supportsNativeTranslation`) and the party's
// `PartyAudioConfig.native_translation` is "one_way", or "two_way" with two
// different languages (the STT engine translates nothing otherwise); the
// pipeline then skips that party (live and "Translate all"). This is decided
// by the settings, never by "a translation already arrived": Soniox's
// translation often lands after `transcript_final`.

import type { MeetingAudioConfig, NativeTranslationConfig, PartyAudioConfig, Speaker } from "../types";
import { AUTO_LANGUAGE, baseLanguage, normalizeLanguageCode } from "../languages";
import { sttProviderMeta } from "../stt/providerMeta";
import type { PartyTranslationMode, TranslateParties, TranslationParty } from "./types";

export const TRANSLATION_PARTIES: readonly TranslationParty[] = ["you", "them"];

/** "User" lines are the user's own; everything else ("Them", room speakers…) is the other side. */
export function partyOfSpeaker(speaker: Speaker | string | undefined): TranslationParty {
  return speaker === "User" ? "you" : "them";
}

/** The STT engine can translate by itself. (Soniox counts even before its metadata entry exists.) */
export function engineSupportsNativeTranslation(provider: string | undefined): boolean {
  if (!provider) return false;
  const meta = sttProviderMeta(provider);
  return meta ? meta.supportsNativeTranslation : provider === "soniox";
}

export function partyConfig(
  audio: MeetingAudioConfig | null | undefined,
  party: TranslationParty,
): PartyAudioConfig | undefined {
  return audio?.[party];
}

/** Two-way needs two languages that differ as plain languages ("zh-CN" / "zh-TW" don't). */
function hasLanguagePair(native: NativeTranslationConfig): boolean {
  const a = baseLanguage(native.language_a ?? "");
  const b = baseLanguage(native.language_b ?? "");
  return a !== "" && b !== "" && a !== AUTO_LANGUAGE && b !== AUTO_LANGUAGE && a !== b;
}

/** The STT engine is set to translate (the mode is on, whatever the engine). */
function nativeModeOn(native: NativeTranslationConfig | undefined): boolean {
  return native?.mode === "one_way" || native?.mode === "two_way";
}

/** This party's translations come from its STT engine. */
export function partyUsesNativeTranslation(config: PartyAudioConfig | null | undefined): boolean {
  const native = config?.native_translation;
  if (!config || !native || !engineSupportsNativeTranslation(config.stt_provider)) return false;
  if (native.mode === "one_way") return true;
  return native.mode === "two_way" && hasLanguagePair(native);
}

/** Who translates `party` right now. */
export function partyTranslationMode(
  party: TranslationParty,
  parties: TranslateParties,
  audio: MeetingAudioConfig | null | undefined,
): PartyTranslationMode {
  if (partyUsesNativeTranslation(partyConfig(audio, party))) return "native";
  return parties[party] ? "service" : "off";
}

/**
 * Applies a mode: `translateParties` says whether the party is translated at
 * all; `native_translation` turns the engine's translation on or off
 * (target "" = follow the translation settings). `audio` is null when the
 * audio config needs no change (or there is none).
 */
export function applyPartyTranslationMode(
  party: TranslationParty,
  mode: PartyTranslationMode,
  parties: TranslateParties,
  audio: MeetingAudioConfig | null | undefined,
): { parties: TranslateParties; audio: MeetingAudioConfig | null } {
  const nextParties = { ...parties, [party]: mode !== "off" };
  const config = partyConfig(audio, party);
  if (!audio || !config) return { parties: nextParties, audio: null };

  const current = config.native_translation;
  let native = current;
  if (mode === "native" && !partyUsesNativeTranslation(config)) {
    // One way into the target (also replaces a two-way setting without a language pair).
    native = { ...current, mode: "one_way", target_language: current?.target_language ?? "" };
  } else if (mode !== "native" && nativeModeOn(current)) {
    native = { ...current, mode: "off" };
  }
  if (native === current) return { parties: nextParties, audio: null };
  return {
    parties: nextParties,
    audio: { ...audio, [party]: { ...config, native_translation: native } },
  };
}

/** Parties the translation service handles: switched on and not translated by their engine. */
export function serviceParties(
  parties: TranslateParties,
  audio: MeetingAudioConfig | null | undefined,
): TranslationParty[] {
  return TRANSLATION_PARTIES.filter((p) => partyTranslationMode(p, parties, audio) === "service");
}

/**
 * Source language for a party's lines: the translation settings' source when
 * it isn't auto-detect; otherwise the party's recognition language (its own,
 * else the global one) unless that is auto-detect too.
 */
export function partySourceLanguage(
  party: TranslationParty,
  sourceSetting: string,
  audio: MeetingAudioConfig | null | undefined,
  globalSttLanguage?: string,
): string | undefined {
  const explicit = normalizeLanguageCode(sourceSetting ?? "");
  if (explicit && explicit !== AUTO_LANGUAGE) return explicit;
  const recognition = normalizeLanguageCode(partyConfig(audio, party)?.language || globalSttLanguage || "");
  return recognition && recognition !== AUTO_LANGUAGE ? recognition : undefined;
}
