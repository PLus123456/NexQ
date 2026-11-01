// The language AI answers are written in: the UI language (default), the
// meeting's language, or a fixed language. Applies to AI assist, summaries,
// action items, bookmarks and "Ask this meeting"; never to translation.

import { useId, useState } from "react";
import { useT, useUiLanguage, UI_LANGUAGE_NAMES } from "../../i18n";
import { LanguageCombobox } from "../../components/LanguageCombobox";
import { TRANSLATION_COMMON } from "../../lib/languages";
import { errorMessage } from "../../lib/llm/ipc";
import type { LlmConfigView } from "../../lib/llm/types";
import { useLlmConnectionsStore } from "../../stores/llmConnectionsStore";
import { showToast } from "../../stores/toastStore";
import { CARD, HINT, SECTION_TITLE, Segmented } from "./ui";

type Mode = "ui" | "transcript" | "fixed";

export function ResponseLanguageCard({ view }: { view: LlmConfigView }) {
  const { t } = useT(["llm", "common"]);
  const id = useId();
  const { language: uiLanguage } = useUiLanguage();
  const stored = view.response_language || "ui";
  const storedMode: Mode = stored === "ui" ? "ui" : stored === "transcript" ? "transcript" : "fixed";
  // "Fixed" without a language yet is shown until one is picked.
  const [choosing, setChoosing] = useState(false);
  const mode: Mode = choosing ? "fixed" : storedMode;

  const save = async (language: string) => {
    try {
      await useLlmConnectionsStore.getState().setResponseLanguage(language);
    } catch (err) {
      showToast(t("common:errors.saveFailed", { detail: errorMessage(err) }), "error");
    }
  };

  const changeMode = (next: Mode) => {
    if (next === "fixed") {
      setChoosing(storedMode !== "fixed");
      return;
    }
    setChoosing(false);
    if (next !== stored) void save(next);
  };

  return (
    <div className={CARD}>
      <h3 id={`${id}-title`} className={SECTION_TITLE}>
        {t("responseLanguage.title")}
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">{t("responseLanguage.hint")}</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Segmented<Mode>
          labelledBy={`${id}-title`}
          value={mode}
          disabled={view.read_only}
          options={[
            { value: "ui", label: t("responseLanguage.modes.ui") },
            { value: "transcript", label: t("responseLanguage.modes.transcript") },
            { value: "fixed", label: t("responseLanguage.modes.fixed") },
          ]}
          onChange={changeMode}
        />
        {mode === "fixed" && (
          <LanguageCombobox
            value={storedMode === "fixed" ? stored : ""}
            onChange={(code) => {
              setChoosing(false);
              if (code && code !== stored) void save(code);
            }}
            common={TRANSLATION_COMMON}
            aria-label={t("responseLanguage.languageLabel")}
            disabled={view.read_only}
            className="w-56"
          />
        )}
      </div>
      <p className={HINT}>
        {mode === "ui"
          ? t("responseLanguage.descriptions.ui", { language: UI_LANGUAGE_NAMES[uiLanguage] })
          : mode === "transcript"
            ? t("responseLanguage.descriptions.transcript")
            : t("responseLanguage.descriptions.fixed")}
      </p>
    </div>
  );
}
