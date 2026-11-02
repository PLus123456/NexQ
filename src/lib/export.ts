// ============================================================================
// NexQ Export Utilities — multi-format meeting export
// ============================================================================

import type { Meeting, TranscriptSegment, AIScenario, SpeakerIdentity } from "./types";
import { formatTimestamp, formatDurationLong, getSpeakerLabel, getModeLabel } from "./utils";
import { showToast } from "../stores/toastStore";
import { defaultRemoteSpeakerName, remoteKeyOf } from "./speakerLabels";
import { formatDate, t } from "../i18n";

/** Strip LLM thinking tags from text (Qwen3, DeepSeek, etc.) */
function stripThinkTags(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*/gi, "")
    .trim();
}

// ── Speaker resolution ───────────────────────────────────────────────────────

function buildSpeakerMap(speakers?: SpeakerIdentity[]): Map<string, SpeakerIdentity> | null {
  if (!speakers || speakers.length === 0) return null;
  const map = new Map<string, SpeakerIdentity>();
  for (const s of speakers) map.set(s.id, s);
  return map;
}

function resolveSpeaker(
  seg: TranscriptSegment,
  speakerMap: Map<string, SpeakerIdentity> | null
): string {
  const remoteKey = remoteKeyOf(seg);
  if (remoteKey && seg.speaker_tag) {
    return speakerMap?.get(remoteKey)?.display_name ?? defaultRemoteSpeakerName(seg.speaker_tag);
  }
  if (speakerMap && seg.speaker_id) {
    const s = speakerMap.get(seg.speaker_id);
    if (s) return s.display_name;
  }
  return getSpeakerLabel(seg.speaker);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function meetingStartMs(meeting: Meeting): number {
  return new Date(meeting.start_time).getTime();
}

/** The fields `Date.prototype.toLocaleString()` shows when given no options. */
const DATE_TIME_FIELDS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
};

/** Meeting start date and time, in the UI language. */
function formatMeetingStart(meeting: Meeting): string {
  return formatDate(new Date(meeting.start_time), DATE_TIME_FIELDS);
}

/** Scenario as the exported document shows it; an id we don't know shows as stored, underscores as spaces. */
function scenarioLabel(scenario: AIScenario): string {
  switch (scenario) {
    case "team_meeting":
      return t("misc:export.scenarios.teamMeeting");
    case "lecture":
      return t("misc:export.scenarios.lecture");
    case "interview":
      return t("misc:export.scenarios.interview");
    case "webinar":
      return t("misc:export.scenarios.webinar");
    case "oral_exam":
      return t("misc:export.scenarios.oralExam");
    case "custom":
      return t("misc:export.scenarios.custom");
    default:
      return String(scenario).replace(/_/g, " ");
  }
}

function segmentTime(seg: TranscriptSegment, startMs: number): string {
  return formatTimestamp(Math.max(0, seg.timestamp_ms - startMs));
}

function safeFilename(title: string): string {
  // Retain Unicode letters (including Chinese) while excluding path separators
  // and other filename punctuation. Bound UTF-8 bytes, not JS code units, so
  // long Chinese titles fit the filesystem limit with room for an extension.
  const clean = title.normalize("NFC").replace(/[^\p{L}\p{N}\p{M} _-]/gu, "").trim();
  let name = "";
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const char of clean) {
    bytes += encoder.encode(char).length;
    if (bytes > 200) break;
    name += char;
  }
  name = name.trim() || "meeting";
  // Windows device names are reserved even when a file extension is added.
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name) ? `_${name}` : name;
}

// ── Export: Markdown ──────────────────────────────────────────────────────────

