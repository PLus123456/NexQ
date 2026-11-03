// Models of a connection: the default model (typed or picked), the user's own
// model list, fetching the list from the server, and a test chat with one
// tiny request that shows the real address, status and answer or raw error.

import { useEffect, useState } from "react";
import { CheckCircle2, ChevronDown, Loader2, MessageSquare, Plus, RefreshCw, X, XCircle } from "lucide-react";
import { formatDate, formatNumber, useT } from "../../i18n";
import { ModelCombobox } from "../../components/ModelCombobox";
import { cn } from "../../lib/utils";
import { errorMessage } from "../../lib/llm/ipc";
import { formatTokenCount, isEmbeddingModel, modelOptions, parseTokenCount, toInput } from "../../lib/llm/connection";
import type { FetchModelsResult, LlmConnection, ResultHint, TestConnectionResult } from "../../lib/llm/types";
import type { ModelInfo, OpenRouterModel } from "../../lib/types";
import { listOpenRouterModels } from "../../lib/ipc";
import { OpenRouterModelCatalog } from "../openrouter/OpenRouterModelCatalog";
import { useLlmConnectionsStore } from "../../stores/llmConnectionsStore";
import { endpointFingerprint, type ConnectionDraft } from "./draft";
import { BUTTON, HINT, INPUT, INPUT_INVALID, LABEL, PLAIN_TEXT } from "./ui";

const HINTS: readonly ResultHint[] = ["check_version_prefix", "auth_failed", "no_model", "base_url_invalid", "looks_openai_compat"];

/** A failed fetch or test as one line: the error, else the status, else a generic word. */
function failureText(result: Pick<FetchModelsResult, "error" | "error_body" | "status">): string | null {
  return result.error || result.error_body || (result.status ? `HTTP ${result.status}` : null);
}

