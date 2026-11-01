// NexQ Plus: settings of Remote Whisper — any OpenAI-compatible
// `/audio/transcriptions` server (faster-whisper-server / speaches, vLLM,
// LocalAI…). Saved through setOpenAICompatSttConfig; text fields save on
// blur / Enter. The optional key lives in the keychain (slot
// `openai_compat_stt`) and is never read back: no key = no Authorization header.

import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import { ChevronDown, ChevronUp, Info, Loader2, Server, Wifi } from "lucide-react";
import { useT } from "../../i18n";
import { EndpointFields, type EndpointFieldsValue } from "../../components/EndpointFields";
import { ModelCombobox } from "../../components/ModelCombobox";
import { ENDPOINT_PATHS, NO_AUTH, type AuthMode } from "../../lib/endpoint";
import { deleteApiKey, hasApiKey, storeApiKey } from "../../lib/ipc";
import { probeOpenAICompatStt } from "../../lib/stt/ipc";
import {
  OPENAI_COMPAT_STT_KEY_SLOT,
  type OpenAICompatSttConfig,
  type SttProbeResult,
} from "../../lib/stt/types";
import { useConfigStore } from "../../stores/configStore";
import { ProbeResultView, probeMessage } from "./ProbeResult";
import {
  CommitNumberInput,
  CommitTextInput,
  CommitTextarea,
  FIELD_HINT,
  FIELD_INPUT,
  FIELD_LABEL,
} from "./fields";
import { sttEngineLabel } from "./sttEngines";

const ENGINE = "openai_compat";
const AUTH_MODES: AuthMode[] = ["none", "bearer"];
const RESPONSE_FORMATS = ["json", "text", "verbose_json"] as const;

export interface OpenAICompatSttSettingsProps {
  /** Short form for the quick setup: address, key and model (the quick setup runs the test). */
  compact?: boolean;
  /** After the key was saved or removed. */
  onKeyChange?: () => void;
}

