import { useCallback, useEffect, useId, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderPlus, HelpCircle, Plus } from "lucide-react";
import type { McpServer, NotesFolderInfo } from "../lib/types";
import { checkMcpServer, deleteMcpSecrets, inspectNotesFolder } from "../lib/ipc";
import { t as translate, useT } from "../i18n";
import { useConfigStore } from "../stores/configStore";
import { useSourcesStore } from "../stores/sourcesStore";
import { showToast } from "../stores/toastStore";
import { NotesFolderCard } from "./NotesFolderCard";
import { McpServerCard } from "./McpServerCard";
import { AddMcpServerDialog } from "./AddMcpServerDialog";
import { SourcesGuideModal } from "./SourcesGuideModal";
import { McpPermissionNotice } from "./McpPermissionNotice";
import {
  addNotesFolder,
  errorText,
  folderNameOf,
  markMcpNoticeSeen,
  patchMcpServer,
  patchNotesFolder,
  removeMcpServerDurably,
  removeNotesFolder,
  applyCheckResult,
} from "./sourcesActions";

/** Why the editor is dimmed on any provider but the Claude subscription, in the UI language. */
export function sourcesGatingLine(): string {
  return translate("sources:gating", { tab: translate("settings:tabs.llm") });
}

interface PersonalSourcesEditorProps {
  /** `compact` on the launcher main screen, `full` in Settings. */
  variant: "compact" | "full";
}

function GroupHeader({ title, tone, onGuide, children }: { title: string; tone: "highlight" | "primary"; onGuide: () => void; children: React.ReactNode }) {
  const { t } = useT("sources");
  return (
    <div className="mb-2 flex items-center gap-2">
      <span className={`h-1.5 w-1.5 rounded-full ${tone === "highlight" ? "bg-highlight" : "bg-primary"}`} aria-hidden />
      <h3 className="text-xs font-semibold text-foreground">{title}</h3>
      <button
        type="button"
        onClick={onGuide}
        className="flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
      >
        <HelpCircle className="h-3 w-3" />
        {t("editor.howThisWorks")}
      </button>
      <div className="ml-auto">{children}</div>
    </div>
  );
}

const addButton =
  "flex cursor-pointer items-center gap-1.5 rounded-lg border border-dashed border-border/40 bg-card/30 px-2.5 py-1 text-xs font-medium text-muted-foreground transition-all duration-150 hover:border-border/60 hover:bg-accent/30 hover:text-foreground active:scale-[0.98]";

