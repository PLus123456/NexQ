// Translation Settings — provider selector with API key and service address,
// LLM prompts, languages, who to translate, and behavior toggles.
// Follows the STT/LLM settings pattern: provider grid, API key input, test connection, make active.

import { useState, useEffect, useCallback, useId } from "react";
import { useTranslationStore, errorMessage } from "../stores/translationStore";
import { useConfigStore } from "../stores/configStore";
import { storeApiKey, getApiKey, hasApiKey, deleteApiKey, listOpusMtModels } from "../lib/ipc";
import { testTranslationProvider } from "../lib/translation/ipc";
import type { TranslationProviderType, OpusMtModelStatus } from "../lib/types";
import { TRANSLATION_COMMON, languageLabel } from "../lib/languages";
import { LanguageCombobox } from "../components/LanguageCombobox";
import { useT } from "../i18n";
import {
  Globe,
  Cloud,
  Server,
  Layers,
  Brain,
  CheckCircle,
  XCircle,
  Eye,
  EyeOff,
  Loader2,
  Wifi,
  AlertTriangle,
} from "lucide-react";
import { OpusMtModelManager } from "./OpusMtModelManager";
import { LlmTranslationPanel } from "./translation/LlmTranslationPanel";
import { PartyTranslationPicker } from "./translation/PartyTranslationPicker";
import { TRANSLATION_PARTIES, partyTranslationMode } from "../lib/translation/nativeTranslation";
import { ProviderEndpointField } from "./translation/ProviderEndpointField";
import {
  ALL_PROVIDERS,
  AZURE_REGIONS,
  CLOUD_PROVIDERS,
  LOCAL_PROVIDERS,
  MICROSOFT_REGION_KEY,
  isCloudProvider,
  type ProviderOption,
} from "./translation/providers";
import { MAX_LIVE_SETTLE_MS, MIN_LIVE_SETTLE_MS } from "../lib/translation/defaults";

// ── Badge logic ──

type BadgeVariant = "ready" | "available" | "no-key";
interface BadgeState { text: string; variant: BadgeVariant }

const BADGE_STYLES: Record<BadgeVariant, string> = {
  "ready": "bg-success/20 text-success border-success/20",
  "available": "bg-info/20 text-info border-info/20",
  "no-key": "bg-muted text-muted-foreground border-border/30",
};

// Status dot colors derived from badge variant
const DOT_COLORS: Record<BadgeVariant, string> = {
  "ready": "bg-success",
  "available": "bg-info",
  "no-key": "bg-muted-foreground/40",
};

type ConnectionStatus = "idle" | "testing" | "success" | "error";

// ══════════════════════════════════════════════════════════════

