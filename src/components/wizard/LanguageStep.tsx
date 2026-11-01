// Step 1: interface language (applies at once, in every window) and what
// the following steps are about.

import { useEffect } from "react";
import { Brain, Check, Globe, Headphones, Languages, Mic } from "lucide-react";
import {
  UI_LANGUAGES,
  UI_LANGUAGE_NAMES,
  changeUiLanguage,
  resolveUiLanguage,
  useT,
  useUiLanguage,
  type UiLanguageSetting,
} from "../../i18n";
import type { QuickSetupProps } from "../../settings/quickSetup";
import { StepHeader } from "./parts";

const OVERVIEW = [
  { step: "llm", icon: <Brain className="h-3.5 w-3.5" /> },
  { step: "stt", icon: <Mic className="h-3.5 w-3.5" /> },
  { step: "translation", icon: <Globe className="h-3.5 w-3.5" /> },
  { step: "audio", icon: <Headphones className="h-3.5 w-3.5" /> },
] as const;

export function LanguageStep({ onStatusChange }: Pick<QuickSetupProps, "onStatusChange">) {
  const { t } = useT("onboarding");
  const { setting } = useUiLanguage();

  // There is always a language: the step is done as soon as it shows.
  useEffect(() => {
    onStatusChange("ok");
  }, [onStatusChange]);

  const options: { value: UiLanguageSetting; label: string; hint?: string; lang?: string }[] = [
    {
      value: "system",
      label: t("steps.language.system"),
      hint: t("steps.language.systemHint", { language: UI_LANGUAGE_NAMES[resolveUiLanguage("system")] }),
    },
    ...UI_LANGUAGES.map((lang) => ({ value: lang, label: UI_LANGUAGE_NAMES[lang], lang })),
  ];

  return (
    <div>
      <StepHeader
        icon={<Languages className="h-5 w-5" />}
        title={t("steps.language.title")}
        description={t("steps.language.description")}
      />

      <div role="radiogroup" aria-label={t("steps.language.label")} className="space-y-2">
        {options.map((option) => {
          const selected = setting === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              lang={option.lang}
              onClick={() => void changeUiLanguage(option.value)}
              className={`flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left transition-colors cursor-pointer ${
                selected
                  ? "border-primary/50 bg-primary/10"
                  : "border-border/40 bg-card/50 hover:border-border hover:bg-accent/40"
              }`}
            >
              <span>
                <span className="block text-sm font-medium text-foreground">{option.label}</span>
                {option.hint && <span className="mt-0.5 block text-xs text-muted-foreground">{option.hint}</span>}
              </span>
              {selected && <Check className="h-4 w-4 text-primary" aria-hidden />}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{t("steps.language.appliesNow")}</p>

      <div className="mt-8 rounded-xl border border-border/30 bg-card/40 p-4">
        <p className="mb-2.5 text-meta font-semibold uppercase tracking-wider text-muted-foreground/70">
          {t("steps.language.upNext")}
        </p>
        <ul className="space-y-2">
          {OVERVIEW.map(({ step, icon }) => (
            <li key={step} className="flex items-start gap-2.5 text-xs">
              <span className="mt-0.5 text-primary/80">{icon}</span>
              <span>
                <span className="font-medium text-foreground">{t(`steps.${step}.name`)}</span>
                <span className="text-muted-foreground"> · {t(`steps.language.overview.${step}`)}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
