// Settings → General: run the first-run setup again, right away (no
// restart). Not during a meeting: setup tests the audio devices.

import { Wand2 } from "lucide-react";
import { useT } from "../../i18n";
import { useMeetingStore } from "../../stores/meetingStore";
import { useOnboardingStore } from "../../stores/onboardingStore";

export function RerunSetupCard() {
  const { t } = useT("onboarding");
  const inMeeting = useMeetingStore((s) => s.activeMeeting !== null);

  return (
    <div className="rounded-xl border border-border/30 bg-card/50 p-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-foreground">{t("rerun.label")}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{inMeeting ? t("rerun.inMeeting") : t("rerun.hint")}</p>
        </div>
        <button
          type="button"
          onClick={() => useOnboardingStore.getState().restart()}
          disabled={inMeeting}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border/50 bg-secondary/30 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-secondary/60 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Wand2 className="h-3.5 w-3.5" />
          {t("rerun.action")}
        </button>
      </div>
    </div>
  );
}
