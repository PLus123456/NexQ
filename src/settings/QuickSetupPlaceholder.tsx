// Stand-in for a quick-setup component its package hasn't delivered yet: a
// sentence and a button to the full settings page. Reports "incomplete" once.

import { useEffect, useRef } from "react";
import { useT } from "../i18n";
import { useMeetingStore } from "../stores/meetingStore";
import type { QuickSetupProps } from "./quickSetup";

export interface QuickSetupPlaceholderProps extends QuickSetupProps {
  area: "llm" | "stt" | "translation";
  /** Settings tab the button opens. */
  settingsTab: string;
}

export function QuickSetupPlaceholder({ variant, onStatusChange, area, settingsTab }: QuickSetupPlaceholderProps) {
  const { t } = useT("common");
  const reported = useRef(false);

  useEffect(() => {
    if (reported.current) return;
    reported.current = true;
    onStatusChange("incomplete");
  }, [onStatusChange]);

  return (
    <div className="rounded-xl border border-border/30 bg-card/50 p-5">
      <p className="text-sm font-medium text-foreground">{t(`quickSetup.${area}.title`)}</p>
      <p className="mt-1 text-xs text-muted-foreground">{t(`quickSetup.${area}.hint`)}</p>
      {variant === "wizard" && (
        <button
          type="button"
          onClick={() => useMeetingStore.getState().openSettings(settingsTab)}
          className="mt-4 rounded-lg border border-border/40 bg-secondary/50 px-4 py-2 text-xs font-medium text-foreground/80 transition-colors hover:bg-secondary"
        >
          {t("actions.openSettings")}
        </button>
      )}
    </div>
  );
}
