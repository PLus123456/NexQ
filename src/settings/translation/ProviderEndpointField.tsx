// Custom service address for DeepL / Microsoft / Google: empty = the official
// endpoint. Shows the address requests actually go to, as the backend builds it.

import { useId } from "react";
import { useT } from "../../i18n";
import { previewTranslateUrl, defaultEndpoint, type CloudProvider } from "./providers";

const HINT_KEYS = {
  deepl: "endpoint.hint.deepl",
  microsoft: "endpoint.hint.microsoft",
  google: "endpoint.hint.google",
} as const;

export function ProviderEndpointField({
  provider,
  value,
  onChange,
  apiKey = "",
}: {
  provider: CloudProvider;
  value: string;
  onChange: (value: string) => void;
  /** DeepL picks its free or pro API from the key when there's no custom address. */
  apiKey?: string;
}) {
  const { t } = useT(["translation", "common"]);
  const id = useId();
  const preview = previewTranslateUrl(provider, value, apiKey);

  let error: string | null = null;
  let suggestion: string | undefined;
  if (!preview.ok) {
    const { code, scheme } = preview.error;
    suggestion = preview.error.suggestion;
    error =
      code === "missing_scheme"
        ? t("common:components.endpointFields.errors.missingScheme")
        : code === "unsupported_scheme"
          ? t("common:components.endpointFields.errors.unsupportedScheme", { scheme: scheme ?? "" })
          : t("common:components.endpointFields.errors.invalidUrl");
  }

  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-xs font-medium text-foreground">
        {t("endpoint.label")}
        <span className="ml-1.5 font-normal text-muted-foreground">{t("endpoint.optional")}</span>
      </label>
      <input
        id={id}
        type="url"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={defaultEndpoint(provider, apiKey)}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        maxLength={512}
        className="w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
      />
      <p className="mt-1 text-xs text-muted-foreground">{t(HINT_KEYS[provider])}</p>
      {preview.ok ? (
        <p className="mt-1 break-all text-[11px] text-muted-foreground">
          <span className="font-medium">{t("endpoint.preview")}</span>{" "}
          <code className="font-mono text-foreground/80">{preview.url}</code>
          {preview.trimmed && (
            <span className="block text-muted-foreground/80">{t("endpoint.trimmed", { path: preview.trimmed })}</span>
          )}
        </p>
      ) : (
        <p className="mt-1 text-[11px] text-destructive" role="alert">
          {error}
          {suggestion && (
            <button
              type="button"
              onClick={() => onChange(suggestion!)}
              className="ml-2 underline underline-offset-2 hover:text-destructive/80"
            >
              {t("common:components.endpointFields.errors.useSuggestion", { suggestion })}
            </button>
          )}
        </p>
      )}
    </div>
  );
}
