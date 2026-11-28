import { emit, listen } from "@tauri-apps/api/event";
import { t } from "../i18n";
import type { AIScenario, AudioMode, Meeting, WindowMeetingEndedEvent } from "./types";

export const MEETING_STARTED = "nexq:meeting_started";
export const MEETING_ENDED = "nexq:meeting_ended";
export const MEETING_END_FAILED = "nexq:meeting_end_failed";
export const MEETING_STOP_REQUEST = "tray_stop_meeting";
export const OVERLAY_SAVE_REQUEST = "nexq:save_overlay_meeting";
export const OVERLAY_PRESENT = "nexq:overlay_meeting_present";
const OVERLAY_SAVED = "nexq:overlay_meeting_saved";
const OVERLAY_READY = "nexq:overlay_meeting_ready";
export const WINDOW_READY_TIMEOUT_MS = 4_000;
const OVERLAY_SAVE_TIMEOUT_MS = 30_000;
export const MEETING_END_TIMEOUT_MS = 120_000;

export type MeetingStarted = { meeting: Meeting; audioMode: AudioMode; aiScenario: AIScenario };
export type MeetingEndResult = { meetingId: string; message?: string };
export type OverlaySaveRequest = { meetingId: string; requestId: string };
type OverlaySaveResult = OverlaySaveRequest & { message?: string; speakerAliases?: [string, string][] };

export async function startOverlayMeeting(payload: MeetingStarted, waitForOverlay: boolean): Promise<boolean> {
  if (!waitForOverlay) {
    await emit(MEETING_STARTED, payload);
    return false;
  }

  let ready!: (value: boolean) => void;
  const done = new Promise<boolean>((resolve) => { ready = resolve; });
  const unlisten = await listen<{ meetingId: string }>(OVERLAY_READY, ({ payload: ack }) => {
    if (ack.meetingId === payload.meeting.id) ready(true);
  });
  const timer = setTimeout(() => ready(false), WINDOW_READY_TIMEOUT_MS);
  // The hidden webview can finish loading after the first start event.
  const retry = setInterval(() => { void emit(MEETING_STARTED, payload).catch(() => {}); }, 250);
  try {
    void emit(MEETING_STARTED, payload).catch(() => {});
    return await done;
  } finally {
    clearTimeout(timer);
    clearInterval(retry);
    unlisten();
  }
}

export function acknowledgeOverlaySave(result: OverlaySaveResult): Promise<void> {
  return emit(OVERLAY_SAVED, result);
}

export async function saveMeetingInOverlay(meetingId: string): Promise<Map<string, string>> {
  const request = { meetingId, requestId: crypto.randomUUID() };
  let finish!: (result: OverlaySaveResult) => void;
  const done = new Promise<OverlaySaveResult>((resolve) => { finish = resolve; });
  const unlisten = await listen<OverlaySaveResult>(OVERLAY_SAVED, ({ payload }) => {
    if (payload.meetingId === meetingId && payload.requestId === request.requestId) finish(payload);
  });
  const timer = setTimeout(() => finish({ ...request, message: t("onboarding:meetingFlow.overlaySaveTimeout") }), OVERLAY_SAVE_TIMEOUT_MS);
  try {
    const result = await Promise.race([done, emit(OVERLAY_SAVE_REQUEST, request).then(() => done)]);
    if (result.message) throw new Error(result.message);
    return new Map(result.speakerAliases);
  } finally {
    clearTimeout(timer);
    unlisten();
  }
}

/** The launcher owns ending even when the user presses End in the overlay. */
export async function endMeetingInLauncher(meetingId: string, timeoutMs = MEETING_END_TIMEOUT_MS): Promise<void> {
  let finish!: (result: MeetingEndResult) => void;
  const done = new Promise<MeetingEndResult>((resolve) => { finish = resolve; });
  const onResult = ({ payload }: { payload: MeetingEndResult }) => {
    if (payload.meetingId === meetingId) finish(payload);
  };
  const unlisten = await listen<WindowMeetingEndedEvent>(MEETING_ENDED, (event) => {
    if (event.payload.window === "launcher") onResult(event);
  });
  let unlistenFailure: (() => void) | undefined;
  const timer = setTimeout(() => finish({ meetingId, message: t("onboarding:meetingFlow.endTimeout") }), timeoutMs);
  try {
    unlistenFailure = await listen<MeetingEndResult>(MEETING_END_FAILED, onResult);
    const result = await Promise.race([done, emit(MEETING_STOP_REQUEST, { meetingId }).then(() => done)]);
    if (result.message) throw new Error(result.message);
  } finally {
    clearTimeout(timer);
    unlisten();
    unlistenFailure?.();
  }
}
