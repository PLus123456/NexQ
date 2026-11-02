import {
  Github,
  FileText,
  AlertCircle,
  HelpCircle,
  FolderOpen,
  Copy,
  Check,
} from "lucide-react";
import type { TFunction } from "i18next";
import { arch } from "@tauri-apps/plugin-os";
import { NEXQ_VERSION, NEXQ_BUILD_DATE, NEXQ_DEVELOPER } from "../lib/version";
import { useEffect, useState } from "react";
import { getLogInfo, getRecentLogs, openLogFolder, setVerboseLogging } from "../lib/ipc";
import type { LogInfo } from "../lib/types";
import { APP_NAME, REPO_URL, UPDATER_ENABLED, UPSTREAM_URL } from "../lib/brand";
import { currentPlatform, type Platform } from "../lib/platform";
import { Trans, formatDate, useT } from "../i18n";
import { persistValue } from "../stores/configStore";
import { showToast } from "../stores/toastStore";
import { useUpdaterStore } from "../stores/updaterStore";
import {
  checkForUpdates,
  downloadUpdateNow,
  hydrateUpdater,
  restartToUpdate,
  setAutoUpdate,
  skipVersion,
} from "../hooks/useUpdater";
import { open } from "@tauri-apps/plugin-shell";

/** OS names are product names: the same in every UI language. */
const PLATFORM_NAMES: Partial<Record<Platform, string>> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
};

/** CPU architecture of this build ("aarch64", "x86_64"…); "—" outside the app (tests, browser). */
function cpuArchitecture(): string {
  try {
    return arch();
  } catch {
    return "—";
  }
}

/** "just now", "5 min ago", "2h ago". */
function timeSince(ms: number, t: TFunction<"settings">): string {
  const secs = Math.floor((Date.now() - ms) / 1000);
  if (secs < 60) return t("about.updates.timeSince.justNow");
  if (secs < 3600) return t("about.updates.timeSince.minutes", { count: Math.floor(secs / 60) });
  return t("about.updates.timeSince.hours", { count: Math.floor(secs / 3600) });
}

/** The app log: where it is, a copy of its end for bug reports, verbose mode. */
function Diagnostics() {
  const { t } = useT(["settings", "common"]);
  const [info, setInfo] = useState<LogInfo | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    getLogInfo().then(setInfo).catch(() => setInfo(null));
  }, []);

  const copyRecent = async () => {
    try {
      await navigator.clipboard.writeText(await getRecentLogs(400));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      showToast(
        t("about.diagnostics.copyFailed", { detail: err instanceof Error ? err.message : String(err) }),
        "error",
      );
    }
  };

  const toggleVerbose = async () => {
    if (!info) return;
    const verbose = !info.verbose;
    await setVerboseLogging(verbose);
    persistValue("verboseLogging", verbose);
    setInfo({ ...info, verbose });
  };

  const openFolder = () =>
    openLogFolder().catch((err) => showToast(String(err), "error"));

  const buttonClass =
    "inline-flex items-center gap-1.5 rounded-lg border border-border/40 bg-secondary/50 px-3 py-2 text-xs font-medium text-foreground/80 transition-colors hover:bg-secondary disabled:opacity-50";

  return (
    <div className="rounded-xl border border-border/30 bg-card/50 p-5 space-y-5">
      <div>
        <p className="text-sm font-medium text-foreground">{t("about.diagnostics.title")}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("about.diagnostics.description")}</p>
        {info && (
          <p className="mt-2 truncate font-mono text-meta text-muted-foreground/60" title={info.file}>
            {info.file}
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <button onClick={openFolder} disabled={!info} className={buttonClass}>
          <FolderOpen className="h-3.5 w-3.5" />
          {t("about.diagnostics.openLogFolder")}
        </button>
        <button onClick={copyRecent} disabled={!info} className={buttonClass}>
          {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? t("common:status.copied") : t("about.diagnostics.copyRecentLog")}
        </button>
      </div>

      <div className="h-px bg-border/20" />

      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm font-medium text-foreground">{t("about.diagnostics.verbose.label")}</label>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("about.diagnostics.verbose.hint")}</p>
        </div>
        <button
          onClick={toggleVerbose}
          disabled={!info}
          role="switch"
          aria-checked={!!info?.verbose}
          aria-label={t("about.diagnostics.verbose.ariaLabel")}
          className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-all duration-200 disabled:opacity-50 ${
            info?.verbose ? "bg-primary shadow-[0_0_0_3px_hsl(var(--primary)/0.12)]" : "bg-muted"
          }`}
        >
          <span
            className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-all duration-200 ${
              info?.verbose ? "translate-x-5 scale-[1.05]" : "translate-x-0"
            }`}
          />
        </button>
      </div>
    </div>
  );
}

/** This build doesn't update itself (`UPDATER_ENABLED` in brand.ts): a notice, no controls. */
function UpdatesOff() {
  const { t } = useT("settings");
  return (
    <div className="rounded-xl border border-border/30 bg-card/50 p-5">
      <div className="flex items-center gap-3">
        <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-muted-foreground/40" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{t("about.updates.off.title")}</p>
          <p className="text-meta text-muted-foreground/60">{t("about.updates.off.detail")}</p>
        </div>
      </div>
    </div>
  );
}

