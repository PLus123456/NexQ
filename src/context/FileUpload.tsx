import { useState, useCallback, useEffect, useRef } from "react";
import { CloudUpload, Loader2 } from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { useContextStore } from "../stores/contextStore";
import { isWindows } from "../lib/platform";
import { useT } from "../i18n";

export function FileUpload() {
  const { t } = useT("rag");
  const loadFile = useContextStore((s) => s.loadFile);
  const dropZone = useRef<HTMLButtonElement>(null);
  const busy = useRef(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!errorMessage) return;
    const timeout = setTimeout(() => setErrorMessage(null), 5000);
    return () => clearTimeout(timeout);
  }, [errorMessage]);

  const upload = useCallback(
    async (choosePaths: () => Promise<string[]>) => {
      if (busy.current) return;
      busy.current = true;
      setErrorMessage(null);
      try {
        const paths = await choosePaths();
        if (!paths.length) return;
        setIsProcessing(true);
        for (const path of paths) {
          try {
            // load_context_file owns background indexing and observes auto_index.
            await loadFile(path);
          } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : String(error));
          }
        }
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      } finally {
        busy.current = false;
        setIsProcessing(false);
      }
    },
    [loadFile]
  );

  useEffect(() => {
    if (!isTauri()) return;
    let mounted = true;
    const subscription = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (!mounted) return;
      if (payload.type === "leave") {
        setIsDragOver(false);
        return;
      }
      // Wry 0.57 forwards Win32 client pixels, AppKit points and GTK widget coordinates.
      const scale = isWindows() ? window.devicePixelRatio : 1;
      const target = document.elementFromPoint(payload.position.x / scale, payload.position.y / scale);
      const inside = dropZone.current?.contains(target) ?? false;
      setIsDragOver(payload.type !== "drop" && inside && !busy.current);
      if (payload.type === "drop" && inside) void upload(async () => payload.paths);
    });
    void subscription.catch((error) => console.warn("[FileUpload] Drag and drop unavailable:", error));
    return () => {
      mounted = false;
      void subscription.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [upload]);

  const handleBrowse = useCallback(() => {
    void upload(async () => {
      const selected = await open({
        multiple: true,
        filters: [
          {
            name: t("context.fileUpload.browseDialog.filterName"),
            extensions: ["pdf", "txt", "md", "docx"],
          },
        ],
      });
      return Array.isArray(selected) ? selected : selected ? [selected] : [];
    });
  }, [upload, t]);

  return (
    <div className="w-full">
      {/* Drop zone */}
      <button
        ref={dropZone}
        type="button"
        disabled={isProcessing}
        onClick={handleBrowse}
        aria-label={t("context.fileUpload.dropZone.ariaLabel")}
        className={`relative flex w-full flex-col items-center justify-center rounded-xl border-2 border-dashed transition-all duration-200 ${
          isDragOver
            ? "border-primary/60 bg-primary/5 scale-[1.01]"
            : "border-muted-foreground/20 bg-secondary/20 hover:border-muted-foreground/30 hover:bg-secondary/30"
        } px-6 py-6`}
      >
        {isProcessing ? (
          <>
            <Loader2 className="mb-2 h-8 w-8 animate-spin text-primary/60" />
            <span className="text-sm font-medium text-muted-foreground">
              {t("context.fileUpload.dropZone.processing")}
            </span>
          </>
        ) : (
          <>
            <CloudUpload
              className={`mb-2 h-8 w-8 transition-colors duration-200 ${
                isDragOver ? "text-primary" : "text-primary/30"
              }`}
            />
            <span className="text-sm font-medium text-muted-foreground">
              {isDragOver
                ? t("context.fileUpload.dropZone.dropToUpload")
                : t("context.fileUpload.dropZone.dragHere")}
            </span>
            <span className="mt-1 text-xs text-muted-foreground">
              {t("context.fileUpload.dropZone.supportedTypes")}
            </span>
            <span className="mt-3 rounded-lg border border-primary/20 bg-primary/5 px-4 py-1.5 text-xs font-medium text-primary">
              {t("context.fileUpload.browse")}
            </span>
          </>
        )}
      </button>

      {/* Error toast */}
      {errorMessage && (
        <div className="mt-2 rounded-xl bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {errorMessage}
        </div>
      )}
    </div>
  );
}
