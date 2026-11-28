import { useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { createEventScope } from "../lib/eventScope";
import { t } from "../i18n";
import { onSTTConnectionStatus, type STTConnectionStatusEvent } from "../lib/events";
import { onSonioxRegionSwitch } from "../lib/stt/events";
import { STT_LABELS } from "../lib/stt/providerMeta";
import type { SonioxRegionSwitchEvent, SonioxSwitchReason } from "../lib/stt/types";
import { sonioxRegionInText } from "../settings/stt/sonioxRegions";
import { useSttRegionStore } from "../stores/sttRegionStore";
import { showToast } from "../stores/toastStore";

/**
 * The event's party in the UI language; anything else as sent. Upstream's
 * engines name the other side of an in-person meeting "Room" (the fork's own
 * engines keep "Them", which the region display is keyed by).
 */
export function partyName(party: string): string {
  if (party === "You") return t("common:labels.you");
  if (party === "Them") return t("common:labels.them");
  if (party === "Room") return t("common:labels.room");
  return party;
}

/** Product names as they are; Remote Whisper is worded per UI language. */
function engineName(provider: string): string {
  if (provider === "openai_compat") return t("stt:engines.openai_compat.label");
  return STT_LABELS[provider] ?? provider;
}

const SWITCH_REASONS: readonly SonioxSwitchReason[] = [
  "concurrency",
  "unavailable",
  "model_not_available",
  "budget",
  "network",
  "key_rejected",
  "internal_error",
];

/** The notice for a Soniox session that moved region ("Them: the Japan region is at its concurrency limit, switching to the India region"). */
export function regionSwitchMessage(event: SonioxRegionSwitchEvent): string {
  const values = { party: partyName(event.party), from: sonioxRegionInText(event.from), to: sonioxRegionInText(event.to) };
  return SWITCH_REASONS.includes(event.reason)
    ? t(`stt:soniox.switch.${event.reason}`, values)
    : t("stt:soniox.switch.other", values);
}

/**
 * Toasts for STT connections (connected once per engine and party, errors)
 * and the Soniox region each party is connected to (`useSttRegionStore`,
 * cleared when the meeting ends). Runs in both windows.
 */
export function useSTTStatus() {
  const connectedRef = useRef<Set<string>>(new Set());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const scope = createEventScope("STT status");
    const setRegion = (party: string, region: string | null) => useSttRegionStore.getState().setRegion(party, region);

    void Promise.all([
      scope.add(onSTTConnectionStatus, (event: STTConnectionStatusEvent) => {
        console.log("[STT Status]", event);

        // Soniox: the region the party is connected to (the chips' tooltips).
        if (event.provider === "soniox") {
          if (event.status === "connected" && event.region) setRegion(event.party, event.region);
          else if (event.status === "disconnected") setRegion(event.party, null);
        }

        if (event.status === "error" && event.message) {
          showToast(t("stt:status.error", { party: partyName(event.party), message: event.message }), "error");
        } else if (event.status === "connected") {
          const key = `${event.provider}_${event.party}`;
          if (!connectedRef.current.has(key)) {
            connectedRef.current.add(key);
            showToast(
              t("stt:status.connected", { engine: engineName(event.provider), party: partyName(event.party) }),
              "info",
            );
          }
        } else if (event.status === "disconnected") {
          const key = `${event.provider}_${event.party}`;
          connectedRef.current.delete(key);
        }
      }),
      scope.add(onSonioxRegionSwitch, (event) => setRegion(event.party, event.to)),
    ]).then((results) => {
      if (scope.active()) setReady(results.every(Boolean));
    });

    return () => {
      scope.dispose();
      connectedRef.current.clear();
      useSttRegionStore.getState().clear();
    };
  }, []);

  return ready;
}

/**
 * One toast per Soniox region switch. Mounted in the overlay window only
 * (where meetings run): the event reaches every window, and the launcher
 * would show the same notice a second time.
 */
export function useSonioxRegionSwitchToast() {
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let mounted = true;
    onSonioxRegionSwitch((event) => {
      if (mounted) showToast(regionSwitchMessage(event), "warning");
    })
      .then((u) => {
        if (mounted) unlisten = u;
        else u();
      })
      .catch((e) => console.warn("[STT Status] listen failed:", e));
    return () => {
      mounted = false;
      unlisten?.();
    };
  }, []);
}
