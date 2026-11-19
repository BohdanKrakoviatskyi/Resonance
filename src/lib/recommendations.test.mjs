import assert from 'node:assert/strict';
import test from 'node:test';
import { rankRecommendations, youtubeRadioId } from './recommendations.ts';

const seed = { id: 'seed', title: 'Blue Moon!', artist: 'The Artists', duration: 180 };
const candidate = (id, title, artist, duration = 180) => ({ id, title, artist, duration });

test('rejects same-title versions and already queued or disliked tracks', () => {
  const ranked = rankRecommendations(seed, [
    candidate('same-title', 'Blue Moon', 'The Artists'),
    candidate('queued', 'Red Sky', 'The Artists'),
    candidate('disliked', 'Green Light', 'The Artists'),
    candidate('good', 'Red Sky', 'The Artists'),
  ], new Set(['queued']), new Set(['disliked']));

  assert.deepEqual(ranked.map((track) => track.id), ['good']);
});

test('ranks artist-related recommendations ahead of title lookalikes', () => {
  const ranked = rankRecommendations(seed, [
    candidate('title-lookalike', 'Blue Moon Live', 'Someone Else'),
    candidate('artist-match', 'Night Drive', 'The Artists'),
  ]);

  assert.deepEqual(ranked.map((track) => track.id), ['artist-match', 'title-lookalike']);
});

test('uses the selected YouTube video ID and refuses to turn titles into recommendation queries', () => {
  assert.equal(youtubeRadioId({ id: 'yt:abcdefghijk' }), 'abcdefghijk');
  assert.equal(youtubeRadioId({ id: 'search:Blue Moon' }), null);
});

test('uses duration similarity to break otherwise equal recommendation ties', () => {
  const ranked = rankRecommendations(seed, [
    candidate('long', 'New Moon', 'The Artists', 320),
    candidate('close', 'New Moon', 'The Artists', 190),
  ]);

  assert.deepEqual(ranked.map((track) => track.id), ['close', 'long']);
});

test('uses only the current and played tracks as recommendation seeds', async () => {
  const { recommendationSeedIds } = await import('./recommendations.ts');

  assert.deepEqual(recommendationSeedIds('selected', ['played', 'selected']), ['selected', 'played']);
});

test('places new recommendations among upcoming tracks instead of after the playlist', async () => {
  const { insertRecommendations } = await import('./recommendations.ts');

  assert.deepEqual(insertRecommendations(['now', 'one', 'two', 'three', 'four'], 0, ['radio']), ['now', 'one', 'two', 'radio', 'three', 'four']);
  assert.deepEqual(insertRecommendations(['now', 'one', 'two'], 2, ['radio']), ['now', 'one', 'two', 'radio']);
});

test('ranks tracks from any seed and excludes tracks already known to the user', () => {
  const secondSeed = { id: 'second', title: 'Night Drive', artist: 'Neon Band', duration: 210 };
  const ranked = rankRecommendations([seed, secondSeed], [
    candidate('known', 'City Lights', 'Neon Band'),
    candidate('new', 'City Lights', 'Neon Band'),
    candidate('first-seed-match', 'Blue Horizon', 'The Artists'),
  ], new Set(), new Set(), new Set(['known']));

  assert.deepEqual(ranked.map((track) => track.id), ['first-seed-match', 'new']);
});
