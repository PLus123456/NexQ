// STT Settings — engine cards with inline configuration per engine.
// Clicking a card picks the engine to configure; "Use for" puts it on You / Them.
// Badges: ready=green, no model/key/server=red, key saved or server set but
//         not tested yet=amber, tested=green.

import { useState, useEffect, useCallback, useMemo } from "react";
import type { ParseKeys } from "i18next";
import { Trans, useT } from "../i18n";
import { useConfigStore } from "../stores/configStore";
import { showToast } from "../stores/toastStore";
import {
  setSTTProvider,
  testSTTConnection,
  listLocalSTTEngines,
  deleteApiKey,
} from "../lib/ipc";
import { storeApiKey, getApiKey, hasApiKey } from "../lib/ipc";
import type { STTProviderType, DeepgramConfig, GroqConfig } from "../lib/types";
import {
  CheckCircle,
  XCircle,
  Loader2,
  Eye,
  EyeOff,
  Cloud,
  Wifi,
  HardDrive,
  Trash2,
  ChevronDown,
  ChevronUp,
  Settings2,
} from "lucide-react";
import { LocalModelManager } from "./LocalModelManager";
import { currentPlatform } from "../lib/platform";
import {
  isSttProviderAvailable,
  sttKeySlot,
  sttProviderMeta,
  sttProvidersFor,
  type SttProviderMeta,
} from "../lib/stt/providerMeta";
import { OpenAICompatSttSettings } from "./stt/OpenAICompatSttSettings";
import { SonioxSettings } from "./stt/SonioxSettings";
import { PartyLanguageField } from "./stt/PartyLanguageField";
import {
  PARTIES,
  SttEngineIcon,
  assignPartyEngine,
  availabilityContext,
  defaultMeetingAudioConfig,
  exclusiveFallback,
  isModelReady,
  needsExclusiveSwap,
  otherParty,
  partyLabel,
  sttEngineDescription,
  sttEngineLabel,
  unavailableReason,
  useSttReadiness,
  type Party,
} from "./stt/sttEngines";

/** Engines with their own settings panel (and key handling) instead of the generic key panel. */
const OWN_PANEL_ENGINES: readonly STTProviderType[] = ["openai_compat", "soniox"];

/** Engines the legacy backend router doesn't know (`set_stt_provider` isn't called for them). */
const NO_LEGACY_ROUTER_ENGINES: readonly STTProviderType[] = ["openai_compat", "soniox"];

// ── Deepgram Models ──

interface DeepgramModelInfo {
  id: string;
  /** Model name (product name, not translated). */
  name: string;
  tier: "latest" | "standard" | "economy" | "whisper";
  descriptionKey: ParseKeys<"stt">;
  costPerMin: number;
}

const DEEPGRAM_MODELS: DeepgramModelInfo[] = [
  { id: "nova-3", name: "Nova 3", tier: "latest", descriptionKey: "deepgram.models.nova3", costPerMin: 0.0059 },
  { id: "nova-2", name: "Nova 2", tier: "standard", descriptionKey: "deepgram.models.nova2", costPerMin: 0.0043 },
  { id: "nova", name: "Nova", tier: "standard", descriptionKey: "deepgram.models.nova", costPerMin: 0.0043 },
  { id: "enhanced", name: "Enhanced", tier: "standard", descriptionKey: "deepgram.models.enhanced", costPerMin: 0.0043 },
  { id: "base", name: "Base", tier: "economy", descriptionKey: "deepgram.models.base", costPerMin: 0.0043 },
  { id: "whisper-large", name: "Whisper Large", tier: "whisper", descriptionKey: "deepgram.models.whisperLarge", costPerMin: 0.0048 },
  { id: "whisper-medium", name: "Whisper Medium", tier: "whisper", descriptionKey: "deepgram.models.whisperMedium", costPerMin: 0.0048 },
  { id: "whisper-small", name: "Whisper Small", tier: "whisper", descriptionKey: "deepgram.models.whisperSmall", costPerMin: 0.0048 },
  { id: "whisper-tiny", name: "Whisper Tiny", tier: "whisper", descriptionKey: "deepgram.models.whisperTiny", costPerMin: 0.0048 },
  { id: "whisper-base", name: "Whisper Base", tier: "whisper", descriptionKey: "deepgram.models.whisperBase", costPerMin: 0.0048 },
];

// ── Deepgram Presets ──

interface DeepgramPreset {
  id: string;
  labelKey: ParseKeys<"stt">;
  descriptionKey: ParseKeys<"stt">;
  config: DeepgramConfig;
}

const DEEPGRAM_PRESETS: DeepgramPreset[] = [
  {
    id: "default",
    labelKey: "deepgram.presets.default.label",
    descriptionKey: "deepgram.presets.default.description",
    config: {
      model: "nova-3", smart_format: false, interim_results: true,
      endpointing: 300, punctuate: true, diarize: true,
      profanity_filter: false, numerals: false, dictation: false,
      vad_events: true, keyterms: [],
    },
  },
  {
    id: "low_latency",
    labelKey: "deepgram.presets.lowLatency.label",
    descriptionKey: "deepgram.presets.lowLatency.description",
    config: {
      model: "nova-3", smart_format: false, interim_results: true,
      endpointing: 150, punctuate: false, diarize: false,
      profanity_filter: false, numerals: false, dictation: false,
      vad_events: true, keyterms: [],
    },
  },
  {
    id: "high_accuracy",
    labelKey: "deepgram.presets.highAccuracy.label",
    descriptionKey: "deepgram.presets.highAccuracy.description",
    config: {
      model: "nova-3", smart_format: true, interim_results: true,
      endpointing: 500, punctuate: true, diarize: true,
      profanity_filter: false, numerals: true, dictation: false,
      vad_events: true, keyterms: [],
    },
  },
  {
    id: "meeting_mode",
    labelKey: "deepgram.presets.meeting.label",
    descriptionKey: "deepgram.presets.meeting.description",
    config: {
      model: "nova-3", smart_format: true, interim_results: true,
      endpointing: 400, punctuate: true, diarize: true,
      profanity_filter: false, numerals: true, dictation: false,
      vad_events: true, keyterms: [],
    },
  },
  {
    id: "economy",
    labelKey: "deepgram.presets.economy.label",
    descriptionKey: "deepgram.presets.economy.description",
    config: {
      model: "nova-2", smart_format: false, interim_results: true,
      endpointing: 300, punctuate: true, diarize: false,
      profanity_filter: false, numerals: false, dictation: false,
      vad_events: false, keyterms: [],
    },
  },
];

function configMatchesPreset(config: DeepgramConfig, preset: DeepgramConfig): boolean {
  return (
    config.model === preset.model &&
    config.smart_format === preset.smart_format &&
    config.interim_results === preset.interim_results &&
    config.endpointing === preset.endpointing &&
    config.punctuate === preset.punctuate &&
    config.diarize === preset.diarize &&
    config.profanity_filter === preset.profanity_filter &&
    config.numerals === preset.numerals &&
    config.dictation === preset.dictation &&
    config.vad_events === preset.vad_events
    // keyterms excluded from preset matching — user-specific
  );
}

type ConnectionStatus = "idle" | "testing" | "success" | "error";
type BadgeVariant = "ready" | "warning" | "error";
interface BadgeState { text: string; variant: BadgeVariant }

/** A pending "Use for" that moves the other party off Web Speech / Windows Speech. */
interface PendingSwap {
  party: Party;
  engine: STTProviderType;
  fallback: STTProviderType | null;
}

