// "Task routing" tab: which connection and model answers each task (AI
// assist, meeting summary, live translation, …), with per-task parameter
// overrides. Most tasks without a connection follow their parent, ending at
// the default; question detection requires its own route. Each row shows what
// actually answers (Rust's `effective`).
// Changes save immediately.

import { useId, useState, type ComponentType } from "react";
import type { TFunction } from "i18next";
import {
  BookOpen,
  Bookmark,
  ChevronDown,
  FileText,
  Languages,
  LifeBuoy,
  ListChecks,
  MessageCircleQuestion,
  Sparkles,
  Star,
  Tag,
  Zap,
} from "lucide-react";
import { useT } from "../../i18n";
import { ModelCombobox } from "../../components/ModelCombobox";
import { cn } from "../../lib/utils";
import { errorMessage } from "../../lib/llm/ipc";
import { isEmbeddingModel, modelOptions } from "../../lib/llm/connection";
import { effectiveRoute, isLlmTaskKey, LLM_TASKS, taskDef, type LlmTaskKey } from "../../lib/llm/tasks";
import type { EffectiveRoute, LlmConfigView, LlmParams, RouteError, TaskRoute } from "../../lib/llm/types";
import { useAIActionsStore } from "../../stores/aiActionsStore";
import { useConfigStore } from "../../stores/configStore";
import { useLlmConnectionsStore } from "../../stores/llmConnectionsStore";
import { showToast } from "../../stores/toastStore";
import { claudeTierLabel } from "../ClaudeCliSettings";
import { ParamsFields } from "./ParamsFields";
import { findTemplate } from "./providerTemplates";
import { ResponseLanguageCard } from "./ResponseLanguageCard";
import { QuestionDetectionCard } from "./QuestionDetectionCard";
import { BUILT_IN_ACTIONS, isBuiltInAction, useTaskLabel } from "./taskLabels";
import { CARD, LABEL, SECTION_TITLE, SELECT } from "./ui";

const TASK_ICONS: Record<LlmTaskKey, ComponentType<{ className?: string }>> = {
  default: Star,
  assist: Sparkles,
  question_detect: MessageCircleQuestion,
  question_predict: Sparkles,
  meeting_summary: FileText,
  action_items: ListChecks,
  bookmark_suggestions: Bookmark,
  meeting_ask: MessageCircleQuestion,
  translation: Languages,
  translation_batch: Languages,
  rag_answer: BookOpen,
  claude_fallback: LifeBuoy,
};

const ROUTE_ERRORS: readonly RouteError[] = [
  "not_configured",
  "connection_missing",
  "connection_disabled",
  "no_model",
  "no_fallback",
  "base_url_missing",
];

interface Row {
  key: string;
  parent: string | null;
}

/** `assist:<mode>` rows: the built-in actions, the custom ones, and any routed action no longer listed. */
function useActionRows(view: LlmConfigView): Row[] {
  const actions = useAIActionsStore((s) => s.configs.actions);
  const modes = [
    ...BUILT_IN_ACTIONS,
    ...Object.values(actions)
      .filter((action) => !action.isBuiltIn && !isBuiltInAction(action.mode))
      .map((action) => action.mode),
  ];
  for (const key of Object.keys(view.routing.tasks)) {
    if (key.startsWith("assist:") && !modes.includes(key.slice(7))) modes.push(key.slice(7));
  }
  return modes.map((mode) => ({ key: `assist:${mode}`, parent: "assist" }));
}