export function ModelSection({
  draft,
  saved,
  blockedReason,
  onDraftChange,
}: {
  draft: ConnectionDraft;
  saved: LlmConnection | null;
  /** Why requests can't be sent right now (e.g. the key must be re-entered); null when they can. */
  blockedReason: string | null;
  onDraftChange: (next: ConnectionDraft) => void;
}) {
  const { t } = useT(["llm", "common"]);
  const c = draft.connection;
  const [fetched, setFetched] = useState<{ models: ModelInfo[]; at: number } | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestConnectionResult | null>(null);
  const [newModel, setNewModel] = useState("");

  const update = (patch: Partial<LlmConnection>) => onDraftChange({ ...draft, connection: { ...c, ...patch } });

  // The cache lives on the saved connection (it changes while the draft doesn't);
  // a list fetched here for unsaved edits replaces it.
  const cache = saved?.model_cache ?? null;
  const models = (fetched?.models ?? cache?.models ?? []).filter((m) => !isEmbeddingModel(m.id));
  const options = modelOptions(
    { ...c, model_cache: { models, fetched_at_ms: null, url: null, error: null } },
  );
  const testModel = c.default_model?.trim() || c.manual_models[0] || "";
  const modelsOff = c.models_endpoint === "disabled";
  // Unsaved address changes are tried as a draft; a clean saved connection by id (its list is cached).
  const clean =
    !!saved && !draft.isNew && draft.pendingSecret === null && endpointFingerprint(saved) === endpointFingerprint(c);

  const fetchModels = async () => {
    if (blockedReason) return;
    setFetching(true);
    setFetchError(null);
    try {
      const store = useLlmConnectionsStore.getState();
      const outcome = clean
        ? await store.fetchModels({ id: c.id })
        : await store.fetchModels({ draft: toInput(c), secret: draft.pendingSecret });
      if (outcome.ok) {
        setFetched({ models: outcome.models, at: Date.now() });
        if (outcome.models.length === 0) setFetchError(t("editor.models.emptyList"));
      } else {
        const hint = HINTS.find((h) => h === outcome.hint);
        setFetchError([failureText(outcome), hint ? t(`editor.hints.${hint}`) : null].filter(Boolean).join(" — "));
      }
    } catch (err) {
      setFetchError(errorMessage(err));
    } finally {
      setFetching(false);
    }
  };

  const test = async () => {
    if (blockedReason) return;
    setTesting(true);
    setResult(null);
    try {
      const store = useLlmConnectionsStore.getState();
      const outcome = clean
        ? await store.testConnection({ id: c.id, model: testModel || null, mode: "chat" })
        : await store.testConnection({ draft: toInput(c), secret: draft.pendingSecret, model: testModel || null, mode: "chat" });
      setResult(outcome);
      if (outcome.ok && !clean) onDraftChange({ ...draft, testedFingerprint: endpointFingerprint(c), testedAt: Date.now() });
    } catch (err) {
      setResult({
        ok: false,
        url: null,
        status: null,
        latency_ms: 0,
        model: null,
        sample: null,
        error: errorMessage(err),
        error_body: null,
        hint: null,
      });
    } finally {
      setTesting(false);
    }
  };

  const addManual = () => {
    const id = newModel.trim();
    if (!id) return;
    setNewModel("");
    if (!c.manual_models.includes(id)) update({ manual_models: [...c.manual_models, id] });
  };

  const fetchedAt = fetched?.at ?? cache?.fetched_at_ms ?? null;

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor={`model-${c.id}`} className={LABEL}>
          {t("editor.models.default.label")}
        </label>
        <ModelCombobox
          id={`model-${c.id}`}
          value={c.default_model ?? ""}
          onChange={(model) => update({ default_model: model || null })}
          options={options}
          loading={fetching}
          error={fetchError}
          onRefresh={modelsOff || blockedReason ? undefined : () => void fetchModels()}
          placeholder={t("editor.models.default.placeholder")}
        />
        <p className={HINT}>{t("editor.models.default.hint")}</p>
      </div>

      <div>
        <span id={`manual-${c.id}-label`} className={LABEL}>
          {t("editor.models.manual.label")}
        </span>
        {c.manual_models.length > 0 && (
          <ul aria-labelledby={`manual-${c.id}-label`} className="mb-2 flex flex-wrap gap-1.5">
            {c.manual_models.map((id) => (
              <li
                key={id}
                className="inline-flex max-w-full items-center gap-1 rounded-full border border-border/40 bg-secondary/40 py-0.5 pl-2.5 pr-1 font-mono text-[11px] text-foreground/90"
              >
                <span className="truncate">{id}</span>
                <button
                  type="button"
                  onClick={() => update({ manual_models: c.manual_models.filter((m) => m !== id) })}
                  aria-label={t("editor.models.manual.remove", { model: id })}
                  className="rounded-full p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground cursor-pointer"
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex gap-2">
          <input
            type="text"
            {...PLAIN_TEXT}
            value={newModel}
            onChange={(e) => setNewModel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addManual();
              }
            }}
            placeholder={t("editor.models.manual.placeholder")}
            aria-label={t("editor.models.manual.placeholder")}
            className={cn(INPUT, "flex-1 font-mono")}
          />
          <button type="button" onClick={addManual} disabled={!newModel.trim()} className={BUTTON}>
            <Plus className="h-3.5 w-3.5" aria-hidden />
            {t("common:actions.add")}
          </button>
        </div>
        <p className={HINT}>{t("editor.models.manual.hint")}</p>
      </div>

      <ContextWindows
        connection={c}
        listed={fetched?.models ?? cache?.models ?? []}
        onChange={(context_windows) => update({ context_windows })}
      />

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void test()}
            disabled={testing || !!blockedReason || !testModel}
            className={BUTTON}
            title={!testModel ? t("editor.test.needModel") : undefined}
          >
            {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <MessageSquare className="h-3.5 w-3.5" aria-hidden />}
            {testing ? t("common:status.testing") : t("editor.test.button")}
          </button>
          {!modelsOff && (
            <button type="button" onClick={() => void fetchModels()} disabled={fetching || !!blockedReason} className={BUTTON}>
              {fetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />}
              {t("editor.models.fetch")}
            </button>
          )}
          {!testing && testModel && <span className="text-xs text-muted-foreground">{t("editor.test.withModel", { model: testModel })}</span>}
        </div>
        {blockedReason && <p className="text-xs text-warning">{blockedReason}</p>}
        {!blockedReason && !testModel && <p className="text-xs text-muted-foreground">{t("editor.test.needModel")}</p>}
        {fetchedAt !== null && models.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {t("editor.models.fetchedInfo", {
              count: models.length,
              countText: formatNumber(models.length),
              time: formatDate(fetchedAt, { dateStyle: "short", timeStyle: "short" }),
            })}
          </p>
        )}
        {!fetched && cache?.error && <p className="text-xs text-warning">{t("editor.models.lastFetchFailed", { detail: cache.error })}</p>}
        {result && <TestResultView result={result} />}
      </div>

      {isOpenRouter(c) && (
        <OpenRouterBrowser
          connectionId={saved && !draft.isNew ? saved.id : undefined}
          selectedId={c.default_model ?? ""}
          onSelect={(model) => update({ default_model: model })}
        />
      )}
    </div>
  );
}

