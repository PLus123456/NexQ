import { useState, useEffect, useCallback, useMemo } from "react";
import type { ParseKeys, TFunction } from "i18next";
import { useAIActionsStore } from "../stores/aiActionsStore";
import { useConfigStore } from "../stores/configStore";
import { useT } from "../i18n";
import { actionDisplayName } from "../lib/actionNames";
import type { ActionConfig, InstructionPresets } from "../lib/types";
import {
  ChevronDown,
  ChevronRight,
  RotateCcw,
  Trash2,
  Plus,
  MessageSquare,
  Zap,
  Layers,
  Sparkles,
  HelpCircle,
  X,
} from "lucide-react";

// ─── Constants ───────────────────────────────────────────

const BUILT_IN_MODES = [
  "Assist",
  "WhatToSay",
  "Shorten",
  "FollowUp",
  "Recap",
  "AskQuestion",
];

/** Built-in action id -> description key (translated where it is shown). */
const ACTION_DESCRIPTION_KEYS: Record<string, ParseKeys<"settings">> = {
  Assist: "aiActions.actions.descriptions.assist",
  WhatToSay: "aiActions.actions.descriptions.whatToSay",
  Shorten: "aiActions.actions.descriptions.shorten",
  FollowUp: "aiActions.actions.descriptions.followUp",
  Recap: "aiActions.actions.descriptions.recap",
  AskQuestion: "aiActions.actions.descriptions.askQuestion",
};

// Preset options: `value` is what gets stored, `labelKey` is translated where it is shown.
const TONE_OPTIONS: { labelKey: ParseKeys<"settings">; value: string }[] = [
  { labelKey: "aiActions.style.tone.options.professional", value: "Professional" },
  { labelKey: "aiActions.style.tone.options.casual", value: "Casual" },
  { labelKey: "aiActions.style.tone.options.formal", value: "Formal" },
  { labelKey: "aiActions.style.tone.options.friendly", value: "Friendly" },
  { labelKey: "aiActions.style.tone.options.direct", value: "Direct" },
];

const FORMAT_OPTIONS: { labelKey: ParseKeys<"settings">; value: string }[] = [
  { labelKey: "aiActions.style.format.options.bullets", value: "bullets" },
  { labelKey: "aiActions.style.format.options.paragraphs", value: "paragraphs" },
  { labelKey: "aiActions.style.format.options.numbered", value: "numbered" },
  { labelKey: "aiActions.style.format.options.oneliner", value: "oneliner" },
];

const LENGTH_OPTIONS: { labelKey: ParseKeys<"settings">; value: string }[] = [
  { labelKey: "aiActions.style.length.options.brief", value: "brief" },
  { labelKey: "aiActions.style.length.options.standard", value: "standard" },
  { labelKey: "aiActions.style.length.options.detailed", value: "detailed" },
];

const OPINION_OPTIONS: { labelKey: ParseKeys<"settings">; value: string | null }[] = [
  { labelKey: "aiActions.style.perspective.options.factual", value: null },
  { labelKey: "aiActions.style.perspective.options.addTake", value: "add" },
];

// The "Active" summary row: one sentence per chosen preset (see presetSummary).
const FORMAT_SUMMARY_KEYS: Record<string, ParseKeys<"settings">> = {
  bullets: "aiActions.style.summary.format.bullets",
  paragraphs: "aiActions.style.summary.format.paragraphs",
  numbered: "aiActions.style.summary.format.numbered",
  oneliner: "aiActions.style.summary.format.oneliner",
};

const LENGTH_SUMMARY_KEYS: Record<string, ParseKeys<"settings">> = {
  brief: "aiActions.style.summary.length.brief",
  standard: "aiActions.style.summary.length.standard",
  detailed: "aiActions.style.summary.length.detailed",
};

/** Help content for each setting (translation keys) — shown via HelpButton/HelpPanel toggle */
const HELP: Record<string, { titleKey: ParseKeys<"settings">; bodyKey: ParseKeys<"settings"> }> = {
  tone: { titleKey: "aiActions.style.tone.label", bodyKey: "aiActions.style.tone.help" },
  format: { titleKey: "aiActions.style.format.label", bodyKey: "aiActions.style.format.help" },
  length: { titleKey: "aiActions.style.length.label", bodyKey: "aiActions.style.length.help" },
  opinion: {
    titleKey: "aiActions.style.perspective.label",
    bodyKey: "aiActions.style.perspective.help",
  },
  instructions: {
    titleKey: "aiActions.instructions.label",
    bodyKey: "aiActions.instructions.help",
  },
  autoTrigger: { titleKey: "aiActions.autoTrigger.label", bodyKey: "aiActions.autoTrigger.help" },
  temperature: { titleKey: "aiActions.temperature.label", bodyKey: "aiActions.temperature.help" },
  transcriptWindow: {
    titleKey: "aiActions.transcriptWindow.label",
    bodyKey: "aiActions.transcriptWindow.help",
  },
};

