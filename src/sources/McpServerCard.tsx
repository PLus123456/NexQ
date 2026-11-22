import { useEffect, useId, useState } from "react";
import { ChevronDown, Loader2, Pencil, Wrench, X } from "lucide-react";
import { t, useT } from "../i18n";
import type { McpServer } from "../lib/types";
import { SourceSwitch } from "./SourceSwitch";

interface McpServerCardProps {
  server: McpServer;
  checking: boolean;
  onToggle: (enabled: boolean) => void;
  onCheck: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onToolToggle: (toolName: string, allowed: boolean) => void;
  /** Open the tool list (a new server's first successful Check). */
  autoOpen?: boolean;
}

/** Said of a server that asks for a sign-in, in the UI language. */
export function needsSignInText(): string {
  return t("sources:mcp.needsSignIn");
}

/** `node s.js` or the URL. */
function summaryOf(server: McpServer): string {
  const t = server.transport;
  return t.type === "stdio" ? [t.command, ...t.args].join(" ") : t.url;
}

function statusOf(server: McpServer, checking: boolean): { text: string; tone: "ok" | "bad" | "quiet" } {
  if (checking) return { text: t("sources:mcp.status.checking"), tone: "quiet" };
  if (server.needs_sign_in) return { text: needsSignInText(), tone: "bad" };
  const c = server.last_check;
  if (!c) {
    return {
      text: server.enabled ? t("sources:mcp.status.notChecked") : t("sources:mcp.status.notCheckedYet"),
      tone: "quiet",
    };
  }
  if (c.ok) return { text: t("sources:mcp.status.ready", { count: c.tool_count }), tone: "ok" };
  return { text: t("sources:mcp.status.failed", { detail: c.error ?? t("sources:mcp.status.failedDefault") }), tone: "bad" };
}

export function McpServerCard({ server, checking, onToggle, onCheck, onEdit, onRemove, onToolToggle, autoOpen = false }: McpServerCardProps) {
  const { t } = useT("sources");
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (autoOpen) setOpen(true);
  }, [autoOpen]);
  const statusId = useId();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const status = statusOf(server, checking);
  const ready = !!server.last_check?.ok && !server.needs_sign_in;
  // Off until a Check works; one that is on can always be switched off.
  const cantEnable = !server.enabled && !ready;
  const allowed = server.tools.filter((tool) => tool.allowed).length;
  const toolsId = `mcp-tools-${server.id}`;

  return (
    <div
      className={`rounded-xl border bg-secondary/20 p-3 transition-colors hover:bg-secondary/30 ${
        status.tone === "bad" ? "border-destructive/30" : "border-border/40"
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10">
          <Wrench className="h-4 w-4 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">{server.label}</div>
          <div className="truncate font-mono text-xs text-muted-foreground" title={summaryOf(server)}>
            {summaryOf(server)}
          </div>
          <div
            id={statusId}
            role="status"
            className={`mt-1 flex items-center gap-1.5 text-xs ${
              status.tone === "ok" ? "text-success" : status.tone === "bad" ? "text-destructive" : "text-muted-foreground/80"
            }`}
          >
            {checking && <Loader2 className="h-3 w-3 animate-spin" />}
            <span>{status.text}</span>
          </div>
        </div>
        <div className="flex items-center gap-2.5 pt-0.5">
          <SourceSwitch
            checked={server.enabled}
            disabled={cantEnable}
            onChange={onToggle}
            describedBy={statusId}
            label={t("card.useAria", { name: server.label })}
          />
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-2 pl-11">
        <button
          type="button"
          onClick={onCheck}
          disabled={checking || server.needs_sign_in}
          className="cursor-pointer rounded-md border border-border/50 px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t("mcp.check")}
        </button>
        <button
          type="button"
          onClick={onEdit}
          aria-label={t("mcp.editAria", { name: server.label })}
          className="flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
        >
          <Pencil className="h-3 w-3" />
          {t("mcp.edit")}
        </button>
        <button
          type="button"
          onClick={() => {
            if (confirmRemove) onRemove();
            else {
              setConfirmRemove(true);
              setTimeout(() => setConfirmRemove(false), 3000);
            }
          }}
          aria-label={
            confirmRemove
              ? t("card.confirmRemoveAria", { name: server.label })
              : t("card.removeAria", { name: server.label })
          }
          className={`flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors ${
            confirmRemove ? "bg-destructive/15 text-destructive" : "text-muted-foreground hover:bg-accent/40 hover:text-foreground"
          }`}
        >
          {confirmRemove ? (
            t("card.removeQuestion")
          ) : (
            <>
              <X className="h-3 w-3" />
              {t("card.remove")}
            </>
          )}
        </button>
        {server.tools.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls={toolsId}
            className="ml-auto flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
          >
            <span>
              {t("mcp.toolsAllowed", { allowed, total: server.tools.length })}
            </span>
            <ChevronDown className={`h-3 w-3 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
          </button>
        )}
      </div>

      {open && server.tools.length > 0 && (
        <ul id={toolsId} className="mt-2 space-y-1 pl-11">
          {server.tools.map((tool) => (
            <li key={tool.name} className="flex items-center justify-between gap-3 rounded-md px-2 py-1 hover:bg-accent/20">
              <span className="truncate font-mono text-xs text-foreground/90">{tool.name}</span>
              <SourceSwitch checked={tool.allowed} onChange={(next) => onToolToggle(tool.name, next)} label={t("mcp.allowAria", { name: tool.name })} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