/** Update status with check / download / restart, skip, and the automatic-updates switch. */
function Updates() {
  const { t } = useT(["settings", "common"]);
  const phase = useUpdaterStore((s) => s.phase);
  const version = useUpdaterStore((s) => s.version);
  const progress = useUpdaterStore((s) => s.progress);
  const error = useUpdaterStore((s) => s.error);
  const lastChecked = useUpdaterStore((s) => s.lastChecked);
  const autoUpdate = useUpdaterStore((s) => s.autoUpdate);
  const skippedVersion = useUpdaterStore((s) => s.skippedVersion);

  // The update loop lives in the launcher; this page may open in either window.
  useEffect(() => {
    hydrateUpdater();
  }, []);

  const pct =
    progress.total && progress.total > 0
      ? Math.min(100, Math.round((progress.received / progress.total) * 100))
      : null;

  let dotClass = "bg-success";
  let title = t("about.updates.idle.title");
  let detail = lastChecked
    ? t("about.updates.idle.lastChecked", { time: timeSince(lastChecked, t) })
    : t("about.updates.idle.notChecked");
  let action: { label: string; onClick: () => void; primary?: boolean; disabled?: boolean } | null = {
    label: t("about.updates.checkForUpdates"),
    onClick: () => checkForUpdates({ manual: true }),
  };

  if (phase === "checking") {
    dotClass = "animate-pulse bg-warning";
    title = t("about.updates.checking.title");
    detail = t("about.updates.checking.detail");
    action = { ...action, disabled: true };
  } else if (phase === "downloading") {
    dotClass = "animate-pulse bg-warning";
    title = version
      ? t("about.updates.downloading.titleVersion", { version })
      : t("about.updates.downloading.title");
    detail = pct !== null ? `${pct}%` : t("about.updates.downloading.detail");
    action = null;
  } else if (phase === "ready" && version) {
    dotClass = "bg-primary";
    title = t("about.updates.ready.title", { version });
    detail = autoUpdate ? t("about.updates.ready.installsOnQuit") : t("about.updates.ready.restartToInstall");
    action = { label: t("about.updates.restartNow"), onClick: () => restartToUpdate(), primary: true };
  } else if (phase === "error") {
    dotClass = "bg-destructive";
    title = version ? t("about.updates.error.downloadFailed") : t("about.updates.error.checkFailed");
    detail = error ?? t("common:errors.unknown");
    if (version) action = { label: t("common:actions.retry"), onClick: () => downloadUpdateNow({ explicit: true }) };
  } else if (version) {
    dotClass = "bg-primary";
    title = t("about.updates.available.title", { version });
    detail = t("about.updates.available.detail");
    action = { label: t("about.updates.download"), onClick: () => downloadUpdateNow({ explicit: true }), primary: true };
  }

  const canSkip =
    !!version && phase !== "checking" && phase !== "downloading" && skippedVersion !== version;

  return (
    <div className="rounded-xl border border-border/30 bg-card/50 p-5 space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${dotClass}`} />
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">{title}</p>
            <p className="truncate text-meta text-muted-foreground/60">{detail}</p>
          </div>
        </div>

        {action && (
          <button
            onClick={action.onClick}
            disabled={action.disabled}
            className={
              action.primary
                ? "shrink-0 rounded-lg bg-primary px-4 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                : "shrink-0 rounded-lg border border-border/40 bg-secondary/50 px-4 py-2 text-xs font-medium text-foreground/80 transition-colors hover:bg-secondary disabled:opacity-50"
            }
          >
            {action.label}
          </button>
        )}
      </div>

      {canSkip && version && (
        <button
          onClick={() => skipVersion(version)}
          className="text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {t("about.updates.skipVersion")}
        </button>
      )}

      <div className="h-px bg-border/20" />

      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm font-medium text-foreground">{t("about.updates.auto.label")}</label>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("about.updates.auto.hint")}</p>
        </div>
        <button
          onClick={() => setAutoUpdate(!autoUpdate)}
          role="switch"
          aria-checked={autoUpdate}
          aria-label={t("about.updates.auto.ariaLabel")}
          className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-all duration-200 ${
            autoUpdate ? "bg-primary shadow-[0_0_0_3px_hsl(var(--primary)/0.12)]" : "bg-muted"
          }`}
        >
          <span
            className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-all duration-200 ${
              autoUpdate ? "translate-x-5 scale-[1.05]" : "translate-x-0"
            }`}
          />
        </button>
      </div>
    </div>
  );
}

