// Index status of the knowledge base: counts, whether vector search is
// usable, the "rebuild needed" banner (nothing is re-embedded without the
// user's confirmation), live progress with a stop button, and the
// update / rebuild / clear actions.

import { useState } from "react";
import { AlertTriangle, CheckCircle2, Info, Loader2, RefreshCw, Square, Trash2, XCircle } from "lucide-react";
import { formatDate, formatNumber, useT } from "../../i18n";
import type { IndexInfo, IndexProgressEvent, VectorState } from "../../lib/rag/types";
import { useRagStore } from "../../stores/ragStore";

const BUTTON =
  "inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50";

const STATE_STYLE: Record<VectorState, string> = {
  ready: "bg-success/10 text-success",
  empty: "bg-muted/60 text-muted-foreground",
  loading: "bg-primary/10 text-primary",
  stale: "bg-amber-500/10 text-amber-500",
  unconfigured: "bg-muted/60 text-muted-foreground",
  unavailable: "bg-destructive/10 text-destructive",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${formatNumber(Math.round(bytes / 1024))} KB`;
  return `${formatNumber(bytes / (1024 * 1024), { maximumFractionDigits: 1 })} MB`;
}

export function IndexSection() {
  const { t } = useT(["rag", "common"]);
  const info = useRagStore((s) => s.indexInfo);
  const progress = useRagStore((s) => s.progress);
  const isIndexing = useRagStore((s) => s.isIndexing);
  const syncIndex = useRagStore((s) => s.syncIndex);
  const rebuild = useRagStore((s) => s.rebuildWithCurrentSettings);
  const cancelIndexing = useRagStore((s) => s.cancelIndexing);
  const clearIndex = useRagStore((s) => s.clearIndex);
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  if (!info) return null;

  const busy = isIndexing || !!progress;
  const hasIndex = info.chunks > 0;

  const handleRebuild = () => {
    if (!confirmRebuild) {
      setConfirmRebuild(true);
      setTimeout(() => setConfirmRebuild(false), 5000);
      return;
    }
    setConfirmRebuild(false);
    void rebuild();
  };

  const handleClear = () => {
    if (!confirmClear) {
      setConfirmClear(true);
      setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    setConfirmClear(false);
    void clearIndex();
  };

  return (
    <div
      className={`rounded-xl border bg-card/50 p-5 ${
        info.needs_rebuild ? "border-amber-500/40 ring-1 ring-amber-500/10" : "border-border/30"
      }`}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-primary/80">{t("index.title")}</h3>
        <span className={`rounded-full px-2.5 py-1 text-meta font-medium ${STATE_STYLE[info.vector_state]}`}>
          {t(`index.state.${info.vector_state}`)}
        </span>
      </div>

      {info.store_error && (
        <p className="mb-3 flex items-start gap-1.5 text-xs text-destructive">
          <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t("index.storeError", { detail: info.store_error })}
        </p>
      )}

      {info.needs_rebuild && <RebuildBanner info={info} confirm={confirmRebuild} busy={busy} onRebuild={handleRebuild} />}

      <div className="grid grid-cols-2 gap-3 text-xs">
        <Stat label={t("index.stats.documents")} value={`${formatNumber(info.documents_indexed)} / ${formatNumber(info.documents)}`} />
        <Stat label={t("index.stats.chunks")} value={formatNumber(info.chunks)} />
        <Stat
          label={t("index.stats.vectors")}
          value={formatNumber(info.vectors)}
          detail={info.active_space ? `${info.active_space.model} · ${t("index.stats.dims", { dims: info.active_space.dims })}` : undefined}
        />
        <Stat
          label={t("index.stats.tokens")}
          value={info.tokens ? `~${formatNumber(Math.round(info.tokens / 1000))}k` : "0"}
        />
        <Stat
          label={t("index.stats.lastIndexed")}
          value={info.last_indexed_at ? formatDate(info.last_indexed_at, { dateStyle: "short", timeStyle: "short" }) : t("index.stats.never")}
        />
        <Stat label={t("index.stats.memory")} value={formatBytes(info.memory_bytes)} />
      </div>

      {info.pending_vectors > 0 && !info.needs_rebuild && info.vector_state !== "unconfigured" && !busy && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Info className="h-3.5 w-3.5" />
          {t("index.pending", { count: info.pending_vectors })}
        </p>
      )}
      {info.vector_state === "unconfigured" && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Info className="h-3.5 w-3.5" />
          {t("index.unconfiguredHint")}
        </p>
      )}

      {busy && <ProgressView progress={progress} onCancel={() => void cancelIndexing()} />}

      {!busy && info.last_error && (
        <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs">
          <p className="font-medium text-destructive">{t("index.lastError")}</p>
          <p className="mt-0.5 select-text break-words text-foreground/80">{info.last_error.message}</p>
        </div>
      )}
      {!busy && info.last_job && !info.last_error && <LastJob info={info} />}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void syncIndex()} disabled={busy} className={BUTTON}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          {hasIndex ? t("index.actions.sync") : t("index.actions.build")}
        </button>
        {!info.needs_rebuild && hasIndex && (
          <button type="button" onClick={handleRebuild} disabled={busy} className={BUTTON}>
            <RefreshCw className="h-3.5 w-3.5" />
            {confirmRebuild ? t("index.actions.confirmRebuild") : t("index.actions.rebuild")}
          </button>
        )}
        <button
          type="button"
          onClick={handleClear}
          disabled={busy}
          className={`${BUTTON} ${confirmClear ? "border-destructive/50 bg-destructive/10 text-destructive hover:bg-destructive/20" : ""}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
          {confirmClear ? t("index.actions.confirmClear") : t("index.actions.clear")}
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-lg bg-accent/20 px-3 py-2.5">
      <span className="text-muted-foreground">{label}</span>
      <p className="mt-0.5 truncate text-sm font-medium text-foreground">{value}</p>
      {detail && <p className="truncate text-meta text-muted-foreground">{detail}</p>}
    </div>
  );
}

