import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlaybackAccess } from './playback-access.ts';

test('notifies listeners when the host-control lock changes', () => {
  const access = createPlaybackAccess();
  const values = [];
  const unsubscribe = access.subscribeLock((locked) => values.push(locked));
  access.setLocked(true);
  access.setLocked(true);
  access.setLocked(false);
  unsubscribe();
  access.setLocked(true);
  assert.deepEqual(values, [true, false]);
});

test('locks local commands while allowing scoped remote playback updates', () => {
  const access = createPlaybackAccess();
  assert.equal(access.canControl(), true);
  access.setLocked(true);
  assert.equal(access.canControl(), false);
  access.withRemote(() => {
    assert.equal(access.canControl(), true);
    access.withRemote(() => assert.equal(access.canControl(), true));
  });
  assert.equal(access.canControl(), false);
  access.setLocked(false);
  assert.equal(access.canControl(), true);
});
