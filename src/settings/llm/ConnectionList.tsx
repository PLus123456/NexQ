// Left column of the connections tab: every connection with its state, the
// tasks that use it, and unsaved edits marked; plus "Add connection".
//
// Three separate things, shown three different ways so they are never taken
// for one another:
//  - in use: a task answers with the connection (primary border, task chips);
//  - viewing: the connection whose editor is open (a quiet outline ring only);
//  - status: whether it is ready (one dot and one word).

import { Plus } from "lucide-react";
import { useT } from "../../i18n";
import { cn } from "../../lib/utils";
import { tasksUsing } from "../../lib/llm/tasks";
import type { LlmConfigView, LlmConnection } from "../../lib/llm/types";
import { useAgentStore } from "../../stores/agentStore";
import { ConnectionIcon, StatusDot, connectionStatus, type ConnectionStatus } from "./ui";

export interface ConnectionListItem {
  connection: LlmConnection;
  /** Has unsaved edits (or isn't saved at all). */
  dirty: boolean;
  isNew: boolean;
}

export function ConnectionList({
  view,
  items,
  selectedId,
  adding,
  onSelect,
  onAdd,
}: {
  view: LlmConfigView;
  items: ConnectionListItem[];
  selectedId: string | null;
  adding: boolean;
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  const { t } = useT("llm");
  const claudeStatus = useAgentStore((s) => s.status);

  const statusOf = (connection: LlmConnection): ConnectionStatus => {
    // Claude is ready when the CLI is installed and logged in.
    if (connection.kind === "claude_cli" && connection.enabled && claudeStatus) {
      return claudeStatus.installed && claudeStatus.auth?.logged_in ? "ready" : "error";
    }
    return connectionStatus(connection);
  };

  return (
    <nav aria-label={t("connections.listLabel")} className="space-y-1.5">
      {items.map(({ connection, dirty, isNew }) => {
        const selected = !adding && connection.id === selectedId;
        const status = statusOf(connection);
        const tasks = isNew ? [] : tasksUsing(view, connection.id);
        const inUse = tasks.length > 0;
        const subtitle =
          connection.kind === "claude_cli"
            ? t("kinds.claude_cli")
            : connection.default_model || t(`kinds.${connection.kind}`);
        return (
          <button
            key={connection.id}
            type="button"
            onClick={() => onSelect(connection.id)}
            aria-current={selected ? "true" : undefined}
            data-in-use={inUse ? "true" : undefined}
            title={t(`connections.status.${status}`)}
            className={cn(
              "w-full rounded-lg border px-2.5 py-2 text-left transition-colors duration-150 cursor-pointer",
              inUse ? "border-primary/50 bg-primary/5" : "border-border/40 hover:border-border hover:bg-accent/40",
              selected && "ring-2 ring-foreground/25 ring-offset-1 ring-offset-card",
              !connection.enabled && "opacity-60",
            )}
          >
            <span className="flex items-center gap-1.5">
              <ConnectionIcon connection={connection} />
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                {connection.name || t("connections.untitled")}
              </span>
              {dirty && (
                <span className="shrink-0 text-meta font-semibold text-primary" title={t("connections.unsaved")}>
                  {isNew ? t("connections.newBadge") : "•"}
                </span>
              )}
            </span>
            <span className="mt-0.5 block truncate pl-5 font-mono text-meta text-muted-foreground">{subtitle}</span>
            <span className="mt-1 flex items-center gap-1.5 pl-5 text-meta text-muted-foreground">
              <StatusDot status={status} className="h-1.5 w-1.5" />
              <span className="truncate">{t(`connections.statusShort.${status}`)}</span>
            </span>
            {inUse && (
              <span className="mt-1 flex flex-wrap gap-1 pl-5">
                {tasks.map((task) => (
                  <span
                    key={task}
                    className={cn(
                      "rounded-full border px-1.5 py-px text-[10px] leading-tight",
                      task === "default" ? "border-primary/30 bg-primary/10 text-primary" : "border-border/40 text-muted-foreground",
                    )}
                  >
                    {t(`tasks.${task}.short`)}
                  </span>
                ))}
              </span>
            )}
          </button>
        );
      })}

      <button
        type="button"
        onClick={onAdd}
        aria-pressed={adding}
        className={cn(
          "flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed px-2.5 py-2 text-xs font-medium transition-colors duration-150 cursor-pointer",
          adding ? "border-primary/40 bg-primary/5 text-primary" : "border-border/50 text-muted-foreground hover:border-border hover:text-foreground",
        )}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
        {t("connections.add")}
      </button>
    </nav>
  );
}
