import { useT } from "../i18n";

/**
 * What the `captions` window shows: the caption strip that floats over the
 * meeting. For now only a placeholder line on a see-through window; it fills
 * whatever holds it (the window, or a frame in the preview harness) and can be
 * dragged by its body.
 */
export function CaptionsWindow() {
  const { t } = useT("captions");
  return (
    <div
      className="no-select flex h-full w-full items-center justify-center overflow-hidden bg-transparent px-4"
      data-tauri-drag-region
    >
      <p
        className="truncate text-sm text-white/60"
        style={{ textShadow: "0 1px 2px rgb(0 0 0 / 0.8)" }}
        data-tauri-drag-region
      >
        {t("strip.placeholder")}
      </p>
    </div>
  );
}
