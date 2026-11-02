// Last step: where every step stands, a check that speech recognition can
// run (a meeting needs at least one side), the personal knowledge base
// (upload a resume) and the shortcuts; finishing marks setup completed.

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, CheckCircle2, ChevronRight, FileText, Keyboard, Mic, PartyPopper, RefreshCw, Rocket } from "lucide-react";
import { UI_LANGUAGE_NAMES, resolveUiLanguage, useT, useUiLanguage } from "../../i18n";
import { listLocalSTTEngines } from "../../lib/ipc";
import { ONBOARDING_STEPS, statusOf } from "../../lib/onboarding/progress";
import {
  canStartMeeting,
  checkSttReadiness,
  type PartyReadiness,
  type ReadinessContext,
  type SttReadiness,
} from "../../lib/onboarding/readiness";
import { currentPlatform } from "../../lib/platform";
import { hasSttKeySlot } from "../../lib/stt/keys";
import { STT_LABELS } from "../../lib/stt/providerMeta";
import { sonioxKeyScope } from "../../settings/stt/sonioxRegions";
import { useConfigStore } from "../../stores/configStore";
import { useMeetingStore } from "../../stores/meetingStore";
import { useOnboardingStore } from "../../stores/onboardingStore";
import { showToast } from "../../stores/toastStore";
import { KnowledgeBaseDialog } from "./KnowledgeBaseDialog";
import { StatusBadge, StepHeader } from "./parts";

const SUMMARY_STEPS = ONBOARDING_STEPS.filter((step) => step !== "finish");

function useShortcuts() {
  const hotkeys = useConfigStore((s) => s.hotkeys);
  return [
    { keys: hotkeys.toggle_assist, action: "assist", context: "meeting" },
    { keys: hotkeys.start_end_meeting, action: "startEnd", context: "global" },
    { keys: hotkeys.show_hide, action: "showHide", context: "global" },
    { keys: hotkeys.mode_say, action: "modeSay", context: "meeting" },
    { keys: hotkeys.mode_shorten, action: "modeShorten", context: "meeting" },
    { keys: hotkeys.mode_followup, action: "modeFollowup", context: "meeting" },
    { keys: hotkeys.mode_recap, action: "modeRecap", context: "meeting" },
    { keys: hotkeys.mode_ask, action: "modeAsk", context: "meeting" },
    { keys: hotkeys.open_settings, action: "openSettings", context: "global" },
    { keys: hotkeys.escape, action: "escape", context: "global" },
  ] as const;
}

const READINESS_TONE: Record<PartyReadiness, string> = {
  ready: "bg-success/10 text-success",
  unknown: "bg-muted text-muted-foreground",
  needs_key: "bg-destructive/10 text-destructive",
  needs_address: "bg-destructive/10 text-destructive",
  needs_model: "bg-destructive/10 text-destructive",
  unsupported: "bg-destructive/10 text-destructive",
  input_only: "bg-destructive/10 text-destructive",
};

/** Checks the speech recognition settings when the step shows and whenever they change. */
function useSttReadiness() {
  const meetingAudioConfig = useConfigStore((s) => s.meetingAudioConfig);
  // Soniox's key depends on the regions its settings may use.
  const sonioxKeys = useConfigStore((s) => sonioxKeyScope(s.sonioxConfig));
  const [readiness, setReadiness] = useState<SttReadiness | null>(null);
  const [checking, setChecking] = useState(false);
  const latest = useRef(0);

  const check = useCallback(async () => {
    const run = ++latest.current;
    setChecking(true);
    const config = useConfigStore.getState();
    let engines: ReturnType<typeof listLocalSTTEngines> | undefined;
    const ctx: ReadinessContext = {
      platform: currentPlatform(),
      hasKey: hasSttKeySlot,
      downloadedModels: async (engine) => {
        engines ??= listLocalSTTEngines();
        const found = (await engines).find((e) => e.engine === engine);
        // "binary-…" entries are runtimes, not models
        return found?.models.filter((m) => m.is_downloaded && !m.id.startsWith("binary-")).map((m) => m.id);
      },
      activeModelPerEngine: config.activeModelPerEngine,
      activeWhisperModel: config.activeWhisperModel,
      // Remote Whisper is the only engine with a server address so far.
      hasBaseUrl: () => config.openaiCompatSttConfig.base_url.trim() !== "",
    };
    const result = await checkSttReadiness(config.meetingAudioConfig, ctx);
    if (run !== latest.current) return; // a newer check is running
    setReadiness(result);
    setChecking(false);
  }, []);

  useEffect(() => {
    void check();
  }, [check, meetingAudioConfig, sonioxKeys]);

  return { readiness, checking, check, meetingAudioConfig };
}

