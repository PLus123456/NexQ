// Advanced settings of a connection: a full chat URL override for irregular
// gateways, where the model list comes from, timeouts and parallel requests,
// and the compatibility switches for servers that deviate from the protocol.

import { useId } from "react";
import { useT } from "../../i18n";
import { cn } from "../../lib/utils";
import { DEFAULT_MAX_CONCURRENCY, DEFAULT_TIMEOUT_SECS } from "../../lib/llm/connection";
import { chatUrl, MODEL_PLACEHOLDER, modelsUrl, overrideWithoutModel } from "../../lib/llm/endpoints";
import type { LlmCompat, LlmConnection, MaxTokensField, ModelsEndpointMode, TemperatureCompat, WebSearchMode } from "../../lib/llm/types";
import { NumberField } from "./ParamsFields";
import { HINT, INPUT, INPUT_INVALID, LABEL, PLAIN_TEXT, SELECT, Segmented, Toggle } from "./ui";

export function AdvancedSection({
  connection: c,
  onChange,
}: {
  connection: LlmConnection;
  onChange: (patch: Partial<LlmConnection>) => void;
}) {
  const { t } = useT(["llm", "common"]);
  const id = useId();
  const override = c.chat_url_override ?? "";
  const overridePreview = override.trim() ? chatUrl(c, c.default_model) : null;
  const models = modelsUrl(c);
  const endpoint = c.models_endpoint;
  const disabled = false;
  const setCompat = (patch: Partial<LlmCompat>) => onChange({ compat: { ...c.compat, ...patch } });

  return (
    <div className="space-y-5">
      {/* Chat URL override */}
      <div>
        <label htmlFor={`${id}-override`} className={LABEL}>
          {t("editor.advanced.override.label")}
        </label>
        <input
          id={`${id}-override`}
          type="text"
          inputMode="url"
          {...PLAIN_TEXT}
          value={override}
          onChange={(e) => onChange({ chat_url_override: e.target.value.trim() ? e.target.value : null })}
          placeholder={t("editor.advanced.override.placeholder")}
          disabled={disabled}
          aria-invalid={overridePreview && !overridePreview.ok ? true : undefined}
          className={cn(INPUT, "font-mono", overridePreview && !overridePreview.ok && INPUT_INVALID)}
        />
        <p className={HINT}>{t("editor.advanced.override.hint", { placeholder: MODEL_PLACEHOLDER })}</p>
        {overridePreview?.ok && (
          <p className="mt-1 break-all text-xs text-muted-foreground">
            {t("editor.advanced.override.preview")}{" "}
            <span className="select-text font-mono text-foreground/80">{overridePreview.url}</span>
          </p>
        )}
        {overridePreview && !overridePreview.ok && (
          <p className="mt-1 text-xs text-destructive">{t("editor.advanced.override.invalid")}</p>
        )}
        {overridePreview?.ok && overrideWithoutModel(c) && (
          <p className="mt-1 text-xs text-muted-foreground">{t("editor.advanced.override.noModel", { placeholder: MODEL_PLACEHOLDER })}</p>
        )}
      </div>

      {/* Model list address */}
      {c.kind !== "claude_cli" && (
        <div>
          <span id={`${id}-models-label`} className={LABEL}>
            {t("editor.advanced.modelsEndpoint.label")}
          </span>
          <Segmented<ModelsEndpointMode>
            labelledBy={`${id}-models-label`}
            value={endpoint}
            disabled={disabled}
            options={[
              { value: "auto", label: t("editor.advanced.modelsEndpoint.auto") },
              { value: "custom", label: t("editor.advanced.modelsEndpoint.custom") },
              { value: "disabled", label: t("editor.advanced.modelsEndpoint.disabled") },
            ]}
            onChange={(mode) => onChange({ models_endpoint: mode })}
          />
          {endpoint === "custom" && (
            <input
              type="text"
              inputMode="url"
              {...PLAIN_TEXT}
              value={c.models_url ?? ""}
              onChange={(e) => onChange({ models_url: e.target.value.trim() ? e.target.value : null })}
              placeholder={t("editor.advanced.modelsEndpoint.placeholder")}
              aria-label={t("editor.advanced.modelsEndpoint.custom")}
              disabled={disabled}
              className={cn(INPUT, "mt-2 font-mono")}
            />
          )}
          <p className={HINT}>
            {endpoint === "disabled"
              ? t("editor.advanced.modelsEndpoint.disabledHint")
              : models.ok
                ? t("editor.advanced.modelsEndpoint.preview", { url: models.url })
                : t("editor.advanced.modelsEndpoint.autoHint")}
          </p>
        </div>
      )}

      {/* Timeout and parallel requests */}
      {c.kind !== "claude_cli" && (
        <div className="grid grid-cols-2 gap-3">
          <NumberField
            id={`${id}-timeout`}
            label={t("editor.advanced.timeout.label")}
            value={c.timeout_secs}
            onChange={(timeout_secs) => onChange({ timeout_secs })}
            min={1}
            max={600}
            integer
            placeholder={t("editor.advanced.timeout.placeholder", { seconds: DEFAULT_TIMEOUT_SECS })}
            disabled={disabled}
          />
          <NumberField
            id={`${id}-concurrency`}
            label={t("editor.advanced.concurrency.label")}
            value={c.max_concurrency}
            onChange={(max_concurrency) => onChange({ max_concurrency })}
            min={1}
            max={64}
            integer
            placeholder={t("editor.advanced.concurrency.placeholder", { value: DEFAULT_MAX_CONCURRENCY })}
            disabled={disabled}
          />
        </div>
      )}

      {c.kind !== "claude_cli" && <CompatFields connection={c} setCompat={setCompat} disabled={disabled} />}
    </div>
  );
}

