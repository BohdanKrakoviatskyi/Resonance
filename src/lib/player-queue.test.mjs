import assert from 'node:assert/strict';
import test from 'node:test';
import { stepQueueIndex, shouldAdvanceAfterError, ERROR_ADVANCE_LIMIT } from './player-queue.ts';

const noDislike = () => false;

test('empty queue returns null', () => {
  assert.equal(stepQueueIndex({ queue: [], index: -1, dir: 1, auto: true, repeat: 'all', shuffle: false, isDisliked: noDislike, canExtendShuffle: false }), null);
});

test('next track advances by one', () => {
  assert.equal(stepQueueIndex({ queue: ['a', 'b', 'c'], index: 0, dir: 1, auto: false, repeat: 'off', shuffle: false, isDisliked: noDislike, canExtendShuffle: false }), 1);
});

test('repeat one on auto step restarts current track', () => {
  assert.equal(stepQueueIndex({ queue: ['a', 'b'], index: 1, dir: 1, auto: true, repeat: 'one', shuffle: false, isDisliked: noDislike, canExtendShuffle: false }), 'repeat-one');
});

test('repeat one does not apply to manual steps', () => {
  assert.equal(stepQueueIndex({ queue: ['a', 'b'], index: 0, dir: 1, auto: false, repeat: 'one', shuffle: false, isDisliked: noDislike, canExtendShuffle: false }), 1);
});

test('end of queue with repeat off on auto step stops', () => {
  assert.equal(stepQueueIndex({ queue: ['a', 'b'], index: 1, dir: 1, auto: true, repeat: 'off', shuffle: false, isDisliked: noDislike, canExtendShuffle: false }), null);
});

test('end of queue with repeat all wraps to the start', () => {
  assert.equal(stepQueueIndex({ queue: ['a', 'b'], index: 1, dir: 1, auto: true, repeat: 'all', shuffle: false, isDisliked: noDislike, canExtendShuffle: false }), 0);
});

test('manual next at end with repeat off wraps (manual steps wrap)', () => {
  assert.equal(stepQueueIndex({ queue: ['a', 'b'], index: 1, dir: 1, auto: false, repeat: 'off', shuffle: false, isDisliked: noDislike, canExtendShuffle: false }), 0);
});

test('prev at start wraps to the last track', () => {
  assert.equal(stepQueueIndex({ queue: ['a', 'b', 'c'], index: 0, dir: -1, auto: false, repeat: 'off', shuffle: false, isDisliked: noDislike, canExtendShuffle: false }), 2);
});

test('disliked tracks are skipped', () => {
  assert.equal(stepQueueIndex({ queue: ['a', 'b', 'c'], index: 0, dir: 1, auto: true, repeat: 'all', shuffle: false, isDisliked: (id) => id === 'b', canExtendShuffle: false }), 2);
});

test('all tracks disliked returns null (no infinite loop)', () => {
  assert.equal(stepQueueIndex({ queue: ['a', 'b'], index: 0, dir: 1, auto: true, repeat: 'all', shuffle: false, isDisliked: () => true, canExtendShuffle: false }), null);
});

test('shuffle with recommendations at end returns end-shuffle', () => {
  assert.equal(stepQueueIndex({ queue: ['a', 'b'], index: 1, dir: 1, auto: true, repeat: 'off', shuffle: true, isDisliked: noDislike, canExtendShuffle: true }), 'end-shuffle');
});

test('shuffle without recommendations at end stops when repeat is off', () => {
  assert.equal(stepQueueIndex({ queue: ['a', 'b'], index: 1, dir: 1, auto: true, repeat: 'off', shuffle: true, isDisliked: noDislike, canExtendShuffle: false }), null);
});

test('error advance stops after the limit', () => {
  assert.equal(ERROR_ADVANCE_LIMIT, 3);
  assert.equal(shouldAdvanceAfterError(0), true);
  assert.equal(shouldAdvanceAfterError(2), true);
  assert.equal(shouldAdvanceAfterError(3), false);
  assert.equal(shouldAdvanceAfterError(4), false);
});