export function PersonalSourcesEditor({ variant }: PersonalSourcesEditorProps) {
  const { t } = useT("sources");
  const config = useSourcesStore((s) => s.config);
  const pushError = useSourcesStore((s) => s.pushError);
  const provider = useConfigStore((s) => s.llmProvider);
  const gatingId = useId();
  const gated = provider !== "claude_cli";

  const [infos, setInfos] = useState<Record<string, NotesFolderInfo>>({});
  const [folderError, setFolderError] = useState<string | null>(null);
  const [checking, setChecking] = useState<Set<string>>(new Set());
  // Servers whose tool list opens by itself once their first Check worked.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [guide, setGuide] = useState<"notes" | "tools" | null>(null);
  const [dialog, setDialog] = useState<{ editing?: McpServer } | null>(null);
  const [showNotice, setShowNotice] = useState(false);

  // Look at each folder when it appears or its path changes, not on every edit.
  const inspected = useRef(new Map<string, string>());
  const lookAt = useCallback((id: string, path: string) => {
    inspected.current.set(id, path);
    inspectNotesFolder(path)
      .then((info) => setInfos((prev) => ({ ...prev, [id]: info })))
      .catch(() => setInfos((prev) => ({ ...prev, [id]: { exists: false, md_count: 0, truncated: false, problem: null } })));
  }, []);
  useEffect(() => {
    for (const f of config.notes_folders) {
      if (inspected.current.get(f.id) !== f.path) lookAt(f.id, f.path);
    }
  }, [config.notes_folders, lookAt]);

  const addFolder = async () => {
    setFolderError(null);
    let picked: string | string[] | null;
    try {
      picked = await open({ directory: true, title: t("editor.notes.pickTitle") });
    } catch (e) {
      setFolderError(errorText(e));
      return;
    }
    if (!picked || typeof picked !== "string") return;
    if (config.notes_folders.some((f) => f.path.toLowerCase() === picked.toLowerCase())) {
      setFolderError(t("editor.notes.duplicate"));
      return;
    }
    let info: NotesFolderInfo;
    try {
      info = await inspectNotesFolder(picked);
    } catch (e) {
      setFolderError(errorText(e));
      return;
    }
    // A folder that can't be used is not added, and never switched on.
    if (!info.exists) {
      setFolderError(t("editor.notes.notFound"));
      return;
    }
    if (info.problem) {
      setFolderError(info.problem);
      return;
    }
    const id = crypto.randomUUID();
    inspected.current.set(id, picked);
    setInfos((prev) => ({ ...prev, [id]: info }));
    await addNotesFolder({ id, label: folderNameOf(picked), path: picked, enabled: true });
  };

  const check = async (server: McpServer, expand = false) => {
    setChecking((prev) => new Set(prev).add(server.id));
    try {
      const result = await checkMcpServer(server.id);
      await applyCheckResult(result);
      if (expand && result.last_check?.ok) setExpanded((prev) => new Set(prev).add(server.id));
    } catch (e) {
      showToast(t("editor.toast.checkFailed", { name: server.label, detail: errorText(e) }), "error");
    } finally {
      setChecking((prev) => {
        const next = new Set(prev);
        next.delete(server.id);
        return next;
      });
    }
  };

  const removeServer = async (server: McpServer) => {
    // The removal is saved first; the secrets go only after that (and the backend,
    // which forgets them too, hears of it last). A failed save keeps the server.
    try {
      await removeMcpServerDurably(server.id, async () => {
        try {
          await deleteMcpSecrets(server.id);
        } catch (e) {
          showToast(t("editor.toast.forgetSecretsFailed", { name: server.label, detail: errorText(e) }), "warning");
        }
      });
    } catch (e) {
      showToast(t("editor.toast.removeFailed", { name: server.label, detail: errorText(e) }), "error");
    }
  };

  const compact = variant === "compact";

  return (
    <div className="space-y-3">
      {gated && (
        <p id={gatingId} className="rounded-lg border border-border/40 bg-secondary/30 px-3 py-2 text-xs text-muted-foreground">
          {sourcesGatingLine()}
        </p>
      )}

      <div className={`space-y-5 transition-opacity duration-200 ${gated ? "opacity-60" : ""}`} aria-describedby={gated ? gatingId : undefined}>
        {!compact && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("editor.intro")}
          </p>
        )}

        {pushError && (
          <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-1.5 text-xs text-destructive">
            {pushError}
          </p>
        )}

        {/* Notes */}
        <section aria-label={t("editor.notes.sectionLabel")}>
          <GroupHeader title={t("editor.notes.title")} tone="highlight" onGuide={() => setGuide("notes")}>
            <button type="button" onClick={addFolder} className={addButton}>
              <FolderPlus className="h-3 w-3" />
              {t("editor.notes.add")}
            </button>
          </GroupHeader>
          {folderError && (
            <p role="alert" className="mb-2 text-xs text-destructive">
              {folderError}
            </p>
          )}
          {config.notes_folders.length === 0 ? (
            <p className="text-xs text-muted-foreground/80">{t("editor.notes.empty")}</p>
          ) : (
            <div className="space-y-2">
              {config.notes_folders.map((f) => (
                <NotesFolderCard
                  key={f.id}
                  folder={f}
                  info={infos[f.id]}
                  onToggle={(enabled) => void patchNotesFolder(f.id, { enabled })}
                  onRename={(label) => void patchNotesFolder(f.id, { label })}
                  onRemove={() => void removeNotesFolder(f.id)}
                />
              ))}
            </div>
          )}
        </section>

        {/* Tools */}
        <section aria-label={t("editor.tools.sectionLabel")}>
          <GroupHeader title={t("editor.tools.title")} tone="primary" onGuide={() => setGuide("tools")}>
            <button type="button" onClick={() => setDialog({})} className={addButton}>
              <Plus className="h-3 w-3" />
              {t("editor.tools.add")}
            </button>
          </GroupHeader>
          {config.mcp_servers.length === 0 ? (
            <p className="text-xs text-muted-foreground/80">{t("editor.tools.empty")}</p>
          ) : (
            <div className="space-y-2">
              {config.mcp_servers.map((s) => (
                <McpServerCard
                  key={s.id}
                  server={s}
                  checking={checking.has(s.id)}
                  autoOpen={expanded.has(s.id)}
                  onToggle={(enabled) => void patchMcpServer(s.id, (cur) => ({ ...cur, enabled }))}
                  onCheck={() => void check(s)}
                  onEdit={() => setDialog({ editing: s })}
                  onRemove={() => void removeServer(s)}
                  onToolToggle={(name, allowed) =>
                    void patchMcpServer(s.id, (cur) => ({
                      ...cur,
                      tools: cur.tools.map((tool) => (tool.name === name ? { ...tool, allowed } : tool)),
                    }))
                  }
                />
              ))}
            </div>
          )}
        </section>
      </div>

      {guide && <SourcesGuideModal kind={guide} onClose={() => setGuide(null)} />}
      {dialog && (
        <AddMcpServerDialog
          editing={dialog.editing}
          onClose={() => setDialog(null)}
          onAdded={(servers) => {
            // Only an added server, not an edit of one the user already knew.
            if (!dialog.editing && !useSourcesStore.getState().config.mcp_notice_seen) setShowNotice(true);
            // A new or edited server starts off: check it now and show its tools,
            // so the switch can be turned on.
            for (const s of servers) if (!s.needs_sign_in) void check(s, true);
          }}
        />
      )}
      {showNotice && (
        <McpPermissionNotice
          onDismiss={() => {
            setShowNotice(false);
            void markMcpNoticeSeen();
          }}
        />
      )}
    </div>
  );
}
