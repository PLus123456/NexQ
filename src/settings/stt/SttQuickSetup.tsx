// First-run / quick setup for speech recognition (STT package): an engine and
// a language for You and for Them, the configuration those engines need
// (Soniox key, Remote Whisper server, local model download) and a test.
//
// Status (QuickSetupProps): "ok" once a test passed for both parties, "error"
// when the last test failed for one, "incomplete" otherwise (also as soon as
// an engine or its settings change after a test). Reported on mount and on
// every change, never twice in a row.

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle, Loader2, Sparkles, Wifi, XCircle } from "lucide-react";
import { useT } from "../../i18n";
import { hasApiKey, listAudioDevices, listLocalSTTEngines } from "../../lib/ipc";
import { currentPlatform } from "../../lib/platform";
import { probeOpenAICompatStt, probeSoniox } from "../../lib/stt/ipc";
import {
  isExclusiveProvider,
  sttKeySlot,
  sttProviderMeta,
  sttProvidersFor,
  type SttProviderMeta,
} from "../../lib/stt/providerMeta";
import type { SttProbeResult } from "../../lib/stt/types";
import type { AudioDevice, MeetingAudioConfig, STTProviderType } from "../../lib/types";
import { useConfigStore } from "../../stores/configStore";
import { useMeetingStore } from "../../stores/meetingStore";
import { LocalModelManager } from "../LocalModelManager";
import { BUILT_IN_PRESETS, applyPreset } from "../presets";
import type { QuickSetupProps, QuickSetupStatus } from "../quickSetup";
import { OpenAICompatSttSettings } from "./OpenAICompatSttSettings";
import { PartyLanguageField } from "./PartyLanguageField";
import { ProbeResultView, probeMessage, probeUsable, type ProbeEngine } from "./ProbeResult";
import { SonioxSettings } from "./SonioxSettings";
import {
  PARTIES,
  defaultMeetingAudioConfig,
  isModelReady,
  otherParty,
  partyLabel,
  sttEngineDescription,
  sttEngineLabel,
  useSttReadiness,
  withPartyEngine,
  type Party,
} from "./sttEngines";

/** Listed first in the engine pickers. */
const FEATURED: readonly STTProviderType[] = ["whisper_cpp", "openai_compat", "soniox"];
const RECOMMENDED_PRESET_ID = "soniox_them";

/** The outcome of testing one party's engine. */
interface PartyCheck {
  /** "warning" passes (e.g. a Soniox key that may not list models). */
  status: "ok" | "warning" | "error";
  message: string;
  probe?: { engine: ProbeEngine; result: SttProbeResult | null; error: string | null };
}

interface TestResults {
  /** What was tested; results of other settings don't count. */
  signature: string;
  /** Local engine → whether the test found a downloaded model (a later download or delete makes it stale). */
  models: Record<string, boolean>;
  you: PartyCheck;
  them: PartyCheck;
}