export function AboutSettings() {
  const { t } = useT("settings");
  const platformName = PLATFORM_NAMES[currentPlatform()];

  return (
    <div className="space-y-6">
      {/* App Identity Card */}
      <div className="rounded-xl border border-border/30 bg-card/50 p-6">
        <div className="flex items-start gap-5">
          <img src="/nexq-icon.png" alt={APP_NAME} className="h-14 w-14 shrink-0 rounded-2xl" />
          <div>
            <h3 className="text-lg font-bold text-foreground">{APP_NAME}</h3>
            <p className="text-xs text-muted-foreground">
              v{NEXQ_VERSION}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              {t("about.tagline")}
            </p>
            {/* Credit to upstream (MIT): keep the original author and copyright visible. */}
            <p className="mt-1 text-xs text-muted-foreground/70">
              <Trans
                t={t}
                i18nKey="about.credit"
                components={{
                  upstream: (
                    <a
                      href={UPSTREAM_URL}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => {
                        e.preventDefault();
                        open(UPSTREAM_URL);
                      }}
                      className="font-medium text-primary hover:underline"
                    />
                  ),
                }}
              />
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center rounded-full bg-secondary/50 px-3 py-1 text-meta font-medium text-muted-foreground">
                Tauri 2 {/* i18n-ignore: product name */}
              </span>
              <span className="inline-flex items-center rounded-full bg-secondary/50 px-3 py-1 text-meta font-medium text-muted-foreground">
                React + Rust {/* i18n-ignore: product names */}
              </span>
              {platformName && (
                <span className="inline-flex items-center rounded-full bg-secondary/50 px-3 py-1 text-meta font-medium text-muted-foreground">
                  {platformName}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Meta Grid (2x2) */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-border/30 bg-card/50 p-4">
          <p className="text-meta text-muted-foreground/60">{t("about.meta.buildDate")}</p>
          <p className="mt-1 text-sm font-medium text-foreground">
            {formatDate(NEXQ_BUILD_DATE, { year: "numeric", month: "short", day: "numeric" })}
          </p>
        </div>
        <div className="rounded-xl border border-border/30 bg-card/50 p-4">
          <p className="text-meta text-muted-foreground/60">{t("about.meta.developer")}</p>
          <p className="mt-1 text-sm font-medium text-foreground">
            {NEXQ_DEVELOPER}
          </p>
        </div>
        <div className="rounded-xl border border-border/30 bg-card/50 p-4">
          <p className="text-meta text-muted-foreground/60">{t("about.meta.architecture")}</p>
          <p className="mt-1 text-sm font-medium text-foreground">{cpuArchitecture()}</p>
        </div>
        <div className="rounded-xl border border-border/30 bg-card/50 p-4">
          <p className="text-meta text-muted-foreground/60">{t("about.meta.license")}</p>
          <p className="mt-1 text-sm font-medium text-foreground">MIT</p>
        </div>
      </div>

      {/* Updates */}
      {UPDATER_ENABLED ? <Updates /> : <UpdatesOff />}

      {/* Running next to the official NexQ */}
      <div className="rounded-xl border border-warning/20 bg-warning/5 px-5 py-3">
        <p className="text-xs font-medium text-warning">{t("about.coexistence.title")}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("about.coexistence.detail")}</p>
      </div>

      <Diagnostics />

      {/* Quick Links Row */}
      <div className="grid grid-cols-4 gap-3">
        <button
          onClick={() => open(REPO_URL)}
          className="flex flex-col items-center gap-2 rounded-xl border border-border/30 bg-card/50 p-4 transition-colors hover:bg-secondary/30"
        >
          <Github className="h-4 w-4 text-muted-foreground" />
          <span className="text-meta font-medium text-muted-foreground">
            {t("about.links.github")}
          </span>
        </button>
        <button
          onClick={() => open(`${REPO_URL}/blob/main/CHANGELOG.md`)}
          className="flex flex-col items-center gap-2 rounded-xl border border-border/30 bg-card/50 p-4 transition-colors hover:bg-secondary/30"
        >
          <FileText className="h-4 w-4 text-muted-foreground" />
          <span className="text-meta font-medium text-muted-foreground">
            {t("about.links.changelog")}
          </span>
        </button>
        <button
          onClick={() => open(`${REPO_URL}/issues`)}
          className="flex flex-col items-center gap-2 rounded-xl border border-border/30 bg-card/50 p-4 transition-colors hover:bg-secondary/30"
        >
          <AlertCircle className="h-4 w-4 text-muted-foreground" />
          <span className="text-meta font-medium text-muted-foreground">
            {t("about.links.reportIssue")}
          </span>
        </button>
        <button
          onClick={() => open(`${REPO_URL}#readme`)}
          className="flex flex-col items-center gap-2 rounded-xl border border-border/30 bg-card/50 p-4 transition-colors hover:bg-secondary/30"
        >
          <HelpCircle className="h-4 w-4 text-muted-foreground" />
          <span className="text-meta font-medium text-muted-foreground">
            {t("about.links.documentation")}
          </span>
        </button>
      </div>

      {/* Footer */}
      <div className="rounded-xl border border-border/30 bg-card/50 p-5">
        <p className="text-xs text-muted-foreground/60 leading-relaxed">
          {t("about.footer")}
        </p>
      </div>
    </div>
  );
}