function CompatFields({
  connection: c,
  setCompat,
  disabled,
}: {
  connection: LlmConnection;
  setCompat: (patch: Partial<LlmCompat>) => void;
  disabled: boolean;
}) {
  const { t } = useT("llm");
  const id = useId();
  const compat = c.compat;
  const openAiLike = c.kind === "openai_compat";
  const webSearchOptions: readonly WebSearchMode[] | null =
    c.kind === "gemini"
      ? ["auto", "none", "gemini_google_search"]
      : c.template === "openrouter"
        ? ["auto", "none", "openrouter_online"]
        : null;

  const row = (labelKey: "reasoning" | "stripThink" | "streamUsage" | "ollamaFallback" | "supportsJsonMode", checked: boolean, onToggle: (v: boolean) => void) => (
    <div className="flex items-start gap-2.5">
      <Toggle
        checked={checked}
        onChange={onToggle}
        label={t(`editor.compat.${labelKey}.label`)}
        describedBy={`${id}-${labelKey}-hint`}
        disabled={disabled}
      />
      <div className="min-w-0">
        <p className="text-xs text-foreground">{t(`editor.compat.${labelKey}.label`)}</p>
        <p id={`${id}-${labelKey}-hint`} className="text-meta text-muted-foreground">
          {t(`editor.compat.${labelKey}.hint`)}
        </p>
      </div>
    </div>
  );

  return (
    <div className="space-y-3 border-t border-border/20 pt-4">
      <div>
        <p className="text-xs font-semibold text-foreground">{t("editor.compat.title")}</p>
        <p className="text-meta text-muted-foreground">{t("editor.compat.hint")}</p>
      </div>

      <div>
        <span id={`${id}-temperature`} className={LABEL}>
          {t("editor.compat.temperature.label")}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented<TemperatureCompat>
            labelledBy={`${id}-temperature`}
            value={compat.temperature}
            disabled={disabled}
            options={[
              { value: "pass", label: t("editor.compat.temperature.pass") },
              { value: "omit", label: t("editor.compat.temperature.omit") },
              { value: "fixed", label: t("editor.compat.temperature.fixed") },
            ]}
            onChange={(mode) =>
              setCompat(mode === "fixed" ? { temperature: mode, fixed_temperature: compat.fixed_temperature ?? 1 } : { temperature: mode })
            }
          />
          {compat.temperature === "fixed" && (
            <div className="w-24">
              <NumberField
                id={`${id}-temperature-fixed`}
                label={t("editor.compat.temperature.value")}
                value={compat.fixed_temperature}
                onChange={(value) => setCompat({ fixed_temperature: value ?? 1 })}
                min={0}
                max={2}
                disabled={disabled}
              />
            </div>
          )}
        </div>
        <p className={HINT}>{t("editor.compat.temperature.hint")}</p>
      </div>

      {openAiLike && (
        <div>
          <label htmlFor={`${id}-max-tokens-field`} className={LABEL}>
            {t("editor.compat.maxTokensField.label")}
          </label>
          <select
            id={`${id}-max-tokens-field`}
            value={compat.max_tokens_field}
            onChange={(e) => setCompat({ max_tokens_field: e.target.value as MaxTokensField })}
            disabled={disabled}
            className={cn(SELECT, "w-auto")}
          >
            <option value="max_tokens">max_tokens</option>
            <option value="max_completion_tokens">max_completion_tokens</option>
            <option value="omit">{t("editor.compat.maxTokensField.omit")}</option>
          </select>
          <p className={HINT}>{t("editor.compat.maxTokensField.hint")}</p>
        </div>
      )}

      {row("reasoning", compat.reasoning !== "off", (on) => setCompat({ reasoning: on ? "auto" : "off" }))}
      {(openAiLike || c.kind === "ollama" || c.kind === "gemini") && row("supportsJsonMode", compat.supports_json_mode === true, (on) => setCompat({ supports_json_mode: on }))}
      {row("stripThink", compat.strip_think_tags, (on) => setCompat({ strip_think_tags: on }))}
      {openAiLike && row("streamUsage", compat.stream_usage, (on) => setCompat({ stream_usage: on }))}
      {openAiLike &&
        (compat.ollama_fallback_on_404 || c.id.startsWith("legacy-")) &&
        row("ollamaFallback", compat.ollama_fallback_on_404, (on) => setCompat({ ollama_fallback_on_404: on }))}

      {c.kind === "ollama" && (
        <div>
          <label htmlFor={`${id}-keep-alive`} className={LABEL}>
            {t("editor.compat.keepAlive.label")}
          </label>
          <input
            id={`${id}-keep-alive`}
            type="text"
            {...PLAIN_TEXT}
            value={compat.keep_alive ?? ""}
            onChange={(e) => setCompat({ keep_alive: e.target.value.trim() ? e.target.value : null })}
            placeholder="30m"
            disabled={disabled}
            className={cn(INPUT, "w-32 font-mono")}
          />
          <p className={HINT}>{t("editor.compat.keepAlive.hint")}</p>
        </div>
      )}

      {webSearchOptions && (
        <div>
          <label htmlFor={`${id}-web-search`} className={LABEL}>
            {t("editor.compat.webSearch.label")}
          </label>
          <select
            id={`${id}-web-search`}
            value={compat.web_search}
            onChange={(e) => setCompat({ web_search: e.target.value as WebSearchMode })}
            disabled={disabled}
            className={cn(SELECT, "w-auto")}
          >
            {webSearchOptions.map((option) => (
              <option key={option} value={option}>
                {t(`editor.compat.webSearch.options.${option}`)}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
