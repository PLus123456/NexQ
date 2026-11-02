import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

// Each webview owns its browser recognition. The launcher registers its stop
// handler here; meeting end awaits it before persisting the final transcript.
const stops = new Set<() => Promise<void>>();
const drainedMeetings = new Set<string>();
function markDrained(meetingId: string) {
  drainedMeetings.add(meetingId);
  if (drainedMeetings.size > 8) drainedMeetings.delete(drainedMeetings.values().next().value!);
}
const STOP_REQUEST = "nexq:web_speech_stop";
const STOP_ACK = "nexq:web_speech_stopped";
type StopRequest = { meetingId: string; requestId: string };

export function registerWebSpeechStop(stop: () => Promise<void>): () => void {
  stops.add(stop);
  return () => { stops.delete(stop); };
}

/** Gracefully stop this webview's recognition and wait for its last results. */
export async function stopWebSpeechRecognition(): Promise<void> {
  await Promise.all([...stops].map((stop) => stop()));
}

/** The launcher also services stop requests sent by the overlay. */
export function onWebSpeechStopRequest(beginStop: (meetingId: string) => boolean): Promise<UnlistenFn> {
  return listen<StopRequest>(STOP_REQUEST, ({ payload }) => {
    if (!beginStop(payload.meetingId)) {
      // The launcher may have already finished while the overlay was saving.
      // A late acknowledgement must never stop the next meeting's recognizer.
      if (drainedMeetings.has(payload.meetingId)) void emit(STOP_ACK, payload).catch(() => {});
      return;
    }
    void stopWebSpeechRecognition().then(() => {
      markDrained(payload.meetingId);
      return emit(STOP_ACK, payload);
    }).catch(() => {});
  });
}

/** Both windows wait for the launcher before saving transcript/speaker data. */
export async function stopMeetingWebSpeech(meetingId: string): Promise<void> {
  if (getCurrentWebviewWindow().label === "launcher") {
    await stopWebSpeechRecognition();
    markDrained(meetingId);
    return;
  }
  const request: StopRequest = { meetingId, requestId: crypto.randomUUID() };
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const unlisten = await listen<StopRequest>(STOP_ACK, ({ payload }) => {
    if (payload.meetingId === meetingId && payload.requestId === request.requestId) finish();
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Timed out waiting for browser speech recognition to finish")), 3000);
    });
    await Promise.race([emit(STOP_REQUEST, request).then(() => done), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    unlisten();
  }
}
