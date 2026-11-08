import assert from 'node:assert/strict';
import test from 'node:test';
import { findLyricsCandidate, lyricsSearchQueries, matchesGeniusCandidate, toSeconds } from './lyrics-match.ts';

test('uses the song title and artist from an official video title', () => {
  const queries = lyricsSearchQueries({
    title: 'Ravyn Lenae - Love Me Not (Official Music Video)',
    artist: 'Ravyn Lenae',
    source: 'youtube',
  });

  assert.deepEqual(queries[0], { title: 'Love Me Not', artist: 'Ravyn Lenae' });
});

test('uses artist credit from a lyric upload or SoundCloud reupload instead of its channel name', () => {
  const queries = lyricsSearchQueries({
    title: 'kyNZai – не убивая тебя (prod. someone) #rap',
    artist: 'eclipse media',
    source: 'soundcloud',
  });

  assert.deepEqual(queries[0], { title: 'не убивая тебя', artist: 'kyNZai' });
});

test('normalizes duration in ms, seconds, and m:ss strings to seconds', () => {
  assert.equal(toSeconds(113000), 113);
  assert.equal(toSeconds(113), 113);
  assert.equal(toSeconds('1:53'), 113);
});

test('matches YouTube lyrics when the music video differs in duration slightly', () => {
  const candidate = findLyricsCandidate([{
    trackName: 'Love Me Not', artistName: 'Ravyn Lenae', duration: 215, syncedLyrics: '[00:00.00] lyric',
  }], { title: 'Love Me Not', artist: 'Ravyn Lenae' }, 219, 30);

  assert.equal(candidate?.trackName, 'Love Me Not');
});

test('rejects short 1-word title with mismatched artist even when duration is identical', () => {
  const candidate = findLyricsCandidate([
    {
      trackName: 'Стратосферный самолёт',
      artistName: 'Детский хор',
      duration: 113,
      syncedLyrics: '[00:00.00] wrong song',
    },
    {
      trackName: 'самолёт',
      artistName: 'Чужой Автор',
      duration: 113,
      syncedLyrics: '[00:00.00] also wrong song',
    },
  ], { title: 'самолёт', artist: 'zer0cks' }, 113, 4);

  assert.equal(candidate, null);
});

test('requires strict artist and title match for Genius candidates without duration', () => {
  assert.equal(
    matchesGeniusCandidate({ title: 'самолёт', artist: 'zer0cks' }, { title: 'Стратосферный самолёт', artist: 'Другой' }),
    false,
  );
  assert.equal(
    matchesGeniusCandidate({ title: 'самолёт', artist: 'zer0cks' }, { title: 'самолёт', artist: 'zer0cks' }),
    true,
  );
});
