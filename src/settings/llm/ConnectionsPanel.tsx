// "Connections" tab: the list on the left, the editor (or the template
// picker) on the right. Unsaved edits are kept per connection, so moving
// between connections never loses them; new connections live here until
// they're saved.

import { useEffect, useMemo, useState } from "react";
import { useT } from "../../i18n";
import type { LlmConfigView } from "../../lib/llm/types";
import { ConnectionEditor } from "./ConnectionEditor";
import { ConnectionList, type ConnectionListItem } from "./ConnectionList";
import { draftOf, isDirty, type ConnectionDraft } from "./draft";
import { connectionFromTemplate, type ProviderTemplate } from "./providerTemplates";
import { TemplatePicker } from "./TemplatePicker";
import { useTemplateName } from "./templateNames";
import { CARD } from "./ui";

/** The default connection, else the first one. */
function preferredId(view: LlmConfigView): string | null {
  const def = view.routing.default.target?.connection_id;
  if (def && view.connections.some((c) => c.id === def)) return def;
  return view.connections[0]?.id ?? null;
}

export function ConnectionsPanel({ view }: { view: LlmConfigView }) {
  const { t } = useT("llm");
  const templateName = useTemplateName();
  const [drafts, setDrafts] = useState<Record<string, ConnectionDraft>>({});
  const [selectedId, setSelectedId] = useState<string | null>(() => preferredId(view));
  const [adding, setAdding] = useState(() => view.connections.length === 0);

  const newDrafts = useMemo(() => Object.values(drafts).filter((d) => d.isNew), [drafts]);
  const items: ConnectionListItem[] = [
    ...view.connections.map((connection) => {
      const draft = drafts[connection.id];
      return { connection: draft?.connection ?? connection, dirty: !!draft && isDirty(draft, connection), isNew: false };
    }),
    ...newDrafts.map((draft) => ({ connection: draft.connection, dirty: true, isNew: true })),
  ];

  // The selected connection was deleted (here or in the other window): pick another.
  const selectedExists = items.some((item) => item.connection.id === selectedId);
  useEffect(() => {
    if (!selectedExists) setSelectedId(preferredId(view));
  }, [selectedExists, view]);

  const saved = view.connections.find((c) => c.id === selectedId) ?? null;
  const draft = selectedId ? drafts[selectedId] ?? (saved ? draftOf(saved) : null) : null;

  const setDraft = (id: string, next: ConnectionDraft) => setDrafts((all) => ({ ...all, [id]: next }));
  const dropDraft = (id: string) =>
    setDrafts((all) => {
      const { [id]: _dropped, ...rest } = all;
      return rest;
    });

  const pick = (template: ProviderTemplate) => {
    // One Claude subscription per computer: open the existing one.
    if (template.kind === "claude_cli") {
      const existing = items.find((item) => item.connection.kind === "claude_cli");
      if (existing) {
        setSelectedId(existing.connection.id);
        setAdding(false);
        return;
      }
    }
    const connection = connectionFromTemplate(
      template,
      templateName(template.id),
      items.map((item) => item.connection.name),
    );
    setDraft(connection.id, draftOf(connection, true));
    setSelectedId(connection.id);
    setAdding(false);
  };

  return (
    <div className="grid grid-cols-[10.5rem_minmax(0,1fr)] items-start gap-4">
      <ConnectionList
        view={view}
        items={items}
        selectedId={selectedId}
        adding={adding}
        onSelect={(id) => {
          setSelectedId(id);
          setAdding(false);
        }}
        onAdd={() => setAdding(true)}
      />
      <div className="min-w-0">
        {adding || !draft ? (
          items.length === 0 || adding ? (
            <TemplatePicker onPick={pick} onCancel={items.length > 0 ? () => setAdding(false) : undefined} />
          ) : (
            <div className={CARD}>
              <p className="text-xs text-muted-foreground">{t("connections.selectHint")}</p>
            </div>
          )
        ) : (
          <ConnectionEditor
            key={draft.connection.id}
            view={view}
            saved={saved}
            draft={draft}
            onDraftChange={(next) => setDraft(draft.connection.id, next)}
            onSaved={(id) => {
              // A new connection's draft key isn't its id: Rust assigns that.
              dropDraft(draft.connection.id);
              setSelectedId(id);
            }}
            onDiscard={() => {
              const id = draft.connection.id;
              dropDraft(id);
              if (draft.isNew) setSelectedId(preferredId(view));
            }}
            onDeleted={() => {
              dropDraft(draft.connection.id);
              setSelectedId(null);
            }}
          />
        )}
      </div>
    </div>
  );
}
