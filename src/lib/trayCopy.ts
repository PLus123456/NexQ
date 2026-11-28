import { t } from "../i18n";
import { useActionItemStore } from "../stores/actionItemStore";
import { useCallLogStore } from "../stores/callLogStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useTranscriptStore } from "../stores/transcriptStore";
import { showToast } from "../stores/toastStore";
import { getMeeting, listMeetings, writeClipboardText } from "./ipc";
import type { ActionItem, TranscriptSegment } from "./types";
import { stripThinkTags } from "./utils";
import { PAST_MEETING_MODES } from "../hooks/useStreamBuffer";

export type TrayCopyKind = "ai_answer" | "action_items" | "summary" | "transcript";

function actionItemsText(items: readonly ActionItem[]): string {
  return items.map((item) => `- [${item.completed ? "x" : " "}] ${item.text}`).join("\n");
}

function transcriptText(segments: readonly TranscriptSegment[]): string {
  return segments.filter((segment) => segment.is_final)
    .map(({ speaker, text }) => `${speaker}: ${text}`).join("\n");
}

function liveText(kind: TrayCopyKind): string {
  if (kind === "transcript") return transcriptText(useTranscriptStore.getState().segments);
  if (kind === "action_items") return actionItemsText(useActionItemStore.getState().items);
  if (kind === "ai_answer") {
    const answer = useCallLogStore.getState().entries.find((entry) =>
      (entry.status === "complete" || entry.status === "cancelled") && entry.responseContentClean &&
      !PAST_MEETING_MODES.has(entry.mode) && !entry.mode.startsWith("question_"),
    );
    return answer?.responseContentClean ?? "";
  }
  return "";
}

async function savedText(kind: TrayCopyKind, meetingId?: string): Promise<string> {
  const id = meetingId ?? (await listMeetings(50, 0)).find((meeting) => meeting.end_time)?.id;
  if (!id) return "";
  const meeting = await getMeeting(id);
  switch (kind) {
    case "ai_answer": return stripThinkTags(meeting.ai_interactions.find((answer) => answer.response)?.response ?? "");
    case "action_items": return actionItemsText(meeting.action_items ?? []);
    case "summary": return stripThinkTags(meeting.summary ?? "");
    case "transcript": return transcriptText(meeting.transcript);
  }
}

export async function copyFromTray(kind: TrayCopyKind): Promise<void> {
  try {
    const meetingId = useMeetingStore.getState().activeMeeting?.id;
    const text = (meetingId ? liveText(kind) : "") || await savedText(kind, meetingId);
    if (!text.trim()) {
      showToast(t("common:status.nothingToCopy"), "info");
      return;
    }
    await writeClipboardText(text);
    showToast(t("common:status.copiedToClipboard"), "success");
  } catch (error) {
    console.warn("[Tray] Copy failed:", error);
    showToast(t("common:errors.copyFailed"), "error");
  }
}
