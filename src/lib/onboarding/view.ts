import type { AppView } from "../types";

/**
 * The view the main window shows: first-run setup until it is finished.
 * Settings opened from setup (a quick setup's "Open settings", the knowledge
 * base) show in its place, and going back returns to it. Once setup is
 * finished, a "wizard" view left behind means the launcher.
 */
export function resolveAppView(firstRunCompleted: boolean, currentView: AppView): AppView {
  if (!firstRunCompleted) return currentView === "settings" ? "settings" : "wizard";
  return currentView === "wizard" ? "launcher" : currentView;
}
