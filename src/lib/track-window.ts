export const TRACK_LIST_PAGE_SIZE = 20;
export const TRACK_ROW_STRIDE_PX = 64; // 62px .track-row + 2px gap-0.5
export const TRACK_VIRTUALIZE_THRESHOLD = 40;
export const TRACK_OVERSCAN_ROWS = 10;

export function nextLoadedCount(prev: number, total: number, pageSize = TRACK_LIST_PAGE_SIZE, step = false): number {
  if (total <= 0) return 0;
  const clampedPrev = Math.max(0, Math.min(prev, total));
  if (step) {
    if (clampedPrev >= total) return total;
    return Math.min(total, clampedPrev + pageSize);
  }
  const base = clampedPrev === 0 ? pageSize : clampedPrev;
  return Math.min(total, Math.max(base, Math.min(total, pageSize)));
}

export function computeTrackWindow(opts: {
  loadedCount: number;
  viewTop: number;
  viewBottom: number;
  stridePx?: number;
  overscan?: number;
  virtualizeThreshold?: number;
}): { start: number; end: number; topPad: number; bottomPad: number; virtualized: boolean } {
  const {
    loadedCount,
    viewTop,
    viewBottom,
    stridePx = TRACK_ROW_STRIDE_PX,
    overscan = TRACK_OVERSCAN_ROWS,
    virtualizeThreshold = TRACK_VIRTUALIZE_THRESHOLD,
  } = opts;
  const count = Math.max(0, loadedCount);
  if (count <= virtualizeThreshold) {
    return { start: 0, end: count, topPad: 0, bottomPad: 0, virtualized: false };
  }
  const rawStart = Math.floor(Math.max(0, viewTop) / stridePx) - overscan;
  const rawEnd = Math.ceil(Math.max(0, viewBottom) / stridePx) + overscan;
  const start = Math.max(0, Math.min(rawStart, count));
  const end = Math.max(start, Math.min(rawEnd, count));
  return {
    start,
    end,
    topPad: start * stridePx,
    bottomPad: Math.max(0, (count - end) * stridePx),
    virtualized: true,
  };
}
