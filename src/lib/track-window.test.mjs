import assert from 'node:assert/strict';
import test from 'node:test';
import { computeTrackWindow, nextLoadedCount, TRACK_LIST_PAGE_SIZE } from './track-window.ts';

test('defaults to 20 tracks and steps by 20 when scrolling down', () => {
  assert.equal(TRACK_LIST_PAGE_SIZE, 20);
  let loaded = nextLoadedCount(0, 533);
  assert.equal(loaded, 20);

  loaded = nextLoadedCount(loaded, 533, 20, true);
  assert.equal(loaded, 40);

  loaded = nextLoadedCount(loaded, 533, 20, true);
  assert.equal(loaded, 60);
});

test('handles total length shrinking or growing without clamping below 20 or exceeding total', () => {
  assert.equal(nextLoadedCount(60, 45), 45);
  assert.equal(nextLoadedCount(20, 500), 20);
  assert.equal(nextLoadedCount(20, 0), 0);
});

test('does not virtualize small lists (<= 40 loaded) and virtualizes large loaded slices cleanly', () => {
  const small = computeTrackWindow({ loadedCount: 20, viewTop: 0, viewBottom: 700 });
  assert.equal(small.virtualized, false);
  assert.equal(small.start, 0);
  assert.equal(small.end, 20);
  assert.equal(small.topPad, 0);
  assert.equal(small.bottomPad, 0);

  const large = computeTrackWindow({ loadedCount: 500, viewTop: 6400, viewBottom: 7040 });
  assert.equal(large.virtualized, true);
  // viewTop=6400 -> idx 100 - overscan 10 = 90; viewBottom=7040 -> idx 110 + overscan 10 = 120
  assert.equal(large.start, 90);
  assert.equal(large.end, 120);
  assert.equal(large.topPad, 90 * 64);
  assert.equal(large.bottomPad, (500 - 120) * 64);
  assert.equal(large.end - large.start, 30);
});
