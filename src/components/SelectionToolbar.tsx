import { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { errorMessage, useTranslationStore } from "../stores/translationStore";
import { showToast } from "../stores/toastStore";
import { translateText } from "../lib/ipc";
import type { TranslationResult } from "../lib/types";
import { Languages, Copy } from "lucide-react";
import { useT } from "../i18n";
import { TranslationPopup } from "./TranslationPopup";

export function SelectionToolbar() {
  const { t } = useT("translation");
  const enabled = useTranslationStore((s) => s.selectionToolbarEnabled);
  const targetLang = useTranslationStore((s) => s.targetLang);
  const sourceLang = useTranslationStore((s) => s.sourceLang);

  const [selectedText, setSelectedText] = useState("");
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [translationResult, setTranslationResult] = useState<TranslationResult | null>(null);
  const [isTranslating, setIsTranslating] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const revision = useRef(0);

  const resetTranslation = useCallback(() => {
    revision.current += 1;
    setTranslationResult(null);
    setIsTranslating(false);
  }, []);

  const dismiss = useCallback(() => {
    setAnchor(null);
    resetTranslation();
  }, [resetTranslation]);

  // Handle text selection
  const handleMouseUp = useCallback((event: MouseEvent) => {
    if (!enabled || toolbarRef.current?.contains(event.target as Node)) return;
    const sel = window.getSelection();
    const text = sel?.toString().trim();
    if (!sel?.rangeCount || !text || text.length < 2) return;
    setSelectedText(text);
    setAnchor(sel.getRangeAt(0).getBoundingClientRect());
    resetTranslation();
  }, [enabled, resetTranslation]);

  // Dismiss on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (toolbarRef.current && !toolbarRef.current.contains(e.target as Node)) {
        dismiss();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [dismiss]);

  useEffect(() => {
    document.addEventListener("mouseup", handleMouseUp);
    return () => document.removeEventListener("mouseup", handleMouseUp);
  }, [handleMouseUp]);

  useEffect(() => {
    if (enabled) resetTranslation();
    else dismiss();
    return () => { revision.current += 1; };
  }, [enabled, targetLang, sourceLang, dismiss, resetTranslation]);

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar || !anchor) return;
    const placeToolbar = () => {
      const { width, height } = toolbar.getBoundingClientRect();
      const margin = 8;
      const center = anchor.left + anchor.width / 2;
      const above = anchor.top - height - margin;
      const top = above >= margin ? above : anchor.bottom + margin;
      toolbar.style.left = `${Math.max(margin, Math.min(center - width / 2, window.innerWidth - width - margin))}px`;
      toolbar.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - height - margin))}px`;
    };
    placeToolbar();
    window.addEventListener("resize", placeToolbar);
    return () => window.removeEventListener("resize", placeToolbar);
  }, [anchor, enabled, isTranslating, translationResult]);

  const handleTranslate = async () => {
    if (!selectedText) return;
    const lang = targetLang || "en";
    const request = ++revision.current;
    const isCurrent = () => {
      const config = useTranslationStore.getState();
      return request === revision.current && config.selectionToolbarEnabled
        && targetLang === config.targetLang && sourceLang === config.sourceLang;
    };
    setIsTranslating(true);
    try {
      const result = await translateText(
        selectedText,
        lang,
        sourceLang === "auto" ? undefined : sourceLang
      );
      if (isCurrent()) setTranslationResult(result);
    } catch (err) {
      if (!isCurrent()) return;
      console.error("[SelectionToolbar] Translation failed:", err);
      showToast(t("errors.translateFailed", { detail: errorMessage(err) }), "error");
    } finally {
      if (isCurrent()) setIsTranslating(false);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(selectedText);
    dismiss();
  };

  if (!anchor || !enabled) return null;

  return createPortal(
    <div
      ref={toolbarRef}
      className="fixed z-[9999] w-max max-w-[calc(100vw-16px)]"
    >
      {/* Mini toolbar */}
      <div className="flex w-fit gap-0.5 rounded-lg border border-border/40 bg-popover p-1 shadow-xl">
        <button
          onClick={handleTranslate}
          disabled={isTranslating}
          className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors disabled:opacity-50"
        >
          <Languages className="h-3 w-3" />
          {isTranslating ? t("selection.translating") : t("selection.translate")}
        </button>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent transition-colors"
        >
          <Copy className="h-3 w-3" />
        </button>
      </div>

      {/* Translation popup */}
      {translationResult && (
        <TranslationPopup
          result={translationResult}
          onClose={() => setTranslationResult(null)}
        />
      )}
    </div>,
    document.body,
  );
}
