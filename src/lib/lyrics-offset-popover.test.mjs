import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LYRICS_POPOVER_MARGIN,
  LYRICS_POPOVER_MAX_WIDTH,
  computeLyricsOffsetPopoverPlacement,
} from './lyrics-offset-popover.ts';

const viewport = { width: 1200, height: 800 };

function place(overrides) {
  return computeLyricsOffsetPopoverPlacement({
    anchor: { left: 0, top: 40, right: 32, bottom: 72 },
    container: { left: 0, right: 320 },
    viewport,
    popoverHeight: 200,
    ...overrides,
  });
}

test('narrow 240px panel: popover shrinks to panel width minus margins', () => {
  const box = place({
    anchor: { left: 200, top: 40, right: 232, bottom: 72 },
    container: { left: 0, right: 240 },
  });
  assert.equal(box.width, 240 - 2 * LYRICS_POPOVER_MARGIN);
  assert.equal(box.left, LYRICS_POPOVER_MARGIN);
  assert.ok(box.left + box.width <= 240 - LYRICS_POPOVER_MARGIN + 0.001);
});

test('button at the left edge: box slides right to stay inside the panel', () => {
  const box = place({ anchor: { left: 0, top: 40, right: 32, bottom: 72 } });
  assert.equal(box.width, LYRICS_POPOVER_MAX_WIDTH);
  assert.equal(box.left, LYRICS_POPOVER_MARGIN);
});

test('button at the right edge: box right edge aligns with the button', () => {
  const box = place({
    anchor: { left: 860, top: 40, right: 892, bottom: 72 },
    container: { left: 0, right: 900 },
  });
  assert.equal(box.width, LYRICS_POPOVER_MAX_WIDTH);
  assert.equal(box.left + box.width, 892);
  assert.ok(box.left + box.width <= 900 - LYRICS_POPOVER_MARGIN);
});

test('never wider than a 300px maximum even in a wide panel', () => {
  const box = place({ container: { left: 0, right: 1000 } });
  assert.equal(box.width, LYRICS_POPOVER_MAX_WIDTH);
});

test('flips above the button when there is no room below', () => {
  const box = place({
    anchor: { left: 200, top: 700, right: 232, bottom: 732 },
    viewport: { width: 1200, height: 900 },
    popoverHeight: 200,
  });
  assert.equal(box.placement, 'above');
  assert.equal(box.top, 700 - 8 - 200);
  assert.ok(box.top >= LYRICS_POPOVER_MARGIN);
});

test('short window: box stays on screen and gets a scrollable maxHeight', () => {
  const box = place({
    anchor: { left: 200, top: 218, right: 232, bottom: 250 },
    viewport: { width: 1200, height: 300 },
    popoverHeight: 240,
  });
  assert.equal(box.maxHeight, 300 - 2 * LYRICS_POPOVER_MARGIN);
  assert.ok(box.top >= LYRICS_POPOVER_MARGIN);
  assert.ok(box.top + 240 <= 300 - LYRICS_POPOVER_MARGIN + 0.001);
});

test('container wider than the window is clamped to the viewport', () => {
  const box = place({
    anchor: { left: 1960, top: 40, right: 2000, bottom: 72 },
    container: { left: -100, right: 2000 },
  });
  assert.equal(box.width, LYRICS_POPOVER_MAX_WIDTH);
  assert.equal(box.left + box.width, 1200 - LYRICS_POPOVER_MARGIN);
});

test('zero-height first paint still returns a usable below placement', () => {
  const box = place({ popoverHeight: 0 });
  assert.equal(box.placement, 'below');
  assert.equal(box.top, 72 + 8);
});
