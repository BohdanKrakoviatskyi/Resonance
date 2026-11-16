import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyMatchCandidates, scoreImportCandidate } from './import-match.ts';

const ytTrack = (id, title, artist, durationSec) => ({
  id: `yt:${id}`,
  title,
  artist,
  src: `https://music.youtube.com/watch?v=${id}`,
  duration: durationSec,
  nativeId: id,
  playback: 'direct',
  source: 'youtube',
});

test('auto-matches clean artist + title + duration', () => {
  const source = { title: 'Blinding Lights', artist: 'The Weeknd', durationMs: 200_000 };
  const outcome = classifyMatchCandidates(
    source,
    [
      ytTrack('vid11111111', 'Blinding Lights', 'The Weeknd', 201),
      ytTrack('vid22222222', 'Blinding Lights (Slowed + Reverb)', 'Remix Channel', 240),
    ],
    false,
  );
  assert.equal(outcome.reason, 'auto_matched');
  assert.equal(outcome.best?.id, 'yt:vid11111111');
  assert.ok(outcome.score >= 85);
});

test('flags duration mismatch when title and artist match but length diverges', () => {
  const source = { title: 'Midnight City', artist: 'M83', durationMs: 243_000 };
  const outcome = classifyMatchCandidates(
    source,
    [ytTrack('vid33333333', 'Midnight City', 'M83', 360)],
    false,
  );
  assert.equal(outcome.reason, 'duration_mismatch');
  assert.equal(outcome.best?.id, 'yt:vid33333333');
});

test('flags extra unrequested remix variant as low confidence instead of auto-match', () => {
  const source = { title: 'Starboy', artist: 'The Weeknd', durationMs: 230_000 };
  const scored = scoreImportCandidate(source, ytTrack('vid44444444', 'Starboy (Nightcore Remix)', 'The Weeknd', 230));
  assert.equal(scored.hasExtraVariant, true);

  const outcome = classifyMatchCandidates(
    source,
    [ytTrack('vid44444444', 'Starboy (Nightcore Remix)', 'The Weeknd', 230)],
    false,
  );
  assert.notEqual(outcome.reason, 'auto_matched');
});

test('returns catalog_lookup_failed when all searches rejected with no candidates', () => {
  const source = { title: 'Test', artist: 'Artist', durationMs: 180_000 };
  const outcome = classifyMatchCandidates(source, [], true);
  assert.equal(outcome.reason, 'catalog_lookup_failed');
  assert.equal(outcome.best, null);
});
