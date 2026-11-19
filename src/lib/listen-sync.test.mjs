import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoomCode, normalizeRoomCode, parseHostState, peerIdForRoom, planSync } from './listen-sync.ts';

const track = { id: 'yt:abcdefghijk', title: 'T', artist: 'A', src: 'https://music.youtube.com/watch?v=abcdefghijk', duration: 200, source: 'youtube' };

test('loads the host track when the guest plays something else', () => {
  const a = planSync({ trackId: 'yt:other', playing: true, pos: 10 }, { type: 'state', track, playing: true, pos: 30 });
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, 'load');
  assert.ok(Math.abs(a[0].pos - 30.15) < 1e-9);
});

test('only corrects drift beyond the threshold', () => {
  const near = planSync({ trackId: track.id, playing: true, pos: 30.5 }, { type: 'state', track, playing: true, pos: 30 });
  assert.deepEqual(near, []);
  const far = planSync({ trackId: track.id, playing: true, pos: 40 }, { type: 'state', track, playing: true, pos: 30 });
  assert.deepEqual(far.map((x) => x.kind), ['seek']);
});

test('mirrors play/pause and stops when the host has nothing', () => {
  assert.deepEqual(planSync({ trackId: track.id, playing: false, pos: 30 }, { type: 'state', track, playing: true, pos: 30 }).map((x) => x.kind), ['play']);
  assert.deepEqual(planSync({ trackId: track.id, playing: true, pos: 30 }, { type: 'state', track, playing: false, pos: 30 }).map((x) => x.kind), ['pause']);
  assert.deepEqual(planSync({ trackId: null, playing: true, pos: 0 }, { type: 'state', track: null, playing: false, pos: 0 }).map((x) => x.kind), ['pause']);
});

test('parses local host state without accepting unsafe stream URLs', () => {
  const local = { ...track, id: 'local:0123456789abcdefabcd', src: 'local:0123456789abcdefabcd', nativeId: '0123456789abcdefabcd', source: 'local' };
  assert.deepEqual(parseHostState({ type: 'state', track: local, playing: true, pos: 1 }), { type: 'state', track: local, playing: true, pos: 1 });
  assert.equal(parseHostState({ type: 'state', track: { ...track, src: 'http://example.com/audio' }, playing: true, pos: 1 }), null);
  assert.equal(parseHostState({ type: 'state', track: { ...track, src: 'javascript:alert(1)' }, playing: true, pos: 1 }), null);
  assert.equal(parseHostState({ type: 'state', track: { ...track, src: 'https://user:pass@example.com/audio' }, playing: true, pos: 1 }), null);
  assert.equal(parseHostState({ type: 'state', track: { ...local, src: 'https://example.com/audio' }, playing: true, pos: 1 }), null);
});

test('local files cannot be shared and pause stale guest playback', () => {
  const playing = planSync({ trackId: 'yt:old', playing: true, pos: 20 }, { type: 'state', track: { ...track, source: 'local' }, playing: true, pos: 0 });
  assert.deepEqual(playing.map((action) => action.kind), ['pause', 'unsupported']);
  const paused = planSync({ trackId: 'yt:old', playing: false, pos: 20 }, { type: 'state', track: { ...track, source: 'local' }, playing: true, pos: 0 });
  assert.deepEqual(paused.map((action) => action.kind), ['unsupported']);
});

test('room codes normalize, validate, and map to a stable PeerJS ID', () => {
  assert.equal(normalizeRoomCode(' 1234-abcd '), '1234-ABCD');
  assert.equal(peerIdForRoom('1234-abcd'), 'resonance-1234-abcd');
  assert.equal(normalizeRoomCode('1234-ABCI'), null);
  assert.equal(normalizeRoomCode('123-ABCD'), null);
  assert.equal(normalizeRoomCode('1234-ABCD extra'), null);
});

test('room codes use the requested numeric-alphanumeric shape', () => {
  const values = [0.1, 0.2, 0.3, 0.4, 0.1, 0.2, 0.3, 0.4];
  const code = createRoomCode(() => values.shift() ?? 0);
  assert.match(code, /^\d{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(code, '1234-58BE');
});
