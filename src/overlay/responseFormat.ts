// Small formatters for the AI response panel (timer, meeting time, previews).

import { formatDate, t } from "../i18n";

/** "0.6 s", "12.3 s", then "1:05" past a minute. */
export function formatDuration(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < 60_000) return t("overlay:format.seconds", { value: (safe / 1000).toFixed(1) });
  const secs = Math.floor(safe / 1000);
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

/** Meeting-relative "mm:ss" when the meeting start is known, else the clock time. */
export function formatAnswerTime(timestamp: number, meetingStart: number | null): string {
  if (meetingStart && timestamp >= meetingStart) {
    const secs = Math.floor((timestamp - meetingStart) / 1000);
    return `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
  }
  return formatDate(timestamp, { hour: "2-digit", minute: "2-digit" });
}

/** First non-empty line of an answer, without markdown markers. */
export function previewLine(content: string): string {
  const line = content.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return line.replace(/^(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, "").replace(/[*_`]/g, "");
}

/** "3 new transcript lines sent" / "no new transcript since last answer" (session path), "42 transcript lines" (stateless). */
export function linesLabel(newLines: number | null, sessionKey: string | null): string | null {
  if (newLines == null) return null;
  if (sessionKey) {
    if (newLines === 0) return t("overlay:progress.lines.none");
    return t("overlay:progress.lines.sent", { count: newLines });
  }
  return t("overlay:progress.lines.total", { count: newLines });
}
