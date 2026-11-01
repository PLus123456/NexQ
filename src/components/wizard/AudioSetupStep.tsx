// Audio step: where "you" and "them" are captured from, with a smart
// suggestion and a microphone test. In the wizard it reports the step's
// state: done when the microphone test hears sound.

import { useEffect, useState, useRef, useCallback } from "react";
import { useT } from "../../i18n";
import { useConfigStore } from "../../stores/configStore";
import {
  listAudioDevices,
  startAudioTest,
  stopAudioTest,
} from "../../lib/ipc";
import { useAudioLevel } from "../../hooks/useAudioLevel";
import type { AudioDevice, AudioDeviceList } from "../../lib/types";
import type { QuickSetupProps } from "../../settings/quickSetup";
import {
  Mic,
  Volume2,
  RefreshCw,
  CheckCircle,
  XCircle,
  Loader2,
  Wand2,
} from "lucide-react";
import { StepHeader } from "./parts";

const MIC_TEST_SECONDS = 5;

type Party = "you" | "them";
type MicTestState = "idle" | "running" | "detected" | "silent" | "failed";

interface AudioSetupStepProps {
  /** Wizard only: reports the step's state. */
  onStatusChange?: QuickSetupProps["onStatusChange"];
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

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function AudioSetupStep({ onStatusChange }: AudioSetupStepProps = {}) {
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
  const [micTest, setMicTest] = useState<MicTestState>("idle");
  const [micTestError, setMicTestError] = useState("");
  const [testCountdown, setTestCountdown] = useState(0);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const you = meetingAudioConfig?.you ?? { device_id: micDeviceId ?? "default", is_input_device: true };
  const them = meetingAudioConfig?.them ?? { device_id: systemDeviceId ?? "default", is_input_device: false };
  // An output device picked for "you" is tested through loopback (the "System" level).
  const micLevel = you.is_input_device ? levels.micLevel : levels.systemLevel;
  const micPeak = you.is_input_device ? levels.micPeak : levels.systemPeak;

  // The user picked another source: an earlier test result no longer applies.
  const chooseDevice = useCallback(
    (party: Party, deviceId: string, isInput: boolean) => {
      updateDevice(party, deviceId, isInput);
      if (party === "you") setMicTest("idle");
      onStatusChange?.("incomplete");
    },
    [onStatusChange],
  );

  const loadDevices = useCallback(async () => {
    setLoadingDevices(true);
    try {
      const deviceList = await listAudioDevices();
      setDevices(deviceList);

      // Auto-select defaults if nothing selected
      const config = useConfigStore.getState().meetingAudioConfig;
      const youId = config?.you.device_id ?? useConfigStore.getState().micDeviceId;
      const themId = config?.them.device_id ?? useConfigStore.getState().systemDeviceId;
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

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
      stopAudioTest().catch(() => {});
    };
  }, []);

  // Smart Source Suggestion: scan each device for audio activity
  const handleSmartScan = useCallback(async () => {
    if (isScanning) return;
    setIsScanning(true);
    setScanResults([]);

    const allDevices = [...devices.inputs, ...devices.outputs];
    const results: { device: AudioDevice; hasAudio: boolean }[] = [];

    for (const device of allDevices) {
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

  const finishMicTest = useCallback(async () => {
    if (countdownRef.current) clearInterval(countdownRef.current);
    countdownRef.current = null;
    setTestCountdown(0);
    const detected = await stopAudioTest().catch(() => false);
    setMicTest(detected ? "detected" : "silent");
    if (detected) onStatusChange?.("ok");
    else onStatusChange?.("error", t("steps.audio.micTest.silent"));
  }, [onStatusChange, t]);

  // Live audio test
  const handleLiveTest = useCallback(async () => {
    if (micTest === "running") {
      await finishMicTest();
      return;
    }
    if (!you.device_id) return;

    try {
      await startAudioTest(you.device_id, you.is_input_device);
    } catch (err) {
      const detail = errorText(err);
      setMicTest("failed");
      setMicTestError(detail);
      onStatusChange?.("error", t("steps.audio.micTest.failed", { detail }));
      return;
    }

    setMicTest("running");
    setTestCountdown(MIC_TEST_SECONDS);

    let remaining = MIC_TEST_SECONDS;
    countdownRef.current = setInterval(() => {
      remaining -= 1;
      setTestCountdown(remaining);
      if (remaining <= 0) void finishMicTest();
    }, 1000);
  }, [micTest, finishMicTest, you.device_id, you.is_input_device, onStatusChange, t]);

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

  const selectClass =
    "w-full rounded-xl border border-border/40 bg-background px-4 py-3 text-sm transition-colors focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20";

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
          disabled={isScanning || loadingDevices}
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
            disabled={loadingDevices}
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
            disabled={loadingDevices}
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
          disabled={loadingDevices}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className={`h-3 w-3 ${loadingDevices ? "animate-spin" : ""}`} />
          {t("steps.audio.refresh")}
        </button>

        {/* Live Audio Test */}
        <div className="rounded-xl border border-border/40 bg-secondary/20 p-5">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm font-semibold text-foreground">{t("steps.audio.micTest.title")}</p>
            <button
              onClick={handleLiveTest}
              disabled={!you.device_id}
              className={`inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-semibold transition-all ${
                micTest === "running"
                  ? "bg-destructive/10 text-destructive hover:bg-destructive/20"
                  : "bg-primary/10 text-primary hover:bg-primary/20"
              } disabled:cursor-not-allowed disabled:opacity-50`}
            >
              {micTest === "running" ? (
                <>
                  <div className="h-2 w-2 animate-pulse rounded-full bg-destructive" />
                  {t("steps.audio.micTest.stop", { seconds: testCountdown })}
                </>
              ) : (
                t("steps.audio.micTest.start")
              )}
            </button>
          </div>

          {/* Level Meter */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="w-12 text-xs text-muted-foreground">{t("steps.audio.micTest.level")}</span>
              <div
                className="relative h-4 flex-1 overflow-hidden rounded-full bg-muted"
                role="meter"
                aria-label={t("steps.audio.micTest.meter")}
                aria-valuenow={Math.round(micLevel * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className={`absolute inset-y-0 left-0 rounded-full transition-all duration-75 ${
                    micLevel > 0.8
                      ? "bg-destructive"
                      : micLevel > 0.5
                        ? "bg-warning"
                        : "bg-success"
                  }`}
                  style={{ width: `${Math.min(micLevel, 1) * 100}%` }}
                />
                {micPeak > 0.01 && (
                  <div
                    className="absolute inset-y-0 w-0.5 bg-foreground/60"
                    style={{ left: `${Math.min(micPeak, 1) * 100}%` }}
                  />
                )}
              </div>
              <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">
                {Math.round(micLevel * 100)}
              </span>
            </div>

            {micTest === "detected" ? (
              <p className="flex items-center justify-center gap-1.5 text-xs text-success">
                <CheckCircle className="h-3.5 w-3.5" />
                {t("steps.audio.micTest.detected")}
              </p>
            ) : micTest === "silent" || micTest === "failed" ? (
              <p className="flex items-start justify-center gap-1.5 text-center text-xs text-destructive">
                <XCircle className="mt-px h-3.5 w-3.5 shrink-0" />
                {micTest === "silent"
                  ? t("steps.audio.micTest.silent")
                  : t("steps.audio.micTest.failed", { detail: micTestError })}
              </p>
            ) : (
              <p className="text-center text-xs text-muted-foreground">
                {micTest === "running" ? t("steps.audio.micTest.speakNow") : t("steps.audio.micTest.idle")}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
