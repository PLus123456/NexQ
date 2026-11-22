import { useEffect, useState } from "react";
import { CAPTIONS_VISIBILITY_EVENT, isCaptionsVisible } from "./window";

/**
 * Whether the caption strip is on screen, for a toggle button in any window:
 * read once on mount, then kept up to date by the changes `window.ts` announces.
 */
export function useCaptionsVisible(): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | null = null;
    // A change announced while the first read is still on its way wins over it.
    let announced = false;

    void isCaptionsVisible().then((now) => {
      if (mounted && !announced) setVisible(now);
    });
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<{ visible: boolean }>(CAPTIONS_VISIBILITY_EVENT, (event) => {
          announced = true;
          if (mounted) setVisible(!!event.payload?.visible);
        }),
      )
      .then((stop) => {
        if (mounted) unlisten = stop;
        else stop();
      })
      .catch((err) => console.warn("[captions] Could not follow the caption strip's state:", err));

    return () => {
      mounted = false;
      unlisten?.();
    };
  }, []);

  return visible;
}
