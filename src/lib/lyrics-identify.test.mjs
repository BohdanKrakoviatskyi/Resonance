import assert from 'node:assert/strict';
import test from 'node:test';
import { matchScore, pickBest } from './lyrics-identify.ts';

const q = { title: 'Положение', artist: 'Скриптонит' };

test('accepts the same song despite noise and a few seconds of difference', () => {
  const m = matchScore({ title: 'Положение (prod. X) [FREE]', artist: 'Скриптонит' }, { title: 'Положение', artist: 'Скриптонит', duration: 201 }, 205);
  assert.ok(m && m.score > 0.9);
  assert.equal(m.timeScale, 1);
});

test('a music video with a long intro still matches, with a lower score', () => {
  const near = matchScore(q, { title: 'Положение', artist: 'Скриптонит', duration: 200 }, 201);
  const intro = matchScore(q, { title: 'Положение', artist: 'Скриптонит', duration: 200 }, 228);
  assert.ok(near && intro && intro.score < near.score);
});

test('rejects a different song or a different artist with a short title', () => {
  assert.equal(matchScore(q, { title: 'Совсем другая песня', artist: 'Скриптонит', duration: 200 }, 200), null);
  assert.equal(matchScore({ title: 'Молчи', artist: 'A' }, { title: 'Молчи', artist: 'Совсем Другой', duration: 120 }, 300), null);
  assert.equal(matchScore(q, { title: 'Положение', artist: 'Скриптонит', duration: 200 }, 400), null, 'way off in length');
});

test('an unknown uploader can still match on exact title and length', () => {
  const m = matchScore({ title: 'Положение', artist: 'repost_acc_77' }, { title: 'Положение', artist: 'Скриптонит', duration: 200 }, 201);
  assert.ok(m, 'exact title + duration is enough without artist');
});

test('slowed and sped up uploads match the original with a time scale', () => {
  const slowed = matchScore(q, { title: 'Положение', artist: 'Скриптонит', duration: 200 }, 236, 'slowed');
  assert.ok(slowed);
  assert.ok(Math.abs(slowed.timeScale - 1.18) < 1e-9);
  const sped = matchScore(q, { title: 'Положение', artist: 'Скриптонит', duration: 200 }, 160, 'spedUp');
  assert.ok(sped && Math.abs(sped.timeScale - 0.8) < 1e-9);
  assert.equal(matchScore(q, { title: 'Положение', artist: 'Скриптонит', duration: 200 }, 236, null), null, 'no scaling without the marker');
});

test('pickBest chooses the strongest candidate across query variants', () => {
  const r = pickBest(
    [{ title: 'Положение', artist: 'uploader' }, q],
    [
      { title: 'Положение (Live)', artist: 'Кто-то', duration: 300 },
      { title: 'Положение', artist: 'Скриптонит', duration: 201 },
    ],
    200,
  );
  assert.equal(r?.candidate.artist, 'Скриптонит');
});
