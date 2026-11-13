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

test('keeps single-character and numeric title tokens matchable', () => {
  const track = { title: 'U', artist: 'Ed Sheeran', duration: 200 };
  const match = findYouTubeFallbackCandidate(track, [
    video('single12345', 'Ed Sheeran - U', 'Ed Sheeran', 200_000),
  ]);
  assert.equal(match?.nativeId, 'single12345');

  const numbered = { title: 'Pt 2', artist: 'Some Band', duration: 180 };
  assert.equal(findYouTubeFallbackCandidate(numbered, [
    video('pt2aaaaaaaa1', 'Some Band - Pt 2', 'Some Band', 180_000),
  ])?.nativeId, 'pt2aaaaaaaa1');
});

test('rejects unrequested live and remix variants but accepts requested ones', () => {
  const plain = { title: 'Heartbeat', artist: 'Nova', duration: 200 };
  assert.equal(findYouTubeFallbackCandidate(plain, [
    video('livevariant1', 'Nova - Heartbeat (Live at Wembley)', 'Nova', 200_000),
    video('remixvariant', 'Nova - Heartbeat (Nightcore Remix)', 'Nova', 200_000),
  ]), null);

  const live = { title: 'Heartbeat (Live)', artist: 'Nova', duration: 200 };
  assert.equal(findYouTubeFallbackCandidate(live, [
    video('livevariant2', 'Nova - Heartbeat (Live)', 'Nova', 200_000),
  ])?.nativeId, 'livevariant2');
});

test('strips common YouTube noise suffixes from candidate titles', () => {
  const track = { title: 'Gold', artist: 'Lumen', duration: 210 };
  const match = findYouTubeFallbackCandidate(track, [
    video('noisecand001', 'Lumen - Gold [Official Visualizer] HQ', 'Lumen', 210_000),
  ]);
  assert.equal(match?.nativeId, 'noisecand001');
});

test('empty or very short candidate artists do not satisfy artist matching by substring', () => {
  const track = { title: 'Midnight Rain', artist: 'Taylor', duration: 200 };
  assert.equal(findYouTubeFallbackCandidate(track, [
    video('emptyartist01', 'Midnight Rain', '', 200_000),
    video('shortartist01', 'Midnight Rain', 'T', 200_000),
  ]), null);
});

test('matches Topic and VEVO channel names to the seed artist', () => {
  const track = { title: 'Skyline', artist: 'Mira Vale', duration: 190 };
  assert.equal(findYouTubeFallbackCandidate(track, [
    video('topicchan001', 'Skyline', 'Mira Vale - Topic', 190_000),
  ])?.nativeId, 'topicchan001');
  assert.equal(findYouTubeFallbackCandidate(track, [
    video('vevochan001', 'Skyline', 'MiraValeVEVO', 190_000),
  ])?.nativeId, 'vevochan001');
});

test('accepts a close radio edit duration and treats unknown duration as neutral', () => {
  const track = { title: 'Skyline Radio Edit', artist: 'Mira Vale', duration: 200 };
  assert.equal(findYouTubeFallbackCandidate(track, [
    video('radiocand001', 'Mira Vale - Skyline Radio Edit', 'Mira Vale', 214_000),
  ])?.nativeId, 'radiocand001');
  assert.equal(findYouTubeFallbackCandidate(track, [
    video('unknowndur01', 'Mira Vale - Skyline Radio Edit', 'Mira Vale', 0),
  ])?.nativeId, 'unknowndur01');
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
