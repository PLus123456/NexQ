// NexQ Plus: settings of the Soniox real-time engine (recognition and
// translation in the same WebSocket stream). Saved through setSonioxConfig;
// text fields save on blur / Enter, sliders when released. The API key lives
// in the keychain (slot `soniox`) and is never read back.

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Info, Loader2, Radio, Wifi } from "lucide-react";
import { useT } from "../../i18n";
import { ModelCombobox, type ModelOption } from "../../components/ModelCombobox";
import { deleteApiKey, hasApiKey, storeApiKey } from "../../lib/ipc";
import { probeSoniox } from "../../lib/stt/ipc";
import {
  SONIOX_KEY_SLOT,
  SONIOX_REGIONS,
  SONIOX_SUGGESTED_MODELS,
  type SonioxConfig,
  type SonioxRegion,
  type SttProbeResult,
} from "../../lib/stt/types";
import { useConfigStore } from "../../stores/configStore";
import { ProbeResultView, probeMessage } from "./ProbeResult";
import {
  CommitTextInput,
  CommitTextarea,
  FIELD_HINT,
  FIELD_INPUT,
  FIELD_LABEL,
  PLAIN_TEXT,
  SwitchRow,
} from "./fields";
import { sttEngineLabel } from "./sttEngines";

const ENGINE = "soniox";
const DELAY_MIN = 500;
const DELAY_MAX = 3000;
const SENSITIVITY_MIN = -1;
const SENSITIVITY_MAX = 1;
const LATENCY_LEVELS = [0, 1, 2, 3] as const;

/** An endpoint sensitivity as saved: within -1.0–1.0, one decimal. */
export function roundSensitivity(value: number): number {
  const clamped = Math.min(SENSITIVITY_MAX, Math.max(SENSITIVITY_MIN, value));
  return Math.round(clamped * 10) / 10 || 0;
}

export type ExtraParamsProblem = "invalidJson" | "notObject" | "apiKey";

/**
 * Checks the extra start parameters: empty, or a JSON object without an
 * `api_key` field at any depth (the key only comes from the keychain).
 */
export function checkExtraStartParams(text: string): ExtraParamsProblem | null {
  if (!text.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "invalidJson";
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "notObject";
  const hasApiKeyField = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(hasApiKeyField);
    if (value === null || typeof value !== "object") return false;
    return Object.entries(value).some(([key, inner]) => key.toLowerCase() === "api_key" || hasApiKeyField(inner));
  };
  return hasApiKeyField(parsed) ? "apiKey" : null;
}

export interface SonioxSettingsProps {
  /** Short form for the quick setup: key, region and model (the quick setup runs the test). */
  compact?: boolean;
  /** After the key was saved or removed. */
  onKeyChange?: () => void;
}

