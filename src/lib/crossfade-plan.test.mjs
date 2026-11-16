import assert from 'node:assert/strict';
import test from 'node:test';
import { canFallbackToOutgoingDeck, evaluateAutoCrossfadeTrigger, planAutoCrossfade } from './crossfade-plan.ts';

test('triggers preload and auto-crossfade before track end', () => {
  const preload = evaluateAutoCrossfadeTrigger({
    duration: 200,
    currentTime: 189,
    fadeSec: 4,
    paused: false,
    ended: false,
    preloadedAlready: false,
    preparingAlready: false,
    preloadAheadSec: 14,
  });
  assert.deepEqual(preload, { shouldPreload: true, shouldStart: false });

  const start = evaluateAutoCrossfadeTrigger({
    duration: 200,
    currentTime: 196.1,
    fadeSec: 4,
    paused: false,
    ended: false,
    preloadedAlready: true,
    preparingAlready: false,
    preloadAheadSec: 14,
  });
  assert.deepEqual(start, { shouldPreload: false, shouldStart: true });
});

test('does not double-trigger preload or crossfade while paused or ended', () => {
  const res = evaluateAutoCrossfadeTrigger({
    duration: 200,
    currentTime: 197,
    fadeSec: 4,
    paused: true,
    ended: false,
    preloadedAlready: false,
    preparingAlready: false,
    preloadAheadSec: 14,
  });
  assert.deepEqual(res, { shouldPreload: false, shouldStart: false });
});

test('uses real metadata duration when WebKit doubles el.duration during auto-crossfade planning', () => {
  const plan = planAutoCrossfade({
    baseFadeSec: 4,
    elDuration: 400,
    metaDuration: 200,
    currentTime: 196.2,
  });
  assert.equal(plan.fromDuration, 200);
  assert.ok(plan.fadeSec <= 4 && plan.fadeSec >= 3.7);
  assert.ok(plan.startFraction > 0.95 && plan.startFraction <= 1);
});

test('allows outgoing-deck fallback only while outgoing deck is actively playing', () => {
  assert.equal(canFallbackToOutgoingDeck(false, false, 'http://127.0.0.1:9999/yt-stream/abc'), true);
  assert.equal(canFallbackToOutgoingDeck(false, true, 'http://127.0.0.1:9999/yt-stream/abc'), false);
  assert.equal(canFallbackToOutgoingDeck(true, false, 'http://127.0.0.1:9999/yt-stream/abc'), false);
  assert.equal(canFallbackToOutgoingDeck(false, false, ''), false);
});
