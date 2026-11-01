import { useEffect, useRef } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { t } from "../i18n";
import { onSTTConnectionStatus, type STTConnectionStatusEvent } from "../lib/events";
import { STT_LABELS } from "../lib/stt/providerMeta";
import { showToast } from "../stores/toastStore";

/** The event's party ("You" / "Them") in the UI language; anything else as sent. */
function partyName(party: string): string {
  if (party === "You") return t("common:labels.you");
  if (party === "Them") return t("common:labels.them");
  return party;
}

/** Product names as they are; Remote Whisper is worded per UI language. */
function engineName(provider: string): string {
  if (provider === "openai_compat") return t("stt:engines.openai_compat.label");
  return STT_LABELS[provider] ?? provider;
}

export function useSTTStatus() {
  const connectedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let mounted = true;

    const setup = async () => {
      const u = await onSTTConnectionStatus((event: STTConnectionStatusEvent) => {
        if (!mounted) return;
        console.log("[STT Status]", event);

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
      });
      if (mounted) unlisten = u; else u();
    };

    setup();
    return () => { mounted = false; if (unlisten) unlisten(); };
  }, []);
}
