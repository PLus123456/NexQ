// Remote speaker tags: Deepgram diarization tells the people on the other
// side of an online call apart ("S1", "S2"...). Their lines keep speaker
// "Them" / speaker_id "them" (stats, filters, question detection and routing
// are unchanged) and carry `speaker_tag`; names live in the speaker store and
// meeting_speakers under `them:<tag>`.

import { t } from "../i18n";
import { REMOTE_SPEAKER_COLORS } from "./speakerColors";
import type { SpeakerIdentity } from "./types";

/** Speaker-store / meeting_speakers id under which a remote tag's name is kept. */
export function remoteSpeakerId(tag: string): string {
  return `them:${tag}`; // i18n-ignore: 说话人 id
}

/** Label of a remote tag nobody renamed: "S2" → "Speaker 2" (in the UI language). */
export function defaultRemoteSpeakerName(tag: string): string {
  const n = /^S(\d+)$/.exec(tag);
  return n ? t("misc:speakerLabels.defaultName", { n: n[1] }) : tag;
}

/** The same label, always in English: AI context lines are not translated. */
function englishSpeakerName(tag: string): string {
  const n = /^S(\d+)$/.exec(tag);
  return n ? `Speaker ${n[1]}` : tag; // i18n-ignore: 发给 AI 的说话人标签，保持英文
}

/** One quiet, stable color per remote person (by tag number). */
export function remoteSpeakerColor(tag: string): string {
  const n = /^S(\d+)$/.exec(tag);
  const index = n ? Math.max(0, parseInt(n[1], 10) - 1) : 0;
  return REMOTE_SPEAKER_COLORS[index % REMOTE_SPEAKER_COLORS.length];
}

/** `speakers` with `speakerKey` named `name` (a remote tag gets its entry if missing). */
export function withSpeakerName(
  speakers: SpeakerIdentity[] | undefined,
  speakerKey: string,
  name: string,
): SpeakerIdentity[] {
  const list = speakers ?? [];
  if (list.some((s) => s.id === speakerKey)) {
    return list.map((s) => (s.id === speakerKey ? { ...s, display_name: name } : s));
  }
  return [
    ...list,
    {
      id: speakerKey,
      display_name: name,
      source: "remote_tag",
      color: remoteSpeakerColor(speakerKey.replace(/^them:/, "")),
      stats: { segment_count: 0, word_count: 0, talk_time_ms: 0, last_spoke_ms: 0 },
    },
  ];
}

interface SpeakerFields {
  speaker: string;
  speaker_id?: string;
  speaker_tag?: string;
}

/**
 * The remote-speaker key (`them:S1`) of a tagged line from the other side of
 * an online call, or null (untagged, or an in-person line whose diarized
 * speaker_id names the person itself).
 */
export function remoteKeyOf(seg: SpeakerFields): string | null {
  if (!seg.speaker_tag || seg.speaker === "User") return null; // i18n-ignore: 枚举值
  const id = seg.speaker_id ?? "them";
  return id === "them" ? remoteSpeakerId(seg.speaker_tag) : null;
}

/**
 * Speaker label for AI context: a diarized line goes by its person's name
 * ("Erin", else "Speaker 2") so the model can attribute statements; every
 * other line keeps its speaker ("User" / "Them").
 */
export function assistSpeakerLabel(
  seg: SpeakerFields,
  nameOf: (speakerKey: string) => string | undefined,
): string {
  if (!seg.speaker_tag || seg.speaker === "User") return seg.speaker; // i18n-ignore: 枚举值
  const key = remoteKeyOf(seg) ?? seg.speaker_id;
  return (key && nameOf(key)) || englishSpeakerName(seg.speaker_tag);
}
