// First-run / quick setup for the AI model: pick a provider template, fill in
// the address, key and model, and test with one tiny request. A successful
// draft is saved and made the default. The user can also save a failed draft
// explicitly to test it later. Used by the first-run wizard
// (variant "wizard") and reusable on a settings page.
//
// Reports "ok" once the default model works (tested), "error" with the
// failure after a failed test, "incomplete" otherwise. A build without the
// connection commands shows the placeholder instead.

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, RefreshCw, Settings2, Zap } from "lucide-react";
import { useT } from "../../i18n";
import { EndpointFields, type EndpointFieldsValue } from "../../components/EndpointFields";
import { ModelCombobox } from "../../components/ModelCombobox";
import { cn } from "../../lib/utils";
import { errorMessage } from "../../lib/llm/ipc";
import { chatPath, modelsPath, wantsVersionPrefix } from "../../lib/llm/endpoints";
import { isEmbeddingModel, modelOptions, toInput } from "../../lib/llm/connection";
import { effectiveRoute } from "../../lib/llm/tasks";
import type { LlmConnection, TestConnectionResult } from "../../lib/llm/types";
import type { ModelInfo } from "../../lib/types";
import { useLlmConfig, useLlmConnectionsStore } from "../../stores/llmConnectionsStore";
import { useMeetingStore } from "../../stores/meetingStore";
import { QuickSetupPlaceholder } from "../QuickSetupPlaceholder";
import type { QuickSetupProps, QuickSetupStatus } from "../quickSetup";
import { draftOf, draftProblems } from "./draft";
import { TestResultView } from "./ModelSection";
import { connectionFromTemplate, findTemplate, QUICK_SETUP_TEMPLATES, type ProviderTemplate } from "./providerTemplates";
import { connectionNameFrom, useTemplateName } from "./templateNames";
import { BUTTON, BUTTON_PRIMARY, CARD, ConnectionIcon, LABEL, LINK_BUTTON } from "./ui";

export function LlmQuickSetup(props: QuickSetupProps) {
  const { view, loadState } = useLlmConfig();
  if (loadState === "unavailable") return <QuickSetupPlaceholder {...props} area="llm" settingsTab="llm" />;
  if (!view) return <LoadingCard failed={loadState === "error"} />;
  return <QuickSetupBody {...props} />;
}