export function TaskRoutingPanel({ view }: { view: LlmConfigView }) {
  const { t } = useT("llm");
  // The built-in rows, then any task the backend knows that this version doesn't.
  const rows: Row[] = [
    ...LLM_TASKS.map(({ key, parent }) => ({ key, parent })),
    ...view.known_tasks.filter((task) => !isLlmTaskKey(task.key) && !task.key.startsWith("assist:")),
  ];
  const actionRows = useActionRows(view);
  const actionsSet = actionRows.filter((row) => view.routing.tasks[row.key]).length;
  const [actionsOpen, setActionsOpen] = useState(() => actionsSet > 0);
  return (
    <div className="space-y-4">
      <ResponseLanguageCard view={view} />
      <QuestionDetectionCard view={view} />
      <div className={CARD}>
        <h3 className={SECTION_TITLE}>{t("routing.title")}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{t("routing.hint")}</p>
        {view.connections.length === 0 && <p className="mt-3 text-xs text-warning">{t("routing.noConnections")}</p>}
        <div className="mt-4 space-y-2.5">
          {rows.map((row) => (
            <div key={row.key} className="space-y-2">
              <TaskRow row={row} view={view} />
              {row.key === "assist" && (
                <div className="pl-6">
                  <button
                    type="button"
                    onClick={() => setActionsOpen((open) => !open)}
                    aria-expanded={actionsOpen}
                    className="inline-flex items-center gap-1 text-meta font-medium text-muted-foreground hover:text-foreground cursor-pointer"
                  >
                    <ChevronDown className={cn("h-3 w-3 transition-transform", actionsOpen && "rotate-180")} aria-hidden />
                    {actionsSet > 0 ? t("routing.actions.toggleSet", { count: actionsSet }) : t("routing.actions.toggle")}
                  </button>
                  {actionsOpen && (
                    <div className="mt-2 space-y-2">
                      <p className="text-meta text-muted-foreground">{t("routing.actions.hint")}</p>
                      {actionRows.map((action) => (
                        <TaskRow key={action.key} row={action} view={view} nested />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function TaskRow({ row, view, nested = false }: { row: Row; view: LlmConfigView; nested?: boolean }) {
  const { t } = useT(["llm", "common"]);
  const taskLabel = useTaskLabel();
  const id = useId();
  const claudeConfig = useConfigStore((s) => s.claudeCliConfig);
  const claudeModels = useConfigStore((s) => s.claudeModels) ?? undefined;
  const [paramsOpen, setParamsOpen] = useState(false);
  const key = row.key;
  const known = isLlmTaskKey(key) ? key : null;
  const def = known ? taskDef(known) : undefined;
  const isDefault = key === "default";
  const route: TaskRoute | undefined = isDefault ? view.routing.default : view.routing.tasks[key];
  const own = route?.target ?? null;
  const ownConnection = own ? view.connections.find((c) => c.id === own.connection_id) ?? null : null;
  const params: LlmParams = route?.params ?? {};
  const effective = effectiveRoute(view, key);
  const Icon = known ? TASK_ICONS[known] : nested ? Sparkles : Tag;
  const hasParams = Object.keys(params).length > 0;
  const effectiveConnection = view.connections.find((c) => c.id === effective.connection_id) ?? null;

  const save = async (next: TaskRoute | null) => {
    try {
      await useLlmConnectionsStore.getState().setRoute(key, next);
    } catch (err) {
      showToast(t("common:errors.saveFailed", { detail: errorMessage(err) }), "error");
    }
  };

  const chooseConnection = (connectionId: string) => {
    if (!connectionId) {
      // Follow the parent; parameter overrides stay if there are any.
      void save(hasParams ? { target: null, params } : null);
      return;
    }
    if (connectionId === ownConnection?.id) return;
    void save({ target: { connection_id: connectionId, model: null }, params });
  };

  const chooseModel = (model: string) => {
    if (!ownConnection) return;
    void save({ target: { connection_id: ownConnection.id, model: model || null }, params });
  };

  const setParams = (next: LlmParams) => {
    const target = ownConnection ? own : null;
    // The default route always exists; another task's empty route is removed.
    void save(isDefault || target || Object.keys(next).length > 0 ? { target, params: next } : null);
  };

  const template = findTemplate(ownConnection?.template ?? effectiveConnection?.template);
  const options = ownConnection
    ? modelOptions(
        {
          ...ownConnection,
          model_cache: ownConnection.model_cache
            ? { ...ownConnection.model_cache, models: ownConnection.model_cache.models.filter((m) => !isEmbeddingModel(m.id)) }
            : null,
        },
        findTemplate(ownConnection.template)?.suggestedModels ?? [],
      )
    : [];

  const { text: effectiveText, warn } = describeEffective(effective, key, {
    t,
    taskLabel,
    claude: () => ({
      fast: claudeTierLabel(claudeConfig.fast_model, claudeConfig.fast_effort, claudeModels),
      deep: claudeTierLabel(claudeConfig.deep_model, claudeConfig.deep_effort, claudeModels),
    }),
  });

  const modelPlaceholder = !ownConnection
    ? t("routing.model.followsPlaceholder")
    : ownConnection.kind === "claude_cli"
      ? t("routing.model.claudePlaceholder")
      : ownConnection.default_model
        ? t("routing.model.connectionDefault", { model: ownConnection.default_model })
        : t("routing.model.placeholder");

  return (
    <div
      className={cn(
        "rounded-lg border px-3.5 py-3",
        isDefault ? "border-primary/25 bg-primary/5" : nested ? "border-border/30 bg-secondary/10" : "border-border/40",
      )}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-border/40 bg-secondary/40 text-muted-foreground">
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span id={`${id}-label`} className="text-xs font-semibold text-foreground">
              {taskLabel(key)}
            </span>
            {def?.highFrequency && (
              <span className="inline-flex items-center gap-0.5 rounded-full border border-warning/30 bg-warning/10 px-1.5 py-px text-[10px] font-semibold text-warning">
                <Zap className="h-2.5 w-2.5" aria-hidden />
                {t("routing.badges.highFrequency")}
              </span>
            )}
          </div>
          {known && <p className="mt-0.5 text-meta text-muted-foreground">{t(`tasks.${known}.hint`)}</p>}
          {key === "question_detect" && <p className="mt-0.5 text-meta text-muted-foreground">{t("questionDetection.httpOnly")}</p>}
          {def?.highFrequency && <p className="mt-0.5 text-meta text-warning/90">{t("routing.fastModelHint")}</p>}
          {def?.translationOnly && <p className="mt-0.5 text-meta text-muted-foreground/80">{t("routing.translationOnly")}</p>}
          {key === "claude_fallback" && !own && (
            <p className="mt-0.5 text-meta text-muted-foreground/80">{t("routing.claudeFallbackLegacy")}</p>
          )}
        </div>
      </div>

      <div className="mt-2.5 grid grid-cols-2 gap-2 pl-10">
        <div>
          <label htmlFor={`${id}-connection`} className="sr-only">
            {t("routing.connection.label")}
          </label>
          <select
            id={`${id}-connection`}
            value={ownConnection?.id ?? ""}
            onChange={(e) => chooseConnection(e.target.value)}
            disabled={view.connections.length === 0}
            aria-describedby={`${id}-label`}
            className={SELECT}
          >
            {isDefault ? (
              !ownConnection && <option value="">{t("routing.connection.choose")}</option>
            ) : (
              <option value="">{key === "question_predict" ? t("questionPrediction.routeDisabled") : key === "question_detect" ? t("questionDetection.routeDisabled") : t("routing.connection.follow", { task: taskLabel(row.parent) })}</option>
            )}
            {view.connections.map((connection) => (
              <option key={connection.id} value={connection.id} disabled={((key === "question_detect" || key === "question_predict") && connection.kind === "claude_cli") || (!connection.enabled && connection.id !== ownConnection?.id)}>
                {connection.name || t("connections.untitled")}
                {!connection.enabled ? t("routing.connection.disabledSuffix") : ""}
              </option>
            ))}
          </select>
        </div>
        <ModelCombobox
          aria-label={t("routing.model.label", { task: taskLabel(key) })}
          value={own?.model ?? ""}
          onChange={chooseModel}
          options={options}
          disabled={!ownConnection || ownConnection.kind === "claude_cli"}
          placeholder={modelPlaceholder}
        />
      </div>

      <div className="mt-1.5 flex items-start justify-between gap-3 pl-10">
        <p className={`min-w-0 break-words text-meta ${warn ? "text-warning" : "text-muted-foreground"}`}>
          <span className="sr-only">{t("routing.effective.label")} </span>
          {effectiveText}
        </p>
        <button
          type="button"
          onClick={() => setParamsOpen((open) => !open)}
          aria-expanded={paramsOpen}
          className="inline-flex shrink-0 items-center gap-0.5 text-meta font-medium text-muted-foreground hover:text-foreground cursor-pointer"
        >
          {hasParams ? t("routing.params.toggleSet", { count: Object.keys(params).length }) : t("routing.params.toggle")}
          <ChevronDown className={cn("h-3 w-3 transition-transform", paramsOpen && "rotate-180")} aria-hidden />
        </button>
      </div>

      {paramsOpen && (
        <div className="mt-3 border-t border-border/20 pt-3 pl-10">
          <p className={cn(LABEL, "mb-2")}>{t("routing.params.title")}</p>
          <ParamsFields
            idPrefix={`route-${key}`}
            value={params}
            onChange={setParams}
            temperaturePlaceholder={
              def?.defaultTemperature !== undefined
                ? t("routing.params.defaultTemperature", { value: def.defaultTemperature })
                : undefined
            }
            disableThinking={template?.disableThinking}
          />
        </div>
      )}
    </div>
  );
}

type T = TFunction<["llm", "common"]>;

/** The grey "actually answered by" line of a row. */
function describeEffective(
  effective: EffectiveRoute,
  key: string,
  ctx: { t: T; taskLabel: (key: string | null) => string; claude: () => { fast: string; deep: string } },
): { text: string; warn: boolean } {
  const { t, taskLabel } = ctx;
  const name = effective.connection_name || t("connections.untitled");
  const error = ROUTE_ERRORS.find((e) => e === effective.error);
  if (effective.error) {
    switch (error) {
      case "not_configured":
        if (key === "question_predict") return { text: t("questionPrediction.routeMissing"), warn: true };
        if (key === "question_detect") return { text: t(effective.kind === "claude_cli" ? "questionDetection.httpOnly" : "questionDetection.routeFallback"), warn: true };
        return { text: key === "default" ? t("routing.effective.noDefault") : t("routing.effective.notConfigured"), warn: true };
      case "connection_missing":
        return { text: t("routing.effective.connectionMissing"), warn: true };
      case "connection_disabled":
        return { text: t("routing.effective.disabled", { name }), warn: true };
      case "no_model":
        return { text: t("routing.effective.noModel", { name }), warn: true };
      case "no_fallback":
        return { text: t("routing.effective.noFallback"), warn: key !== "claude_fallback" };
      case "base_url_missing":
        return { text: t("routing.effective.baseUrlMissing", { name }), warn: true };
      default:
        return { text: effective.error, warn: true };
    }
  }
  let target =
    effective.kind === "claude_cli"
      ? t("routing.effective.claude", { name, ...ctx.claude() })
      : t("routing.effective.target", { name, model: effective.model ?? "" });
  if (effective.via_fallback) target = `${target}${t("routing.effective.viaFallback")}`;
  if (!effective.source || effective.source === key) return { text: target, warn: false };
  return { text: t("routing.effective.follows", { task: taskLabel(effective.source), target }), warn: false };
}
