// Small pieces the first-run steps share: the step heading and status marks.

import type { ReactNode } from "react";
import { AlertCircle, CheckCircle2, CircleDashed, MinusCircle } from "lucide-react";
import { useT } from "../../i18n";
import type { StepStatus } from "../../lib/onboarding/progress";

export function StepHeader({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
  return (
    <div className="mb-7 flex items-start gap-4">
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
        {icon}
      </div>
      <div className="min-w-0">
        <h2 className="text-xl font-semibold text-foreground">{title}</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

/** A step's status as an icon (null while the step is just "not done"). */
export function StatusIcon({ status, className = "h-4 w-4" }: { status: StepStatus; className?: string }) {
  switch (status) {
    case "ok":
      return <CheckCircle2 className={`${className} text-success`} aria-hidden />;
    case "error":
      return <AlertCircle className={`${className} text-destructive`} aria-hidden />;
    case "skipped":
      return <MinusCircle className={`${className} text-muted-foreground/70`} aria-hidden />;
    case "incomplete":
      return <CircleDashed className={`${className} text-muted-foreground/70`} aria-hidden />;
    default:
      return null;
  }
}

/** Where the current step stands, under its content. */
export function StepStatusNote({ status, detail }: { status: Exclude<StepStatus, "pending">; detail?: string }) {
  const { t } = useT("onboarding");
  const note =
    status === "error"
      ? detail
        ? t("stepNote.error", { detail })
        : t("stepNote.errorNoDetail")
      : t(`stepNote.${status}`);
  return (
    <div
      role="status"
      className={`mt-4 flex items-start gap-2 rounded-lg px-3 py-2 text-xs ${
        status === "ok"
          ? "bg-success/5 text-success"
          : status === "error"
            ? "bg-destructive/5 text-destructive"
            : "bg-muted/40 text-muted-foreground"
      }`}
    >
      <StatusIcon status={status} className="mt-px h-3.5 w-3.5 shrink-0" />
      <span>{note}</span>
    </div>
  );
}

const BADGE_TONE: Record<StepStatus, string> = {
  ok: "bg-success/10 text-success",
  error: "bg-destructive/10 text-destructive",
  skipped: "bg-muted text-muted-foreground",
  incomplete: "bg-warning/10 text-warning",
  pending: "bg-muted text-muted-foreground/70",
};

export function StatusBadge({ status }: { status: StepStatus }) {
  const { t } = useT("onboarding");
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-meta font-medium ${BADGE_TONE[status]}`}>
      <StatusIcon status={status} className="h-3 w-3" />
      {t(`status.${status}`)}
    </span>
  );
}
