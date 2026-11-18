import assert from 'node:assert/strict';
import test from 'node:test';
import { syncKey } from './sync-key.ts';

test('same song across services yields the same key', () => {
  assert.equal(syncKey('One More Time', 'Daft Punk'), syncKey('one more time!', 'Daft Punk, Romanthony'));
  assert.equal(syncKey('Song (feat. X)', 'A'), syncKey('Song', 'A feat. X'));
  assert.equal(syncKey('Кино', 'Группа крови'), syncKey('кино', 'группа  крови'));
  assert.notEqual(syncKey('Song', 'A'), syncKey('Song 2', 'A'));
});
