// Shared service status bar used in both Dashboard and Meeting Overlay footers.
// Shows LLM, You STT, and Them STT with provider + model, lighting up when active.
// During recording: STT chips are interactive (click to swap provider), with mute toggles.

import { useState, useEffect, useRef, useCallback } from "react";
import {
  Brain, Mic, MicOff, Volume2, VolumeX, Zap, Cpu,
  ChevronUp, CheckCircle, Globe, Monitor, HardDrive, Cloud, ArrowUpCircle,
} from "lucide-react";
import { useConfigStore } from "../stores/configStore";
import { useStreamStore } from "../stores/streamStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useSpeakerStore } from "../stores/speakerStore";
import { useSttRegionStore } from "../stores/sttRegionStore";
import { useAudioLevel } from "../hooks/useAudioLevel";
import { listLocalSTTEngines, getApiKey } from "../lib/ipc";
import { hasSttKeySlot } from "../lib/stt/keys";
import type { STTProviderType, LLMProviderType, LocalSTTEngineInfo } from "../lib/types";
import {
  STT_LABELS, STT_PROVIDER_OPTIONS, EXCLUSIVE_FALLBACK_ORDER, isExclusiveProvider,
  LOCAL_MODEL_ENGINES, resolveLocalModelId, localModelIdOnSwitch, type SttIconKey,
  isSttProviderAvailable, sttKeySlot,
} from "../lib/stt/providerMeta";
import { showToast } from "../stores/toastStore";
import { useUpdaterStore } from "../stores/updaterStore";
import { useAgentStore } from "../stores/agentStore";
import { AgentStatusChip } from "./AgentStatusChip";
import { StreamLatency } from "./StreamLatency";
import { claudeTierLabel } from "../settings/ClaudeCliSettings";
import { sonioxRegionName } from "../settings/stt/sonioxRegions";
import { restartToUpdate } from "../hooks/useUpdater";
import { Trans, useT } from "../i18n";
import { useLlmConfig } from "../stores/llmConnectionsStore";
import { LlmQuickPicker } from "./llm/LlmQuickPicker";
import { effectiveRoute } from "../lib/llm/tasks";

// ── Human-friendly provider labels (product names; only "Custom" is translated) ──
const LLM_LABELS: Record<string, string> = {
  ollama: "Ollama",
  lm_studio: "LM Studio",
  openai: "OpenAI",
  anthropic: "Anthropic",
  groq: "Groq",
  gemini: "Gemini",
  openrouter: "OpenRouter",
  claude_cli: "Claude",
};

/** Display name of an LLM provider; `customLabel` is the translated "Custom". */
function llmLabel(provider: string, customLabel: string): string {
  return provider === "custom" ? customLabel : LLM_LABELS[provider] || provider;
}

/** "Provider / model" (just the provider when there is no model), for the chip tooltips. */
function sttEngineText({ provider, model }: { provider: string; model: string }): string {
  return model ? `${provider} / ${model}` : provider;
}

/** A Soniox chip's tooltip text with the region the party is connected to ("Soniox · Japan"). */
function withSonioxRegion(text: string, engine: string, region: string | undefined): string {
  return engine === "soniox" && region ? `${text} · ${sonioxRegionName(region)}` : text;
}

// STT labels, picker options and exclusion rules live in lib/stt/providerMeta.
export { STT_LABELS } from "../lib/stt/providerMeta";

// ── Icons for providerMeta's icon keys (STT quick-swap picker) ──
const STT_ICONS: Record<SttIconKey, React.ComponentType<{ className?: string }>> = {
  globe: Globe,
  monitor: Monitor,
  hardDrive: HardDrive,
  zap: Zap,
  cpu: Cpu,
  cloud: Cloud,
};

// ── LLM provider options for quick-swap (names come from `llmLabel`) ──
const LLM_PROVIDER_OPTIONS: {
  value: LLMProviderType;
  IconComponent: React.ComponentType<{ className?: string }>; // i18n-ignore: a type, not text
  requiresKey: boolean;
  isLocal: boolean;
}[] = [
  { value: "ollama", IconComponent: Monitor, requiresKey: false, isLocal: true },
  { value: "lm_studio", IconComponent: Monitor, requiresKey: false, isLocal: true },
  { value: "openai", IconComponent: Cloud, requiresKey: true, isLocal: false },
  { value: "anthropic", IconComponent: Cloud, requiresKey: true, isLocal: false },
  { value: "groq", IconComponent: Zap, requiresKey: true, isLocal: false },
  { value: "gemini", IconComponent: Cloud, requiresKey: true, isLocal: false },
  { value: "openrouter", IconComponent: Globe, requiresKey: true, isLocal: false },
  { value: "custom", IconComponent: HardDrive, requiresKey: false, isLocal: false },
];

function formatModel(model: string): string {
  if (!model) return "—";
  const afterSlash = model.split("/").pop() || model;
  return afterSlash.split(":")[0] || afterSlash;
}

