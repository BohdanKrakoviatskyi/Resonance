import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanArtist, creditedDelta, dropStale, scrobbleThreshold } from './scrobble-plan.ts';

test('threshold follows the Last.fm rules', () => {
  assert.equal(scrobbleThreshold(25), null);
  assert.equal(scrobbleThreshold(0), null);
  assert.equal(scrobbleThreshold(200), 100);
  assert.equal(scrobbleThreshold(900), 240);
});

test('only small wall-clock steps count as listening', () => {
  assert.equal(creditedDelta(1), 1);
  assert.equal(creditedDelta(0), 0);
  assert.equal(creditedDelta(30), 0);
  assert.equal(creditedDelta(-1), 0);
});

test('cleans YouTube topic channel names', () => {
  assert.equal(cleanArtist('Daft Punk - Topic'), 'Daft Punk');
  assert.equal(cleanArtist('AC/DC'), 'AC/DC');
});

test('drops items Last.fm would reject as too old', () => {
  const now = 2_000_000_000;
  const q = [{ artist: 'a', track: 'b', timestamp: now - 60 }, { artist: 'a', track: 'c', timestamp: now - 15 * 86400 }];
  assert.deepEqual(dropStale(q, now).map((x) => x.track), ['b']);
});
