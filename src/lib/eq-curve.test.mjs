import assert from 'node:assert/strict';
import test from 'node:test';
import { binSpectrum, bandResponseDb, freqToUnit, sampleCurve, totalResponseDb, unitToFreq } from './eq-curve.ts';

const BANDS = [
  { freq: 60, type: 'lowshelf' },
  { freq: 230, type: 'peaking' },
  { freq: 910, type: 'peaking' },
  { freq: 3600, type: 'peaking' },
  { freq: 14000, type: 'highshelf' },
];

test('a flat chain has a 0 dB response everywhere', () => {
  for (const hz of [20, 100, 1000, 8000, 20000]) assert.ok(Math.abs(totalResponseDb(BANDS, [0, 0, 0, 0, 0], hz)) < 1e-9);
});

test('a peaking band reaches its gain at the centre frequency and fades away from it', () => {
  const band = BANDS[2];
  assert.ok(Math.abs(bandResponseDb(band, 6, 910) - 6) < 0.05);
  assert.ok(Math.abs(bandResponseDb(band, -6, 910) + 6) < 0.05);
  assert.ok(Math.abs(bandResponseDb(band, 6, 30)) < 0.5);
  assert.ok(Math.abs(bandResponseDb(band, 6, 19000)) < 0.5);
});

test('shelves approach their gain far from the corner and stay flat on the other side', () => {
  assert.ok(Math.abs(bandResponseDb(BANDS[0], 8, 20) - 8) < 0.7);
  assert.ok(Math.abs(bandResponseDb(BANDS[0], 8, 8000)) < 0.1);
  assert.ok(Math.abs(bandResponseDb(BANDS[4], -8, 20000) + 8) < 1.2);
  assert.ok(Math.abs(bandResponseDb(BANDS[4], -8, 200)) < 0.1);
});

test('bands add up in dB and the sampled curve covers the whole axis', () => {
  const gains = [4, 0, 3, 0, -2];
  const sum = [0, 1, 2, 3, 4].reduce((acc, i) => acc + bandResponseDb(BANDS[i], gains[i], 500), 0);
  assert.ok(Math.abs(totalResponseDb(BANDS, gains, 500) - sum) < 1e-9);
  const curve = sampleCurve(BANDS, gains, 50);
  assert.equal(curve.length, 50);
  assert.equal(curve[0][0], 0);
  assert.equal(curve[49][0], 1);
});

test('the log axis maps 20 Hz .. 20 kHz onto 0 .. 1 and back', () => {
  assert.ok(Math.abs(freqToUnit(20)) < 1e-12);
  assert.ok(Math.abs(freqToUnit(20000) - 1) < 1e-12);
  assert.ok(Math.abs(unitToFreq(freqToUnit(1234)) - 1234) < 1e-6);
  assert.ok(Math.abs(freqToUnit(632.45) - 0.5) < 1e-3);
});

test('spectrum binning keeps the loudest bin of each log band', () => {
  const data = new Uint8Array(2048);
  data[Math.round(1000 / (24000 / 2048))] = 200; // a 1 kHz tone at 48 kHz sample rate
  const bars = new Float32Array(64);
  binSpectrum(data, 48000, 64, bars);
  const loud = bars.reduce((best, v, i) => (v > bars[best] ? i : best), 0);
  assert.ok(Math.abs(bars[loud] - 200 / 255) < 1e-6);
  const centre = unitToFreq((loud + 0.5) / 64);
  assert.ok(centre > 800 && centre < 1250, `peak bar sits at ${centre} Hz`);
  assert.equal(bars.filter((v) => v > 0).length, 1);
});