export function exportToMarkdown(meeting: Meeting): string {
  const startMs = meetingStartMs(meeting);
  const speakerMap = buildSpeakerMap(meeting.speakers);
  let md = `# ${meeting.title}\n\n`;
  md += `**${t("misc:export.labels.date")}** ${formatMeetingStart(meeting)}\n`;
  if (meeting.duration_seconds) {
    md += `**${t("misc:export.labels.duration")}** ${formatDurationLong(meeting.duration_seconds * 1000)}\n`;
  }
  if (meeting.audio_mode) {
    md += `**${t("misc:export.labels.mode")}** ${meeting.audio_mode === "online" ? t("common:labels.online") : t("common:labels.inPerson")}\n`;
  }
  if (meeting.ai_scenario) {
    md += `**${t("misc:export.labels.scenario")}** ${scenarioLabel(meeting.ai_scenario)}\n`;
  }
  md += `**${t("misc:export.labels.segments")}** ${meeting.transcript.length}\n\n`;

  if (meeting.summary) {
    md += `## ${t("misc:export.headings.summary")}\n\n${stripThinkTags(meeting.summary)}\n\n`;
  }

  if (meeting.action_items && meeting.action_items.length > 0) {
    md += `## ${t("misc:export.headings.actionItems")}\n\n`;
    for (const item of meeting.action_items) {
      md += `- [${item.completed ? "x" : " "}] ${item.text}\n`;
    }
    md += "\n";
  }

  if (meeting.bookmarks && meeting.bookmarks.length > 0) {
    md += `## ${t("misc:export.headings.bookmarks")}\n\n`;
    const sortedBookmarks = [...meeting.bookmarks].sort((a, b) => a.timestamp_ms - b.timestamp_ms);
    for (const b of sortedBookmarks) {
      const ts = formatTimestamp(Math.max(0, b.timestamp_ms - startMs));
      md += b.note ? `- **[${ts}]** ${b.note}\n` : `- **[${ts}]** *${t("misc:export.noNote")}*\n`;
    }
    md += "\n";
  }

  if (meeting.transcript.length > 0) {
    md += `## ${t("misc:export.headings.transcript")}\n\n`;
    for (const seg of meeting.transcript) {
      md += `**[${segmentTime(seg, startMs)}] ${resolveSpeaker(seg, speakerMap)}:** ${seg.text}\n\n`;
    }
  }

  if (meeting.ai_interactions.length > 0) {
    md += `## ${t("misc:export.headings.aiInteractions")}\n\n`;
    for (const ai of meeting.ai_interactions) {
      md += `### ${getModeLabel(ai.mode)} (${ai.provider}/${ai.model})\n\n${ai.response}\n\n---\n\n`;
    }
  }

  return md;
}

// ── Export: SRT ───────────────────────────────────────────────────────────────

function msToSrtTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const millis = ms % 1000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return (
    `${hours.toString().padStart(2, "0")}:` +
    `${minutes.toString().padStart(2, "0")}:` +
    `${seconds.toString().padStart(2, "0")},` +
    `${millis.toString().padStart(3, "0")}`
  );
}

