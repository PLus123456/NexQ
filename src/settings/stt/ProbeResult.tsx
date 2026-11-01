// The outcome of testing Remote Whisper or Soniox (`probe*`): a localized
// message per `code`, then the HTTP status, the URL tried, the latency and
// the server's raw answer.

import { AlertTriangle, CheckCircle, XCircle } from "lucide-react";
import { t, useT } from "../../i18n";
import type { SttProbeCode, SttProbeResult } from "../../lib/stt/types";

export type ProbeEngine = "openai_compat" | "soniox";
export type ProbeTone = "success" | "warning" | "error";

const PROBE_CODES: readonly SttProbeCode[] = [
  "ok",
  "no_base_url",
  "invalid_url",
  "no_key",
  "unauthorized",
  "forbidden",
  "not_found",
  "http_error",
  "timeout",
  "network",
  "bad_response",
];

function isProbeCode(code: string): code is SttProbeCode {
  return (PROBE_CODES as readonly string[]).includes(code);
}

/**
 * Whether the engine can be used after this test. A Soniox key without the
 * "list models" permission (403) still runs real-time recognition.
 */
export function probeUsable(engine: ProbeEngine, result: SttProbeResult): boolean {
  return result.ok || (engine === "soniox" && result.code === "forbidden");
}

export function probeTone(engine: ProbeEngine, result: SttProbeResult): ProbeTone {
  if (result.ok) return "success";
  return probeUsable(engine, result) ? "warning" : "error";
}

/** What the result means, in the UI language. */
export function probeMessage(engine: ProbeEngine, result: SttProbeResult): string {
  const count = result.models.length;
  if (engine === "soniox") {
    switch (result.code) {
      case "ok":
        return count > 0 ? t("stt:probe.soniox.okModels", { count }) : t("stt:probe.soniox.ok");
      case "no_key":
        return t("stt:probe.soniox.noKey");
      case "unauthorized":
        return t("stt:probe.soniox.unauthorized");
      case "forbidden":
        return t("stt:probe.soniox.forbidden");
    }
  } else if (result.code === "ok") {
    return count > 0 ? t("stt:probe.codes.okModels", { count }) : t("stt:probe.codes.ok");
  }
  return isProbeCode(result.code)
    ? t(`stt:probe.codes.${result.code}`)
    : t("stt:probe.unknownCode", { code: String(result.code) });
}

const TONE_CLASS: Record<ProbeTone, string> = {
  success: "text-success",
  warning: "text-warning",
  error: "text-destructive",
};

/** A finished test: `result`, or `error` when the test itself couldn't run. */
export function ProbeResultView({
  engine,
  result,
  error,
}: {
  engine: ProbeEngine;
  result: SttProbeResult | null;
  error?: string | null;
}) {
  const { t } = useT(["stt", "common"]);
  if (!result) {
    if (!error) return null;
    return (
      <p role="status" className="flex items-start gap-1.5 text-xs text-destructive">
        <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 break-words">{t("common:errors.testFailed", { detail: error })}</span>
      </p>
    );
  }
  const tone = probeTone(engine, result);
  const Icon = tone === "success" ? CheckCircle : tone === "warning" ? AlertTriangle : XCircle;
  const facts = [
    result.status != null ? t("stt:probe.status", { status: result.status }) : null,
    t("stt:probe.latency", { ms: result.latency_ms }),
  ].filter(Boolean);

  return (
    <div role="status" className="space-y-1.5">
      <p className={`flex items-start gap-1.5 text-xs font-medium ${TONE_CLASS[tone]}`}>
        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="min-w-0">{probeMessage(engine, result)}</span>
      </p>
      <p className="text-meta text-muted-foreground">{facts.join(" · ")}</p>
      {result.url && (
        <p className="text-meta text-muted-foreground">
          {t("stt:probe.url")}{" "}
          <code className="select-text break-all font-mono text-foreground/80">{result.url}</code>
        </p>
      )}
      {result.detail && (
        <div>
          <p className="text-meta text-muted-foreground">{t("stt:probe.detail")}</p>
          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border/30 bg-background/60 px-2.5 py-1.5 font-mono text-[11px] text-foreground/80 select-text">
            {result.detail}
          </pre>
        </div>
      )}
    </div>
  );
}
