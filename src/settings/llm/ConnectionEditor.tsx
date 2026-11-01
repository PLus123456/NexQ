// Editor of one LLM connection: name, protocol, address and key (the shared
// EndpointFields), models and a test chat, default parameters and advanced
// switches. Edits stay in a draft until Save. Changing the protocol or the
// host the key would go to asks for the key again (Rust drops the stored key
// in that case), so a saved key is never sent somewhere new by accident.

import { useEffect, useState } from "react";
import { ChevronDown, CircleAlert, Info, KeyRound, Loader2, ShieldAlert, Star, Trash2, Undo2 } from "lucide-react";
import { useT } from "../../i18n";
import { EndpointFields, type EndpointFieldsValue } from "../../components/EndpointFields";
import { cn } from "../../lib/utils";
import { errorMessage } from "../../lib/llm/ipc";
import { bareHint } from "../../lib/llm/connection";
import { chatPath, isPlainHttpRemote, looksLikeOpenAiPath, modelsPath, wantsVersionPrefix } from "../../lib/llm/endpoints";
import { tasksUsing } from "../../lib/llm/tasks";
import type { LlmConfigView, LlmConnection, LlmKind, SecretStatus } from "../../lib/llm/types";
import { useLlmConnectionsStore } from "../../stores/llmConnectionsStore";
import { showToast } from "../../stores/toastStore";
import { ClaudeCliSettings } from "../ClaudeCliSettings";
import { AdvancedSection } from "./AdvancedSection";
import {
  connectionToSave,
  draftProblems,
  endpointFingerprint,
  isDirty,
  needsSecretReentry,
  secretToSave,
  type ConnectionDraft,
  type DraftProblem,
} from "./draft";
import { ModelSection } from "./ModelSection";
import { ParamsFields } from "./ParamsFields";
import { findTemplate, hasTemplateNote } from "./providerTemplates";
import { useTemplateName } from "./templateNames";
import {
  BUTTON,
  BUTTON_DANGER,
  BUTTON_PRIMARY,
  CARD,
  ConnectionIcon,
  INPUT,
  LABEL,
  LINK_BUTTON,
  Notice,
  PLAIN_TEXT,
  SECTION_TITLE,
  SELECT,
  Toggle,
} from "./ui";

const EDITABLE_KINDS: readonly Exclude<LlmKind, "claude_cli">[] = ["openai_compat", "anthropic", "gemini", "ollama"];

interface ConnectionEditorProps {
  view: LlmConfigView;
  /** The saved connection; null while a new one hasn't been saved. */
  saved: LlmConnection | null;
  draft: ConnectionDraft;
  onDraftChange: (next: ConnectionDraft) => void;
  /** Saved under `id` (new connections get theirs from Rust): the draft can be dropped. */
  onSaved: (id: string) => void;
  onDiscard: () => void;
  onDeleted: () => void;
}

