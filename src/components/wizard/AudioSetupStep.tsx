// Audio step: where "you" and "them" are captured from (with a smart
// suggestion), and a test for each: speak for the microphone, play some
// sound for the system audio. When a test hears nothing it says what to
// check, with a way to the permission settings. In setup the wizard keeps
// the results; the step is done when both were heard.

import { useEffect, useState, useRef, useCallback, type ReactNode } from "react";
import { useT } from "../../i18n";
import { useConfigStore } from "../../stores/configStore";
import {
  listAudioDevices,
  startAudioTest,
  stopAudioTest,
} from "../../lib/ipc";
import { openPrivacySettings, type PrivacyPane } from "../../lib/onboarding/ipc";
import { UNTESTED_AUDIO_CHECKS, type AudioCheck, type AudioCheckKind, type AudioChecks } from "../../lib/onboarding/audioChecks";
import { isMac, isWindows } from "../../lib/platform";
import { useAudioLevel } from "../../hooks/useAudioLevel";
import type { AudioDevice, AudioDeviceList } from "../../lib/types";
import {
  Mic,
  Volume2,
  RefreshCw,
  CheckCircle,
  XCircle,
  Loader2,
  Wand2,
  ExternalLink,
} from "lucide-react";
import { StepHeader } from "./parts";

type Party = "you" | "them";

/** How long each test listens. Playing something takes a moment to start. */
const TEST_SECONDS: Record<AudioCheckKind, number> = { mic: 5, system: 8 };
const TEST_PARTY: Record<AudioCheckKind, Party> = { mic: "you", system: "them" };

interface AudioSetupStepProps {
  /** Setup: the test results, kept by the wizard so they survive leaving the step. */
  checks?: AudioChecks;
  onChecksChange?: (checks: AudioChecks) => void;
}

/** Writes a party's capture device (and the legacy device fields). */
function updateDevice(party: Party, deviceId: string, isInput: boolean) {
  const { meetingAudioConfig, setMeetingAudioConfig, setMicDeviceId, setSystemDeviceId } = useConfigStore.getState();
  // The config store always creates the audio config on load; without it only
  // the legacy fields are written (no engine is made up here).
  if (meetingAudioConfig) {
    setMeetingAudioConfig({
      ...meetingAudioConfig,
      [party]: { ...meetingAudioConfig[party], device_id: deviceId, is_input_device: isInput },
      preset_name: null,
    });
  }
  if (party === "you") setMicDeviceId(deviceId);
  else setSystemDeviceId(deviceId);
}