// ─── Helpers ─────────────────────────────────────────────

function secsToMin(secs: number): number {
  return Math.round(secs / 60);
}

function minToSecs(min: number): number {
  return min * 60;
}

function formatWindowDisplay(seconds: number | null, t: TFunction<["settings", "common"]>): string {
  if (seconds === null) return t("common:labels.default");
  if (seconds === 0) return t("aiActions.transcriptWindow.all");
  return t("aiActions.units.minutes", { count: secsToMin(seconds) });
}

/** Section header with icon badge */
function SectionHeader({
  icon: Icon,
  title,
  subtitle,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="flex items-center gap-2.5 mb-4">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10">
        <Icon className="h-3.5 w-3.5 text-primary" />
      </div>
      <div>
        <h3 className="text-sm font-semibold text-primary/80">{title}</h3>
        <p className="text-meta text-muted-foreground">{subtitle}</p>
      </div>
    </div>
  );
}

/** Toggleable help icon — matches ContextStrategySettings pattern */
function HelpButton({
  id,
  activeId,
  onToggle,
}: {
  id: string;
  activeId: string | null;
  onToggle: (id: string | null) => void;
}) {
  const { t } = useT("settings");
  const isOpen = activeId === id;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle(isOpen ? null : id);
      }}
      className={`inline-flex items-center justify-center rounded-full border transition-colors ${
        isOpen
          ? "border-primary/40 bg-primary/10 text-primary"
          : "border-border/40 text-muted-foreground/60 hover:border-border/60 hover:text-muted-foreground"
      } h-[18px] w-[18px]`}
      title={t("aiActions.help.show")}
    >
      {isOpen ? <X className="h-2.5 w-2.5" /> : <HelpCircle className="h-2.5 w-2.5" />}
    </button>
  );
}

/** Expandable help panel — matches ContextStrategySettings pattern */
function HelpPanel({ id }: { id: string }) {
  const { t } = useT("settings");
  const content = HELP[id];
  if (!content) return null;
  return (
    <div className="mt-2 rounded-lg border border-primary/20 bg-primary/5 px-3.5 py-3 space-y-1">
      <p className="text-xs font-semibold text-primary/80">{t(content.titleKey)}</p>
      <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-line">
        {t(content.bodyKey)}
      </p>
    </div>
  );
}

/** Hint under a control the Claude CLI path ignores. */
function CliUnusedHint() {
  const { t } = useT("settings");
  return <p className="mt-1 text-meta text-muted-foreground/70">{t("aiActions.cliUnused.hint")}</p>;
}

/** Small toggle switch (h-5 w-9) */
function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors duration-200 ${
        checked ? "bg-primary" : "bg-muted"
      }`}
    >
      <span
        className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${
          checked ? "translate-x-4" : "translate-x-0"
        }`}
      />
    </button>
  );
}

// ─── Main Component ──────────────────────────────────────

