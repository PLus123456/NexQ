import { useState, useEffect, useCallback, useRef } from "react";
import { listen, type Event } from "@tauri-apps/api/event";
import { createEventScope } from "../lib/eventScope";
import type { ModelDownloadProgress } from "../lib/types";
import { downloadLocalSTTModel, cancelModelDownload, listLocalSTTEngines } from "../lib/ipc";
import { showToast } from "../stores/toastStore";
import { t } from "../i18n";

type DownloadState = Record<string, ModelDownloadProgress>;

export function useModelDownload(restoreSttDownloads = false) {
  const [downloads, setDownloads] = useState<DownloadState>({});
  const listenerReady = useRef<Promise<boolean> | null>(null);

  useEffect(() => {
    const scope = createEventScope("Model downloads");
    const updated = new Set<string>();
    const timeouts = new Map<string, ReturnType<typeof setTimeout>>();

    const subscription = scope.add<Event<ModelDownloadProgress>>(
      (callback) => listen("model_download_progress", callback),
      ({ payload }) => {
        const key = `${payload.engine}:${payload.model_id}`;
        updated.add(key);
        clearTimeout(timeouts.get(key));
        timeouts.delete(key);
        setDownloads((prev) => ({ ...prev, [key]: payload }));

        const terminal = payload.status === "complete" || payload.status === "cancelled"
          || (payload.status === "error" && payload.engine === "opus_mt");
        if (terminal) {
          timeouts.set(key, setTimeout(() => {
            timeouts.delete(key);
            setDownloads((prev) => {
              if (prev[key] !== payload) return prev;
              const next = { ...prev };
              delete next[key];
              return next;
            });
          }, 3000));
        }
      },
    );
    listenerReady.current = subscription;

    if (restoreSttDownloads) {
      void subscription.then(async (registered) => {
        if (!registered) return;
        const engines = await listLocalSTTEngines();
        if (!scope.active()) return;
        const snapshot: DownloadState = {};
        for (const engine of engines) {
          for (const model of engine.models) {
            const key = `${engine.engine}:${model.id}`;
            if (model.download_progress && !updated.has(key)) {
              snapshot[key] = model.download_progress;
            }
          }
        }
        setDownloads((prev) => ({ ...snapshot, ...prev }));
      }).catch((err) => console.warn("Failed to restore model downloads:", err));
    }

    return () => {
      listenerReady.current = null;
      scope.dispose();
      for (const timer of timeouts.values()) clearTimeout(timer);
    };
  }, [restoreSttDownloads]);

  const waitForDownloadEvents = useCallback(async () => {
    await listenerReady.current;
  }, []);

  const startDownload = useCallback(async (engine: string, modelId: string) => {
    try {
      await waitForDownloadEvents();
      await downloadLocalSTTModel(engine, modelId);
    } catch (err: unknown) {
      const detail = typeof err === "string" ? err : err instanceof Error ? err.message : t("common:errors.unknown");
      showToast(t("stt:localModels.toasts.downloadFailed", { detail }), "error");
    }
  }, [waitForDownloadEvents]);

  const cancelDownloadFn = useCallback(async (engine: string, modelId: string) => {
    try {
      await cancelModelDownload(engine, modelId);
    } catch (err) {
      console.error("Failed to cancel download:", err);
    }
  }, []);

  return { downloads, startDownload, cancelDownload: cancelDownloadFn, waitForDownloadEvents };
}
