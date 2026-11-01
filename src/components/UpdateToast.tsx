import { useEffect, useRef, useState } from "react";
import { ArrowUpCircle, X } from "lucide-react";
import { open } from "@tauri-apps/plugin-shell";
import { useT } from "../i18n";
import { useUpdaterStore } from "../stores/updaterStore";
import { releaseNotesUrl } from "../hooks/useUpdater";

const AUTO_DISMISS_MS = 12_000;

/**
 * One-time notice when an update has finished downloading. The footer pill
 * stays as the persistent way to restart; this only announces it once per
 * version, with a link to the release notes.
 */
export function UpdateReadyToast() {
  const { t } = useT(["settings", "common"]);
  const phase = useUpdaterStore((s) => s.phase);
  const version = useUpdaterStore((s) => s.version);
  const autoUpdate = useUpdaterStore((s) => s.autoUpdate);
  const announced = useRef(new Set<string>());
  const [visibleVersion, setVisibleVersion] = useState<string | null>(null);

  useEffect(() => {
    if (phase !== "ready" || !version || announced.current.has(version)) return;
    announced.current.add(version);
    setVisibleVersion(version);
  }, [phase, version]);

  useEffect(() => {
    if (!visibleVersion) return;
    const timer = setTimeout(() => setVisibleVersion(null), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [visibleVersion]);

  // Hide if the update was skipped or installed meanwhile.
  if (!visibleVersion || phase !== "ready" || version !== visibleVersion) return null;

  return (
    <div className="fixed bottom-14 right-4 z-50">
      <div
        role="status"
        aria-live="polite"
        className="flex w-[300px] items-start gap-3 rounded-xl border border-border/20 bg-card/90 px-4 py-3 shadow-lg backdrop-blur-md"
      >
        <ArrowUpCircle className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground/90">
            {t("updates.toast.ready", { version: visibleVersion })}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {autoUpdate ? t("updates.toast.restartOrQuit") : t("updates.toast.restartToInstall")}
          </p>
          <button
            onClick={() => open(releaseNotesUrl(visibleVersion)).catch(() => {})}
            className="mt-1.5 text-xs font-medium text-primary hover:underline"
          >
            {t("updates.toast.whatsNew")}
          </button>
        </div>
        <button
          onClick={() => setVisibleVersion(null)}
          aria-label={t("common:actions.dismiss")}
          className="shrink-0 rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
