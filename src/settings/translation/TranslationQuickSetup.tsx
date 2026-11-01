// First-run / quick setup for translation (step 4 of the first-run wizard):
// translate or not, which parties, the target language, and who translates
// (the STT engine itself when it can — Soniox —, the LLM, DeepL, Microsoft,
// Google). A service that needs a key is tested before the step counts as done.
//
// Status (the wizard moves on only with ok or skipped): "skipped" when
// translation is off; "ok" when the STT engine translates every chosen party
// (its key is tested in the speech recognition step) or the translation
// service passed its test here, with a one-line summary as detail;
// "incomplete" while the service is untested; "error" after a failed test.

import { useEffect, useId, useRef, useState } from "react";
import { CheckCircle, Loader2, Wifi, XCircle } from "lucide-react";
import { useT } from "../../i18n";
import { useConfigStore } from "../../stores/configStore";
import { useMeetingStore } from "../../stores/meetingStore";
import { errorMessage, useTranslationStore } from "../../stores/translationStore";
import { getApiKey, hasApiKey, storeApiKey } from "../../lib/ipc";
import { TRANSLATION_COMMON, languageLabel } from "../../lib/languages";
import { LanguageCombobox } from "../../components/LanguageCombobox";
import { testTranslationProvider } from "../../lib/translation/ipc";
import {
  TRANSLATION_PARTIES,
  applyPartyTranslationMode,
  engineSupportsNativeTranslation,
  partyConfig,
  partyTranslationMode,
} from "../../lib/translation/nativeTranslation";
import type { PartyTranslationMode, TranslateParties, TranslationParty } from "../../lib/translation/types";
import type { MeetingAudioConfig, TranslationProviderType } from "../../lib/types";
import type { QuickSetupProps, QuickSetupStatus } from "../quickSetup";
import { ProviderEndpointField } from "./ProviderEndpointField";
import { AZURE_REGIONS, CLOUD_PROVIDERS, MICROSOFT_REGION_KEY, isCloudProvider, providerOption } from "./providers";
import { engineName } from "./PartyTranslationPicker";

type TestState = { state: "idle" } | { state: "testing" } | { state: "ok"; ms: number } | { state: "error"; message: string };

const QUICK_PROVIDERS: readonly TranslationProviderType[] = ["llm", ...CLOUD_PROVIDERS.map((p) => p.value)];

const PARTY_KEYS = { you: "common:labels.you", them: "common:labels.them" } as const;

/** The configuration that last passed its test, so going back to the step keeps it done. */
let passedConfig: string | null = null;