function LoadingCard({ failed }: { failed: boolean }) {
  const { t } = useT(["llm", "common"]);
  return (
    <div className={cn(CARD, "flex items-center gap-3")}>
      {failed ? (
        <>
          <p className="min-w-0 flex-1 text-xs text-destructive">{t("quickSetup.loadFailed")}</p>
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

/** One line for a failed test: the error, the body, or the status. */
function failureDetail(result: TestConnectionResult): string | undefined {
  return result.error || result.error_body || (result.status ? `HTTP ${result.status}` : undefined);
}

function QuickSetupBody({ variant, onStatusChange }: QuickSetupProps) {
  const { t } = useT(["llm", "common"]);
  const templateName = useTemplateName();
  const view = useLlmConnectionsStore((s) => s.view)!;
  const effective = effectiveRoute(view, "default");
  const defaultConnection = view.connections.find((c) => c.id === effective.connection_id) ?? null;
  const configured = !effective.error && !!defaultConnection;
  const ready = configured && (defaultConnection.kind === "claude_cli" || !!defaultConnection.verified_at_ms);

  const [changing, setChanging] = useState(false);
  const [connection, setConnection] = useState<LlmConnection | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [fetched, setFetched] = useState<ModelInfo[] | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<TestConnectionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const testVersion = useRef(0);
  const fetchVersion = useRef(0);

  useEffect(() => () => {
    testVersion.current += 1;
    fetchVersion.current += 1;
  }, []);

  // ── Status for the wizard: reported on change only (callers often pass an inline function) ──
  const failure = error ?? (result && !result.ok ? failureDetail(result) ?? "" : null);
  const status: QuickSetupStatus = failure !== null ? "error" : ready && !changing ? "ok" : "incomplete";
  const detail = status === "error" ? failure || undefined : undefined;
  const report = useRef(onStatusChange);
  report.current = onStatusChange;
  const reported = useRef<string | null>(null);
  useEffect(() => {
    const key = `${status}:${detail ?? ""}`;
    if (reported.current === key) return;
    reported.current = key;
    if (detail === undefined) report.current(status);
    else report.current(status, detail);
  }, [status, detail]);

  const template = findTemplate(connection?.template);

  const clearOutcome = () => {
    setResult(null);
    setError(null);
  };

  const editDraft = (resetModels = false) => {
    testVersion.current += 1;
    setBusy(false);
    clearOutcome();
    if (resetModels) {
      fetchVersion.current += 1;
      setFetching(false);
      setFetched(null);
      setFetchError(null);
    }
  };

  const fetchModels = async (draft: LlmConnection, key: string | null) => {
    const version = ++fetchVersion.current;
    setFetching(true);
    setFetchError(null);
    try {
      const outcome = await useLlmConnectionsStore.getState().fetchModels({ draft: toInput(draft), secret: key });
      if (version !== fetchVersion.current) return;
      if (outcome.ok) {
        setFetched(outcome.models.filter((m) => !isEmbeddingModel(m.id)));
        if (outcome.models.length === 0) setFetchError(t("editor.models.emptyList"));
      } else {
        setFetchError(outcome.error || outcome.error_body || (outcome.status ? `HTTP ${outcome.status}` : t("common:errors.unknown")));
      }
    } catch (err) {
      if (version === fetchVersion.current) setFetchError(errorMessage(err));
    } finally {
      if (version === fetchVersion.current) setFetching(false);
    }
  };

  const choose = (next: ProviderTemplate) => {
    editDraft(true);
    const created = connectionFromTemplate(next, connectionNameFrom(templateName(next.id)), view.connections.map((c) => c.name));
    setConnection(created);
    setSecret(null);
    // A local server answers right away: fetching its models shows it's running.
    if (next.kind === "ollama" || next.id === "lmstudio") void fetchModels(created, null);
  };

  const saveAndTest = async (keep: boolean) => {
    if (!connection || busy) return;
    const version = ++testVersion.current;
    const current = () => version === testVersion.current;
    const draft = {
      ...connection,
      id: "",
      name: connection.name.trim() || templateName(template?.id ?? "custom"),
    };
    const expectedDefault = view.routing.default;
    setBusy(true);
    clearOutcome();
    const store = useLlmConnectionsStore.getState();
    try {
      const outcome = keep ? null : await store.testConnection({
        draft: toInput(draft),
        secret,
        model: draft.default_model,
        mode: "chat",
      });
      if (!current()) return;
      if (outcome && !outcome.ok) {
        setResult(outcome);
        return;
      }
      if (outcome && !outcome.test_receipt) throw new Error(t("quickSetup.loadFailed"));
      setSaving(true);
      await store.upsertConnection(draft, {
        isNew: true,
        secret: secret ?? undefined,
        quickSetup: { expected_default: expectedDefault, test_receipt: outcome?.test_receipt ?? null },
      });
      if (!current()) return;
      setResult(outcome);
      setChanging(false);
      setConnection(null);
    } catch (err) {
      if (current()) setError(errorMessage(err));
    } finally {
      if (current()) {
        setBusy(false);
        setSaving(false);
      }
    }
  };

  const retest = async () => {
    if (!defaultConnection) return;
    const version = ++testVersion.current;
    setBusy(true);
    clearOutcome();
    try {
      const result = await useLlmConnectionsStore.getState().testConnection({ id: defaultConnection.id, model: effective.model, mode: "chat" });
      const latest = useLlmConnectionsStore.getState().view;
      const route = latest && effectiveRoute(latest, "default");
      if (version === testVersion.current && route?.connection_id === defaultConnection.id && route.model === effective.model) {
        setResult(result);
      }
    } catch (err) {
      if (version === testVersion.current) setError(errorMessage(err));
    } finally {
      if (version === testVersion.current) setBusy(false);
    }
  };

  const moreSettings =
    variant === "wizard" ? (
      <button
        type="button"
        onClick={() => useMeetingStore.getState().openSettings("llm")}
        className={cn(LINK_BUTTON, "inline-flex items-center gap-1")}
      >
        <Settings2 className="h-3.5 w-3.5" aria-hidden />
        {t("quickSetup.moreSettings")}
      </button>
    ) : null;

  const outcome = (
    <>
      {result && <TestResultView result={result} />}
      {error && <p className="break-words text-xs text-destructive">{t("common:errors.testFailed", { detail: error })}</p>}
    </>
  );

  // ── A default model is set up: show it ──
  if (configured && !changing) {
    const name = effective.connection_name || t("connections.untitled");
    const target = effective.kind === "claude_cli" ? name : `${name} / ${effective.model ?? ""}`;
    return (
      <div className={cn(CARD, "space-y-3")}>
        <div className="flex items-start gap-3">
          {ready ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
          ) : (
            <Zap className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">
              {ready ? t("quickSetup.ready", { target }) : t("quickSetup.configured", { target })}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">{ready ? t("quickSetup.readyHint") : t("quickSetup.untestedHint")}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {effective.kind !== "claude_cli" && (
            <button type="button" onClick={() => void retest()} disabled={busy} className={BUTTON}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
              {ready ? t("quickSetup.retest") : t("quickSetup.test")}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              clearOutcome();
              setChanging(true);
            }}
            disabled={busy}
            className={BUTTON}
          >
            {t("quickSetup.change")}
          </button>
          {moreSettings}
        </div>
        {outcome}
      </div>
    );
  }

  // ── Pick a template, fill in the form, test ──
  const options = connection
    ? modelOptions(
        { ...connection, model_cache: fetched ? { models: fetched, fetched_at_ms: null, url: null, error: null } : null },
      )
    : [];
  const fields: EndpointFieldsValue | null = connection
    ? { baseUrl: connection.base_url, auth: connection.auth, headers: connection.headers }
    : null;
  const problems = connection ? draftProblems(draftOf(connection, true), null, false) : [];
  const canTest = !!connection && problems.length === 0 && !!connection.default_model?.trim();

  return (
    <div className={cn(CARD, "space-y-4")}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-foreground">{t("quickSetup.title")}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("quickSetup.hint")}</p>
        </div>
        {configured && (
          <button
            type="button"
            onClick={() => {
              editDraft(true);
              setConnection(null);
              setSecret(null);
              setChanging(false);
            }}
            disabled={saving}
            className={LINK_BUTTON}
          >
            {t("common:actions.cancel")}
          </button>
        )}
      </div>

      <div>
        <span id="llm-quick-templates" className={LABEL}>
          {t("quickSetup.provider")}
        </span>
        <div role="group" aria-labelledby="llm-quick-templates" className="grid grid-cols-3 gap-1.5">
          {QUICK_SETUP_TEMPLATES.map((id) => {
            const item = findTemplate(id)!;
            const selected = connection?.template === id;
            return (
              <button
                key={id}
                type="button"
                aria-pressed={selected}
                disabled={saving}
                onClick={() => choose(item)}
                className={cn(
                  "flex min-w-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors duration-150 cursor-pointer",
                  selected ? "border-primary/50 bg-primary/5 text-primary" : "border-border/50 text-foreground/80 hover:bg-accent/50",
                )}
              >
                <ConnectionIcon connection={{ kind: item.kind, template: id }} />
                <span className="truncate">{templateName(id)}</span>
              </button>
            );
          })}
        </div>
      </div>

      {connection && fields && (
        <>
          <EndpointFields
            idPrefix="llm-quick"
            value={fields}
            onChange={(next) => {
              editDraft(true);
              setConnection({ ...connection, base_url: next.baseUrl, auth: next.auth, headers: next.headers.map((h) => ({ secret: false, ...h })) });
            }}
            path={chatPath(connection.kind, connection.base_url, connection.default_model) ?? ""}
            extraPaths={(() => {
              const path = modelsPath(connection.kind, connection.base_url);
              return path ? [{ label: t("editor.modelsUrlLabel"), path }] : [];
            })()}
            versionHint={wantsVersionPrefix(connection.kind) && !template?.noVersionPrefix}
            baseUrlPlaceholder={template?.baseUrlPlaceholder}
            secretStatus={secret ? { saved: true, hint: secret.slice(-4) } : { saved: false }}
            onSecretChange={(value) => {
              editDraft(true);
              setSecret(value);
            }}
            disabled={saving}
            showHeaders={false}
          />
          <div>
            <label htmlFor="llm-quick-model" className={LABEL}>
              {t("editor.models.default.label")}
            </label>
            <ModelCombobox
              id="llm-quick-model"
              value={connection.default_model ?? ""}
              onChange={(model) => {
                editDraft();
                setConnection({ ...connection, default_model: model || null });
              }}
              options={options}
              loading={fetching}
              disabled={saving}
              error={fetchError}
              onRefresh={() => void fetchModels(connection, secret)}
              placeholder={t("editor.models.default.placeholder")}
            />
            {fetched && fetched.length > 0 && (connection.kind === "ollama" || connection.template === "lmstudio") && (
              <p className="mt-1.5 text-xs text-success">{t("quickSetup.localFound", { count: fetched.length })}</p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void saveAndTest(false)} disabled={busy || !canTest} className={BUTTON_PRIMARY}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
              {busy ? t("common:status.testing") : t("quickSetup.testAndSave")}
            </button>
            {result && !result.ok && (
              <button type="button" onClick={() => void saveAndTest(true)} disabled={busy} className={LINK_BUTTON}>
                {t("quickSetup.saveAnyway")}
              </button>
            )}
            {moreSettings}
          </div>
          {!canTest && !busy && (
            <p className="text-xs text-muted-foreground">
              {problems.length > 0 ? t(`editor.problems.${problems[0]}`) : t("editor.test.needModel")}
            </p>
          )}
          {outcome}
        </>
      )}
    </div>
  );
}
