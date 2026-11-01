// The personal knowledge base (upload a resume, documents) in a dialog over
// the first-run setup, with a way to its search and embedding settings.

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Database, Settings2, X } from "lucide-react";
import { useT } from "../../i18n";
import { ContextPanel } from "../../context/ContextPanel";
import { useMeetingStore } from "../../stores/meetingStore";

/** Settings tab of the knowledge base (search strategy, embedding service). */
export const KNOWLEDGE_BASE_SETTINGS_TAB = "context_strategy";

export function KnowledgeBaseDialog({ onClose }: { onClose: () => void }) {
  const { t } = useT(["onboarding", "common"]);
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const openSettings = () => {
    onClose();
    useMeetingStore.getState().openSettings(KNOWLEDGE_BASE_SETTINGS_TAB);
  };

  // On <body>: an ancestor's transform (step animations) would trap a fixed overlay.
  return createPortal(
    <div
      ref={backdropRef}
      onClick={(e) => {
        if (e.target === backdropRef.current) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("knowledgeBase.title")}
        className="flex h-[560px] max-h-full w-[620px] max-w-full flex-col rounded-xl border border-border/40 bg-card shadow-2xl shadow-black/20"
      >
        <div className="flex items-center justify-between border-b border-border/30 px-5 py-3.5">
          <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
            <Database className="h-4 w-4 text-primary" />
            {t("knowledgeBase.title")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
            aria-label={t("common:actions.close")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* The panel fills this height and scrolls inside it */}
        <div className="min-h-0 flex-1 overflow-hidden">
          <ContextPanel />
        </div>

        <div className="flex items-center justify-between border-t border-border/30 px-5 py-3">
          <button
            type="button"
            onClick={openSettings}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-primary"
          >
            <Settings2 className="h-3.5 w-3.5" />
            {t("knowledgeBase.settings")}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
          >
            {t("common:actions.done")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
