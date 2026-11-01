import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { ExternalLink, Loader2, RefreshCw, Terminal } from "lucide-react";
import type { TFunction } from "i18next";
import { ModelCombobox, type ModelOption } from "../components/ModelCombobox";
// `translate` is the global `t`, for helpers that run outside a component;
// components use the `t` of `useT` so they re-render on a language change.
import { t as translate, useT } from "../i18n";
import { apiBilledNote, npmOnlyNote } from "../lib/agentUsage";
import { getApiKey, listModels, openClaudeLoginTerminal } from "../lib/ipc";
import {
  STATIC_CLAUDE_MODELS,
  effectiveEffort,
  findClaudeModel,
  formatCheckedAgo,
  groupClaudeModels,
  isClaudeAlias,
} from "../lib/claudeModels";
import type { ClaudeCliConfig, ClaudeCliStatus, ClaudeModelInfo } from "../lib/types";
import { isSessionRunning, useAgentStore } from "../stores/agentStore";
import { CLAUDE_FALLBACK_PROVIDERS, useConfigStore } from "../stores/configStore";
import { showToast } from "../stores/toastStore";

type T = TFunction<["llm", "common"]>;

export const CLAUDE_INSTALL_URL = "https://code.claude.com/docs/en/setup";

/** Product name: the same in every UI language. */
const CLAUDE = "Claude"; // i18n-ignore

/**
 * Effort levels, lowest first. `labelKey` (namespace-prefixed, because the
 * global `t` translates it) is translated when shown: see `effortLabel`.
 */
export const CLAUDE_EFFORTS = [
  { value: "low", labelKey: "llm:claudeCli.effort.low" },
  { value: "medium", labelKey: "llm:claudeCli.effort.medium" },
  { value: "high", labelKey: "llm:claudeCli.effort.high" },
  { value: "xhigh", labelKey: "llm:claudeCli.effort.xhigh" },
  { value: "max", labelKey: "llm:claudeCli.effort.max" },
] as const;

// The two model tiers' texts, as keys translated when shown.
const TIER_KEYS = {
  fast: {
    name: "claudeCli.models.tiers.fast.name",
    hint: "claudeCli.models.tiers.fast.hint",
    modelLabel: "claudeCli.models.tiers.fast.modelLabel",
    effortLabel: "claudeCli.models.tiers.fast.effortLabel",
    thinkingLabel: "claudeCli.models.tiers.fast.thinkingLabel",
  },
  deep: {
    name: "claudeCli.models.tiers.deep.name",
    hint: "claudeCli.models.tiers.deep.hint",
    modelLabel: "claudeCli.models.tiers.deep.modelLabel",
    effortLabel: "claudeCli.models.tiers.deep.effortLabel",
    thinkingLabel: "claudeCli.models.tiers.deep.thinkingLabel",
  },
} as const;

const FALLBACK_LABELS: Record<string, string> = {
  ollama: "Ollama",
  lm_studio: "LM Studio",
  openai: "OpenAI",
  anthropic: "Anthropic",
  groq: "Groq",
  gemini: "Google Gemini",
  openrouter: "OpenRouter",
};

function currentCatalog(): ClaudeModelInfo[] {
  return useConfigStore.getState().claudeModels ?? STATIC_CLAUDE_MODELS;
}

/** "haiku" → "Haiku", a pinned id → its name ("Opus 4.8"); unknown ids as they are. */
export function claudeModelLabel(model: string, models: ClaudeModelInfo[] = currentCatalog()): string {
  if (isClaudeAlias(model)) return model.charAt(0).toUpperCase() + model.slice(1);
  return findClaudeModel(models, model)?.display_name || model;
}

/** "Low" / "Extra high" in the UI language; an unknown level as it is. */
function effortLabel(effort: string): string {
  const level = CLAUDE_EFFORTS.find((x) => x.value === effort);
  return level ? translate(level.labelKey) : effort;
}

/** "Sonnet · Medium" with the effort the session actually gets; just "Haiku" without effort. */
export function claudeTierLabel(model: string, effort: string, models: ClaudeModelInfo[] = currentCatalog()): string {
  const effective = effectiveEffort(findClaudeModel(models, model), effort);
  const label = claudeModelLabel(model, models);
  return effective === null ? label : `${label} · ${effortLabel(effective)}`;
}

