// NexQ Plus: settings of the Soniox real-time engine (recognition and
// translation in the same WebSocket stream). Saved through setSonioxConfig;
// text fields save on blur / Enter, sliders when released.
//
// Keys live in the keychain, one per region (`soniox_us`…; the old `soniox`
// slot counts as `region`'s), and are never read back. A pasted key is saved
// for the region that accepts it (`sonioxAddKey`); when that is unclear the
// user picks the region. Regions: Fixed (one), Auto (the fastest enabled
// region with a key) or Ordered (the user's order), and failover. The compact
// form (quick setup) only adds keys — turning their region on, and Auto
// unless a mode was picked here before — and picks the model.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Gauge,
  Info,
  Loader2,
  Plus,
  Radio,
  Wifi,
} from "lucide-react";
import { useT } from "../../i18n";
import { ModelCombobox, type ModelOption } from "../../components/ModelCombobox";
import { deleteApiKey } from "../../lib/ipc";
import { probeSoniox, sonioxAddKey, sonioxKeyStatus, sonioxMeasureLatency } from "../../lib/stt/ipc";
import {
  SONIOX_KEY_SLOT,
  SONIOX_REGIONS,
  SONIOX_REGION_IDS,
  SONIOX_SUGGESTED_MODELS,
  sonioxKeySlot,
  sonioxRegionList,
  type SonioxAddKeyResult,
  type SonioxConfig,
  type SonioxKeyStatus,
  type SonioxLatency,
  type SonioxRegion,
  type SonioxRegionMode,
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
  Switch,
  SwitchRow,
} from "./fields";
import {
  probeUsableSonioxKey,
  regionHasKey,
  regionKeySource,
  regionModeChosen,
  rememberRegionModeChoice,
  sonioxKeyScope,
  sonioxRegionInText,
  sonioxRegionName,
  sonioxUsableRegions,
  usesCustomEndpoint,
} from "./sonioxRegions";
import { sttEngineLabel } from "./sttEngines";

const ENGINE = "soniox";
const DELAY_MIN = 500;
const DELAY_MAX = 3000;
const SENSITIVITY_MIN = -1;
const SENSITIVITY_MAX = 1;
const LATENCY_LEVELS = [0, 1, 2, 3] as const;
const REGION_MODES: readonly SonioxRegionMode[] = ["fixed", "auto", "ordered"];

const SMALL_BUTTON =
  "inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-border/50 bg-background px-2 py-1 text-meta font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50";
const SMALL_DANGER_BUTTON =
  "shrink-0 cursor-pointer rounded-md border border-destructive/30 px-2 py-1 text-meta text-destructive transition-colors hover:bg-destructive/10";
const ARROW_BUTTON =
  "cursor-pointer rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30";

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

/** What saving a key did to the region settings. */
type AddedHow = "enabled" | "fixed" | "saved";

type AddOutcome =
  | { kind: "added"; region: SonioxRegion; how: AddedHow }
  /** No single region accepted the key: nothing saved, the user picks. */
  | { kind: "unclear"; statuses: SonioxAddKeyResult["statuses"] };

type KeyProbe = NonNullable<SonioxAddKeyResult["statuses"][SonioxRegion]>;

/** A row's key: its own slot, the older key (old slot), none, or refused by its last test. */
type KeyState = "saved" | "legacy" | "none" | "invalid";

const KEY_TONE: Record<KeyState, string> = {
  saved: "text-success/80",
  legacy: "text-success/80",
  none: "text-muted-foreground",
  invalid: "text-destructive",
};

interface RegionProbe {
  region: SonioxRegion;
  result: SttProbeResult | null;
  error: string | null;
}

export interface SonioxSettingsProps {
  /** Short form for the quick setup: add a key (its region is found) and the model (the quick setup runs the test). */
  compact?: boolean;
  /** After a key was saved or removed. */
  onKeyChange?: () => void;
}