export function SttQuickSetup({ variant, onStatusChange }: QuickSetupProps) {
  const { t } = useT(["stt", "common", "settings"]);
  const meetingAudioConfig = useConfigStore((s) => s.meetingAudioConfig);
  const micDeviceId = useConfigStore((s) => s.micDeviceId);
  const systemDeviceId = useConfigStore((s) => s.systemDeviceId);
  const recordingEnabled = useConfigStore((s) => s.recordingEnabled);
  const openaiCompat = useConfigStore((s) => s.openaiCompatSttConfig);
  const soniox = useConfigStore((s) => s.sonioxConfig);
  const readiness = useSttReadiness();
  const platform = currentPlatform();

  // This platform's engines: Whisper.cpp, Remote Whisper and Soniox first.
  const offered = useMemo(() => {
    const all = sttProvidersFor(platform);
    const featured = FEATURED.map((id) => all.find((p) => p.id === id)).filter((p): p is SttProviderMeta => !!p);
    return { featured, others: all.filter((p) => !FEATURED.includes(p.id)), all };
  }, [platform]);

  const config: MeetingAudioConfig =
    meetingAudioConfig ?? defaultMeetingAudioConfig({ micDeviceId, systemDeviceId, recordingEnabled });

  const [testing, setTesting] = useState(false);
  const [results, setResults] = useState<TestResults | null>(null);
  const [keyRevision, setKeyRevision] = useState(0);
  const [applying, setApplying] = useState(false);

  // Everything a test result depends on (not the languages), besides the local models.
  const signature = JSON.stringify([
    PARTIES.map((p) => [config[p].stt_provider, config[p].is_input_device]),
    [openaiCompat.base_url, openaiCompat.url_override, openaiCompat.model],
    [soniox.region, soniox.rest_url, soniox.model],
    keyRevision,
  ]);
  // A model downloaded or deleted since the test makes it stale; the list loading late doesn't.
  const modelsUnchanged = (models: Record<string, boolean>) =>
    Object.entries(models).every(([engine, ready]) => {
      const now = isModelReady(readiness.localEngines, engine);
      return now === undefined || now === ready;
    });
  const current = results && results.signature === signature && modelsUnchanged(results.models) ? results : null;

  // "ok" carries a one-line summary ("Soniox for Them, Whisper.cpp for You"), "error" the reason.
  let status: QuickSetupStatus = "incomplete";
  let detail: string | undefined;
  if (current) {
    const failed = PARTIES.filter((p) => current[p].status === "error");
    if (failed.length > 0) {
      status = "error";
      detail = failed.map((p) => `${partyLabel(p)}: ${current[p].message}`).join(" · ");
    } else {
      status = "ok";
      const you = sttEngineLabel(config.you.stt_provider);
      const them = sttEngineLabel(config.them.stt_provider);
      detail =
        config.you.stt_provider === config.them.stt_provider
          ? t("stt:quickSetup.summary.both", { engine: you })
          : t("stt:quickSetup.summary.each", { you, them });
    }
  }

  // Report on mount and whenever the status changes; never the same twice.
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;
  const reported = useRef<string | null>(null);
  useEffect(() => {
    const key = `${status}\n${detail ?? ""}`;
    if (reported.current === key) return;
    reported.current = key;
    if (detail === undefined) onStatusChangeRef.current(status);
    else onStatusChangeRef.current(status, detail);
  }, [status, detail]);

  function updateConfig(next: MeetingAudioConfig) {
    useConfigStore.getState().setMeetingAudioConfig(next);
  }

  function latestConfig(): MeetingAudioConfig {
    const state = useConfigStore.getState();
    return state.meetingAudioConfig ?? defaultMeetingAudioConfig(state);
  }

  function setEngine(party: Party, engine: STTProviderType) {
    updateConfig(withPartyEngine(latestConfig(), party, engine, useConfigStore.getState()));
  }

  function setLanguage(party: Party, code: string) {
    const base = latestConfig();
    updateConfig({ ...base, [party]: { ...base[party], language: code } });
  }

  const recommended = BUILT_IN_PRESETS.find((p) => p.id === RECOMMENDED_PRESET_ID);

  async function applyRecommended() {
    if (!recommended) return;
    setApplying(true);
    let devices: AudioDevice[] = [];
    try {
      const list = await listAudioDevices();
      devices = [...list.inputs, ...list.outputs];
    } catch (err) {
      console.warn("[stt] Failed to list audio devices:", err);
    }
    // Keeps each party's language.
    updateConfig(applyPreset(recommended, devices, latestConfig()));
    setApplying(false);
  }

  /** Tests both parties; one probe per remote engine even when both use it. */
  async function runTest() {
    const tested = signature;
    const cfg = latestConfig();
    const state = useConfigStore.getState();
    // What passes the test is what meetings use: store the defaults shown when nothing is saved yet.
    if (!state.meetingAudioConfig) updateConfig(cfg);
    setTesting(true);

    const probes = new Map<ProbeEngine, Promise<{ result: SttProbeResult | null; error: string | null }>>();
    const probeOnce = (engine: ProbeEngine) => {
      let pending = probes.get(engine);
      if (!pending) {
        const run = engine === "soniox"
          ? probeSoniox(state.sonioxConfig)
          : probeOpenAICompatStt(state.openaiCompatSttConfig);
        pending = run.then(
          (result) => ({ result, error: null }),
          (err) => ({ result: null, error: String(err) }),
        );
        probes.set(engine, pending);
      }
      return pending;
    };
    // One model list for both parties.
    let enginesPromise: ReturnType<typeof listLocalSTTEngines> | null = null;
    const loadEngines = () => (enginesPromise ??= listLocalSTTEngines());
    const models: Record<string, boolean> = {};

    const check = async (party: Party): Promise<PartyCheck> => {
      const engine = cfg[party].stt_provider;
      const meta = sttProviderMeta(engine);
      const label = sttEngineLabel(engine);
      const fail = (message: string): PartyCheck => ({ status: "error", message });
      if (!meta || !offered.all.some((p) => p.id === engine)) {
        return fail(t("stt:quickSetup.checks.notOffered", { engine: label }));
      }
      if (meta.inputOnly && !cfg[party].is_input_device) {
        return fail(t("stt:quickSetup.checks.needsInput", { engine: label }));
      }
      if (engine === "soniox" || engine === "openai_compat") {
        if (engine === "openai_compat" && !state.openaiCompatSttConfig.base_url.trim()) {
          return fail(t("stt:probe.codes.no_base_url"));
        }
        const outcome = await probeOnce(engine);
        const probe = { engine, ...outcome };
        if (!outcome.result) {
          return { status: "error", message: t("common:errors.testFailed", { detail: outcome.error ?? "" }), probe };
        }
        const message = probeMessage(engine, outcome.result);
        if (outcome.result.ok) return { status: "ok", message, probe };
        return { status: probeUsable(engine, outcome.result) ? "warning" : "error", message, probe };
      }
      if (meta.requiresDownload) {
        let engines: Awaited<ReturnType<typeof listLocalSTTEngines>>;
        try {
          engines = await loadEngines();
        } catch (err) {
          return fail(t("common:errors.loadFailed", { detail: String(err) }));
        }
        const ready = isModelReady(engines, meta.requiresDownload) === true;
        models[meta.requiresDownload] = ready;
        return ready
          ? { status: "ok", message: t("stt:quickSetup.checks.modelReady", { engine: label }) }
          : fail(t("stt:quickSetup.checks.needsModel", { engine: label }));
      }
      if (engine === "web_speech" || engine === "windows_native") {
        return { status: "ok", message: t("stt:quickSetup.checks.builtIn", { engine: label }) };
      }
      if (meta.requiresApiKey) {
        let saved = false;
        try {
          saved = await hasApiKey(sttKeySlot(meta));
        } catch {
          saved = false;
        }
        return saved
          ? { status: "ok", message: t("stt:quickSetup.checks.keySaved", { engine: label }) }
          : fail(t("stt:quickSetup.checks.needsKey", { engine: label, tab: t("settings:tabs.stt") }));
      }
      return { status: "ok", message: t("stt:quickSetup.checks.builtIn", { engine: label }) };
    };

    const [you, them] = await Promise.all([check("you"), check("them")]);
    setResults({ signature: tested, models, you, them });
    setTesting(false);
  }

  const used = new Set(PARTIES.map((p) => config[p].stt_provider));
  const localModelEngines = [...used]
    .map((id) => sttProviderMeta(id))
    .filter((meta): meta is SttProviderMeta => !!meta?.requiresDownload);
  const keyEngines = [...used]
    .map((id) => sttProviderMeta(id))
    .filter((meta): meta is SttProviderMeta => !!meta?.requiresApiKey && meta.id !== "soniox");
  const onKeyChange = () => {
    setKeyRevision((n) => n + 1);
    readiness.refresh();
  };
  const recommendedApplied = !!recommended && config.preset_name === recommended.name;

  return (
    <div className="space-y-5 rounded-xl border border-border/30 bg-card/50 p-5">
      <div>
        <p className="text-sm font-medium text-foreground">{t("common:quickSetup.stt.title")}</p>
        {variant === "wizard" && (
          <p className="mt-1 text-xs text-muted-foreground">{t("stt:quickSetup.intro")}</p>
        )}
      </div>

      {/* One click: Soniox for Them, Whisper.cpp for You */}
      {recommended && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground">{t("stt:quickSetup.recommended.title")}</p>
            <p className="mt-0.5 text-meta text-muted-foreground">{t("stt:quickSetup.recommended.hint")}</p>
          </div>
          <button
            type="button"
            onClick={() => void applyRecommended()}
            disabled={applying}
            aria-pressed={recommendedApplied}
            className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {applying ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : recommendedApplied ? (
              <CheckCircle className="h-3.5 w-3.5" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            {recommendedApplied ? t("stt:quickSetup.recommended.applied") : t("stt:quickSetup.recommended.apply")}
          </button>
        </div>
      )}

      {/* You / Them: engine + language */}
      <div className="space-y-3">
        {PARTIES.map((party) => {
          const engine = config[party].stt_provider;
          const otherEngine = config[otherParty(party)].stt_provider;
          const engineId = `stt-quick-${party}-engine`;
          const languageId = `stt-quick-${party}-language`;
          const offeredHere = offered.all.some((p) => p.id === engine);
          const optionLabel = (meta: SttProviderMeta) => {
            const label = sttEngineLabel(meta.id);
            if (meta.inputOnly && !config[party].is_input_device) {
              return t("stt:quickSetup.option.micOnly", { engine: label });
            }
            if (meta.id !== engine && isExclusiveProvider(meta.id) && isExclusiveProvider(otherEngine)) {
              return t("stt:quickSetup.option.inUseBy", { engine: label, party: partyLabel(otherParty(party)) });
            }
            return label;
          };
          const optionDisabled = (meta: SttProviderMeta) =>
            meta.id !== engine &&
            ((meta.inputOnly === true && !config[party].is_input_device) ||
              (isExclusiveProvider(meta.id) && isExclusiveProvider(otherEngine)));
          return (
            <div key={party} className="grid grid-cols-[4.5rem_minmax(0,1fr)_minmax(0,1fr)] items-start gap-3">
              <span
                className={`pt-2 text-xs font-semibold uppercase tracking-wide ${
                  party === "you" ? "text-sky-400" : "text-amber-400"
                }`}
              >
                {partyLabel(party)}
              </span>
              <div>
                <label htmlFor={engineId} className="mb-1 block text-meta font-semibold uppercase tracking-wider text-muted-foreground/60">
                  {t("stt:quickSetup.engineLabel")}
                </label>
                <select
                  id={engineId}
                  value={engine}
                  onChange={(e) => setEngine(party, e.target.value as STTProviderType)}
                  aria-label={t("stt:quickSetup.engineAriaLabel", { party: partyLabel(party) })}
                  className="w-full cursor-pointer rounded-lg border border-border/50 bg-secondary/30 px-3 py-2 text-xs text-foreground focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/20"
                >
                  {!offeredHere && (
                    <option value={engine} disabled>
                      {sttEngineLabel(engine)}
                    </option>
                  )}
                  <optgroup label={t("stt:quickSetup.groups.featured")}>
                    {offered.featured.map((meta) => (
                      <option key={meta.id} value={meta.id} disabled={optionDisabled(meta)}>
                        {optionLabel(meta)}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label={t("stt:quickSetup.groups.others")}>
                    {offered.others.map((meta) => (
                      <option key={meta.id} value={meta.id} disabled={optionDisabled(meta)}>
                        {optionLabel(meta)}
                      </option>
                    ))}
                  </optgroup>
                </select>
                {sttProviderMeta(engine) && (
                  <p className="mt-1 text-meta text-muted-foreground/80">
                    {sttEngineDescription(engine)}
                  </p>
                )}
              </div>
              <div>
                <label htmlFor={languageId} className="mb-1 block text-meta font-semibold uppercase tracking-wider text-muted-foreground/60">
                  {t("stt:language.label")}
                </label>
                <PartyLanguageField
                  id={languageId}
                  aria-label={t("stt:language.partyAriaLabel", { party: partyLabel(party) })}
                  party={config[party]}
                  onChange={(code) => setLanguage(party, code)}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* What the chosen engines need */}
      {used.has("soniox") && <SonioxSettings compact onKeyChange={onKeyChange} />}
      {used.has("openai_compat") && <OpenAICompatSttSettings compact onKeyChange={onKeyChange} />}
      {localModelEngines.map((meta) => (
        <div key={meta.id} className="rounded-lg border border-border/30 bg-background/30 p-4">
          <p className="mb-1 text-sm font-semibold text-primary/80">
            {t("stt:quickSetup.models.title", { engine: sttEngineLabel(meta.id) })}
          </p>
          <p className="mb-3 text-meta text-muted-foreground">{t("stt:quickSetup.models.hint")}</p>
          <LocalModelManager engineFilter={meta.requiresDownload} onModelsChange={readiness.refresh} />
        </div>
      ))}
      {keyEngines.map((meta) => (
        <p key={meta.id} className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
          <span>
            {t("stt:quickSetup.keyHint", { engine: sttEngineLabel(meta.id), tab: t("settings:tabs.stt") })}
          </span>
        </p>
      ))}

      {/* Test both parties */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void runTest()}
            disabled={testing}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border/50 bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wifi className="h-3.5 w-3.5" />}
            {testing ? t("common:status.testing") : t("stt:quickSetup.test")}
          </button>
          {current && (
            <span className={`text-xs ${status === "ok" ? "text-success" : "text-destructive"}`}>
              {status === "ok" ? t("stt:quickSetup.result.ok") : t("stt:quickSetup.result.error")}
            </span>
          )}
        </div>
        {current &&
          PARTIES.map((party) => {
            const check = current[party];
            const Icon = check.status === "ok" ? CheckCircle : check.status === "warning" ? AlertTriangle : XCircle;
            const tone =
              check.status === "ok" ? "text-success" : check.status === "warning" ? "text-warning" : "text-destructive";
            return (
              <div key={party} className="rounded-lg border border-border/30 bg-background/30 px-3 py-2.5">
                <p className="mb-1 text-meta font-semibold uppercase tracking-wider text-muted-foreground/70">
                  {partyLabel(party)} · {sttEngineLabel(config[party].stt_provider)}
                </p>
                {check.probe ? (
                  <ProbeResultView engine={check.probe.engine} result={check.probe.result} error={check.probe.error} />
                ) : (
                  <p className={`flex items-start gap-1.5 text-xs font-medium ${tone}`}>
                    <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span>{check.message}</span>
                  </p>
                )}
              </div>
            );
          })}
      </div>

      {variant === "wizard" && (
        <div className="flex flex-wrap items-center gap-3 border-t border-border/20 pt-4">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">{t("stt:quickSetup.moreOptions")}</p>
          <button
            type="button"
            onClick={() => useMeetingStore.getState().openSettings("stt")}
            className="rounded-lg border border-border/40 bg-secondary/50 px-4 py-2 text-xs font-medium text-foreground/80 transition-colors hover:bg-secondary"
          >
            {t("common:actions.openSettings")}
          </button>
        </div>
      )}
    </div>
  );
}
