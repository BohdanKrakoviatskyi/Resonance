import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeCode, encodeCode, planSync } from './listen-sync.ts';

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

test('local files cannot be shared', () => {
  const a = planSync({ trackId: null, playing: false, pos: 0 }, { type: 'state', track: { ...track, source: 'local' }, playing: true, pos: 0 });
  assert.equal(a[0].kind, 'unsupported');
});

test('invite codes round-trip and reject garbage', async () => {
  const sdp = { type: 'offer', sdp: 'v=0\r\no=- 123 2 IN IP4 127.0.0.1\r\n'.repeat(30) };
  const code = await encodeCode(sdp);
  assert.ok(code.startsWith('RSN1.'));
  assert.ok(code.length < sdp.sdp.length / 2, 'compressed');
  assert.deepEqual(await decodeCode(`  ${code}\n`), sdp);
  await assert.rejects(decodeCode('hello'));
});
