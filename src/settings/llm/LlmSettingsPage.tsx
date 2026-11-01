// Settings → AI models: the default model banner, then two tabs — the
// connections (list + editor) and the task routing table. Connections are
// owned by Rust; this page reads them through llmConnectionsStore and changes
// them with commands. A build without those commands shows the old page.

import { useState } from "react";
import { CircleAlert, Info, Loader2, RefreshCw, Zap } from "lucide-react";
import { useT } from "../../i18n";
import { cn } from "../../lib/utils";
import { effectiveRoute } from "../../lib/llm/tasks";
import type { LlmConfigView } from "../../lib/llm/types";
import { useConfigStore } from "../../stores/configStore";
import { useLlmConfig, useLlmConnectionsStore } from "../../stores/llmConnectionsStore";
import { claudeTierLabel } from "../ClaudeCliSettings";
import { LLMSettings } from "../LLMSettings";
import { ConnectionsPanel } from "./ConnectionsPanel";
import { TaskRoutingPanel } from "./TaskRoutingPanel";
import { BUTTON, CARD, Notice } from "./ui";

type Tab = "connections" | "routing";

export function LlmSettingsPage() {
  const { t } = useT(["llm", "common"]);
  const { view, loadState, loadError } = useLlmConfig();
  const [tab, setTab] = useState<Tab>("connections");

  if (loadState === "unavailable") {
    return (
      <div className="space-y-4">
        <Notice icon={<Info className="h-3.5 w-3.5 text-info" />}>{t("page.legacyFallback")}</Notice>
        <LLMSettings />
      </div>
    );
  }

  if (!view) {
    return (
      <div className={cn(CARD, "flex items-center gap-3")}>
        {loadState === "error" ? (
          <>
            <CircleAlert className="h-4 w-4 shrink-0 text-destructive" aria-hidden />
            <p className="min-w-0 flex-1 break-words text-xs text-destructive">
              {t("common:errors.loadFailed", { detail: loadError ?? t("common:errors.unknown") })}
            </p>
            <button type="button" onClick={() => void useLlmConnectionsStore.getState().load()} className={BUTTON}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              {t("common:actions.retry")}
            </button>
          </>
        ) : (
          <>
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />
            <p className="text-xs text-muted-foreground">{t("common:status.loading")}</p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <DefaultBanner view={view} />
      {view.read_only && (
        <Notice tone="warning" icon={<CircleAlert className="h-3.5 w-3.5 text-warning" />}>
          {t("page.readOnly")}
        </Notice>
      )}
      {view.load_warning === "restored_from_backup" && (
        <Notice tone="warning" icon={<CircleAlert className="h-3.5 w-3.5 text-warning" />}>
          {t("page.loadWarnings.restoredFromBackup")}
        </Notice>
      )}
      {view.load_warning === "reset_corrupt_file" && (
        <Notice tone="warning" icon={<CircleAlert className="h-3.5 w-3.5 text-warning" />}>
          {t("page.loadWarnings.resetCorruptFile")}
        </Notice>
      )}
      {loadError && (
        <Notice tone="warning" icon={<CircleAlert className="h-3.5 w-3.5 text-warning" />}>
          {t("page.refreshFailed", { detail: loadError })}
        </Notice>
      )}

      <div role="tablist" aria-label={t("page.tabsLabel")} className="inline-flex rounded-lg border border-border/50 bg-secondary/30 p-0.5">
        {(["connections", "routing"] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              "rounded-md px-4 py-1.5 text-xs font-medium transition-all duration-150 cursor-pointer",
              tab === id
                ? "bg-primary text-primary-foreground shadow-sm shadow-primary/20"
                : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
            )}
          >
            {t(`page.tabs.${id}`)}
          </button>
        ))}
      </div>

      <div role="tabpanel">{tab === "connections" ? <ConnectionsPanel view={view} /> : <TaskRoutingPanel view={view} />}</div>
    </div>
  );
}

/** "Default: DeepSeek / deepseek-chat" — what answers every task without its own route. */
function DefaultBanner({ view }: { view: LlmConfigView }) {
  const { t } = useT("llm");
  const claudeConfig = useConfigStore((s) => s.claudeCliConfig);
  const claudeModels = useConfigStore((s) => s.claudeModels) ?? undefined;
  const effective = effectiveRoute(view, "default");
  const name = effective.connection_name || t("connections.untitled");
  const customized = Object.values(view.routing.tasks).filter(
    (route) => route.target && view.connections.some((c) => c.id === route.target?.connection_id),
  ).length;

  let title: string;
  let detail: string;
  let warn = false;
  switch (effective.error) {
    case null:
      if (effective.kind === "claude_cli") {
        title = t("page.banner.title", { target: name });
        detail = t("page.banner.claude", {
          fast: claudeTierLabel(claudeConfig.fast_model, claudeConfig.fast_effort, claudeModels),
          deep: claudeTierLabel(claudeConfig.deep_model, claudeConfig.deep_effort, claudeModels),
        });
      } else {
        title = t("page.banner.title", { target: `${name} / ${effective.model ?? ""}` });
        detail = customized > 0 ? t("page.banner.customized", { count: customized }) : t("page.banner.hint");
      }
      if (effective.via_fallback) {
        detail = t("page.banner.viaFallback");
        warn = true;
      }
      break;
    case "not_configured":
    case "connection_missing":
      title = t("page.banner.none");
      detail = t("page.banner.noneHint");
      warn = true;
      break;
    case "connection_disabled":
      title = t("page.banner.title", { target: name });
      detail = t("routing.effective.disabled", { name });
      warn = true;
      break;
    case "no_model":
      title = t("page.banner.title", { target: name });
      detail = t("routing.effective.noModel", { name });
      warn = true;
      break;
    case "base_url_missing":
      title = t("page.banner.title", { target: name });
      detail = t("routing.effective.baseUrlMissing", { name });
      warn = true;
      break;
    default:
      title = t("page.banner.title", { target: name });
      detail = effective.error;
      warn = true;
  }

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-xl border px-5 py-3.5",
        warn ? "border-warning/30 bg-warning/5" : "border-primary/30 bg-primary/5",
      )}
    >
      <Zap className={cn("h-4 w-4 shrink-0", warn ? "text-warning" : "text-primary")} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground" title={title}>
          {title}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}
