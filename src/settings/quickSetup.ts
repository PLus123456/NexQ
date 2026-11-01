// Contract of the quick-setup components the first-run wizard embeds (and a
// settings page may reuse): LlmQuickSetup (LLM package), SttQuickSetup (STT
// package), TranslationQuickSetup (translation package). Frozen: add only.

/** "ok" = configured and tested; "error" = the last test failed. */
export type QuickSetupStatus = "incomplete" | "ok" | "skipped" | "error";

export interface QuickSetupProps {
  /** "wizard": a first-run step; "settings": shown inside a settings page. */
  variant: "wizard" | "settings";
  /** Reports the step's state whenever it changes; `detail` explains an error. */
  onStatusChange: (status: QuickSetupStatus, detail?: string) => void;
}
