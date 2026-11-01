// Pure helpers for Claude session status and usage, shared by the footer chip,
// the AI Log header and the fallback toast. Text is translated when the helper
// runs (never at module level), so it follows the UI language.

import { formatNumber, t } from "../i18n";
import type { AgentSessionStatus, ClaudeCliStatus, SessionUsage } from "./types";

/**
 * @deprecated A module-level string does not follow a language change. Use
 * `apiBilledNote()`. Kept only for files that still import the constant.
 */
export const API_BILLED_NOTE = "This Claude login bills an API account, not your subscription."; // i18n-ignore

/**
 * @deprecated A module-level string does not follow a language change. Use
 * `npmOnlyNote()`. Kept only for files that still import the constant.
 */
export const NPM_ONLY_NOTE = "Found an npm install of Claude Code — NexQ needs the native installer"; // i18n-ignore

/** Shown wherever a login that bills an API account would read as connected. */
export function apiBilledNote(): string {
  return t("llm:agentUsage.notes.apiBilled");
}

/** Shown when only an npm install of Claude Code (`claude.cmd`) was found. */
export function npmOnlyNote(): string {
  return t("llm:agentUsage.notes.npmOnly");
}

/** The Claude login bills an API account (usable, but not the subscription). */
export function isApiBilled(status: ClaudeCliStatus | undefined | null): boolean {
  return status?.auth?.login === "api_billed";
}

export function formatTokens(n: number): string {
  return formatNumber(Math.round(n));
}

export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.005) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

export const EMPTY_USAGE: SessionUsage = {
  input_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  output_tokens: 0,
  thinking_tokens: 0,
  cost_usd: 0,
  requests: 0,
  total_latency_ms: 0,
  total_first_token_ms: 0,
  last_latency_ms: 0,
  last_request_at_ms: 0,
};

/** Every prompt token: uncached, cache reads and cache writes. */
export function promptTokens(u: Pick<SessionUsage, "input_tokens" | "cache_read_tokens" | "cache_write_tokens">): number {
  return u.input_tokens + (u.cache_read_tokens ?? 0) + (u.cache_write_tokens ?? 0);
}

/** "850 ms" / "1.2 s" / "31 s" / "2 min 5 s" */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return t("llm:agentUsage.duration.milliseconds", { milliseconds: Math.round(ms) });
  const s = ms / 1000;
  if (s < 10) return t("llm:agentUsage.duration.seconds", { seconds: (Math.round(s * 10) / 10).toFixed(1) });
  if (s < 60) return t("llm:agentUsage.duration.seconds", { seconds: Math.round(s) });
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  return rest > 0
    ? t("llm:agentUsage.duration.minutesSeconds", { minutes: m, seconds: rest })
    : t("llm:agentUsage.duration.minutes", { minutes: m });
}

/** "Last answer: 1.2 s total, first words after 600 ms" */
export function lastAnswerTooltip(latencyMs: number, firstTokenMs: number | null): string {
  const total = formatDuration(latencyMs);
  return firstTokenMs != null
    ? t("llm:agentUsage.lastAnswer.totalWithFirstWords", { total, firstWords: formatDuration(firstTokenMs) })
    : t("llm:agentUsage.lastAnswer.total", { total });
}