export function ConnectionEditor({ view, saved, draft, onDraftChange, onSaved, onDiscard, onDeleted }: ConnectionEditorProps) {
  const { t } = useT(["llm", "common"]);
  const templateName = useTemplateName();
  const c = draft.connection;
  const template = findTemplate(c.template);
  const isDefault = !draft.isNew && view.routing.default.target?.connection_id === c.id;
  const usedBy = draft.isNew ? [] : tasksUsing(view, c.id);

  const [secret, setSecret] = useState<SecretStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // What's in the keychain. Reading it may prompt, so only here, once per editor
  // (and again when the hint shows the key changed).
  const savedId = saved?.id ?? null;
  const savedHint = saved?.secret_hint ?? null;
  useEffect(() => {
    if (!savedId || c.kind === "claude_cli") {
      setSecret(null);
      return;
    }
    let alive = true;
    useLlmConnectionsStore
      .getState()
      .secretStatus(savedId)
      .then((status) => alive && setSecret(status))
      .catch(() => alive && setSecret(savedHint ? { present: true, hint: savedHint } : null));
    return () => {
      alive = false;
    };
  }, [savedId, savedHint, c.kind]);

  const secretSaved = secret?.present ?? savedHint !== null;
  const dirty = isDirty(draft, saved);
  const problems = draftProblems(draft, saved, secretSaved);
  const reentry = needsSecretReentry(draft, saved, secretSaved);
  const update = (patch: Partial<LlmConnection>) => onDraftChange({ ...draft, connection: { ...c, ...patch } });

  // ── Address and key ──
  const fieldsValue: EndpointFieldsValue = { baseUrl: c.base_url, auth: c.auth, headers: c.headers };
  const handleFields = (next: EndpointFieldsValue) =>
    update({
      base_url: next.baseUrl,
      auth: next.auth,
      // New rows are plain headers; existing ones keep their secret flags.
      headers: next.headers.map((h) => ({ secret: false, ...h })),
    });
  const path = chatPath(c.kind, c.base_url, c.default_model) ?? "";
  const listPath = c.models_endpoint === "auto" ? modelsPath(c.kind, c.base_url) : null;
  const shownSecret = draft.pendingSecret
    ? { saved: true, hint: draft.pendingSecret.slice(-4) }
    : draft.clearSecret
      ? { saved: false }
      : { saved: secretSaved, hint: bareHint(secret?.hint ?? savedHint) };
  const handleSecret = (value: string | null) => {
    if (value === null) onDraftChange({ ...draft, pendingSecret: null, clearSecret: draft.pendingSecret === null && secretSaved });
    else onDraftChange({ ...draft, pendingSecret: value, clearSecret: false });
  };

  const revertAddress = () => {
    if (!saved) return;
    update({
      kind: saved.kind,
      base_url: saved.base_url,
      chat_url_override: saved.chat_url_override,
      models_endpoint: saved.models_endpoint,
      models_url: saved.models_url,
    });
  };

  const blockedReason = reentry ? t("editor.secret.reentryShort") : null;

  // ── Save, discard, delete, default ──
  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const store = useLlmConnectionsStore.getState();
      const connection = connectionToSave(draft);
      // One call: a new key travels with a new address (never old key + new host).
      const id = await store.upsertConnection(connection, { isNew: draft.isNew, secret: secretToSave(draft) });
      // The first usable connection becomes the default.
      const latest = useLlmConnectionsStore.getState().view;
      if (
        latest &&
        !latest.routing.default.target &&
        connection.enabled &&
        (connection.kind === "claude_cli" || connection.default_model)
      ) {
        await store.setDefaultRoute({ connection_id: id, model: null });
      }
      // A test of exactly this setup passed before saving: record it (Rust keeps the test time).
      if (draft.testedFingerprint === endpointFingerprint(connection)) {
        void store.testConnection({ id, mode: "chat" }).catch(() => {});
      }
      onSaved(id);
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!saved) {
      onDiscard();
      return;
    }
    try {
      const cleared = await useLlmConnectionsStore.getState().deleteConnection(saved.id);
      const followers = cleared.filter((task) => task !== "default").length;
      showToast(
        followers > 0
          ? t("editor.delete.doneWithRoutes", { name: saved.name, count: followers })
          : t("editor.delete.done", { name: saved.name }),
        "success",
      );
      onDeleted();
    } catch (err) {
      showToast(t("common:errors.operationFailed", { detail: errorMessage(err) }), "error");
    } finally {
      setConfirmDelete(false);
    }
  };

  const makeDefault = async () => {
    try {
      await useLlmConnectionsStore.getState().setDefaultRoute({ connection_id: c.id, model: null });
    } catch (err) {
      showToast(t("common:errors.operationFailed", { detail: errorMessage(err) }), "error");
    }
  };
  const canBeDefault = !draft.isNew && c.enabled && (c.kind === "claude_cli" || !!saved?.default_model);

  const problemText = (problem: DraftProblem) => t(`editor.problems.${problem}`);

  return (
    <div className="space-y-4">
      {/* Header: name, protocol, default, on/off */}
      <div className={CARD}>
        <div className="flex items-start gap-3">
          <ConnectionIcon connection={c} className="mt-2.5 h-4 w-4" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <input
              type="text"
              {...PLAIN_TEXT}
              value={c.name}
              onChange={(e) => update({ name: e.target.value })}
              placeholder={template ? templateName(template.id) : t("connections.untitled")}
              aria-label={t("editor.name.label")}
              className={cn(INPUT, "text-sm font-medium")}
            />
            <p className="text-xs text-muted-foreground">
              {[t(`kinds.${c.kind}`), template && template.id !== "custom" ? t("editor.fromTemplate", { name: templateName(template.id) }) : null]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2 pt-1">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              {t("editor.enabled")}
              <Toggle checked={c.enabled} onChange={(enabled) => update({ enabled })} label={t("editor.enabled")} />
            </label>
            {isDefault ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-meta font-medium text-primary">
                <Star className="h-3 w-3" aria-hidden />
                {t("editor.isDefault")}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => void makeDefault()}
                disabled={!canBeDefault}
                title={!canBeDefault ? t("editor.makeDefaultHint") : undefined}
                className={LINK_BUTTON}
              >
                {t("editor.makeDefault")}
              </button>
            )}
          </div>
        </div>
        {!c.enabled && usedBy.length > 0 && (
          <Notice tone="warning" icon={<CircleAlert className="h-3.5 w-3.5 text-warning" />} className="mt-3">
            {t("editor.disabledInUse")}
          </Notice>
        )}
      </div>

      {c.kind === "claude_cli" ? (
        <ClaudeCliSettings selected active={isDefault} onSelect={() => {}} embedded />
      ) : (
        <>
          {/* Address and key */}
          <div className={cn(CARD, "space-y-4")}>
            <h3 className={SECTION_TITLE}>{t("editor.sections.endpoint")}</h3>
            <div>
              <label htmlFor={`kind-${c.id}`} className={LABEL}>
                {t("editor.kind.label")}
              </label>
              <select
                id={`kind-${c.id}`}
                value={c.kind}
                onChange={(e) => update({ kind: e.target.value as LlmKind })}
                className={SELECT}
              >
                {EDITABLE_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {t(`kinds.${kind}`)}
                  </option>
                ))}
              </select>
              <p className="mt-1.5 text-xs text-muted-foreground">{t(`editor.kind.hints.${c.kind}`)}</p>
            </div>

            {template?.altBaseUrls && template.altBaseUrls.length > 0 && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>{t("editor.altBaseUrls.label")}</span>
                {[{ id: "china" as const, url: template.baseUrl }, ...template.altBaseUrls]
                  .filter((alt) => alt.url && alt.url !== c.base_url)
                  .map((alt) => (
                    <button key={alt.url} type="button" onClick={() => update({ base_url: alt.url })} className={LINK_BUTTON}>
                      {t(`editor.altBaseUrls.${alt.id}`)}
                    </button>
                  ))}
              </div>
            )}

            <EndpointFields
              idPrefix={`conn-${c.id}`}
              value={fieldsValue}
              onChange={handleFields}
              path={path}
              extraPaths={listPath ? [{ label: t("editor.modelsUrlLabel"), path: listPath }] : []}
              versionHint={wantsVersionPrefix(c.kind) && !template?.noVersionPrefix}
              baseUrlPlaceholder={template?.baseUrlPlaceholder}
              secretStatus={shownSecret}
              onSecretChange={handleSecret}
            />

            {draft.pendingSecret && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <KeyRound className="h-3.5 w-3.5" aria-hidden />
                {t("editor.secret.pending")}
              </p>
            )}
            {draft.clearSecret && <p className="text-xs text-muted-foreground">{t("editor.secret.willClear")}</p>}
            {template?.needsKey && !secretSaved && !draft.pendingSecret && c.auth.mode !== "none" && (
              <p className="text-xs text-muted-foreground">
                {t("editor.secret.needed")}{" "}
                {template.keyUrl && <span className="select-text break-all font-mono text-foreground/70">{template.keyUrl}</span>}
              </p>
            )}

            {reentry && (
              <Notice tone="warning" icon={<KeyRound className="h-3.5 w-3.5 text-warning" />}>
                <p>{t("editor.secret.reentry")}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" onClick={revertAddress} className={BUTTON}>
                    <Undo2 className="h-3.5 w-3.5" aria-hidden />
                    {t("editor.secret.revert")}
                  </button>
                  <button
                    type="button"
                    onClick={() => onDraftChange({ ...draft, clearSecret: true, pendingSecret: null })}
                    className={BUTTON}
                  >
                    {t("editor.secret.clear")}
                  </button>
                </div>
              </Notice>
            )}

            {c.auth.mode !== "none" && isPlainHttpRemote(c.base_url) && (
              <Notice tone="warning" icon={<ShieldAlert className="h-3.5 w-3.5 text-warning" />}>
                {t("editor.plainHttp")}
              </Notice>
            )}
            {c.chat_url_override?.trim() && (
              <Notice icon={<Info className="h-3.5 w-3.5 text-info" />}>{t("editor.overrideActive")}</Notice>
            )}
            {looksLikeOpenAiPath(c.kind, c.base_url) && (
              <Notice tone="warning" icon={<CircleAlert className="h-3.5 w-3.5 text-warning" />}>
                {t("editor.ollamaV1")}
              </Notice>
            )}
            {template && hasTemplateNote(template.id) && (
              <Notice icon={<Info className="h-3.5 w-3.5 text-info" />}>{t(`templates.items.${template.id}.note`)}</Notice>
            )}
          </div>

          {/* Models and test */}
          <div className={cn(CARD, "space-y-4")}>
            <h3 className={SECTION_TITLE}>{t("editor.sections.models")}</h3>
            <ModelSection
              draft={draft}
              saved={saved}
              template={template}
              blockedReason={blockedReason}
              onDraftChange={onDraftChange}
            />
          </div>

          {/* Default parameters */}
          <div className={cn(CARD, "space-y-3")}>
            <div>
              <h3 className={SECTION_TITLE}>{t("editor.sections.params")}</h3>
              <p className="mt-1 text-xs text-muted-foreground">{t("editor.paramsHint")}</p>
            </div>
            <ParamsFields
              idPrefix={`params-${c.id}`}
              value={c.params}
              onChange={(params) => update({ params })}
              disableThinking={template?.disableThinking}
              onValidityChange={(valid) => {
                const invalid = valid ? draft.invalid.filter((f) => f !== "params") : [...new Set([...draft.invalid, "params"])];
                if (invalid.length !== draft.invalid.length) onDraftChange({ ...draft, invalid });
              }}
            />
          </div>

          {/* Advanced */}
          <div className={CARD}>
            <button
              type="button"
              onClick={() => setAdvancedOpen((open) => !open)}
              aria-expanded={advancedOpen}
              className="flex w-full items-center justify-between gap-2 text-left cursor-pointer"
            >
              <span className={SECTION_TITLE}>{t("editor.sections.advanced")}</span>
              <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", advancedOpen && "rotate-180")} aria-hidden />
            </button>
            {advancedOpen && (
              <div className="mt-4">
                <AdvancedSection connection={c} onChange={update} />
              </div>
            )}
          </div>
        </>
      )}

      {/* Save bar */}
      <div className="sticky bottom-0 z-10 -mx-1 rounded-xl border border-border/30 bg-card/95 px-4 py-3 shadow-lg shadow-black/5 backdrop-blur">
        {problems.length > 0 && dirty && (
          <ul className="mb-2 space-y-0.5 text-xs text-warning">
            {problems.map((problem) => (
              <li key={problem}>{problemText(problem)}</li>
            ))}
          </ul>
        )}
        {saveError && <p className="mb-2 break-words text-xs text-destructive">{t("common:errors.saveFailed", { detail: saveError })}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || !dirty || problems.length > 0}
            className={BUTTON_PRIMARY}
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
            {saving ? t("common:status.saving") : t("common:actions.save")}
          </button>
          {dirty && (
            <button type="button" onClick={onDiscard} disabled={saving} className={BUTTON}>
              {draft.isNew ? t("common:actions.cancel") : t("editor.discard")}
            </button>
          )}
          <span className="text-xs text-muted-foreground">
            {dirty ? (draft.isNew ? t("editor.state.new") : t("editor.state.unsaved")) : t("editor.state.saved")}
          </span>
          {!draft.isNew && (
            <div className="ml-auto flex items-center gap-2">
              {confirmDelete ? (
                <>
                  <span className="text-xs text-muted-foreground">
                    {usedBy.length > 0 ? t("editor.delete.confirmInUse", { count: usedBy.length }) : t("editor.delete.confirm")}
                  </span>
                  <button type="button" onClick={() => void remove()} className={BUTTON_DANGER}>
                    {t("common:actions.delete")}
                  </button>
                  <button type="button" onClick={() => setConfirmDelete(false)} className={BUTTON}>
                    {t("common:actions.cancel")}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className={cn(BUTTON, "text-muted-foreground")}
                  aria-label={t("editor.delete.button")}
                  title={t("editor.delete.button")}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