export function FinishStep() {
  const { t } = useT(["onboarding", "common"]);
  const progress = useOnboardingStore((s) => s.progress);
  const { setting: languageSetting } = useUiLanguage();
  const shortcuts = useShortcuts();
  const [knowledgeBaseOpen, setKnowledgeBaseOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const { readiness, checking, check, meetingAudioConfig } = useSttReadiness();
  // The step's own test is the real check; otherwise go by the settings.
  const sttTested = statusOf(progress, "stt") === "ok";
  const blocked = !sttTested && readiness !== null && !canStartMeeting(readiness);

  const languageName =
    languageSetting === "system"
      ? `${t("steps.language.system")} · ${UI_LANGUAGE_NAMES[resolveUiLanguage("system")]}`
      : UI_LANGUAGE_NAMES[languageSetting];

  const handleStartMeeting = async () => {
    setStarting(true);
    useOnboardingStore.getState().complete();
    try {
      await useMeetingStore.getState().startMeetingFlow();
    } catch (err) {
      console.error("[FinishStep] Failed to start meeting:", err);
      showToast(t("steps.finish.startFailed", { detail: err instanceof Error ? err.message : String(err) }), "error");
    }
  };

  return (
    <div>
      <StepHeader
        icon={<PartyPopper className="h-5 w-5" />}
        title={t("steps.finish.title")}
        description={t("steps.finish.description")}
      />

      <div className="space-y-5">
        {/* Where each step stands */}
        <section aria-label={t("steps.finish.summary")} className="rounded-xl border border-border/40 bg-card/50">
          <ul className="divide-y divide-border/20">
            {SUMMARY_STEPS.map((step) => {
              const state = progress.steps[step];
              return (
                <li key={step} className="flex items-center gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground">{t(`steps.${step}.name`)}</p>
                    {step === "language" ? (
                      <p className="truncate text-xs text-muted-foreground">{languageName}</p>
                    ) : (
                      state?.detail && <p className="truncate text-xs text-muted-foreground">{state.detail}</p>
                    )}
                  </div>
                  {step !== "language" && <StatusBadge status={statusOf(progress, step)} />}
                  <button
                    type="button"
                    onClick={() => useOnboardingStore.getState().goTo(step)}
                    aria-label={`${t("common:actions.change")} · ${t(`steps.${step}.name`)}`}
                    className="rounded-lg px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    {t("common:actions.change")}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        {/* Speech recognition: a meeting needs at least one side that can run */}
        <section aria-label={t("steps.finish.check.title")} className="rounded-xl border border-border/40 bg-card/50 p-4">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">{t("steps.finish.check.title")}</p>
              {sttTested ? (
                <p className="mt-0.5 flex items-center gap-1.5 text-xs text-success">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {t("steps.finish.check.tested")}
                </p>
              ) : (
                <p className="mt-0.5 text-xs text-muted-foreground">{t("steps.finish.check.hint")}</p>
              )}
            </div>
            {!sttTested && (
              <button
                type="button"
                onClick={() => void check()}
                disabled={checking}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${checking ? "animate-spin" : ""}`} />
                {checking ? t("steps.finish.check.checking") : t("steps.finish.check.recheck")}
              </button>
            )}
          </div>

          {!sttTested && readiness && meetingAudioConfig && (
            <ul className="mt-3 space-y-1.5">
              {(["you", "them"] as const).map((party) => (
                <li key={party} className="flex items-center justify-between gap-3 text-xs">
                  <span className="min-w-0 truncate text-foreground">
                    <span className="font-medium">{t(`common:labels.${party}`)}</span>
                    <span className="text-muted-foreground">
                      {" · "}
                      {STT_LABELS[meetingAudioConfig[party].stt_provider] ?? meetingAudioConfig[party].stt_provider}
                    </span>
                  </span>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-meta font-medium ${READINESS_TONE[readiness[party]]}`}>
                    {t(`steps.finish.check.states.${readiness[party]}`)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {blocked && (
            <div role="alert" className="mt-3 flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
              <div>
                <p>{t("steps.finish.check.blocked")}</p>
                <button
                  type="button"
                  onClick={() => useOnboardingStore.getState().goTo("stt")}
                  className="mt-1.5 font-medium underline underline-offset-2 hover:no-underline"
                >
                  {t("steps.finish.check.goToStt")}
                </button>
              </div>
            </div>
          )}
        </section>

        {/* Personal knowledge base */}
        <section className="flex items-center gap-4 rounded-xl border border-border/40 bg-card/50 p-4">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">{t("steps.finish.knowledgeBase.title")}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("steps.finish.knowledgeBase.hint")}</p>
          </div>
          <button
            type="button"
            onClick={() => setKnowledgeBaseOpen(true)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border/40 bg-secondary/40 px-3.5 py-2 text-xs font-medium text-foreground transition-colors hover:bg-secondary"
          >
            <FileText className="h-3.5 w-3.5" />
            {t("steps.finish.knowledgeBase.upload")}
          </button>
        </section>

        {/* Keyboard shortcuts */}
        <details className="group rounded-xl border border-border/40 bg-card/50">
          <summary className="flex cursor-pointer list-none items-center gap-2.5 px-4 py-3 text-sm font-medium text-foreground">
            <Keyboard className="h-4 w-4 text-muted-foreground" />
            {t("steps.finish.shortcuts.title")}
            <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden />
          </summary>
          <div className="max-h-52 overflow-y-auto border-t border-border/20 p-1.5">
            <table className="w-full">
              <tbody>
                {shortcuts.map((s) => (
                  <tr key={s.action} className="border-b border-border/20 last:border-0">
                    <td className="px-3 py-1.5">
                      <kbd className="inline-flex items-center rounded border border-border/50 bg-background px-1.5 py-0.5 font-mono text-xs text-foreground">
                        {s.keys}
                      </kbd>
                    </td>
                    <td className="px-2 py-1.5 text-xs text-foreground">
                      {t(`steps.finish.shortcuts.actions.${s.action}`)}
                    </td>
                    <td className="px-3 py-1.5 text-right text-meta text-muted-foreground/60">
                      {t(`steps.finish.shortcuts.contexts.${s.context}`)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>

        {/* Finish */}
        <div className="space-y-3 pt-1">
          <button
            type="button"
            onClick={handleStartMeeting}
            disabled={starting || blocked}
            className="group flex w-full items-center justify-center gap-3 rounded-2xl bg-primary px-6 py-3.5 text-base font-semibold text-primary-foreground shadow-md shadow-primary/10 transition-all duration-200 hover:shadow-lg hover:shadow-primary/20 disabled:opacity-60"
          >
            <Mic className="h-5 w-5" />
            {t("steps.finish.startMeeting")}
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </button>
          <button
            type="button"
            onClick={() => useOnboardingStore.getState().complete()}
            disabled={starting}
            className="flex w-full items-center justify-center gap-2.5 rounded-2xl border border-border/40 bg-secondary/20 px-6 py-3 text-sm font-semibold text-foreground transition-all duration-200 hover:bg-secondary/40 disabled:opacity-60"
          >
            <Rocket className="h-4 w-4 text-muted-foreground" />
            {t("steps.finish.goToLauncher")}
          </button>
        </div>
      </div>

      {knowledgeBaseOpen && <KnowledgeBaseDialog onClose={() => setKnowledgeBaseOpen(false)} />}
    </div>
  );
}
