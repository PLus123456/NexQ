// Footer quick switch for the default AI model: pick a connection (grouped
// local / cloud / subscription), then a model (one click on a candidate, or
// type any id), and it becomes the default route. Tasks routed to their own
// model are listed as unaffected. Opens upward from the footer chip.

import { useEffect, useRef, useState, type ComponentType } from "react";
import { CheckCircle2, Cloud, Cpu, HardDrive, Loader2, RefreshCw, Settings2 } from "lucide-react";
import { useT } from "../../i18n";
import { ModelCombobox } from "../ModelCombobox";
import { cn } from "../../lib/utils";
import { errorMessage } from "../../lib/llm/ipc";
import { isEmbeddingModel, modelOptions } from "../../lib/llm/connection";
import { effectiveRoute } from "../../lib/llm/tasks";
import type { LlmConfigView, LlmConnection } from "../../lib/llm/types";
import { useLlmConnectionsStore } from "../../stores/llmConnectionsStore";
import { useMeetingStore } from "../../stores/meetingStore";
import { showToast } from "../../stores/toastStore";
import { useConfigStore } from "../../stores/configStore";
import { claudeTierLabel } from "../../settings/ClaudeCliSettings";
import { findTemplate } from "../../settings/llm/providerTemplates";
import { useTaskLabel } from "../../settings/llm/taskLabels";

type Group = "local" | "cloud" | "subscription";
const GROUPS: readonly Group[] = ["local", "cloud", "subscription"];

const GROUP_ICONS: Record<Group, ComponentType<{ className?: string }>> = {
  local: HardDrive,
  cloud: Cloud,
  subscription: Cpu,
};

function groupOf(connection: LlmConnection): Group {
  if (connection.kind === "claude_cli") return "subscription";
  if (connection.kind === "ollama" || findTemplate(connection.template)?.group === "local") return "local";
  return "cloud";
}

/** How many candidates are listed for one click; the rest are reachable by typing. */
const MAX_ROWS = 8;

