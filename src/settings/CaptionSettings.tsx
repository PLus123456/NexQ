// Settings of the caption strip (SPEC 3.2), with a live preview.

import type { ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { useT } from "../i18n";
import { useConfigStore } from "../stores/configStore";
import { DEFAULT_CAPTIONS_SETTINGS, type CaptionsParties, type CaptionsShow } from "../lib/captions/types";
import { clampCaptionsSettings } from "../lib/captions/layout";
import { setCaptionsLocked } from "../lib/captions/window";
import type { StripCue } from "../lib/captions/feed";
import { CaptionStack } from "../captions/CaptionStack";

const TEXT_SWATCHES = ["#ffffff", "#f5f5f4", "#fde68a", "#a5f3fc"];
const TRANSLATION_SWATCHES = ["#ffd34d", "#ffffff", "#86efac", "#7dd3fc"];

const CHECKERBOARD = "repeating-conic-gradient(#c9c9c9 0% 25%, #f4f4f4 0% 50%) 0 0 / 20px 20px";
const PICTURE = "radial-gradient(circle at 30% 30%, #6b7280 0, transparent 45%), linear-gradient(160deg, #111827, #3b3355)";

export function CaptionSettings() {
  const { t } = useT("captions");
  const s = clampCaptionsSettings(
    useConfigStore(
      useShallow((c) => ({
        captionsEnabled: c.captionsEnabled,
        captionsParties: c.captionsParties,
        captionsShow: c.captionsShow,
        captionsFontSize: c.captionsFontSize,
        captionsTranslationFontSize: c.captionsTranslationFontSize,
        captionsTextColor: c.captionsTextColor,
        captionsTranslationColor: c.captionsTranslationColor,
        captionsBgOpacity: c.captionsBgOpacity,
        captionsCueCount: c.captionsCueCount,
        captionsFadeSeconds: c.captionsFadeSeconds,
        captionsLocked: c.captionsLocked,
        captionsBounds: c.captionsBounds,
      })),
    ),
  );
  const store = useConfigStore.getState;

  const samples: StripCue[] = [
    {
      id: "sample#0", lineId: "sample", party: "them", complete: true,
      src: t("settings.sample.olderSrc"), dst: t("settings.sample.olderDst"),
    },
    {
      id: "sample#1", lineId: "sample", party: s.captionsParties === "both" ? "you" : "them", complete: false,
      src: t("settings.sample.newestSrc"), srcPending: t("settings.sample.newestPending"), dst: t("settings.sample.newestDst"),
    },
  ];
  const sample = samples.slice(-s.captionsCueCount);

  const restoreDefaults = () => {
    const d = DEFAULT_CAPTIONS_SETTINGS;
    const c = store();
    c.setCaptionsParties(d.captionsParties);
    c.setCaptionsShow(d.captionsShow);
    c.setCaptionsFontSize(d.captionsFontSize);
    c.setCaptionsTranslationFontSize(d.captionsTranslationFontSize);
    c.setCaptionsTextColor(d.captionsTextColor);
    c.setCaptionsTranslationColor(d.captionsTranslationColor);
    c.setCaptionsBgOpacity(d.captionsBgOpacity);
    c.setCaptionsCueCount(d.captionsCueCount);
    c.setCaptionsFadeSeconds(d.captionsFadeSeconds);
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border/30 bg-card/50 p-5 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-primary/80">{t("settings.title")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{t("settings.intro")}</p>
        </div>

        <div>
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">{t("settings.preview.label")}</div>
          <div className="grid grid-cols-2 overflow-hidden rounded-lg border border-border/30" data-testid="caption-preview">
            {[PICTURE, CHECKERBOARD].map((background, i) => (
              <div key={i} className="relative h-[150px] overflow-hidden" style={{ background }} aria-label={t(i === 0 ? "settings.preview.dark" : "settings.preview.light")}>
                <CaptionStack
                  cues={sample}
                  look={s}
                  showParty={s.captionsParties === "both"}
                  reserveTranslation
                  className="absolute inset-0"
                  style={{ padding: "8px 10px", ["--caption-fade" as string]: "0px" }}
                />
              </div>
            ))}
          </div>
        </div>

        <Row label={t("settings.enabled.label")} hint={t("settings.enabled.hint")}>
          <Switch checked={s.captionsEnabled} label={t("settings.enabled.label")} onChange={(v) => store().setCaptionsEnabled(v)} />
        </Row>

        <Row label={t("settings.parties.label")}>
          <Segmented<CaptionsParties>
            value={s.captionsParties}
            options={[["them", t("settings.parties.them")], ["both", t("settings.parties.both")]]}
            onChange={(v) => store().setCaptionsParties(v)}
            label={t("settings.parties.label")}
          />
        </Row>

        <Row label={t("settings.show.label")}>
          <Segmented<CaptionsShow>
            value={s.captionsShow}
            options={[
              ["both", t("settings.show.both")],
              ["translation", t("settings.show.translation")],
              ["original", t("settings.show.original")],
            ]}
            onChange={(v) => store().setCaptionsShow(v)}
            label={t("settings.show.label")}
          />
        </Row>
      </div>

      <div className="rounded-xl border border-border/30 bg-card/50 p-5 space-y-4">
        <Slider label={t("settings.fontSize")} value={s.captionsFontSize} min={12} max={40} step={1} unit="px"
          onChange={(v) => store().setCaptionsFontSize(v)} />
        <Slider label={t("settings.translationFontSize")} value={s.captionsTranslationFontSize} min={12} max={40} step={1} unit="px"
          onChange={(v) => store().setCaptionsTranslationFontSize(v)} />
        <Row label={t("settings.textColor")}>
          <ColorPicker value={s.captionsTextColor} swatches={TEXT_SWATCHES} label={t("settings.textColor")}
            onChange={(v) => store().setCaptionsTextColor(v)} />
        </Row>
        <Row label={t("settings.translationColor")}>
          <ColorPicker value={s.captionsTranslationColor} swatches={TRANSLATION_SWATCHES} label={t("settings.translationColor")}
            onChange={(v) => store().setCaptionsTranslationColor(v)} />
        </Row>
        <Slider label={t("settings.bgOpacity.label")} hint={t("settings.bgOpacity.hint")} value={s.captionsBgOpacity} min={0} max={0.8} step={0.05}
          format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => store().setCaptionsBgOpacity(v)} />
        <Row label={t("settings.cueCount.label")} hint={t("settings.cueCount.hint")}>
          <Segmented<string>
            value={String(s.captionsCueCount)}
            options={[["1", "1"], ["2", "2"], ["3", "3"]]}
            onChange={(v) => store().setCaptionsCueCount(Number(v))}
            label={t("settings.cueCount.label")}
          />
        </Row>
        <Slider label={t("settings.fade.label")} hint={t("settings.fade.hint")} value={s.captionsFadeSeconds} min={0} max={30} step={1}
          format={(v) => (v === 0 ? t("settings.fade.never") : t("settings.fade.seconds", { value: v }))}
          onChange={(v) => store().setCaptionsFadeSeconds(v)} />
      </div>

      <div className="rounded-xl border border-border/30 bg-card/50 p-5 space-y-4">
        {s.captionsLocked && (
          <Row label={t("settings.locked.label")} hint={t("settings.locked.hint")}>
            <button type="button" onClick={() => void setCaptionsLocked(false)}
              className="rounded-md border border-border/50 px-3 py-1.5 text-xs font-medium hover:bg-muted">
              {t("settings.locked.unlock")}
            </button>
          </Row>
        )}
        <Row label={t("settings.position.label")} hint={t("settings.position.hint")}>
          <button type="button" onClick={() => store().setCaptionsBounds(null)} disabled={s.captionsBounds === null}
            className="rounded-md border border-border/50 px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-40">
            {t("settings.position.reset")}
          </button>
        </Row>
        <div className="flex justify-end">
          <button type="button" onClick={restoreDefaults}
            className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
            {t("settings.reset")}
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Switch({ checked, label, onChange }: { checked: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-all duration-200 ${checked ? "bg-primary" : "bg-muted"}`}
    >
      <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-all duration-200 ${checked ? "translate-x-5" : "translate-x-0"}`} />
    </button>
  );
}

function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: Array<[T, string]>;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-lg bg-muted/60 p-0.5">
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            value === v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function Slider({ label, hint, value, min, max, step, unit, format, onChange }: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-4">
        <div>
          <div className="text-sm font-medium text-foreground">{label}</div>
          {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
        </div>
        <span className="text-sm font-semibold tabular-nums text-primary">{format ? format(value) : `${value}${unit ?? ""}`}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full cursor-pointer accent-primary"
      />
    </div>
  );
}

function ColorPicker({ value, swatches, label, onChange }: {
  value: string;
  swatches: string[];
  label: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      {swatches.map((c) => (
        <button
          key={c}
          type="button"
          aria-label={`${label} ${c}`}
          aria-pressed={value.toLowerCase() === c}
          onClick={() => onChange(c)}
          className={`h-6 w-6 rounded-full border ${value.toLowerCase() === c ? "border-primary ring-2 ring-primary/40" : "border-border/60"}`}
          style={{ background: c }}
        />
      ))}
      <input
        type="color"
        value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#ffffff"}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 w-9 cursor-pointer rounded border border-border/60 bg-transparent p-0.5"
      />
    </div>
  );
}
