import type { ParseKeys } from "i18next";
import { useConfigStore } from "../stores/configStore";
import { Sun, Moon, Monitor } from "lucide-react";
import type { ThemeMode } from "../lib/types";
import { Eye } from "lucide-react";
import {
  Trans,
  UI_LANGUAGES,
  UI_LANGUAGE_NAMES,
  changeUiLanguage,
  useT,
  useUiLanguage,
  type UiLanguageSetting,
} from "../i18n";
import { StealthSettings } from "./StealthSettings";
import { MeetingDetectionSettings } from "./MeetingDetectionSettings";

const THEME_OPTIONS: { value: ThemeMode; labelKey: ParseKeys<"settings">; icon: React.ReactNode }[] = [
  { value: "dark", labelKey: "general.theme.options.dark", icon: <Moon className="h-3.5 w-3.5" /> },
  { value: "light", labelKey: "general.theme.options.light", icon: <Sun className="h-3.5 w-3.5" /> },
  {
    value: "system",
    labelKey: "general.theme.options.system",
    icon: <Monitor className="h-3.5 w-3.5" />,
  },
];

interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
  /** Language of the label when it differs from the UI's (language names). */
  lang?: string;
}

/** A row of mutually exclusive buttons (theme, interface language). */
function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  /** Accessible name of the group. */
  label: string;
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex rounded-lg border border-border/50 bg-secondary/30 p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          lang={opt.lang}
          aria-pressed={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all duration-150 cursor-pointer ${
            value === opt.value
              ? "bg-primary text-primary-foreground shadow-sm shadow-primary/20"
              : "text-muted-foreground hover:text-foreground hover:bg-secondary/50 active:scale-95"
          }`}
        >
          {opt.icon}
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function GeneralSettings() {
  const { t } = useT("settings");
  const { setting: uiLanguage } = useUiLanguage();
  const theme = useConfigStore((s) => s.theme);
  const setTheme = useConfigStore((s) => s.setTheme);
  const autoSummary = useConfigStore((s) => s.autoSummary);
  const setAutoSummary = useConfigStore((s) => s.setAutoSummary);
  const startOnLogin = useConfigStore((s) => s.startOnLogin);
  const setStartOnLogin = useConfigStore((s) => s.setStartOnLogin);
  const overlayOpacity = useConfigStore((s) => s.overlayOpacity);
  const setOverlayOpacity = useConfigStore((s) => s.setOverlayOpacity);

  const languageOptions: SegmentOption<UiLanguageSetting>[] = [
    { value: "system", label: t("general.language.options.system") },
    ...UI_LANGUAGES.map((lang) => ({ value: lang, label: UI_LANGUAGE_NAMES[lang], lang })),
  ];

  const themeOptions: SegmentOption<ThemeMode>[] = THEME_OPTIONS.map((opt) => ({
    value: opt.value,
    label: t(opt.labelKey),
    icon: opt.icon,
  }));

  return (
    <div className="space-y-6">
      {/* Interface language */}
      <div className="rounded-xl border border-border/30 bg-card/50 p-5">
        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm font-medium text-foreground">{t("general.language.label")}</label>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("general.language.hint")}</p>
          </div>
          <SegmentedControl
            label={t("general.language.label")}
            options={languageOptions}
            value={uiLanguage}
            onChange={(setting) => void changeUiLanguage(setting)}
          />
        </div>
      </div>

      {/* Theme Toggle */}
      <div className="rounded-xl border border-border/30 bg-card/50 p-5">
        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm font-medium text-foreground">{t("general.theme.label")}</label>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("general.theme.hint")}</p>
          </div>
          <SegmentedControl
            label={t("general.theme.label")}
            options={themeOptions}
            value={theme}
            onChange={setTheme}
          />
        </div>
      </div>

      {/* Stealth mode */}
      <StealthSettings />

      {/* Meeting detection */}
      <MeetingDetectionSettings />

      {/* Toggle Options */}
      <div className="rounded-xl border border-border/30 bg-card/50 p-5 space-y-5">
        <h3 className="text-sm font-semibold text-primary/80">{t("general.behavior.title")}</h3>

        {/* Auto-Summary Toggle */}
        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm font-medium text-foreground">
              {t("general.autoSummary.label")}
            </label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("general.autoSummary.hint")}
            </p>
          </div>
          <button
            onClick={() => setAutoSummary(!autoSummary)}
            role="switch"
            aria-checked={autoSummary}
            aria-label={t("general.autoSummary.ariaLabel")}
            className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-all duration-200 ${
              autoSummary ? "bg-primary shadow-[0_0_0_3px_hsl(var(--primary)/0.12)]" : "bg-muted"
            }`}
          >
            <span
              className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-all duration-200 ${
                autoSummary ? "translate-x-5 scale-[1.05]" : "translate-x-0"
              }`}
            />
          </button>
        </div>

        <div className="h-px bg-border/20" />

        {/* Start on Login Toggle */}
        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm font-medium text-foreground">
              {t("general.startOnLogin.label")}
            </label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("general.startOnLogin.hint")}
            </p>
          </div>
          <button
            onClick={() => setStartOnLogin(!startOnLogin)}
            role="switch"
            aria-checked={startOnLogin}
            aria-label={t("general.startOnLogin.ariaLabel")}
            className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-all duration-200 ${
              startOnLogin ? "bg-primary shadow-[0_0_0_3px_hsl(var(--primary)/0.12)]" : "bg-muted"
            }`}
          >
            <span
              className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-all duration-200 ${
                startOnLogin ? "translate-x-5 scale-[1.05]" : "translate-x-0"
              }`}
            />
          </button>
        </div>
      </div>

      {/* Moved notice */}
      <div className="rounded-xl border border-info/20 bg-info/5 px-5 py-3">
        <p className="text-xs text-info/80">
          <Trans
            t={t}
            i18nKey="general.movedNotice"
            components={{ strong: <strong className="text-info" /> }}
          />
        </p>
      </div>

      {/* Overlay Opacity */}
      <div className="rounded-xl border border-border/30 bg-card/50 p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Eye className="h-3.5 w-3.5 text-muted-foreground" />
            <div>
              <label className="text-sm font-medium text-foreground">{t("general.overlayOpacity.label")}</label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t("general.overlayOpacity.hint")}
              </p>
            </div>
          </div>
          <span className="text-xs font-mono text-muted-foreground w-10 text-right">
            {Math.round(overlayOpacity * 100)}%
          </span>
        </div>
        <input
          type="range"
          min={0.1}
          max={1}
          step={0.01}
          value={overlayOpacity}
          onChange={(e) => setOverlayOpacity(parseFloat(e.target.value))}
          className="w-full h-1.5 rounded-full appearance-none bg-secondary cursor-pointer accent-primary"
        />
        <div className="flex justify-between mt-1">
          <span className="text-[10px] text-muted-foreground/50">{t("general.overlayOpacity.transparent")}</span>
          <span className="text-[10px] text-muted-foreground/50">{t("general.overlayOpacity.solid")}</span>
        </div>
      </div>

      {/* Data Directory: hidden. Rust never reads the dataDirectory setting
          (data lives in the app data dir), so picking a folder did nothing. */}
    </div>
  );
}