export function LlmQuickPicker({ view, onClose }: { view: LlmConfigView; onClose: () => void }) {
  const { t } = useT(["llm", "common"]);
  const ref = useRef<HTMLDivElement>(null);
  const claudeConfig = useConfigStore((s) => s.claudeCliConfig);
  const claudeModels = useConfigStore((s) => s.claudeModels) ?? undefined;
  const current = effectiveRoute(view, "default");
  const enabled = view.connections.filter((c) => c.enabled);
  const [pendingId, setPendingId] = useState<string | null>(
    () => (current.connection_id && enabled.some((c) => c.id === current.connection_id) ? current.connection_id : enabled[0]?.id ?? null),
  );
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const pending = enabled.find((c) => c.id === pendingId) ?? null;

  // Click outside / Escape closes (the model input's own list handles Escape first).
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const apply = async (connection: LlmConnection, model: string | null) => {
    setApplying(true);
    try {
      await useLlmConnectionsStore.getState().setDefaultRoute({ connection_id: connection.id, model });
      onClose();
    } catch (err) {
      showToast(t("quickPicker.applyFailed", { detail: errorMessage(err) }), "error");
    } finally {
      setApplying(false);
    }
  };

  const refresh = async () => {
    if (!pending) return;
    setFetching(true);
    setFetchError(null);
    try {
      const result = await useLlmConnectionsStore.getState().fetchModels({ id: pending.id });
      if (!result.ok) setFetchError(result.error || result.error_body || (result.status ? `HTTP ${result.status}` : t("common:errors.unknown")));
    } catch (err) {
      setFetchError(errorMessage(err));
    } finally {
      setFetching(false);
    }
  };

  const options = pending
    ? modelOptions(
        {
          ...pending,
          model_cache: pending.model_cache
            ? { ...pending.model_cache, models: pending.model_cache.models.filter((m) => !isEmbeddingModel(m.id)) }
            : null,
        },
        findTemplate(pending.template)?.suggestedModels ?? [],
      )
    : [];
  // The connection's default model first, then the candidates (each once).
  const rows = [...new Set([pending?.default_model, ...options.map((o) => o.id)].filter((m): m is string => !!m))].slice(0, MAX_ROWS);
  const isCurrent = (connection: LlmConnection, model: string | null) =>
    current.connection_id === connection.id && (connection.kind === "claude_cli" || current.model === model);

  // Tasks with a route of their own keep their model when the default changes.
  const routed = Object.entries(view.routing.tasks)
    .filter(([, route]) => route.target && view.connections.some((c) => c.id === route.target?.connection_id))
    .map(([key]) => key);
  const taskLabel = useTaskLabel();

  const openSettings = () => {
    onClose();
    useMeetingStore.getState().openSettings("llm");
  };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={t("quickPicker.label")}
      className="absolute bottom-full left-0 z-50 mb-2 w-[280px] overflow-hidden rounded-xl border border-border/30 bg-popover/95 shadow-2xl backdrop-blur-md animate-in slide-in-from-bottom-2 fade-in duration-150"
    >
      {enabled.length === 0 ? (
        <div className="space-y-2 px-4 py-3 text-meta text-muted-foreground">
          <p>{t("quickPicker.noConnections")}</p>
        </div>
      ) : (
        <div className="max-h-[220px] overflow-y-auto">
          {GROUPS.map((group, index) => {
            const items = enabled.filter((c) => groupOf(c) === group);
            if (items.length === 0) return null;
            const Icon = GROUP_ICONS[group];
            return (
              <div key={group} className={index > 0 ? "border-t border-border/20" : ""}>
                <div className="flex items-center gap-1.5 border-b border-border/20 bg-muted/20 px-3 py-1.5">
                  <Icon className="h-2.5 w-2.5 text-muted-foreground" aria-hidden />
                  <span className="text-meta font-semibold uppercase tracking-wider text-muted-foreground/70">
                    {t(`quickPicker.groups.${group}`)}
                  </span>
                </div>
                {items.map((connection) => {
                  const selected = connection.id === pendingId;
                  const inUse = current.connection_id === connection.id;
                  return (
                    <button
                      key={connection.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => {
                        setPendingId(connection.id);
                        setFetchError(null);
                      }}
                      className={cn(
                        "flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs transition-colors cursor-pointer",
                        selected ? "bg-primary/10 text-primary" : "text-foreground/80 hover:bg-accent/40",
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate font-medium">{connection.name || t("connections.untitled")}</span>
                      {inUse && <span className="shrink-0 text-meta text-primary/80">{t("quickPicker.inUse")}</span>}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      {pending && pending.kind === "claude_cli" && (
        <div className="border-t border-border/20">
          <button
            type="button"
            disabled={applying}
            onClick={() => void apply(pending, null)}
            className={cn(
              "flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs transition-colors cursor-pointer",
              isCurrent(pending, null) ? "bg-primary/10 text-primary" : "text-foreground/80 hover:bg-accent/40",
            )}
          >
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{isCurrent(pending, null) ? t("quickPicker.claudeInUse") : t("quickPicker.useClaude")}</span>
              <span className="block text-meta text-muted-foreground">
                {t("quickPicker.claudeTiers", {
                  fast: claudeTierLabel(claudeConfig.fast_model, claudeConfig.fast_effort, claudeModels),
                  deep: claudeTierLabel(claudeConfig.deep_model, claudeConfig.deep_effort, claudeModels),
                })}
              </span>
            </span>
            {isCurrent(pending, null) && <CheckCircle2 className="h-3 w-3 shrink-0 text-primary" aria-hidden />}
          </button>
        </div>
      )}

      {pending && pending.kind !== "claude_cli" && (
        <div className="border-t border-border/20">
          <div className="flex items-center gap-1.5 border-b border-border/20 bg-muted/20 px-3 py-1.5">
            {/* Not uppercased: it holds the connection's own name. */}
            <span className="min-w-0 flex-1 truncate text-meta font-semibold text-muted-foreground/70">
              {t("quickPicker.models", { name: pending.name || t("connections.untitled") })}
            </span>
            {pending.models_endpoint !== "disabled" && (
              <button
                type="button"
                onClick={() => void refresh()}
                disabled={fetching}
                aria-label={t("quickPicker.refresh")}
                title={t("quickPicker.refresh")}
                className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground cursor-pointer disabled:cursor-default"
              >
                {fetching ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <RefreshCw className="h-3 w-3" aria-hidden />}
              </button>
            )}
          </div>
          {rows.length > 0 && (
            <div className="max-h-[180px] overflow-y-auto">
              {rows.map((model) => {
                const active = isCurrent(pending, model) || (current.connection_id === pending.id && !current.model && model === pending.default_model);
                return (
                  <button
                    key={model}
                    type="button"
                    disabled={applying}
                    onClick={() => void apply(pending, model)}
                    className={cn(
                      "flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs transition-colors cursor-pointer",
                      active ? "bg-primary/10 text-primary" : "text-foreground/80 hover:bg-accent/40",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate font-mono">{model}</span>
                    {active && <CheckCircle2 className="h-3 w-3 shrink-0 text-primary" aria-hidden />}
                  </button>
                );
              })}
            </div>
          )}
          {fetchError && <p className="break-words px-3 py-1.5 text-meta text-warning">{fetchError}</p>}
          <div className="px-3 py-2">
            <ModelCombobox
              aria-label={t("quickPicker.typeModel")}
              placeholder={t("quickPicker.typeModel")}
              value=""
              onChange={(model) => {
                if (model) void apply(pending, model);
              }}
              options={options}
              disabled={applying}
            />
          </div>
        </div>
      )}

      {routed.length > 0 && (
        <div className="border-t border-border/20 px-3 py-2 text-meta text-muted-foreground">
          <p>{t("quickPicker.unaffected")}</p>
          <ul className="mt-1 space-y-0.5">
            {routed.map((key) => {
              const route = effectiveRoute(view, key);
              return (
                <li key={key} className="truncate">
                  {taskLabel(key)}
                  <span className="text-muted-foreground/70">
                    {" → "}
                    {route.connection_name}
                    {route.model ? ` / ${route.model}` : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="border-t border-border/20">
        <button
          type="button"
          onClick={openSettings}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-meta text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground cursor-pointer"
        >
          <Settings2 className="h-3 w-3" aria-hidden />
          {t("quickPicker.openSettings")}
        </button>
      </div>
    </div>
  );
}