/** A party's capture device as it is stored now. */
function partyDevice(party: Party): { device_id: string; is_input_device: boolean } {
  const { meetingAudioConfig, micDeviceId, systemDeviceId } = useConfigStore.getState();
  if (meetingAudioConfig) return meetingAudioConfig[party];
  return party === "you"
    ? { device_id: micDeviceId ?? "default", is_input_device: true }
    : { device_id: systemDeviceId ?? "default", is_input_device: false };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function LevelMeter({ label, ariaLabel, level, peak }: { label: string; ariaLabel: string; level: number; peak: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 text-xs text-muted-foreground">{label}</span>
      <div
        className="relative h-4 flex-1 overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-label={ariaLabel}
        aria-valuenow={Math.round(level * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={`absolute inset-y-0 left-0 rounded-full transition-all duration-75 ${
            level > 0.8 ? "bg-destructive" : level > 0.5 ? "bg-warning" : "bg-success"
          }`}
          style={{ width: `${Math.min(level, 1) * 100}%` }}
        />
        {peak > 0.01 && (
          <div className="absolute inset-y-0 w-0.5 bg-foreground/60" style={{ left: `${Math.min(peak, 1) * 100}%` }} />
        )}
      </div>
      <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">{Math.round(level * 100)}</span>
    </div>
  );
}

/** What to check when a test heard nothing, with the permission page when the system has one. */
function TestHelp({ items, pane, openLabel }: { items: string[]; pane: PrivacyPane | null; openLabel: string }) {
  const { t } = useT("onboarding");
  const [openError, setOpenError] = useState("");
  return (
    <div className="mt-3 rounded-lg border border-border/40 bg-background/60 px-3.5 py-3 text-xs">
      <p className="font-medium text-foreground">{t("steps.audio.help.title")}</p>
      <ul className="mt-1.5 list-disc space-y-1 pl-4 text-muted-foreground">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      {pane && (
        <button
          type="button"
          onClick={() => {
            setOpenError("");
            openPrivacySettings(pane).catch((err) => setOpenError(t("steps.audio.help.openFailed", { detail: errorText(err) })));
          }}
          className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg border border-border/40 bg-secondary/40 px-3 py-1.5 font-medium text-foreground transition-colors hover:bg-secondary"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          {openLabel}
        </button>
      )}
      {openError && <p className="mt-1.5 text-destructive">{openError}</p>}
    </div>
  );
}

interface TestCardProps {
  title: string;
  running: boolean;
  countdown: number;
  disabled: boolean;
  onToggle: () => void;
  meter: ReactNode;
  check: AudioCheck;
  /** Lines under the meter, by state. */
  text: { idle: string; running: string; ok: string; silent: string; failed: string };
  help: ReactNode;
}

function TestCard({ title, running, countdown, disabled, onToggle, meter, check, text, help }: TestCardProps) {
  const { t } = useT("onboarding");
  const heardNothing = check.state === "silent" || check.state === "failed";
  return (
    <section aria-label={title} className="rounded-xl border border-border/40 bg-secondary/20 p-5">
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <button
          type="button"
          onClick={onToggle}
          disabled={disabled}
          className={`inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-semibold transition-all ${
            running
              ? "bg-destructive/10 text-destructive hover:bg-destructive/20"
              : "bg-primary/10 text-primary hover:bg-primary/20"
          } disabled:cursor-not-allowed disabled:opacity-50`}
        >
          {running ? (
            <>
              <div className="h-2 w-2 animate-pulse rounded-full bg-destructive" />
              {t("steps.audio.test.stop", { seconds: countdown })}
            </>
          ) : (
            t("steps.audio.test.start")
          )}
        </button>
      </div>

      <div className="space-y-2">
        {meter}
        {running ? (
          <p className="text-center text-xs text-muted-foreground">{text.running}</p>
        ) : check.state === "ok" ? (
          <p className="flex items-center justify-center gap-1.5 text-xs text-success">
            <CheckCircle className="h-3.5 w-3.5" />
            {text.ok}
          </p>
        ) : heardNothing ? (
          <p className="flex items-start justify-center gap-1.5 text-center text-xs text-destructive">
            <XCircle className="mt-px h-3.5 w-3.5 shrink-0" />
            {check.state === "silent" ? text.silent : text.failed}
          </p>
        ) : (
          <p className="text-center text-xs text-muted-foreground">{text.idle}</p>
        )}
      </div>
      {!running && heardNothing && help}
    </section>
  );
}

export function AudioSetupStep({ checks: keptChecks, onChecksChange }: AudioSetupStepProps = {}) {
  const { t } = useT(["onboarding", "common"]);
  const meetingAudioConfig = useConfigStore((s) => s.meetingAudioConfig);
  const micDeviceId = useConfigStore((s) => s.micDeviceId);
  const systemDeviceId = useConfigStore((s) => s.systemDeviceId);

  const levels = useAudioLevel();

  const [devices, setDevices] = useState<AudioDeviceList>({
    inputs: [],
    outputs: [],
  });
  const [loadingDevices, setLoadingDevices] = useState(true);
  const [isScanning, setIsScanning] = useState(false);
  const [scanResults, setScanResults] = useState<
    { device: AudioDevice; hasAudio: boolean }[]
  >([]);

  // Test results: the wizard's when it keeps them, else this component's.
  const [ownChecks, setOwnChecks] = useState<AudioChecks>(UNTESTED_AUDIO_CHECKS);
  const checks = keptChecks ?? ownChecks;
  const checksRef = useRef(checks);
  checksRef.current = checks;
  const setCheck = useCallback(
    (kind: AudioCheckKind, check: AudioCheck) => {
      const next = { ...checksRef.current, [kind]: check };
      checksRef.current = next;
      if (onChecksChange) onChecksChange(next);
      else setOwnChecks(next);
    },
    [onChecksChange],
  );

  // One test at a time (the backend runs a single test stream).
  const [running, setRunning] = useState<AudioCheckKind | null>(null);
  const runningRef = useRef<AudioCheckKind | null>(null);
  const [testCountdown, setTestCountdown] = useState(0);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const unmounted = useRef(false);

  const you = meetingAudioConfig?.you ?? { device_id: micDeviceId ?? "default", is_input_device: true };
  const them = meetingAudioConfig?.them ?? { device_id: systemDeviceId ?? "default", is_input_device: false };
  // A test's level comes as "Mic" from an input device and "System" through loopback.
  const levelOf = (party: { is_input_device: boolean }) =>
    party.is_input_device
      ? { level: levels.micLevel, peak: levels.micPeak }
      : { level: levels.systemLevel, peak: levels.systemPeak };

  // The user picked another source: that party's earlier result no longer applies.
  const chooseDevice = useCallback(
    (party: Party, deviceId: string, isInput: boolean) => {
      updateDevice(party, deviceId, isInput);
      const kind: AudioCheckKind = party === "you" ? "mic" : "system";
      if (checksRef.current[kind].state !== "untested") setCheck(kind, { state: "untested" });
    },
    [setCheck],
  );

  const loadDevices = useCallback(async () => {
    setLoadingDevices(true);
    try {
      const deviceList = await listAudioDevices();
      setDevices(deviceList);

      // Auto-select defaults if nothing selected
      const youId = partyDevice("you").device_id;
      const themId = partyDevice("them").device_id;
      if (!youId || youId === "default") {
        const defaultInput = deviceList.inputs.find((d) => d.is_default);
        if (defaultInput) updateDevice("you", defaultInput.id, true);
      }
      if (!themId || themId === "default") {
        const defaultOutput = deviceList.outputs.find((d) => d.is_default);
        if (defaultOutput) updateDevice("them", defaultOutput.id, false);
      }
    } catch (err) {
      console.error("[AudioSetupStep] Failed to load devices:", err);
    } finally {
      setLoadingDevices(false);
    }
  }, []);

  // Load devices on mount
  useEffect(() => {
    loadDevices();
  }, [loadDevices]);

  // Clean up on unmount (a running test or device scan stops)
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      if (countdownRef.current) clearInterval(countdownRef.current);
      stopAudioTest().catch(() => {});
    };
  }, []);

  // Smart Source Suggestion: scan each device for audio activity
  const handleSmartScan = useCallback(async () => {
    if (isScanning || runningRef.current) return;
    setIsScanning(true);
    setScanResults([]);

    const allDevices = [...devices.inputs, ...devices.outputs];
    const results: { device: AudioDevice; hasAudio: boolean }[] = [];

    for (const device of allDevices) {
      if (unmounted.current) return;
      try {
        await startAudioTest(device.id, device.is_input);
        // Wait 1.5 seconds to detect audio
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const detected = await stopAudioTest();
        results.push({ device, hasAudio: detected });
      } catch {
        results.push({ device, hasAudio: false });
      }
    }

    setScanResults(results);

    // Auto-suggest based on results
    const activeMic = results.find((r) => r.device.is_input && r.hasAudio);
    const activeOutput = results.find((r) => !r.device.is_input && r.hasAudio);

    if (activeMic) chooseDevice("you", activeMic.device.id, true);
    if (activeOutput) chooseDevice("them", activeOutput.device.id, false);

    setIsScanning(false);
  }, [isScanning, devices, chooseDevice]);

  const finishTest = useCallback(async () => {
    const kind = runningRef.current;
    if (!kind) return;
    runningRef.current = null;
    if (countdownRef.current) clearInterval(countdownRef.current);
    countdownRef.current = null;
    setTestCountdown(0);
    const detected = await stopAudioTest().catch(() => false);
    setRunning(null);
    setCheck(kind, { state: detected ? "ok" : "silent" });
  }, [setCheck]);

  const toggleTest = useCallback(
    async (kind: AudioCheckKind) => {
      if (runningRef.current) {
        if (runningRef.current === kind) await finishTest();
        return;
      }
      const device = partyDevice(TEST_PARTY[kind]);
      try {
        await startAudioTest(device.device_id, device.is_input_device);
      } catch (err) {
        setCheck(kind, { state: "failed", error: errorText(err) });
        return;
      }

      runningRef.current = kind;
      setRunning(kind);
      let remaining = TEST_SECONDS[kind];
      setTestCountdown(remaining);
      countdownRef.current = setInterval(() => {
        remaining -= 1;
        setTestCountdown(remaining);
        if (remaining <= 0) void finishTest();
      }, 1000);
    },
    [finishTest, setCheck],
  );

  const deviceLabel = (d: AudioDevice) =>
    d.is_default ? t("steps.audio.deviceDefault", { name: d.name }) : d.name;

  const micOptions = devices.inputs.length > 0 && (
    <optgroup label={t("steps.audio.microphones")}>
      {devices.inputs.map((d) => (
        <option key={d.id} value={JSON.stringify([d.is_input, d.id])}>
          {deviceLabel(d)}
        </option>
      ))}
    </optgroup>
  );
  const outputOptions = devices.outputs.length > 0 && (
    <optgroup label={t("steps.audio.outputs")}>
      {devices.outputs.map((d) => (
        <option key={d.id} value={JSON.stringify([d.is_input, d.id])}>
          {deviceLabel(d)}
        </option>
      ))}
    </optgroup>
  );

  const busy = isScanning || running !== null;
  const selectClass =
    "w-full rounded-xl border border-border/40 bg-background px-4 py-3 text-sm transition-colors focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20";

  const micLevel = levelOf(you);
  const systemLevel = levelOf(them);
  // Without a permission page (Linux; system audio on Windows) only the checklist shows.
  const micPane: PrivacyPane | null = isMac() || isWindows() ? "microphone" : null;
  const systemPane: PrivacyPane | null = isMac() ? "system_audio" : null;

  return (
    <div>
      <StepHeader
        icon={<Mic className="h-5 w-5" />}
        title={t("steps.audio.title")}
        description={t("steps.audio.description")}
      />

      <div className="space-y-5">
        {/* Smart Scan Button */}
        <button
          onClick={handleSmartScan}
          disabled={busy || loadingDevices}
          className="flex w-full items-center justify-center gap-2.5 rounded-xl border border-primary/30 bg-primary/5 px-5 py-3 text-sm font-semibold text-primary shadow-sm transition-all hover:bg-primary/10 hover:shadow-md disabled:opacity-50"
        >
          {isScanning ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("steps.audio.scanning")}
            </>
          ) : (
            <>
              <Wand2 className="h-4 w-4" />
              {t("steps.audio.smartDetect")}
            </>
          )}
        </button>

        {/* Scan Results */}
        {scanResults.length > 0 && (
          <div className="rounded-xl border border-border/40 bg-secondary/20 p-3.5 space-y-1.5">
            <p className="text-meta font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
              {t("steps.audio.scanResults")}
            </p>
            {scanResults.map((r) => (
              <div key={r.device.id} className="flex items-center gap-2 text-xs">
                {r.device.is_input ? (
                  <Mic className="h-3 w-3 text-muted-foreground" />
                ) : (
                  <Volume2 className="h-3 w-3 text-muted-foreground" />
                )}
                <span className="flex-1 truncate text-foreground">{r.device.name}</span>
                {r.hasAudio ? (
                  <span className="flex items-center gap-1 text-success">
                    <CheckCircle className="h-3 w-3" /> {t("steps.audio.active")}
                  </span>
                ) : (
                  <span className="text-muted-foreground/50">{t("steps.audio.silent")}</span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* YOUR Source */}
        <div className="space-y-2.5">
          <label className="flex items-center gap-2.5 text-sm font-medium text-foreground">
            <span className="rounded-lg bg-primary/10 px-2 py-1 text-meta font-semibold uppercase tracking-wide text-primary">
              {t("common:labels.you")}
            </span>
            {t("steps.audio.source")}
          </label>
          <select
            value={JSON.stringify([you.is_input_device, you.device_id])}
            onChange={(e) => {
              const [isInput, deviceId]: [boolean, string] = JSON.parse(e.target.value);
              chooseDevice("you", deviceId, isInput);
            }}
            disabled={loadingDevices || busy}
            className={selectClass}
          >
            <option value={JSON.stringify([true, "default"])}>
              {loadingDevices ? t("steps.audio.detecting") : t("steps.audio.defaultMic")}
            </option>
            {micOptions}
            {outputOptions}
          </select>
        </div>

        {/* THEIR Source */}
        <div className="space-y-2.5">
          <label className="flex items-center gap-2.5 text-sm font-medium text-foreground">
            <span className="rounded-lg bg-muted px-2 py-1 text-meta font-semibold uppercase tracking-wide text-muted-foreground">
              {t("common:labels.them")}
            </span>
            {t("steps.audio.source")}
          </label>
          <select
            value={JSON.stringify([them.is_input_device, them.device_id])}
            onChange={(e) => {
              const [isInput, deviceId]: [boolean, string] = JSON.parse(e.target.value);
              chooseDevice("them", deviceId, isInput);
            }}
            disabled={loadingDevices || busy}
            className={selectClass}
          >
            <option value={JSON.stringify([false, "default"])}>
              {loadingDevices ? t("steps.audio.detecting") : t("steps.audio.defaultOutput")}
            </option>
            {outputOptions}
            {micOptions}
          </select>
        </div>

        {/* Refresh */}
        <button
          onClick={loadDevices}
          disabled={loadingDevices || busy}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className={`h-3 w-3 ${loadingDevices ? "animate-spin" : ""}`} />
          {t("steps.audio.refresh")}
        </button>

        {/* Microphone ("you") test */}
        <TestCard
          title={t("steps.audio.micTest.title")}
          running={running === "mic"}
          countdown={testCountdown}
          disabled={!you.device_id || isScanning || running === "system"}
          onToggle={() => void toggleTest("mic")}
          meter={
            <LevelMeter
              label={t("steps.audio.micTest.level")}
              ariaLabel={t("steps.audio.micTest.meter")}
              level={running === "mic" ? micLevel.level : 0}
              peak={running === "mic" ? micLevel.peak : 0}
            />
          }
          check={checks.mic}
          text={{
            idle: t("steps.audio.micTest.idle"),
            running: t("steps.audio.micTest.speakNow"),
            ok: t("steps.audio.micTest.detected"),
            silent: t("steps.audio.micTest.silent"),
            failed: t("steps.audio.test.failed", { detail: checks.mic.error ?? "" }),
          }}
          help={
            <TestHelp
              items={[
                t("steps.audio.help.micDevice"),
                isWindows() ? t("steps.audio.help.micPermissionWindows") : t("steps.audio.help.micPermission"),
              ]}
              pane={micPane}
              openLabel={t("steps.audio.help.openMicSettings")}
            />
          }
        />

        {/* System audio ("them") test */}
        <TestCard
          title={t("steps.audio.systemTest.title")}
          running={running === "system"}
          countdown={testCountdown}
          disabled={!them.device_id || isScanning || running === "mic"}
          onToggle={() => void toggleTest("system")}
          meter={
            <LevelMeter
              label={t("steps.audio.systemTest.level")}
              ariaLabel={t("steps.audio.systemTest.meter")}
              level={running === "system" ? systemLevel.level : 0}
              peak={running === "system" ? systemLevel.peak : 0}
            />
          }
          check={checks.system}
          text={{
            idle: t("steps.audio.systemTest.idle"),
            running: t("steps.audio.systemTest.playNow"),
            ok: t("steps.audio.systemTest.detected"),
            silent: t("steps.audio.systemTest.silent"),
            failed: t("steps.audio.test.failed", { detail: checks.system.error ?? "" }),
          }}
          help={
            <TestHelp
              items={[
                t("steps.audio.help.systemPlaying"),
                ...(isMac() ? [t("steps.audio.help.systemPermission")] : []),
              ]}
              pane={systemPane}
              openLabel={t("steps.audio.help.openSystemSettings")}
            />
          }
        />
      </div>
    </div>
  );
}
