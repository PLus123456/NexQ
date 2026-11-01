// LLM translation: which model (decided by the AI model settings' task
// routing, not here), the editable prompts and glossary, and a real test.

import { useId, useState } from "react";
import { CheckCircle, Info, Loader2, Wifi, XCircle } from "lucide-react";
import { useT } from "../../i18n";
import { useTranslationStore, errorMessage } from "../../stores/translationStore";
import { testTranslationProvider } from "../../lib/translation/ipc";
import { LLM_PROMPT_DEFAULTS } from "../../lib/translation/defaults";
import { useMeetingStore } from "../../stores/meetingStore";

type TestState =
  | { state: "idle" }
  | { state: "testing" }
  | { state: "ok"; sample?: string; ms: number }
  | { state: "error"; message: string };

function PromptField({
  label,
  hint,
  value,
  placeholder,
  rows,
  onChange,
  onUseDefault,
  useDefaultLabel,
}: {
  label: string;
  hint: string;
  value: string;
  placeholder: string;
  rows: number;
  onChange: (value: string) => void;
  /** Copies the default into the field to edit it. */
  onUseDefault?: () => void;
  useDefaultLabel?: string;
}) {
  const id = useId();
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-xs font-medium text-foreground">
          {label}
        </label>
        {onUseDefault && !value && (
          <button
            type="button"
            onClick={onUseDefault}
            className="text-[11px] text-primary/70 underline-offset-2 hover:text-primary hover:underline"
          >
            {useDefaultLabel}
          </button>
        )}
      </div>
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        spellCheck={false}
        maxLength={8000}
        className="w-full resize-y rounded-lg border border-border/50 bg-background px-3 py-2 font-mono text-xs leading-relaxed text-foreground placeholder:text-muted-foreground/45 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
      />
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

export function LlmTranslationPanel() {
  const { t } = useT(["translation", "common"]);
  const llm = useTranslationStore((s) => s.llm);
  const setLlmSettings = useTranslationStore((s) => s.setLlmSettings);
  const [test, setTest] = useState<TestState>({ state: "idle" });

  const runTest = async () => {
    setTest({ state: "testing" });
    try {
      // The prompts on screen, even if the backend hasn't received them yet.
      const result = await testTranslationProvider("llm", { llm });
      setTest(
        result.connected
          ? { state: "ok", sample: result.sample, ms: result.response_ms }
          : { state: "error", message: result.error || t("common:errors.unknown") },
      );
    } catch (err) {
      setTest({ state: "error", message: errorMessage(err) });
    }
  };

  const customized = llm.systemPrompt !== "" || llm.userTemplate !== "";

  return (
    <div className="space-y-4 rounded-xl border border-border/30 bg-card/50 p-4">
      <h3 className="text-sm font-semibold text-primary/80">{t("llm.title")}</h3>

      <div className="flex items-start gap-2 rounded-lg border border-info/20 bg-info/5 px-3 py-2">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-info" />
        <div className="min-w-0 flex-1 text-xs text-muted-foreground">
          <p>{t("llm.modelNote")}</p>
          <button
            type="button"
            onClick={() => useMeetingStore.getState().openSettings("llm")}
            className="mt-1 font-medium text-primary/80 underline-offset-2 hover:text-primary hover:underline"
          >
            {t("llm.openModelSettings")}
          </button>
        </div>
      </div>

      <PromptField
        label={t("llm.systemPrompt.label")}
        hint={t("llm.systemPrompt.hint")}
        value={llm.systemPrompt}
        placeholder={LLM_PROMPT_DEFAULTS.systemPrompt}
        rows={5}
        onChange={(systemPrompt) => setLlmSettings({ systemPrompt })}
        onUseDefault={() => setLlmSettings({ systemPrompt: LLM_PROMPT_DEFAULTS.systemPrompt })}
        useDefaultLabel={t("llm.editDefault")}
      />
      <PromptField
        label={t("llm.userTemplate.label")}
        hint={t("llm.userTemplate.hint")}
        value={llm.userTemplate}
        placeholder={LLM_PROMPT_DEFAULTS.userTemplate}
        rows={3}
        onChange={(userTemplate) => setLlmSettings({ userTemplate })}
        onUseDefault={() => setLlmSettings({ userTemplate: LLM_PROMPT_DEFAULTS.userTemplate })}
        useDefaultLabel={t("llm.editDefault")}
      />
      <PromptField
        label={t("llm.glossary.label")}
        hint={t("llm.glossary.hint")}
        value={llm.glossary}
        placeholder={t("llm.glossary.placeholder")}
        rows={4}
        onChange={(glossary) => setLlmSettings({ glossary })}
      />

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={runTest}
          disabled={test.state === "testing"}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-background px-4 py-2 text-sm font-medium text-foreground transition-all duration-150 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
        >
          {test.state === "testing" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wifi className="h-3.5 w-3.5" />}
          {test.state === "testing" ? t("common:status.testing") : t("llm.test")}
        </button>
        {customized && (
          <button
            type="button"
            onClick={() => setLlmSettings({ systemPrompt: "", userTemplate: "" })}
            className="rounded-lg px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
          >
            {t("llm.resetPrompts")}
          </button>
        )}
      </div>
      {test.state === "ok" && (
        <div className="flex items-start gap-1.5 text-xs text-success" role="status">
          <CheckCircle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            {t("llm.testOk", { ms: test.ms })}
            {test.sample && <span className="mt-0.5 block text-foreground/80">“{test.sample}”</span>}
          </span>
        </div>
      )}
      {test.state === "error" && (
        <div className="flex items-start gap-1.5 text-xs text-destructive" role="alert">
          <XCircle className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="break-words">{t("common:errors.testFailed", { detail: test.message })}</span>
        </div>
      )}
    </div>
  );
}
