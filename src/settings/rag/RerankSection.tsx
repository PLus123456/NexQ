// Reranking of the knowledge base search: on / off, the service (a reused
// LLM connection, or its own address and key through EndpointFields),
// model, request format, candidates and timeout. Edits stay in a draft
// until saved; the key is saved on its own (keychain) as soon as it is
// entered.

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { formatNumber, useT } from "../../i18n";
import { EndpointFields, type EndpointFieldsValue } from "../../components/EndpointFields";
import { ModelCombobox, type ModelOption } from "../../components/ModelCombobox";
import { ENDPOINT_PATHS } from "../../lib/endpoint";
import { consentedHosts, rememberConsent } from "../../lib/rag/consent";
import { hostOf, isLocalAddress } from "../../lib/rag/embeddingPresets";
import type { RagConfigPatch, RerankConfig, RerankFormat } from "../../lib/rag/types";
import { useRagStore } from "../../stores/ragStore";

const LABEL = "mb-1.5 block text-xs font-medium text-foreground";
const INPUT =
  "w-full rounded-lg border border-border/50 bg-secondary/30 px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50";
const BUTTON =
  "inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY =
  "inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50";
const HINT = "mt-1.5 text-xs text-muted-foreground";

/** Fields the draft edits (the key status is not one of them). */
type Editable = Omit<RerankConfig, "key_saved" | "key_hint">;

const EDITABLE_KEYS: (keyof Editable)[] = [
  "enabled",
  "connection_id",
  "base_url",
  "auth",
  "headers",
  "model",
  "format",
  "candidates",
  "timeout_ms",
];

