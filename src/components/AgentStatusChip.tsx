// Footer chip for the Claude subscription provider: a status dot, the live
// session's state during a meeting, and a hover card with login state, model,
// effort and thinking per tier, and the meeting's usage and response times.
// Rendered by ServiceStatusBar in both windows.

import { useEffect, useId, useState, type ReactNode } from "react";
import { Brain, ChevronUp } from "lucide-react";
import type { ParseKeys, TFunction } from "i18next";
import { useT } from "../i18n";
import { useAgentStore } from "../stores/agentStore";
import { useConfigStore } from "../stores/configStore";
import { useMeetingAgentUsage } from "../hooks/useMeetingAgentUsage";
import {
  apiBilledNote,
  avgFirstTokenMs,
  avgLatencyMs,
  formatAgo,
  formatCostEstimate,
  formatDuration,
  formatTokenUsage,
  isApiBilled,
  isRateLimited,
  npmOnlyNote,
} from "../lib/agentUsage";
import { claudeTierLabel } from "../settings/ClaudeCliSettings";
import type { AgentSessionStatus, ClaudeCliConfig, ClaudeCliStatus, ClaudeModelInfo, SessionUsage } from "../lib/types";

export type AgentChipState = "idle" | "starting" | "ready" | "busy" | "error" | "limited" | "attention";

type T = TFunction<["llm", "common"]>;

/** Product name: the same in every UI language. */
const CLAUDE = "Claude"; // i18n-ignore

// Color carries the state: green ready, amber starting / busy / needs the
// user / limit hit, red error, neutral unknown. Only starting and busy pulse.
const STATE_STYLE: Record<AgentChipState, { dot: string; pill: string; pulse: boolean }> = {
  ready: { dot: "bg-success", pill: "bg-success/10 border border-success/20", pulse: false },
  starting: { dot: "bg-warning", pill: "bg-warning/10 border border-warning/20", pulse: true },
  busy: { dot: "bg-warning", pill: "bg-warning/10 border border-warning/20", pulse: true },
  limited: { dot: "bg-warning", pill: "bg-warning/10 border border-warning/20", pulse: false },
  attention: { dot: "bg-warning", pill: "bg-warning/10 border border-warning/20", pulse: false },
  error: { dot: "bg-destructive", pill: "bg-destructive/10 border border-destructive/20", pulse: false },
  idle: { dot: "bg-muted-foreground/30", pill: "bg-secondary/30 border border-transparent", pulse: false },
};

// Tables hold keys, translated when shown, so they follow a language change.
const SESSION_STATE_KEY = {
  starting: "agentChip.sessionState.starting",
  ready: "agentChip.sessionState.ready",
  busy: "agentChip.sessionState.busy",
  error: "agentChip.sessionState.error",
  closed: "agentChip.sessionState.closed",
} as const satisfies Record<AgentSessionStatus["state"], ParseKeys<"llm">>;

const TIER_KEY = {
  fast: "agentChip.tiers.fast",
  deep: "agentChip.tiers.deep",
} as const satisfies Record<"fast" | "deep", ParseKeys<"llm">>;

function sessionState(sessions: AgentSessionStatus[], t: T): { state: AgentChipState; label: string } {
  const errors = sessions.filter((s) => s.state === "error");
  if (errors.length > 0) {
    // A real fault outranks a limit on the other tier.
    return errors.every(isRateLimited)
      ? { state: "limited", label: t("agentChip.session.usageLimit") }
      : { state: "error", label: t("agentChip.session.error") };
  }
  if (sessions.some((s) => s.state === "busy")) return { state: "busy", label: t("agentChip.session.thinking") };
  if (sessions.some((s) => s.state === "starting")) return { state: "starting", label: t("agentChip.session.starting") };
  return { state: "ready", label: t("agentChip.session.ready") };
}

function providerState(
  status: ClaudeCliStatus | undefined,
  statusError: string | undefined,
  t: T,
): { state: AgentChipState; label: string } {
  if (!status) return { state: "idle", label: statusError ? "" : t("agentChip.provider.checking") };
  if (!status.installed) {
    return {
      state: "attention",
      label: status.npm_only ? t("agentChip.provider.needsNativeInstall") : t("agentChip.provider.notInstalled"),
    };
  }
  if (!status.auth) return { state: "idle", label: "" };
  if (!status.auth.logged_in) return { state: "attention", label: t("agentChip.provider.notLoggedIn") };
  // Usable, but never green: it doesn't use the subscription.
  if (isApiBilled(status)) return { state: "attention", label: t("agentChip.provider.apiAccount") };
  return { state: "ready", label: t("common:status.ready") };
}