export function exportToSRT(segments: TranscriptSegment[], startMs: number = 0, speakers?: SpeakerIdentity[]): string {
  const speakerMap = buildSpeakerMap(speakers);
  const lines: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segStart = Math.max(0, seg.timestamp_ms - startMs);
    // Estimate end: next segment start or +3 seconds
    const nextSeg = segments[i + 1];
    const segEnd = nextSeg
      ? Math.max(0, nextSeg.timestamp_ms - startMs)
      : segStart + 3000;

    lines.push(`${i + 1}`);
    lines.push(`${msToSrtTime(segStart)} --> ${msToSrtTime(segEnd)}`);
    lines.push(`${resolveSpeaker(seg, speakerMap)}: ${seg.text}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ── Export: JSON ──────────────────────────────────────────────────────────────

export function exportToJSON(meeting: Meeting): string {
  const data = {
    id: meeting.id,
    title: meeting.title,
    start_time: meeting.start_time,
    end_time: meeting.end_time,
    duration_seconds: meeting.duration_seconds,
    audio_mode: meeting.audio_mode,
    ai_scenario: meeting.ai_scenario,
    summary: meeting.summary ? stripThinkTags(meeting.summary) : meeting.summary,
    transcript: meeting.transcript,
    ai_interactions: meeting.ai_interactions,
    speakers: meeting.speakers,
    action_items: meeting.action_items,
    bookmarks: meeting.bookmarks,
    topic_sections: meeting.topic_sections,
  };
  return JSON.stringify(data, null, 2);
}

// ── Export: Study Notes (Lecture scenario) ────────────────────────────────────

export function exportStudyNotes(meeting: Meeting): string {
  const startMs = meetingStartMs(meeting);
  let md = `# ${t("misc:export.docs.heading", { kind: t("misc:export.docs.studyNotes"), title: meeting.title })}\n\n`;
  md += `**${t("misc:export.labels.date")}** ${formatMeetingStart(meeting)}\n`;
  if (meeting.duration_seconds) {
    md += `**${t("misc:export.labels.duration")}** ${formatDurationLong(meeting.duration_seconds * 1000)}\n`;
  }
  md += "\n";

  if (meeting.summary) {
    md += `## ${t("misc:export.headings.keyTakeaways")}\n\n${stripThinkTags(meeting.summary)}\n\n`;
  }

  if (meeting.topic_sections && meeting.topic_sections.length > 0) {
    md += `## ${t("misc:export.headings.topicsCovered")}\n\n`;
    for (const topic of meeting.topic_sections) {
      md += `### ${topic.title}\n`;
      md += `*${t("misc:export.startsAt", { time: formatTimestamp(topic.start_ms) })}*\n\n`;
      // Segments within this topic
      const topicEnd = topic.end_ms ?? Infinity;
      const topicSegs = meeting.transcript.filter(
        (s) => s.timestamp_ms >= topic.start_ms && s.timestamp_ms < topicEnd
      );
      for (const seg of topicSegs) {
        md += `- **[${segmentTime(seg, startMs)}]** ${seg.text}\n`;
      }
      md += "\n";
    }
  } else if (meeting.transcript.length > 0) {
    md += `## ${t("misc:export.headings.notes")}\n\n`;
    for (const seg of meeting.transcript) {
      md += `- **[${segmentTime(seg, startMs)}]** ${seg.text}\n`;
    }
    md += "\n";
  }

  if (meeting.action_items && meeting.action_items.length > 0) {
    md += `## ${t("misc:export.headings.followUpActions")}\n\n`;
    for (const item of meeting.action_items) {
      md += `- [${item.completed ? "x" : " "}] ${item.text}\n`;
    }
    md += "\n";
  }

  return md;
}

// ── Export: Meeting Minutes (Team Meeting scenario) ───────────────────────────

export function exportMeetingMinutes(meeting: Meeting): string {
  const startMs = meetingStartMs(meeting);
  const speakerMap = buildSpeakerMap(meeting.speakers);
  let md = `# ${t("misc:export.docs.heading", { kind: t("misc:export.docs.meetingMinutes"), title: meeting.title })}\n\n`;
  md += `**${t("misc:export.labels.date")}** ${formatMeetingStart(meeting)}\n`;
  if (meeting.duration_seconds) {
    md += `**${t("misc:export.labels.duration")}** ${formatDurationLong(meeting.duration_seconds * 1000)}\n`;
  }
  if (meeting.speakers && meeting.speakers.length > 0) {
    md += `**${t("misc:export.labels.attendees")}** ${meeting.speakers.map((s) => s.display_name).join(t("misc:export.attendeeSeparator"))}\n`;
  }
  md += "\n";

  if (meeting.summary) {
    md += `## ${t("misc:export.headings.summary")}\n\n${stripThinkTags(meeting.summary)}\n\n`;
  }

  if (meeting.topic_sections && meeting.topic_sections.length > 0) {
    md += `## ${t("misc:export.headings.agendaItems")}\n\n`;
    for (const topic of meeting.topic_sections) {
      md += `### ${topic.title}\n\n`;
      const topicEnd = topic.end_ms ?? Infinity;
      const topicSegs = meeting.transcript.filter(
        (s) => s.timestamp_ms >= topic.start_ms && s.timestamp_ms < topicEnd
      );
      for (const seg of topicSegs) {
        md += `**${resolveSpeaker(seg, speakerMap)}** *(${segmentTime(seg, startMs)})*: ${seg.text}\n\n`;
      }
    }
  } else if (meeting.transcript.length > 0) {
    md += `## ${t("misc:export.headings.discussion")}\n\n`;
    for (const seg of meeting.transcript) {
      md += `**${resolveSpeaker(seg, speakerMap)}** *(${segmentTime(seg, startMs)})*: ${seg.text}\n\n`;
    }
  }

  if (meeting.action_items && meeting.action_items.length > 0) {
    md += `## ${t("misc:export.headings.actionItems")}\n\n`;
    for (const item of meeting.action_items) {
      const assignee = meeting.speakers?.find((s) => s.id === item.assignee_speaker_id);
      md += `- [${item.completed ? "x" : " "}] ${item.text}`;
      if (assignee) md += ` *(${assignee.display_name})*`;
      md += "\n";
    }
    md += "\n";
  }

  return md;
}

// ── Scenario-specific export registry ────────────────────────────────────────

interface ScenarioExportFormat {
  label: string;
  extension: string;
  fn: (meeting: Meeting) => string;
}

export function getScenarioExportFormat(scenario: AIScenario | undefined): ScenarioExportFormat | null {
  switch (scenario) {
    case "lecture":
      return { label: t("misc:export.docs.studyNotes"), extension: "md", fn: exportStudyNotes };
    case "team_meeting":
      return { label: t("misc:export.docs.meetingMinutes"), extension: "md", fn: exportMeetingMinutes };
    default:
      return null;
  }
}

// ── File save helper ─────────────────────────────────────────────────────────

interface SaveOptions {
  defaultName: string;
  extension: string;
  filterLabel: string;
  content: string;
}

export async function saveExportFile({ defaultName, extension, filterLabel, content }: SaveOptions): Promise<boolean> {
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const filePath = await save({
      defaultPath: `${safeFilename(defaultName)}.${extension}`,
      filters: [{ name: filterLabel, extensions: [extension] }],
    });
    if (!filePath) return false;
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    await writeTextFile(filePath, content);
    showToast(t("misc:export.toast.exported"), "success");
    return true;
  } catch (err) {
    console.error("[Export] Failed:", err);
    showToast(t("misc:export.toast.failed"), "error");
    return false;
  }
}

