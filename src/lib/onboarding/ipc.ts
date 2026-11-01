import { invoke } from "@tauri-apps/api/core";

/** A permission whose system settings page the first-run setup can open. */
export type PrivacyPane = "microphone" | "system_audio";

/**
 * Opens the system settings page for a permission. macOS has both pages;
 * Windows only the microphone one (loopback capture needs no permission).
 */
export function openPrivacySettings(pane: PrivacyPane): Promise<void> {
  return invoke("open_privacy_settings", { pane });
}
