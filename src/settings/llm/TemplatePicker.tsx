// "Add connection": the provider templates, grouped. Picking one starts an
// unsaved connection pre-filled from it (every field stays editable).

import { X } from "lucide-react";
import { useT } from "../../i18n";
import { normalizeBaseUrl } from "../../lib/endpoint";
import { PROVIDER_TEMPLATES, TEMPLATE_GROUPS, type ProviderTemplate } from "./providerTemplates";
import { useTemplateName } from "./templateNames";
import { CARD, ConnectionIcon, SECTION_TITLE } from "./ui";

/** The host shown under a template ("api.deepseek.com", "localhost:11434"). */
function hostOf(template: ProviderTemplate): string | null {
  if (!template.baseUrl) return null;
  const normalized = normalizeBaseUrl(template.baseUrl);
  if (!normalized.ok) return null;
  try {
    return new URL(normalized.base).host;
  } catch {
    return null;
  }
}

export function TemplatePicker({
  onPick,
  onCancel,
}: {
  onPick: (template: ProviderTemplate) => void;
  /** Absent when there's nothing to go back to (no connections yet). */
  onCancel?: () => void;
}) {
  const { t } = useT(["llm", "common"]);
  const name = useTemplateName();

  return (
    <div className={CARD}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className={SECTION_TITLE}>{t("templates.title")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{t("templates.hint")}</p>
        </div>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            aria-label={t("common:actions.close")}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        )}
      </div>

      <div className="mt-4 space-y-4">
        {TEMPLATE_GROUPS.map((group) => {
          const templates = PROVIDER_TEMPLATES.filter((template) => template.group === group);
          return (
            <section key={group} aria-label={t(`templates.groups.${group}`)}>
              <h4 className="mb-1.5 text-meta font-semibold uppercase tracking-wider text-muted-foreground/70">
                {t(`templates.groups.${group}`)}
              </h4>
              <div className="grid grid-cols-2 gap-2">
                {templates.map((template) => {
                  const host = hostOf(template);
                  return (
                    <button
                      key={template.id}
                      type="button"
                      onClick={() => onPick(template)}
                      className="flex min-w-0 items-start gap-2 rounded-lg border border-border/50 px-3 py-2 text-left transition-colors duration-150 hover:border-border hover:bg-accent/50 cursor-pointer"
                    >
                      <ConnectionIcon connection={{ kind: template.kind, template: template.id }} className="mt-0.5" />
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-medium text-foreground">{name(template.id)}</span>
                        <span className="block truncate text-meta text-muted-foreground">
                          {host ?? t(`templates.subtitles.${template.id === "claude_cli" ? "claude" : "ownHost"}`)}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
