import { countWords } from "../lib/wordCount";
import { useMemo } from "react";
import type { TFunction } from "i18next";
import type { Meeting } from "../lib/types";
import { useMeetingStore } from "../stores/meetingStore";
import { useT } from "../i18n";

export interface MeetingStats {
  durationDisplay: string;
  wordCount: number;
  wordsPerMinute: number;
  speakerBreakdown: { speaker: string; percentage: number; color: string }[];
  aiCount: number;
  avgLatencyMs: number | null;
}

const SPEAKER_COLORS: Record<string, string> = {
  User: "text-blue-400",
  Interviewer: "text-purple-400",
  Them: "text-emerald-400",
  Unknown: "text-muted-foreground",
};

function formatStatDuration(seconds: number, t: TFunction<"misc">): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return t("hooks.meetingStats.duration.hoursMinutes", { hours: h, minutes: m });
  if (m > 0) {
    return t("hooks.meetingStats.duration.minutesSeconds", { minutes: m, seconds: String(s).padStart(2, "0") });
  }
  return t("hooks.meetingStats.duration.seconds", { seconds: s });
}

export function useMeetingStats(meeting: Meeting | null): MeetingStats {
  const { t } = useT("misc");
  const activeMeetingId = useMeetingStore((s) => s.activeMeeting?.id);
  const elapsedMs = useMeetingStore((s) => s.elapsedMs);
  const isActiveMeeting = meeting?.id === activeMeetingId;

  return useMemo(() => {
    if (!meeting) {
      return {
        durationDisplay: "—",
        wordCount: 0,
        wordsPerMinute: 0,
        speakerBreakdown: [],
        aiCount: 0,
        avgLatencyMs: null,
      };
    }

    const durationSec = isActiveMeeting
      ? elapsedMs / 1000
      : meeting.duration_seconds ?? 0;
    const durationDisplay = durationSec > 0 ? formatStatDuration(durationSec, t) : "—";

    // Word counts per speaker
    const speakerWords: Record<string, number> = {};
    let totalWords = 0;
    for (const seg of meeting.transcript) {
      const words = countWords(seg.text);
      totalWords += words;
      speakerWords[seg.speaker] = (speakerWords[seg.speaker] || 0) + words;
    }

    const durationMin = durationSec / 60;
    const wordsPerMinute = durationMin > 0 ? Math.round(totalWords / durationMin) : 0;

    const speakerBreakdown = Object.entries(speakerWords)
      .map(([speaker, words]) => ({
        speaker,
        percentage: totalWords > 0 ? Math.round((words / totalWords) * 100) : 0,
        color: SPEAKER_COLORS[speaker] || SPEAKER_COLORS.Unknown,
      }))
      .sort((a, b) => b.percentage - a.percentage);

    const aiCount = meeting.ai_interactions.length;
    const avgLatencyMs =
      aiCount > 0
        ? Math.round(
            meeting.ai_interactions.reduce((sum, ai) => sum + ai.latency_ms, 0) / aiCount
          )
        : null;

    return {
      durationDisplay,
      wordCount: totalWords,
      wordsPerMinute,
      speakerBreakdown,
      aiCount,
      avgLatencyMs,
    };
  }, [meeting, isActiveMeeting, elapsedMs, t]);
}
