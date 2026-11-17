/**
 * Pure queue-stepping logic extracted from state/player.ts so the risky
 * paths (end of queue, repeat modes, disliked-track skipping) can be unit
 * tested without a DOM or Tauri runtime.
 */

export type RepeatMode = 'off' | 'all' | 'one';
export type QueueStepResult = number | 'repeat-one' | 'end-shuffle' | null;

/**
 * Computes the next queue index for a step in `dir` direction.
 * - `repeat === 'one'` (auto step only) restarts the current track.
 * - At the end of the queue with shuffle on and `canExtendShuffle`, returns
 *   'end-shuffle' so the caller can append recommendations.
 * - At the end with repeat off (auto step), returns null (stop).
 * - Disliked tracks are skipped; if every track is disliked, returns null.
 */
export function stepQueueIndex(opts: {
  queue: string[];
  index: number;
  dir: 1 | -1;
  auto: boolean;
  repeat: RepeatMode;
  shuffle: boolean;
  isDisliked: (id: string) => boolean;
  canExtendShuffle: boolean;
}): QueueStepResult {
  const { queue, dir, auto, repeat, shuffle, isDisliked, canExtendShuffle } = opts;
  const n = queue.length;
  if (!n) return null;
  if (auto && repeat === 'one') return 'repeat-one';
  let i = opts.index;
  for (let k = 0; k < n; k++) {
    i += dir;
    if (i >= n) {
      if (shuffle && canExtendShuffle) return 'end-shuffle';
      if (auto && repeat === 'off') return null;
      i = 0;
    }
    if (i < 0) i = n - 1;
    if (!isDisliked(queue[i])) return i;
  }
  return null;
}

/** Error auto-advance stops after this many consecutive errors. */
export const ERROR_ADVANCE_LIMIT = 3;

/** Whether another automatic advance is allowed after `errorCount` errors. */
export function shouldAdvanceAfterError(errorCount: number): boolean {
  return errorCount < ERROR_ADVANCE_LIMIT;
}
