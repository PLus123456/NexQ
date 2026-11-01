// Embedding service settings of the knowledge base: template, API style,
// address and key (shared EndpointFields), model, dimensions and the
// advanced request options. Edits stay in a draft until saved; the key is
// saved on its own (keychain) as soon as it is entered.

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Download, Loader2, XCircle } from "lucide-react";
import { formatNumber, useT } from "../../i18n";
import { EndpointFields, type EndpointFieldsValue } from "../../components/EndpointFields";
import { ModelCombobox, type ModelOption } from "../../components/ModelCombobox";
import { addVersionPrefix, ENDPOINT_PATHS } from "../../lib/endpoint";
import {
  EMBEDDING_PRESETS,
  hostOf,
  isLocalAddress,
  modelSuggestions,
  presetForBaseUrl,
  type EmbeddingPreset,
} from "../../lib/rag/embeddingPresets";
import type { EmbeddingConfig, EmbeddingProvider, RagConfigPatch } from "../../lib/rag/types";
import { useRagStore } from "../../stores/ragStore";

const LABEL = "mb-1.5 block text-xs font-medium text-foreground";
const INPUT =
  "w-full rounded-lg border border-border/50 bg-secondary/30 px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50";
const BUTTON =
  "inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY =
  "inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50";
const HINT = "mt-1.5 text-xs text-muted-foreground";
const PLAIN_TEXT = { spellCheck: false, autoCapitalize: "off", autoCorrect: "off", autoComplete: "off" } as const;

/** Fields the draft edits (the key status is not one of them). */
type Editable = Omit<EmbeddingConfig, "key_saved" | "key_hint">;

const EDITABLE_KEYS: (keyof Editable)[] = [
  "provider",
  "connection_id",
  "base_url",
  "auth",
  "headers",
  "model",
  "dimensions",
  "request_dimensions",
  "encoding_format",
  "batch_size",
  "max_concurrency",
  "max_input_tokens",
  "prefixes_auto",
  "query_prefix",
  "document_prefix",
  "extra_body_query",
  "extra_body_document",
  "request_timeout_secs",
  "query_timeout_secs",
];

/** Fields that change the vectors (mirrors `RagConfig::space_key` on the Rust side). */
const SPACE_KEYS: (keyof Editable)[] = [
  "provider",
  "model",
  "prefixes_auto",
  "document_prefix",
  "extra_body_document",
  "dimensions",
  "request_dimensions",
];

