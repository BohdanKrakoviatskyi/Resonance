import assert from 'node:assert/strict';
import test from 'node:test';
import { lyricsSearchQueries, matchesGeniusCandidate, speedVariant, stripTrackNoise, toSeconds } from './lyrics-match.ts';

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

test('strips release-version markers but keeps real title words', () => {
  assert.equal(stripTrackNoise('Song (Remastered 2011)'), 'Song');
  assert.equal(stripTrackNoise('Song - 2011 Remaster'), 'Song');
  assert.equal(stripTrackNoise('Song [Radio Edit]'), 'Song');
  assert.equal(stripTrackNoise('Song - Single Version'), 'Song');
  assert.equal(stripTrackNoise('Edit My Heart'), 'Edit My Heart');
  assert.equal(stripTrackNoise('Mono No Aware'), 'Mono No Aware');
});

test('strips emoji, free-download tags and guillemets', () => {
  assert.equal(stripTrackNoise('🔥 «Звезда» [FREE DL] 🔥'), 'Звезда');
  assert.equal(stripTrackNoise('Song (free download) out now'), 'Song');
});

test('publisher artist beats a repost uploader on SoundCloud', () => {
  const queries = lyricsSearchQueries({
    title: 'Скриптонит - Положение (slowed + reverb) [FREE]',
    artist: 'best_slowed_songs_2024',
    metaArtist: 'Скриптонит',
    source: 'soundcloud',
  });
  assert.deepEqual(queries[0], { title: 'Положение', artist: 'Скриптонит' });
  assert.ok(queries.some((q) => q.artist === 'best_slowed_songs_2024'), 'uploader stays as a last resort');
  assert.ok(queries.findIndex((q) => q.artist === 'best_slowed_songs_2024') > 0);
});

test('detects speed-altered versions', () => {
  assert.equal(speedVariant('Song (Slowed + Reverb)'), 'slowed');
  assert.equal(speedVariant('Song - sped up'), 'spedUp');
  assert.equal(speedVariant('Song (Nightcore)'), 'spedUp');
  assert.equal(speedVariant('Slow Dancing'), null);
});
