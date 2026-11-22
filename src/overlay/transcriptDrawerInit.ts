// Lightweight one-shot flag used by the preview harness's `transcript` scene
// to mount OverlayView with the transcript drawer open without pulling
// OverlayView into scenes.ts or touching shared app stores.

let initialTranscriptRequested = false;

/** Request the next mounted OverlayView to open with the transcript drawer visible. */
export function requestInitialTranscriptDrawer(): void {
  initialTranscriptRequested = true;
}

/** Read the pending request without clearing it (safe under React StrictMode double-init). */
export function isInitialTranscriptDrawerRequested(): boolean {
  return initialTranscriptRequested;
}

/** Clear the one-shot request flag after OverlayView commits. */
export function clearInitialTranscriptDrawer(): void {
  initialTranscriptRequested = false;
}