// ── Convenience wrappers ──────────────────────────────────────────────────────

export async function exportMeetingAsMarkdown(meeting: Meeting): Promise<boolean> {
  return saveExportFile({
    defaultName: meeting.title,
    extension: "md",
    filterLabel: "Markdown", // i18n-ignore: file format name
    content: exportToMarkdown(meeting),
  });
}

export async function exportMeetingAsSRT(meeting: Meeting): Promise<boolean> {
  const startMs = meetingStartMs(meeting);
  return saveExportFile({
    defaultName: meeting.title,
    extension: "srt",
    filterLabel: t("misc:export.filters.srt"),
    content: exportToSRT(meeting.transcript, startMs, meeting.speakers),
  });
}

export async function exportMeetingAsJSON(meeting: Meeting): Promise<boolean> {
  return saveExportFile({
    defaultName: meeting.title,
    extension: "json",
    filterLabel: "JSON",
    content: exportToJSON(meeting),
  });
}

export async function exportMeetingScenario(meeting: Meeting): Promise<boolean> {
  const fmt = getScenarioExportFormat(meeting.ai_scenario);
  if (!fmt) return false;
  return saveExportFile({
    defaultName: `${meeting.title} — ${fmt.label}`,
    extension: fmt.extension,
    filterLabel: fmt.label,
    content: fmt.fn(meeting),
  });
}