function providerNote(status: ClaudeCliStatus | undefined, t: T): string {
  if (status && !status.installed) return status.npm_only ? npmOnlyNote() : t("agentChip.notes.notInstalled");
  if (status?.auth && !status.auth.logged_in) return t("agentChip.notes.notLoggedIn");
  return "";
}

/** "Signed in · Max plan" / "Not logged in" / "" when unknown. The plan name is the backend's, capitalized. */
function loginLine(status: ClaudeCliStatus | undefined, t: T): string {
  if (!status?.installed || !status.auth) return "";
  if (!status.auth.logged_in) return t("agentChip.login.notLoggedIn");
  const plan = status.auth.subscription_type;
  return plan
    ? t("agentChip.login.signedInPlan", { plan: `${plan.charAt(0).toUpperCase()}${plan.slice(1)}` })
    : t("agentChip.login.signedIn");
}

interface TierRow {
  tier: "fast" | "deep";
  label: string;
  thinking: boolean;
  state: AgentSessionStatus["state"] | null;
}

function tierRows(sessions: AgentSessionStatus[], cfg: ClaudeCliConfig, models?: ClaudeModelInfo[]): TierRow[] {
  return (["fast", "deep"] as const).map((tier) => {
    const s = sessions.find((x) => x.tier === tier);
    const effort = tier === "fast" ? cfg.fast_effort : cfg.deep_effort;
    const model = s?.model ?? (tier === "fast" ? cfg.fast_model : cfg.deep_model);
    return {
      tier,
      label: claudeTierLabel(model, effort, models),
      thinking: tier === "fast" ? cfg.fast_thinking : cfg.deep_thinking,
      state: s?.state ?? null,
    };
  });
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right tabular-nums text-foreground/90">{children}</dd>
    </div>
  );
}

