import assert from 'node:assert/strict';
import test from 'node:test';
import { clampFx, detectPreset, FX_PRESETS, fxIsNeutral, makeImpulse, semitones } from './audio-fx.ts';

test('clamps and rounds settings', () => {
  assert.deepEqual(clampFx({ speed: 3, reverb: -1 }), { speed: 1.5, keepPitch: true, reverb: 0 });
  assert.deepEqual(clampFx({ speed: 0.8549, reverb: 0.401, keepPitch: false }), { speed: 0.85, keepPitch: false, reverb: 0.4 });
  assert.deepEqual(clampFx({}), { speed: 1, keepPitch: true, reverb: 0 });
});

test('detects presets', () => {
  assert.equal(detectPreset(FX_PRESETS.slowedReverb), 'slowedReverb');
  assert.equal(detectPreset(FX_PRESETS.nightcore), 'nightcore');
  assert.equal(detectPreset({ speed: 1, keepPitch: true, reverb: 0 }), 'off');
  assert.equal(detectPreset({ speed: 1.1, keepPitch: true, reverb: 0 }), 'custom');
  assert.ok(fxIsNeutral(FX_PRESETS.off));
  assert.ok(!fxIsNeutral(FX_PRESETS.nightcore));
});

test('pitch follows speed only in vinyl mode', () => {
  assert.equal(semitones({ speed: 2, keepPitch: false, reverb: 0 }), 12);
  assert.equal(semitones({ speed: 2, keepPitch: true, reverb: 0 }), 0);
  assert.ok(Math.abs(semitones(FX_PRESETS.nightcore) - 3.86) < 0.01);
});

test('impulse is deterministic, silent pre-delay, decaying tail', () => {
  const [l, r] = makeImpulse(8000, 1);
  const [l2] = makeImpulse(8000, 1);
  assert.equal(l.length, 8000);
  assert.deepEqual(l, l2);
  assert.equal(l[0], 0);
  const energy = (a, from, to) => a.slice(from, to).reduce((s, x) => s + x * x, 0);
  assert.ok(energy(l, 100, 1100) > energy(l, 6900, 7900) * 10);
  assert.notDeepEqual(l, r);
});
