import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { formatDate, t } from "../i18n";
import type { Speaker, IntelligenceMode } from "./types";

// shadcn/ui utility
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Strip <think>...</think> blocks from LLM output.
 * Handles both complete blocks and unclosed tags (mid-stream).
 */
export function stripThinkTags(text: string): string {
  let result = text.replace(/<think>[\s\S]*?<\/think>\s*/g, "");
  const openIdx = result.indexOf("<think>"); // i18n-ignore: model output tag, not UI text
  if (openIdx !== -1) {
    result = result.substring(0, openIdx);
  }
  return result.trimStart();
}

// Format milliseconds to MM:SS
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

// Format milliseconds to HH:MM:SS for long meetings
export function formatDurationLong(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  return formatDuration(ms);
}

// Format timestamp for transcript display
export function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

// Format ISO date string to relative time
export function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return t("misc:time.justNow");
  if (diffMins < 60) return t("misc:time.minutesAgo", { count: diffMins });
  if (diffHours < 24) return t("misc:time.hoursAgo", { count: diffHours });
  if (diffDays < 7) return t("misc:time.daysAgo", { count: diffDays });
  return formatDate(date, { year: "numeric", month: "numeric", day: "numeric" });
}

// Get speaker display color class
export function getSpeakerColor(speaker: Speaker): string {
  switch (speaker) {
    case "User":
      return "text-speaker-user";
    case "Interviewer":
    case "Them":
      return "text-speaker-interviewer";
    default:
      return "text-muted-foreground";
  }
}

// Get speaker label
export function getSpeakerLabel(speaker: Speaker): string {
  switch (speaker) {
    case "User":
      return t("common:labels.you");
    case "Interviewer":
      return t("common:labels.interviewer");
    case "Them":
      return t("common:labels.them");
    case "Unknown":
      return t("common:labels.unknown");
    default:
      return speaker || t("common:labels.unknown");
  }
}

// Get intelligence mode label
export function getModeLabel(mode: IntelligenceMode | "question_detect" | "question_predict" | "question_prepare"): string {
  switch (mode) {
    case "question_predict":
      return t("llm:tasks.question_predict.label");
    case "question_prepare":
      return t("llm:questionPrediction.preparationLog");
    case "question_detect":
      return t("llm:tasks.question_detect.label");
    case "Assist":
      return t("misc:modes.assist");
    case "WhatToSay":
      return t("misc:modes.whatToSay");
    case "Shorten":
      return t("misc:modes.shorten");
    case "FollowUp":
      return t("misc:modes.followUp");
    case "Recap":
      return t("misc:modes.recap");
    case "AskQuestion":
      return t("misc:modes.askQuestion");
    case "MeetingSummary":
      return t("misc:modes.meetingSummary");
    case "ActionItemsExtraction":
      return t("misc:modes.actionItems");
    case "BookmarkSuggestions":
      return t("misc:modes.bookmarkSuggestions");
    case "MeetingAsk":
      return t("misc:modes.meetingAsk");
  }
}

// Get mode keyboard shortcut
export function getModeShortcut(mode: IntelligenceMode): string {
  switch (mode) {
    case "Assist":
      return "Space"; // i18n-ignore: shortcut key name
    case "WhatToSay":
      return "Ctrl+1"; // i18n-ignore: shortcut key name
    case "Shorten":
      return "Ctrl+2"; // i18n-ignore: shortcut key name
    case "FollowUp":
      return "Ctrl+3"; // i18n-ignore: shortcut key name
    case "Recap":
      return "Ctrl+4"; // i18n-ignore: shortcut key name
    case "AskQuestion":
      return "Ctrl+5"; // i18n-ignore: shortcut key name
    case "MeetingSummary":
      return "";
    case "ActionItemsExtraction":
      return "";
    case "BookmarkSuggestions":
      return "";
    case "MeetingAsk":
      return "";
  }
}

// Format file size
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`; // i18n-ignore: file size unit
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`; // i18n-ignore: file size unit
}

// Group meetings by date category. These are group ids, not display text:
// RecentMeetings keys and sorts by them and translates the heading when shown.
export function getDateGroup(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffDays = Math.floor(
    (now.getTime() - date.getTime()) / 86400000
  );

  if (diffDays === 0) return "Today"; // i18n-ignore: group id, translated by RecentMeetings
  if (diffDays === 1) return "Yesterday"; // i18n-ignore: group id, translated by RecentMeetings
  if (diffDays < 7) return "This Week"; // i18n-ignore: group id, translated by RecentMeetings
  return "Earlier"; // i18n-ignore: group id, translated by RecentMeetings
}