export function SonioxSettings({ compact = false, onKeyChange }: SonioxSettingsProps) {
  const { t } = useT(["stt", "common"]);
  const config = useConfigStore((s) => s.sonioxConfig);
  const setConfig = useConfigStore((s) => s.setSonioxConfig);
  const idPrefix = compact ? "soniox-quick" : "soniox";

  // Keys per region (never the keys themselves).
  const [status, setStatus] = useState<SonioxKeyStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<Partial<Record<SonioxRegion, boolean>>>({});
  const [keyDraft, setKeyDraft] = useState("");
  /** The region being saved, or "detect" while the key's region is looked for. */
  const [adding, setAdding] = useState<SonioxRegion | "detect" | null>(null);
  const [addOutcome, setAddOutcome] = useState<AddOutcome | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);

  const [latency, setLatency] = useState<SonioxLatency | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [latencyError, setLatencyError] = useState<string | null>(null);
  const [rowTesting, setRowTesting] = useState<SonioxRegion | null>(null);
  const [rowResult, setRowResult] = useState<RegionProbe | null>(null);

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

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** Reads which regions have a key for the latest settings (the old key follows `region`). */
  const statusRun = useRef(0);
  const refreshStatus = useCallback(async (): Promise<SonioxKeyStatus | null> => {
    const run = ++statusRun.current;
    try {
      const next = await sonioxKeyStatus(useConfigStore.getState().sonioxConfig);
      if (!next?.regions) throw new Error(String(next));
      if (alive.current && run === statusRun.current) {
        setStatus(next);
        setStatusError(null);
      }
      return next;
    } catch (err) {
      if (alive.current && run === statusRun.current) setStatusError(String(err));
      return null;
    }
  }, []);

  // Again whenever what decides it changes: the region, the mode, the list, a gateway.
  const keyScope = sonioxKeyScope(config);
  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus, keyScope]);

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

  /** A key was saved for `region`: turn the region on (Fixed: use it). */
  const turnOnRegion = (region: SonioxRegion): AddedHow => {
    const current = useConfigStore.getState().sonioxConfig;
    // The quick setup has no mode picker: a Fixed region nobody picked becomes Auto.
    const mode: SonioxRegionMode =
      compact && current.region_mode === "fixed" && !regionModeChosen() ? "auto" : current.region_mode;
    const list = sonioxRegionList(current);
    const wasOn = list.some((entry) => entry.id === region && entry.enabled);
    const regions = list.map((entry) => (entry.id === region ? { ...entry, enabled: true } : entry));
    if (mode === "fixed") {
      if (current.region !== region || !wasOn) update({ region, regions });
      return current.region === region ? "saved" : "fixed";
    }
    if (mode !== current.region_mode || !wasOn) update({ region_mode: mode, regions });
    return wasOn && mode === current.region_mode ? "saved" : "enabled";
  };

  /** Save the draft key: for the region that accepts it, or for `region` when the user picked it. */
  const addKey = async (region?: SonioxRegion) => {
    const key = keyDraft.trim();
    if (!key || adding) return;
    setAdding(region ?? "detect");
    setAddError(null);
    try {
      const added = await sonioxAddKey(key, region);
      if (added.stored && added.region) {
        const found = added.region;
        const how = turnOnRegion(found);
        setKeyDraft("");
        setAddOutcome({ kind: "added", region: found, how });
        setInvalid((marks) => ({ ...marks, [found]: false }));
        setRowResult((row) => (row?.region === found ? null : row));
        setResult(null);
        // Found by its answer: a 2xx there means the key works. A picked region isn't tested yet.
        const answer = added.statuses[found]?.status;
        if (answer != null && answer >= 200 && answer < 300) setVerified("ok");
        await refreshStatus();
        onKeyChange?.();
      } else {
        setAddOutcome({ kind: "unclear", statuses: added.statuses });
      }
    } catch (err) {
      setAddError(t("common:errors.saveFailed", { detail: String(err) }));
    } finally {
      setAdding(null);
    }
  };

  /** Remove the key `region` uses: its own slot, else the older key. Never because a test failed. */
  const deleteKey = async (region: SonioxRegion) => {
    const source = status ? regionKeySource(status, region) : null;
    if (!source) return;
    setKeyError(null);
    try {
      await deleteApiKey(source === "own" ? sonioxKeySlot(region) : SONIOX_KEY_SLOT);
      setInvalid((marks) => ({ ...marks, [region]: false }));
      setRowResult((row) => (row?.region === region ? null : row));
      if (region === useConfigStore.getState().sonioxConfig.region) setResult(null);
      const next = await refreshStatus();
      if (next && !next.any_enabled) setVerified("failed");
      onKeyChange?.();
    } catch (err) {
      setKeyError(t("common:errors.operationFailed", { detail: String(err) }));
    }
  };

  const changeMode = (mode: SonioxRegionMode) => {
    rememberRegionModeChoice();
    const current = useConfigStore.getState().sonioxConfig;
    if (mode === current.region_mode) return;
    const patch: Partial<SonioxConfig> = { region_mode: mode };
    // Fixed on a region without a key: take the first region (enabled first) that has one.
    if (mode === "fixed" && status && !regionHasKey(status, current.region)) {
      const list = sonioxRegionList(current);
      const withKey =
        list.find((entry) => entry.enabled && regionHasKey(status, entry.id)) ??
        list.find((entry) => regionHasKey(status, entry.id));
      if (withKey) patch.region = withKey.id;
    }
    update(patch);
  };

  const setRegionEnabled = (region: SonioxRegion, enabled: boolean) => {
    const list = sonioxRegionList(useConfigStore.getState().sonioxConfig);
    update({ regions: list.map((entry) => (entry.id === region ? { ...entry, enabled } : entry)) });
  };

  const moveRegion = (index: number, delta: -1 | 1) => {
    const list = sonioxRegionList(useConfigStore.getState().sonioxConfig);
    const target = index + delta;
    if (target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]];
    update({ regions: list });
  };

  const measureLatency = async () => {
    setMeasuring(true);
    setLatencyError(null);
    try {
      const measured = await sonioxMeasureLatency(true);
      if (alive.current) setLatency(measured);
    } catch (err) {
      if (alive.current) setLatencyError(t("common:errors.testFailed", { detail: String(err) }));
    } finally {
      if (alive.current) setMeasuring(false);
    }
  };

  /** Test one region's key against the region itself (not a gateway). */
  const testRegion = async (region: SonioxRegion) => {
    setRowTesting(region);
    setRowResult(null);
    const current = useConfigStore.getState().sonioxConfig;
    try {
      const probe = await probeSoniox({ ...current, region, ws_url: "", rest_url: "" });
      if (probe.models.length > 0) setModels(probe.models);
      setRowResult({ region, result: probe, error: null });
      setInvalid((marks) => ({ ...marks, [region]: probe.code === "unauthorized" }));
      // Only a region meetings may use says something about the setup.
      if (sonioxUsableRegions(current).includes(region)) {
        setVerified(probe.ok ? "ok" : probe.code === "forbidden" ? "keep" : "failed");
      }
    } catch (err) {
      setRowResult({ region, result: null, error: String(err) });
    } finally {
      setRowTesting(null);
    }
  };

  /** Fixed region (or gateway): test the key of `region` as meetings would use it. */
  const handleTest = async () => {
    setTesting(true);
    setTestError(null);
    const current = useConfigStore.getState().sonioxConfig;
    try {
      const probe = await probeSoniox(current);
      if (probe.models.length > 0) setModels(probe.models);
      setResult(probe);
      if (!usesCustomEndpoint(current)) {
        setInvalid((marks) => ({ ...marks, [current.region]: probe.code === "unauthorized" }));
      }
      // 403: the key works but may not list models; keep whatever was known.
      setVerified(probe.ok ? "ok" : probe.code === "forbidden" ? "keep" : "failed");
    } catch (err) {
      setResult(null);
      setTestError(String(err));
    } finally {
      setTesting(false);
    }
  };

  /** The model list, from a key meetings may use. */
  const handleRefreshModels = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const probe = await probeUsableSonioxKey(useConfigStore.getState().sonioxConfig);
      if (!probe) setRefreshError(t("stt:probe.soniox.noKey"));
      else {
        if (probe.models.length > 0) setModels(probe.models);
        if (!probe.ok) setRefreshError(probeMessage(ENGINE, probe));
      }
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
  const mode = config.region_mode;
  const regionList = sonioxRegionList(config);
  const custom = usesCustomEndpoint(config);
  const modelOptions: ModelOption[] = [
    ...models.map((id) => ({ id, source: "fetched" as const })),
    ...SONIOX_SUGGESTED_MODELS.map((id) => ({ id, source: "suggested" as const })),
  ];
  const keyId = `${idPrefix}-key`;
  const keyHintId = `${idPrefix}-key-hint`;

  const extraProblemText = (text: string): string | null => {
    const problem = checkExtraStartParams(text);
    return problem ? t(`stt:soniox.extraParams.errors.${problem}`) : null;
  };

  const errorText = (error: string | null): string => {
    if (error === "timeout") return t("stt:soniox.errors.timeout");
    if (error === "unreachable") return t("stt:soniox.errors.unreachable");
    return error || t("stt:soniox.key.answers.none");
  };

  /** What a region answered when asked about the pasted key. */
  const answerText = (probe: KeyProbe | undefined): string => {
    if (!probe) return t("stt:soniox.key.answers.none");
    if (probe.status == null) return errorText(probe.error);
    if (probe.status === 403) return t("stt:soniox.key.answers.forbidden");
    if (probe.matches) return t("stt:soniox.key.answers.accepted", { status: probe.status });
    if (probe.status === 401) return t("stt:soniox.key.answers.rejected");
    return t("stt:soniox.key.answers.status", { status: probe.status });
  };

  const keyState = (id: SonioxRegion): KeyState | null => {
    if (!status) return null;
    const source = regionKeySource(status, id);
    if (!source) return "none";
    if (invalid[id]) return "invalid";
    return source === "own" ? "saved" : "legacy";
  };

  /** "Key: Saved" for a region (loading / the error until the status is known). */
  const keyStatusLine = (id: SonioxRegion) => {
    const state = keyState(id);
    const text = state
      ? t(`stt:soniox.regions.keyStates.${state}`)
      : statusError
        ? t("common:errors.loadFailed", { detail: statusError })
        : t("common:status.loading");
    return (
      <span className={state ? KEY_TONE[state] : statusError ? "text-destructive" : ""}>
        {t("stt:soniox.regions.keyStatus", { status: text })}
      </span>
    );
  };

  const latencyText = (id: SonioxRegion): string => {
    const entry = latency?.regions[id];
    if (!entry) return "—";
    if (entry.ms != null) return t("stt:soniox.regions.latencyMs", { ms: entry.ms });
    return entry.error ? errorText(entry.error) : "—";
  };

  /** The regions that have a key, for the quick setup ("Japan, US (older key)"). */
  const keySummary = (): string => {
    if (!status) {
      return statusError ? t("common:errors.loadFailed", { detail: statusError }) : t("common:status.loading");
    }
    const names = regionList
      .filter((entry) => regionHasKey(status, entry.id))
      .map((entry) =>
        regionKeySource(status, entry.id) === "legacy"
          ? t("stt:soniox.key.legacyName", { region: sonioxRegionName(entry.id) })
          : sonioxRegionName(entry.id),
      );
    if (names.length === 0) return t("stt:soniox.key.notSaved");
    return t("stt:soniox.key.savedFor", { regions: names.join(t("stt:soniox.listSeparator")) });
  };
  const anyKeySaved = !!status && SONIOX_REGION_IDS.some((id) => regionHasKey(status, id));

  // Add a key: its region is found by asking each region.
  const addKeyBlock = (
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
          onChange={(e) => {
            setKeyDraft(e.target.value);
            // Another key: what the regions said about the last one no longer applies.
            if (addOutcome) setAddOutcome(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void addKey();
          }}
          placeholder={t("stt:soniox.key.placeholder")}
          aria-describedby={keyHintId}
          className={`${FIELD_INPUT} flex-1`}
        />
        <button
          type="button"
          onClick={() => void addKey()}
          disabled={!keyDraft.trim() || adding !== null}
          className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {adding === "detect" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          {t("stt:soniox.key.add")}
        </button>
      </div>
      <p id={keyHintId} className={FIELD_HINT}>
        {adding === "detect" ? t("stt:soniox.key.adding") : t("stt:soniox.key.hint")}
      </p>
      {compact && <p className={`${FIELD_HINT} ${anyKeySaved ? "text-success/80" : ""}`}>{keySummary()}</p>}

      {addOutcome?.kind === "added" && (
        <p role="status" className="mt-1.5 flex items-start gap-1.5 text-xs text-success">
          <CheckCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{t(`stt:soniox.key.added.${addOutcome.how}`, { region: sonioxRegionInText(addOutcome.region) })}</span>
        </p>
      )}
      {addOutcome?.kind === "unclear" && (
        <div className="mt-2 space-y-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2.5">
          <p role="status" className="flex items-start gap-1.5 text-xs font-medium text-warning">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>{t("stt:soniox.key.unclear.title")}</span>
          </p>
          <ul className="space-y-0.5 text-meta text-muted-foreground">
            {SONIOX_REGION_IDS.map((id) => (
              <li key={id}>
                {t("stt:soniox.key.unclear.answer", {
                  region: sonioxRegionName(id),
                  answer: answerText(addOutcome.statuses[id]),
                })}
              </li>
            ))}
          </ul>
          <p className="text-meta text-foreground">{t("stt:soniox.key.unclear.pick")}</p>
          <div className="flex flex-wrap gap-1.5">
            {SONIOX_REGION_IDS.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => void addKey(id)}
                disabled={adding !== null}
                className={SMALL_BUTTON}
              >
                {adding === id && <Loader2 className="h-3 w-3 animate-spin" />}
                {sonioxRegionName(id)}
              </button>
            ))}
          </div>
        </div>
      )}
      {addError && <p role="alert" className="mt-1 text-meta text-destructive">{addError}</p>}
    </div>
  );

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

      {addKeyBlock}

      {!compact && (
        <div className="space-y-4">
          {/* Region mode */}
          <div>
            <label htmlFor={`${idPrefix}-mode`} className={FIELD_LABEL}>
              {t("stt:soniox.mode.label")}
            </label>
            <select
              id={`${idPrefix}-mode`}
              value={mode}
              onChange={(e) => changeMode(e.target.value as SonioxRegionMode)}
              className={`${FIELD_INPUT} cursor-pointer`}
            >
              {REGION_MODES.map((m) => (
                <option key={m} value={m}>
                  {t(`stt:soniox.mode.options.${m}`)}
                </option>
              ))}
            </select>
            <p className={FIELD_HINT}>{t(`stt:soniox.mode.hints.${mode}`)}</p>
          </div>

          {mode === "fixed" ? (
            /* Fixed: one region */
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
                    {sonioxRegionName(r.id)}
                  </option>
                ))}
              </select>
              <p className={FIELD_HINT}>{t("stt:soniox.region.hint")}</p>
              <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground/80">
                {config.rest_url.trim() || region.rest} · {config.ws_url.trim() || region.ws}
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta">
                {keyStatusLine(region.id)}
                {status && regionHasKey(status, region.id) && (
                  <button
                    type="button"
                    onClick={() => void deleteKey(region.id)}
                    aria-label={t("stt:soniox.regions.deleteAria", { region: sonioxRegionName(region.id) })}
                    className={SMALL_DANGER_BUTTON}
                  >
                    {t("stt:soniox.regions.deleteKey")}
                  </button>
                )}
              </div>
            </div>
          ) : (
            /* Auto / Ordered: the four regions in priority order */
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-medium text-foreground">{t("stt:soniox.regions.label")}</p>
                <button
                  type="button"
                  onClick={() => void measureLatency()}
                  disabled={measuring}
                  className={SMALL_BUTTON}
                >
                  {measuring ? <Loader2 className="h-3 w-3 animate-spin" /> : <Gauge className="h-3 w-3" />}
                  {measuring ? t("common:status.testing") : t("stt:soniox.regions.testLatency")}
                </button>
              </div>
              <ul className="divide-y divide-border/20 rounded-lg border border-border/30">
                {regionList.map((entry, index) => {
                  const name = sonioxRegionName(entry.id);
                  const hasKey = !!status && regionHasKey(status, entry.id);
                  return (
                    <li key={entry.id} className="flex items-center gap-2.5 px-3 py-2">
                      <div className="flex shrink-0 flex-col">
                        <button
                          type="button"
                          onClick={() => moveRegion(index, -1)}
                          disabled={index === 0}
                          aria-label={t("stt:soniox.regions.moveUp", { region: name })}
                          title={t("stt:soniox.regions.moveUp", { region: name })}
                          className={ARROW_BUTTON}
                        >
                          <ArrowUp className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => moveRegion(index, 1)}
                          disabled={index === regionList.length - 1}
                          aria-label={t("stt:soniox.regions.moveDown", { region: name })}
                          title={t("stt:soniox.regions.moveDown", { region: name })}
                          className={ARROW_BUTTON}
                        >
                          <ArrowDown className="h-3 w-3" />
                        </button>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className={`text-xs font-medium ${entry.enabled ? "text-foreground" : "text-muted-foreground"}`}>
                          {name}
                        </p>
                        <p className="mt-0.5 text-meta text-muted-foreground">
                          {keyStatusLine(entry.id)}
                          {" · "}
                          <span>{t("stt:soniox.regions.latency", { value: latencyText(entry.id) })}</span>
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => void testRegion(entry.id)}
                          disabled={!hasKey || rowTesting !== null}
                          aria-label={t("stt:soniox.regions.testAria", { region: name })}
                          className={SMALL_BUTTON}
                        >
                          {rowTesting === entry.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Wifi className="h-3 w-3" />
                          )}
                          {t("stt:soniox.regions.test")}
                        </button>
                        {hasKey && (
                          <button
                            type="button"
                            onClick={() => void deleteKey(entry.id)}
                            aria-label={t("stt:soniox.regions.deleteAria", { region: name })}
                            className={SMALL_DANGER_BUTTON}
                          >
                            {t("stt:soniox.regions.deleteKey")}
                          </button>
                        )}
                        <Switch
                          label={t("stt:soniox.regions.enable", { region: name })}
                          checked={entry.enabled}
                          onChange={(enabled) => setRegionEnabled(entry.id, enabled)}
                          className="ml-1"
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
              {latencyError && <p role="alert" className="text-meta text-destructive">{latencyError}</p>}
              {status && !status.any_enabled && !custom && (
                <p className="flex items-start gap-1.5 text-meta text-warning">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                  <span>{t("stt:soniox.regions.noneUsable")}</span>
                </p>
              )}
              {rowResult && (
                <div className="rounded-lg border border-border/30 bg-background/30 px-3 py-2.5">
                  <p className="mb-1 text-meta font-semibold uppercase tracking-wider text-muted-foreground/70">
                    {sonioxRegionName(rowResult.region)}
                  </p>
                  <ProbeResultView engine={ENGINE} result={rowResult.result} error={rowResult.error} />
                </div>
              )}
              <SwitchRow
                label={t("stt:soniox.failover.label")}
                hint={t("stt:soniox.failover.hint")}
                checked={config.failover}
                onChange={(failover) => update({ failover })}
              />
            </div>
          )}

          {keyError && <p role="alert" className="text-meta text-destructive">{keyError}</p>}
          {custom && (
            <p className="flex items-start gap-1.5 text-meta leading-relaxed text-warning">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
              <span>{t("stt:soniox.customEndpoint", { region: sonioxRegionInText(config.region) })}</span>
            </p>
          )}

          {/* Why several keys, and how to get the other regions */}
          <p className="flex items-start gap-1.5 text-meta leading-relaxed text-muted-foreground">
            <Info className="mt-0.5 h-3 w-3 shrink-0 text-info" aria-hidden />
            <span>{t("stt:soniox.access")}</span>
          </p>
        </div>
      )}

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

          {/* Test: the fixed region's key (or the gateway); Auto / Ordered test each region above */}
          {(mode === "fixed" || custom) && (
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
          )}
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