/**
 * Context length per model: the default model, the user's list and any model
 * that already has a value. Blank uses what the model list says.
 */
function ContextWindows({
  connection,
  listed,
  onChange,
}: {
  connection: LlmConnection;
  /** The fetched list, for the context lengths the server reports. */
  listed: ModelInfo[];
  onChange: (next: Record<string, number>) => void;
}) {
  const { t } = useT("llm");
  const windows = connection.context_windows;
  const models = Array.from(
    new Set(
      [connection.default_model?.trim() ?? "", ...connection.manual_models, ...Object.keys(windows)].filter(Boolean),
    ),
  );
  if (connection.kind === "claude_cli" || models.length === 0) return null;

  const set = (model: string, tokens: number | null) => {
    const next = { ...windows };
    if (tokens === null) delete next[model];
    else next[model] = tokens;
    onChange(next);
  };

  return (
    <div>
      <span id={`context-${connection.id}-label`} className={LABEL}>
        {t("editor.models.context.label")}
      </span>
      <ul aria-labelledby={`context-${connection.id}-label`} className="space-y-1.5">
        {models.map((model) => (
          <ContextWindowRow
            key={model}
            model={model}
            value={windows[model] ?? null}
            listed={listed.find((m) => m.id === model)?.context_window ?? null}
            onChange={(tokens) => set(model, tokens)}
          />
        ))}
      </ul>
      <p className={HINT}>{t("editor.models.context.hint")}</p>
    </div>
  );
}

function ContextWindowRow({
  model,
  value,
  listed,
  onChange,
}: {
  model: string;
  value: number | null;
  listed: number | null;
  onChange: (tokens: number | null) => void;
}) {
  const { t } = useT("llm");
  const [text, setText] = useState(value ? formatTokenCount(value) : "");
  const parsed = parseTokenCount(text);

  // Follow outside changes (a discarded draft) without rewriting what is being typed.
  useEffect(() => {
    setText((current) => (parseTokenCount(current) === value ? current : value ? formatTokenCount(value) : ""));
  }, [value]);

  return (
    <li className="flex items-center gap-2">
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/90" title={model}>
        {model}
      </span>
      <input
        type="text"
        {...PLAIN_TEXT}
        inputMode="text"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const tokens = parseTokenCount(e.target.value);
          if (tokens !== undefined) onChange(tokens);
        }}
        placeholder={
          listed ? t("editor.models.context.fromList", { size: formatTokenCount(listed) }) : t("editor.models.context.placeholder")
        }
        aria-label={t("editor.models.context.input", { model })}
        aria-invalid={parsed === undefined}
        className={cn(INPUT, "w-36 shrink-0 font-mono", parsed === undefined && INPUT_INVALID)}
      />
    </li>
  );
}