export function TranslationSettings() {
  const { t } = useT(["translation", "common"]);
  const provider = useTranslationStore((s) => s.provider);
  const setStoreProvider = useTranslationStore((s) => s.setProvider);
  const targetLang = useTranslationStore((s) => s.targetLang);
  const setTargetLang = useTranslationStore((s) => s.setTargetLang);
  const sourceLang = useTranslationStore((s) => s.sourceLang);
  const setSourceLang = useTranslationStore((s) => s.setSourceLang);
  const autoTranslateEnabled = useTranslationStore((s) => s.autoTranslateEnabled);
  const setAutoTranslateEnabled = useTranslationStore((s) => s.setAutoTranslateEnabled);
  const selectionToolbarEnabled = useTranslationStore((s) => s.selectionToolbarEnabled);
  const setSelectionToolbarEnabled = useTranslationStore((s) => s.setSelectionToolbarEnabled);
  const cacheEnabled = useTranslationStore((s) => s.cacheEnabled);
  const setCacheEnabled = useTranslationStore((s) => s.setCacheEnabled);
  const endpoints = useTranslationStore((s) => s.endpoints);
  const setEndpoint = useTranslationStore((s) => s.setEndpoint);
  const liveSettleMs = useTranslationStore((s) => s.liveSettleMs);
  const setLiveSettleMs = useTranslationStore((s) => s.setLiveSettleMs);
  const backendStatus = useTranslationStore((s) => s.backendStatus);
  const translateParties = useTranslationStore((s) => s.translateParties);
  const meetingAudioConfig = useConfigStore((s) => s.meetingAudioConfig);
  const syncBackend = useTranslationStore((s) => s.syncBackend);
  const showPostMeetingTranslation = useConfigStore((s) => s.showPostMeetingTranslation);
  const setShowPostMeetingTranslation = useConfigStore((s) => s.setShowPostMeetingTranslation);

  const [selectedProvider, setSelectedProvider] = useState<TranslationProviderType>(provider);
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [keyDirty, setKeyDirty] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("idle");
  const [statusMessage, setStatusMessage] = useState("");
  const [azureRegion, setAzureRegion] = useState("global");
  const [keyStatusMap, setKeyStatusMap] = useState<Record<string, boolean>>({});
  const [testedProviders, setTestedProviders] = useState<Set<string>>(new Set());
  const [opusMtModels, setOpusMtModels] = useState<OpusMtModelStatus[]>([]);
  const settleId = useId();

  // Sync selectedProvider grid when the active provider loads from storage
  // (loadConfig runs async after mount, so useState initial value may be stale)
  useEffect(() => {
    setSelectedProvider(provider);
  }, [provider]);

  const currentProviderOption = ALL_PROVIDERS.find((p) => p.value === selectedProvider);
  const providerLabel = (p: ProviderOption | undefined, fallback: string) =>
    p ? (p.labelKey ? t(p.labelKey) : p.label) : fallback;

  // ── Load OPUS-MT model status for badge display + language filtering ──
  // Refreshes when the active provider changes (e.g., after activating a new model)

  const refreshOpusMtModels = useCallback((fresh?: OpusMtModelStatus[]) => {
    const apply = (models: OpusMtModelStatus[]) => {
      setOpusMtModels(models);
      // When OPUS-MT is active, sync targetLang to the active model's target
      if (provider === "opus-mt") {
        const active = models.find((m) => m.is_active);
        if (active && targetLang !== active.definition.target_lang) {
          setTargetLang(active.definition.target_lang);
          setSourceLang(active.definition.source_lang);
        }
      }
    };
    if (fresh) {
      apply(fresh);
    } else {
      listOpusMtModels().then(apply).catch(() => {});
    }
  }, [provider, targetLang, setTargetLang, setSourceLang]);

  useEffect(() => {
    refreshOpusMtModels();
  }, [provider, refreshOpusMtModels]);

  const opusMtDownloadedCount = opusMtModels.filter((m) => m.is_downloaded).length;
  const opusMtActiveModel = opusMtModels.find((m) => m.is_active);
  const opusMtHasActive = Boolean(opusMtActiveModel);

  // ── Check which cloud providers have stored keys (for badge display) ──

  useEffect(() => {
    async function checkAllKeys() {
      const status: Record<string, boolean> = {};
      for (const p of CLOUD_PROVIDERS) {
        try { status[p.credentialKey] = await hasApiKey(p.credentialKey); } catch { status[p.credentialKey] = false; }
      }
      setKeyStatusMap(status);
    }
    checkAllKeys();
  }, []);

  // ── Load key when provider changes ──

  useEffect(() => {
    const loadKeyForProvider = async () => {
      setApiKey("");
      setShowApiKey(false);
      setHasStoredKey(false);
      setKeyDirty(false);
      setConnectionStatus("idle");
      setStatusMessage("");

      if (!currentProviderOption?.requiresApiKey) return;

      const credKey = currentProviderOption.credentialKey;
      if (!credKey) return;

      try {
        const keyExists = await hasApiKey(credKey);
        setHasStoredKey(keyExists);
        if (keyExists) {
          const stored = await getApiKey(credKey);
          if (stored) setApiKey(stored);
        }
      } catch (e) {
        console.warn("Failed to load translation API key:", e);
      }

      if (currentProviderOption.needsRegion) {
        try {
          const regionExists = await hasApiKey(MICROSOFT_REGION_KEY);
          if (regionExists) {
            const stored = await getApiKey(MICROSOFT_REGION_KEY);
            if (stored) setAzureRegion(stored);
          }
        } catch (e) {
          console.warn("Failed to load Azure region:", e);
        }
      }
    };
    loadKeyForProvider();
  }, [selectedProvider, currentProviderOption?.credentialKey, currentProviderOption?.requiresApiKey, currentProviderOption?.needsRegion]);

  const customEndpoint = isCloudProvider(selectedProvider) ? endpoints[selectedProvider].trim() : "";

  // ── Badge state ──

  function getBadgeState(p: ProviderOption): BadgeState {
    if (p.isLocal) {
      if (p.value === "llm") {
        return { text: t("settings.badge.available"), variant: "available" };
      }
      // OPUS-MT — dynamic badge based on model presence
      if (p.value === "opus-mt") {
        if (opusMtHasActive) return { text: t("settings.badge.ready"), variant: "ready" };
        if (opusMtDownloadedCount > 0) return { text: t("settings.badge.models", { count: opusMtDownloadedCount }), variant: "available" };
        return { text: t("settings.badge.noModels"), variant: "no-key" };
      }
      return { text: t("settings.badge.notReady"), variant: "no-key" };
    }
    // Cloud providers
    if (testedProviders.has(p.value)) return { text: t("settings.badge.ready"), variant: "ready" };
    if (keyStatusMap[p.credentialKey]) return { text: t("settings.badge.hasKey"), variant: "available" };
    if (isCloudProvider(p.value) && endpoints[p.value].trim()) return { text: t("settings.badge.customEndpoint"), variant: "available" };
    return { text: t("settings.badge.noKey"), variant: "no-key" };
  }

  // ── Handlers ──

  const handleProviderSelect = (prov: TranslationProviderType) => {
    setSelectedProvider(prov);
    setConnectionStatus("idle");
    setStatusMessage("");
  };

  /** Saves a changed key (and the region), then tests the selected provider — the active one stays. */
  const handleSaveAndTest = useCallback(async () => {
    if (!currentProviderOption?.requiresApiKey) return;
    const key = apiKey.trim();
    if (!key && !customEndpoint) return;

    setConnectionStatus("testing");
    setStatusMessage(t("settings.apiKey.testing"));

    try {
      if (keyDirty && key) {
        await storeApiKey(currentProviderOption.credentialKey, key);
        setHasStoredKey(true);
        setKeyDirty(false);
        setKeyStatusMap((prev) => ({ ...prev, [currentProviderOption.credentialKey]: true }));
      }
      if (currentProviderOption.needsRegion && azureRegion.trim()) {
        await storeApiKey(MICROSOFT_REGION_KEY, azureRegion.trim());
      }

      const result = await testTranslationProvider(
        selectedProvider,
        { endpoints },
        currentProviderOption.needsRegion ? azureRegion : undefined,
      );

      if (result.connected) {
        setConnectionStatus("success");
        setStatusMessage(
          result.language_count > 0
            ? t("settings.apiKey.connected", { count: result.language_count, ms: result.response_ms })
            : t("settings.apiKey.connectedNoList", { ms: result.response_ms }),
        );
        setTestedProviders((prev) => new Set(prev).add(selectedProvider));
        // The active provider picks up a new key or region.
        if (selectedProvider === provider) void syncBackend();
      } else {
        setConnectionStatus("error");
        setStatusMessage(result.error || t("settings.apiKey.failed"));
      }
    } catch (e) {
      setConnectionStatus("error");
      setStatusMessage(errorMessage(e));
    }
  }, [apiKey, azureRegion, customEndpoint, endpoints, keyDirty, provider, selectedProvider, currentProviderOption, syncBackend, t]);

  const handleMakeActive = useCallback(async () => {
    try {
      if (currentProviderOption?.requiresApiKey && keyDirty && apiKey.trim()) {
        await storeApiKey(currentProviderOption.credentialKey, apiKey.trim()).catch(() => {});
      }
      if (currentProviderOption?.needsRegion && azureRegion.trim()) {
        await storeApiKey(MICROSOFT_REGION_KEY, azureRegion.trim()).catch(() => {});
      }
    } finally {
      // Tells the backend; its answer shows in the banner.
      setStoreProvider(selectedProvider);
    }
  }, [selectedProvider, apiKey, keyDirty, azureRegion, currentProviderOption, setStoreProvider]);

  const handleRegionChange = (region: string) => {
    setAzureRegion(region);
    storeApiKey(MICROSOFT_REGION_KEY, region)
      .then(() => {
        if (provider === "microsoft") void syncBackend();
      })
      .catch((e) => console.warn("Failed to store Azure region:", e));
  };

  const handleClearKey = async () => {
    if (!currentProviderOption) return;
    try {
      await deleteApiKey(currentProviderOption.credentialKey);
      setHasStoredKey(false);
      setApiKey("");
      setConnectionStatus("idle");
      setStatusMessage("");
      setTestedProviders((prev) => {
        const next = new Set(prev);
        next.delete(selectedProvider);
        return next;
      });
      setKeyStatusMap((prev) => ({ ...prev, [currentProviderOption.credentialKey]: false }));
      if (selectedProvider === provider) void syncBackend();
    } catch { /* ignore */ }
  };

  const isCloud = currentProviderOption?.requiresApiKey ?? false;
  const isOpusMt = selectedProvider === "opus-mt";
  const isLlm = selectedProvider === "llm";
  // The active OPUS-MT model decides the languages.
  const opusLocksLanguages = provider === "opus-mt" && opusMtHasActive;

  // ── "Make Active" gating logic ──
  // Cloud: tested this session, a stored key or a custom address (and key not dirty). OPUS-MT: when model is active. LLM: always.
  const canMakeActive = (() => {
    if (selectedProvider === provider) return false; // already active
    if (isOpusMt) return opusMtHasActive;
    if (isCloud) return (testedProviders.has(selectedProvider) || hasStoredKey || Boolean(customEndpoint)) && !keyDirty;
    if (isLlm) return true;
    return false;
  })();

  const activeOption = ALL_PROVIDERS.find((p) => p.value === provider);
  // The STT engine reads the target when its session starts (Soniox).
  const nativeInUse = TRANSLATION_PARTIES.some(
    (party) => partyTranslationMode(party, translateParties, meetingAudioConfig) === "native",
  );
  const activeStatus = backendStatus?.provider === provider ? backendStatus : null;

  return (
    <div className="space-y-5">
      {/* ── Active Provider Banner (full-width above grid) ── */}
      <div
        className={`flex items-center gap-3 rounded-xl border px-5 py-3.5 ${
          activeStatus?.ok === false ? "border-destructive/40 bg-destructive/5" : "border-primary/30 bg-primary/5"
        }`}
      >
        {activeStatus?.ok === false
          ? <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
          : <Globe className="h-4 w-4 text-primary shrink-0" />}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground">
            {t("settings.banner.active", {
              provider: providerLabel(activeOption, provider),
              language: languageLabel(targetLang),
            })}
          </p>
          {activeStatus?.ok === false ? (
            <p className="mt-0.5 break-words text-xs text-destructive" role="alert">
              {t("settings.banner.notReady", { detail: activeStatus.error ?? "" })}
            </p>
          ) : (
            <p className="mt-0.5 text-xs text-muted-foreground">{t("settings.banner.hint")}</p>
          )}
        </div>
        {activeStatus?.ok && (
          <div className="flex items-center gap-1 text-success shrink-0">
            <CheckCircle className="h-3.5 w-3.5" />
            <span className="text-xs">{t("settings.banner.ready")}</span>
          </div>
        )}
      </div>

      {/* ── Two-column grid ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* ═══ LEFT COLUMN: Provider-specific ═══ */}
        <div className="space-y-5">
          {/* ── Provider Selection Grid ── */}
          <div className="rounded-xl border border-border/30 bg-card/50 overflow-hidden">
            {/* Local & Offline */}
            <div className="px-5 pt-4 pb-3 border-b border-border/20 bg-muted/10">
              <div className="flex items-center gap-2 mb-3">
                <div className="flex h-5 w-5 items-center justify-center rounded bg-success/10">
                  <Server className="h-3 w-3 text-success" />
                </div>
                <span className="text-xs font-semibold text-foreground">{t("settings.groups.local")}</span>
                <span className="ml-auto text-meta text-muted-foreground/60 font-medium uppercase tracking-wider">
                  {t("settings.groups.localTag")}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {LOCAL_PROVIDERS.map((p) => (
                  <ProviderCard
                    key={p.value}
                    provider={p}
                    label={providerLabel(p, p.value)}
                    isSelected={selectedProvider === p.value}
                    isActive={provider === p.value}
                    badge={getBadgeState(p)}
                    onClick={() => handleProviderSelect(p.value)}
                  />
                ))}
              </div>
            </div>

            {/* Cloud Providers */}
            <div className="px-5 pt-4 pb-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="flex h-5 w-5 items-center justify-center rounded bg-info/10">
                  <Cloud className="h-3 w-3 text-info" />
                </div>
                <span className="text-xs font-semibold text-foreground">{t("settings.groups.cloud")}</span>
                <span className="ml-auto text-meta text-muted-foreground/60 font-medium uppercase tracking-wider">
                  {t("settings.groups.cloudTag")}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {CLOUD_PROVIDERS.map((p) => (
                  <ProviderCard
                    key={p.value}
                    provider={p}
                    label={providerLabel(p, p.value)}
                    isSelected={selectedProvider === p.value}
                    isActive={provider === p.value}
                    badge={getBadgeState(p)}
                    onClick={() => handleProviderSelect(p.value)}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* ── API Key + address (cloud providers only) ── */}
          {isCloud && currentProviderOption && isCloudProvider(selectedProvider) && (
            <div className="space-y-4 rounded-xl border border-border/30 bg-card/50 p-4">
              <div>
                <h3 className="mb-3 text-sm font-semibold text-primary/80">{t("settings.apiKey.title")}</h3>

                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <input
                      type={showApiKey ? "text" : "password"}
                      value={apiKey}
                      onChange={(e) => {
                        setApiKey(e.target.value);
                        setKeyDirty(true);
                        setConnectionStatus("idle");
                        setStatusMessage("");
                      }}
                      placeholder={
                        hasStoredKey && !keyDirty
                          ? t("settings.apiKey.storedPlaceholder")
                          : customEndpoint
                            ? t("settings.apiKey.optionalPlaceholder", { provider: currentProviderOption.label })
                            : t("settings.apiKey.placeholder", { provider: currentProviderOption.label })
                      }
                      maxLength={256}
                      aria-label={t("settings.apiKey.title")}
                      className="w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 pr-10 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
                    />
                    <button
                      onClick={() => setShowApiKey(!showApiKey)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground cursor-pointer"
                      type="button"
                      aria-label={showApiKey ? t("settings.apiKey.hide") : t("settings.apiKey.show")}
                      aria-pressed={showApiKey}
                    >
                      {showApiKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </button>
                  </div>

                  {/* New or changed key → Save & Test; otherwise Test (also keyless with a custom address) */}
                  {(keyDirty ? apiKey.trim() !== "" : (hasStoredKey || Boolean(customEndpoint))) && (
                    <button
                      onClick={handleSaveAndTest}
                      disabled={connectionStatus === "testing"}
                      className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
                    >
                      {connectionStatus === "testing" ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Wifi className="h-3.5 w-3.5" />
                      )}
                      {keyDirty ? t("settings.apiKey.saveAndTest") : t("settings.apiKey.test")}
                    </button>
                  )}

                  {/* Clear stored key */}
                  {hasStoredKey && !keyDirty && (
                    <button
                      onClick={handleClearKey}
                      className="flex items-center gap-1.5 rounded-lg border border-destructive/30 px-3 py-2 text-xs font-medium text-destructive hover:bg-destructive/10 transition-colors cursor-pointer"
                      title={t("settings.apiKey.clearTitle")}
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      {t("settings.apiKey.clear")}
                    </button>
                  )}
                </div>

                {/* Help link */}
                {currentProviderOption.helpUrl && (
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    <a
                      href={currentProviderOption.helpUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary/70 hover:text-primary underline-offset-2 hover:underline"
                    >
                      {t("settings.apiKey.help")} &rarr;
                    </a>
                  </p>
                )}

                {/* Status feedback */}
                <div className="mt-2 min-h-[18px]">
                  {connectionStatus === "testing" && (
                    <p className="text-xs text-muted-foreground">{statusMessage}</p>
                  )}
                  {connectionStatus === "success" && (
                    <div className="flex items-center gap-1.5 text-xs text-success">
                      <CheckCircle className="h-3 w-3" />
                      {statusMessage}
                    </div>
                  )}
                  {connectionStatus === "error" && (
                    <div className="flex items-start gap-1.5 text-xs text-destructive" role="alert">
                      <XCircle className="mt-0.5 h-3 w-3 shrink-0" />
                      <span className="break-words">{statusMessage}</span>
                    </div>
                  )}
                  {connectionStatus === "idle" && hasStoredKey && !keyDirty && (
                    <p className="text-xs text-success/70">{t("settings.apiKey.stored")}</p>
                  )}
                  {connectionStatus === "idle" && !hasStoredKey && (
                    <p className="text-xs text-muted-foreground">{t("settings.apiKey.enterAndTest")}</p>
                  )}
                </div>
              </div>

              {/* Azure Region dropdown (Microsoft only) */}
              {currentProviderOption.needsRegion && (
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-foreground">{t("settings.region.label")}</label>
                  <select
                    value={azureRegion}
                    onChange={(e) => handleRegionChange(e.target.value)}
                    className="w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20 cursor-pointer"
                  >
                    {(AZURE_REGIONS.includes(azureRegion) ? AZURE_REGIONS : [azureRegion, ...AZURE_REGIONS]).map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-muted-foreground">{t("settings.region.hint")}</p>
                </div>
              )}

              {/* Custom service address */}
              <ProviderEndpointField
                provider={selectedProvider}
                value={endpoints[selectedProvider]}
                onChange={(url) => {
                  setEndpoint(selectedProvider, url);
                  setConnectionStatus("idle");
                  setStatusMessage("");
                }}
                apiKey={apiKey}
              />
            </div>
          )}

          {/* ── OPUS-MT Model Manager ── */}
          {isOpusMt && <OpusMtModelManager onModelsChanged={refreshOpusMtModels} />}

          {/* ── LLM translation: model note, prompts, glossary, test ── */}
          {isLlm && <LlmTranslationPanel />}

          {/* Make Active — full-width at bottom of left column */}
          {canMakeActive && (
            <button
              onClick={handleMakeActive}
              className="w-full rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 text-sm font-medium text-primary transition-all duration-150 hover:bg-primary/10 hover:-translate-y-px active:translate-y-px active:scale-[0.99] cursor-pointer"
            >
              {t("settings.makeActive", { provider: providerLabel(currentProviderOption, selectedProvider) })}
            </button>
          )}
        </div>

        {/* ═══ RIGHT COLUMN: Common settings ═══ */}
        <div className="space-y-5">
          {/* ── Language Settings ── */}
          <div className="rounded-xl border border-border/30 bg-card/50 p-4">
            <h3 className="mb-3 text-sm font-semibold text-primary/80">{t("settings.language.title")}</h3>

            <div className="space-y-4">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-foreground">{t("settings.language.target")}</label>
                <LanguageCombobox
                  value={targetLang}
                  onChange={setTargetLang}
                  common={TRANSLATION_COMMON}
                  disabled={opusLocksLanguages}
                  aria-label={t("settings.language.target")}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {opusLocksLanguages
                    ? t("settings.language.opusMtLocked", { name: opusMtActiveModel?.definition.display_name ?? "" })
                    : t("settings.language.targetHint")}
                </p>
                {nativeInUse && (
                  <p className="mt-1 text-xs text-muted-foreground">{t("settings.language.nativeNote")}</p>
                )}
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-foreground">{t("settings.language.source")}</label>
                <LanguageCombobox
                  value={sourceLang}
                  onChange={setSourceLang}
                  common={TRANSLATION_COMMON}
                  allowAuto
                  disabled={opusLocksLanguages}
                  aria-label={t("settings.language.source")}
                />
                <p className="mt-1 text-xs text-muted-foreground">{t("settings.language.sourceHint")}</p>
              </div>
            </div>
          </div>

          {/* ── Who to translate ── */}
          <div className="rounded-xl border border-border/30 bg-card/50 p-4">
            <h3 className="mb-3 text-sm font-semibold text-primary/80">{t("parties.title")}</h3>
            <PartyTranslationPicker />
          </div>

          {/* ── Behavior Toggles ── */}
          <div className="rounded-xl border border-border/30 bg-card/50 p-4">
            <h3 className="mb-3 text-sm font-semibold text-primary/80">{t("settings.behavior.title")}</h3>
            <div className="space-y-4">
              {/* Live translation on when a meeting starts (also set by the overlay's Translate button) */}
              <ToggleRow
                label={t("settings.behavior.autoStart.label")}
                description={t("settings.behavior.autoStart.description")}
                checked={autoTranslateEnabled}
                onChange={setAutoTranslateEnabled}
              />

              {/* Select-to-translate toolbar */}
              <ToggleRow
                label={t("settings.behavior.selection.label")}
                description={t("settings.behavior.selection.description")}
                checked={selectionToolbarEnabled}
                onChange={setSelectionToolbarEnabled}
              />

              {/* Show translations in post-meeting */}
              <ToggleRow
                label={t("settings.behavior.postMeeting.label")}
                description={t("settings.behavior.postMeeting.description")}
                checked={showPostMeetingTranslation}
                onChange={setShowPostMeetingTranslation}
              />

              {/* Cache translations */}
              <ToggleRow
                label={t("settings.behavior.cache.label")}
                description={t("settings.behavior.cache.description")}
                checked={cacheEnabled}
                onChange={setCacheEnabled}
              />

              {/* Live settle time */}
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <label htmlFor={settleId} className="text-sm font-medium text-foreground">
                    {t("settings.behavior.settle.label")}
                  </label>
                  <p className="mt-0.5 text-xs text-muted-foreground">{t("settings.behavior.settle.description")}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <input
                    id={settleId}
                    type="number"
                    min={MIN_LIVE_SETTLE_MS / 1000}
                    max={MAX_LIVE_SETTLE_MS / 1000}
                    step={0.1}
                    value={(liveSettleMs / 1000).toFixed(1)}
                    onChange={(e) => {
                      const seconds = Number(e.target.value);
                      if (Number.isFinite(seconds)) setLiveSettleMs(seconds * 1000);
                    }}
                    className="w-16 rounded-lg border border-border/50 bg-background px-2 py-1.5 text-right text-sm tabular-nums text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
                  />
                  <span className="text-xs text-muted-foreground">{t("settings.behavior.settle.unit")}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Provider Card ──

function ProviderCard({
  provider,
  label,
  isSelected,
  isActive,
  badge,
  onClick,
}: {
  provider: ProviderOption;
  label: string;
  isSelected: boolean;
  isActive: boolean;
  badge: BadgeState;
  onClick: () => void;
}) {
  const { t } = useT("translation");
  return (
    <button
      onClick={onClick}
      aria-pressed={isSelected}
      className={`relative flex flex-col items-start rounded-xl border p-3 text-left transition-all duration-150 cursor-pointer ${
        isSelected
          ? "border-primary bg-primary/10 ring-1 ring-primary/20 shadow-sm"
          : "border-border/40 bg-card/30 hover:border-border/70 hover:bg-accent/60"
      }`}
    >
      {/* Status dot — color reflects actual badge state */}
      {isActive && (
        <div className="absolute -top-1 -right-1">
          <div
            className={`h-2.5 w-2.5 rounded-full ring-2 ring-card ${DOT_COLORS[badge.variant]}`}
            title={t("settings.badge.activeDot", { badge: badge.text })}
            aria-hidden="true"
          />
        </div>
      )}
      <div className="flex w-full items-center gap-1.5 mb-1">
        <ProviderIcon value={provider.value} isSelected={isSelected} />
        <span className={`text-xs font-medium ${isSelected ? "text-primary" : "text-foreground"}`}>
          {label}
        </span>
        <span
          className={`ml-auto inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[8px] font-semibold tracking-wide ${BADGE_STYLES[badge.variant]}`}
        >
          {badge.text}
        </span>
      </div>
      <span className="text-meta text-muted-foreground/70 leading-tight">
        {t(provider.descriptionKey)}
      </span>
    </button>
  );
}

// ── Provider icon helper ──

function ProviderIcon({ value, isSelected }: { value: TranslationProviderType; isSelected?: boolean }) {
  const cls = `h-3.5 w-3.5 shrink-0 ${isSelected ? "text-primary" : "text-muted-foreground"}`;
  switch (value) {
    case "opus-mt":
      return <Layers className={cls} />;
    case "llm":
      return <Brain className={cls} />;
    case "microsoft":
      return <Cloud className={cls} />;
    case "google":
      return <Globe className={cls} />;
    case "deepl":
      return <Cloud className={cls} />;
    default:
      return <Server className={cls} />;
  }
}

// ── Toggle Row ──

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (val: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <button
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 ${
          checked ? "bg-primary" : "bg-muted-foreground/30"
        }`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform duration-200 ${
            checked ? "translate-x-[18px]" : "translate-x-[3px]"
          }`}
        />
      </button>
    </div>
  );
}
