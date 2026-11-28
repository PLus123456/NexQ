import { useEffect } from "react";
import { useMeetingStore } from "../stores/meetingStore";
import { useTranscriptPersistence } from "../hooks/useTranscriptPersistence";
import { useTranscript } from "../hooks/useTranscript";
import { useSpeechRecognition } from "../hooks/useSpeechRecognition";
import { useAudioConfigSync } from "../hooks/useAudioConfigSync";
import { useStreamBuffer } from "../hooks/useStreamBuffer";
import { useCallLogCapture } from "../hooks/useCallLogCapture";
import { useQuestionDetectionLog } from "../hooks/useQuestionDetectionLog";
import { useSTTStatus, useSonioxRegionSwitchToast } from "../hooks/useSTTStatus";
import { useDevLog } from "../hooks/useDevLog";

export function ActiveMeetingProvider({ isLauncherWindow = true }: { isLauncherWindow?: boolean }) {
  const meetingId = useMeetingStore((s) => s.activeMeeting?.id);
  if (!meetingId) return null;
  return <MeetingHooks key={meetingId} meetingId={meetingId} isLauncherWindow={isLauncherWindow} />;
}

function MeetingHooks({ meetingId, isLauncherWindow }: { meetingId: string; isLauncherWindow: boolean }) {
  const transcriptReady = useTranscript();
  const statusReady = useSTTStatus();
  const logReady = useCallLogCapture(isLauncherWindow);
  useQuestionDetectionLog();
  useStreamBuffer();
  useDevLog();

  useEffect(() => {
    if (transcriptReady && statusReady && logReady) {
      useMeetingStore.getState().setMeetingListenersReady(meetingId);
    }
  }, [meetingId, transcriptReady, statusReady, logReady]);

  return isLauncherWindow ? <LauncherAudioHooks /> : <OverlayNotices />;
}

function LauncherAudioHooks() {
  useSpeechRecognition();
  useAudioConfigSync();
  useTranscriptPersistence();
  return null;
}

function OverlayNotices() {
  useSonioxRegionSwitchToast();
  return null;
}
