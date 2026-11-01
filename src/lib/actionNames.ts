import { t } from "../i18n";

/**
 * Display name of an AI action. The built-in actions are stored under their
 * English default names ("Say", "F/U"…), so those are translated here by id;
 * a custom action shows the name the user typed.
 */
export function actionDisplayName(action: { id: string; name: string; isBuiltIn?: boolean }): string {
  if (!action.isBuiltIn) return action.name;
  switch (action.id) {
    case "Assist":
      return t("misc:actionNames.assist");
    case "WhatToSay":
      return t("misc:actionNames.whatToSay");
    case "Shorten":
      return t("misc:actionNames.shorten");
    case "FollowUp":
      return t("misc:actionNames.followUp");
    case "Recap":
      return t("misc:actionNames.recap");
    case "AskQuestion":
      return t("misc:actionNames.askQuestion");
    default:
      return action.name;
  }
}
