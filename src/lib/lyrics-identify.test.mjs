import assert from 'node:assert/strict';
import test from 'node:test';
import { findLyricsMatch, matchScore, pickBest } from './lyrics-identify.ts';

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

test('an unknown uploader matches only on a distinctive exact title and length', () => {
  const long = matchScore({ title: 'Не убивая тебя совсем', artist: 'repost_acc_77' }, { title: 'Не убивая тебя совсем', artist: 'kyNZai', duration: 200 }, 201);
  assert.ok(long, '3+ word exact title + duration is enough without artist');
  const short = matchScore({ title: 'Положение', artist: 'repost_acc_77' }, { title: 'Положение', artist: 'Скриптонит', duration: 200 }, 201);
  assert.equal(short, null, 'one-word titles need the artist');
});

test('findLyricsMatch keeps the old false-positive guards', () => {
  const none = findLyricsMatch(
    [
      { trackName: 'Стратосферный самолёт', artistName: 'Детский хор', duration: 113, syncedLyrics: '[00:00.00] x' },
      { trackName: 'самолёт', artistName: 'Чужой Автор', duration: 113, syncedLyrics: '[00:00.00] y' },
    ],
    [{ title: 'самолёт', artist: 'zer0cks' }],
    113,
  );
  assert.equal(none, null);
  const video = findLyricsMatch([{ trackName: 'Love Me Not', artistName: 'Ravyn Lenae', duration: 215, syncedLyrics: '[00:00.00] l' }], [{ title: 'Love Me Not', artist: 'Ravyn Lenae' }], 219);
  assert.equal(video?.candidate.trackName, 'Love Me Not');
  const prefersSynced = findLyricsMatch(
    [
      { trackName: 'Song', artistName: 'A', duration: 200, plainLyrics: 'p' },
      { trackName: 'Song', artistName: 'A', duration: 200, syncedLyrics: '[00:01.00] s' },
    ],
    [{ title: 'Song', artist: 'A' }],
    200,
  );
  assert.ok(prefersSynced?.candidate.syncedLyrics);
  const slowed = findLyricsMatch([{ trackName: 'Song', artistName: 'A', duration: 200, syncedLyrics: '[00:01.00] s' }], [{ title: 'Song', artist: 'A' }], 240, 'slowed');
  assert.equal(slowed?.timeScale, 1.2);
});

test('slowed and sped up uploads match the original with a time scale', () => {
  const slowed = matchScore(q, { title: 'Положение', artist: 'Скриптонит', duration: 200 }, 236, 'slowed');
  assert.ok(slowed);
  assert.ok(Math.abs(slowed.timeScale - 1.18) < 1e-9);
  const sped = matchScore(q, { title: 'Положение', artist: 'Скриптонит', duration: 200 }, 160, 'spedUp');
  assert.ok(sped && Math.abs(sped.timeScale - 0.8) < 1e-9);
  assert.equal(matchScore(q, { title: 'Положение', artist: 'Скриптонит', duration: 200 }, 236, null), null, 'no scaling without the marker');
});

test('a passing synced record beats a better-scoring plain one', () => {
  const r = findLyricsMatch(
    [
      { trackName: 'Song', artistName: 'Artist', duration: 200, plainLyrics: 'plain' },
      { trackName: 'Song (Remastered 2011)', artistName: 'Artist', duration: 206, syncedLyrics: '[00:01.00] s' },
    ],
    [{ title: 'Song', artist: 'Artist' }],
    200,
  );
  assert.ok(r?.candidate.syncedLyrics, 'timestamps must not be lost to a plain-text record');
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