function editable(config: EmbeddingConfig): Editable {
  const out = {} as Record<string, unknown>;
  for (const key of EDITABLE_KEYS) out[key] = config[key];
  return out as Editable;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Hosts the user agreed to send document text to (a per-computer convenience).
const CONSENT_KEY = "nexq.rag.embeddingConsentHosts";
function consentedHosts(): string[] {
  try {
    const raw = localStorage.getItem(CONSENT_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}
function rememberConsent(host: string) {
  try {
    localStorage.setItem(CONSENT_KEY, JSON.stringify([...new Set([...consentedHosts(), host])]));
  } catch {
    // Private mode or blocked storage: ask again next time.
  }
}

type Pending = { kind: "privacy"; host: string } | { kind: "rebuild"; chunks: number };

export function EmbeddingSection() {
  const { t } = useT(["rag", "common"]);
  const settings = useRagStore((s) => s.settings);
  const indexInfo = useRagStore((s) => s.indexInfo);
  const updateConfig = useRagStore((s) => s.updateConfig);
  const setSecret = useRagStore((s) => s.setSecret);
  const testEmbedding = useRagStore((s) => s.testEmbedding);
  const embeddingTest = useRagStore((s) => s.embeddingTest);
  const isTesting = useRagStore((s) => s.isTestingEmbedding);
  const ollamaStatus = useRagStore((s) => s.ollamaStatus);
  const checkOllamaStatus = useRagStore((s) => s.checkOllamaStatus);
  const isCheckingConnection = useRagStore((s) => s.isCheckingConnection);
  const pullModel = useRagStore((s) => s.pullModel);
  const isPullingModel = useRagStore((s) => s.isPullingModel);
  const pullProgress = useRagStore((s) => s.pullProgress);

  const saved = settings?.config.embedding;
  const [draft, setDraft] = useState<Editable | null>(null);
  const [presetId, setPresetId] = useState<string>("custom");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [saving, setSaving] = useState(false);
  const [jsonErrors, setJsonErrors] = useState<{ query?: boolean; document?: boolean }>({});
  const [jsonText, setJsonText] = useState<{ query: string; document: string }>({ query: "{}", document: "{}" });

  const savedEditable = useMemo(() => (saved ? editable(saved) : null), [saved]);
  const current = draft ?? savedEditable;
  const dirty = !!draft && !!savedEditable && !same(draft, savedEditable);

  // Follow the saved settings (another window, or our own save) while not editing.
  useEffect(() => {
    if (!savedEditable || dirty) return;
    setDraft(null);
    setJsonText({
      query: JSON.stringify(savedEditable.extra_body_query ?? {}, null, 2),
      document: JSON.stringify(savedEditable.extra_body_document ?? {}, null, 2),
    });
    setJsonErrors({});
    setPresetId(presetForBaseUrl(savedEditable.base_url)?.id ?? (savedEditable.provider === "ollama" ? "ollama" : "custom"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedEditable]);

  if (!current || !settings) return null;

  const edit = (patch: Partial<Editable>) => {
    setPending(null);
    setDraft({ ...current, ...patch });
  };

  const applyPreset = (preset: EmbeddingPreset) => {
    setPresetId(preset.id);
    if (preset.id === "custom") return;
    const keepModel = preset.models.length === 0 || preset.models.some((m) => m.id === current.model);
    edit({
      provider: preset.provider,
      connection_id: "",
      base_url: preset.baseUrl,
      auth: { ...current.auth, mode: preset.needsKey ? "bearer" : "none" },
      model: keepModel ? current.model : preset.models[0]?.id ?? "",
      batch_size: preset.maxBatch ? Math.min(current.batch_size, preset.maxBatch) : current.batch_size,
      extra_body_query: preset.extraBodyQuery ?? {},
      extra_body_document: preset.extraBodyDocument ?? {},
    });
    setJsonText({
      query: JSON.stringify(preset.extraBodyQuery ?? {}, null, 2),
      document: JSON.stringify(preset.extraBodyDocument ?? {}, null, 2),
    });
    setJsonErrors({});
  };

  const connections = settings.connections;
  const usingConnection = current.connection_id !== "" && connections.some((c) => c.id === current.connection_id);
  const effectiveBase = usingConnection
    ? connections.find((c) => c.id === current.connection_id)?.base_url ?? ""
    : current.base_url;
  const isOllama = current.provider === "ollama";
  const ollamaV1 = isOllama && /\/v1\/?$/i.test(current.base_url.trim());

  const suggestions = modelSuggestions(current.provider, presetId);
  const fetched = isOllama && ollamaStatus?.connected ? ollamaStatus.models : [];
  const modelOptions: ModelOption[] = [
    ...fetched.map((id) => ({ id, source: "fetched" as const })),
    ...suggestions
      .filter((m) => !fetched.includes(m.id))
      .map((m) => ({
        id: m.id,
        source: "suggested" as const,
        detail: m.dims ? t("embedding.model.dims", { dims: m.dims }) : undefined,
      })),
  ];
  const acceptsDimensions = suggestions.find((m) => m.id === current.model)?.acceptsDimensions;

  const patchFromDraft = (): RagConfigPatch => ({ embedding: { ...current } });

  const save = async (confirmed: Pending["kind"][] = []) => {
    if (jsonErrors.query || jsonErrors.document || !savedEditable) return;
    const host = hostOf(effectiveBase);
    if (!confirmed.includes("privacy") && host && !isLocalAddress(effectiveBase) && !consentedHosts().includes(host)) {
      setPending({ kind: "privacy", host });
      return;
    }
    const changesVectors = SPACE_KEYS.some((k) => !same(current[k], savedEditable[k]));
    const vectors = indexInfo?.vectors ?? 0;
    if (!confirmed.includes("rebuild") && changesVectors && vectors > 0) {
      setPending({ kind: "rebuild", chunks: indexInfo?.chunks ?? vectors });
      return;
    }
    if (host && !isLocalAddress(effectiveBase)) rememberConsent(host);
    setPending(null);
    setSaving(true);
    const view = await updateConfig(patchFromDraft());
    setSaving(false);
    if (view) setDraft(null);
  };

  const confirmPending = () => {
    if (!pending) return;
    const done: Pending["kind"][] = pending.kind === "privacy" ? ["privacy"] : ["privacy", "rebuild"];
    void save(done);
  };

  const revert = () => {
    setPending(null);
    setDraft(null);
    if (savedEditable) {
      setJsonText({
        query: JSON.stringify(savedEditable.extra_body_query ?? {}, null, 2),
        document: JSON.stringify(savedEditable.extra_body_document ?? {}, null, 2),
      });
    }
    setJsonErrors({});
  };

  const editJson = (which: "query" | "document", text: string) => {
    setJsonText((prev) => ({ ...prev, [which]: text }));
    try {
      const value = text.trim() === "" ? {} : JSON.parse(text);
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
      setJsonErrors((prev) => ({ ...prev, [which]: false }));
      edit(which === "query" ? { extra_body_query: value } : { extra_body_document: value });
    } catch {
      setJsonErrors((prev) => ({ ...prev, [which]: true }));
    }
  };

  const endpointValue: EndpointFieldsValue = { baseUrl: current.base_url, auth: current.auth, headers: current.headers };
  const effective = settings.effective;
  const test = embeddingTest;

  return (
    <div className="rounded-xl border border-border/30 bg-card/50 p-5">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-primary/80">{t("embedding.title")}</h3>
        {dirty && <span className="text-xs text-amber-500">{t("embedding.unsaved")}</span>}
      </div>
      <p className="mb-4 text-xs leading-relaxed text-muted-foreground">{t("embedding.description")}</p>

      <div className="space-y-4">
        {/* Template + API style */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="rag-embedding-preset" className={LABEL}>
              {t("embedding.preset.label")}
            </label>
            <select
              id="rag-embedding-preset"
              value={presetId}
              onChange={(e) => {
                const preset = EMBEDDING_PRESETS.find((p) => p.id === e.target.value);
                if (preset) applyPreset(preset);
              }}
              className={INPUT}
            >
              {EMBEDDING_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nameKey ? t(`embedding.presets.${p.nameKey}` as "embedding.presets.custom") : p.name}
                </option>
              ))}
            </select>
            <p className={HINT}>{t("embedding.preset.hint")}</p>
          </div>
          <div>
            <span className={LABEL}>{t("embedding.provider.label")}</span>
            <div className="flex gap-1.5" role="radiogroup" aria-label={t("embedding.provider.label")}>
              {(["openai_compat", "ollama"] as EmbeddingProvider[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={current.provider === p}
                  onClick={() => edit({ provider: p, connection_id: p === "ollama" ? "" : current.connection_id })}
                  className={`flex-1 rounded-lg border px-2.5 py-2 text-xs font-medium transition-colors ${
                    current.provider === p
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border/50 bg-secondary/30 text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t(`embedding.provider.${p}`)}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Reuse an LLM connection (listed once the LLM settings provide connections) */}
        {!isOllama && connections.length > 0 && (
          <div>
            <label htmlFor="rag-embedding-connection" className={LABEL}>
              {t("embedding.connection.label")}
            </label>
            <select
              id="rag-embedding-connection"
              value={usingConnection ? current.connection_id : ""}
              onChange={(e) => edit({ connection_id: e.target.value })}
              className={INPUT}
            >
              <option value="">{t("embedding.connection.own")}</option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — {c.base_url}
                </option>
              ))}
            </select>
            <p className={HINT}>{t("embedding.connection.hint")}</p>
          </div>
        )}

        {!usingConnection && (
          <EndpointFields
            idPrefix="rag-embedding"
            value={endpointValue}
            onChange={(next) => edit({ base_url: next.baseUrl, auth: next.auth, headers: next.headers })}
            path={isOllama ? "/api/embed" : ENDPOINT_PATHS.embeddings}
            versionHint={!isOllama}
            baseUrlPlaceholder={isOllama ? "http://localhost:11434" : "https://api.example.com/v1"}
            secretStatus={{ saved: saved?.key_saved ?? false, hint: saved?.key_hint || null }}
            onSecretChange={(secret) => void setSecret(secret)}
          />
        )}
        {ollamaV1 && (
          <p className="flex items-start gap-1.5 text-xs text-amber-500">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {t("embedding.provider.ollamaV1Warning")}
          </p>
        )}

        {/* Model */}
        <div>
          <label htmlFor="rag-embedding-model" className={LABEL}>
            {t("embedding.model.label")}
          </label>
          <ModelCombobox
            id="rag-embedding-model"
            value={current.model}
            onChange={(model) => edit({ model })}
            options={modelOptions}
            placeholder={t("embedding.model.placeholder")}
            loading={isOllama && isCheckingConnection}
            onRefresh={isOllama ? () => void checkOllamaStatus() : undefined}
          />
          {isOllama && (
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => void pullModel(current.model)}
                disabled={isPullingModel || !current.model || dirty}
                className={BUTTON}
                title={dirty ? t("embedding.actions.pullSaveFirst") : undefined}
              >
                {isPullingModel ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                {isPullingModel ? t("embedding.actions.pulling") : t("embedding.actions.pull")}
              </button>
              {isPullingModel && pullProgress && pullProgress.total > 0 && (
                <span className="font-mono text-xs text-muted-foreground">
                  {Math.round((pullProgress.completed / pullProgress.total) * 100)}%
                </span>
              )}
            </div>
          )}
        </div>

        {/* Dimensions */}
        <div>
          <label htmlFor="rag-embedding-dims" className={LABEL}>
            {t("embedding.dimensions.label")}
          </label>
          <input
            id="rag-embedding-dims"
            type="number"
            min={1}
            value={current.dimensions ?? ""}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10);
              edit({ dimensions: Number.isFinite(n) && n > 0 ? n : null, request_dimensions: Number.isFinite(n) && n > 0 ? current.request_dimensions : false });
            }}
            placeholder={t("embedding.dimensions.placeholder")}
            className={`${INPUT} max-w-[10rem]`}
          />
          <p className={HINT}>{t("embedding.dimensions.hint")}</p>
          <label className="mt-2 flex items-start gap-2 text-xs text-foreground">
            <input
              type="checkbox"
              checked={current.request_dimensions}
              disabled={current.dimensions === null}
              onChange={(e) => edit({ request_dimensions: e.target.checked })}
              className="mt-0.5 accent-primary"
            />
            <span>
              {t("embedding.dimensions.send")}
              <span className="block text-muted-foreground">
                {acceptsDimensions === false || acceptsDimensions === undefined
                  ? t("embedding.dimensions.sendHint")
                  : t("embedding.dimensions.sendSupported")}
              </span>
            </span>
          </label>
        </div>

        {/* Advanced */}
        <div className="rounded-lg border border-border/20">
          <button
            type="button"
            onClick={() => setAdvancedOpen(!advancedOpen)}
            aria-expanded={advancedOpen}
            className="flex w-full items-center justify-between px-3.5 py-2.5 text-xs font-medium text-foreground hover:bg-accent/20"
          >
            {t("common:labels.advanced")}
            {advancedOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
          {advancedOpen && (
            <div className="space-y-4 border-t border-border/20 px-3.5 py-3.5">
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label htmlFor="rag-embedding-batch" className={LABEL}>
                    {t("embedding.advanced.batchSize")}
                  </label>
                  <input
                    id="rag-embedding-batch"
                    type="number"
                    min={1}
                    max={2048}
                    value={current.batch_size}
                    onChange={(e) => edit({ batch_size: Math.max(1, Number.parseInt(e.target.value, 10) || 1) })}
                    className={INPUT}
                  />
                </div>
                <div>
                  <label htmlFor="rag-embedding-concurrency" className={LABEL}>
                    {t("embedding.advanced.concurrency")}
                  </label>
                  <input
                    id="rag-embedding-concurrency"
                    type="number"
                    min={0}
                    max={16}
                    value={current.max_concurrency || ""}
                    placeholder={t("embedding.advanced.auto", { value: effective.concurrency })}
                    onChange={(e) => edit({ max_concurrency: Math.max(0, Number.parseInt(e.target.value, 10) || 0) })}
                    className={INPUT}
                  />
                </div>
                <div>
                  <label htmlFor="rag-embedding-maxtokens" className={LABEL}>
                    {t("embedding.advanced.maxInputTokens")}
                  </label>
                  <input
                    id="rag-embedding-maxtokens"
                    type="number"
                    min={0}
                    value={current.max_input_tokens || ""}
                    placeholder={t("embedding.advanced.auto", { value: effective.max_input_tokens })}
                    onChange={(e) => edit({ max_input_tokens: Math.max(0, Number.parseInt(e.target.value, 10) || 0) })}
                    className={INPUT}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{t("embedding.advanced.batchSizeHint")}</p>

              <div>
                <span className={LABEL}>{t("embedding.advanced.prefixes")}</span>
                <label className="mb-2 flex items-center gap-2 text-xs text-foreground">
                  <input
                    type="checkbox"
                    checked={current.prefixes_auto}
                    onChange={(e) =>
                      edit(
                        e.target.checked
                          ? { prefixes_auto: true }
                          : { prefixes_auto: false, query_prefix: effective.query_prefix, document_prefix: effective.document_prefix },
                      )
                    }
                    className="accent-primary"
                  />
                  {t("embedding.advanced.prefixesAuto")}
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <input
                    aria-label={t("embedding.advanced.queryPrefix")}
                    {...PLAIN_TEXT}
                    value={current.prefixes_auto ? effective.query_prefix : current.query_prefix}
                    disabled={current.prefixes_auto}
                    onChange={(e) => edit({ query_prefix: e.target.value })}
                    placeholder={t("embedding.advanced.queryPrefix")}
                    className={INPUT}
                  />
                  <input
                    aria-label={t("embedding.advanced.documentPrefix")}
                    {...PLAIN_TEXT}
                    value={current.prefixes_auto ? effective.document_prefix : current.document_prefix}
                    disabled={current.prefixes_auto}
                    onChange={(e) => edit({ document_prefix: e.target.value })}
                    placeholder={t("embedding.advanced.documentPrefix")}
                    className={INPUT}
                  />
                </div>
                <p className={HINT}>{t("embedding.advanced.prefixesHint")}</p>
              </div>

              {!isOllama && (
                <div>
                  <label htmlFor="rag-embedding-encoding" className={LABEL}>
                    {t("embedding.advanced.encoding")}
                  </label>
                  <select
                    id="rag-embedding-encoding"
                    value={current.encoding_format}
                    onChange={(e) => edit({ encoding_format: e.target.value as "float" | "base64" })}
                    className={`${INPUT} max-w-[16rem]`}
                  >
                    <option value="float">{t("embedding.advanced.encodingFloat")}</option>
                    <option value="base64">{t("embedding.advanced.encodingBase64")}</option>
                  </select>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                {(["query", "document"] as const).map((which) => (
                  <div key={which}>
                    <label htmlFor={`rag-embedding-extra-${which}`} className={LABEL}>
                      {t(which === "query" ? "embedding.advanced.extraQuery" : "embedding.advanced.extraDocument")}
                    </label>
                    <textarea
                      id={`rag-embedding-extra-${which}`}
                      {...PLAIN_TEXT}
                      rows={3}
                      value={jsonText[which]}
                      onChange={(e) => editJson(which, e.target.value)}
                      className={`${INPUT} font-mono ${jsonErrors[which] ? "border-destructive/60" : ""}`}
                    />
                    {jsonErrors[which] && <p className="mt-1 text-xs text-destructive">{t("embedding.advanced.invalidJson")}</p>}
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">{t("embedding.advanced.extraHint")}</p>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="rag-embedding-timeout" className={LABEL}>
                    {t("embedding.advanced.requestTimeout")}
                  </label>
                  <input
                    id="rag-embedding-timeout"
                    type="number"
                    min={1}
                    max={600}
                    value={current.request_timeout_secs}
                    onChange={(e) => edit({ request_timeout_secs: Math.max(1, Number.parseInt(e.target.value, 10) || 1) })}
                    className={INPUT}
                  />
                </div>
                <div>
                  <label htmlFor="rag-embedding-query-timeout" className={LABEL}>
                    {t("embedding.advanced.queryTimeout")}
                  </label>
                  <input
                    id="rag-embedding-query-timeout"
                    type="number"
                    min={1}
                    max={120}
                    value={current.query_timeout_secs}
                    onChange={(e) => edit({ query_timeout_secs: Math.max(1, Number.parseInt(e.target.value, 10) || 1) })}
                    className={INPUT}
                  />
                  <p className={HINT}>{t("embedding.advanced.queryTimeoutHint")}</p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Confirmations */}
        {pending && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3.5 py-3 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span className="flex-1">
              {pending.kind === "privacy"
                ? t("embedding.confirm.privacy", { host: pending.host })
                : t("embedding.confirm.rebuild", { count: pending.chunks })}
            </span>
            <button type="button" onClick={confirmPending} className={PRIMARY}>
              {pending.kind === "privacy" ? t("embedding.confirm.privacyAction") : t("embedding.confirm.rebuildAction")}
            </button>
            <button type="button" onClick={() => setPending(null)} className={BUTTON}>
              {t("common:actions.cancel")}
            </button>
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void testEmbedding(dirty ? patchFromDraft() : undefined)}
            disabled={isTesting || !!jsonErrors.query || !!jsonErrors.document}
            className={BUTTON}
          >
            {isTesting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {isTesting ? t("common:status.testing") : t("common:actions.testConnection")}
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!dirty || saving || !!jsonErrors.query || !!jsonErrors.document}
            className={PRIMARY}
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {saving ? t("common:status.saving") : t("common:actions.save")}
          </button>
          {dirty && (
            <button type="button" onClick={revert} className={BUTTON}>
              {t("embedding.actions.revert")}
            </button>
          )}
        </div>

        {/* Test result */}
        {test && (
          <div
            className={`rounded-lg border px-3.5 py-3 text-xs ${
              test.ok ? "border-success/30 bg-success/5" : "border-destructive/30 bg-destructive/5"
            }`}
          >
            <div className={`flex items-center gap-1.5 font-medium ${test.ok ? "text-success" : "text-destructive"}`}>
              {test.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
              {test.ok
                ? t("embedding.test.ok", { dims: test.dims ?? 0, ms: formatNumber(test.latency_ms) })
                : t("embedding.test.failed")}
            </div>
            {test.error && <p className="mt-1.5 select-text break-words text-foreground/80">{test.error}</p>}
            {test.dimensions_respected === false && (
              <p className="mt-1.5 text-amber-600 dark:text-amber-400">
                {t("embedding.test.dimsIgnored", { dims: test.dims ?? 0 })}
              </p>
            )}
            {test.url && (
              <p className="mt-1.5 text-muted-foreground">
                {t("embedding.test.url")}: <span className="select-text break-all font-mono">{test.url}</span>
              </p>
            )}
            {test.hint === "add_v1" && (
              <div className="mt-2 flex items-center gap-2">
                <span className="text-foreground/80">{t("embedding.test.addV1")}</span>
                <button
                  type="button"
                  onClick={() => edit({ base_url: addVersionPrefix(current.base_url, "/v1") })}
                  className="rounded-md border border-border/50 px-2 py-0.5 text-xs hover:bg-accent"
                >
                  {t("embedding.test.addV1Action")}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
