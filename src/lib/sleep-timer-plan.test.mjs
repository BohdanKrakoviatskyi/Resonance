import assert from 'node:assert/strict';
import test from 'node:test';
import { fadeFactor, formatRemaining, remainingMs } from './sleep-timer-plan.ts';

test('remaining time only exists for time-based timers', () => {
  assert.equal(remainingMs({ kind: 'off' }, 0), null);
  assert.equal(remainingMs({ kind: 'endOfTrack' }, 0), null);
  assert.equal(remainingMs({ kind: 'at', endsAt: 5000 }, 2000), 3000);
  assert.equal(remainingMs({ kind: 'at', endsAt: 5000 }, 9000), 0);
});

test('fade ramps linearly over the last window', () => {
  const mode = { kind: 'at', endsAt: 20_000 };
  assert.equal(fadeFactor(mode, 0, 10_000), 1);
  assert.equal(fadeFactor(mode, 15_000, 10_000), 0.5);
  assert.equal(fadeFactor(mode, 25_000, 10_000), 0);
  assert.equal(fadeFactor({ kind: 'endOfTrack' }, 0), 1);
});

test('formats remaining time', () => {
  assert.equal(formatRemaining(9_000), '0:09');
  assert.equal(formatRemaining(12 * 60_000 + 4_000), '12:04');
  assert.equal(formatRemaining(3_909_000), '1:05:09');
  assert.equal(formatRemaining(1), '0:01');
});