export function STTSettings() {
  const { t } = useT(["stt", "common"]);
  const sttProvider = useConfigStore((s) => s.sttProvider);
  const setConfigSTTProvider = useConfigStore((s) => s.setSTTProvider);
  const meetingAudioConfig = useConfigStore((s) => s.meetingAudioConfig);
  const setMeetingAudioConfig = useConfigStore((s) => s.setMeetingAudioConfig);
  const micDeviceId = useConfigStore((s) => s.micDeviceId);
  const systemDeviceId = useConfigStore((s) => s.systemDeviceId);
  const recordingEnabled = useConfigStore((s) => s.recordingEnabled);
  // Persisted: providers whose key has been saved + tested successfully
  const verifiedCloudProviders = useConfigStore((s) => s.verifiedCloudProviders);
  const setVerifiedCloudProviders = useConfigStore((s) => s.setVerifiedCloudProviders);
  const hasBaseUrl = useConfigStore((s) => s.openaiCompatSttConfig.base_url.trim() !== "");

  // This platform's engines (Windows Speech only on Windows), in picker order.
  const offered = useMemo(() => sttProvidersFor(currentPlatform()), []);
  const readiness = useSttReadiness();

  const partyConfig =
    meetingAudioConfig ?? defaultMeetingAudioConfig({ micDeviceId, systemDeviceId, recordingEnabled });

  // The engine whose settings are shown: You's, else Them's, else the first one.
  const [selectedProvider, setSelectedProvider] = useState<STTProviderType>(() => {
    const candidates = [partyConfig.you.stt_provider, partyConfig.them.stt_provider, sttProvider];
    return candidates.find((id) => offered.some((o) => o.id === id)) ?? offered[0]?.id ?? "web_speech";
  });
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [hasStoredKey, setHasStoredKey] = useState(false);
  // keyDirty: user has typed a new key that differs from stored — show Save & Test
  const [keyDirty, setKeyDirty] = useState(false);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("idle");
  const [statusMessage, setStatusMessage] = useState("");
  const [pendingSwap, setPendingSwap] = useState<PendingSwap | null>(null);

  const [azureRegion, setAzureRegion] = useState("eastus");
  const [, setHasStoredRegion] = useState(false);

  const currentProviderOption: SttProviderMeta | undefined =
    offered.find((p) => p.id === selectedProvider) ?? sttProviderMeta(selectedProvider);
  const hasOwnPanel = OWN_PANEL_ENGINES.includes(selectedProvider);
  /** The generic key panel: cloud engines without their own panel. */
  const usesKeyPanel = !!currentProviderOption?.requiresApiKey && !hasOwnPanel;
  const needsRegion = selectedProvider === "azure_speech";
  const credentialKey = currentProviderOption ? sttKeySlot(currentProviderOption) : "";
  const selectedLabel = sttEngineLabel(selectedProvider);

  // ── Badge & readiness logic ──

  function getBadgeState(p: SttProviderMeta): BadgeState {
    const ready: BadgeState = { text: t("stt:settings.badges.ready"), variant: "ready" };
    if (p.requiresDownload) {
      return isModelReady(readiness.localEngines, p.requiresDownload)
        ? ready
        : { text: t("stt:settings.badges.noModel"), variant: "error" };
    }
    if (p.requiresBaseUrl) {
      if (!hasBaseUrl) return { text: t("stt:settings.badges.noServer"), variant: "error" };
      return verifiedCloudProviders.includes(p.id)
        ? ready
        : { text: t("stt:settings.badges.untested"), variant: "warning" };
    }
    if (p.requiresApiKey) {
      // Verified = key was saved+tested successfully (persisted across page navigations)
      if (verifiedCloudProviders.includes(p.id)) return ready;
      if (readiness.keys[sttKeySlot(p)]) return { text: t("stt:settings.badges.keySaved"), variant: "warning" };
      return { text: t("stt:settings.badges.noKey"), variant: "error" };
    }
    return ready;
  }

  // ── Key loading (load stored key display when switching providers) ──

  useEffect(() => {
    const loadKeyForProvider = async () => {
      setApiKey("");
      setShowApiKey(false);
      setHasStoredKey(false);
      setKeyDirty(false);
      setConnectionStatus("idle");
      setStatusMessage("");
      setPendingSwap(null);

      if (!usesKeyPanel || !credentialKey) return;

      try {
        const keyExists = await hasApiKey(credentialKey);
        setHasStoredKey(keyExists);
        if (keyExists) {
          const stored = await getApiKey(credentialKey);
          if (stored) setApiKey(stored);
        }
      } catch (e) {
        console.warn("Failed to load STT API key:", e);
      }

      if (needsRegion) {
        try {
          const regionExists = await hasApiKey("azure_speech_region");
          setHasStoredRegion(regionExists);
          if (regionExists) {
            const stored = await getApiKey("azure_speech_region");
            if (stored) setAzureRegion(stored);
          }
        } catch (e) {
          console.warn("Failed to load Azure region:", e);
        }
      }
    };
    loadKeyForProvider();
  }, [selectedProvider, credentialKey, usesKeyPanel, needsRegion]);

  // ── Handlers ──

  /** The party's availability inputs (its device kind decides input-only engines). */
  const partyContext = useCallback(
    (party: Party) => availabilityContext(readiness, partyConfig[party].is_input_device, hasBaseUrl),
    [readiness, partyConfig, hasBaseUrl]
  );

  /** Puts `engine` on `party` (after the swap confirmation for exclusive engines). */
  const applyUseFor = useCallback(
    (party: Party, engine: STTProviderType, fallback: STTProviderType | null) => {
      const state = useConfigStore.getState();
      const base = state.meetingAudioConfig ?? defaultMeetingAudioConfig(state);
      const assignment = assignPartyEngine(base, party, engine, state, fallback);
      if (!assignment) {
        showToast(t("stt:picker.steal.noFallback"), "error");
        return;
      }
      // Sync meetingAudioConfig so useAudioConfigSync hot-swaps the live capture.
      setMeetingAudioConfig(assignment.config);
      // "You" also drives the legacy single-engine setting (backward compat).
      if (party === "you" || assignment.fallback?.party === "you") {
        const youEngine = assignment.config.you.stt_provider;
        setConfigSTTProvider(youEngine);
        if (!NO_LEGACY_ROUTER_ENGINES.includes(youEngine)) {
          setSTTProvider(youEngine).catch((e) => console.error("Failed to set STT provider:", e));
        }
      }
      if (assignment.fallback) {
        showToast(
          t("stt:picker.steal.moved", {
            engine: sttEngineLabel(engine),
            party: partyLabel(party),
            other: partyLabel(assignment.fallback.party),
            fallback: sttEngineLabel(assignment.fallback.engine),
          }),
          "info"
        );
      }
    },
    [setMeetingAudioConfig, setConfigSTTProvider, t]
  );

  const handleUseFor = useCallback(
    (party: Party) => {
      const engine = selectedProvider;
      const state = useConfigStore.getState();
      const base = state.meetingAudioConfig ?? defaultMeetingAudioConfig(state);
      if (needsExclusiveSwap(base, party, engine)) {
        const other = otherParty(party);
        const fallback = exclusiveFallback(offered, (meta) => isSttProviderAvailable(meta, partyContext(other)));
        setPendingSwap({ party, engine, fallback });
        return;
      }
      setPendingSwap(null);
      applyUseFor(party, engine, null);
    },
    [selectedProvider, offered, partyContext, applyUseFor]
  );

  const setPartyLanguage = useCallback(
    (party: Party, code: string) => {
      const state = useConfigStore.getState();
      const base = state.meetingAudioConfig ?? defaultMeetingAudioConfig(state);
      // The language isn't part of a preset: keep preset_name.
      setMeetingAudioConfig({ ...base, [party]: { ...base[party], language: code } });
    },
    [setMeetingAudioConfig]
  );

  /** Save & Test: test key first, only persist on success. */
  const handleSaveAndTest = useCallback(async () => {
    if (!apiKey.trim() || !credentialKey) return;

    setConnectionStatus("testing");
    setStatusMessage(t("stt:settings.apiKey.testing"));

    try {
      // Temporarily store so the backend can read it during test
      await storeApiKey(credentialKey, apiKey.trim());
      if (needsRegion && azureRegion.trim()) {
        await storeApiKey("azure_speech_region", azureRegion.trim());
        setHasStoredRegion(true);
      }

      const success = await testSTTConnection(selectedProvider);
      if (success) {
        setHasStoredKey(true);
        setKeyDirty(false);
        setConnectionStatus("success");
        setStatusMessage(t("stt:settings.apiKey.success"));
        // Persist the verified state
        const updated = Array.from(new Set([...verifiedCloudProviders, selectedProvider]));
        setVerifiedCloudProviders(updated);
      } else {
        // Remove the key we temporarily stored — test failed
        await deleteApiKey(credentialKey).catch(() => {});
        setHasStoredKey(false);
        setConnectionStatus("error");
        setStatusMessage(t("stt:settings.apiKey.failed"));
        const updated = verifiedCloudProviders.filter((p) => p !== selectedProvider);
        setVerifiedCloudProviders(updated);
      }
    } catch (e) {
      await deleteApiKey(credentialKey).catch(() => {});
      setHasStoredKey(false);
      setConnectionStatus("error");
      setStatusMessage(t("common:errors.testFailed", { detail: String(e) }));
      const updated = verifiedCloudProviders.filter((p) => p !== selectedProvider);
      setVerifiedCloudProviders(updated);
    }
    readiness.refresh();
  }, [apiKey, azureRegion, selectedProvider, credentialKey, needsRegion, verifiedCloudProviders, setVerifiedCloudProviders, readiness, t]);

  const handleClearApiKey = useCallback(async () => {
    if (!credentialKey) return;
    try { await deleteApiKey(credentialKey); } catch { /* ok */ }
    setApiKey("");
    setHasStoredKey(false);
    setKeyDirty(false);
    setConnectionStatus("idle");
    setStatusMessage("");
    const updated = verifiedCloudProviders.filter((p) => p !== selectedProvider);
    setVerifiedCloudProviders(updated);
    readiness.refresh();
  }, [credentialKey, selectedProvider, verifiedCloudProviders, setVerifiedCloudProviders, readiness]);

  const handleSaveRegion = useCallback(async () => {
    if (!azureRegion.trim()) return;
    try {
      await storeApiKey("azure_speech_region", azureRegion.trim());
      setHasStoredRegion(true);
    } catch (e) {
      console.warn("Failed to save Azure region:", e);
    }
  }, [azureRegion]);

  /** Test Connection — only for local/always-ready providers; cloud uses handleSaveAndTest. */
  const handleTestConnection = useCallback(async () => {
    setConnectionStatus("testing");
    setStatusMessage(t("common:status.testing"));

    try {
      const engineId = currentProviderOption?.requiresDownload;
      if (engineId) {
        const engines = await listLocalSTTEngines();
        const eng = engines.find((e) => e.engine === engineId);
        const downloaded = eng?.models.filter((m) => m.is_downloaded && !m.id.startsWith("binary-")) ?? [];
        readiness.refresh();
        if (downloaded.length === 0) {
          setConnectionStatus("error");
          setStatusMessage(t("stt:settings.connection.noModel"));
          return;
        }
        setConnectionStatus("success");
        setStatusMessage(t("stt:settings.connection.modelsReady", { count: downloaded.length }));
        return;
      }

      const success = await testSTTConnection(selectedProvider);
      setConnectionStatus(success ? "success" : "error");
      setStatusMessage(success ? t("stt:settings.connection.ready") : t("stt:settings.connection.failed"));
    } catch (e) {
      setConnectionStatus("error");
      setStatusMessage(t("common:errors.testFailed", { detail: String(e) }));
    }
  }, [selectedProvider, currentProviderOption, readiness, t]);

  // Does the selected provider need an inline model panel?
  const modelEngineId = currentProviderOption?.requiresDownload;

  const localProviders = offered.filter((p) => !p.isCloud);
  const cloudProviders = offered.filter((p) => p.isCloud);
  const usedBy = (id: STTProviderType) => PARTIES.filter((party) => partyConfig[party].stt_provider === id);

  return (
    <div className="space-y-6">
      {/* Provider Selection — grouped: Local then Cloud */}
      <div className="rounded-xl border border-border/30 bg-card/50 overflow-hidden">
        {/* Local Providers */}
        <div className="px-5 pt-4 pb-3 border-b border-border/20 bg-muted/10">
          <div className="flex items-center gap-2 mb-3">
            <div className="flex h-5 w-5 items-center justify-center rounded bg-success/10">
              <HardDrive className="h-3 w-3 text-success" />
            </div>
            <span className="text-xs font-semibold text-foreground">{t("stt:groups.local")}</span>
            <span className="ml-auto text-meta text-muted-foreground/60 font-medium uppercase tracking-wider">{t("stt:groups.localHint")}</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {localProviders.map((p) => (
              <ProviderCard
                key={p.id}
                provider={p}
                isSelected={selectedProvider === p.id}
                usedBy={usedBy(p.id)}
                badge={getBadgeState(p)}
                onClick={() => setSelectedProvider(p.id)}
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
            <span className="text-xs font-semibold text-foreground">{t("stt:groups.cloud")}</span>
            <span className="ml-auto text-meta text-muted-foreground/60 font-medium uppercase tracking-wider">{t("stt:groups.cloudHint")}</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {cloudProviders.map((p) => (
              <ProviderCard
                key={p.id}
                provider={p}
                isSelected={selectedProvider === p.id}
                usedBy={usedBy(p.id)}
                badge={getBadgeState(p)}
                onClick={() => setSelectedProvider(p.id)}
              />
            ))}
          </div>
        </div>
      </div>

      {/* The selected engine: who uses it, "Use for" */}
      {currentProviderOption && (
        <div className="rounded-xl border border-border/30 bg-card/50 p-5">
          <div className="flex items-start gap-2.5">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <SttEngineIcon id={selectedProvider} className="h-3.5 w-3.5 text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold text-primary/80">{selectedLabel}</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">{sttEngineDescription(selectedProvider)}</p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2" role="group" aria-label={t("stt:settings.useFor.ariaLabel", { engine: selectedLabel })}>
            <span className="mr-1 text-meta font-semibold uppercase tracking-wider text-muted-foreground/60">
              {t("stt:settings.useFor.label")}
            </span>
            {PARTIES.map((party) => {
              const inUse = partyConfig[party].stt_provider === selectedProvider;
              const reason = inUse ? null : unavailableReason(currentProviderOption, partyContext(party));
              return (
                <button
                  key={party}
                  type="button"
                  aria-pressed={inUse}
                  disabled={!!reason}
                  onClick={() => {
                    if (!inUse) handleUseFor(party);
                  }}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-all duration-150 ${
                    inUse
                      ? "border-primary/50 bg-primary/10 text-primary cursor-default"
                      : "border-border/40 bg-card/50 text-muted-foreground hover:border-border/70 hover:text-foreground cursor-pointer active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border/40 disabled:hover:text-muted-foreground"
                  }`}
                >
                  {inUse && <CheckCircle className="h-3 w-3" />}
                  {partyLabel(party)}
                </button>
              );
            })}
          </div>
          {PARTIES.map((party) => {
            if (partyConfig[party].stt_provider === selectedProvider) return null;
            const reason = unavailableReason(currentProviderOption, partyContext(party));
            if (!reason) return null;
            return (
              <p key={party} className="mt-2 text-meta text-muted-foreground/80">
                {t("stt:settings.useFor.unavailable", {
                  party: partyLabel(party),
                  reason: t(`stt:settings.useFor.reasons.${reason}`),
                })}
              </p>
            );
          })}
          {pendingSwap && pendingSwap.engine === selectedProvider && (
            <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
              <p className="mb-2 text-meta leading-relaxed text-amber-200/80">
                <Trans
                  t={t}
                  i18nKey="stt:settings.useFor.swap"
                  values={{
                    engine: selectedLabel,
                    party: partyLabel(pendingSwap.party),
                    other: partyLabel(otherParty(pendingSwap.party)),
                    fallback: pendingSwap.fallback
                      ? sttEngineLabel(pendingSwap.fallback)
                      : t("stt:picker.steal.noEngine"),
                  }}
                  components={{
                    strong: <span className="font-semibold text-amber-400" />,
                    fallback: <span className="font-medium" />,
                  }}
                />
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    applyUseFor(pendingSwap.party, pendingSwap.engine, pendingSwap.fallback);
                    setPendingSwap(null);
                  }}
                  className="rounded-lg bg-amber-500/20 border border-amber-500/30 px-3 py-1 text-meta font-semibold text-amber-400 hover:bg-amber-500/30 cursor-pointer"
                >
                  {t("stt:picker.steal.switch")}
                </button>
                <button
                  type="button"
                  onClick={() => setPendingSwap(null)}
                  className="rounded-lg bg-muted/30 px-3 py-1 text-meta font-medium text-muted-foreground hover:bg-muted/50 cursor-pointer"
                >
                  {t("common:actions.cancel")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Inline Model Panel — shown when the selected provider needs models */}
      {modelEngineId && (
        <div className="rounded-xl border border-border/30 bg-card/50 p-5">
          <h3 className="mb-1 text-sm font-semibold text-primary/80 flex items-center gap-1.5">
            <HardDrive className="h-4 w-4" />
            {t("stt:settings.models.title", { engine: selectedLabel })}
          </h3>
          <p className="mb-3 text-xs text-muted-foreground">
            <Trans t={t} i18nKey="stt:settings.models.hint" components={{ strong: <strong /> }} />
          </p>
          <LocalModelManager engineFilter={modelEngineId} onModelsChange={readiness.refresh} />
        </div>
      )}

      {/* Remote Whisper and Soniox: their own panels (they never read a key back) */}
      {selectedProvider === "openai_compat" && <OpenAICompatSttSettings onKeyChange={readiness.refresh} />}
      {selectedProvider === "soniox" && <SonioxSettings onKeyChange={readiness.refresh} />}

      {/* API Key — cloud providers only. Save & Test flow: test first, persist only on success. */}
      {usesKeyPanel && currentProviderOption && (
        <div className="rounded-xl border border-border/30 bg-card/50 p-5">
          <h3 className="mb-3 text-sm font-semibold text-primary/80">{t("stt:settings.apiKey.title")}</h3>

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
                    ? t("stt:settings.apiKey.storedPlaceholder")
                    : t("stt:settings.apiKey.placeholder", { engine: selectedLabel })
                }
                aria-label={t("stt:settings.apiKey.title")}
                className="w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 pr-10 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
              />
              <button
                onClick={() => setShowApiKey(!showApiKey)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
                type="button"
                aria-label={showApiKey ? t("stt:settings.apiKey.hide") : t("stt:settings.apiKey.show")}
                aria-pressed={showApiKey}
              >
                {showApiKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>

            {/* Save & Test — shown whenever user has typed a key */}
            {(keyDirty || (!hasStoredKey && apiKey.trim())) && (
              <button
                onClick={handleSaveAndTest}
                disabled={!apiKey.trim() || connectionStatus === "testing"}
                className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {connectionStatus === "testing" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Wifi className="h-3.5 w-3.5" />
                )}
                {t("stt:settings.apiKey.saveAndTest")}
              </button>
            )}

            {/* Clear — only if key is stored and verified, and user hasn't started typing a new one */}
            {hasStoredKey && !keyDirty && (
              <button
                onClick={handleClearApiKey}
                className="flex items-center gap-1.5 rounded-lg border border-destructive/30 px-3 py-2 text-xs text-destructive transition-colors hover:bg-destructive/10"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t("common:actions.clear")}
              </button>
            )}
          </div>

          {/* Status feedback */}
          <div className="mt-2 min-h-[18px]">
            {connectionStatus === "success" && (
              <div className="flex items-center gap-1.5 text-xs text-success">
                <CheckCircle className="h-3 w-3" />
                {statusMessage}
              </div>
            )}
            {connectionStatus === "error" && (
              <div className="flex items-center gap-1.5 text-xs text-destructive">
                <XCircle className="h-3 w-3" />
                {statusMessage}
              </div>
            )}
            {connectionStatus === "idle" && hasStoredKey && !keyDirty && (
              <p className="text-xs text-success/70">
                {t("stt:settings.apiKey.stored")}
              </p>
            )}
            {connectionStatus === "idle" && !hasStoredKey && (
              <p className="text-xs text-muted-foreground">
                {t("stt:settings.apiKey.prompt")}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Azure Region Input */}
      {needsRegion && (
        <div className="rounded-xl border border-border/30 bg-card/50 p-5">
          <h3 className="mb-3 text-sm font-semibold text-primary/80">
            {t("stt:settings.azureRegion.title")}
          </h3>
          <input
            type="text"
            value={azureRegion}
            onChange={(e) => setAzureRegion(e.target.value)}
            onBlur={handleSaveRegion}
            placeholder="eastus"
            aria-label={t("stt:settings.azureRegion.title")}
            className="w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
          />
          <p className="mt-1.5 text-xs text-muted-foreground">
            {t("stt:settings.azureRegion.hint")}
          </p>
        </div>
      )}

      {/* Universal Pause Detection */}
      <PauseThresholdSetting />

      {/* Deepgram Advanced Settings — shown when Deepgram is selected */}
      {selectedProvider === "deepgram" && <DeepgramAdvancedSettings />}

      {/* Groq Whisper Settings — shown when Groq is selected */}
      {selectedProvider === "groq_whisper" && <GroqAdvancedSettings />}

      {/* Whisper.cpp Dual-Pass Settings */}
      {selectedProvider === "whisper_cpp" && <DualPassSettings />}

      {/* Language Selection — one per party */}
      <div className="rounded-xl border border-border/30 bg-card/50 p-5">
        <h3 className="mb-1 text-sm font-semibold text-primary/80">
          {t("stt:settings.languages.title")}
        </h3>
        <p className="mb-3 text-xs text-muted-foreground">{t("stt:settings.languages.hint")}</p>
        <div className="grid grid-cols-2 gap-4">
          {PARTIES.map((party) => {
            const id = `stt-settings-${party}-language`;
            return (
              <div key={party}>
                <label htmlFor={id} className="mb-1.5 flex items-baseline gap-1.5 text-xs font-medium text-foreground">
                  {partyLabel(party)}
                  <span className="truncate text-meta font-normal text-muted-foreground/70">
                    {sttEngineLabel(partyConfig[party].stt_provider)}
                  </span>
                </label>
                <PartyLanguageField
                  id={id}
                  aria-label={t("stt:language.partyAriaLabel", { party: partyLabel(party) })}
                  party={partyConfig[party]}
                  onChange={(code) => setPartyLanguage(party, code)}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Test Connection — only for local/always-ready providers; cloud uses Save & Test in the key section */}
      {!currentProviderOption?.requiresApiKey && !hasOwnPanel && (
        <div className="rounded-xl border border-border/30 bg-card/50 p-5">
          <h3 className="mb-3 text-sm font-semibold text-primary/80">{t("stt:settings.connection.title")}</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={handleTestConnection}
              disabled={connectionStatus === "testing"}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              {connectionStatus === "testing" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Wifi className="h-3.5 w-3.5" />
              )}
              {t("common:actions.testConnection")}
            </button>

            {connectionStatus === "success" && (
              <div className="flex items-center gap-1 text-success">
                <CheckCircle className="h-3.5 w-3.5" />
                <span className="text-xs">{statusMessage}</span>
              </div>
            )}
            {connectionStatus === "error" && (
              <div className="flex items-center gap-1 text-destructive">
                <XCircle className="h-3.5 w-3.5" />
                <span className="text-xs truncate max-w-[200px]">{statusMessage}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Provider Card ──

function ProviderCard({
  provider,
  isSelected,
  usedBy,
  badge,
  onClick,
}: {
  provider: SttProviderMeta;
  isSelected: boolean;
  /** The parties that use this engine now. */
  usedBy: Party[];
  badge: BadgeState;
  onClick: () => void;
}) {
  const label = sttEngineLabel(provider.id);
  return (
    <button
      onClick={onClick}
      aria-pressed={isSelected}
      className={`relative flex flex-col items-start rounded-xl border p-3 text-left transition-all duration-150 ${
        isSelected
          ? "border-primary bg-primary/10 ring-1 ring-primary/20 shadow-sm"
          : "border-border/40 bg-card/30 hover:border-border/70 hover:bg-accent/60"
      }`}
    >
      <div className="flex w-full items-start justify-between gap-1 mb-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <SttEngineIcon
            id={provider.id}
            className={`h-3.5 w-3.5 shrink-0 ${isSelected ? "text-primary" : "text-muted-foreground"}`}
          />
          <span
            title={label}
            className={`text-xs font-medium truncate ${isSelected ? "text-primary" : "text-foreground"}`}
          >
            {label}
          </span>
        </div>
        <ProviderBadge
          text={badge.text}
          variant={badge.variant}
        />
      </div>
      <span className="text-meta text-muted-foreground/70 line-clamp-1 leading-tight">
        {sttEngineDescription(provider.id)}
      </span>
      {usedBy.length > 0 && (
        <span className="mt-1.5 flex gap-1">
          {usedBy.map((party) => (
            <span
              key={party}
              className={`rounded border px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wide ${
                party === "you"
                  ? "border-sky-500/20 bg-sky-500/10 text-sky-400"
                  : "border-amber-500/20 bg-amber-500/10 text-amber-400"
              }`}
            >
              {partyLabel(party)}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

// ── Provider Badge ──

function ProviderBadge({ text, variant }: { text: string; variant: BadgeVariant }) {
  const styles: Record<BadgeVariant, string> = {
    ready: "bg-success/20 text-success border-success/20",
    warning: "bg-warning/20 text-warning border-warning/20",
    error: "bg-destructive/20 text-destructive border-destructive/20",
  };
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[8px] font-semibold tracking-wide ${styles[variant]}`}
    >
      {text}
    </span>
  );
}

// ── Universal Pause Threshold Setting ──

function PauseThresholdSetting() {
  const { t } = useT(["stt", "common"]);
  const pauseThresholdMs = useConfigStore((s) => s.pauseThresholdMs);
  const setPauseThresholdMs = useConfigStore((s) => s.setPauseThresholdMs);

  return (
    <div className="rounded-xl border border-border/30 bg-card/50 p-5">
      <h3 className="mb-1 text-sm font-semibold text-primary/80">
        {t("stt:pause.title")}
      </h3>
      <p className="mb-3 text-xs text-muted-foreground">
        {t("stt:pause.hint")}
      </p>
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={500}
          max={5000}
          step={100}
          value={pauseThresholdMs}
          onChange={(e) => setPauseThresholdMs(parseInt(e.target.value))}
          aria-label={t("stt:pause.title")}
          className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-muted accent-primary"
        />
        <span className="min-w-[4rem] text-right text-xs font-mono text-primary tabular-nums">
          {(pauseThresholdMs / 1000).toFixed(1)}s
        </span>
      </div>
      <div className="mt-1.5 flex justify-between text-meta text-muted-foreground/70">
        <span>{t("stt:pause.min")}</span>
        <span>{t("stt:pause.max")}</span>
      </div>
    </div>
  );
}

// ── Deepgram Advanced Settings ──

function DeepgramAdvancedSettings() {
  const { t } = useT(["stt", "common"]);
  const deepgramConfig = useConfigStore((s) => s.deepgramConfig);
  const setDeepgramConfig = useConfigStore((s) => s.setDeepgramConfig);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [keytermInput, setKeytermInput] = useState("");

  const activePresetId = DEEPGRAM_PRESETS.find((p) =>
    configMatchesPreset(deepgramConfig, p.config)
  )?.id ?? "custom";
  const activePreset = DEEPGRAM_PRESETS.find((p) => p.id === activePresetId);

  const applyPreset = (preset: DeepgramPreset) => {
    setDeepgramConfig({ ...preset.config, keyterms: deepgramConfig.keyterms });
  };

  const updateField = <K extends keyof DeepgramConfig>(key: K, value: DeepgramConfig[K]) => {
    setDeepgramConfig({ ...deepgramConfig, [key]: value });
  };

  const addKeyterm = () => {
    const term = keytermInput.trim();
    if (!term || deepgramConfig.keyterms.includes(term) || deepgramConfig.keyterms.length >= 100) return;
    updateField("keyterms", [...deepgramConfig.keyterms, term]);
    setKeytermInput("");
  };

  const removeKeyterm = (term: string) => {
    updateField("keyterms", deepgramConfig.keyterms.filter((k) => k !== term));
  };

  const activeModel = DEEPGRAM_MODELS.find((m) => m.id === deepgramConfig.model);

  return (
    <div className="rounded-xl border border-border/30 bg-card/50 overflow-hidden">
      {/* Header */}
      <div className="px-5 pt-4 pb-3 border-b border-border/20">
        <div className="flex items-center gap-2">
          <div className="flex h-5 w-5 items-center justify-center rounded bg-primary/10">
            <Settings2 className="h-3 w-3 text-primary" />
          </div>
          <span className="text-xs font-semibold text-foreground">{t("stt:deepgram.title")}</span>
          {activePreset && (
            <span className="ml-1 rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-meta font-semibold text-primary uppercase tracking-wide">
              {t(activePreset.labelKey)}
            </span>
          )}
          {activePresetId === "custom" && (
            <span className="ml-1 rounded border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-meta font-semibold text-warning uppercase tracking-wide">
              {t("common:labels.custom")}
            </span>
          )}
          {activeModel && (
            <span className="ml-auto text-meta text-muted-foreground/60">
              {t("stt:deepgram.priceLine", { price: activeModel.costPerMin.toFixed(4), model: activeModel.name })}
            </span>
          )}
        </div>
      </div>

      {/* Presets */}
      <div className="px-5 py-3 border-b border-border/20 bg-muted/5">
        <p className="mb-2 text-meta font-medium text-muted-foreground uppercase tracking-wider">{t("stt:deepgram.presetsLabel")}</p>
        <div className="flex flex-wrap gap-1.5">
          {DEEPGRAM_PRESETS.map((preset) => (
            <button
              key={preset.id}
              onClick={() => applyPreset(preset)}
              title={t(preset.descriptionKey)}
              className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition-all ${
                activePresetId === preset.id
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border/40 bg-card/50 text-muted-foreground hover:border-border/70 hover:text-foreground"
              }`}
            >
              {t(preset.labelKey)}
            </button>
          ))}
        </div>
      </div>

      {/* Model Selection */}
      <div className="px-5 py-3 border-b border-border/20">
        <label className="mb-1.5 block text-meta font-medium text-muted-foreground uppercase tracking-wider">{t("stt:deepgram.model")}</label>
        <div className="grid grid-cols-2 gap-1.5">
          {DEEPGRAM_MODELS.map((model) => {
            const tierColors: Record<string, string> = {
              latest: "text-success",
              standard: "text-info",
              economy: "text-warning",
              whisper: "text-purple-400",
            };
            return (
              <button
                key={model.id}
                onClick={() => updateField("model", model.id)}
                className={`flex items-start rounded-lg border px-3 py-2 text-left transition-all ${
                  deepgramConfig.model === model.id
                    ? "border-primary bg-primary/10 ring-1 ring-primary/20"
                    : "border-border/30 hover:border-border/60 hover:bg-accent/40"
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className={`text-xs font-semibold ${deepgramConfig.model === model.id ? "text-primary" : "text-foreground"}`}>
                      {model.name}
                    </span>
                    {model.tier === "latest" && (
                      <span className="rounded bg-success/10 px-1 py-0.5 text-[8px] font-bold text-success">{t("stt:deepgram.newTag")}</span>
                    )}
                  </div>
                  <p className="text-meta text-muted-foreground/70 leading-tight mt-0.5">{t(model.descriptionKey)}</p>
                  <p className={`text-meta font-mono mt-0.5 ${tierColors[model.tier]}`}>
                    {t("stt:deepgram.pricePerMinute", { price: model.costPerMin.toFixed(4) })}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Core Feature Toggles */}
      <div className="px-5 py-3 border-b border-border/20">
        <label className="mb-2 block text-meta font-medium text-muted-foreground uppercase tracking-wider">{t("stt:deepgram.features")}</label>
        <div className="space-y-2">
          <DeepgramToggle
            label={t("stt:deepgram.toggles.smartFormat.label")}
            param="smart_format"
            description={t("stt:deepgram.toggles.smartFormat.description")}
            checked={deepgramConfig.smart_format}
            onChange={(v) => updateField("smart_format", v)}
          />
          <DeepgramToggle
            label={t("stt:deepgram.toggles.interimResults.label")}
            param="interim_results"
            description={t("stt:deepgram.toggles.interimResults.description")}
            checked={deepgramConfig.interim_results}
            onChange={(v) => updateField("interim_results", v)}
          />
          <DeepgramToggle
            label={t("stt:deepgram.toggles.punctuate.label")}
            param="punctuate"
            description={t("stt:deepgram.toggles.punctuate.description")}
            checked={deepgramConfig.punctuate}
            onChange={(v) => updateField("punctuate", v)}
          />
          <DeepgramToggle
            label={t("stt:deepgram.toggles.vadEvents.label")}
            param="vad_events"
            description={t("stt:deepgram.toggles.vadEvents.description")}
            checked={deepgramConfig.vad_events}
            onChange={(v) => updateField("vad_events", v)}
          />
        </div>
      </div>

      {/* Endpointing */}
      <div className="px-5 py-3 border-b border-border/20">
        <div className="flex items-center justify-between mb-2">
          <div>
            <span className="text-xs font-medium text-foreground">{t("stt:deepgram.endpointing.label")}</span>
            <code className="ml-2 text-meta text-muted-foreground/60">endpointing=NUMBER</code>
          </div>
          <button
            onClick={() => updateField("endpointing", deepgramConfig.endpointing === null ? 300 : null)}
            role="switch"
            aria-checked={deepgramConfig.endpointing !== null}
            aria-label={t("stt:deepgram.endpointing.label")}
            className={`relative inline-flex h-4 w-8 items-center rounded-full transition-colors ${
              deepgramConfig.endpointing !== null ? "bg-primary" : "bg-muted"
            }`}
          >
            <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
              deepgramConfig.endpointing !== null ? "translate-x-4" : "translate-x-0.5"
            }`} />
          </button>
        </div>
        {deepgramConfig.endpointing !== null && (
          <>
            <div className="flex items-center justify-between mb-1">
              <span className="text-meta text-muted-foreground">{t("stt:deepgram.endpointing.threshold")}</span>
              <span className="text-meta font-mono text-primary tabular-nums">{deepgramConfig.endpointing}ms</span>
            </div>
            <input
              type="range"
              min={10}
              max={2000}
              step={10}
              value={deepgramConfig.endpointing}
              onChange={(e) => updateField("endpointing", parseInt(e.target.value))}
              aria-label={t("stt:deepgram.endpointing.threshold")}
              className="w-full h-1.5 rounded-full bg-muted appearance-none cursor-pointer accent-primary"
            />
            <div className="flex justify-between mt-0.5">
              <span className="text-meta text-muted-foreground/70">{t("stt:deepgram.endpointing.min")}</span>
              <span className="text-meta text-muted-foreground/70">{t("stt:deepgram.endpointing.max")}</span>
            </div>
            <p className="mt-1 text-meta text-muted-foreground/60">
              {t("stt:deepgram.endpointing.hint")}
            </p>
          </>
        )}
        {deepgramConfig.endpointing === null && (
          <p className="text-meta text-muted-foreground/60">{t("stt:deepgram.endpointing.disabled")}</p>
        )}
      </div>

      {/* Advanced toggle */}
      <button
        onClick={() => setShowAdvanced(!showAdvanced)}
        aria-expanded={showAdvanced}
        className="flex w-full items-center justify-between px-5 py-2.5 text-xs text-muted-foreground hover:bg-accent/30 transition-colors"
      >
        <span className="font-medium">{t("stt:advancedSettings")}</span>
        {showAdvanced ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </button>

      {showAdvanced && (
        <div className="border-t border-border/20">
          {/* Advanced Feature Toggles */}
          <div className="px-5 py-3 border-b border-border/20 space-y-2">
            <DeepgramToggle
              label={t("stt:deepgram.toggles.diarize.label")}
              param="diarize"
              description={t("stt:deepgram.toggles.diarize.description")}
              checked={deepgramConfig.diarize}
              onChange={(v) => updateField("diarize", v)}
            />
            <DeepgramToggle
              label={t("stt:deepgram.toggles.numerals.label")}
              param="numerals"
              description={t("stt:deepgram.toggles.numerals.description")}
              checked={deepgramConfig.numerals}
              onChange={(v) => updateField("numerals", v)}
            />
            <DeepgramToggle
              label={t("stt:deepgram.toggles.profanityFilter.label")}
              param="profanity_filter"
              description={t("stt:deepgram.toggles.profanityFilter.description")}
              checked={deepgramConfig.profanity_filter}
              onChange={(v) => updateField("profanity_filter", v)}
            />
            <DeepgramToggle
              label={t("stt:deepgram.toggles.dictation.label")}
              param="dictation"
              description={t("stt:deepgram.toggles.dictation.description")}
              checked={deepgramConfig.dictation}
              onChange={(v) => updateField("dictation", v)}
            />
          </div>

          {/* Keyterm Prompting */}
          <div className="px-5 py-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-foreground">{t("stt:deepgram.keyterms.label")}</span>
              <code className="text-meta text-muted-foreground/60">keyterm=TERM</code>
            </div>
            <p className="mb-2 text-meta text-muted-foreground/70">
              {t("stt:deepgram.keyterms.hint")}
            </p>
            <div className="flex gap-2 mb-2">
              <input
                type="text"
                value={keytermInput}
                onChange={(e) => setKeytermInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") addKeyterm(); }}
                placeholder={t("stt:deepgram.keyterms.placeholder")}
                aria-label={t("stt:deepgram.keyterms.label")}
                className="flex-1 rounded-lg border border-border/50 bg-background px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
              />
              <button
                onClick={addKeyterm}
                disabled={!keytermInput.trim() || deepgramConfig.keyterms.length >= 100}
                className="rounded-lg border border-border/50 bg-background px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-40"
              >
                {t("common:actions.add")}
              </button>
            </div>
            {deepgramConfig.keyterms.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {deepgramConfig.keyterms.map((term) => (
                  <span
                    key={term}
                    className="flex items-center gap-1 rounded border border-border/40 bg-muted/30 px-2 py-0.5 text-meta text-foreground"
                  >
                    {term}
                    <button
                      onClick={() => removeKeyterm(term)}
                      aria-label={t("stt:deepgram.keyterms.remove", { term })}
                      className="text-muted-foreground hover:text-destructive transition-colors"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            {deepgramConfig.keyterms.length === 0 && (
              <p className="text-meta text-muted-foreground/70">{t("stt:deepgram.keyterms.empty")}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Deepgram Toggle Row ──

function DeepgramToggle({
  label,
  param,
  description,
  checked,
  onChange,
}: {
  label: string;
  param: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-foreground">{label}</span>
          <code className="text-meta text-muted-foreground/70">{param}={checked ? "true" : "false"}</code>
        </div>
        <p className="text-meta text-muted-foreground/60 leading-tight mt-0.5">{description}</p>
      </div>
      <button
        onClick={() => onChange(!checked)}
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={`shrink-0 relative inline-flex h-4 w-8 items-center rounded-full transition-colors ${
          checked ? "bg-primary" : "bg-muted"
        }`}
      >
        <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
          checked ? "translate-x-4" : "translate-x-0.5"
        }`} />
      </button>
    </div>
  );
}

// ── Groq Models & Presets ──

interface GroqModelInfo {
  id: string;
  /** Model name (product name, not translated). */
  name: string;
  descriptionKey: ParseKeys<"stt">;
  costPerHour: number;
  speedFactor: string;
}

const GROQ_MODELS: GroqModelInfo[] = [
  {
    id: "whisper-large-v3",
    name: "Whisper Large v3",
    descriptionKey: "groq.models.largeV3",
    costPerHour: 0.111,
    speedFactor: "189x",
  },
  {
    id: "whisper-large-v3-turbo",
    name: "Whisper Large v3 Turbo",
    descriptionKey: "groq.models.largeV3Turbo",
    costPerHour: 0.04,
    speedFactor: "216x",
  },
];

interface GroqPreset {
  id: string;
  labelKey: ParseKeys<"stt">;
  descriptionKey: ParseKeys<"stt">;
  config: GroqConfig;
}

const GROQ_PRESETS: GroqPreset[] = [
  {
    id: "default",
    labelKey: "groq.presets.default.label",
    descriptionKey: "groq.presets.default.description",
    config: {
      model: "whisper-large-v3-turbo",
      language: "en",
      temperature: 0,
      response_format: "json",
      timestamp_granularities: [],
      prompt: "",
      segment_duration_secs: 5.0,
    },
  },
  {
    id: "low_latency",
    labelKey: "groq.presets.lowLatency.label",
    descriptionKey: "groq.presets.lowLatency.description",
    config: {
      model: "whisper-large-v3-turbo",
      language: "en",
      temperature: 0,
      response_format: "json",
      timestamp_granularities: [],
      prompt: "",
      segment_duration_secs: 3.0,
    },
  },
  {
    id: "high_accuracy",
    labelKey: "groq.presets.highAccuracy.label",
    descriptionKey: "groq.presets.highAccuracy.description",
    config: {
      model: "whisper-large-v3",
      language: "en",
      temperature: 0,
      response_format: "json",
      timestamp_granularities: [],
      prompt: "",
      segment_duration_secs: 8.0,
    },
  },
  {
    id: "verbose",
    labelKey: "groq.presets.verbose.label",
    descriptionKey: "groq.presets.verbose.description",
    config: {
      model: "whisper-large-v3-turbo",
      language: "en",
      temperature: 0,
      response_format: "verbose_json",
      timestamp_granularities: ["segment", "word"],
      prompt: "",
      segment_duration_secs: 5.0,
    },
  },
];

function groqConfigMatchesPreset(config: GroqConfig, preset: GroqConfig): boolean {
  return (
    config.model === preset.model &&
    config.temperature === preset.temperature &&
    config.response_format === preset.response_format &&
    config.segment_duration_secs === preset.segment_duration_secs &&
    JSON.stringify(config.timestamp_granularities) === JSON.stringify(preset.timestamp_granularities)
    // prompt excluded from preset matching — user-specific
  );
}

// ── Groq Advanced Settings ──

function GroqAdvancedSettings() {
  const { t } = useT(["stt", "common"]);
  const groqConfig = useConfigStore((s) => s.groqConfig);
  const setGroqConfig = useConfigStore((s) => s.setGroqConfig);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const activePresetId = GROQ_PRESETS.find((p) =>
    groqConfigMatchesPreset(groqConfig, p.config)
  )?.id ?? "custom";
  const activePreset = GROQ_PRESETS.find((p) => p.id === activePresetId);

  const applyPreset = (preset: GroqPreset) => {
    setGroqConfig({ ...preset.config, prompt: groqConfig.prompt });
  };

  const updateField = <K extends keyof GroqConfig>(key: K, value: GroqConfig[K]) => {
    setGroqConfig({ ...groqConfig, [key]: value });
  };

  const activeModel = GROQ_MODELS.find((m) => m.id === groqConfig.model);
  const formatHint =
    groqConfig.response_format === "verbose_json"
      ? t("stt:groq.responseFormat.hints.verboseJson")
      : groqConfig.response_format === "text"
        ? t("stt:groq.responseFormat.hints.text")
        : t("stt:groq.responseFormat.hints.json");

  return (
    <div className="rounded-xl border border-border/30 bg-card/50 overflow-hidden">
      {/* Header */}
      <div className="px-5 pt-4 pb-3 border-b border-border/20">
        <div className="flex items-center gap-2">
          <div className="flex h-5 w-5 items-center justify-center rounded bg-primary/10">
            <Settings2 className="h-3 w-3 text-primary" />
          </div>
          <span className="text-xs font-semibold text-foreground">{t("stt:groq.title")}</span>
          {activePreset && (
            <span className="ml-1 rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-meta font-semibold text-primary uppercase tracking-wide">
              {t(activePreset.labelKey)}
            </span>
          )}
          {activePresetId === "custom" && (
            <span className="ml-1 rounded border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-meta font-semibold text-warning uppercase tracking-wide">
              {t("common:labels.custom")}
            </span>
          )}
          {activeModel && (
            <span className="ml-auto text-meta text-muted-foreground/60">
              {t("stt:groq.priceLine", { price: activeModel.costPerHour.toFixed(3), speed: activeModel.speedFactor })}
            </span>
          )}
        </div>
        <p className="mt-1.5 text-meta text-muted-foreground/60 leading-tight">
          {t("stt:groq.batchHint", {
            seconds: groqConfig.segment_duration_secs,
            min: groqConfig.segment_duration_secs + 1,
            max: groqConfig.segment_duration_secs + 2,
          })}
        </p>
      </div>

      {/* Presets */}
      <div className="px-5 py-3 border-b border-border/20 bg-muted/5">
        <p className="mb-2 text-meta font-medium text-muted-foreground uppercase tracking-wider">{t("stt:groq.presetsLabel")}</p>
        <div className="flex flex-wrap gap-1.5">
          {GROQ_PRESETS.map((preset) => (
            <button
              key={preset.id}
              onClick={() => applyPreset(preset)}
              title={t(preset.descriptionKey)}
              className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition-all ${
                activePresetId === preset.id
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border/40 bg-card/50 text-muted-foreground hover:border-border/70 hover:text-foreground"
              }`}
            >
              {t(preset.labelKey)}
            </button>
          ))}
        </div>
      </div>

      {/* Model Selection */}
      <div className="px-5 py-3 border-b border-border/20">
        <label className="mb-1.5 block text-meta font-medium text-muted-foreground uppercase tracking-wider">{t("stt:groq.model")}</label>
        <div className="grid grid-cols-2 gap-1.5">
          {GROQ_MODELS.map((model) => (
            <button
              key={model.id}
              onClick={() => updateField("model", model.id)}
              className={`flex items-start rounded-lg border px-3 py-2 text-left transition-all ${
                groqConfig.model === model.id
                  ? "border-primary bg-primary/10 ring-1 ring-primary/20"
                  : "border-border/30 hover:border-border/60 hover:bg-accent/40"
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className={`text-xs font-semibold ${groqConfig.model === model.id ? "text-primary" : "text-foreground"}`}>
                    {model.name}
                  </span>
                  {model.id === "whisper-large-v3-turbo" && (
                    <span className="rounded bg-success/10 px-1 py-0.5 text-[8px] font-bold text-success">{t("stt:groq.fastTag")}</span>
                  )}
                  {model.id === "whisper-large-v3" && (
                    <span className="rounded bg-info/10 px-1 py-0.5 text-[8px] font-bold text-info">{t("stt:groq.bestTag")}</span>
                  )}
                </div>
                <p className="text-meta text-muted-foreground/70 leading-tight mt-0.5">{t(model.descriptionKey)}</p>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-meta font-mono text-success">
                    {t("stt:groq.pricePerHour", { price: model.costPerHour.toFixed(3) })}
                  </span>
                  <span className="text-meta text-muted-foreground/70">{model.speedFactor}</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Batch Duration */}
      <div className="px-5 py-3 border-b border-border/20">
        <div className="flex items-center justify-between mb-2">
          <div>
            <span className="text-xs font-medium text-foreground">{t("stt:groq.batch.label")}</span>
            <code className="ml-2 text-meta text-muted-foreground/60">segment={groqConfig.segment_duration_secs}s</code>
          </div>
        </div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-meta text-muted-foreground">{t("stt:groq.batch.accumulation")}</span>
          <span className="text-meta font-mono text-primary tabular-nums">{groqConfig.segment_duration_secs.toFixed(1)}s</span>
        </div>
        <input
          type="range"
          min={2}
          max={15}
          step={0.5}
          value={groqConfig.segment_duration_secs}
          onChange={(e) => updateField("segment_duration_secs", parseFloat(e.target.value))}
          aria-label={t("stt:groq.batch.accumulation")}
          className="w-full h-1.5 rounded-full bg-muted appearance-none cursor-pointer accent-primary"
        />
        <div className="flex justify-between mt-0.5">
          <span className="text-meta text-muted-foreground/70">{t("stt:groq.batch.min")}</span>
          <span className="text-meta text-muted-foreground/70">{t("stt:groq.batch.max")}</span>
        </div>
        <p className="mt-1 text-meta text-muted-foreground/60">
          {t("stt:groq.batch.hint")}
        </p>
      </div>

      {/* Advanced toggle */}
      <button
        onClick={() => setShowAdvanced(!showAdvanced)}
        aria-expanded={showAdvanced}
        className="flex w-full items-center justify-between px-5 py-2.5 text-xs text-muted-foreground hover:bg-accent/30 transition-colors"
      >
        <span className="font-medium">{t("stt:advancedSettings")}</span>
        {showAdvanced ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </button>

      {showAdvanced && (
        <div className="border-t border-border/20">
          {/* Temperature */}
          <div className="px-5 py-3 border-b border-border/20">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium text-foreground">{t("stt:groq.temperature.label")}</span>
                <code className="text-meta text-muted-foreground/70">temperature={groqConfig.temperature}</code>
              </div>
              <span className="text-meta font-mono text-primary tabular-nums">{groqConfig.temperature.toFixed(1)}</span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.1}
              value={groqConfig.temperature}
              onChange={(e) => updateField("temperature", parseFloat(e.target.value))}
              aria-label={t("stt:groq.temperature.label")}
              className="w-full h-1.5 rounded-full bg-muted appearance-none cursor-pointer accent-primary"
            />
            <div className="flex justify-between mt-0.5">
              <span className="text-meta text-muted-foreground/70">{t("stt:groq.temperature.min")}</span>
              <span className="text-meta text-muted-foreground/70">{t("stt:groq.temperature.max")}</span>
            </div>
            <p className="mt-1 text-meta text-muted-foreground/60">
              {t("stt:groq.temperature.hint")}
            </p>
          </div>

          {/* Response Format */}
          <div className="px-5 py-3 border-b border-border/20">
            <div className="flex items-center gap-1.5 mb-2">
              <span className="text-xs font-medium text-foreground">{t("stt:groq.responseFormat.label")}</span>
              <code className="text-meta text-muted-foreground/70">response_format={groqConfig.response_format}</code>
            </div>
            <div className="flex gap-1.5">
              {(["json", "verbose_json", "text"] as const).map((fmt) => (
                <button
                  key={fmt}
                  onClick={() => {
                    updateField("response_format", fmt);
                    // Clear granularities when switching away from verbose_json
                    if (fmt !== "verbose_json") {
                      updateField("timestamp_granularities", []);
                    }
                  }}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-all ${
                    groqConfig.response_format === fmt
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border/40 bg-card/50 text-muted-foreground hover:border-border/70 hover:text-foreground"
                  }`}
                >
                  {fmt === "json" ? "JSON" : fmt === "verbose_json" ? "Verbose JSON" : t("stt:groq.responseFormat.text")}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-meta text-muted-foreground/60">
              {formatHint}
            </p>
          </div>

          {/* Timestamp Granularities — only for verbose_json */}
          {groqConfig.response_format === "verbose_json" && (
            <div className="px-5 py-3 border-b border-border/20">
              <span className="text-xs font-medium text-foreground mb-2 block">{t("stt:groq.timestamps.label")}</span>
              <div className="space-y-2">
                {(["segment", "word"] as const).map((gran) => (
                  <DeepgramToggle
                    key={gran}
                    label={gran === "segment" ? t("stt:groq.timestamps.segment.label") : t("stt:groq.timestamps.word.label")}
                    param={`timestamp_granularities[]=${gran}`}
                    description={gran === "segment"
                      ? t("stt:groq.timestamps.segment.description")
                      : t("stt:groq.timestamps.word.description")}
                    checked={groqConfig.timestamp_granularities.includes(gran)}
                    onChange={(v) => {
                      const current = groqConfig.timestamp_granularities;
                      const updated = v
                        ? [...current, gran]
                        : current.filter((g) => g !== gran);
                      updateField("timestamp_granularities", updated);
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Prompt */}
          <div className="px-5 py-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-foreground">{t("stt:groq.prompt.label")}</span>
              <code className="text-meta text-muted-foreground/60">prompt</code>
            </div>
            <p className="mb-2 text-meta text-muted-foreground/70">
              {t("stt:groq.prompt.hint")}
            </p>
            <textarea
              value={groqConfig.prompt}
              onChange={(e) => updateField("prompt", e.target.value)}
              placeholder={t("stt:groq.prompt.placeholder")}
              aria-label={t("stt:groq.prompt.label")}
              rows={2}
              className="w-full rounded-lg border border-border/50 bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20 resize-none"
            />
            {groqConfig.prompt && (
              <p className="mt-1 text-meta text-muted-foreground/70">
                {t("stt:groq.prompt.tokens", { count: Math.ceil(groqConfig.prompt.length / 4) })}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Dual-Pass Settings ──

function DualPassSettings() {
  const { t } = useT(["stt", "common"]);
  const dualPass = useConfigStore((s) => s.whisperDualPass);
  const setDualPass = useConfigStore((s) => s.setWhisperDualPass);
  const useGpu = useConfigStore((s) => s.whisperUseGpu);
  const setUseGpu = useConfigStore((s) => s.setWhisperUseGpu);

  const update = (key: keyof typeof dualPass, value: number) => {
    setDualPass({ ...dualPass, [key]: value });
  };

  return (
    <div className="rounded-xl border border-border/30 bg-card/50 p-5">
      <h3 className="mb-1 text-sm font-semibold text-primary/80">
        {t("stt:dualPass.title")}
      </h3>
      <p className="mb-4 text-meta text-muted-foreground">
        {t("stt:dualPass.hint")}
      </p>

      <div className="space-y-4">
        <SliderSetting
          label={t("stt:dualPass.fastPass.label")}
          value={dualPass.shortChunkSecs}
          min={0.5}
          max={3.0}
          step={0.1}
          unit="s"
          hint={t("stt:dualPass.fastPass.hint")}
          onChange={(v) => update("shortChunkSecs", v)}
        />
        <SliderSetting
          label={t("stt:dualPass.correction.label")}
          value={dualPass.longChunkSecs}
          min={2.0}
          max={8.0}
          step={0.5}
          unit="s"
          hint={t("stt:dualPass.correction.hint")}
          onChange={(v) => update("longChunkSecs", v)}
        />
        <SliderSetting
          label={t("stt:dualPass.pause.label")}
          value={dualPass.pauseSecs}
          min={0.5}
          max={3.0}
          step={0.1}
          unit="s"
          hint={t("stt:dualPass.pause.hint")}
          onChange={(v) => update("pauseSecs", v)}
        />
      </div>

      <div className="mt-5 flex items-start justify-between gap-3 border-t border-border/20 pt-4">
        <div className="min-w-0">
          <p className="text-xs font-medium text-foreground">{t("stt:dualPass.gpu.label")}</p>
          <p className="mt-0.5 text-meta text-muted-foreground/70">{t("stt:dualPass.gpu.hint")}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={useGpu}
          aria-label={t("stt:dualPass.gpu.label")}
          onClick={() => setUseGpu(!useGpu)}
          className={`relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-all duration-200 ${
            useGpu ? "bg-primary shadow-[0_0_0_3px_hsl(var(--primary)/0.12)]" : "bg-muted"
          }`}
        >
          <span
            className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-all duration-200 ${
              useGpu ? "translate-x-4 scale-105" : "translate-x-0"
            }`}
          />
        </button>
      </div>
    </div>
  );
}

function SliderSetting({
  label,
  value,
  min,
  max,
  step,
  unit,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  hint: string;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-xs text-foreground">{label}</label>
        <span className="text-xs font-mono text-primary tabular-nums">
          {value.toFixed(1)}{unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        aria-label={label}
        className="w-full h-1.5 rounded-full bg-muted appearance-none cursor-pointer accent-primary"
      />
      <p className="mt-0.5 text-meta text-muted-foreground/60">{hint}</p>
    </div>
  );
}
