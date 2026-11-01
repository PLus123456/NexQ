// The Claude subscription's fallback as a connection + model: the
// `claude_fallback` route (any connection, LAN Ollama and custom endpoints
// included). Replaces the old provider-type picker in the Claude settings when
// LLM connections are available. While the route is empty the backend still
// uses the old fallback setting, so picking a connection clears that one and
// "No fallback" clears both.

import { useId } from "react";
import { useT } from "../../i18n";
import { ModelCombobox } from "../../components/ModelCombobox";
import { errorMessage } from "../../lib/llm/ipc";
import { isEmbeddingModel, modelOptions } from "../../lib/llm/connection";
import { effectiveRoute } from "../../lib/llm/tasks";
import type { LlmConfigView } from "../../lib/llm/types";
import { useConfigStore } from "../../stores/configStore";
import { useLlmConnectionsStore } from "../../stores/llmConnectionsStore";
import { showToast } from "../../stores/toastStore";
import { findTemplate } from "./providerTemplates";
import { SELECT } from "./ui";

export function ClaudeFallbackRoute({ view }: { view: LlmConfigView }) {
  const { t } = useT(["llm", "common"]);
  const id = useId();
  const legacy = useConfigStore((s) => s.claudeCliConfig);
  const route = view.routing.tasks.claude_fallback;
  const own = route?.target ?? null;
  const connection = own ? view.connections.find((c) => c.id === own.connection_id) ?? null : null;
  const candidates = view.connections.filter((c) => c.kind !== "claude_cli");
  const effective = effectiveRoute(view, "claude_fallback");
  const legacyInUse = !connection && !!legacy.fallback_provider;

  const save = async (connectionId: string | null, model: string | null) => {
    try {
      const store = useLlmConnectionsStore.getState();
      const params = route?.params ?? {};
      if (connectionId) {
        await store.setRoute("claude_fallback", { target: { connection_id: connectionId, model }, params });
      } else {
        await store.setRoute("claude_fallback", Object.keys(params).length > 0 ? { target: null, params } : null);
      }
      // The route is the one setting from now on.
      if (legacy.fallback_provider) useConfigStore.getState().setClaudeCliFallback(null, null);
    } catch (err) {
      showToast(t("common:errors.saveFailed", { detail: errorMessage(err) }), "error");
    }
  };

  const options = connection
    ? modelOptions(
        {
          ...connection,
          model_cache: connection.model_cache
            ? { ...connection.model_cache, models: connection.model_cache.models.filter((m) => !isEmbeddingModel(m.id)) }
            : null,
        },
        findTemplate(connection.template)?.suggestedModels ?? [],
      )
    : [];

  return (
    <div>
      <h4 className="text-xs font-semibold text-foreground">{t("claudeCli.fallback.title")}</h4>
      <p className="mt-0.5 text-meta text-muted-foreground/70">{t("claudeCli.fallback.hint")}</p>
      <div className="mt-2 flex items-center gap-3">
        <label htmlFor={`${id}-connection`} className="sr-only">
          {t("fallbackRoute.connectionLabel")}
        </label>
        <select
          id={`${id}-connection`}
          value={connection?.id ?? ""}
          onChange={(e) => void save(e.target.value || null, null)}
          className={`${SELECT} flex-1`}
        >
          <option value="">{legacyInUse ? t("fallbackRoute.legacyOption") : t("fallbackRoute.none")}</option>
          {candidates.map((c) => (
            <option key={c.id} value={c.id} disabled={!c.enabled && c.id !== connection?.id}>
              {c.name || t("connections.untitled")}
              {!c.enabled ? t("routing.connection.disabledSuffix") : ""}
            </option>
          ))}
        </select>
        <ModelCombobox
          aria-label={t("fallbackRoute.modelLabel")}
          className="min-w-0 flex-1"
          value={own?.model ?? ""}
          onChange={(model) => connection && void save(connection.id, model || null)}
          options={options}
          disabled={!connection}
          placeholder={
            connection?.default_model
              ? t("routing.model.connectionDefault", { model: connection.default_model })
              : t("routing.model.placeholder")
          }
        />
      </div>
      <p className="mt-1.5 text-meta text-muted-foreground">
        {legacyInUse
          ? t("fallbackRoute.legacyInUse", {
              provider: legacy.fallback_provider ?? "",
              model: legacy.fallback_model ? ` / ${legacy.fallback_model}` : "",
            })
          : connection && !effective.error
            ? t("fallbackRoute.effective", { name: effective.connection_name ?? "", model: effective.model ?? "" })
            : t("fallbackRoute.routingHint")}
      </p>
    </div>
  );
}
