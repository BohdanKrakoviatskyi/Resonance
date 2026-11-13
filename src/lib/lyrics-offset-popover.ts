/**
 * Pure placement math for the lyrics-offset popover.
 *
 * The popover is rendered in a portal on `document.body` with `position: fixed`,
 * so it must be positioned from viewport coordinates and clamped to the lyrics
 * panel (so it never spills outside the narrow right panel or the immersive card)
 * and to the application window.
 */

export const LYRICS_POPOVER_MAX_WIDTH = 300;
export const LYRICS_POPOVER_GAP = 8;
export const LYRICS_POPOVER_MARGIN = 8;

export type PopoverRect = { left: number; top: number; right: number; bottom: number };

export type LyricsOffsetPopoverInput = {
  /** Button rectangle in viewport coordinates. */
  anchor: PopoverRect;
  /** Lyrics container rectangle (only the horizontal edges matter). */
  container: { left: number; right: number } | null;
  viewport: { width: number; height: number };
  /** Measured popover height; `0` on the very first paint. */
  popoverHeight: number;
  maxWidth?: number;
  gap?: number;
  margin?: number;
};

export type LyricsOffsetPopoverPlacement = {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  placement: 'below' | 'above';
};

/**
 * Returns a fully clamped `{ left, top, width, maxHeight }` box.
 *
 * Rules:
 *  - `width = min(maxWidth, containerWidth - 2 * margin)` — never wider than the panel.
 *  - right edge prefers to align with the button's right edge, then the box slides
 *    left until it fits inside `[containerLeft + margin, containerRight - margin]`.
 *  - vertically prefers below the button, flips above when there is no room, and
 *    finally clamps into the window with `maxHeight` so the content scrolls instead
 *    of being cut off.
 */
export function computeLyricsOffsetPopoverPlacement(
  input: LyricsOffsetPopoverInput,
): LyricsOffsetPopoverPlacement {
  const margin = input.margin ?? LYRICS_POPOVER_MARGIN;
  const gap = input.gap ?? LYRICS_POPOVER_GAP;
  const maxWidth = input.maxWidth ?? LYRICS_POPOVER_MAX_WIDTH;

  const viewportWidth = Math.max(0, input.viewport.width);
  const viewportHeight = Math.max(0, input.viewport.height);

  const minLeft = Math.max(margin, input.container ? input.container.left + margin : margin);
  const maxRight = Math.min(
    viewportWidth - margin,
    input.container ? input.container.right - margin : viewportWidth - margin,
  );

  const available = Math.max(0, maxRight - minLeft);
  const width = Math.max(0, Math.min(maxWidth, available));

  const anchorRight = Math.min(Math.max(input.anchor.right, minLeft), maxRight);
  const preferredLeft = anchorRight - width;
  const left = Math.max(minLeft, Math.min(preferredLeft, maxRight - width));

  const height = Math.max(0, input.popoverHeight);
  const belowTop = input.anchor.bottom + gap;
  const aboveTop = input.anchor.top - gap - height;
  const fitsBelow = belowTop + height <= viewportHeight - margin;
  const fitsAbove = aboveTop >= margin;

  let top: number;
  let placement: 'below' | 'above';
  if (fitsBelow) {
    top = belowTop;
    placement = 'below';
  } else if (fitsAbove) {
    top = aboveTop;
    placement = 'above';
  } else {
    placement = 'below';
    top = Math.max(margin, Math.min(belowTop, viewportHeight - margin - height));
  }

  const maxHeight = Math.max(0, viewportHeight - 2 * margin);

  return { left, top, width, maxHeight, placement };
}
