// Unified "Meeting Audio" settings tab — per-party device + STT configuration.
// Two-panel layout: YOU (left) | THEM (right), with monitor + sessions below.
// Engines, their availability and the Web Speech / Windows Speech exclusion
// come from lib/stt/providerMeta (through ./stt/sttEngines).

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { Trans, currentUiLanguage, useT } from "../i18n";
import { useConfigStore } from "../stores/configStore";
import {
  listAudioDevices,
  setRecordingEnabled,
  getAudioSessions,
  startDeviceMonitor,
  stopDeviceMonitor,
  type DevicePeakLevel,
} from "../lib/ipc";
import { showToast } from "../stores/toastStore";
import type {
  AudioDevice,
  AudioDeviceList,
  AudioSessionInfo,
  MeetingAudioConfig,
  NativeTranslationConfig,
  PartyAudioConfig,
  STTProviderType,
} from "../lib/types";
import {
  Mic,
  Volume2,
  RefreshCw,
  HardDrive,
  Cloud,
  ChevronDown,
  CheckCircle,
  AlertTriangle,
  Info,
  Download,
  X,
} from "lucide-react";
import { BUILT_IN_PRESETS, type MeetingPreset, applyPreset } from "./presets";
import { currentPlatform } from "../lib/platform";
import {
  isExclusiveProvider,
  isSttProviderAvailable,
  localModelIdOnSwitch,
  sttProviderMeta,
  sttProvidersFor,
  type SttProviderMeta,
} from "../lib/stt/providerMeta";
import { LanguageCombobox } from "../components/LanguageCombobox";
import { TRANSLATION_COMMON, baseLanguage } from "../lib/languages";
import { LocalModelManager } from "./LocalModelManager";
import { PartyLanguageField } from "./stt/PartyLanguageField";
import {
  SttEngineIcon,
  assignPartyEngine,
  availabilityContext,
  defaultMeetingAudioConfig,
  exclusiveFallback,
  otherParty,
  partyLabel,
  presetDescription,
  presetName,
  presetRequirements,
  sttEngineLabel,
  unavailableReason,
  useSttReadiness,
  type Party,
  type SttReadiness,
} from "./stt/sttEngines";

// ── Party color config — must use full Tailwind class strings (no interpolation) ──
const PARTY_CONFIG = {
  you: {
    iconColor: "text-sky-400",
    iconBg: "bg-sky-500/10",
    border: "border-sky-500/20",
    headerGrad: "from-sky-500/10",
    dot: "bg-sky-400",
    ping: "bg-sky-400",
  },
  them: {
    iconColor: "text-amber-400",
    iconBg: "bg-amber-500/10",
    border: "border-amber-500/20",
    headerGrad: "from-amber-500/10",
    dot: "bg-amber-400",
    ping: "bg-amber-400",
  },
} as const;

/** Engines whose diarization the in-person toggle below drives. */
const DIARIZATION_ENGINES: readonly STTProviderType[] = ["deepgram", "azure_speech"];

interface DeviceOption {
  device: AudioDevice;
  kind: "input" | "output";
}

/** "Deepgram & Azure" / "Deepgram和Azure". */
function formatList(items: string[]): string {
  try {
    return new Intl.ListFormat(currentUiLanguage(), { style: "short", type: "conjunction" }).format(items);
  } catch {
    return items.join(", ");
  }
}

