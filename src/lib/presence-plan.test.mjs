import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPresence, presenceKey } from './presence-plan.ts';

const base = {
  id: 'yt:1',
  title: 'Song',
  artist: 'Artist',
  album: ' ',
  cover: 'http://127.0.0.1:1234/cover.jpg',
  src: 'https://music.youtube.com/watch?v=1',
  playing: true,
  position: 30,
  duration: 200,
};

test('builds timestamps only while playing', () => {
  const p = buildPresence(base, 100_000);
  assert.equal(p.startMs, 70_000);
  assert.equal(p.endMs, 270_000);
  assert.equal(p.coverUrl, null, 'local covers are not reachable by Discord');
  assert.equal(p.album, null);
  assert.equal(p.url, 'https://music.youtube.com/watch?v=1');
  const paused = buildPresence({ ...base, playing: false }, 100_000);
  assert.equal(paused.startMs, null);
  assert.equal(paused.endMs, null);
});

test('key ignores normal playback but changes on seek and pause', () => {
  const k1 = presenceKey(base, 100_000);
  const k2 = presenceKey({ ...base, position: 35 }, 105_000);
  assert.equal(k1, k2);
  assert.notEqual(k1, presenceKey({ ...base, position: 90 }, 105_000));
  assert.notEqual(k1, presenceKey({ ...base, playing: false }, 100_000));
});