export function SonioxSettings({ compact = false, onKeyChange }: SonioxSettingsProps) {
  const { t } = useT(["stt", "common"]);
  const config = useConfigStore((s) => s.sonioxConfig);
  const setConfig = useConfigStore((s) => s.setSonioxConfig);
  const idPrefix = compact ? "soniox-quick" : "soniox";

  const [keySaved, setKeySaved] = useState<boolean | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [delayDraft, setDelayDraft] = useState(config.max_endpoint_delay_ms);
  // null = server default (not sent); the slider keeps its last value meanwhile.
  const sensitivity = config.endpoint_sensitivity ?? null;
  const latencyLevel = config.endpoint_latency_adjustment_level ?? null;
  const [sensitivityDraft, setSensitivityDraft] = useState(sensitivity ?? 0);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<SttProbeResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    hasApiKey(SONIOX_KEY_SLOT)
      .then((saved) => alive && setKeySaved(saved))
      .catch(() => alive && setKeySaved(false));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => setDelayDraft(config.max_endpoint_delay_ms), [config.max_endpoint_delay_ms]);
  useEffect(() => {
    if (sensitivity !== null) setSensitivityDraft(sensitivity);
  }, [sensitivity]);

  /** Save a change on top of the latest stored settings. */
  const update = useCallback(
    (patch: Partial<SonioxConfig>) => {
      setConfig({ ...useConfigStore.getState().sonioxConfig, ...patch });
    },
    [setConfig],
  );

  const setVerified = (state: "ok" | "failed" | "keep") => {
    if (state === "keep") return;
    const { verifiedCloudProviders, setVerifiedCloudProviders } = useConfigStore.getState();
    const has = verifiedCloudProviders.includes(ENGINE);
    if (state === "ok" && !has) setVerifiedCloudProviders([...verifiedCloudProviders, ENGINE]);
    if (state === "failed" && has) setVerifiedCloudProviders(verifiedCloudProviders.filter((p) => p !== ENGINE));
  };

  const saveKey = async () => {
    const key = keyDraft.trim();
    if (!key) return;
    setSavingKey(true);
    setKeyError(null);
    try {
      await storeApiKey(SONIOX_KEY_SLOT, key);
      setKeySaved(true);
      setKeyDraft("");
      // A new key needs a new test.
      setVerified("failed");
      setResult(null);
      onKeyChange?.();
    } catch (err) {
      setKeyError(t("common:errors.saveFailed", { detail: String(err) }));
    } finally {
      setSavingKey(false);
    }
  };

  const clearKey = async () => {
    setKeyError(null);
    try {
      await deleteApiKey(SONIOX_KEY_SLOT);
      setKeySaved(false);
      setVerified("failed");
      setResult(null);
      onKeyChange?.();
    } catch (err) {
      setKeyError(t("common:errors.operationFailed", { detail: String(err) }));
    }
  };

  const runProbe = async (): Promise<SttProbeResult> => {
    const probe = await probeSoniox(useConfigStore.getState().sonioxConfig);
    if (probe.models.length > 0) setModels(probe.models);
    return probe;
  };

  const handleTest = async () => {
    setTesting(true);
    setTestError(null);
    try {
      const probe = await runProbe();
      setResult(probe);
      // 403: the key works but may not list models; keep whatever was known.
      setVerified(probe.ok ? "ok" : probe.code === "forbidden" ? "keep" : "failed");
    } catch (err) {
      setResult(null);
      setTestError(String(err));
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

  const commitDelay = () => {
    const next = Math.min(DELAY_MAX, Math.max(DELAY_MIN, delayDraft));
    if (next !== useConfigStore.getState().sonioxConfig.max_endpoint_delay_ms) {
      update({ max_endpoint_delay_ms: next });
    }
  };

  const commitSensitivity = () => {
    const saved = useConfigStore.getState().sonioxConfig.endpoint_sensitivity ?? null;
    // The slider is off while the server default is in use.
    if (saved === null) return;
    const next = roundSensitivity(sensitivityDraft);
    if (next !== saved) update({ endpoint_sensitivity: next });
  };

  const region = SONIOX_REGIONS.find((r) => r.id === config.region) ?? SONIOX_REGIONS[0];
  const modelOptions: ModelOption[] = [
    ...models.map((id) => ({ id, source: "fetched" as const })),
    ...SONIOX_SUGGESTED_MODELS.map((id) => ({ id, source: "suggested" as const })),
  ];
  const keyId = `${idPrefix}-key`;
  const keyStatusId = `${idPrefix}-key-status`;

  const extraProblemText = (text: string): string | null => {
    const problem = checkExtraStartParams(text);
    return problem ? t(`stt:soniox.extraParams.errors.${problem}`) : null;
  };

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
          <Radio className="h-4 w-4" />
          {sttEngineLabel(ENGINE)}
        </h3>
        {!compact && <p className="mt-0.5 text-xs text-muted-foreground">{t("stt:soniox.description")}</p>}
      </div>

      {/* API key: saved to the keychain, never shown back */}
      <div>
        <label htmlFor={keyId} className={FIELD_LABEL}>
          {t("stt:soniox.key.label")}
        </label>
        <div className="flex gap-2">
          <input
            id={keyId}
            type="password"
            {...PLAIN_TEXT}
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveKey();
            }}
            placeholder={keySaved ? t("stt:soniox.key.savedPlaceholder") : t("stt:soniox.key.placeholder")}
            aria-describedby={keyStatusId}
            className={`${FIELD_INPUT} flex-1`}
          />
          <button
            type="button"
            onClick={() => void saveKey()}
            disabled={!keyDraft.trim() || savingKey}
            className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {savingKey && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t("common:actions.save")}
          </button>
          {keySaved && (
            <button
              type="button"
              onClick={() => void clearKey()}
              className="shrink-0 cursor-pointer rounded-lg border border-destructive/30 px-3 py-2 text-xs text-destructive transition-colors hover:bg-destructive/10"
            >
              {t("common:actions.clear")}
            </button>
          )}
        </div>
        <p id={keyStatusId} className={`${FIELD_HINT} ${keySaved ? "text-success/80" : ""}`}>
          {keySaved === null
            ? t("common:status.loading")
            : keySaved
              ? t("stt:soniox.key.saved")
              : t("stt:soniox.key.notSaved")}
        </p>
        {keyError && <p role="alert" className="mt-1 text-meta text-destructive">{keyError}</p>}
      </div>

      {/* Region */}
      <div>
        <label htmlFor={`${idPrefix}-region`} className={FIELD_LABEL}>
          {t("stt:soniox.region.label")}
        </label>
        <select
          id={`${idPrefix}-region`}
          value={region.id}
          onChange={(e) => update({ region: e.target.value as SonioxRegion })}
          className={`${FIELD_INPUT} cursor-pointer`}
        >
          {SONIOX_REGIONS.map((r) => (
            <option key={r.id} value={r.id}>
              {t(`stt:soniox.region.options.${r.id}`)}
            </option>
          ))}
        </select>
        <p className={FIELD_HINT}>{t("stt:soniox.region.hint")}</p>
        {!compact && (
          <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground/80">
            {config.rest_url.trim() || region.rest} · {config.ws_url.trim() || region.ws}
          </p>
        )}
      </div>

      {/* Model */}
      <div>
        <label htmlFor={`${idPrefix}-model`} className={FIELD_LABEL}>
          {t("stt:soniox.model.label")}
        </label>
        <ModelCombobox
          id={`${idPrefix}-model`}
          value={config.model}
          onChange={(model) => {
            if (model !== config.model) update({ model });
          }}
          options={modelOptions}
          loading={refreshing}
          error={refreshError}
          onRefresh={() => void handleRefreshModels()}
        />
        <p className={FIELD_HINT}>{t("stt:soniox.model.hint")}</p>
      </div>

      {!compact && (
        <>
          {/* Endpoint delay */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label htmlFor={`${idPrefix}-delay`} className="text-xs font-medium text-foreground">
                {t("stt:soniox.endpointDelay.label")}
              </label>
              <span className="font-mono text-xs tabular-nums text-primary">
                {t("stt:soniox.endpointDelay.value", { ms: delayDraft })}
              </span>
            </div>
            <input
              id={`${idPrefix}-delay`}
              type="range"
              min={DELAY_MIN}
              max={DELAY_MAX}
              step={100}
              value={delayDraft}
              onChange={(e) => setDelayDraft(parseInt(e.target.value, 10))}
              onMouseUp={commitDelay}
              onTouchEnd={commitDelay}
              onKeyUp={commitDelay}
              onBlur={commitDelay}
              className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
            />
            <div className="mt-0.5 flex justify-between text-meta text-muted-foreground/70">
              <span>{t("stt:soniox.endpointDelay.min")}</span>
              <span>{t("stt:soniox.endpointDelay.max")}</span>
            </div>
            <p className={FIELD_HINT}>{t("stt:soniox.endpointDelay.hint")}</p>
          </div>

          <SwitchRow
            label={t("stt:soniox.diarization.label")}
            hint={t("stt:soniox.diarization.hint")}
            checked={config.enable_speaker_diarization}
            onChange={(enable_speaker_diarization) => update({ enable_speaker_diarization })}
          />
          <SwitchRow
            label={t("stt:soniox.strictHints.label")}
            hint={t("stt:soniox.strictHints.hint")}
            checked={config.language_hints_strict}
            onChange={(language_hints_strict) => update({ language_hints_strict })}
          />

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
                {/* Sentence-end tuning: stt-rt-v5 only, so each goes out only when set */}
                <div className="space-y-4 border-b border-border/20 pb-4">
                  <div>
                    <p className="text-xs font-medium text-foreground">{t("stt:soniox.endpointTuning.title")}</p>
                    <p className="mt-1 flex items-start gap-1.5 text-meta leading-relaxed text-muted-foreground">
                      <Info className="mt-0.5 h-3 w-3 shrink-0 text-info" aria-hidden />
                      <span>{t("stt:soniox.endpointTuning.note")}</span>
                    </p>
                  </div>
                  <div>
                    <div className="mb-1.5 flex items-center justify-between">
                      <label htmlFor={`${idPrefix}-sensitivity`} className="text-xs font-medium text-foreground">
                        {t("stt:soniox.endpointSensitivity.label")}
                      </label>
                      <span className="font-mono text-xs tabular-nums text-primary">
                        {sensitivity === null
                          ? t("stt:soniox.endpointTuning.serverDefault")
                          : sensitivityDraft.toFixed(1)}
                      </span>
                    </div>
                    <label className="mb-2 flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={sensitivity === null}
                        onChange={(e) =>
                          update({ endpoint_sensitivity: e.target.checked ? null : roundSensitivity(sensitivityDraft) })
                        }
                        className="h-3.5 w-3.5 rounded border-border/50 accent-primary"
                      />
                      <span className="text-xs text-foreground">{t("stt:soniox.endpointSensitivity.useDefault")}</span>
                    </label>
                    <input
                      id={`${idPrefix}-sensitivity`}
                      type="range"
                      min={SENSITIVITY_MIN}
                      max={SENSITIVITY_MAX}
                      step={0.1}
                      value={sensitivityDraft}
                      disabled={sensitivity === null}
                      onChange={(e) => setSensitivityDraft(parseFloat(e.target.value))}
                      onMouseUp={commitSensitivity}
                      onTouchEnd={commitSensitivity}
                      onKeyUp={commitSensitivity}
                      onBlur={commitSensitivity}
                      className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary disabled:cursor-not-allowed disabled:opacity-50"
                    />
                    <div className="mt-0.5 flex justify-between text-meta text-muted-foreground/70">
                      <span>{t("stt:soniox.endpointSensitivity.min")}</span>
                      <span>{t("stt:soniox.endpointSensitivity.max")}</span>
                    </div>
                    <p className={FIELD_HINT}>{t("stt:soniox.endpointSensitivity.hint")}</p>
                  </div>
                  <div>
                    <label htmlFor={`${idPrefix}-latency-level`} className={FIELD_LABEL}>
                      {t("stt:soniox.latencyAdjustment.label")}
                    </label>
                    <select
                      id={`${idPrefix}-latency-level`}
                      value={latencyLevel === null ? "" : String(Math.min(3, Math.max(0, Math.round(latencyLevel))))}
                      onChange={(e) =>
                        update({
                          endpoint_latency_adjustment_level: e.target.value === "" ? null : Number(e.target.value),
                        })
                      }
                      className={`${FIELD_INPUT} cursor-pointer`}
                    >
                      <option value="">{t("stt:soniox.endpointTuning.serverDefault")}</option>
                      {LATENCY_LEVELS.map((level) => (
                        <option key={level} value={String(level)}>
                          {t("stt:soniox.latencyAdjustment.level", { level })}
                        </option>
                      ))}
                    </select>
                    <p className={FIELD_HINT}>{t("stt:soniox.latencyAdjustment.hint")}</p>
                  </div>
                </div>
                <div>
                  <label htmlFor={`${idPrefix}-ws-url`} className={FIELD_LABEL}>
                    {t("stt:soniox.wsUrl.label")}
                  </label>
                  <CommitTextInput
                    id={`${idPrefix}-ws-url`}
                    inputMode="url"
                    value={config.ws_url}
                    onCommit={(ws_url) => update({ ws_url })}
                    placeholder={region.ws}
                  />
                  <p className={FIELD_HINT}>{t("stt:soniox.wsUrl.hint")}</p>
                </div>
                <div>
                  <label htmlFor={`${idPrefix}-rest-url`} className={FIELD_LABEL}>
                    {t("stt:soniox.restUrl.label")}
                  </label>
                  <CommitTextInput
                    id={`${idPrefix}-rest-url`}
                    inputMode="url"
                    value={config.rest_url}
                    onCommit={(rest_url) => update({ rest_url })}
                    placeholder={region.rest}
                  />
                  <p className={FIELD_HINT}>{t("stt:soniox.restUrl.hint")}</p>
                </div>
                <div>
                  <label htmlFor={`${idPrefix}-extra`} className={FIELD_LABEL}>
                    {t("stt:soniox.extraParams.label")}
                  </label>
                  <CommitTextarea
                    id={`${idPrefix}-extra`}
                    value={config.extra_start_params}
                    onCommit={(extra_start_params) => update({ extra_start_params: extra_start_params.trim() })}
                    validate={extraProblemText}
                    placeholder={t("stt:soniox.extraParams.placeholder")}
                    rows={3}
                    className="font-mono"
                  />
                  <p className={FIELD_HINT}>{t("stt:soniox.extraParams.hint")}</p>
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
              {testing ? t("common:status.testing") : t("stt:soniox.testKey")}
            </button>
            <ProbeResultView engine={ENGINE} result={result} error={testError} />
          </div>
        </>
      )}

      {/* Cost */}
      <p className="flex items-start gap-1.5 text-meta leading-relaxed text-muted-foreground">
        <Info className="mt-0.5 h-3 w-3 shrink-0 text-info" aria-hidden />
        <span>{t("stt:soniox.cost")}</span>
      </p>
    </div>
  );
}