export function MeetingAudioSettings() {
  const { t } = useT(["stt", "common"]);
  const {
    meetingAudioConfig,
    setMeetingAudioConfig,
    micDeviceId,
    systemDeviceId,
    recordingEnabled,
  } = useConfigStore();
  const diarizationEnabled = useConfigStore((s) => s.diarizationEnabled);
  const setDiarizationEnabled = useConfigStore((s) => s.setDiarizationEnabled);
  const echoCancellation = useConfigStore((s) => s.echoCancellation);
  const setEchoCancellation = useConfigStore((s) => s.setEchoCancellation);
  // Remote Whisper can be picked once its server address is set.
  const hasBaseUrl = useConfigStore((s) => s.openaiCompatSttConfig.base_url.trim() !== "");

  const [devices, setDevices] = useState<AudioDeviceList>({
    inputs: [],
    outputs: [],
  });
  const [loadingDevices, setLoadingDevices] = useState(true);
  const [sessions, setSessions] = useState<AudioSessionInfo[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const readiness = useSttReadiness();
  // This platform's engines (Windows Speech only on Windows), in picker order.
  const offered = useMemo(() => sttProvidersFor(currentPlatform()), []);

  const [deviceLevels, setDeviceLevels] = useState<Record<string, number>>({});
  const [devicePeaks, setDevicePeaks] = useState<Record<string, number>>({});

  const config: MeetingAudioConfig =
    meetingAudioConfig ?? defaultMeetingAudioConfig({ micDeviceId, systemDeviceId, recordingEnabled });

  useEffect(() => {
    if (!meetingAudioConfig) {
      setMeetingAudioConfig(config);
    }
  }, []);

  useEffect(() => {
    loadDevices();
    loadSessions();
  }, []);

  // Device monitor: runs for the entire component lifetime, independent of recording state.
  // During recording, audio_level events supplement this with selected-source PCM levels.
  useEffect(() => {
    startDeviceMonitor().catch(() => {});

    const unlistenPromise = listen<DevicePeakLevel[]>("device_levels", (event) => {
      setDeviceLevels((prev) => {
        const next = { ...prev };
        for (const { device_id, level } of event.payload) {
          next[device_id] = level;
        }
        return next;
      });
      // Track peak per device with slow decay (used for peak markers on bars)
      setDevicePeaks((prev) => {
        const next = { ...prev };
        for (const { device_id, level } of event.payload) {
          const cur = next[device_id] ?? 0;
          next[device_id] = level > cur ? level : cur * 0.95;
        }
        return next;
      });
    });

    return () => {
      stopDeviceMonitor().catch(() => {});
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  async function loadDevices() {
    setLoadingDevices(true);
    try {
      const deviceList = await listAudioDevices();
      setDevices(deviceList);
    } catch (err) {
      console.error("Failed to load audio devices:", err);
    } finally {
      setLoadingDevices(false);
    }
  }

  async function loadSessions() {
    setLoadingSessions(true);
    try {
      const s = await getAudioSessions();
      setSessions(s);
    } catch (err) {
      console.error("Failed to load audio sessions:", err);
    } finally {
      setLoadingSessions(false);
    }
  }

  /**
   * Changes one party (from the latest stored config, so two changes in one
   * tick don't overwrite each other). Anything but the language takes the
   * config off its preset.
   */
  const updateParty = useCallback(
    (party: Party, updates: Partial<PartyAudioConfig>, keepPreset = false) => {
      const current = useConfigStore.getState().meetingAudioConfig ?? config;
      const newConfig: MeetingAudioConfig = {
        ...current,
        [party]: { ...current[party], ...updates },
        preset_name: keepPreset ? current.preset_name : null,
      };
      setMeetingAudioConfig(newConfig);
    },
    [config, setMeetingAudioConfig]
  );

  async function handleRecordingToggle(enabled: boolean) {
    const newConfig = { ...config, recording_enabled: enabled };
    setMeetingAudioConfig(newConfig);
    try {
      await setRecordingEnabled(enabled);
      showToast(
        enabled ? t("stt:meetingAudio.recording.enabled") : t("stt:meetingAudio.recording.disabled"),
        "success"
      );
    } catch (err) {
      console.error("Failed to set recording:", err);
      showToast(t("stt:meetingAudio.recording.toggleFailed"), "error");
    }
  }

  function handlePresetSelect(preset: MeetingPreset) {
    const allDevices = [...devices.inputs, ...devices.outputs];
    // Keeps each party's language and translation target.
    const resolved = applyPreset(preset, allDevices, config);
    setMeetingAudioConfig(resolved);
    const missing = presetRequirements(preset, readiness, hasBaseUrl);
    showToast(
      missing.length
        ? t("stt:meetingAudio.presets.appliedIncomplete", { name: presetName(preset), requirements: missing.join(" · ") })
        : t("stt:meetingAudio.presets.applied", { name: presetName(preset) }),
      missing.length ? "warning" : "success",
    );
  }

  const allDevices: DeviceOption[] = [
    ...devices.inputs.map((d) => ({ device: d, kind: "input" as const })),
    ...devices.outputs.map((d) => ({ device: d, kind: "output" as const })),
  ];

  const diarizationEngines = DIARIZATION_ENGINES.filter(
    (p) => config.you.stt_provider === p || config.them.stt_provider === p
  );

  return (
    <div className="flex flex-col gap-4">

      {/* ── Quick Presets ── */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/20 bg-card/40 px-4 py-2.5">
        <span className="mr-1 shrink-0 text-meta font-semibold uppercase tracking-wider text-muted-foreground/60">
          {t("stt:meetingAudio.presets.label")}
        </span>
        {BUILT_IN_PRESETS.map((preset) => {
          const missing = presetRequirements(preset, readiness, hasBaseUrl);
          return (
            <button
              key={preset.id}
              onClick={() => handlePresetSelect(preset)}
              aria-label={presetName(preset)}
              aria-describedby={missing.length ? `preset-${preset.id}-requirements` : undefined}
              title={[presetDescription(preset), ...missing].join("\n")}
              className={`cursor-pointer rounded-lg border px-3 py-1 text-xs font-medium transition-all duration-150 active:scale-95 ${
                config.preset_name === preset.name
                  ? "border-primary/50 bg-primary/10 text-primary shadow-sm shadow-primary/10"
                  : "border-border/30 text-muted-foreground/70 hover:border-border/60 hover:bg-accent/40 hover:text-foreground"
              }`}
            >
              {presetName(preset)}
              {missing.length > 0 && (
                <span id={`preset-${preset.id}-requirements`} className="mt-0.5 block max-w-56 text-meta font-normal text-warning">
                  {missing.join(" · ")}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Main two-panel: YOU | THEM ── */}
      <div className="grid grid-cols-2 gap-4">
        <PartyPanel
          label={t("common:labels.you")}
          description={t("stt:meetingAudio.party.you.description")}
          badge={t("stt:meetingAudio.party.you.badge")}
          role="you"
          icon={<Mic className="h-4 w-4" />}
          party={config.you}
          level={deviceLevels[config.you.device_id] ?? 0}
          peak={devicePeaks[config.you.device_id] ?? 0}
          allDevices={allDevices}
          loadingDevices={loadingDevices}
          offered={offered}
          readiness={readiness}
          hasBaseUrl={hasBaseUrl}
          otherPartyProvider={config.them.stt_provider}
          onChange={(updates, keepPreset) => updateParty("you", updates, keepPreset)}
        />
        <PartyPanel
          label={t("common:labels.them")}
          labelSuffix={
            <span className="text-xs font-semibold uppercase tracking-wide text-purple-400">
              /&nbsp;{t("common:labels.room")}
            </span>
          }
          description={t("stt:meetingAudio.party.them.description")}
          role="them"
          icon={<Volume2 className="h-4 w-4" />}
          party={config.them}
          level={deviceLevels[config.them.device_id] ?? 0}
          peak={devicePeaks[config.them.device_id] ?? 0}
          allDevices={allDevices}
          loadingDevices={loadingDevices}
          offered={offered}
          readiness={readiness}
          hasBaseUrl={hasBaseUrl}
          otherPartyProvider={config.you.stt_provider}
          onChange={(updates, keepPreset) => updateParty("them", updates, keepPreset)}
        />
      </div>

      {/* ── Diarization Toggle — only shown when Deepgram or Azure is active ── */}
      {diarizationEngines.length > 0 && (
        <div className="flex items-center justify-between rounded-xl border border-border/20 bg-card/40 px-4 py-3">
          <div>
            <p className="text-xs font-medium text-foreground">{t("stt:meetingAudio.diarization.label")}</p>
            <p className="mt-0.5 text-meta text-muted-foreground/70">
              {t("stt:meetingAudio.diarization.hint", {
                engines: formatList(diarizationEngines.map((id) => sttProviderMeta(id)?.label ?? id)),
              })}
            </p>
          </div>
          <ToggleSwitch
            checked={diarizationEnabled}
            onChange={setDiarizationEnabled}
            label={t("stt:meetingAudio.diarization.ariaLabel")}
          />
        </div>
      )}

      {/* ── Recording Toggle (full-width row) ── */}
      <div className="flex items-center justify-between rounded-xl border border-border/20 bg-card/40 px-4 py-3">
        <div>
          <p className="text-xs font-medium text-foreground">{t("stt:meetingAudio.recording.label")}</p>
          <p className="mt-0.5 text-meta text-muted-foreground/70">{t("stt:meetingAudio.recording.hint")}</p>
        </div>
        <ToggleSwitch
          checked={config.recording_enabled}
          onChange={(enabled) => handleRecordingToggle(enabled)}
          label={t("stt:meetingAudio.recording.ariaLabel")}
        />
      </div>

      {/* ── Echo Cancellation — needs the other side's output as the reference ── */}
      {!config.them.is_input_device && (
        <div className="flex items-center justify-between rounded-xl border border-border/20 bg-card/40 px-4 py-3">
          <div>
            <p className="text-xs font-medium text-foreground">{t("stt:meetingAudio.echoCancellation.label")}</p>
            <p className="mt-0.5 text-meta text-muted-foreground/70">{t("stt:meetingAudio.echoCancellation.hint")}</p>
          </div>
          <ToggleSwitch
            checked={echoCancellation}
            onChange={setEchoCancellation}
            label={t("stt:meetingAudio.echoCancellation.ariaLabel")}
          />
        </div>
      )}

      {/* ── Bottom row: Live Monitor | Audio Sessions ── */}
      <div className="grid grid-cols-2 gap-4">

        {/* Live Audio Monitor */}
        <div className="flex flex-col rounded-xl border border-border/20 bg-card/40 p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-foreground">{t("stt:meetingAudio.monitor.title")}</span>
              <div
                className="h-1.5 w-1.5 rounded-full bg-success animate-pulse"
                title={t("stt:meetingAudio.monitor.monitoringAll")}
              />
            </div>
            <button
              onClick={loadDevices}
              disabled={loadingDevices}
              aria-label={t("stt:meetingAudio.monitor.refresh")}
              title={t("stt:meetingAudio.monitor.refresh")}
              className="cursor-pointer rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-foreground"
            >
              <RefreshCw className={`h-3 w-3 ${loadingDevices ? "animate-spin" : ""}`} />
            </button>
          </div>
          <div className="space-y-1.5">
            {devices.inputs.map((d) => (
              <DeviceLevelRow
                key={d.id}
                name={d.name}
                icon={<Mic className="h-3 w-3" />}
                level={deviceLevels[d.id] ?? 0}
                peak={devicePeaks[d.id] ?? 0}
                isSelected={d.id === config.you.device_id || d.id === config.them.device_id}
              />
            ))}
            {devices.outputs.map((d) => (
              <DeviceLevelRow
                key={d.id}
                name={d.name}
                icon={<Volume2 className="h-3 w-3" />}
                level={deviceLevels[d.id] ?? 0}
                peak={devicePeaks[d.id] ?? 0}
                isSelected={d.id === config.you.device_id || d.id === config.them.device_id}
              />
            ))}
          </div>
          <p className="mt-2 shrink-0 text-meta text-muted-foreground/60">
            {t("stt:meetingAudio.monitor.streamingAll")}
          </p>
        </div>

        {/* Right column: Audio Sessions */}
        <div className="flex flex-col">

          {/* Audio Sessions */}
          <div className="flex flex-col rounded-xl border border-border/20 bg-card/40 p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs font-semibold text-foreground">{t("stt:meetingAudio.sessions.title")}</span>
              <button
                onClick={loadSessions}
                disabled={loadingSessions}
                aria-label={t("stt:meetingAudio.sessions.refresh")}
                title={t("stt:meetingAudio.sessions.refresh")}
                className="cursor-pointer rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-foreground"
              >
                <RefreshCw className={`h-3 w-3 ${loadingSessions ? "animate-spin" : ""}`} />
              </button>
            </div>
            {sessions.length === 0 ? (
              <p className="text-xs text-muted-foreground/70">
                {loadingSessions ? t("stt:meetingAudio.sessions.scanning") : t("stt:meetingAudio.sessions.empty")}
              </p>
            ) : (
              <div className="space-y-1">
                {sessions.map((s, idx) => {
                  const matchingDevice = devices.outputs.find((d) => d.name === s.device_name);
                  const isSelectedDevice = matchingDevice
                    ? matchingDevice.id === config.them.device_id
                    : false;
                  return (
                    <div
                      key={`${s.pid}-${s.device_name}-${idx}`}
                      className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 transition-colors ${
                        isSelectedDevice ? "bg-primary/5 border border-primary/20" : "hover:bg-accent/30"
                      }`}
                    >
                      <div className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.is_active ? "bg-success" : "bg-muted-foreground/30"}`} />
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                        {s.display_name}
                      </span>
                      <button
                        onClick={() => {
                          if (matchingDevice) {
                            updateParty("them", {
                              device_id: matchingDevice.id,
                              is_input_device: false,
                            });
                            showToast(
                              t("stt:meetingAudio.sessions.sourceSet", {
                                party: t("common:labels.them"),
                                device: matchingDevice.name,
                              }),
                              "success"
                            );
                          } else {
                            showToast(t("stt:meetingAudio.sessions.noMatchingDevice"), "error");
                          }
                        }}
                        disabled={isSelectedDevice}
                        className={`shrink-0 cursor-pointer rounded px-2 py-0.5 text-meta font-medium transition-all ${
                          isSelectedDevice
                            ? "bg-primary/10 text-primary cursor-default"
                            : "bg-accent text-foreground hover:bg-primary/10 hover:text-primary"
                        }`}
                      >
                        {isSelectedDevice ? t("stt:meetingAudio.sessions.active") : t("stt:meetingAudio.sessions.use")}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Info Callout ── */}
      <div className="flex items-start gap-3 rounded-xl border border-border/20 bg-card/40 px-4 py-3">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
        <p className="text-xs text-muted-foreground/70">
          <Trans
            t={t}
            i18nKey="stt:meetingAudio.info"
            components={{
              strong: <span className="font-medium text-foreground" />,
              online: <span className="text-sky-400 font-medium" />,
              onsite: <span className="text-purple-400 font-medium" />,
            }}
          />
        </p>
      </div>
    </div>
  );
}

// ── Toggle switch ──

function ToggleSwitch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Accessible name. */
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-all duration-200 ${
        checked ? "bg-primary shadow-[0_0_0_3px_hsl(var(--primary)/0.12)]" : "bg-muted"
      }`}
    >
      <span
        className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-all duration-200 ${
          checked ? "translate-x-4 scale-105" : "translate-x-0"
        }`}
      />
    </button>
  );
}

// ── Party Panel Component ──

function PartyPanel({
  label,
  labelSuffix,
  description,
  badge,
  role,
  icon,
  party,
  level,
  peak,
  allDevices,
  loadingDevices,
  offered,
  readiness,
  hasBaseUrl,
  otherPartyProvider,
  onChange,
}: {
  label: string;
  labelSuffix?: React.ReactNode;
  description?: string;
  badge?: string;
  role: Party;
  icon: React.ReactNode;
  party: PartyAudioConfig;
  level: number;
  peak: number;
  allDevices: DeviceOption[];
  loadingDevices: boolean;
  offered: readonly SttProviderMeta[];
  readiness: SttReadiness;
  hasBaseUrl: boolean;
  otherPartyProvider: STTProviderType | null;
  /** `keepPreset`: the change doesn't take the config off its preset (language). */
  onChange: (updates: Partial<PartyAudioConfig>, keepPreset?: boolean) => void;
}) {
  const { t } = useT(["stt", "common", "settings"]);
  const c = PARTY_CONFIG[role];
  const inputDevices = allDevices.filter((d) => d.kind === "input");
  const outputDevices = allDevices.filter((d) => d.kind === "output");
  const [showModels, setShowModels] = useState(false);

  // Amplify then sqrt for perceptual sensitivity — 2.5× gain makes typical peaks fill the bar
  const amplified = Math.min(level * 2.5, 1);
  const scaledLv = Math.sqrt(amplified);
  const isActive = level > 0.005;
  const barWidth = isActive ? Math.min(100, Math.round(scaledLv * 100)) : 0;

  const engine = sttEngineLabel(party.stt_provider);
  const meta = sttProviderMeta(party.stt_provider);
  const isOffered = offered.some((o) => o.id === party.stt_provider);
  const notReady = meta
    ? unavailableReason(meta, availabilityContext(readiness, party.is_input_device, hasBaseUrl))
    : null;
  const languageId = `meeting-audio-${role}-language`;

  function handleDeviceChange(value: string) {
    const [isInput, deviceId]: [boolean, string] = JSON.parse(value);
    onChange({ device_id: deviceId, is_input_device: isInput });
  }

  function handleProviderChange(newProvider: STTProviderType) {
    const { activeModelPerEngine, activeWhisperModel } = useConfigStore.getState();
    // The engine's model (none for engines without one): no cross-engine model ids.
    const updates: Partial<PartyAudioConfig> = {
      stt_provider: newProvider,
      local_model_id: localModelIdOnSwitch(newProvider, activeModelPerEngine, activeWhisperModel),
    };
    // Dev log: provider change
    import("../stores/devLogStore").then(({ useDevLogStore }) => {
      useDevLogStore.getState().addEntry(
        "info", "config",
        `[${party.role === "You" ? "You" : "Them"}] Provider → ${newProvider}` +
        (updates.local_model_id ? ` (model: ${updates.local_model_id})` : "")
      );
    });
    setShowModels(false);
    onChange(updates);
  }

  return (
    <div className={`flex flex-col rounded-xl border bg-card/40 ${c.border}`}>

      {/* ── Header ── */}
      <div className={`flex items-center gap-3 rounded-t-xl bg-gradient-to-r ${c.headerGrad} to-transparent border-b border-border/20 px-4 py-3`}>
        <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${c.iconBg}`}>
          <span className={c.iconColor}>{icon}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className={`text-xs font-semibold uppercase tracking-wide ${c.iconColor}`}>{label}</p>
            {labelSuffix}
          </div>
          <p className="mt-0.5 text-meta text-muted-foreground/60">
            {description ?? t("stt:meetingAudio.party.defaultDescription")}
          </p>
          {badge && (
            <span className="mt-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-medium bg-sky-500/10 text-sky-400 border border-sky-500/20">
              {badge}
            </span>
          )}
        </div>
        {/* Live activity indicator */}
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="relative flex h-2 w-2">
            {isActive && (
              <span className={`absolute inline-flex h-full w-full animate-pulse rounded-full ${c.ping} opacity-40`} />
            )}
            <span className={`relative inline-flex h-2 w-2 rounded-full transition-colors duration-150 ${isActive ? c.dot : "bg-muted-foreground/20"}`} />
          </span>
          <span className="w-7 text-right text-meta tabular-nums font-medium text-muted-foreground/60">
            {barWidth}%
          </span>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="flex flex-col gap-4 p-4">

        {/* Source device */}
        <div>
          <label className="mb-1.5 block text-meta font-semibold uppercase tracking-wider text-muted-foreground/60">
            {t("stt:meetingAudio.source.label")}
          </label>
          <select
            value={JSON.stringify([party.is_input_device, party.device_id])}
            onChange={(e) => handleDeviceChange(e.target.value)}
            disabled={loadingDevices}
            className="w-full cursor-pointer rounded-lg border border-border/40 bg-background/60 px-3 py-2 text-xs text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
          >
            <option value={JSON.stringify([role === "you", "default"])}>
              {loadingDevices ? t("common:status.loading") : t("stt:meetingAudio.source.default")}
            </option>
            {inputDevices.length > 0 && (
              <optgroup label={t("stt:meetingAudio.source.microphones")}>
                {inputDevices.map((d) => (
                  <option key={d.device.id} value={JSON.stringify([d.device.is_input, d.device.id])}>
                    {d.device.is_default ? t("stt:meetingAudio.source.defaultDevice", { name: d.device.name }) : d.device.name}
                  </option>
                ))}
              </optgroup>
            )}
            {outputDevices.length > 0 && (
              <optgroup label={t("stt:meetingAudio.source.outputs")}>
                {outputDevices.map((d) => (
                  <option key={d.device.id} value={JSON.stringify([d.device.is_input, d.device.id])}>
                    {d.device.is_default ? t("stt:meetingAudio.source.defaultDevice", { name: d.device.name }) : d.device.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>

        {/* Level bar — gradient zones */}
        <div className="relative h-3 overflow-hidden rounded-full bg-muted/20">
          <div
            className="absolute inset-y-0 left-0 rounded-full audio-level-gradient audio-bar-spring"
            style={{ width: `${scaledLv * 100}%` }}
          />
          {peak > 0.005 && (
            <div
              className="absolute inset-y-0 w-[2px] rounded-full bg-foreground/50 transition-all duration-150"
              style={{ left: `${Math.sqrt(Math.min(peak * 2.5, 1)) * 100}%` }}
            />
          )}
        </div>

        {/* STT Provider */}
        <div>
          <label className="mb-1.5 block text-meta font-semibold uppercase tracking-wider text-muted-foreground/60">
            {t("stt:meetingAudio.engine.label")}
          </label>
          <ProviderSelect
            role={role}
            value={party.stt_provider}
            isInput={party.is_input_device}
            offered={offered}
            readiness={readiness}
            hasBaseUrl={hasBaseUrl}
            otherPartyProvider={otherPartyProvider}
            onChange={handleProviderChange}
          />
        </div>

        {/* The party's engine can't run as set up */}
        {(!isOffered || notReady) && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
              <p className="text-meta leading-relaxed text-amber-200/80">
                {!isOffered
                  ? t("stt:meetingAudio.notReady.notOffered", { engine })
                  : notReady === "needsModel"
                    ? t("stt:meetingAudio.notReady.needsModel", { engine })
                    : notReady === "needsBaseUrl"
                      ? t("stt:meetingAudio.notReady.needsBaseUrl", { engine, tab: t("settings:tabs.stt") })
                      : notReady === "needsKey"
                        ? t("stt:meetingAudio.notReady.needsKey", { engine, tab: t("settings:tabs.stt") })
                        : t("stt:meetingAudio.notReady.needsInput", { engine })}
              </p>
            </div>
            {isOffered && notReady === "needsModel" && meta?.requiresDownload && (
              <>
                <button
                  type="button"
                  onClick={() => setShowModels((v) => !v)}
                  aria-expanded={showModels}
                  className="mt-2 inline-flex cursor-pointer items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-meta font-semibold text-amber-400 hover:bg-amber-500/20"
                >
                  {showModels ? <X className="h-3 w-3" /> : <Download className="h-3 w-3" />}
                  {showModels ? t("stt:meetingAudio.notReady.hideModels") : t("stt:meetingAudio.notReady.downloadModel")}
                </button>
                {showModels && (
                  <div className="mt-2">
                    <LocalModelManager engineFilter={meta.requiresDownload} compact />
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Recognition language */}
        <div>
          <label
            htmlFor={languageId}
            className="mb-1.5 block text-meta font-semibold uppercase tracking-wider text-muted-foreground/60"
          >
            {t("stt:language.label")}
          </label>
          <PartyLanguageField
            id={languageId}
            aria-label={t("stt:language.partyAriaLabel", { party: partyLabel(role) })}
            party={party}
            onChange={(code) => onChange({ language: code }, true)}
          />
        </div>

        {/* Soniox translates in the same stream */}
        {party.stt_provider === "soniox" && (
          <SonioxTranslationField
            role={role}
            value={party.native_translation}
            onChange={(native_translation) => onChange({ native_translation })}
          />
        )}

        {/* Device + Provider mismatch warning */}
        {(party.stt_provider === "web_speech" || party.stt_provider === "windows_native") &&
          party.is_input_device &&
          party.device_id !== "default" && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
            <p className="text-meta leading-relaxed text-amber-200/80">
              <Trans
                t={t}
                i18nKey="stt:meetingAudio.deviceOverride"
                values={{ engine }}
                components={{ strong: <span className="font-semibold text-amber-400" /> }}
              />
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Soniox native translation ──

type NativeTranslationMode = NativeTranslationConfig["mode"];

const NATIVE_TRANSLATION_MODES: readonly NativeTranslationMode[] = ["off", "one_way", "two_way"];

const TRANSLATION_FIELD_LABEL = "mb-1.5 block text-meta font-semibold uppercase tracking-wider text-muted-foreground/60";

/**
 * Why a two-way pair can't run yet, or null. Soniox needs two different
 * languages with two-letter codes (the backend turns translation off otherwise).
 */
export function sonioxPairProblem(a: string, b: string): "incomplete" | "unsupported" | "same" | null {
  if (!a.trim() || !b.trim()) return "incomplete";
  const [baseA, baseB] = [baseLanguage(a), baseLanguage(b)];
  if (!/^[a-z]{2}$/.test(baseA) || !/^[a-z]{2}$/.test(baseB)) return "unsupported";
  return baseA === baseB ? "same" : null;
}

/**
 * Soniox's own translation of this party (`native_translation`): off,
 * one-way into a target (empty = the Translation settings' target), or
 * two-way between languages A and B (in-person meetings). Switching keeps
 * the other mode's fields, so switching back finds them again.
 */
function SonioxTranslationField({
  role,
  value,
  onChange,
}: {
  role: Party;
  value: NativeTranslationConfig | undefined;
  onChange: (value: NativeTranslationConfig) => void;
}) {
  const { t } = useT(["stt", "common"]);
  const mode: NativeTranslationMode = value?.mode === "one_way" || value?.mode === "two_way" ? value.mode : "off";
  const target = value?.target_language ?? "";
  const languageA = value?.language_a ?? "";
  const languageB = value?.language_b ?? "";
  const party = partyLabel(role);
  const modeId = `meeting-audio-${role}-translation-mode`;
  const targetId = `meeting-audio-${role}-translation-target`;
  const pairId = `meeting-audio-${role}-translation-pair`;
  const pairProblem = mode === "two_way" ? sonioxPairProblem(languageA, languageB) : null;

  function setMode(next: NativeTranslationMode) {
    onChange({ ...value, mode: next });
  }

  function setPair(side: "language_a" | "language_b", code: string) {
    onChange({ ...value, mode: "two_way", [side]: code });
  }

  function clearTarget() {
    const rest: NativeTranslationConfig = { ...(value ?? { mode: "one_way" }) };
    delete rest.target_language;
    onChange(rest);
  }

  return (
    <div className="rounded-lg border border-border/30 bg-background/30 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <label htmlFor={modeId} className="text-xs font-medium text-foreground">
            {t("stt:meetingAudio.nativeTranslation.label")}
          </label>
          <p className="mt-0.5 text-meta text-muted-foreground/70">{t("stt:meetingAudio.nativeTranslation.hint")}</p>
        </div>
        <select
          id={modeId}
          value={mode}
          onChange={(e) => setMode(e.target.value as NativeTranslationMode)}
          aria-label={t("stt:meetingAudio.nativeTranslation.ariaLabel", { party })}
          className="shrink-0 cursor-pointer rounded-lg border border-border/40 bg-background/60 px-2 py-1.5 text-xs text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
        >
          {NATIVE_TRANSLATION_MODES.map((m) => (
            <option key={m} value={m}>
              {t(`stt:meetingAudio.nativeTranslation.modes.${m}`)}
            </option>
          ))}
        </select>
      </div>
      {mode === "one_way" && (
        <div className="mt-3">
          <label htmlFor={targetId} className={TRANSLATION_FIELD_LABEL}>
            {t("stt:meetingAudio.nativeTranslation.target.label")}
          </label>
          <LanguageCombobox
            id={targetId}
            value={target}
            onChange={(code) => onChange({ ...value, mode: "one_way", target_language: code })}
            common={TRANSLATION_COMMON}
            placeholder={t("stt:meetingAudio.nativeTranslation.target.followPlaceholder")}
          />
          {target ? (
            <button
              type="button"
              onClick={clearTarget}
              className="mt-1.5 cursor-pointer text-meta font-medium text-primary hover:underline"
            >
              {t("stt:meetingAudio.nativeTranslation.target.follow")}
            </button>
          ) : (
            <p className="mt-1.5 text-meta text-muted-foreground/70">
              {t("stt:meetingAudio.nativeTranslation.target.followHint")}
            </p>
          )}
        </div>
      )}
      {mode === "two_way" && (
        <div className="mt-3 space-y-2.5">
          {(["language_a", "language_b"] as const).map((side) => {
            const id = `${pairId}-${side === "language_a" ? "a" : "b"}`;
            const key = side === "language_a" ? "A" : "B";
            return (
              <div key={side}>
                <label htmlFor={id} className={TRANSLATION_FIELD_LABEL}>
                  {t(`stt:meetingAudio.nativeTranslation.pair.language${key}`)}
                </label>
                <LanguageCombobox
                  id={id}
                  value={side === "language_a" ? languageA : languageB}
                  onChange={(code) => setPair(side, code)}
                  common={TRANSLATION_COMMON}
                  placeholder={t("stt:meetingAudio.nativeTranslation.pair.placeholder")}
                  aria-label={t(`stt:meetingAudio.nativeTranslation.pair.ariaLabel${key}`, { party })}
                />
              </div>
            );
          })}
          {pairProblem ? (
            <p role="status" className="flex items-start gap-1.5 text-meta leading-relaxed text-amber-500">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
              <span>{t(`stt:meetingAudio.nativeTranslation.pair.${pairProblem}`)}</span>
            </p>
          ) : (
            <p className="text-meta text-muted-foreground/70">{t("stt:meetingAudio.nativeTranslation.pair.hint")}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Custom STT Provider Dropdown ──

function ProviderSelect({
  role,
  value,
  isInput,
  offered,
  readiness,
  hasBaseUrl,
  otherPartyProvider,
  onChange,
}: {
  role: Party;
  value: STTProviderType;
  isInput: boolean;
  offered: readonly SttProviderMeta[];
  readiness: SttReadiness;
  hasBaseUrl: boolean;
  otherPartyProvider: STTProviderType | null;
  onChange: (val: STTProviderType) => void;
}) {
  const { t } = useT(["stt", "common"]);
  const [open, setOpen] = useState(false);
  const [stealTarget, setStealTarget] = useState<STTProviderType | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const otherLabel = partyLabel(otherParty(role));

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setStealTarget(null);
      }
    }
    if (open) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Unknown status (still loading) counts as available, so a slow check never triggers a fallback.
  const ctx = availabilityContext(readiness, isInput, hasBaseUrl);
  const isAvailable = (opt: SttProviderMeta) => isSttProviderAvailable(opt, ctx);

  function isExclusiveLocked(opt: SttProviderMeta): boolean {
    if (!isExclusiveProvider(opt.id)) return false;
    if (!otherPartyProvider) return false;
    return isExclusiveProvider(otherPartyProvider);
  }

  function findExclusiveFallback(): STTProviderType | null {
    return exclusiveFallback(offered, isAvailable);
  }

  function handleStealConfirm() {
    if (!stealTarget) return;
    const state = useConfigStore.getState();
    const freshConfig = state.meetingAudioConfig;
    if (!freshConfig) return;

    const otherRole = otherParty(role);
    if (!isExclusiveProvider(freshConfig[otherRole].stt_provider)) {
      onChange(stealTarget);
      setStealTarget(null);
      setOpen(false);
      return;
    }

    const assignment = assignPartyEngine(freshConfig, role, stealTarget, state, findExclusiveFallback());
    if (!assignment?.fallback) {
      showToast(t("stt:picker.steal.noFallback"), "error");
      setStealTarget(null);
      return;
    }
    state.setMeetingAudioConfig(assignment.config);
    showToast(
      t("stt:picker.steal.moved", {
        engine: sttEngineLabel(stealTarget),
        party: partyLabel(role),
        other: partyLabel(otherRole),
        fallback: sttEngineLabel(assignment.fallback.engine),
      }),
      "info"
    );

    setStealTarget(null);
    setOpen(false);
  }

  // Auto-reset to a working provider if the current one is no longer available.
  //
  // IMPORTANT: this must NOT run on the initial load. Availability resolves
  // asynchronously (local engines + API-key status), and reacting to the first
  // resolution would silently overwrite the user's saved provider every time the
  // settings page is opened. So we wait until BOTH lists have been populated once,
  // then only react to later changes.
  const initialAvailabilityLoadedRef = useRef(false);

  useEffect(() => {
    if (!initialAvailabilityLoadedRef.current) {
      if (readiness.localEngines !== null && readiness.keysLoaded) {
        initialAvailabilityLoadedRef.current = true;
      }
      return; // Skip fallback on initial load
    }
    const currentOpt = offered.find((o) => o.id === value);
    if (currentOpt && !isAvailable(currentOpt)) {
      // Never fall back to an exclusive provider (Web Speech / Windows Speech):
      // they capture the OS default mic and can only serve one party at a time.
      const fallback = offered.find(
        (o) => o.id !== value && isAvailable(o) && !isExclusiveProvider(o.id)
      );
      if (fallback) {
        onChange(fallback.id);
      }
    }
  }, [readiness.localEngines, readiness.keys]);

  const localOptions = offered.filter((o) => !o.isCloud && isAvailable(o));
  const cloudOptions = offered.filter((o) => o.isCloud && isAvailable(o));
  const hasAny = localOptions.length > 0 || cloudOptions.length > 0;

  const renderOption = (opt: SttProviderMeta, accent: string) => {
    const locked = isExclusiveLocked(opt);
    return (
      <button
        key={opt.id}
        type="button"
        onClick={() => {
          if (locked) {
            setStealTarget(opt.id);
          } else {
            onChange(opt.id);
            setOpen(false);
          }
        }}
        className={`flex w-full cursor-pointer items-center gap-2.5 px-3 py-2.5 text-xs transition-colors hover:bg-accent ${
          locked ? "opacity-50 hover:opacity-70" : ""
        } ${
          value === opt.id ? "bg-primary/5 text-primary" : "text-foreground"
        }`}
      >
        <span className={`shrink-0 ${value === opt.id ? "text-primary" : accent}`}>
          <SttEngineIcon id={opt.id} className="h-3.5 w-3.5" />
        </span>
        <span className="flex-1 text-left">
          {sttEngineLabel(opt.id)}
          {locked && (
            <span className="block text-meta text-muted-foreground/50">
              {t("stt:picker.inUseBy", { party: otherLabel })}
            </span>
          )}
        </span>
        {value === opt.id && !locked && (
          <CheckCircle className="h-3 w-3 shrink-0 text-primary" />
        )}
      </button>
    );
  };

  const fallbackPreview = stealTarget ? findExclusiveFallback() : null;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="true"
        className={`flex w-full cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors ${
          open
            ? "border-primary bg-background ring-1 ring-primary/20"
            : "border-border/50 bg-background hover:border-border"
        }`}
      >
        <span className="shrink-0 text-muted-foreground">
          <SttEngineIcon id={value} className="h-3.5 w-3.5" />
        </span>
        <span className="flex-1 truncate text-left font-medium">
          {sttEngineLabel(value)}
        </span>
        <ChevronDown className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-xl border border-border/50 bg-popover shadow-xl">
          {localOptions.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 border-b border-border/20 bg-muted/30 px-3 py-1.5">
                <HardDrive className="h-2.5 w-2.5 text-emerald-500" />
                <span className="text-meta font-semibold uppercase tracking-wider text-muted-foreground">
                  {t("stt:groups.local")}
                </span>
              </div>
              {localOptions.map((opt) => renderOption(opt, "text-emerald-500"))}
            </div>
          )}

          {cloudOptions.length > 0 && (
            <div className={localOptions.length > 0 ? "border-t border-border/20" : ""}>
              <div className="flex items-center gap-1.5 border-b border-border/20 bg-muted/30 px-3 py-1.5">
                <Cloud className="h-2.5 w-2.5 text-blue-500" />
                <span className="text-meta font-semibold uppercase tracking-wider text-muted-foreground">
                  {t("stt:groups.cloud")}
                </span>
              </div>
              {cloudOptions.map((opt) => renderOption(opt, "text-blue-500"))}
            </div>
          )}

          {!hasAny && (
            <p className="px-3 py-3 text-meta text-muted-foreground">
              {t("stt:picker.noneReady")}
            </p>
          )}

          {stealTarget && (
            <div className="border-t border-border/20 bg-amber-500/5 px-3 py-2.5">
              <p className="text-meta leading-relaxed text-amber-200/80 mb-2">
                <Trans
                  t={t}
                  i18nKey="stt:picker.steal.confirm"
                  values={{
                    engine: sttEngineLabel(stealTarget),
                    fallback: fallbackPreview ? sttEngineLabel(fallbackPreview) : t("stt:picker.steal.noEngine"),
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
                  onClick={handleStealConfirm}
                  className="rounded-lg bg-amber-500/20 border border-amber-500/30 px-3 py-1 text-meta font-semibold text-amber-400 hover:bg-amber-500/30 cursor-pointer"
                >
                  {t("stt:picker.steal.switch")}
                </button>
                <button
                  type="button"
                  onClick={() => setStealTarget(null)}
                  className="rounded-lg bg-muted/30 px-3 py-1 text-meta font-medium text-muted-foreground hover:bg-muted/50 cursor-pointer"
                >
                  {t("common:actions.cancel")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Device Level Row ──

function DeviceLevelRow({
  name,
  icon,
  level,
  peak,
  isSelected,
}: {
  name: string;
  icon: React.ReactNode;
  level: number;
  peak: number;
  isSelected?: boolean;
}) {
  const amplified = Math.min(Math.max(level, 0) * 2.5, 1);
  const scaled = Math.sqrt(amplified);

  return (
    <div className="flex items-center gap-2">
      <span className={isSelected ? "text-primary" : "text-muted-foreground/60"}>{icon}</span>
      <span className={`w-28 truncate text-meta ${isSelected ? "font-medium text-foreground" : "text-muted-foreground/60"}`}>
        {name}
      </span>
      <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-muted/20">
        <div
          className="absolute inset-y-0 left-0 rounded-full audio-level-gradient audio-bar-spring"
          style={{ width: `${scaled * 100}%` }}
        />
        {peak > 0.005 && (
          <div
            className="absolute inset-y-0 w-[2px] rounded-full bg-foreground/30 transition-all duration-150"
            style={{ left: `${Math.sqrt(Math.min(peak * 2.5, 1)) * 100}%` }}
          />
        )}
      </div>
      <span className="w-7 text-right text-meta tabular-nums text-muted-foreground/70">
        {level > 0.005 ? `${Math.round(scaled * 100)}%` : "—"}
      </span>
    </div>
  );
}
