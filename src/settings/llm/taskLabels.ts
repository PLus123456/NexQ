// Display names of routing task keys: the built-in tasks, the AI actions
// (`assist:<mode>`, built-in or custom) and unknown keys as they are.

import { useT } from "../../i18n";
import { isLlmTaskKey } from "../../lib/llm/tasks";
import { useAIActionsStore } from "../../stores/aiActionsStore";

/** The built-in AI actions, in their button order (their routes are `assist:<mode>`). */
export const BUILT_IN_ACTIONS = ["Assist", "WhatToSay", "Shorten", "FollowUp", "Recap", "AskQuestion"] as const;
export type BuiltInAction = (typeof BUILT_IN_ACTIONS)[number];

export function isBuiltInAction(mode: string): mode is BuiltInAction {
  return (BUILT_IN_ACTIONS as readonly string[]).includes(mode);
}

/** "AI assist" for a known task, the action's name for `assist:<mode>`, an unknown key as it is. */
export function useTaskLabel() {
  const { t } = useT("llm");
  const actions = useAIActionsStore((s) => s.configs.actions);
  return (key: string | null): string => {
    if (!key) return "";
    if (isLlmTaskKey(key)) return t(`tasks.${key}.label`);
    if (key.startsWith("assist:")) {
      const mode = key.slice(7);
      if (isBuiltInAction(mode)) return t(`routing.actions.names.${mode}`);
      const name = actions[mode]?.name?.trim();
      return name ? t("routing.actions.custom", { name }) : mode;
    }
    return key;
  };
}