function formatSttModel(modelId: string): string {
  if (!modelId) return "";
  return modelId
    .replace(/^sherpa-onnx-nemo-/, "")
    .replace(/^sherpa-onnx-/, "")
    .replace(/^parakeet-/, "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "")  // Strip date suffix
    .replace(/-int8$/, "")
    .split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function formatSttLabel(provider: string, localModelId?: string): { provider: string; model: string } {
  const providerLabel = STT_LABELS[provider] || provider;
  if (LOCAL_MODEL_ENGINES.includes(provider as STTProviderType) && localModelId) {
    return { provider: providerLabel, model: formatSttModel(localModelId) };
  }
  return { provider: providerLabel, model: "" };
}

/**
 * Unified service status bar for both Dashboard footer and Meeting overlay footer.
 * Reads directly from Zustand stores so it reacts to settings changes immediately.
 *
 * `compact` — used in the meeting overlay (less padding, tighter spacing)
 *
 * During an active recording, STT chips become interactive:
 * - Click to open an upward dropdown to switch STT provider
 * - Mute toggle button to silence each audio source
 */
export function ServiceStatusBar({ compact = false }: { compact?: boolean }) {
  const { t } = useT(["llm", "common"]);

  // Config (reactive)
  const llmProvider = useConfigStore((s) => s.llmProvider);
  const llmModel = useConfigStore((s) => s.llmModel);
  const meetingAudioConfig = useConfigStore((s) => s.meetingAudioConfig);
  const activeWhisperModel = useConfigStore((s) => s.activeWhisperModel);
  const activeModelPerEngine = useConfigStore((s) => s.activeModelPerEngine);
  const setMeetingAudioConfig = useConfigStore((s) => s.setMeetingAudioConfig);

  // Active state
  const isRecording = useMeetingStore((s) => s.isRecording);
  const audioMode = useMeetingStore((s) => s.audioMode);
  const speakerOrder = useSpeakerStore((s) => s.speakerOrder);
  const sonioxRegions = useSttRegionStore((s) => s.regions);
  const isStreaming = useStreamStore((s) => s.isStreaming);
  const streamProvider = useStreamStore((s) => s.currentProvider);
  const streamModel = useStreamStore((s) => s.currentModel);
  const { micLevel, systemLevel } = useAudioLevel();

  // Mute state (session-only, not persisted)
  const mutedYou = useConfigStore((s) => s.mutedYou);
  const mutedThem = useConfigStore((s) => s.mutedThem);
  const toggleMuteYou = useConfigStore((s) => s.toggleMuteYou);
  const toggleMuteThem = useConfigStore((s) => s.toggleMuteThem);

  // Picker state (LLM or STT)
  const [pickerOpen, setPickerOpen] = useState<"llm" | "you" | "them" | null>(null);
  const activateLLMProvider = useConfigStore((s) => s.activateLLMProvider);

  // ── Derive display values ──
  // While an answer streams, name what serves it (it can be a fallback);
  // otherwise the active provider. The stream store keeps the last stream's
  // provider until the meeting ends, so it must not outlive the stream.
  // With LLM connections, the default connection's own name ("DeepSeek")
  // instead of its old provider type; without them (older backend), as before.
  const { view: llmView } = useLlmConfig();
  const defaultRoute = llmView ? effectiveRoute(llmView, "default") : null;
  const usable = defaultRoute && !defaultRoute.error ? defaultRoute : null;
  const shownProvider = (isStreaming && streamProvider) || usable?.connection_name || llmProvider;
  const shownModel = (isStreaming && streamModel) || (usable ? usable.model ?? "" : llmModel);
  const llmProviderLabel = usable && !isStreaming ? shownProvider : llmLabel(shownProvider, t("common:labels.custom"));
  const llmModelLabel = formatModel(shownModel);
  const claudeIsDefault = usable ? usable.kind === "claude_cli" : llmProvider === "claude_cli";

  const youSttProvider = meetingAudioConfig?.you.stt_provider ?? "web_speech";
  const youLocalModel = resolveLocalModelId(
    youSttProvider, meetingAudioConfig?.you.local_model_id, activeModelPerEngine, activeWhisperModel,
  );
  const youStt = formatSttLabel(youSttProvider, youLocalModel);
  const youActive = isRecording && !mutedYou && micLevel > 0.02;

  const themSttProvider = meetingAudioConfig?.them.stt_provider ?? "—";
  const themLocalModel = resolveLocalModelId(
    themSttProvider, meetingAudioConfig?.them.local_model_id, activeModelPerEngine, activeWhisperModel,
  );
  const themStt = formatSttLabel(themSttProvider, themLocalModel);
  const themActive = isRecording && !mutedThem && systemLevel > 0.02;

  // ── Provider change handler ──
  // Updates meetingAudioConfig; useAudioConfigSync automatically restarts capture.
  const handleProviderChange = useCallback((party: "you" | "them", provider: STTProviderType) => {
    if (!meetingAudioConfig) return;
    const updates: Partial<typeof meetingAudioConfig.you> = { stt_provider: provider };
    const state = useConfigStore.getState();
    const engineModel = localModelIdOnSwitch(provider, state.activeModelPerEngine, state.activeWhisperModel);
    if (engineModel) updates.local_model_id = engineModel;
    setMeetingAudioConfig({
      ...meetingAudioConfig,
      [party]: { ...meetingAudioConfig[party], ...updates },
      preset_name: null,
    });
    setPickerOpen(null);
  }, [meetingAudioConfig, setMeetingAudioConfig]);

  return (
    <div className={`flex flex-wrap items-center gap-2.5 ${compact ? "px-3 py-2" : "px-5 py-2.5"}`}>
      {/* LLM — always interactive */}
      <div className="relative">
        {claudeIsDefault ? (
          <AgentStatusChip
            compact={compact}
            pickerOpen={pickerOpen === "llm"}
            onClick={() => setPickerOpen(pickerOpen === "llm" ? null : "llm")}
          />
        ) : (
          <STTChip
            icon={<Brain className="h-3.5 w-3.5" />}
            provider={llmProviderLabel}
            model={llmModelLabel}
            active={isStreaming}
            color="blue"
            label=""
            muted={false}
            interactive={true}
            pickerOpen={pickerOpen === "llm"}
            onClick={() => setPickerOpen(pickerOpen === "llm" ? null : "llm")}
            tooltip={t("statusBar.llmChip.tooltip", { provider: llmProviderLabel, model: llmModelLabel })}
          />
        )}
        {pickerOpen === "llm" && llmView && (
          <LlmQuickPicker view={llmView} onClose={() => setPickerOpen(null)} />
        )}
        {/* Without LLM connections (older backend): the provider picker. */}
        {pickerOpen === "llm" && !llmView && (
          <LLMPickerDropdown
            currentProvider={llmProvider}
            currentModel={llmModel}
            onApply={async (provider, model) => {
              try {
                await activateLLMProvider(provider as LLMProviderType, { model });
              } catch (e) {
                console.warn("[ServiceStatusBar] Failed to switch LLM:", e);
                showToast(
                  t("statusBar.llmChip.switchFailed", { detail: e instanceof Error ? e.message : String(e) }),
                  "error",
                );
              }
              setPickerOpen(null);
            }}
            onClose={() => setPickerOpen(null)}
          />
        )}
      </div>

      <Divider />

      {audioMode === "in_person" ? (
        /* In-Person mode: single Room STT indicator + speaker count */
        <div className="flex items-center gap-2">
          <div className="relative">
            <STTChip
              icon={<Mic className="h-3.5 w-3.5" />}
              provider={themStt.provider}
              model={themStt.model}
              active={themActive || youActive}
              color="purple"
              label={t("common:labels.room")} /* shown uppercase by the chip */
              muted={mutedThem}
              interactive={isRecording}
              pickerOpen={pickerOpen === "them"}
              onClick={() => setPickerOpen(pickerOpen === "them" ? null : "them")}
              tooltip={t("statusBar.sttChip.tooltip.room", {
                engine: withSonioxRegion(sttEngineText(themStt), themSttProvider, sonioxRegions.Them),
              })}
            />
            {pickerOpen === "them" && (
              <STTPickerDropdown
                currentProvider={themSttProvider as STTProviderType}
                isInput={meetingAudioConfig?.them.is_input_device ?? false}
                onSelect={(p) => handleProviderChange("them", p)}
                onClose={() => setPickerOpen(null)}
                otherPartyProvider={meetingAudioConfig?.you.stt_provider ?? null}
                otherPartyLabel={t("common:labels.you")}
              />
            )}
          </div>
          <span className="text-xs text-muted-foreground/60">
            {speakerOrder.length > 0
              ? t("statusBar.sttChip.speakersDetected", { count: speakerOrder.length })
              : ""}
          </span>
        </div>
      ) : (
        <>
          {/* Online mode: You STT — interactive during recording */}
          <div className="flex items-center gap-1">
            <div className="relative">
              <STTChip
                icon={<Mic className="h-3.5 w-3.5" />}
                provider={youStt.provider}
                model={youStt.model}
                active={youActive}
                color="sky"
                label={t("common:labels.you")}
                muted={mutedYou}
                interactive={isRecording}
                pickerOpen={pickerOpen === "you"}
                onClick={() => setPickerOpen(pickerOpen === "you" ? null : "you")}
                tooltip={t("statusBar.sttChip.tooltip.you", {
                  engine: withSonioxRegion(sttEngineText(youStt), youSttProvider, sonioxRegions.You),
                })}
              />
              {pickerOpen === "you" && (
                <STTPickerDropdown
                  currentProvider={youSttProvider as STTProviderType}
                  isInput={meetingAudioConfig?.you.is_input_device ?? true}
                  onSelect={(p) => handleProviderChange("you", p)}
                  onClose={() => setPickerOpen(null)}
                  otherPartyProvider={meetingAudioConfig?.them.stt_provider ?? null}
                  otherPartyLabel={t("common:labels.them")}
                />
              )}
            </div>
            {isRecording && (
              <MuteButton type="mic" muted={mutedYou} onToggle={toggleMuteYou} party="you" />
            )}
          </div>

          <Divider />

          {/* Online mode: Them STT — interactive during recording */}
          <div className="flex items-center gap-1">
            <div className="relative">
              <STTChip
                icon={<Volume2 className="h-3.5 w-3.5" />}
                provider={themStt.provider}
                model={themStt.model}
                active={themActive}
                color="amber"
                label={t("common:labels.them")}
                muted={mutedThem}
                interactive={isRecording}
                pickerOpen={pickerOpen === "them"}
                onClick={() => setPickerOpen(pickerOpen === "them" ? null : "them")}
                tooltip={t("statusBar.sttChip.tooltip.them", {
                  engine: withSonioxRegion(sttEngineText(themStt), themSttProvider, sonioxRegions.Them),
                })}
          />
          {pickerOpen === "them" && (
            <STTPickerDropdown
              currentProvider={themSttProvider as STTProviderType}
              isInput={meetingAudioConfig?.them.is_input_device ?? false}
              onSelect={(p) => handleProviderChange("them", p)}
              onClose={() => setPickerOpen(null)}
              otherPartyProvider={meetingAudioConfig?.you.stt_provider ?? null}
              otherPartyLabel={t("common:labels.you")}
            />
          )}
            </div>
            {isRecording && (
              <MuteButton type="speaker" muted={mutedThem} onToggle={toggleMuteThem} party="them" />
            )}
          </div>
        </>
      )}

      {/* Latency: live timer while an answer streams, then the last answer's time */}
      <StreamLatency divider={<Divider />} />

      {/* Update ready — launcher footer only (the updater runs in the launcher) */}
      {!compact && <UpdatePill />}
    </div>
  );
}

// ── Update Pill ────────────────────────────────────────────────────

function UpdatePill() {
  const { t } = useT("llm");
  const phase = useUpdaterStore((s) => s.phase);
  const version = useUpdaterStore((s) => s.version);
  const [installing, setInstalling] = useState(false);

  if (phase !== "ready" || !version) return null;

  const handleClick = async () => {
    setInstalling(true);
    try {
      await restartToUpdate();
    } finally {
      // Only reached if the user cancelled or the install failed.
      setInstalling(false);
    }
  };

  return (
    <>
      <Divider />
      <button
        onClick={handleClick}
        disabled={installing}
        title={t("statusBar.updatePill.title", { version })}
        className="flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary transition-colors hover:bg-primary/15 disabled:opacity-60"
      >
        <ArrowUpCircle className="h-3 w-3" />
        <span>{t("statusBar.updatePill.ready", { version })}</span>
        <span className="text-primary/50">—</span>
        <span className="font-semibold">
          {installing ? t("statusBar.updatePill.restarting") : t("statusBar.updatePill.restart")}
        </span>
      </button>
    </>
  );
}

// ── Color Map ──────────────────────────────────────────────────────

const COLOR_MAP = {
  blue: {
    active: "text-info",
    dot: "bg-info",
    bg: "bg-info/10",
    border: "border-info/20",
    glow: "shadow-info/20",
  },
  sky: {
    active: "text-info",
    dot: "bg-info",
    bg: "bg-info/10",
    border: "border-info/20",
    glow: "shadow-info/20",
  },
  amber: {
    active: "text-warning",
    dot: "bg-warning",
    bg: "bg-warning/10",
    border: "border-warning/20",
    glow: "shadow-warning/20",
  },
  purple: {
    active: "text-purple-400",
    dot: "bg-purple-400",
    bg: "bg-purple-400/10",
    border: "border-purple-400/20",
    glow: "shadow-purple-400/20",
  },
} as const;

// ── Service Chip (display-only, used for LLM) ──────────────────────

function ServiceChip({
  icon,
  provider,
  model,
  active,
  color,
  tooltip,
}: {
  icon: React.ReactNode;
  provider: string;
  model: string;
  active: boolean;
  color: keyof typeof COLOR_MAP;
  tooltip: string;
}) {
  const c = COLOR_MAP[color];

  return (
    <div
      className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 transition-all duration-200 ${
        active
          ? `${c.bg} border ${c.border} shadow-sm ${c.glow}`
          : "bg-secondary/30 border border-transparent"
      }`}
      title={tooltip}
    >
      {/* Status dot */}
      <span className="relative flex h-2 w-2 shrink-0">
        {active && (
          <span className={`absolute inline-flex h-full w-full animate-pulse rounded-full ${c.dot} opacity-40`} />
        )}
        <span className={`relative inline-flex h-2 w-2 rounded-full transition-colors duration-200 ${
          active ? c.dot : "bg-muted-foreground/30"
        }`} />
      </span>

      {/* Icon */}
      <span className={`shrink-0 transition-colors duration-200 ${active ? c.active : "text-muted-foreground/60"}`}>
        {icon}
      </span>

      {/* Text */}
      <div className="flex items-center gap-1 min-w-0">
        <span className={`text-xs font-medium truncate max-w-[100px] transition-colors duration-200 ${
          active ? "text-foreground/90" : "text-muted-foreground/70"
        }`}>
          {provider}
        </span>
        {model && (
          <span className={`text-meta truncate max-w-[70px] transition-colors duration-200 ${
            active ? "text-foreground/60" : "text-muted-foreground/60"
          }`}>
            {model}
          </span>
        )}
      </div>
    </div>
  );
}

// ── STT Chip (interactive during recording) ─────────────────────────

function STTChip({
  icon,
  provider,
  model,
  active,
  color,
  label,
  muted,
  interactive,
  pickerOpen,
  onClick,
  tooltip,
}: {
  icon: React.ReactNode;
  provider: string;
  model: string;
  active: boolean;
  color: keyof typeof COLOR_MAP;
  label: string;
  muted: boolean;
  interactive: boolean;
  pickerOpen: boolean;
  onClick: () => void;
  tooltip: string;
}) {
  const c = COLOR_MAP[color];

  return (
    <div
      className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 transition-all duration-200 ${
        muted
          ? "bg-destructive/5 border border-destructive/10"
          : active
            ? `${c.bg} border ${c.border} shadow-sm ${c.glow}`
            : "bg-secondary/30 border border-transparent"
      } ${interactive ? "cursor-pointer hover:brightness-110" : ""}`}
      title={tooltip}
      onClick={interactive ? onClick : undefined}
    >
      {/* Status dot */}
      <span className="relative flex h-2 w-2 shrink-0">
        {active && !muted && (
          <span className={`absolute inline-flex h-full w-full animate-pulse rounded-full ${c.dot} opacity-40`} />
        )}
        <span className={`relative inline-flex h-2 w-2 rounded-full transition-colors duration-200 ${
          muted ? "bg-destructive/50" : active ? c.dot : "bg-muted-foreground/30"
        }`} />
      </span>

      {/* Icon */}
      <span className={`shrink-0 transition-colors duration-200 ${
        muted ? "text-destructive/60" : active ? c.active : "text-muted-foreground/60"
      }`}>
        {icon}
      </span>

      {/* Text */}
      <div className="flex items-center gap-1 min-w-0">
        {label && (
          <span className={`shrink-0 text-meta font-semibold uppercase tracking-wide transition-colors duration-200 ${
            muted ? "text-destructive/50" : active ? c.active : "text-muted-foreground/60"
          }`}>
            {label}
          </span>
        )}
        <span className={`text-xs font-medium truncate max-w-[100px] transition-colors duration-200 ${
          muted ? "text-destructive/50 line-through" : active ? "text-foreground/90" : "text-muted-foreground/70"
        }`}>
          {provider}
        </span>
        {model && !muted && (
          <span className={`text-meta truncate max-w-[70px] transition-colors duration-200 ${
            active ? "text-foreground/60" : "text-muted-foreground/60"
          }`}>
            {model}
          </span>
        )}
      </div>

      {/* Chevron — visible only when interactive */}
      {interactive && (
        <ChevronUp className={`h-2.5 w-2.5 shrink-0 transition-all duration-200 ${
          pickerOpen ? "text-foreground/60 rotate-0" : "text-muted-foreground/50 rotate-180"
        }`} />
      )}
    </div>
  );
}

// ── Mute Button ─────────────────────────────────────────────────────

const MUTE_TITLE_KEYS = {
  you: { mute: "statusBar.muteButton.you.mute", unmute: "statusBar.muteButton.you.unmute" },
  them: { mute: "statusBar.muteButton.them.mute", unmute: "statusBar.muteButton.them.unmute" },
} as const;

function MuteButton({
  type,
  muted,
  onToggle,
  party,
}: {
  type: "mic" | "speaker";
  muted: boolean;
  onToggle: () => void;
  party: "you" | "them";
}) {
  const { t } = useT("llm");
  return (
    <button
      onClick={onToggle}
      className={`shrink-0 rounded-full p-1 transition-all duration-150 cursor-pointer ${
        muted
          ? "bg-red-500/10 text-red-400 hover:bg-red-500/20"
          : "text-muted-foreground/60 hover:text-foreground/70 hover:bg-accent/40"
      }`}
      title={t(MUTE_TITLE_KEYS[party][muted ? "unmute" : "mute"])}
    >
      {type === "mic"
        ? (muted ? <MicOff className="h-3 w-3" /> : <Mic className="h-3 w-3" />)
        : (muted ? <VolumeX className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />)
      }
    </button>
  );
}

// ── STT Provider Picker Dropdown (opens upward from footer) ─────────

function STTPickerDropdown({
  currentProvider,
  isInput,
  onSelect,
  onClose,
  otherPartyProvider,
  otherPartyLabel,
}: {
  currentProvider: STTProviderType;
  isInput: boolean;
  onSelect: (provider: STTProviderType) => void;
  onClose: () => void;
  otherPartyProvider: STTProviderType | null;
  otherPartyLabel: string;
}) {
  const { t } = useT(["llm", "common"]);
  const ref = useRef<HTMLDivElement>(null);
  const [apiKeyStatus, setApiKeyStatus] = useState<Record<string, boolean>>({});
  const [localEngines, setLocalEngines] = useState<LocalSTTEngineInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [stealTarget, setStealTarget] = useState<STTProviderType | null>(null);

  // Load availability data on mount (lazy — only when dropdown opens)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const keyProviders = STT_PROVIDER_OPTIONS.filter((o) => o.requiresApiKey).map(sttKeySlot);
        const [engines, ...keyResults] = await Promise.all([
          listLocalSTTEngines(),
          ...keyProviders.map(async (p) => {
            try { return { p, ok: await hasSttKeySlot(p) }; }
            catch { return { p, ok: false }; }
          }),
        ]);
        if (cancelled) return;
        setLocalEngines(engines);
        const status: Record<string, boolean> = {};
        for (const k of keyResults) status[k.p] = k.ok;
        setApiKeyStatus(status);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Click outside to close
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setStealTarget(null);
        onClose();
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  // Escape to close
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setStealTarget(null);
        onClose();
      }
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  function isLocalEngineReady(engineId: string): boolean {
    const eng = localEngines.find((e) => e.engine === engineId);
    if (!eng) return false;
    return eng.models.some((m) => !m.id.startsWith("binary-") && m.is_downloaded);
  }

  function isAvailable(opt: (typeof STT_PROVIDER_OPTIONS)[0]): boolean {
    return isSttProviderAvailable(opt, {
      isInput,
      isEngineReady: isLocalEngineReady,
      // Assume available if key status hasn't loaded yet — prevents false fallbacks
      hasKey: (slot) => apiKeyStatus[slot],
      hasBaseUrl: useConfigStore.getState().openaiCompatSttConfig.base_url.trim() !== "",
    });
  }

  function isExclusiveLocked(opt: (typeof STT_PROVIDER_OPTIONS)[0]): boolean {
    if (!isExclusiveProvider(opt.id)) return false;
    if (!otherPartyProvider) return false;
    return isExclusiveProvider(otherPartyProvider);
  }

  function findExclusiveFallback(): STTProviderType | null {
    for (const provider of EXCLUSIVE_FALLBACK_ORDER) {
      const opt = STT_PROVIDER_OPTIONS.find((o) => o.id === provider);
      if (opt && isAvailable(opt)) return provider;
    }
    return null;
  }

  function handleStealConfirm() {
    if (!stealTarget) return;
    const freshConfig = useConfigStore.getState().meetingAudioConfig;
    if (!freshConfig) return;

    const thisRole = freshConfig.you.stt_provider === otherPartyProvider ? "them" : "you";
    const otherRole = thisRole === "you" ? "them" : "you";
    const otherStillExclusive = isExclusiveProvider(freshConfig[otherRole].stt_provider);

    if (!otherStillExclusive) {
      onSelect(stealTarget);
      setStealTarget(null);
      onClose();
      return;
    }

    const fallback = findExclusiveFallback();
    if (!fallback) {
      showToast(t("statusBar.sttPicker.toast.noFallback"), "error");
      setStealTarget(null);
      return;
    }

    const updatedConfig = { ...freshConfig };
    updatedConfig[thisRole] = {
      ...updatedConfig[thisRole],
      stt_provider: stealTarget,
      local_model_id: undefined,
    };
    updatedConfig[otherRole] = {
      ...updatedConfig[otherRole],
      stt_provider: fallback,
      local_model_id: undefined,
    };
    useConfigStore.getState().setMeetingAudioConfig(updatedConfig);

    const stealLabel = STT_PROVIDER_OPTIONS.find((o) => o.id === stealTarget)?.pickerLabel ?? stealTarget;
    const fallbackLabel = STT_PROVIDER_OPTIONS.find((o) => o.id === fallback)?.pickerLabel ?? fallback;
    const partyLabel = (role: "you" | "them") => t(role === "you" ? "common:labels.you" : "common:labels.them");
    showToast(
      t("statusBar.sttPicker.toast.moved", {
        engine: stealLabel,
        to: partyLabel(thisRole),
        from: partyLabel(otherRole),
        fallback: fallbackLabel,
      }),
      "info"
    );

    setStealTarget(null);
    onClose();
  }

  const localOpts = STT_PROVIDER_OPTIONS.filter((o) => !o.isCloud && isAvailable(o));
  const cloudOpts = STT_PROVIDER_OPTIONS.filter((o) => o.isCloud && isAvailable(o));

  // What the other party would fall back to if `stealTarget` moved to this one (null: nothing is available).
  const stealFallbackId = stealTarget ? findExclusiveFallback() : null;
  const stealFallbackLabel = stealFallbackId
    ? (STT_PROVIDER_OPTIONS.find((o) => o.id === stealFallbackId)?.pickerLabel ?? stealFallbackId)
    : null;

  return (
    <div
      ref={ref}
      className="absolute bottom-full left-0 mb-2 min-w-[200px] rounded-xl border border-border/30 bg-popover/90 backdrop-blur-md shadow-2xl z-50 overflow-hidden animate-in slide-in-from-bottom-2 fade-in duration-150"
    >
      {loading ? (
        <div className="px-4 py-3 text-xs text-muted-foreground">{t("statusBar.sttPicker.loading")}</div>
      ) : (
        <>
          {localOpts.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 bg-muted/20 px-3 py-1.5 border-b border-border/20">
                <HardDrive className="h-2.5 w-2.5 text-emerald-400" />
                <span className="text-meta font-semibold uppercase tracking-wider text-muted-foreground/70">
                  {t("statusBar.groups.localBuiltIn")}
                </span>
              </div>
              {localOpts.map((opt) => {
                const Icon = STT_ICONS[opt.icon];
                const selected = currentProvider === opt.id;
                const locked = isExclusiveLocked(opt);
                return (
                  <button
                    key={opt.id}
                    onClick={() => {
                      if (locked) {
                        setStealTarget(opt.id);
                      } else {
                        onSelect(opt.id);
                      }
                    }}
                    className={`flex w-full items-center gap-2.5 px-3 py-2 text-xs transition-colors cursor-pointer ${
                      locked ? "opacity-50 hover:opacity-70" : ""
                    } ${
                      selected ? "bg-primary/10 text-primary" : "text-foreground/80 hover:bg-accent/40"
                    }`}
                  >
                    <Icon className={`h-3.5 w-3.5 shrink-0 ${selected ? "text-primary" : "text-emerald-400"}`} />
                    <span className="flex-1 text-left font-medium">
                      {opt.pickerLabel}
                      {locked && (
                        <span className="block text-meta text-muted-foreground/50">
                          {t("statusBar.sttPicker.inUseBy", { party: otherPartyLabel })}
                        </span>
                      )}
                    </span>
                    {selected && !locked && <CheckCircle className="h-3 w-3 shrink-0 text-primary" />}
                  </button>
                );
              })}
            </div>
          )}

          {cloudOpts.length > 0 && (
            <div className={localOpts.length > 0 ? "border-t border-border/20" : ""}>
              <div className="flex items-center gap-1.5 bg-muted/20 px-3 py-1.5 border-b border-border/20">
                <Cloud className="h-2.5 w-2.5 text-blue-400" />
                <span className="text-meta font-semibold uppercase tracking-wider text-muted-foreground/70">
                  {t("statusBar.groups.cloud")}
                </span>
              </div>
              {cloudOpts.map((opt) => {
                const Icon = STT_ICONS[opt.icon];
                const selected = currentProvider === opt.id;
                const locked = isExclusiveLocked(opt);
                return (
                  <button
                    key={opt.id}
                    onClick={() => {
                      if (locked) {
                        setStealTarget(opt.id);
                      } else {
                        onSelect(opt.id);
                      }
                    }}
                    className={`flex w-full items-center gap-2.5 px-3 py-2 text-xs transition-colors cursor-pointer ${
                      locked ? "opacity-50 hover:opacity-70" : ""
                    } ${
                      selected ? "bg-primary/10 text-primary" : "text-foreground/80 hover:bg-accent/40"
                    }`}
                  >
                    <Icon className={`h-3.5 w-3.5 shrink-0 ${selected ? "text-primary" : "text-blue-400"}`} />
                    <span className="flex-1 text-left font-medium">
                      {opt.pickerLabel}
                      {locked && (
                        <span className="block text-meta text-muted-foreground/50">
                          {t("statusBar.sttPicker.inUseBy", { party: otherPartyLabel })}
                        </span>
                      )}
                    </span>
                    {selected && !locked && <CheckCircle className="h-3 w-3 shrink-0 text-primary" />}
                  </button>
                );
              })}
            </div>
          )}

          {localOpts.length === 0 && cloudOpts.length === 0 && (
            <p className="px-4 py-3 text-meta text-muted-foreground/60">
              {t("statusBar.sttPicker.empty")}
            </p>
          )}

          {stealTarget && (
            <div className="border-t border-border/20 bg-amber-500/5 px-3 py-2.5">
              <p className="text-meta leading-relaxed text-amber-200/80 mb-2">
                <Trans
                  t={t}
                  i18nKey={stealFallbackLabel ? "statusBar.sttPicker.steal.message" : "statusBar.sttPicker.steal.messageNoFallback"}
                  values={{
                    engine: STT_PROVIDER_OPTIONS.find((o) => o.id === stealTarget)?.pickerLabel,
                    fallback: stealFallbackLabel,
                  }}
                  components={{
                    engine: <span className="font-semibold text-amber-400" />,
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
                  {t("statusBar.sttPicker.steal.confirm")}
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
        </>
      )}
    </div>
  );
}

// ── LLM Provider + Model Picker (single interaction, opens upward) ───
// Shows verified providers, loads models inline when provider is picked.
// User selects provider → models load → user picks model → dropdown closes.

const EMBEDDING_PATTERNS = [
  "embed", "all-minilm", "nomic-embed", "bge-",
  "text-embedding", "snowflake-arctic", "jina-embedding",
];

function LLMPickerDropdown({
  currentProvider,
  currentModel,
  onApply,
  onClose,
}: {
  currentProvider: string;
  currentModel: string;
  onApply: (provider: string, model: string) => void;
  onClose: () => void;
}) {
  const { t } = useT(["llm", "common"]);
  const customLabel = t("common:labels.custom");
  const ref = useRef<HTMLDivElement>(null);
  const verifiedProviders = useConfigStore((s) => s.verifiedCloudProviders);
  const claudeCliConfig = useConfigStore((s) => s.claudeCliConfig);
  const claudeModels = useConfigStore((s) => s.claudeModels) ?? undefined;
  const claudeStatus = useAgentStore((s) => s.status);
  const refreshClaudeStatus = useAgentStore((s) => s.refreshStatus);

  // Detect Claude once per window so a logged-in CLI shows up here.
  useEffect(() => {
    if (!useAgentStore.getState().status) refreshClaudeStatus();
  }, [refreshClaudeStatus]);
  const claudeAvailable = currentProvider === "claude_cli" || !!claudeStatus?.auth?.logged_in;

  // Internal state: pending provider (may differ from active while browsing)
  const [pendingProvider, setPendingProvider] = useState(currentProvider);
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  // Load models when pending provider changes (Claude has none to pick:
  // Fast / Deep come from its settings)
  useEffect(() => {
    let cancelled = false;
    setModels([]);
    if (pendingProvider === "claude_cli") {
      setModelsLoading(false);
      return;
    }
    setModelsLoading(true);
    (async () => {
      try {
        const { listModels } = await import("../lib/ipc");
        const key = await getApiKey(pendingProvider).catch(() => null);
        const config = JSON.stringify({
          provider_type: pendingProvider,
          ...(key && { api_key: key }),
        });
        const modelList = await listModels(config);
        if (cancelled) return;
        const chatModels = modelList.filter(
          (m: { id: string }) => !EMBEDDING_PATTERNS.some((p) => m.id.toLowerCase().includes(p))
        );
        setModels(chatModels.map((m: { id: string; name?: string }) => ({ id: m.id, name: m.name || m.id })));
      } catch {
        if (!cancelled) setModels([]);
      } finally {
        if (!cancelled) setModelsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [pendingProvider]);

  // Click outside / Escape to close
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  useEffect(() => {
    function handler(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  // Only show verified/ready providers
  const available = LLM_PROVIDER_OPTIONS.filter((o) => {
    if (o.value === "custom") return false;
    if (o.requiresKey) return verifiedProviders.includes(o.value);
    return verifiedProviders.includes(o.value); // Local also needs verification
  });
  // Fallback: always include the current active provider
  if (!available.some((o) => o.value === currentProvider)) {
    const opt = LLM_PROVIDER_OPTIONS.find((o) => o.value === currentProvider);
    if (opt) available.unshift(opt);
  }

  const localOpts = available.filter((o) => o.isLocal);
  const cloudOpts = available.filter((o) => !o.isLocal);

  return (
    <div
      ref={ref}
      className="absolute bottom-full left-0 mb-2 min-w-[240px] rounded-xl border border-border/30 bg-popover/90 backdrop-blur-md shadow-2xl z-50 overflow-hidden animate-in slide-in-from-bottom-2 fade-in duration-150"
    >
      {/* ── Provider section ── */}
      {localOpts.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 bg-muted/20 px-3 py-1.5 border-b border-border/20">
            <HardDrive className="h-2.5 w-2.5 text-emerald-400" />
            <span className="text-meta font-semibold uppercase tracking-wider text-muted-foreground/70">
              {t("statusBar.groups.local")}
            </span>
          </div>
          {localOpts.map((opt) => {
            const Icon = opt.IconComponent;
            const isPending = pendingProvider === opt.value;
            const isActive = currentProvider === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => setPendingProvider(opt.value)}
                className={`flex w-full items-center gap-2.5 px-3 py-2 text-xs transition-colors cursor-pointer ${
                  isPending ? "bg-primary/10 text-primary" : "text-foreground/80 hover:bg-accent/40"
                }`}
              >
                <Icon className={`h-3.5 w-3.5 shrink-0 ${isPending ? "text-primary" : "text-emerald-400"}`} />
                <span className="flex-1 text-left font-medium">{llmLabel(opt.value, customLabel)}</span>
                {isActive && <span className="text-meta text-primary/80">{t("statusBar.llmPicker.active")}</span>}
              </button>
            );
          })}
        </div>
      )}

      {cloudOpts.length > 0 && (
        <div className={localOpts.length > 0 ? "border-t border-border/20" : ""}>
          <div className="flex items-center gap-1.5 bg-muted/20 px-3 py-1.5 border-b border-border/20">
            <Cloud className="h-2.5 w-2.5 text-blue-400" />
            <span className="text-meta font-semibold uppercase tracking-wider text-muted-foreground/70">
              {t("statusBar.groups.cloud")}
            </span>
          </div>
          {cloudOpts.map((opt) => {
            const Icon = opt.IconComponent;
            const isPending = pendingProvider === opt.value;
            const isActive = currentProvider === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => setPendingProvider(opt.value)}
                className={`flex w-full items-center gap-2.5 px-3 py-2 text-xs transition-colors cursor-pointer ${
                  isPending ? "bg-primary/10 text-primary" : "text-foreground/80 hover:bg-accent/40"
                }`}
              >
                <Icon className={`h-3.5 w-3.5 shrink-0 ${isPending ? "text-primary" : "text-blue-400"}`} />
                <span className="flex-1 text-left font-medium">{llmLabel(opt.value, customLabel)}</span>
                {isActive && <span className="text-meta text-primary/80">{t("statusBar.llmPicker.active")}</span>}
              </button>
            );
          })}
        </div>
      )}

      {claudeAvailable && (
        <div className={available.length > 0 ? "border-t border-border/20" : ""}>
          <div className="flex items-center gap-1.5 bg-muted/20 px-3 py-1.5 border-b border-border/20">
            <Cpu className="h-2.5 w-2.5 text-muted-foreground" />
            <span className="text-meta font-semibold uppercase tracking-wider text-muted-foreground/70">
              {t("statusBar.groups.subscription")}
            </span>
          </div>
          <button
            onClick={() => setPendingProvider("claude_cli")}
            className={`flex w-full items-center gap-2.5 px-3 py-2 text-xs transition-colors cursor-pointer ${
              pendingProvider === "claude_cli" ? "bg-primary/10 text-primary" : "text-foreground/80 hover:bg-accent/40"
            }`}
          >
            <Brain className={`h-3.5 w-3.5 shrink-0 ${pendingProvider === "claude_cli" ? "text-primary" : "text-muted-foreground"}`} />
            <span className="flex-1 text-left font-medium">{LLM_LABELS.claude_cli}</span>
            {currentProvider === "claude_cli" && (
              <span className="text-meta text-primary/80">{t("statusBar.llmPicker.active")}</span>
            )}
          </button>
        </div>
      )}

      {available.length === 0 && !claudeAvailable && (
        <div className="px-4 py-3 text-meta text-muted-foreground/60">
          {t("statusBar.llmPicker.noVerified")}
        </div>
      )}

      {/* ── Claude: no model list, Fast / Deep come from its settings ── */}
      {pendingProvider === "claude_cli" ? (
        <div className="border-t border-border/20">
          <button
            onClick={() => onApply("claude_cli", claudeCliConfig.fast_model)}
            className={`flex w-full items-center gap-2.5 px-3 py-2 text-xs transition-colors cursor-pointer ${
              currentProvider === "claude_cli" ? "bg-primary/10 text-primary" : "text-foreground/80 hover:bg-accent/40"
            }`}
          >
            <span className="flex-1 text-left">
              <span className="block font-medium">
                {currentProvider === "claude_cli" ? t("statusBar.llmPicker.usingClaude") : t("statusBar.llmPicker.useClaude")}
              </span>
              <span className="block text-meta text-muted-foreground">
                {t("statusBar.llmPicker.claudeTiers", {
                  fast: claudeTierLabel(claudeCliConfig.fast_model, claudeCliConfig.fast_effort, claudeModels),
                  deep: claudeTierLabel(claudeCliConfig.deep_model, claudeCliConfig.deep_effort, claudeModels),
                })}
              </span>
            </span>
            {currentProvider === "claude_cli" && <CheckCircle className="h-3 w-3 shrink-0 text-primary" />}
          </button>
        </div>
      ) : (
        /* ── Model section (for pending provider) ── */
        <div className="border-t border-border/20">
          <div className="flex items-center gap-1.5 bg-muted/20 px-3 py-1.5 border-b border-border/20">
            <Brain className="h-2.5 w-2.5 text-violet-400" />
            <span className="text-meta font-semibold uppercase tracking-wider text-muted-foreground/70">
              {t("statusBar.llmPicker.modelHeader", { provider: llmLabel(pendingProvider, customLabel) })}
            </span>
            {modelsLoading && (
              <span className="text-meta text-muted-foreground/60 animate-pulse ml-auto">
                {t("statusBar.llmPicker.loadingModels")}
              </span>
            )}
          </div>
          {models.length > 0 ? (
            <div className="max-h-[160px] overflow-y-auto">
              {models.map((m) => {
                const isCurrentModel = currentProvider === pendingProvider && currentModel === m.id;
                return (
                  <button
                    key={m.id}
                    onClick={() => onApply(pendingProvider, m.id)}
                    className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-xs transition-colors cursor-pointer ${
                      isCurrentModel ? "bg-primary/10 text-primary" : "text-foreground/80 hover:bg-accent/40"
                    }`}
                  >
                    <span className="flex-1 text-left font-medium truncate">{formatModel(m.id)}</span>
                    {isCurrentModel && <CheckCircle className="h-3 w-3 shrink-0 text-primary" />}
                  </button>
                );
              })}
            </div>
          ) : !modelsLoading ? (
            <div className="px-3 py-2 text-meta text-muted-foreground/60">
              {t("statusBar.llmPicker.noModels")}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

// ── Divider ─────────────────────────────────────────────────────────

function Divider() {
  return <div className="h-4 w-px shrink-0 bg-border/20" />;
}
