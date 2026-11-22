const EDGE_PAD = 8;
const GAP = 6;

export interface PopoverRect {
  top: number;
  left: number;
  maxHeight: number;
}

/**
 * ColorPickerButton renders its swatch grid in a portal on `document.body`,
 * marked `data-color-picker-portal`. Outside-click listeners on a parent
 * popover ignore clicks inside it so picking a color doesn't close the parent first.
 */
export function isInsideColorPickerPortal(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest("[data-color-picker-portal]") !== null;
}

/**
 * Clamps a fixed-position popover to the viewport, preferring `prefer` side
 * of `anchor` and flipping when there is more room on the opposite side.
 */
export function clampPopoverPosition(
  anchor: DOMRect,
  width: number,
  estimatedHeight: number,
  prefer: "below" | "above" = "below",
  align: "left" | "right" = "right",
): PopoverRect {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const effectiveWidth = Math.min(width, Math.max(160, vw - EDGE_PAD * 2));

  const rawLeft = align === "right" ? anchor.right - effectiveWidth : anchor.left;
  const left = Math.max(EDGE_PAD, Math.min(rawLeft, vw - effectiveWidth - EDGE_PAD));

  const spaceBelow = Math.max(0, vh - anchor.bottom - GAP - EDGE_PAD);
  const spaceAbove = Math.max(0, anchor.top - GAP - EDGE_PAD);

  const openAbove =
    prefer === "above"
      ? spaceAbove >= estimatedHeight || spaceAbove >= spaceBelow
      : spaceBelow < estimatedHeight && spaceAbove > spaceBelow;

  if (openAbove) {
    const maxHeight = Math.max(100, spaceAbove);
    const usedHeight = Math.min(estimatedHeight, maxHeight);
    const top = Math.max(EDGE_PAD, anchor.top - GAP - usedHeight);
    return { top, left, maxHeight };
  }

  const maxHeight = Math.max(100, spaceBelow);
  const top = Math.min(anchor.bottom + GAP, Math.max(EDGE_PAD, vh - EDGE_PAD - Math.min(estimatedHeight, maxHeight)));
  return { top, left, maxHeight };
}
