import { useEffect, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { EMPTY_FEED, feedTranscript, feedTranslation, type CaptionFeed } from "../lib/captions/feed";
import type { TranscriptUpdateEvent, TranslationResult } from "../lib/types";

/**
 * The caption window's own copy of the conversation: it listens to the
 * transcript and translation events every window gets (SPEC 3.2) and keeps
 * the last few lines in memory. A new meeting starts it empty.
 */
export function useCaptionFeed(): CaptionFeed {
  const [feed, setFeed] = useState<CaptionFeed>(EMPTY_FEED);

  useEffect(() => {
    let mounted = true;
    const stops: UnlistenFn[] = [];
    const keep = (stop: UnlistenFn) => {
      if (mounted) stops.push(stop);
      else stop();
    };
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        keep(await listen<TranscriptUpdateEvent>("transcript_update", (e) => {
          if (e.payload?.segment) setFeed((f) => feedTranscript(f, e.payload.segment, false));
        }));
        keep(await listen<TranscriptUpdateEvent>("transcript_final", (e) => {
          if (e.payload?.segment) setFeed((f) => feedTranscript(f, e.payload.segment, true));
        }));
        keep(await listen<TranslationResult>("translation_result", (e) => {
          if (e.payload) setFeed((f) => feedTranslation(f, e.payload));
        }));
        keep(await listen("nexq:meeting_started", () => setFeed(EMPTY_FEED)));
      } catch (err) {
        console.warn("[captions] Could not listen to the transcript:", err);
      }
    })();
    return () => {
      mounted = false;
      stops.forEach((stop) => stop());
    };
  }, []);

  return feed;
}