export function TranslationQuickSetup({ variant, onStatusChange }: QuickSetupProps) {
  const { t } = useT(["translation", "common"]);
  const provider = useTranslationStore((s) => s.provider);
  const setProvider = useTranslationStore((s) => s.setProvider);
  const targetLang = useTranslationStore((s) => s.targetLang);
  const setTargetLang = useTranslationStore((s) => s.setTargetLang);
  const translateParties = useTranslationStore((s) => s.translateParties);
  const setTranslateParties = useTranslationStore((s) => s.setTranslateParties);
  const endpoints = useTranslationStore((s) => s.endpoints);
  const setEndpoint = useTranslationStore((s) => s.setEndpoint);
  const llm = useTranslationStore((s) => s.llm);
  const syncBackend = useTranslationStore((s) => s.syncBackend);
  const audio = useConfigStore((s) => s.meetingAudioConfig);
  const setMeetingAudioConfig = useConfigStore((s) => s.setMeetingAudioConfig);

  const [apiKey, setApiKey] = useState("");
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [region, setRegion] = useState("global");
  const [showEndpoint, setShowEndpoint] = useState(false);
  const [test, setTest] = useState<TestState>({ state: "idle" });
  const keyId = useId();
  const regionId = useId();
  const targetId = useId();

  const modes: Record<TranslationParty, PartyTranslationMode> = {
    you: partyTranslationMode("you", translateParties, audio),
    them: partyTranslationMode("them", translateParties, audio),
  };
  const nativeCapable = (party: TranslationParty) => engineSupportsNativeTranslation(partyConfig(audio, party)?.stt_provider);
  const enabled = TRANSLATION_PARTIES.some((p) => modes[p] !== "off");
  const checkedNativeCapable = TRANSLATION_PARTIES.filter((p) => modes[p] !== "off" && nativeCapable(p));
  const useNative = TRANSLATION_PARTIES.some((p) => modes[p] === "native");
  const needsService = TRANSLATION_PARTIES.some((p) => modes[p] === "service");
  const cloud = isCloudProvider(provider) ? provider : null;
  const option = providerOption(provider);
  const serviceConfig = `${provider}|${cloud ? endpoints[cloud].trim() : ""}|${option?.needsRegion ? region : ""}`;
  const testPassed = test.state === "ok" || (test.state === "idle" && passedConfig === serviceConfig);
  /** The key, address or region changed: an earlier test no longer counts. */
  const invalidateTest = () => {
    passedConfig = null;
    setTest({ state: "idle" });
  };

  // ── Applying modes (several parties at once) ──
  const applyModes = (next: Partial<Record<TranslationParty, PartyTranslationMode>>) => {
    let parties: TranslateParties = translateParties;
    let config: MeetingAudioConfig | null = audio;
    let audioChanged = false;
    for (const party of TRANSLATION_PARTIES) {
      const mode = next[party];
      if (!mode) continue;
      const out = applyPartyTranslationMode(party, mode, parties, config);
      parties = out.parties;
      if (out.audio) {
        config = out.audio;
        audioChanged = true;
      }
    }
    setTranslateParties(parties);
    if (audioChanged && config) setMeetingAudioConfig(config);
  };

  /** A party switched on is translated by its engine when it can. */
  const modeWhenOn = (party: TranslationParty): PartyTranslationMode =>
    nativeCapable(party) && (useNative || !needsService) ? "native" : "service";

  const setEnabled = (on: boolean) => {
    if (!on) applyModes({ you: "off", them: "off" });
    else applyModes({ them: modeWhenOn("them") });
  };

  const toggleParty = (party: TranslationParty) => {
    applyModes({ [party]: modes[party] === "off" ? modeWhenOn(party) : "off" });
  };

  const setNative = (on: boolean) => {
    const next: Partial<Record<TranslationParty, PartyTranslationMode>> = {};
    for (const party of checkedNativeCapable) next[party] = on ? "native" : "service";
    applyModes(next);
  };

  // ── Keys of the chosen cloud service ──
  useEffect(() => {
    setApiKey("");
    setHasStoredKey(false);
    setTest({ state: "idle" });
    if (!option?.requiresApiKey) return;
    let cancelled = false;
    (async () => {
      try {
        const exists = await hasApiKey(option.credentialKey);
        if (cancelled) return;
        setHasStoredKey(exists);
        if (exists) {
          const stored = await getApiKey(option.credentialKey);
          if (!cancelled && stored) setApiKey(stored);
        }
        if (option.needsRegion && (await hasApiKey(MICROSOFT_REGION_KEY))) {
          const stored = await getApiKey(MICROSOFT_REGION_KEY);
          if (!cancelled && stored) setRegion(stored);
        }
      } catch (e) {
        console.warn("[TranslationQuickSetup] Failed to read the stored key:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [option?.credentialKey, option?.requiresApiKey, option?.needsRegion]);

  const runTest = async () => {
    setTest({ state: "testing" });
    try {
      if (option?.requiresApiKey && apiKey.trim()) {
        await storeApiKey(option.credentialKey, apiKey.trim());
        setHasStoredKey(true);
      }
      if (option?.needsRegion) await storeApiKey(MICROSOFT_REGION_KEY, region);
      const result = await testTranslationProvider(provider, { endpoints, llm }, option?.needsRegion ? region : undefined);
      if (result.connected) {
        passedConfig = serviceConfig;
        setTest({ state: "ok", ms: result.response_ms });
        // The active provider picks up the key just saved.
        void syncBackend();
      } else {
        setTest({ state: "error", message: result.error || t("common:errors.unknown") });
      }
    } catch (e) {
      setTest({ state: "error", message: errorMessage(e) });
    }
  };

  // ── Status for the wizard ──
  const nativeEngine = engineName(partyConfig(audio, checkedNativeCapable[0] ?? "them")?.stt_provider);
  const serviceName = option?.labelKey ? t(option.labelKey) : option?.label ?? provider;
  let status: QuickSetupStatus;
  let detail: string | undefined;
  if (!enabled) {
    status = "skipped";
    detail = t("quickSetup.summary.off");
  } else if (!needsService) {
    status = "ok";
    detail = t("quickSetup.summary.native", { engine: nativeEngine, language: languageLabel(targetLang) });
  } else if (test.state === "error") {
    status = "error";
    detail = test.message;
  } else if (testPassed) {
    status = "ok";
    detail = useNative
      ? t("quickSetup.summary.mixed", { engine: nativeEngine, provider: serviceName, language: languageLabel(targetLang) })
      : t("quickSetup.summary.service", { provider: serviceName, language: languageLabel(targetLang) });
  } else {
    status = "incomplete";
  }
  const report = useRef(onStatusChange);
  report.current = onStatusChange;
  const reported = useRef<string | null>(null);
  useEffect(() => {
    const key = `${status}\u0000${detail ?? ""}`;
    if (reported.current === key) return;
    reported.current = key;
    report.current(status, detail);
  }, [status, detail]);

  const canTest = provider === "llm" || (cloud !== null && (apiKey.trim() !== "" || hasStoredKey || endpoints[cloud].trim() !== ""));

  return (
    <div className="space-y-4 rounded-xl border border-border/30 bg-card/50 p-5">
      {variant === "wizard" && (
        <div>
          <p className="text-sm font-medium text-foreground">{t("quickSetup.title")}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t("quickSetup.intro")}</p>
        </div>
      )}

      <label className="flex items-center justify-between gap-4">
        <span className="text-sm font-medium text-foreground">{t("quickSetup.enable")}</span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={t("quickSetup.enable")}
          onClick={() => setEnabled(!enabled)}
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 ${
            enabled ? "bg-primary" : "bg-muted-foreground/30"
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform duration-200 ${
              enabled ? "translate-x-[18px]" : "translate-x-[3px]"
            }`}
          />
        </button>
      </label>

      {enabled && (
        <>
          {/* Parties */}
          <fieldset>
            <legend className="mb-1.5 text-xs font-medium text-foreground">{t("quickSetup.parties")}</legend>
            <div className="flex flex-wrap gap-4">
              {(["them", "you"] as const).map((party) => (
                <label key={party} className="flex items-center gap-2 text-sm text-foreground">
                  <input
                    type="checkbox"
                    checked={modes[party] !== "off"}
                    onChange={() => toggleParty(party)}
                    className="h-3.5 w-3.5 accent-primary"
                  />
                  {t(PARTY_KEYS[party])}
                </label>
              ))}
            </div>
          </fieldset>

          {/* Target language */}
          <div>
            <label htmlFor={targetId} className="mb-1.5 block text-xs font-medium text-foreground">
              {t("settings.language.target")}
            </label>
            <LanguageCombobox id={targetId} value={targetLang} onChange={setTargetLang} common={TRANSLATION_COMMON} />
          </div>

          {/* The STT engine's own translation */}
          {checkedNativeCapable.length > 0 && (
            <label className="flex items-start gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={useNative}
                onChange={(e) => setNative(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 accent-primary"
              />
              <span>
                {t("quickSetup.native.label", {
                  engine: engineName(partyConfig(audio, checkedNativeCapable[0])?.stt_provider),
                })}
                <span className="block text-xs text-muted-foreground">{t("quickSetup.native.hint")}</span>
              </span>
            </label>
          )}

          {/* The translation service */}
          {needsService && (
            <div className="space-y-3">
              <fieldset>
                <legend className="mb-1.5 text-xs font-medium text-foreground">{t("quickSetup.provider")}</legend>
                <div className="grid grid-cols-2 gap-2">
                  {(QUICK_PROVIDERS.includes(provider) ? QUICK_PROVIDERS : [provider, ...QUICK_PROVIDERS]).map((value) => {
                    const p = providerOption(value);
                    const selected = provider === value;
                    return (
                      <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => {
                          if (!selected) setProvider(value);
                        }}
                        className={`rounded-lg border px-3 py-2 text-left text-xs transition-colors cursor-pointer ${
                          selected
                            ? "border-primary bg-primary/10 text-primary ring-1 ring-primary/20"
                            : "border-border/40 text-foreground hover:bg-accent/60"
                        }`}
                      >
                        <span className="block font-medium">{p?.labelKey ? t(p.labelKey) : p?.label ?? value}</span>
                        {value === "llm" && (
                          <span className="block text-[11px] text-muted-foreground">{t("quickSetup.llmHint")}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </fieldset>

              {cloud && option && (
                <div className="space-y-3">
                  <div>
                    <label htmlFor={keyId} className="mb-1.5 block text-xs font-medium text-foreground">
                      {t("settings.apiKey.title")}
                    </label>
                    <input
                      id={keyId}
                      type="password"
                      value={apiKey}
                      onChange={(e) => {
                        setApiKey(e.target.value);
                        invalidateTest();
                      }}
                      placeholder={
                        hasStoredKey
                          ? t("settings.apiKey.storedPlaceholder")
                          : t("settings.apiKey.placeholder", { provider: option.label })
                      }
                      maxLength={256}
                      className="w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
                    />
                  </div>
                  {option.needsRegion && (
                    <div>
                      <label htmlFor={regionId} className="mb-1.5 block text-xs font-medium text-foreground">
                        {t("settings.region.label")}
                      </label>
                      <select
                        id={regionId}
                        value={region}
                        onChange={(e) => {
                          setRegion(e.target.value);
                          invalidateTest();
                        }}
                        className="w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none cursor-pointer"
                      >
                        {(AZURE_REGIONS.includes(region) ? AZURE_REGIONS : [region, ...AZURE_REGIONS]).map((r) => (
                          <option key={r} value={r}>{r}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  {showEndpoint || endpoints[cloud].trim() ? (
                    <ProviderEndpointField
                      provider={cloud}
                      value={endpoints[cloud]}
                      onChange={(url) => {
                        setEndpoint(cloud, url);
                        invalidateTest();
                      }}
                      apiKey={apiKey}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => setShowEndpoint(true)}
                      className="text-xs text-primary/70 underline-offset-2 hover:text-primary hover:underline"
                    >
                      {t("quickSetup.customEndpoint")}
                    </button>
                  )}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={runTest}
                  disabled={!canTest || test.state === "testing"}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
                >
                  {test.state === "testing" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wifi className="h-3.5 w-3.5" />}
                  {cloud && apiKey.trim() && !hasStoredKey ? t("settings.apiKey.saveAndTest") : t("common:actions.testConnection")}
                </button>
                {test.state === "ok" && (
                  <span className="flex items-center gap-1 text-xs text-success" role="status">
                    <CheckCircle className="h-3 w-3" />
                    {t("quickSetup.testOk", { ms: test.ms })}
                  </span>
                )}
                {test.state === "idle" && testPassed && (
                  <span className="flex items-center gap-1 text-xs text-success" role="status">
                    <CheckCircle className="h-3 w-3" />
                    {t("quickSetup.testedBefore")}
                  </span>
                )}
              </div>
              {test.state === "error" && (
                <p className="flex items-start gap-1.5 text-xs text-destructive" role="alert">
                  <XCircle className="mt-0.5 h-3 w-3 shrink-0" />
                  <span className="break-words">{t("common:errors.testFailed", { detail: test.message })}</span>
                </p>
              )}
              {test.state === "idle" && !testPassed && (
                <p className="text-xs text-muted-foreground">{t("quickSetup.testNeeded")}</p>
              )}
            </div>
          )}
        </>
      )}

      {variant === "wizard" && (
        <button
          type="button"
          onClick={() => useMeetingStore.getState().openSettings("translation")}
          className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {t("quickSetup.moreSettings")}
        </button>
      )}
    </div>
  );
}
