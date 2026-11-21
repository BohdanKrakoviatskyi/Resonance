import assert from 'node:assert/strict';
import test from 'node:test';
import { createPendingAudioSeek, pendingAudioSeekFor } from './pending-audio-seek.ts';

test('does not carry a seek from an embedded provider into the audio element', () => {
  assert.equal(createPendingAudioSeek('yt:one', 96, true), null);
});

test('applies a delayed seek only to the track that requested it', () => {
  const pending = createPendingAudioSeek('sc:one', 96);

  assert.equal(pendingAudioSeekFor(pending, 'sc:one'), 96);
  assert.equal(pendingAudioSeekFor(pending, 'sc:two'), null);
});