export function OpenAICompatSttSettings({ compact = false, onKeyChange }: OpenAICompatSttSettingsProps) {
  const { t } = useT(["stt", "common"]);
  const config = useConfigStore((s) => s.openaiCompatSttConfig);
  const setConfig = useConfigStore((s) => s.setOpenAICompatSttConfig);
  const idPrefix = compact ? "openai-compat-stt-quick" : "openai-compat-stt";
  const baseUrlInputId = `${idPrefix}-base-url`;

  // The address as typed, saved on blur / Enter.
  const [baseUrlDraft, setBaseUrlDraft] = useState(config.base_url);
  const editingBaseUrl = useRef(false);
  useEffect(() => {
    if (!editingBaseUrl.current) setBaseUrlDraft(config.base_url);
  }, [config.base_url]);

  const [keySaved, setKeySaved] = useState<boolean | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>("none");
  const [confirmRemoveKey, setConfirmRemoveKey] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<SttProbeResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    hasApiKey(OPENAI_COMPAT_STT_KEY_SLOT)
      .then((saved) => {
        if (!alive) return;
        setKeySaved(saved);
        if (saved) setAuthMode("bearer");
      })
      .catch(() => {
        if (alive) setKeySaved(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  /** Save a change on top of the latest stored settings. */
  const update = useCallback(
    (patch: Partial<OpenAICompatSttConfig>) => {
      setConfig({ ...useConfigStore.getState().openaiCompatSttConfig, ...patch });
    },
    [setConfig],
  );

  const commitBaseUrl = (next = baseUrlDraft) => {
    editingBaseUrl.current = false;
    const trimmed = next.trim();
    if (trimmed !== next) setBaseUrlDraft(trimmed);
    if (trimmed !== useConfigStore.getState().openaiCompatSttConfig.base_url) update({ base_url: trimmed });
  };

  const setVerified = (ok: boolean) => {
    const { verifiedCloudProviders, setVerifiedCloudProviders } = useConfigStore.getState();
    const has = verifiedCloudProviders.includes(ENGINE);
    if (ok && !has) setVerifiedCloudProviders([...verifiedCloudProviders, ENGINE]);
    if (!ok && has) setVerifiedCloudProviders(verifiedCloudProviders.filter((p) => p !== ENGINE));
  };

  const handleEndpointChange = (next: EndpointFieldsValue) => {
    if (next.baseUrl !== baseUrlDraft) {
      // Typing (or pasting) in the field saves on blur; a button ("Add /v1") saves at once.
      if (document.activeElement?.id === baseUrlInputId) {
        editingBaseUrl.current = true;
        setBaseUrlDraft(next.baseUrl);
      } else {
        setBaseUrlDraft(next.baseUrl);
        commitBaseUrl(next.baseUrl);
      }
    }
    if (next.auth.mode !== authMode) {
      // The backend sends Authorization whenever a key is stored: "None" means removing it.
      if (next.auth.mode === "none" && keySaved) setConfirmRemoveKey(true);
      else {
        setConfirmRemoveKey(false);
        setAuthMode(next.auth.mode);
      }
    }
  };

  const handleSecretChange = async (secret: string | null) => {
    setKeyError(null);
    try {
      if (secret) {
        await storeApiKey(OPENAI_COMPAT_STT_KEY_SLOT, secret);
        setKeySaved(true);
      } else {
        await deleteApiKey(OPENAI_COMPAT_STT_KEY_SLOT);
        setKeySaved(false);
      }
      // A new key needs a new test.
      setVerified(false);
      setResult(null);
      onKeyChange?.();
    } catch (err) {
      setKeyError(t("common:errors.saveFailed", { detail: String(err) }));
    }
  };

  const removeKey = async () => {
    await handleSecretChange(null);
    setConfirmRemoveKey(false);
    setAuthMode("none");
  };

  /** The settings as they are on screen (the address may not be saved yet). */
  const currentConfig = (): OpenAICompatSttConfig => ({
    ...useConfigStore.getState().openaiCompatSttConfig,
    base_url: baseUrlDraft.trim(),
  });

  const runProbe = async (): Promise<SttProbeResult> => {
    const probe = await probeOpenAICompatStt(currentConfig());
    if (probe.models.length > 0) setModels(probe.models);
    return probe;
  };

  const handleTest = async () => {
    commitBaseUrl();
    setTesting(true);
    setTestError(null);
    try {
      const probe = await runProbe();
      setResult(probe);
      setVerified(probe.ok);
    } catch (err) {
      setResult(null);
      setTestError(String(err));
      setVerified(false);
    } finally {
      setTesting(false);
    }
  };

  const handleRefreshModels = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const probe = await runProbe();
      if (!probe.ok) setRefreshError(probeMessage(ENGINE, probe));
    } catch (err) {
      setRefreshError(String(err));
    } finally {
      setRefreshing(false);
    }
  };

  const endpointValue: EndpointFieldsValue = {
    baseUrl: baseUrlDraft,
    auth: { ...NO_AUTH, mode: authMode },
    headers: [],
  };

  // Enter in the address field saves it (EndpointFields reports every keystroke).
  const onEndpointKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" && (e.target as HTMLElement).id === baseUrlInputId) commitBaseUrl();
  };
  const onEndpointBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).id === baseUrlInputId) commitBaseUrl();
  };

  const modelId = `${idPrefix}-model`;
  const title = sttEngineLabel(ENGINE);

  return (
    <div
      className={
        compact
          ? "space-y-4 rounded-lg border border-border/30 bg-background/30 p-4"
          : "space-y-5 rounded-xl border border-border/30 bg-card/50 p-5"
      }
    >
      <div>
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-primary/80">
          <Server className="h-4 w-4" />
          {title}
        </h3>
        {!compact && <p className="mt-0.5 text-xs text-muted-foreground">{t("stt:openaiCompat.description")}</p>}
      </div>

      {/* Address and optional key */}
      <div onKeyDown={onEndpointKeyDown} onBlur={onEndpointBlur}>
        <EndpointFields
          value={endpointValue}
          onChange={handleEndpointChange}
          path={ENDPOINT_PATHS.audioTranscriptions}
          authModes={AUTH_MODES}
          secretStatus={{ saved: !!keySaved }}
          onSecretChange={(secret) => void handleSecretChange(secret)}
          showHeaders={false}
          baseUrlPlaceholder={t("stt:openaiCompat.baseUrl.placeholder")}
          idPrefix={idPrefix}
        />
      </div>
      <p className={`${FIELD_HINT} -mt-2 flex items-start gap-1.5`}>
        <Info className="mt-0.5 h-3 w-3 shrink-0 text-info" aria-hidden />
        <span>{t("stt:openaiCompat.baseUrl.hint")}</span>
      </p>
      {authMode === "none" && !confirmRemoveKey && (
        <p className={`${FIELD_HINT} -mt-2`}>{t("stt:openaiCompat.auth.noneHint")}</p>
      )}
      {keyError && <p role="alert" className="-mt-2 text-meta text-destructive">{keyError}</p>}
      {confirmRemoveKey && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
          <p className="mb-2 text-meta leading-relaxed text-amber-200/80">{t("stt:openaiCompat.auth.removeConfirm")}</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void removeKey()}
              className="cursor-pointer rounded-lg border border-amber-500/30 bg-amber-500/20 px-3 py-1 text-meta font-semibold text-amber-400 hover:bg-amber-500/30"
            >
              {t("stt:openaiCompat.auth.removeKey")}
            </button>
            <button
              type="button"
              onClick={() => setConfirmRemoveKey(false)}
              className="cursor-pointer rounded-lg bg-muted/30 px-3 py-1 text-meta font-medium text-muted-foreground hover:bg-muted/50"
            >
              {t("common:actions.cancel")}
            </button>
          </div>
        </div>
      )}

      {/* Model */}
      <div>
        <label htmlFor={modelId} className={FIELD_LABEL}>
          {t("stt:openaiCompat.model.label")}
        </label>
        <ModelCombobox
          id={modelId}
          value={config.model}
          onChange={(model) => {
            if (model !== config.model) update({ model });
          }}
          options={models.map((id) => ({ id, source: "fetched" as const }))}
          loading={refreshing}
          error={refreshError}
          onRefresh={() => void handleRefreshModels()}
        />
        <p className={FIELD_HINT}>{t("stt:openaiCompat.model.hint")}</p>
      </div>

      {!compact && (
        <>
          {/* Prompt */}
          <div>
            <label htmlFor={`${idPrefix}-prompt`} className={FIELD_LABEL}>
              {t("stt:openaiCompat.prompt.label")}
            </label>
            <CommitTextarea
              id={`${idPrefix}-prompt`}
              value={config.prompt}
              onCommit={(prompt) => update({ prompt })}
              placeholder={t("stt:openaiCompat.prompt.placeholder")}
              rows={2}
            />
            <p className={FIELD_HINT}>{t("stt:openaiCompat.prompt.hint")}</p>
          </div>

          {/* Segments and requests */}
          <div className="grid grid-cols-2 gap-4">
            <NumberField
              id={`${idPrefix}-segment`}
              label={t("stt:openaiCompat.segment.label")}
              hint={t("stt:openaiCompat.segment.hint")}
              unit={t("stt:units.secondsSuffix")}
            >
              <CommitNumberInput
                id={`${idPrefix}-segment`}
                value={config.segment_duration_secs}
                onCommit={(segment_duration_secs) => update({ segment_duration_secs })}
                min={1}
                max={30}
                step={0.5}
              />
            </NumberField>
            <NumberField
              id={`${idPrefix}-pause`}
              label={t("stt:openaiCompat.pauseSplit.label")}
              hint={t("stt:openaiCompat.pauseSplit.hint")}
              unit={t("stt:units.millisecondsSuffix")}
            >
              <CommitNumberInput
                id={`${idPrefix}-pause`}
                value={config.pause_split_ms}
                onCommit={(pause_split_ms) => update({ pause_split_ms })}
                min={0}
                max={5000}
                step={100}
                integer
              />
            </NumberField>
            <NumberField
              id={`${idPrefix}-timeout`}
              label={t("stt:openaiCompat.timeout.label")}
              hint={t("stt:openaiCompat.timeout.hint")}
              unit={t("stt:units.secondsSuffix")}
            >
              <CommitNumberInput
                id={`${idPrefix}-timeout`}
                value={config.request_timeout_secs}
                onCommit={(request_timeout_secs) => update({ request_timeout_secs })}
                min={5}
                max={300}
                step={5}
                integer
              />
            </NumberField>
            <div>
              <span id={`${idPrefix}-inflight-label`} className={FIELD_LABEL}>
                {t("stt:openaiCompat.maxInFlight.label")}
              </span>
              <div
                role="group"
                aria-labelledby={`${idPrefix}-inflight-label`}
                className="inline-flex rounded-lg border border-border/50 bg-secondary/30 p-0.5"
              >
                {[1, 2].map((n) => (
                  <button
                    key={n}
                    type="button"
                    aria-pressed={config.max_in_flight === n}
                    onClick={() => update({ max_in_flight: n })}
                    className={`min-w-[2.5rem] cursor-pointer rounded-md px-3 py-1.5 text-xs font-medium tabular-nums transition-all duration-150 ${
                      config.max_in_flight === n
                        ? "bg-primary text-primary-foreground shadow-sm shadow-primary/20"
                        : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <p className={FIELD_HINT}>{t("stt:openaiCompat.maxInFlight.hint")}</p>
            </div>
          </div>

          {/* Advanced */}
          <div className="rounded-lg border border-border/30">
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              aria-expanded={showAdvanced}
              className="flex w-full cursor-pointer items-center justify-between px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent/30"
            >
              <span className="font-medium">{t("common:labels.advanced")}</span>
              {showAdvanced ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
            {showAdvanced && (
              <div className="space-y-4 border-t border-border/20 px-3 py-3">
                <div>
                  <label htmlFor={`${idPrefix}-url-override`} className={FIELD_LABEL}>
                    {t("stt:openaiCompat.urlOverride.label")}
                  </label>
                  <CommitTextInput
                    id={`${idPrefix}-url-override`}
                    inputMode="url"
                    value={config.url_override}
                    onCommit={(url_override) => update({ url_override })}
                    placeholder={t("stt:openaiCompat.urlOverride.placeholder")}
                  />
                  <p className={FIELD_HINT}>{t("stt:openaiCompat.urlOverride.hint")}</p>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <NumberField
                    id={`${idPrefix}-temperature`}
                    label={t("stt:openaiCompat.temperature.label")}
                    hint={t("stt:openaiCompat.temperature.hint")}
                  >
                    <CommitNumberInput
                      id={`${idPrefix}-temperature`}
                      value={config.temperature}
                      onCommit={(temperature) => update({ temperature })}
                      min={0}
                      max={1}
                      step={0.1}
                    />
                  </NumberField>
                  <div>
                    <label htmlFor={`${idPrefix}-format`} className={FIELD_LABEL}>
                      {t("stt:openaiCompat.responseFormat.label")}
                    </label>
                    <select
                      id={`${idPrefix}-format`}
                      value={config.response_format}
                      onChange={(e) => update({ response_format: e.target.value })}
                      className={`${FIELD_INPUT} cursor-pointer`}
                    >
                      {RESPONSE_FORMATS.map((fmt) => (
                        <option key={fmt} value={fmt}>
                          {fmt}
                        </option>
                      ))}
                      {!(RESPONSE_FORMATS as readonly string[]).includes(config.response_format) && (
                        <option value={config.response_format}>{config.response_format}</option>
                      )}
                    </select>
                    <p className={FIELD_HINT}>{t("stt:openaiCompat.responseFormat.hint")}</p>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Test */}
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => void handleTest()}
              disabled={testing}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border/50 bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wifi className="h-3.5 w-3.5" />}
              {testing ? t("common:status.testing") : t("common:actions.testConnection")}
            </button>
            <ProbeResultView engine={ENGINE} result={result} error={testError} />
          </div>
        </>
      )}
    </div>
  );
}

function NumberField({
  id,
  label,
  hint,
  unit,
  children,
}: {
  id: string;
  label: string;
  hint: string;
  unit?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className={FIELD_LABEL}>
        {label}
        {unit && <span className="ml-1 font-normal text-muted-foreground">{unit}</span>}
      </label>
      {children}
      <p className={FIELD_HINT}>{hint}</p>
    </div>
  );
}
