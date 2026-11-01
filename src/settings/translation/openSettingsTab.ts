// Opens another settings tab from inside the settings page.
//
// SettingsOverlay reads the requested tab (meetingStore.settingsTab) only when
// it mounts, so while it is open `openSettings(tab)` alone doesn't switch tabs:
// close it and reopen it at the tab on the next tick (where it was opened
// from stays the same).

import { useMeetingStore } from "../../stores/meetingStore";

export function openSettingsTab(tab: string): void {
  const store = useMeetingStore.getState();
  if (store.currentView === "settings") {
    store.setCurrentView(store.previousView || "launcher");
  } else if (store.settingsOpen) {
    store.setSettingsOpen(false);
  } else {
    store.openSettings(tab);
    return;
  }
  setTimeout(() => useMeetingStore.getState().openSettings(tab), 0);
}