function RebuildBanner({
  info,
  confirm,
  busy,
  onRebuild,
}: {
  info: IndexInfo;
  confirm: boolean;
  busy: boolean;
  onRebuild: () => void;
}) {
  const { t } = useT("rag");
  const modelChanged = info.rebuild_reasons.includes("model_changed");
  const dimsChanged = info.rebuild_reasons.includes("dimensions_changed");
  return (
    <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3.5 py-3 text-xs">
      <p className="flex items-start gap-1.5 font-medium text-amber-600 dark:text-amber-400">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {t("index.banner.title")}
      </p>
      <ul className="mt-1.5 space-y-1 pl-5 text-foreground/80">
        {modelChanged && <li>{t("index.banner.modelChanged")}</li>}
        {dimsChanged && <li>{t("index.banner.dimensionsChanged")}</li>}
        {info.stale_documents > 0 && <li>{t("index.banner.chunkingChanged", { count: info.stale_documents })}</li>}
      </ul>
      {(modelChanged || dimsChanged) && info.pending_vectors > 0 && (
        <p className="mt-1.5 pl-5 text-muted-foreground">{t("index.banner.cost", { count: info.pending_vectors })}</p>
      )}
      <div className="mt-2.5 pl-5">
        <button
          type="button"
          onClick={onRebuild}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-600 hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-50 dark:text-amber-400"
        >
          <RefreshCw className="h-3 w-3" />
          {confirm ? t("index.actions.confirmRebuild") : t("index.actions.rebuild")}
        </button>
      </div>
    </div>
  );
}

function ProgressView({ progress, onCancel }: { progress: IndexProgressEvent | null; onCancel: () => void }) {
  const { t } = useT("rag");
  const status = progress?.status ?? "scanning";
  const embedding = status === "embedding" || status === "paused";
  const total = embedding ? progress?.chunks_total ?? 0 : progress?.files_total ?? 0;
  const done = embedding ? progress?.chunks_done ?? 0 : progress?.files_done ?? 0;
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const label =
    status === "extracting" && progress?.file_name
      ? t("index.progress.extracting", { name: progress.file_name })
      : status === "summarizing" && progress?.file_name
        ? t("index.progress.summarizing", { name: progress.file_name, chapter: progress.message ?? "" })
        : status === "embedding"
          ? t("index.progress.embedding")
          : status === "paused"
            ? t("index.progress.paused")
            : t("index.progress.scanning");
  return (
    <div className="mt-3 space-y-1.5">
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="flex min-w-0 items-center gap-1.5">
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" />
          <span className="truncate">{label}</span>
        </span>
        <span className="shrink-0 font-mono">
          {embedding
            ? t("index.progress.chunks", { done: formatNumber(done), total: formatNumber(total) })
            : t("index.progress.files", { done: formatNumber(done), total: formatNumber(total) })}
          {(progress?.chunks_reused ?? 0) > 0 && ` · ${t("index.progress.reused", { count: progress?.chunks_reused ?? 0 })}`}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <div className="h-1.5 flex-1 rounded-full bg-muted/40">
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${percent}%` }} />
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center gap-1 rounded-md border border-border/50 px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Square className="h-2.5 w-2.5" />
          {t("index.actions.stop")}
        </button>
      </div>
    </div>
  );
}

function LastJob({ info }: { info: IndexInfo }) {
  const { t } = useT("rag");
  const job = info.last_job;
  if (!job || (job.vectors_embedded === 0 && job.chunks_inserted === 0 && job.files_failed === 0)) return null;
  return (
    <div className="mt-3 space-y-1 text-xs text-muted-foreground">
      <p className="flex items-center gap-1.5">
        <CheckCircle2 className="h-3.5 w-3.5 text-success" />
        {t("index.lastJob", {
          embedded: formatNumber(job.vectors_embedded),
          reused: formatNumber(job.chunks_kept + job.vectors_reused),
          skipped: formatNumber(job.files_skipped),
        })}
      </p>
      {job.files_failed > 0 && (
        <details>
          <summary className="cursor-pointer text-amber-500">{t("index.failures", { count: job.files_failed })}</summary>
          <ul className="mt-1 space-y-0.5 pl-4">
            {job.failures.map((f) => (
              <li key={f.resource_id} className="select-text break-words">
                {f.name}: {f.error}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