type ConnectionState =
  | "checking"
  | "failed"
  | "connected"
  | "api_billed"
  | "logged_out"
  | "not_installed"
  | "npm_only"
  | "unknown";

function connectionState(status: ClaudeCliStatus | undefined, failed: boolean): ConnectionState {
  // No answer yet: still checking, or the check itself failed.
  if (!status) return failed ? "failed" : "checking";
  if (!status.installed) return status.npm_only ? "npm_only" : "not_installed";
  if (!status.auth) return "unknown";
  if (!status.auth.logged_in) return "logged_out";
  // Only a subscription login counts as connected; any other login bills an API account.
  return status.auth.login === "subscription" ? "connected" : "api_billed";
}

// Color carries the state: green ok, amber needs the user, neutral absent.
const DOT_CLASS: Record<ConnectionState, string> = {
  checking: "bg-muted-foreground/40 animate-pulse",
  failed: "bg-warning",
  connected: "bg-success",
  api_billed: "bg-warning",
  logged_out: "bg-warning",
  unknown: "bg-warning",
  not_installed: "bg-muted-foreground/40",
  npm_only: "bg-warning",
};

function planLabel(plan: string | null): string | null {
  if (!plan) return null;
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

/** Short state shown on the provider row. */
function rowLabel(state: ConnectionState, t: T): string {
  switch (state) {
    case "checking":
      return t("claudeCli.rowState.checking");
    case "failed":
      return t("claudeCli.rowState.failed");
    case "connected":
      return t("common:status.connected");
    case "api_billed":
      return t("claudeCli.rowState.apiBilled");
    case "logged_out":
      return t("claudeCli.rowState.loggedOut");
    case "unknown":
      return t("claudeCli.rowState.unknown");
    case "not_installed":
      return t("claudeCli.rowState.notInstalled");
    case "npm_only":
      return t("claudeCli.rowState.npmOnly");
  }
}

/** Full state line of the details panel. */
function statusLine(state: ConnectionState, status: ClaudeCliStatus | undefined, t: T): string {
  switch (state) {
    case "checking":
      return t("claudeCli.statusLine.checking");
    case "failed":
      return t("claudeCli.statusLine.failed");
    case "not_installed":
      return t("claudeCli.statusLine.notInstalled");
    case "npm_only":
      return npmOnlyNote();
    case "unknown":
      return t("claudeCli.statusLine.unknown");
    case "logged_out":
      return t("claudeCli.statusLine.loggedOut");
    case "connected": {
      const auth = status?.auth;
      const plan = planLabel(auth?.subscription_type ?? null);
      return [auth?.email ?? t("claudeCli.statusLine.loggedIn"), plan].filter(Boolean).join(" · ");
    }
    case "api_billed":
      return [status?.auth?.email ?? t("claudeCli.statusLine.loggedIn"), t("claudeCli.statusLine.apiAccount")].join(" · ");
  }
}

/** Outcome of the last check, shown next to Check connection; color only where it means something. */
function checkResult(
  state: ConnectionState,
  error: string | undefined,
  t: T,
): { text: string; className: string } | null {
  if (state === "checking") return null;
  // The last check itself failed: say so, not the state an earlier check found.
  if (error) return { text: t("claudeCli.checkResult.failedWithDetail", { detail: error }), className: "text-warning" };
  switch (state) {
    case "connected":
      return { text: t("claudeCli.checkResult.connected"), className: "text-success" };
    case "api_billed":
      return { text: t("claudeCli.checkResult.apiBilled"), className: "text-warning" };
    case "logged_out":
      return { text: t("claudeCli.checkResult.loggedOut"), className: "text-warning" };
    case "unknown":
      return { text: t("claudeCli.checkResult.unknown"), className: "text-warning" };
    case "npm_only":
      return { text: t("claudeCli.checkResult.npmOnly"), className: "text-warning" };
    case "not_installed":
      return { text: t("claudeCli.checkResult.notInstalled"), className: "text-muted-foreground" };
    case "failed":
      return { text: t("claudeCli.checkResult.failed"), className: "text-warning" };
  }
}

/** Current time, re-read every `ms` so relative times stay honest. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return now;
}

/** While waiting for a login in the terminal: re-check this often, this many times. */
const LOGIN_POLL_MS = 4000;
const LOGIN_POLL_TRIES = 30;

const SELECT_CLASS =
  "rounded-lg border border-border/50 bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50";

const BUTTON_CLASS =
  "inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-background px-3.5 py-2 text-sm font-medium text-foreground transition-all duration-150 hover:bg-accent hover:-translate-y-px active:translate-y-px active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:active:scale-100 cursor-pointer";

interface ClaudeCliSettingsProps {
  /** The Claude row is the provider being viewed (shows its details). */
  selected: boolean;
  /** Claude CLI is the active provider. */
  active: boolean;
  onSelect: () => void;
  /**
   * Shown inside the connection editor: no provider rows and no "Use Claude"
   * banner (the editor has its own "Make default"); the details always show.
   */
  embedded?: boolean;
}

/**
 * "Subscription (local CLI)" group of the AI provider settings: Claude Code
 * driven through the user's own login (Beta), plus placeholder rows for
 * Gemini CLI and Codex CLI.
 */
export function ClaudeCliSettings({ selected, active, onSelect, embedded = false }: ClaudeCliSettingsProps) {
  const { t } = useT(["llm", "common"]);
  const status = useAgentStore((s) => s.status);
  const checking = useAgentStore((s) => s.checking);
  const statusFailed = useAgentStore((s) => !!s.statusError);
  const refreshStatus = useAgentStore((s) => s.refreshStatus);
  const initAgentStore = useAgentStore((s) => s.init);

  useEffect(() => {
    initAgentStore();
    refreshStatus();
  }, [initAgentStore, refreshStatus]);

  const state = connectionState(status, statusFailed && !checking);
  const stateLabel = rowLabel(state, t);

  return (
    <div className="rounded-xl border border-border/30 bg-card/50 p-5">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-primary/80">{t("claudeCli.title")}</h3>
        <span className="rounded-full border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-meta font-semibold uppercase tracking-wider text-warning">
          {t("claudeCli.beta")}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{t("claudeCli.credentialsNote")}</p>

      {!embedded && (
        <div className="mt-4 grid grid-cols-3 gap-2.5">
          <button
            type="button"
            onClick={onSelect}
            aria-pressed={selected}
            aria-label={
              active
                ? t("claudeCli.providerRow.ariaLabelActive", { state: stateLabel })
                : t("claudeCli.providerRow.ariaLabel", { state: stateLabel })
            }
            className={`relative flex flex-col items-start rounded-xl border p-3 text-left transition-all duration-150 cursor-pointer ${
              selected
                ? "border-primary bg-primary/5 ring-1 ring-primary/20"
                : "border-border/50 hover:border-border hover:bg-accent/50"
            }`}
          >
            <div className="flex w-full items-center gap-1.5">
              <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs font-medium">{CLAUDE}</span>
              {active && <span className="ml-auto text-meta font-medium text-primary/80">{t("claudeCli.active")}</span>}
            </div>
            <span className="mt-1.5 flex w-full items-center gap-1.5 text-meta text-muted-foreground">
              <span
                data-testid="claude-status-dot"
                data-state={state}
                aria-hidden="true"
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_CLASS[state]}`}
              />
              <span className="truncate">{stateLabel}</span>
            </span>
          </button>
          {/* Product names: the same in every language. */}
          {["Gemini CLI", "Codex CLI"].map((label) => (
            <button
              key={label}
              type="button"
              disabled
              className="flex flex-col items-start rounded-xl border border-dashed border-border/40 p-3 text-left opacity-60 cursor-not-allowed"
            >
              <div className="flex w-full items-center gap-1.5">
                <Terminal className="h-3.5 w-3.5 text-muted-foreground/60" />
                <span className="text-xs font-medium text-muted-foreground">{label}</span>
              </div>
              <span className="mt-1.5 text-meta text-muted-foreground/70">{t("claudeCli.comingSoon")}</span>
            </button>
          ))}
        </div>
      )}

      {(selected || embedded) && (
        <ClaudeDetails
          status={status}
          state={state}
          checking={checking}
          active={active || embedded}
          refreshStatus={refreshStatus}
        />
      )}
    </div>
  );
}

function ClaudeDetails({
  status,
  state,
  checking,
  active,
  refreshStatus,
}: {
  status: ClaudeCliStatus | undefined;
  state: ConnectionState;
  checking: boolean;
  active: boolean;
  refreshStatus: () => Promise<void>;
}) {
  const { t } = useT(["llm", "common"]);
  const [awaitingLogin, setAwaitingLogin] = useState(false);
  const [activating, setActivating] = useState(false);
  const checkedAt = useAgentStore((s) => s.checkedAt);
  const statusError = useAgentStore((s) => s.statusError);
  const refreshModels = useAgentStore((s) => s.refreshModels);
  const modelsRefreshing = useAgentStore((s) => s.modelsRefreshing);
  const now = useNow(15_000);
  const result = checkResult(state, statusError, t);
  // A check covers both the connection and the model list.
  const busy = checking || modelsRefreshing;

  // A check also refreshes the model catalog.
  const handleCheck = () => {
    void refreshStatus();
    void refreshModels();
  };
  // Same rule as "Set as Active": usable unless known to be missing or logged out.
  const unusable = state === "not_installed" || state === "npm_only" || state === "logged_out";

  // The same store action as the footer, so both always agree.
  const handleActivate = async () => {
    setActivating(true);
    try {
      await useConfigStore.getState().activateLLMProvider("claude_cli");
    } catch (e) {
      showToast(t("claudeCli.errors.switchFailed", { detail: e instanceof Error ? e.message : String(e) }), "error");
    } finally {
      setActivating(false);
    }
  };

  // After the login terminal opens: re-check on window focus and every few
  // seconds for a while, until the CLI reports a login.
  useEffect(() => {
    if (!awaitingLogin) return;
    if (state === "connected") {
      setAwaitingLogin(false);
      return;
    }
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      refreshStatus();
      if (tries >= LOGIN_POLL_TRIES) setAwaitingLogin(false);
    }, LOGIN_POLL_MS);
    const onFocus = () => refreshStatus();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [awaitingLogin, state, refreshStatus]);

  const handleOpenLogin = async () => {
    try {
      await openClaudeLoginTerminal();
      setAwaitingLogin(true);
    } catch (e) {
      showToast(t("claudeCli.errors.openTerminalFailed", { detail: e instanceof Error ? e.message : String(e) }), "error");
    }
  };

  return (
    <div className="mt-4 space-y-4 border-t border-border/20 pt-4">
      {!active && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-primary/20 bg-primary/5 px-4 py-3">
          <p className="text-xs text-muted-foreground">{t("claudeCli.inactive.hint")}</p>
          <button
            type="button"
            onClick={handleActivate}
            disabled={unusable || activating}
            className={`${BUTTON_CLASS} shrink-0 border-primary/30 text-primary`}
          >
            {activating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t("claudeCli.inactive.useClaude")}
          </button>
        </div>
      )}

      {/* Connection */}
      <div>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground">{statusLine(state, status, t)}</p>
            {status?.installed && (
              <p className="mt-0.5 truncate font-mono text-meta text-muted-foreground/70" title={status.binary_path ?? undefined}>
                {[status.version && `v${status.version}`, status.binary_path].filter(Boolean).join(" — ")}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {!busy && result && checkedAt !== undefined && (
              <span
                role="status"
                className={`max-w-[16rem] truncate text-meta ${result.className}`}
                title={result.text}
              >
                {result.text}
                <span className="text-muted-foreground">
                  {" · "}
                  {t("claudeCli.connection.checkedAgo", { ago: formatCheckedAgo(checkedAt, Math.max(now, checkedAt)) })}
                </span>
              </span>
            )}
            <button type="button" onClick={handleCheck} disabled={busy} className={BUTTON_CLASS}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              {busy ? t("claudeCli.connection.checking") : t("claudeCli.connection.check")}
            </button>
          </div>
        </div>

        {(state === "not_installed" || state === "npm_only") && (
          <div
            className={`mt-3 rounded-lg border px-4 py-3 ${
              state === "npm_only" ? "border-warning/20 bg-warning/5" : "border-border/30 bg-accent/20"
            }`}
          >
            <p className="text-xs text-muted-foreground">
              {state === "npm_only" ? t("claudeCli.install.npmOnly") : t("claudeCli.install.notInstalled")}
            </p>
            <a
              href={CLAUDE_INSTALL_URL}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => {
                e.preventDefault();
                open(CLAUDE_INSTALL_URL).catch((err) =>
                  showToast(
                    t("claudeCli.errors.openBrowserFailed", { detail: err instanceof Error ? err.message : String(err) }),
                    "error",
                  )
                );
              }}
              className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              {t("claudeCli.install.link")}
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        )}

        {(state === "logged_out" || state === "unknown" || state === "api_billed") && (
          <div className="mt-3 rounded-lg border border-warning/20 bg-warning/5 px-4 py-3">
            {state === "api_billed" ? (
              <>
                <p className="text-xs font-medium text-warning">{apiBilledNote()}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t("claudeCli.login.apiBilledDetail")}</p>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">{t("claudeCli.login.hint")}</p>
            )}
            <div className="mt-2.5 flex items-center gap-3">
              <button type="button" onClick={handleOpenLogin} className={BUTTON_CLASS}>
                <Terminal className="h-3.5 w-3.5" />
                {t("claudeCli.login.openTerminal")}
              </button>
              {awaitingLogin && (
                <span className="text-meta text-muted-foreground">{t("claudeCli.login.waiting")}</span>
              )}
            </div>
          </div>
        )}
      </div>

      <ModelSettings />
      <FallbackSettings />
    </div>
  );
}

function ModelSettings() {
  const { t } = useT(["llm", "common"]);
  const config = useConfigStore((s) => s.claudeCliConfig);
  const setConfig = useConfigStore((s) => s.setClaudeCliConfig);
  const sessionRunning = useAgentStore((s) => Object.values(s.sessions).some(isSessionRunning));
  const catalog = useConfigStore((s) => s.claudeModels);
  const modelsError = useAgentStore((s) => s.modelsError);
  const [changed, setChanged] = useState(false);
  // The CLI's catalog; the static aliases only until it was fetched once.
  const models = catalog ?? STATIC_CLAUDE_MODELS;
  const { latest, pinned } = groupClaudeModels(models);

  // The hint is about sessions running now; once they end it no longer applies.
  useEffect(() => {
    if (!sessionRunning) setChanged(false);
  }, [sessionRunning]);

  const update = (patch: Partial<ClaudeCliConfig>) => {
    setConfig({ ...config, ...patch });
    setChanged(true);
  };

  const rows = [
    { tier: "fast", model: "fast_model", effort: "fast_effort", thinking: "fast_thinking" },
    { tier: "deep", model: "deep_model", effort: "deep_effort", thinking: "deep_thinking" },
  ] as const;

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h4 className="text-xs font-semibold text-foreground">{t("claudeCli.models.title")}</h4>
        {changed && sessionRunning ? (
          <span className="text-meta text-muted-foreground">{t("claudeCli.models.appliesNextSession")}</span>
        ) : (
          modelsError && (
            <span className="text-meta text-muted-foreground" title={modelsError}>
              {catalog === null ? t("claudeCli.models.listUnavailable") : t("claudeCli.models.refreshFailed")}
            </span>
          )
        )}
      </div>
      <div className="mt-2 space-y-2">
        {rows.map((row) => {
          const saved = config[row.model];
          const info = findClaudeModel(models, saved);
          const listed = [...latest, ...pinned].some((o) => o.value === saved);
          // Only a fetched catalog can say a model is gone.
          const unavailable = !info && catalog !== null;
          const noEffort = !!info && !info.supports_effort;
          const levels = info ? info.effort_levels : CLAUDE_EFFORTS.map((x) => x.value);
          // Shown as the session will run it; the saved effort is kept as chosen.
          const effort = effectiveEffort(info, config[row.effort]) ?? "";
          const keys = TIER_KEYS[row.tier];
          return (
            <div key={row.tier} className="flex items-start gap-3">
              <div className="w-40 shrink-0 pt-0.5">
                <p className="text-xs font-medium text-foreground">{t(keys.name)}</p>
                <p className="text-meta text-muted-foreground/70">{t(keys.hint)}</p>
              </div>
              <div className="min-w-0 flex-1">
                <select
                  aria-label={t(keys.modelLabel)}
                  value={saved}
                  title={info?.description || undefined}
                  onChange={(e) => update({ [row.model]: e.target.value })}
                  className={`${SELECT_CLASS} w-full ${unavailable ? "border-warning/50" : ""}`}
                >
                  {!listed && <option value={saved}>{info?.display_name || saved}</option>}
                  <optgroup label={t("claudeCli.models.groups.latest")}>
                    {latest.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </optgroup>
                  {pinned.length > 0 && (
                    <optgroup label={t("claudeCli.models.groups.pinned")}>
                      {pinned.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
                {unavailable && <p className="mt-1 text-meta text-warning">{t("claudeCli.models.noLongerAvailable")}</p>}
                <ThinkingToggle
                  tier={row.tier}
                  checked={config[row.thinking]}
                  onChange={(on) => update({ [row.thinking]: on })}
                />
              </div>
              <select
                aria-label={t(keys.effortLabel)}
                value={effort}
                disabled={noEffort}
                title={noEffort ? t("claudeCli.models.effortUnsupported") : undefined}
                onChange={(e) => update({ [row.effort]: e.target.value })}
                className={`${SELECT_CLASS} w-36`}
              >
                {noEffort ? (
                  <option value="">{t("claudeCli.models.effortNotSupported")}</option>
                ) : (
                  levels.map((level) => (
                    <option key={level} value={level}>
                      {effortLabel(level)}
                    </option>
                  ))
                )}
              </select>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Per-tier extended thinking: off answers fastest, on reasons more first. */
function ThinkingToggle({
  tier,
  checked,
  onChange,
}: {
  tier: keyof typeof TIER_KEYS;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  const { t } = useT(["llm", "common"]);
  const hintId = `claude-thinking-hint-${tier}`;
  return (
    <div className="mt-2 flex items-center gap-2.5">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={t(TIER_KEYS[tier].thinkingLabel)}
        aria-describedby={hintId}
        onClick={() => onChange(!checked)}
        className={`relative h-4 w-7 shrink-0 cursor-pointer rounded-full transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
          checked ? "bg-primary" : "bg-muted"
        }`}
      >
        <span
          className={`absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-transform duration-200 ${
            checked ? "translate-x-3" : "translate-x-0"
          }`}
        />
      </button>
      <span className="text-xs text-foreground">{t("claudeCli.thinking.label")}</span>
      <span id={hintId} className="truncate text-meta text-muted-foreground/70">
        {t("claudeCli.thinking.hint")}
      </span>
    </div>
  );
}

function FallbackSettings() {
  const { t } = useT(["llm", "common"]);
  const config = useConfigStore((s) => s.claudeCliConfig);
  const lastModelByProvider = useConfigStore((s) => s.lastModelByProvider);
  const setFallback = useConfigStore((s) => s.setClaudeCliFallback);
  const provider = config.fallback_provider;
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  // The fallback provider's models, for the model picker.
  useEffect(() => {
    setModels([]);
    if (!provider) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const key = await getApiKey(provider).catch(() => null);
        const list = await listModels(JSON.stringify({ provider_type: provider, ...(key && { api_key: key }) }));
        if (!cancelled) setModels(list.map((m) => m.id));
      } catch {
        // No list (server down, no key): the saved model stays, and any id can be typed.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [provider]);

  // The fetched ids, with the saved model first when the list doesn't hold it
  // (not fetched yet, or an id the user typed).
  const modelOptions = useMemo<ModelOption[]>(() => {
    const fetched = models.map((id): ModelOption => ({ id, source: "fetched" }));
    const saved = config.fallback_model;
    return saved && !models.includes(saved) ? [{ id: saved, source: "manual" }, ...fetched] : fetched;
  }, [config.fallback_model, models]);

  return (
    <div>
      <h4 className="text-xs font-semibold text-foreground">{t("claudeCli.fallback.title")}</h4>
      <p className="mt-0.5 text-meta text-muted-foreground/70">{t("claudeCli.fallback.hint")}</p>
      <div className="mt-2 flex items-center gap-3">
        <select
          aria-label={t("claudeCli.fallback.providerLabel")}
          value={provider ?? ""}
          onChange={(e) => {
            const next = e.target.value || null;
            setFallback(next, next ? lastModelByProvider[next] ?? null : null);
          }}
          className={`${SELECT_CLASS} flex-1`}
        >
          <option value="">{t("common:labels.none")}</option>
          {CLAUDE_FALLBACK_PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {FALLBACK_LABELS[p] ?? p}
            </option>
          ))}
        </select>
        <ModelCombobox
          aria-label={t("claudeCli.fallback.modelLabel")}
          placeholder={t("claudeCli.fallback.modelPlaceholder")}
          value={config.fallback_model ?? ""}
          onChange={(m) => setFallback(provider, m || null)}
          options={modelOptions}
          loading={loading}
          disabled={!provider}
          className="min-w-0 flex-1"
        />
      </div>
    </div>
  );
}
