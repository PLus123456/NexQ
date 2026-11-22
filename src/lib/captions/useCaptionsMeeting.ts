import { useEffect } from "react";
import { useConfigStore } from "../../stores/configStore";
import { useMeetingStore } from "../../stores/meetingStore";
import { hideCaptions, setCaptionsLocked, showCaptions } from "./window";

/**
 * The caption strip follows the meeting (SPEC 3.2): shown when a meeting
 * starts and `captionsEnabled` is on, hidden and unlocked when it ends.
 * Mounted once in the app, active in the answer window only (`active`), where
 * the meeting store's active meeting is set on `nexq:meeting_started` and
 * cleared when the meeting ends.
 */
export function useCaptionsMeeting(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    return useMeetingStore.subscribe((now, before) => {
      const id = now.activeMeeting?.id ?? null;
      if (id === (before.activeMeeting?.id ?? null)) return;
      if (id) {
        if (useConfigStore.getState().captionsEnabled) void showCaptions();
      } else {
        void hideCaptions();
        if (useConfigStore.getState().captionsLocked) void setCaptionsLocked(false);
      }
    });
  }, [active]);
}
