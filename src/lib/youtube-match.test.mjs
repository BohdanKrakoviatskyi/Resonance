import assert from 'node:assert/strict';
import test from 'node:test';
import { findYouTubeFallbackCandidate, youtubeFallbackQueries } from './youtube-match.ts';

const video = (nativeId, title, artist, durationMs) => ({ nativeId, title, artist, durationMs });

test('matches an artist moved before a featured radio-mix title', () => {
  const track = { title: 'I Don’t Know (Radio Mix) [feat. Erika]', artist: 'Erika', duration: 202 };
  const match = findYouTubeFallbackCandidate(track, [
    video('correct12345', "Erika - I Don't Know (Radio Mix)", 'Alessandro Maria Noè De Matti', 202_000),
  ]);

  assert.equal(match?.nativeId, 'correct12345');
});

test('matches ft. spelling and artist-prefixed Beauty And A Beat results', () => {
  const track = { title: 'Beauty And A Beat (feat. Nicki Minaj)', artist: 'Justin Bieber', duration: 229 };
  const match = findYouTubeFallbackCandidate(track, [
    video('officialvid01', 'Justin Bieber - Beauty And A Beat (Official Music Video) ft. Nicki Minaj', 'Justin Bieber', 293_000),
    video('officialaud01', 'Justin Bieber - Beauty And A Beat (Official Audio) ft. Nicki Minaj', 'Justin Bieber', 229_000),
  ]);

  assert.equal(match?.nativeId, 'officialaud01');
});

test('retries with a clean title and without a potentially wrong SoundCloud uploader name', () => {
  assert.deepEqual(youtubeFallbackQueries({
    title: 'I Don’t Know (Radio Mix) [feat. Erika]',
    artist: 'SoundCloud Reposts',
    duration: 202,
  }), [
    'SoundCloud Reposts - I Don’t Know (Radio Mix)',
    'I Don’t Know (Radio Mix) SoundCloud Reposts',
    'I Don’t Know (Radio Mix)',
  ]);
});