function editable(config: RerankConfig): Editable {
  const out = {} as Record<string, unknown>;
  for (const key of EDITABLE_KEYS) out[key] = config[key];
  return out as Editable;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Well-known model ids offered in the model field (any id can be typed). */
const MODEL_SUGGESTIONS: ModelOption[] = [
  "BAAI/bge-reranker-v2-m3",
  "Qwen/Qwen3-Reranker-8B",
  "jina-reranker-v2-base-multilingual",
  "rerank-v3.5",
].map((id) => ({ id, source: "suggested" as const }));

const FORMATS: RerankFormat[] = ["generic", "tei"];

export function RerankSection() {
  const { t } = useT(["rag", "common"]);
  const settings = useRagStore((s) => s.settings);
  const updateConfig = useRagStore((s) => s.updateConfig);
  const setRerankSecret = useRagStore((s) => s.setRerankSecret);
  const testRerank = useRagStore((s) => s.testRerank);
  const test = useRagStore((s) => s.rerankTest);
  const isTesting = useRagStore((s) => s.isTestingRerank);

  const saved = settings?.config.rerank;
  const [draft, setDraft] = useState<Editable | null>(null);
  const [pendingHost, setPendingHost] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const savedEditable = useMemo(() => (saved ? editable(saved) : null), [saved]);
  const current = draft ?? savedEditable;
  const dirty = !!draft && !!savedEditable && !same(draft, savedEditable);

  // Follow the saved settings (another window, or our own save) while not editing.
  useEffect(() => {
    if (!savedEditable || dirty) return;
    setDraft(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedEditable]);

  if (!current || !settings) return null;

  const edit = (patch: Partial<Editable>) => {
    setPendingHost(null);
    setDraft({ ...current, ...patch });
  };

  // Only OpenAI-compatible services answer `{base}/rerank`.
  const connections = settings.connections.filter((c) => c.kind === "openai_compat");
  const usingConnection = current.connection_id !== "" && connections.some((c) => c.id === current.connection_id);
  const effectiveBase = usingConnection
    ? connections.find((c) => c.id === current.connection_id)?.base_url ?? ""
    : current.base_url;
  const isTei = current.format === "tei";
  const configured = effectiveBase.trim() !== "" && (isTei || current.model.trim() !== "");

  // A connection that no longer exists is shown (and saved) as "own address".
  const patchFromDraft = (): RagConfigPatch => ({
    rerank: { ...current, connection_id: usingConnection ? current.connection_id : "" },
  });

  const save = async (confirmed = false) => {
    if (!savedEditable) return;
    // Nothing is sent while reranking is off: ask when it is turned on.
    const host = current.enabled && !isLocalAddress(effectiveBase) ? hostOf(effectiveBase) : null;
    if (!confirmed && host && !consentedHosts("rerank").includes(host)) {
      setPendingHost(host);
      return;
    }
    if (host) rememberConsent("rerank", host);
    setPendingHost(null);
    setSaving(true);
    const view = await updateConfig(patchFromDraft());
    setSaving(false);
    if (view) setDraft(null);
  };

  const revert = () => {
    setPendingHost(null);
    setDraft(null);
  };

  const endpointValue: EndpointFieldsValue = { baseUrl: current.base_url, auth: current.auth, headers: current.headers };
  const sentCount = Math.max(current.candidates, settings.config.top_k);

  return (
    <div className="rounded-xl border border-border/30 bg-card/50 p-5">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-primary/80">{t("rerank.title")}</h3>
        {dirty && <span className="text-xs text-amber-500">{t("rerank.unsaved")}</span>}
      </div>
      <p className="mb-4 text-xs leading-relaxed text-muted-foreground">{t("rerank.description")}</p>

      <div className="space-y-4">
        {/* On / off */}
        <div>
          <div className="flex items-center justify-between gap-3">
            <span id="rag-rerank-enabled-label" className="text-xs font-medium text-foreground">
              {t("rerank.enabled")}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={current.enabled}
              aria-labelledby="rag-rerank-enabled-label"
              onClick={() => edit({ enabled: !current.enabled })}
              className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-all duration-200 ${
                current.enabled ? "bg-primary shadow-[0_0_0_3px_hsl(var(--primary)/0.12)]" : "bg-muted"
              }`}
            >
              <span
                className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-all duration-200 ${
                  current.enabled ? "translate-x-5 scale-[1.05]" : "translate-x-0"
                }`}
              />
            </button>
          </div>
          <p className={HINT}>{t("rerank.enabledHint", { count: sentCount })}</p>
          {current.enabled && !configured && (
            <p className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-500">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {t("rerank.incomplete")}
            </p>
          )}
        </div>

        {/* Reuse an LLM connection (OpenAI-compatible ones only) */}
        {connections.length > 0 && (
          <div>
            <label htmlFor="rag-rerank-connection" className={LABEL}>
              {t("rerank.connection.label")}
            </label>
            <select
              id="rag-rerank-connection"
              value={usingConnection ? current.connection_id : ""}
              onChange={(e) => edit({ connection_id: e.target.value })}
              className={INPUT}
            >
              <option value="">{t("rerank.connection.own")}</option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — {c.base_url}
                </option>
              ))}
            </select>
            <p className={HINT}>{t("rerank.connection.hint")}</p>
          </div>
        )}

        {!usingConnection && (
          <EndpointFields
            idPrefix="rag-rerank"
            value={endpointValue}
            onChange={(next) => edit({ base_url: next.baseUrl, auth: next.auth, headers: next.headers })}
            path={ENDPOINT_PATHS.rerank}
            versionHint={!isTei}
            baseUrlPlaceholder={isTei ? "http://localhost:8080" : "https://api.example.com/v1"}
            secretStatus={{ saved: saved?.key_saved ?? false, hint: saved?.key_hint || null }}
            onSecretChange={(secret) => void setRerankSecret(secret)}
          />
        )}

        {/* Request format */}
        <div>
          <span className={LABEL}>{t("rerank.format.label")}</span>
          <div className="flex max-w-[16rem] gap-1.5" role="radiogroup" aria-label={t("rerank.format.label")}>
            {FORMATS.map((format) => (
              <button
                key={format}
                type="button"
                role="radio"
                aria-checked={current.format === format}
                onClick={() => edit({ format })}
                className={`flex-1 rounded-lg border px-2.5 py-2 text-xs font-medium transition-colors ${
                  current.format === format
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border/50 bg-secondary/30 text-muted-foreground hover:text-foreground"
                }`}
              >
                {t(`rerank.format.${format}`)}
              </button>
            ))}
          </div>
          <p className={HINT}>{t("rerank.format.hint")}</p>
        </div>

        {/* Model */}
        <div>
          <label htmlFor="rag-rerank-model" className={LABEL}>
            {t("rerank.model.label")}
          </label>
          <ModelCombobox
            id="rag-rerank-model"
            value={current.model}
            onChange={(model) => edit({ model })}
            options={MODEL_SUGGESTIONS}
            placeholder={t("rerank.model.placeholder")}
          />
          {isTei && <p className={HINT}>{t("rerank.model.teiHint")}</p>}
        </div>

        {/* Candidates + timeout */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="rag-rerank-candidates" className={LABEL}>
              {t("rerank.candidates.label")}
            </label>
            <input
              id="rag-rerank-candidates"
              type="number"
              min={2}
              max={200}
              value={current.candidates}
              onChange={(e) => edit({ candidates: Math.max(1, Number.parseInt(e.target.value, 10) || 1) })}
              className={INPUT}
            />
            <p className={HINT}>{t("rerank.candidates.hint")}</p>
          </div>
          <div>
            <label htmlFor="rag-rerank-timeout" className={LABEL}>
              {t("rerank.timeout.label")}
            </label>
            <input
              id="rag-rerank-timeout"
              type="number"
              min={200}
              max={60000}
              step={100}
              value={current.timeout_ms}
              onChange={(e) => edit({ timeout_ms: Math.max(1, Number.parseInt(e.target.value, 10) || 1) })}
              className={INPUT}
            />
            <p className={HINT}>{t("rerank.timeout.hint")}</p>
          </div>
        </div>

        {/* Confirmation */}
        {pendingHost && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3.5 py-3 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span className="flex-1">{t("rerank.confirm.privacy", { host: pendingHost })}</span>
            <button type="button" onClick={() => void save(true)} className={PRIMARY}>
              {t("rerank.confirm.privacyAction")}
            </button>
            <button type="button" onClick={() => setPendingHost(null)} className={BUTTON}>
              {t("common:actions.cancel")}
            </button>
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void testRerank(dirty ? patchFromDraft() : undefined)}
            disabled={isTesting}
            className={BUTTON}
          >
            {isTesting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {isTesting ? t("common:status.testing") : t("common:actions.testConnection")}
          </button>
          <button type="button" onClick={() => void save()} disabled={!dirty || saving} className={PRIMARY}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {saving ? t("common:status.saving") : t("common:actions.save")}
          </button>
          {dirty && (
            <button type="button" onClick={revert} className={BUTTON}>
              {t("rerank.actions.revert")}
            </button>
          )}
        </div>

        {/* Test result */}
        {test && (
          <div
            role="status"
            className={`rounded-lg border px-3.5 py-3 text-xs ${
              test.ok ? "border-success/30 bg-success/5" : "border-destructive/30 bg-destructive/5"
            }`}
          >
            <div className={`flex items-center gap-1.5 font-medium ${test.ok ? "text-success" : "text-destructive"}`}>
              {test.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
              {test.ok ? t("rerank.test.ok", { ms: formatNumber(test.latency_ms) }) : t("rerank.test.failed")}
            </div>
            {test.error && <p className="mt-1.5 select-text break-words text-foreground/80">{test.error}</p>}
            {test.ok && test.ranked_correctly === true && (
              <p className="mt-1.5 text-foreground/80">{t("rerank.test.rankedCorrectly")}</p>
            )}
            {test.ok && test.ranked_correctly === false && (
              <p className="mt-1.5 text-amber-600 dark:text-amber-400">{t("rerank.test.rankedWrong")}</p>
            )}
            {test.ok && test.latency_ms > current.timeout_ms && (
              <p className="mt-1.5 text-amber-600 dark:text-amber-400">
                {t("rerank.test.slow", { ms: formatNumber(test.latency_ms), timeout: formatNumber(current.timeout_ms) })}
              </p>
            )}
            {test.url && (
              <p className="mt-1.5 text-muted-foreground">
                {t("rerank.test.url")}: <span className="select-text break-all font-mono">{test.url}</span>
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
