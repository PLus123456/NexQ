// Display names of the provider templates in the UI language.

import { useCallback } from "react";
import { t as translate, useT } from "../../i18n";
import type { TemplateId } from "./providerTemplates";

/** `name(id)` → the template's name in the current UI language (re-renders on language change). */
export function useTemplateName(): (id: TemplateId) => string {
  const { t } = useT("llm");
  return useCallback((id: TemplateId) => t(`templates.items.${id}.name`), [t]);
}

/** Outside React. */
export function templateName(id: TemplateId): string {
  return translate(`llm:templates.items.${id}.name`);
}

/**
 * A new connection's name from its template's display name, without the
 * explanation in parentheses: "DeepSeek（深度求索）" → "DeepSeek",
 * "Custom (OpenAI-compatible)" → "Custom".
 */
export function connectionNameFrom(displayName: string): string {
  return displayName.replace(/\s*[（(][^（）()]*[）)]\s*$/, "").trim() || displayName;
}
