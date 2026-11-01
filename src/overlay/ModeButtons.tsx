import { useCallback, useEffect, useMemo, useState } from "react";
import { useT } from "../i18n";
import { useStreamStore } from "../stores/streamStore";
import { useAIActionsStore } from "../stores/aiActionsStore";
import { useConfigStore } from "../stores/configStore";
import { cancelGeneration } from "../lib/ipc";
import { runUserAction } from "../lib/userAction";
import { actionDisplayName } from "../lib/actionNames";
import { DEFAULT_CONTEXT_SCOPE, scopeHint } from "../lib/contextScope";
import { showToast } from "../stores/toastStore";
import { ContextScopePicker } from "./ContextScopePicker";
import type { IntelligenceMode } from "../lib/types";
import {
  Loader2,
  Sparkles,
  MessageSquare,
  Scissors,
  CornerUpRight,
  ListChecks,
  HelpCircle,
  Wand2,
  Send,
  X,
} from "lucide-react";

// Icon mapping for built-in modes
const MODE_ICONS: Record<string, typeof Sparkles> = {
  Assist: Sparkles,
  WhatToSay: MessageSquare,
  Shorten: Scissors,
  FollowUp: CornerUpRight,
  Recap: ListChecks,
  AskQuestion: HelpCircle,
};

// Built-in shortcuts
const MODE_SHORTCUTS: Record<string, string> = {
  Assist: "Space",
  WhatToSay: "1",
  Shorten: "2",
  FollowUp: "3",
  Recap: "4",
  AskQuestion: "5",
};

// Ordered built-in modes — AskQuestion now included
const BUILT_IN_ORDER = ["Assist", "WhatToSay", "Shorten", "FollowUp", "Recap", "AskQuestion"];

export function ModeButtons() {
  const { t } = useT("overlay");
  const currentMode = useStreamStore((s) => s.currentMode);
  const streaming = useStreamStore((s) => s.isStreaming);
  // A clicked action awaiting its start counts as running.
  const sending = useStreamStore((s) => s.phase === "sending");
  const isStreaming = streaming || sending;
  const contextScope = useConfigStore((s) => s.contextScope ?? DEFAULT_CONTEXT_SCOPE);
  const actions = useAIActionsStore((s) => s.configs.actions);
  const [askInputText, setAskInputText] = useState("");
  const [askInputVisible, setAskInputVisible] = useState(false);

  // Listen for keyboard shortcut (Digit5) to toggle ask input
  useEffect(() => {
    const handler = () => setAskInputVisible((v) => !v);
    window.addEventListener("nexq:toggle-ask-input", handler);
    return () => window.removeEventListener("nexq:toggle-ask-input", handler);
  }, []);

  // Build ordered list: built-in modes first (in order), then custom actions.
  // `t` is a dependency so the built-in action names follow the UI language.
  const visibleModes = useMemo(() => {
    const result: { mode: string; label: string; shortcut: string; icon: typeof Sparkles; isCustom: boolean }[] = [];

    // Add built-in modes in order
    for (const modeKey of BUILT_IN_ORDER) {
      const cfg = actions[modeKey];
      if (cfg && cfg.visible) {
        result.push({
          mode: cfg.mode,
          label: actionDisplayName(cfg),
          shortcut: MODE_SHORTCUTS[modeKey] || "",
          icon: MODE_ICONS[modeKey] || Wand2,
          isCustom: false,
        });
      }
    }

    // Add custom actions
    for (const [key, cfg] of Object.entries(actions)) {
      if (!cfg.isBuiltIn && cfg.visible) {
        result.push({
          mode: cfg.mode,
          label: actionDisplayName(cfg),
          shortcut: "",
          icon: Wand2,
          isCustom: true,
        });
      }
    }

    return result;
  }, [actions, t]);

  const handleClick = useCallback(
    (mode: string) => {
      if (isStreaming) {
        if (streaming && currentMode === mode) cancelGeneration().catch(() => showToast(t("modes.errors.cancelFailed"), "error"));
        return;
      }
      // AskQuestion mode: toggle ask input instead of direct generation
      if (mode === "AskQuestion") {
        setAskInputVisible((v) => !v);
        return;
      }
      runUserAction(mode).catch((err) => showToast(err instanceof Error ? err.message : t("modes.errors.generateFailed"), "error"));
    },
    [isStreaming, streaming, currentMode, t]
  );

  const handleAskSubmit = useCallback(() => {
    const text = askInputText.trim();
    if (!text || isStreaming) return;
    runUserAction("AskQuestion", text).catch((err) =>
      showToast(err instanceof Error ? err.message : t("modes.errors.sendFailed"), "error")
    );
    setAskInputText("");
    setAskInputVisible(false);
  }, [askInputText, isStreaming, t]);

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex flex-wrap items-center gap-0.5">
        {visibleModes.map(({ mode, label, shortcut, icon: Icon, isCustom }) => {
          const isActive = currentMode === mode && isStreaming;
          const isAskActive = mode === "AskQuestion" && askInputVisible && !isStreaming;
          const hint = scopeHint(contextScope, label);
          const name = hint ? `${label} · ${hint}` : label;
          return (
            <button
              key={mode}
              onClick={() => handleClick(mode)}
              disabled={isStreaming && !isActive}
              aria-label={shortcut ? t("modes.shortcutLabel", { name, shortcut }) : name}
              title={shortcut ? t("modes.shortcutLabel", { name, shortcut }) : name}
              aria-pressed={isActive || isAskActive}
              className={`flex items-center gap-1 rounded-lg px-2 py-1 text-meta font-medium transition-all duration-150 cursor-pointer ${
                isActive
                  ? "bg-primary/20 text-primary ring-1 ring-primary/30 shadow-sm shadow-primary/10"
                  : isAskActive
                    ? "bg-info/10 text-info ring-1 ring-info/20 shadow-sm shadow-info/10"
                    : isCustom
                      ? "text-warning/60 hover:bg-warning/10 hover:text-warning border border-warning/10"
                      : "text-muted-foreground/60 hover:bg-accent/50 hover:text-foreground"
              } ${isStreaming && !isActive ? "opacity-40 cursor-not-allowed" : ""}`}
            >
              {isActive ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : <Icon className="h-3 w-3" aria-hidden="true" />}
              <span>{label}</span>
            </button>
          );
        })}
        <ContextScopePicker />
      </div>

      {/* Inline Ask input */}
      {askInputVisible && !isStreaming && (
        <div className="flex items-center gap-1.5 rounded-lg border border-info/20 bg-info/5 px-2 py-1 slide-down-enter">
          <input
            type="text"
            value={askInputText}
            onChange={(e) => setAskInputText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") { e.preventDefault(); handleAskSubmit(); }
              if (e.key === "Escape") { e.preventDefault(); setAskInputVisible(false); }
            }}
            placeholder={t("ask.input.placeholder")}
            aria-label={t("ask.input.ariaLabel")}
            autoFocus
            maxLength={2000}
            className="flex-1 min-w-0 bg-transparent text-xs text-foreground/90 placeholder:text-muted-foreground/50 outline-none"
          />
          <button
            onClick={handleAskSubmit}
            disabled={!askInputText.trim()}
            className="rounded-md p-1 text-info/60 hover:bg-info/10 hover:text-info disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            aria-label={t("ask.send.ariaLabel")}
          >
            <Send className="h-3 w-3" aria-hidden="true" />
          </button>
          <button
            onClick={() => setAskInputVisible(false)}
            className="rounded-md p-1 text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground transition-colors"
            aria-label={t("modes.ask.closeLabel")}
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