/** "just now" / "40 s ago" / "2 min ago" / "3 h ago" */
export function formatAgo(atMs: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - atMs) / 1000));
  if (s < 10) return t("llm:agentUsage.ago.justNow");
  if (s < 60) return t("llm:agentUsage.ago.seconds", { seconds: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t("llm:agentUsage.ago.minutes", { minutes: m });
  return t("llm:agentUsage.ago.hours", { hours: Math.floor(m / 60) });
}

/** Average wall time per answered request (ms), or null before the first one. */
export function avgLatencyMs(u: SessionUsage): number | null {
  return u.requests > 0 ? u.total_latency_ms / u.requests : null;
}

/** Average time to the first words per answered request (ms), or null. */
export function avgFirstTokenMs(u: SessionUsage): number | null {
  return u.requests > 0 ? u.total_first_token_ms / u.requests : null;
}

/** "45,210 in (38,000 cached)": every prompt token, and how many came from the cache. */
export function formatPromptTokens(u: Pick<SessionUsage, "input_tokens" | "cache_read_tokens" | "cache_write_tokens">): string {
  const cached = u.cache_read_tokens ?? 0;
  const tokens = formatTokens(promptTokens(u));
  return cached > 0
    ? t("llm:agentUsage.promptTokens.cached", { tokens, cached: formatTokens(cached) })
    : t("llm:agentUsage.promptTokens.plain", { tokens });
}

/** "in 45,210 (38,000 cached) · out 1,240 (thinking 300)" */
export function formatTokenUsage(u: SessionUsage): string {
  const cached = u.cache_read_tokens ?? 0;
  const thinking = u.thinking_tokens ?? 0;
  const tokensIn = formatTokens(promptTokens(u));
  const tokensOut = formatTokens(u.output_tokens);
  const input =
    cached > 0
      ? t("llm:agentUsage.tokenUsage.inCached", { tokens: tokensIn, cached: formatTokens(cached) })
      : t("llm:agentUsage.tokenUsage.in", { tokens: tokensIn });
  const output =
    thinking > 0
      ? t("llm:agentUsage.tokenUsage.outThinking", { tokens: tokensOut, thinking: formatTokens(thinking) })
      : t("llm:agentUsage.tokenUsage.out", { tokens: tokensOut });
  return `${input} · ${output}`;
}

/** "3 requests · 45,210 in (38,000 cached) / 1,240 out · avg 1.4 s" */
export function formatUsageSummary(u: SessionUsage): string {
  const parts = [
    t("llm:agentUsage.summary.requests", { count: u.requests }),
    t("llm:agentUsage.summary.tokens", { prompt: formatPromptTokens(u), output: formatTokens(u.output_tokens) }),
  ];
  const avg = avgLatencyMs(u);
  if (avg != null) parts.push(t("llm:agentUsage.summary.average", { duration: formatDuration(avg) }));
  return parts.join(" · ");
}

/** The cost line shown wherever usage appears. */
export function formatCostEstimate(u: SessionUsage, apiBilled = false): string {
  const cost = formatCost(u.cost_usd);
  return apiBilled
    ? t("llm:agentUsage.costEstimate.apiBilled", { cost })
    : t("llm:agentUsage.costEstimate.subscription", { cost });
}

/** Live-scope sessions of one meeting (fast and/or deep). */
export function liveSessionsOf(
  sessions: Record<string, AgentSessionStatus>,
  meetingId: string | null,
): AgentSessionStatus[] {
  if (!meetingId) return [];
  return Object.values(sessions).filter((s) => s.scope === "live" && s.meeting_id === meetingId);
}

/** Cumulative fields of `SessionUsage` (only ever grow within a scope). */
const CUMULATIVE: Array<Exclude<keyof SessionUsage, "last_latency_ms" | "last_request_at_ms">> = [
  "input_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "output_tokens",
  "thinking_tokens",
  "cost_usd",
  "requests",
  "total_latency_ms",
  "total_first_token_ms",
];

/**
 * Cumulative usage of a meeting. Every session carries the usage of its whole
 * scope (both tiers), snapshotted when that session last changed, so tiers are
 * not summed: the larger snapshot per field is the latest one. The "last
 * request" fields come from the snapshot that saw the latest request.
 */
export function scopeUsage(list: AgentSessionStatus[]): SessionUsage {
  return list.reduce<SessionUsage>((acc, s) => {
    const u = { ...EMPTY_USAGE, ...s.usage };
    const next = { ...acc };
    for (const field of CUMULATIVE) next[field] = Math.max(acc[field], u[field]);
    if (u.last_request_at_ms > acc.last_request_at_ms) {
      next.last_request_at_ms = u.last_request_at_ms;
      next.last_latency_ms = u.last_latency_ms;
    }
    return next;
  }, { ...EMPTY_USAGE });
}

/** Text fallback for a limit error when the backend sent no `error_kind`. */
export function isRateLimitText(text: string | null | undefined): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    lower.includes("rate limit") ||
    lower.includes("usage limit") ||
    (lower.includes("limit reached") && !lower.includes("context")) ||
    lower.includes("too many requests") ||
    lower.includes("per minute")
  );
}

/** The session stopped on a usage / rate limit (not a fault). */
export function isRateLimited(s: Pick<AgentSessionStatus, "error_kind" | "detail">): boolean {
  return s.error_kind != null ? s.error_kind === "rate_limited" : isRateLimitText(s.detail);
}