function HoverCard({
  id,
  sessions,
  usage,
  cfg,
  status,
  note,
  apiBilled,
  models,
}: {
  id: string;
  sessions: AgentSessionStatus[];
  usage: SessionUsage;
  cfg: ClaudeCliConfig;
  status: ClaudeCliStatus | undefined;
  note: string;
  apiBilled: boolean;
  models?: ClaudeModelInfo[];
}) {
  const { t } = useT(["llm", "common"]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const inSession = sessions.length > 0;
  const login = loginLine(status, t);
  const detail = sessions.find((s) => s.state === "error" && s.detail)?.detail;
  const avg = avgLatencyMs(usage);
  const avgFirst = avgFirstTokenMs(usage);

  return (
    <div
      id={id}
      role="tooltip"
      data-testid="agent-hover-card"
      className="absolute bottom-full left-0 z-50 mb-2 w-72 rounded-xl border border-border/40 bg-popover p-3 text-meta shadow-lg animate-in fade-in-0 slide-in-from-bottom-1 duration-150"
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-semibold text-foreground">
          {apiBilled ? t("agentChip.hoverCard.titleApiAccount") : t("agentChip.hoverCard.titleSubscription")}
        </span>
        {login && <span className="truncate text-muted-foreground">{login}</span>}
      </div>
      {apiBilled && <p className="mt-1 text-warning">{apiBilledNote()}</p>}

      <dl className="mt-2.5 space-y-1">
        {tierRows(sessions, cfg, models).map((row) => (
          <Row key={row.tier} label={t(TIER_KEY[row.tier])}>
            {row.label} · {row.thinking ? t("agentChip.hoverCard.thinkingOn") : t("agentChip.hoverCard.thinkingOff")}
            {row.state && <span className="text-muted-foreground"> · {t(SESSION_STATE_KEY[row.state])}</span>}
          </Row>
        ))}
      </dl>

      {inSession && (
        <dl className="mt-2.5 space-y-1 border-t border-border/30 pt-2.5">
          <Row label={t("agentChip.hoverCard.requests")}>{usage.requests}</Row>
          {usage.requests > 0 && usage.last_request_at_ms > 0 && (
            <Row label={t("agentChip.hoverCard.lastRequest")}>
              {formatAgo(usage.last_request_at_ms, Math.max(now, usage.last_request_at_ms))} ·{" "}
              {formatDuration(usage.last_latency_ms)}
            </Row>
          )}
          {avg != null && (
            <Row label={t("agentChip.hoverCard.averageResponse")}>
              {formatDuration(avg)}
              {avgFirst != null && (
                <span className="text-muted-foreground">
                  {" · "}
                  {t("agentChip.hoverCard.firstWords", { duration: formatDuration(avgFirst) })}
                </span>
              )}
            </Row>
          )}
          <Row label={t("agentChip.hoverCard.tokens")}>{formatTokenUsage(usage)}</Row>
          <p className="pt-0.5 text-muted-foreground">{formatCostEstimate(usage, apiBilled)}</p>
        </dl>
      )}

      {(detail || note) && (
        <p className={`mt-2.5 border-t border-border/30 pt-2.5 ${detail ? "text-destructive" : "text-muted-foreground"}`}>
          {detail ?? note}
        </p>
      )}
    </div>
  );
}

export function AgentStatusChip({
  compact = false,
  onClick,
  pickerOpen = false,
}: {
  compact?: boolean;
  onClick?: () => void;
  pickerOpen?: boolean;
}) {
  const { t } = useT(["llm", "common"]);
  const status = useAgentStore((s) => s.status);
  const statusError = useAgentStore((s) => s.statusError);
  const cfg = useConfigStore((s) => s.claudeCliConfig);
  const claudeModels = useConfigStore((s) => s.claudeModels);
  const { sessions, usage } = useMeetingAgentUsage();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const cardId = useId();

  // Session updates only arrive once the store has subscribed (per window).
  useEffect(() => {
    const store = useAgentStore.getState();
    store.init();
    if (!store.status) void store.refreshStatus();
  }, []);

  // Closed sessions are dropped from the store, so any session here is open.
  const inSession = sessions.length > 0;
  const apiBilled = isApiBilled(status);
  const chip = inSession ? sessionState(sessions, t) : providerState(status, statusError, t);
  // An API-billed login is never shown green, in a session or not.
  const state: AgentChipState = apiBilled && chip.state === "ready" ? "attention" : chip.state;
  const label = chip.label;
  const style = STATE_STYLE[state];
  // The picker replaces the card while it is open.
  const cardOpen = (hovered || focused) && !dismissed && !pickerOpen;

  return (
    <div
      className="relative"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setDismissed(false);
      }}
    >
      <div
        data-testid="agent-status-chip"
        role={onClick ? "button" : undefined}
        tabIndex={0}
        aria-label={label ? t("agentChip.ariaLabelWithState", { state: label }) : t("agentChip.ariaLabel")}
        aria-describedby={cardOpen ? cardId : undefined}
        aria-expanded={onClick ? pickerOpen : undefined}
        className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-primary/40 ${style.pill} ${
          onClick ? "cursor-pointer hover:brightness-110" : ""
        }`}
        onClick={onClick}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          setDismissed(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setDismissed(true);
          else if (onClick && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            onClick();
          }
        }}
      >
        <span className="relative flex h-2 w-2 shrink-0">
          {style.pulse && (
            <span className={`absolute inline-flex h-full w-full animate-pulse rounded-full ${style.dot} opacity-40`} />
          )}
          <span
            data-testid="agent-status-dot"
            data-state={state}
            className={`relative inline-flex h-2 w-2 rounded-full transition-colors duration-200 ${style.dot}`}
          />
        </span>
        <Brain className={`h-3.5 w-3.5 shrink-0 ${state === "idle" ? "text-muted-foreground/60" : "text-foreground/70"}`} />
        <div className="flex min-w-0 items-center gap-1">
          {!compact && <span className="text-xs font-medium text-foreground/90">{CLAUDE}</span>}
          {label && (
            <span className={`truncate ${compact ? "text-xs font-medium text-foreground/90" : "text-meta text-foreground/60"}`}>
              {label}
            </span>
          )}
        </div>
        {onClick && (
          <ChevronUp
            className={`h-2.5 w-2.5 shrink-0 transition-all duration-200 ${
              pickerOpen ? "rotate-0 text-foreground/60" : "rotate-180 text-muted-foreground/50"
            }`}
          />
        )}
      </div>
      {cardOpen && (
        <HoverCard
          id={cardId}
          sessions={sessions}
          usage={usage}
          cfg={cfg}
          status={status}
          note={inSession ? "" : providerNote(status, t)}
          apiBilled={apiBilled}
          models={claudeModels ?? undefined}
        />
      )}
    </div>
  );
}
