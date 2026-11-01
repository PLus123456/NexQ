import { useEffect } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { useRagStore } from "../stores/ragStore";
import { onOllamaPullProgress, onTranscriptIndexed } from "../lib/events";

// Indexing progress (`rag_index_progress`) and settings changes reach every
// window through ragStore's own listeners; this hook adds the Ollama model
// download progress for the settings page.
export function useRagEvents() {
  const setPullProgress = useRagStore((s) => s.setPullProgress);
  const setIsPullingModel = useRagStore((s) => s.setIsPullingModel);
  const refreshIndexStatus = useRagStore((s) => s.refreshIndexStatus);

  useEffect(() => {
    let unlistenPull: UnlistenFn | null = null;
    let unlistenTranscript: UnlistenFn | null = null;
    let mounted = true;

    const setup = async () => {
      const unlisten1 = await onOllamaPullProgress((event) => {
        if (!mounted) return;
        setPullProgress({
          status: event.status,
          total: event.total,
          completed: event.completed,
        });
        if (event.status === "complete" || event.status === "success") {
          setIsPullingModel(false);
          setPullProgress(null);
        }
      });

      const unlisten2 = await onTranscriptIndexed(() => {
        if (!mounted) return;
        refreshIndexStatus();
      });

      if (mounted) {
        unlistenPull = unlisten1;
        unlistenTranscript = unlisten2;
      } else {
        unlisten1();
        unlisten2();
      }
    };

    setup();

    return () => {
      mounted = false;
      if (unlistenPull) unlistenPull();
      if (unlistenTranscript) unlistenTranscript();
    };
  }, []);
}