/** An OpenRouter connection (by template, or by its address). */
function isOpenRouter(connection: LlmConnection): boolean {
  if (connection.template === "openrouter") return true;
  try {
    return new URL(connection.base_url.trim()).hostname.toLowerCase().endsWith("openrouter.ai");
  } catch {
    return false;
  }
}

/** OpenRouter's catalog (prices, context, capabilities) to pick the default model from. */
function OpenRouterBrowser({
  connectionId,
  selectedId,
  onSelect,
}: {
  /** The saved connection whose key lists the models; the catalog is public, so a new one works too. */
  connectionId?: string;
  selectedId: string;
  onSelect: (model: string) => void;
}) {
  const { t } = useT("llm");
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<OpenRouterModel[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (force: boolean) => {
    setLoading(true);
    setError(null);
    try {
      setModels(await listOpenRouterModels(force, connectionId));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !models && !loading) void load(false);
  };

  return (
    <div className="border-t border-border/20 pt-3">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline cursor-pointer"
      >
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} aria-hidden />
        {open ? t("openrouter.hide") : t("openrouter.browse")}
      </button>
      {open && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-muted-foreground">{t("openrouter.picked")}</p>
          {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />}
          {error && <p className="break-words text-xs text-destructive">{t("openrouter.loadFailed", { detail: error })}</p>}
          {models && <OpenRouterModelCatalog models={models} selectedId={selectedId} onSelect={onSelect} />}
        </div>
      )}
    </div>
  );
}

export function TestResultView({ result }: { result: TestConnectionResult }) {
  const { t } = useT(["llm", "common"]);
  const hint = HINTS.find((h) => h === result.hint);
  const meta = [
    result.status !== null ? t("editor.test.status", { status: result.status }) : null,
    result.latency_ms > 0 ? t("common:units.milliseconds", { count: Math.round(result.latency_ms) }) : null,
  ].filter(Boolean);
  return (
    <div
      role="status"
      className={cn(
        "space-y-1.5 rounded-lg border px-3 py-2.5 text-xs",
        result.ok ? "border-success/25 bg-success/5" : "border-destructive/25 bg-destructive/5",
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {result.ok ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-success" aria-hidden />
        ) : (
          <XCircle className="h-3.5 w-3.5 text-destructive" aria-hidden />
        )}
        <span className={cn("font-medium", result.ok ? "text-success" : "text-destructive")}>
          {result.ok ? t("editor.test.ok") : t("editor.test.failed")}
        </span>
        {meta.length > 0 && <span className="text-muted-foreground">· {meta.join(" · ")}</span>}
      </div>
      {result.url && (
        <p className="break-all text-muted-foreground">
          {t("editor.test.url")} <span className="select-text font-mono text-foreground/80">{result.url}</span>
        </p>
      )}
      {result.ok && result.model && (
        <p className="text-muted-foreground">
          {t("editor.test.model")} <span className="select-text font-mono text-foreground/80">{result.model}</span>
        </p>
      )}
      {result.ok && (
        <p className="text-muted-foreground">
          {t("editor.test.reply")}{" "}
          {result.sample ? (
            <span className="select-text text-foreground/90">{result.sample}</span>
          ) : (
            <span className="italic">{t("editor.test.reasoningOnly")}</span>
          )}
        </p>
      )}
      {!result.ok && result.error && <p className="select-text break-words text-foreground/90">{result.error}</p>}
      {!result.ok && result.error_body && result.error_body !== result.error && (
        <pre className="max-h-40 select-text overflow-auto whitespace-pre-wrap break-all rounded-md bg-background/60 p-2 font-mono text-[11px] text-foreground/80">
          {result.error_body}
        </pre>
      )}
      {!result.ok && hint && <p className="text-muted-foreground">{t(`editor.hints.${hint}`)}</p>}
    </div>
  );
}