export function AIActionsSettings() {
  const { t } = useT(["settings", "common"]);
  const configs = useAIActionsStore((s) => s.configs);
  const loadConfigs = useAIActionsStore((s) => s.loadConfigs);
  const updateGlobalDefaults = useAIActionsStore((s) => s.updateGlobalDefaults);
  const updateActionConfig = useAIActionsStore((s) => s.updateActionConfig);
  const resetActionPrompt = useAIActionsStore((s) => s.resetActionPrompt);
  const addCustomAction = useAIActionsStore((s) => s.addCustomAction);
  const removeCustomAction = useAIActionsStore((s) => s.removeCustomAction);
  const setInstructionPresets = useAIActionsStore((s) => s.setInstructionPresets);
  const setCustomInstructions = useAIActionsStore((s) => s.setCustomInstructions);
  // Claude CLI sessions get the transcript as deltas and run without
  // temperature or tools, so those controls don't apply.
  const cliActive = useConfigStore((s) => s.llmProvider === "claude_cli");

  const [expandedActions, setExpandedActions] = useState<Record<string, boolean>>({});
  const [expandedOverrides, setExpandedOverrides] = useState<Record<string, boolean>>({});
  const [showNewActionForm, setShowNewActionForm] = useState(false);
  const [newActionName, setNewActionName] = useState("");
  const [newActionPrompt, setNewActionPrompt] = useState("");
  const [openHelp, setOpenHelp] = useState<string | null>(null);

  useEffect(() => {
    loadConfigs();
  }, []);

  const toggleExpanded = useCallback((mode: string) => {
    setExpandedActions((prev) => ({ ...prev, [mode]: !prev[mode] }));
  }, []);

  const toggleOverride = useCallback((mode: string) => {
    setExpandedOverrides((prev) => ({ ...prev, [mode]: !prev[mode] }));
  }, []);

  const handlePresetToggle = useCallback(
    (category: keyof InstructionPresets, value: string) => {
      const current = configs.instructionPresets[category];
      const newPresets: InstructionPresets = {
        ...configs.instructionPresets,
        [category]: current === value ? null : value,
      };
      setInstructionPresets(newPresets);
    },
    [configs.instructionPresets, setInstructionPresets]
  );

  const handleOpinionChange = useCallback(
    (value: string | null) => {
      setInstructionPresets({ ...configs.instructionPresets, opinion: value });
    },
    [configs.instructionPresets, setInstructionPresets]
  );

  const handleCustomInstructionsChange = useCallback(
    (text: string) => {
      setCustomInstructions(text);
    },
    [setCustomInstructions]
  );

  const handleGlobalDefaultChange = useCallback(
    (key: string, value: number | boolean) => {
      updateGlobalDefaults({ [key]: value });
    },
    [updateGlobalDefaults]
  );

  const handleActionToggleVisible = useCallback(
    (mode: string, visible: boolean) => {
      updateActionConfig(mode, { visible });
    },
    [updateActionConfig]
  );

  const handleActionPromptChange = useCallback(
    (mode: string, systemPrompt: string) => {
      updateActionConfig(mode, { systemPrompt, isDefaultPrompt: false });
    },
    [updateActionConfig]
  );

  const handleResetPrompt = useCallback(
    (mode: string) => {
      resetActionPrompt(mode);
    },
    [resetActionPrompt]
  );

  const handleContextToggle = useCallback(
    (mode: string, key: string, value: boolean) => {
      updateActionConfig(mode, { [key]: value });
    },
    [updateActionConfig]
  );

  const handleOverrideChange = useCallback(
    (mode: string, key: string, value: number | null) => {
      updateActionConfig(mode, { [key]: value });
    },
    [updateActionConfig]
  );

  const handleAddCustomAction = useCallback(() => {
    if (!newActionName.trim() || !newActionPrompt.trim()) return;
    addCustomAction(newActionName.trim(), newActionPrompt.trim());
    setNewActionName("");
    setNewActionPrompt("");
    setShowNewActionForm(false);
  }, [newActionName, newActionPrompt, addCustomAction]);

  const handleRemoveCustomAction = useCallback(
    (mode: string) => {
      removeCustomAction(mode);
    },
    [removeCustomAction]
  );

  const toggleHelp = useCallback((id: string | null) => {
    setOpenHelp((prev) => (prev === id ? null : id));
  }, []);

  const builtInActions = useMemo(() => {
    return BUILT_IN_MODES.map((mode) => configs.actions[mode]).filter(Boolean);
  }, [configs.actions]);

  const customActions = useMemo(() => {
    return Object.values(configs.actions).filter((a) => !a.isBuiltIn);
  }, [configs.actions]);

  const instructionTokens = useMemo(() => {
    const chars = configs.customInstructions.length;
    return Math.ceil(chars / 4);
  }, [configs.customInstructions]);

  // A plain-language summary of the chosen presets for the "Active" row. (The
  // instructions actually sent to the AI are composed in aiActionsStore.)
  const presetSummary = useMemo(() => {
    const parts: string[] = [];
    const p = configs.instructionPresets;
    if (p.tone) {
      const toneOption = TONE_OPTIONS.find((opt) => opt.value === p.tone);
      parts.push(
        t("aiActions.style.summary.tone", { tone: toneOption ? t(toneOption.labelKey) : p.tone })
      );
    }
    if (p.format) {
      const formatKey = FORMAT_SUMMARY_KEYS[p.format];
      parts.push(
        formatKey ? t(formatKey) : t("aiActions.style.summary.format.other", { format: p.format })
      );
    }
    if (p.length) {
      const lengthKey = LENGTH_SUMMARY_KEYS[p.length];
      parts.push(
        lengthKey ? t(lengthKey) : t("aiActions.style.summary.length.other", { length: p.length })
      );
    }
    if (p.opinion === "add") {
      parts.push(t("aiActions.style.summary.perspective"));
    }
    return parts.join(" ");
  }, [configs.instructionPresets, t]);

  const describeAction = (mode: string): string | undefined => {
    const key = ACTION_DESCRIPTION_KEYS[mode];
    return key ? t(key) : undefined;
  };

  const globalWindowMin = secsToMin(configs.globalDefaults.transcriptWindowSeconds);

  return (
    <div className="space-y-5">
      {/* ═══ Two-column grid: Response Style │ Behavior + Context ═══ */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* ─── Left Column: Response Style ─── */}
        <div className="rounded-xl border border-border/30 bg-card/50 p-4">
          <SectionHeader
            icon={MessageSquare}
            title={t("aiActions.style.title")}
            subtitle={t("aiActions.style.subtitle")}
          />

          <div className="space-y-4">
            {/* Tone */}
            <div>
              <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                {t("aiActions.style.tone.label")}
                <HelpButton id="tone" activeId={openHelp} onToggle={toggleHelp} />
              </label>
              {openHelp === "tone" && <HelpPanel id="tone" />}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {TONE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => handlePresetToggle("tone", opt.value)}
                    className={`rounded-full px-3 py-1 text-xs font-medium cursor-pointer transition-colors duration-150 ${
                      configs.instructionPresets.tone === opt.value
                        ? "bg-primary/20 text-primary ring-1 ring-primary/20"
                        : "text-muted-foreground hover:bg-accent/50"
                    }`}
                  >
                    {t(opt.labelKey)}
                  </button>
                ))}
              </div>
            </div>

            {/* Format */}
            <div>
              <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                {t("aiActions.style.format.label")}
                <HelpButton id="format" activeId={openHelp} onToggle={toggleHelp} />
              </label>
              {openHelp === "format" && <HelpPanel id="format" />}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {FORMAT_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => handlePresetToggle("format", opt.value)}
                    className={`rounded-full px-3 py-1 text-xs font-medium cursor-pointer transition-colors duration-150 ${
                      configs.instructionPresets.format === opt.value
                        ? "bg-primary/20 text-primary ring-1 ring-primary/20"
                        : "text-muted-foreground hover:bg-accent/50"
                    }`}
                  >
                    {t(opt.labelKey)}
                  </button>
                ))}
              </div>
            </div>

            {/* Length */}
            <div>
              <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                {t("aiActions.style.length.label")}
                <HelpButton id="length" activeId={openHelp} onToggle={toggleHelp} />
              </label>
              {openHelp === "length" && <HelpPanel id="length" />}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {LENGTH_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => handlePresetToggle("length", opt.value)}
                    className={`rounded-full px-3 py-1 text-xs font-medium cursor-pointer transition-colors duration-150 ${
                      configs.instructionPresets.length === opt.value
                        ? "bg-primary/20 text-primary ring-1 ring-primary/20"
                        : "text-muted-foreground hover:bg-accent/50"
                    }`}
                  >
                    {t(opt.labelKey)}
                  </button>
                ))}
              </div>
            </div>

            {/* Perspective */}
            <div>
              <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                {t("aiActions.style.perspective.label")}
                <HelpButton id="opinion" activeId={openHelp} onToggle={toggleHelp} />
              </label>
              {openHelp === "opinion" && <HelpPanel id="opinion" />}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {OPINION_OPTIONS.map((opt) => (
                  <button
                    key={opt.labelKey}
                    onClick={() => handleOpinionChange(opt.value)}
                    className={`rounded-full px-3 py-1 text-xs font-medium cursor-pointer transition-colors duration-150 ${
                      (configs.instructionPresets.opinion ?? null) === opt.value
                        ? "bg-primary/20 text-primary ring-1 ring-primary/20"
                        : "text-muted-foreground hover:bg-accent/50"
                    }`}
                  >
                    {t(opt.labelKey)}
                  </button>
                ))}
              </div>
            </div>

            {/* Active preset summary */}
            {presetSummary && (
              <div className="rounded-lg border border-primary/10 bg-primary/5 px-3 py-2 flex items-center gap-2">
                <span className="text-meta font-semibold text-primary/80 uppercase tracking-wider shrink-0">
                  {t("aiActions.style.active")}
                </span>
                <span className="text-xs text-foreground/80">{presetSummary}</span>
              </div>
            )}

            <div className="h-px bg-border/20" />

            {/* Additional Instructions */}
            <div>
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  {t("aiActions.instructions.label")}
                  <HelpButton id="instructions" activeId={openHelp} onToggle={toggleHelp} />
                </label>
                <div className="flex items-center gap-3 text-meta text-muted-foreground/70">
                  <span>
                    {t("aiActions.instructions.charCount", { count: configs.customInstructions.length })}
                  </span>
                  <span>{t("aiActions.instructions.tokenCount", { count: instructionTokens })}</span>
                </div>
              </div>
              {openHelp === "instructions" && <HelpPanel id="instructions" />}
              <textarea
                rows={3}
                value={configs.customInstructions}
                onChange={(e) => handleCustomInstructionsChange(e.target.value)}
                placeholder={t("aiActions.instructions.placeholder")}
                className="mt-2 w-full resize-none rounded-lg border border-border/50 bg-secondary/30 px-3 py-2.5 text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/20"
              />
            </div>
          </div>
        </div>

        {/* ─── Right Column: Behavior + Context ─── */}
        <div className="space-y-5">
          {/* AI Behavior */}
          <div className="rounded-xl border border-border/30 bg-card/50 p-4">
            <SectionHeader
              icon={Zap}
              title={t("aiActions.behavior.title")}
              subtitle={t("aiActions.behavior.subtitle")}
            />

            <div className="space-y-4">
              {/* Auto-Trigger */}
              <div>
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    {t("aiActions.autoTrigger.label")}
                    <HelpButton id="autoTrigger" activeId={openHelp} onToggle={toggleHelp} />
                  </label>
                  <Toggle
                    checked={configs.globalDefaults.autoTrigger}
                    onChange={(v) => handleGlobalDefaultChange("autoTrigger", v)}
                    label={t("aiActions.autoTrigger.ariaLabel")}
                  />
                </div>
                {openHelp === "autoTrigger" && <HelpPanel id="autoTrigger" />}
              </div>

              <div className="h-px bg-border/20" />

              {/* Temperature */}
              <div>
                <fieldset disabled={cliActive} className={`min-w-0 ${cliActive ? "opacity-50" : ""}`}>
                  <div className="flex items-center justify-between">
                    <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                      {t("aiActions.temperature.label")}
                      <HelpButton id="temperature" activeId={openHelp} onToggle={toggleHelp} />
                    </label>
                    <span className="rounded-md bg-secondary/50 px-2 py-0.5 text-xs font-medium tabular-nums text-foreground">
                      {configs.globalDefaults.temperature.toFixed(1)}
                    </span>
                  </div>
                  {openHelp === "temperature" && <HelpPanel id="temperature" />}
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.1}
                    value={configs.globalDefaults.temperature}
                    onChange={(e) =>
                      handleGlobalDefaultChange("temperature", Number(e.target.value))
                    }
                    aria-label={t("aiActions.temperature.label")}
                    className="mt-2 w-full cursor-pointer accent-primary disabled:cursor-not-allowed"
                  />
                  <div className="mt-1 flex justify-between text-meta text-muted-foreground/70">
                    <span>{t("aiActions.temperature.precise")}</span>
                    <span>{t("aiActions.temperature.creative")}</span>
                  </div>
                </fieldset>
                {cliActive && <CliUnusedHint />}
              </div>
            </div>
          </div>

          {/* Context Window */}
          <div className="rounded-xl border border-border/30 bg-card/50 p-4">
            <SectionHeader
              icon={Layers}
              title={t("aiActions.context.title")}
              subtitle={t("aiActions.context.subtitle")}
            />

            <div className="space-y-4">
              {/* Transcript Window */}
              <div>
                <fieldset disabled={cliActive} className={`min-w-0 ${cliActive ? "opacity-50" : ""}`}>
                  <div className="flex items-center justify-between">
                    <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                      {t("aiActions.transcriptWindow.label")}
                      <HelpButton id="transcriptWindow" activeId={openHelp} onToggle={toggleHelp} />
                    </label>
                    <span className="rounded-md bg-secondary/50 px-2 py-0.5 text-xs font-medium tabular-nums text-foreground">
                      {t("aiActions.units.minutes", { count: globalWindowMin })}
                    </span>
                  </div>
                  {openHelp === "transcriptWindow" && <HelpPanel id="transcriptWindow" />}
                  <input
                    type="range"
                    min={1}
                    max={30}
                    step={1}
                    value={globalWindowMin}
                    onChange={(e) =>
                      handleGlobalDefaultChange(
                        "transcriptWindowSeconds",
                        minToSecs(Number(e.target.value))
                      )
                    }
                    aria-label={t("aiActions.transcriptWindow.label")}
                    className="mt-2 w-full cursor-pointer accent-primary disabled:cursor-not-allowed"
                  />
                  <div className="mt-1 flex justify-between text-meta text-muted-foreground/70">
                    <span>{t("aiActions.units.minutes", { count: 1 })}</span>
                    <span>{t("aiActions.units.minutes", { count: 30 })}</span>
                  </div>
                </fieldset>
                {cliActive && <CliUnusedHint />}
              </div>

              <div className="h-px bg-border/20" />

              {/* RAG Chunks — reference to Context Strategy */}
              <div>
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-muted-foreground">
                    {t("aiActions.ragChunks.label")}
                  </label>
                  <span className="text-xs text-muted-foreground/60">
                    {t("aiActions.ragChunks.setElsewhere")}
                  </span>
                </div>
                <p className="mt-1 text-meta text-muted-foreground/50">
                  {t("aiActions.ragChunks.hint")}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ═══ Actions (full width) ═══ */}
      <div className="rounded-xl border border-border/30 bg-card/50 p-4">
        <SectionHeader
          icon={Sparkles}
          title={t("aiActions.actions.title")}
          subtitle={t("aiActions.actions.subtitle")}
        />

        {/* Built-in Actions */}
        <div>
          <h4 className="text-meta font-semibold uppercase tracking-wider text-muted-foreground/70 mb-2">
            {t("aiActions.actions.builtIn", { count: builtInActions.length })}
          </h4>
          <div className="rounded-lg border border-border/20 divide-y divide-border/20 overflow-hidden">
            {builtInActions.map((action) => (
              <ActionCard
                key={action.mode}
                action={action}
                description={describeAction(action.mode)}
                isExpanded={!!expandedActions[action.mode]}
                isOverrideExpanded={!!expandedOverrides[action.mode]}
                onToggleExpand={() => toggleExpanded(action.mode)}
                onToggleOverride={() => toggleOverride(action.mode)}
                onToggleVisible={(v) => handleActionToggleVisible(action.mode, v)}
                onPromptChange={(p) => handleActionPromptChange(action.mode, p)}
                onResetPrompt={() => handleResetPrompt(action.mode)}
                onContextToggle={(k, v) => handleContextToggle(action.mode, k, v)}
                onOverrideChange={(k, v) => handleOverrideChange(action.mode, k, v)}
                showReset={true}
                cliActive={cliActive}
              />
            ))}
          </div>
        </div>

        {/* Custom Actions */}
        <div className="mt-5">
          <h4 className="text-meta font-semibold uppercase tracking-wider text-muted-foreground/70 mb-2">
            {t("aiActions.actions.custom", { count: customActions.length })}
          </h4>

          {customActions.length > 0 && (
            <div className="rounded-lg border border-border/20 divide-y divide-border/20 overflow-hidden">
              {customActions.map((action) => (
                <ActionCard
                  key={action.mode}
                  action={action}
                  isExpanded={!!expandedActions[action.mode]}
                  isOverrideExpanded={!!expandedOverrides[action.mode]}
                  onToggleExpand={() => toggleExpanded(action.mode)}
                  onToggleOverride={() => toggleOverride(action.mode)}
                  onToggleVisible={(v) => handleActionToggleVisible(action.mode, v)}
                  onPromptChange={(p) => handleActionPromptChange(action.mode, p)}
                  onResetPrompt={undefined}
                  onContextToggle={(k, v) => handleContextToggle(action.mode, k, v)}
                  onOverrideChange={(k, v) => handleOverrideChange(action.mode, k, v)}
                  showReset={false}
                  cliActive={cliActive}
                  onDelete={() => handleRemoveCustomAction(action.mode)}
                />
              ))}
            </div>
          )}

          {customActions.length === 0 && !showNewActionForm && (
            <p className="py-2 text-center text-meta text-muted-foreground/60">
              {t("aiActions.actions.empty")}
            </p>
          )}

          {showNewActionForm && (
            <div className="rounded-lg border border-border/40 bg-secondary/20 p-3.5 space-y-2.5">
              <input
                type="text"
                value={newActionName}
                onChange={(e) => setNewActionName(e.target.value)}
                placeholder={t("aiActions.actions.namePlaceholder")}
                className="w-full rounded-lg border border-border/50 bg-secondary/30 px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/20"
              />
              <textarea
                rows={3}
                value={newActionPrompt}
                onChange={(e) => setNewActionPrompt(e.target.value)}
                placeholder={t("aiActions.actions.promptPlaceholder")}
                className="w-full resize-none rounded-lg border border-border/50 bg-secondary/30 px-3 py-2.5 text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/20"
              />
              <div className="flex gap-2">
                <button
                  onClick={handleAddCustomAction}
                  disabled={!newActionName.trim() || !newActionPrompt.trim()}
                  className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Plus className="h-3 w-3" />
                  {t("common:actions.add")}
                </button>
                <button
                  onClick={() => {
                    setShowNewActionForm(false);
                    setNewActionName("");
                    setNewActionPrompt("");
                  }}
                  className="rounded-lg border border-border/50 bg-secondary/30 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors duration-150 hover:bg-secondary hover:text-foreground"
                >
                  {t("common:actions.cancel")}
                </button>
              </div>
            </div>
          )}

          {!showNewActionForm && (
            <button
              onClick={() => setShowNewActionForm(true)}
              className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border/50 py-2 text-xs font-medium text-muted-foreground cursor-pointer transition-colors duration-150 hover:border-primary/30 hover:text-primary"
            >
              <Plus className="h-3.5 w-3.5" />
              {t("aiActions.actions.addButton")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Action Card ─────────────────────────────────────────

interface ActionCardProps {
  action: ActionConfig;
  description?: string;
  isExpanded: boolean;
  isOverrideExpanded: boolean;
  onToggleExpand: () => void;
  onToggleOverride: () => void;
  onToggleVisible: (visible: boolean) => void;
  onPromptChange: (prompt: string) => void;
  onResetPrompt: (() => void) | undefined;
  onContextToggle: (key: string, value: boolean) => void;
  onOverrideChange: (key: string, value: number | null) => void;
  showReset: boolean;
  /** Claude CLI is active: web search, transcript window and temperature don't apply. */
  cliActive: boolean;
  onDelete?: () => void;
}

function ActionCard({
  action,
  description,
  isExpanded,
  isOverrideExpanded,
  onToggleExpand,
  onToggleOverride,
  onToggleVisible,
  onPromptChange,
  onResetPrompt,
  onContextToggle,
  onOverrideChange,
  showReset,
  cliActive,
  onDelete,
}: ActionCardProps) {
  const { t } = useT(["settings", "common"]);
  const handleDeleteClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onDelete?.();
    },
    [onDelete]
  );

  const windowDisplayMin =
    action.transcriptWindowSeconds !== null
      ? action.transcriptWindowSeconds === 0
        ? 0
        : secsToMin(action.transcriptWindowSeconds)
      : null;

  return (
    <div>
      {/* Compact header row */}
      <button
        onClick={onToggleExpand}
        className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors duration-150 hover:bg-secondary/20"
      >
        {isExpanded ? (
          <ChevronDown className="h-3 w-3 text-muted-foreground/70 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 text-muted-foreground/70 shrink-0" />
        )}
        <span className="text-xs font-medium text-foreground shrink-0">
          {actionDisplayName(action)}
        </span>
        <span className="text-meta text-muted-foreground/60 shrink-0">
          {action.mode}
        </span>
        {description && (
          <span className="hidden sm:inline text-meta text-muted-foreground/60 truncate">
            &mdash; {description}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2 shrink-0">
          {onDelete && (
            <button
              onClick={handleDeleteClick}
              className="rounded-md p-1 text-muted-foreground/60 transition-colors duration-150 hover:bg-destructive/10 hover:text-destructive"
              aria-label={t("aiActions.card.delete.ariaLabel", { name: actionDisplayName(action) })}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
          <Toggle
            checked={action.visible}
            onChange={(v) => onToggleVisible(v)}
            label={t("aiActions.card.visibility.ariaLabel", { name: actionDisplayName(action) })}
          />
        </div>
      </button>

      {/* Expanded configuration */}
      {isExpanded && (
        <div className="border-t border-border/20 bg-secondary/10 px-3.5 py-3.5 space-y-3.5">
          {/* Purpose */}
          {description && (
            <p className="text-xs text-muted-foreground/80 italic">
              {description}
            </p>
          )}

          {/* System Prompt */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                {t("aiActions.card.systemPrompt")}
              </label>
              {showReset && onResetPrompt && (
                <button
                  onClick={onResetPrompt}
                  disabled={action.isDefaultPrompt}
                  className="flex items-center gap-1 text-meta font-medium text-muted-foreground transition-colors duration-150 hover:text-primary disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <RotateCcw className="h-3 w-3" />
                  {t("common:actions.reset")}
                </button>
              )}
            </div>
            <textarea
              rows={3}
              value={action.systemPrompt}
              onChange={(e) => onPromptChange(e.target.value)}
              className="w-full resize-none rounded-lg border border-border/50 bg-secondary/30 px-3 py-2.5 text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/20"
            />
          </div>

          {/* Context Sources — two-column grid */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              {t("aiActions.card.sources.label")}
            </label>
            <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1.5">
              {[
                { key: "includeTranscript", label: t("aiActions.card.sources.transcript"), checked: action.includeTranscript },
                { key: "includeRagChunks", label: t("aiActions.ragChunks.label"), checked: action.includeRagChunks },
                { key: "includeCustomInstructions", label: t("aiActions.card.sources.customInstructions"), checked: action.includeCustomInstructions },
                { key: "includeDetectedQuestion", label: t("aiActions.card.sources.detectedQuestion"), checked: action.includeDetectedQuestion },
                { key: "webSearch", label: t("aiActions.card.sources.webSearch"), checked: action.webSearch },
              ].map(({ key, label, checked }) => {
                const unused = cliActive && key === "webSearch";
                return (
                  <label
                    key={key}
                    title={unused ? t("aiActions.cliUnused.hint") : undefined}
                    className={`flex items-center gap-2 ${unused ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={unused}
                      onChange={(e) => onContextToggle(key, e.target.checked)}
                      className="h-3.5 w-3.5 rounded border-border/50 accent-primary"
                    />
                    <span className="text-xs text-foreground">{label}</span>
                  </label>
                );
              })}
            </div>
            {cliActive && (
              <p className="mt-1.5 text-meta text-muted-foreground/70">{t("aiActions.cliUnused.webSearch")}</p>
            )}
          </div>

          {/* Override Defaults (Collapsible) */}
          <div>
            <button
              onClick={onToggleOverride}
              className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground"
            >
              {isOverrideExpanded ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              {t("aiActions.card.overrides.title")}
            </button>

            {isOverrideExpanded && (
              <div className="mt-2.5 space-y-3 rounded-lg border border-border/30 bg-secondary/10 p-3">
                {/* Transcript Window Override */}
                <div>
                  <fieldset disabled={cliActive} className={`min-w-0 ${cliActive ? "opacity-50" : ""}`}>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-meta font-medium text-muted-foreground">
                        {t("aiActions.transcriptWindow.label")}
                      </label>
                      <span className="rounded bg-secondary/50 px-1.5 py-0.5 text-meta font-medium tabular-nums text-foreground">
                        {formatWindowDisplay(action.transcriptWindowSeconds, t)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={action.transcriptWindowSeconds !== null}
                          onChange={(e) =>
                            onOverrideChange(
                              "transcriptWindowSeconds",
                              e.target.checked ? 120 : null
                            )
                          }
                          className="h-3 w-3 rounded border-border/50 accent-primary"
                        />
                        <span className="text-meta text-muted-foreground">{t("aiActions.card.overrides.toggle")}</span>
                      </label>
                      {action.transcriptWindowSeconds !== null && (
                        <input
                          type="range"
                          min={0}
                          max={30}
                          step={1}
                          value={windowDisplayMin ?? 2}
                          onChange={(e) => {
                            const min = Number(e.target.value);
                            onOverrideChange(
                              "transcriptWindowSeconds",
                              min === 0 ? 0 : minToSecs(min)
                            );
                          }}
                          className="flex-1 cursor-pointer accent-primary"
                        />
                      )}
                    </div>
                    {action.transcriptWindowSeconds !== null && (
                      <div className="mt-1 flex justify-between text-meta text-muted-foreground/60">
                        <span>{t("aiActions.transcriptWindow.all")}</span>
                        <span>{t("aiActions.units.minutes", { count: 30 })}</span>
                      </div>
                    )}
                  </fieldset>
                  {cliActive && <CliUnusedHint />}
                </div>

                {/* RAG Top-K Override */}
                <div className="flex items-center justify-between">
                  <label className="text-meta font-medium text-muted-foreground">
                    {t("aiActions.card.overrides.ragTopK")}
                  </label>
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={action.ragTopK !== null}
                        onChange={(e) =>
                          onOverrideChange("ragTopK", e.target.checked ? 5 : null)
                        }
                        className="h-3 w-3 rounded border-border/50 accent-primary"
                      />
                      <span className="text-meta text-muted-foreground">{t("aiActions.card.overrides.toggle")}</span>
                    </label>
                    {action.ragTopK !== null && (
                      <select
                        value={action.ragTopK}
                        onChange={(e) =>
                          onOverrideChange("ragTopK", Number(e.target.value))
                        }
                        className="rounded border border-border/50 bg-secondary/30 px-2 py-1 text-meta text-foreground focus:border-primary/50 focus:outline-none"
                      >
                        {[3, 5, 7, 10, 15, 20].map((v) => (
                          <option key={v} value={v}>
                            {v}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>

                {/* Temperature Override */}
                <div>
                  <fieldset disabled={cliActive} className={`min-w-0 ${cliActive ? "opacity-50" : ""}`}>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-meta font-medium text-muted-foreground">
                        {t("aiActions.temperature.label")}
                      </label>
                      <span className="rounded bg-secondary/50 px-1.5 py-0.5 text-meta font-medium tabular-nums text-foreground">
                        {action.temperature === null
                          ? t("common:labels.default")
                          : action.temperature.toFixed(1)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={action.temperature !== null}
                          onChange={(e) =>
                            onOverrideChange("temperature", e.target.checked ? 0.3 : null)
                          }
                          className="h-3 w-3 rounded border-border/50 accent-primary"
                        />
                        <span className="text-meta text-muted-foreground">{t("aiActions.card.overrides.toggle")}</span>
                      </label>
                      {action.temperature !== null && (
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.1}
                          value={action.temperature}
                          onChange={(e) =>
                            onOverrideChange("temperature", Number(e.target.value))
                          }
                          className="flex-1 cursor-pointer accent-primary"
                        />
                      )}
                    </div>
                  </fieldset>
                  {cliActive && <CliUnusedHint />}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
