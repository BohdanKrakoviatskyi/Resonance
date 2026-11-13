import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LYRICS_NEGATIVE_CACHE_TTL_MS,
  LYRICS_OFFSET_MAX_SEC,
  LYRICS_OFFSET_MIN_SEC,
  LYRICS_OFFSET_STEP_SEC,
  clampLyricsOffset,
  detectTempoVariant,
  findLyricsCandidate,
  findSyncedLyricLineIndex,
  getSeekTimeForLyricLine,
  lyricsSearchQueries,
  matchesGeniusCandidate,
  resolveEffectiveLyricsOffset,
  resolvePersistentLyricsCacheEntry,
  scaleSyncedLrcTimestamps,
  toSeconds,
  updateTrackLyricsOffsetsMap,
  writePersistentLyricsCacheEntry,
} from './lyrics-match.ts';

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

test('normalizes queries across 18 real owner tracks from YouTube Music and SoundCloud', () => {
  const cases = [
    {
      track: { title: 'POISON. (feat. Pranav.Wav)', artist: 'Kill Dyll', source: 'youtube' },
      expectPair: { title: 'POISON.', artist: 'Kill Dyll' },
    },
    {
      track: { title: 'I Got Love (feat. Рем Дигга)', artist: 'Miyagi & Andy Panda - Topic', source: 'youtube' },
      expectPair: { title: 'I Got Love', artist: 'Miyagi' },
    },
    {
      track: { title: 'Smells Like Teen Spirit', artist: 'Nirvana - Topic', source: 'youtube' },
      expectPair: { title: 'Smells Like Teen Spirit', artist: 'Nirvana' },
    },
    {
      track: { title: 'Горький вкус', artist: ' Султан Лагучев - Topic', source: 'youtube' },
      expectPair: { title: 'Горький вкус', artist: 'Султан Лагучев' },
    },
    {
      track: { title: 'Let Me Love You', artist: 'DJ Snake - Topic', source: 'youtube' },
      expectPair: { title: 'Let Me Love You', artist: 'DJ Snake' },
    },
    {
      track: { title: 'Summer', artist: 'Calvin Harris - Topic', source: 'youtube' },
      expectPair: { title: 'Summer', artist: 'Calvin Harris' },
    },
    {
      track: { title: 'Sharir', artist: 'Heyson', source: 'youtube' },
      expectPair: { title: 'Sharir', artist: 'Heyson' },
    },
    {
      track: { title: 'JOHAN X Goddamn - Slowmotion', artist: 'JOHAN X Goddamn', source: 'youtube' },
      expectPair: { title: 'Slowmotion', artist: 'JOHAN' },
    },
    {
      track: { title: 'монстр', artist: 'норман грейсон', source: 'soundcloud' },
      expectPair: { title: 'монстр', artist: 'норман грейсон' },
    },
    {
      track: { title: 'BATO - Miura', artist: 'Русская Рэп-Сцена', source: 'soundcloud' },
      expectPair: { title: 'Miura', artist: 'BATO' },
    },
    {
      track: { title: 'trytofriend (prod. cloudly006)', artist: 'FORTUNA 812', source: 'soundcloud' },
      expectPair: { title: 'trytofriend', artist: 'FORTUNA 812' },
    },
    {
      track: { title: 'princeofscale — FORTUNA 812', artist: 'just_sad_maan', source: 'soundcloud' },
      expectPair: { title: 'princeofscale', artist: 'FORTUNA 812' },
    },
    {
      track: { title: 'Three Days Grace - Pain', artist: 'DollZ', source: 'soundcloud' },
      expectPair: { title: 'Pain', artist: 'Three Days Grace' },
    },
    {
      track: { title: 'tame impala-loser (slowed)', artist: 'sebtss', source: 'soundcloud' },
      expectPair: { title: 'loser', artist: 'tame impala' },
    },
    {
      track: { title: 'Go With The Flow by Queens of the Stone Age (Slowed)', artist: 'Gula', source: 'soundcloud' },
      expectPair: { title: 'Go With The Flow', artist: 'Queens of the Stone Age' },
    },
    {
      track: { title: 'SPINE (slowed + reverb)', artist: 'WesGhost', source: 'soundcloud' },
      expectPair: { title: 'SPINE', artist: 'WesGhost' },
    },
    {
      track: { title: 'UH OH! - Sub Urban - (sped up/pitched)', artist: 'shirospiral | MaxDrawsVA', source: 'soundcloud' },
      expectPair: { title: 'UH OH!', artist: 'Sub Urban' },
    },
    {
      track: { title: 'fashion (walking like a rockstar) - britney manson (tiktok version) (slowed)', artist: 'v e n u s', source: 'soundcloud' },
      expectPair: { title: 'fashion', artist: 'britney manson' },
    },
  ];

  for (const { track, expectPair } of cases) {
    const queries = lyricsSearchQueries(track);
    assert.ok(
      queries.some(
        (q) =>
          q.title.toLowerCase() === expectPair.title.toLowerCase() &&
          q.artist.toLowerCase() === expectPair.artist.toLowerCase(),
      ),
      `Expected query ${JSON.stringify(expectPair)} in ${JSON.stringify(queries)} for track ${track.title}`,
    );
  }
});

test('extends duration tolerance up to ±10s when both artist and title match with high confidence', () => {
  const candidates = [
    {
      trackName: 'Монополия',
      artistName: 'Монеточка',
      duration: 218.0,
      syncedLyrics: '[00:10.00] synced version',
      plainLyrics: 'synced version',
    },
    {
      trackName: 'Монополия',
      artistName: 'Монеточка',
      duration: 214.0,
      plainLyrics: 'plain version only',
    },
  ];
  // Track duration on SoundCloud is 213.4s (delta = 4.6s > 4s base tolerance, but within ±10s for high-confidence match)
  const best = findLyricsCandidate(candidates, { title: 'Монополия', artist: 'Монеточка' }, 213.4, 4);
  assert.ok(best);
  assert.equal(best.syncedLyrics, '[00:10.00] synced version');
  assert.equal(best.possibleOffsetWarning, true);

  // Within ±4s base tolerance, possibleOffsetWarning is not set
  const exactDur = findLyricsCandidate(candidates, { title: 'Монополия', artist: 'Монеточка' }, 216.0, 4);
  assert.ok(exactDur);
  assert.equal(Boolean(exactDur.possibleOffsetWarning), false);

  // Rejects candidate when delta > 10s even if artist and title match (e.g. 10-minute loop vs 4-minute original)
  const tooFar = findLyricsCandidate(
    [{ trackName: 'Pain', artistName: 'Three Days Grace', duration: 251.7, syncedLyrics: '[00:05.00] pain' }],
    { title: 'Pain', artist: 'Three Days Grace' },
    604.7,
    4,
  );
  assert.equal(tooFar, null);
});

test('caches negative not_found results for 7 days, ignores network errors, and respects manual override', () => {
  const t0 = 1_700_000_000_000;
  let cache = {};

  // 1. Network / 5xx / timeout errors MUST NOT be written to persistent cache
  cache = writePersistentLyricsCacheEntry(cache, 'sc:2244975557', { status: 'network_error' }, t0);
  assert.deepEqual(resolvePersistentLyricsCacheEntry(cache, 'sc:2244975557', t0), { hit: false, data: null });

  // 2. Confirmed 404 / empty results ARE cached as null for 7 days
  cache = writePersistentLyricsCacheEntry(cache, 'sc:2244975557', { status: 'not_found' }, t0);
  assert.deepEqual(resolvePersistentLyricsCacheEntry(cache, 'sc:2244975557', t0 + 1000), { hit: true, data: null });

  // 3. Manual override / forceRefresh bypasses negative cache immediately
  assert.deepEqual(resolvePersistentLyricsCacheEntry(cache, 'sc:2244975557', t0 + 1000, true), { hit: false, data: null });

  // 4. After 7 days TTL expires, negative cache entry is no longer a hit
  assert.deepEqual(
    resolvePersistentLyricsCacheEntry(cache, 'sc:2244975557', t0 + LYRICS_NEGATIVE_CACHE_TTL_MS + 1),
    { hit: false, data: null },
  );
});

test('slowed/sped up scaling: detects tempo variant correctly', () => {
  assert.equal(detectTempoVariant('SPINE (slowed + reverb)', 'WesGhost'), 'slowed');
  assert.equal(detectTempoVariant('UH OH! - Sub Urban - (sped up/pitched)', 'shirospiral'), 'sped_up');
  assert.equal(detectTempoVariant('Smells Like Teen Spirit', 'Nirvana'), null);
});

test('slowed/sped up scaling: keeps original timestamps when scaleSlowedLyrics is false', () => {
  const lrc = '[00:10.00] First line\n[01:00.00] Second line';
  assert.equal(scaleSyncedLrcTimestamps(lrc, 205.4, 181.0, false), lrc);
});

test('slowed/sped up scaling: scales LRC timestamps proportionally for slowed track (WesGhost - SPINE)', () => {
  const lrc = '[00:10.00] First line\n[01:30.00] Chorus';
  // ratio = 205.4 / 181.0 = 1.1348066...
  // 10s * ratio = 11.35s -> [00:11.35], 90s * ratio = 102.13s -> [01:42.13]
  const scaled = scaleSyncedLrcTimestamps(lrc, 205.4, 181.0, true);
  assert.equal(scaled, '[00:11.35] First line\n[01:42.13] Chorus');
});

test('slowed/sped up scaling: scales LRC timestamps proportionally for sped up track', () => {
  const lrc = '[00:20.00] Fast verse\n[02:00.00] End';
  // ratio = 96 / 120 = 0.80 -> 20s -> 16.00s, 120s -> 96.00s (01:36.00)
  const scaled = scaleSyncedLrcTimestamps(lrc, 96, 120, true);
  assert.equal(scaled, '[00:16.00] Fast verse\n[01:36.00] End');
});

test('slowed/sped up scaling: matches slowed candidate only when scaleSlowedLyrics flag is enabled', () => {
  const candidates = [
    {
      trackName: 'SPINE',
      artistName: 'WesGhost',
      duration: 181.0,
      syncedLyrics: '[00:10.00] spine lyrics',
    },
  ];
  // With scaleSlowedLyrics = false (default), delta = 24.4s > 10s -> rejected
  assert.equal(
    findLyricsCandidate(candidates, { title: 'SPINE', artist: 'WesGhost' }, 205.4, 4, {
      scaleSlowedLyrics: false,
      rawTitle: 'SPINE (slowed + reverb)',
      rawArtist: 'WesGhost',
    }),
    null,
  );
  // With scaleSlowedLyrics = true, ratio = 1.135 is within slowed bounds -> matched
  const matched = findLyricsCandidate(candidates, { title: 'SPINE', artist: 'WesGhost' }, 205.4, 4, {
    scaleSlowedLyrics: true,
    rawTitle: 'SPINE (slowed + reverb)',
    rawArtist: 'WesGhost',
  });
  assert.ok(matched);
  assert.equal(matched.trackName, 'SPINE');
});

test('rejects foreign artist even when title has >= 3 words and duration matches within <= 1.5s', () => {
  const candidates = [
    {
      trackName: 'Go With The Flow',
      artistName: 'Completely Different Artist',
      duration: 187.2,
      syncedLyrics: '[00:05.00] wrong artist lyrics',
    },
    {
      trackName: 'Let Me Love You Tonight',
      artistName: 'Random Cover Band',
      duration: 205.9,
      syncedLyrics: '[00:08.00] wrong cover lyrics',
    },
  ];
  assert.equal(
    findLyricsCandidate(candidates, { title: 'Go With The Flow', artist: 'Queens of the Stone Age' }, 187.0, 4),
    null,
  );
  assert.equal(
    findLyricsCandidate(candidates, { title: 'Let Me Love You Tonight', artist: 'DJ Snake' }, 205.9, 4),
    null,
  );
});

test('applies unified query and strict artist+title rules to both SoundCloud and YouTube tracks', () => {
  const scTrack = { title: 'Go With The Flow by Queens of the Stone Age', artist: 'Gula', source: 'soundcloud' };
  const ytTrack = { title: 'Go With The Flow', artist: 'Queens of the Stone Age - Topic', source: 'youtube' };
  const scQueries = lyricsSearchQueries(scTrack);
  const ytQueries = lyricsSearchQueries(ytTrack);

  const pool = [
    {
      trackName: 'Go With The Flow',
      artistName: 'Some Impostor',
      duration: 187.0,
      syncedLyrics: '[00:01.00] impostor',
    },
    {
      trackName: 'Go With The Flow',
      artistName: 'Queens of the Stone Age',
      duration: 187.5,
      syncedLyrics: '[00:01.00] real qotsa',
    },
  ];

  const scMatch = scQueries.map((q) => findLyricsCandidate(pool, q, 187.0, 4)).find(Boolean);
  const ytMatch = ytQueries.map((q) => findLyricsCandidate(pool, q, 187.0, 4)).find(Boolean);
  assert.equal(scMatch?.artistName, 'Queens of the Stone Age');
  assert.equal(ytMatch?.artistName, 'Queens of the Stone Age');
});

test('clamps lyrics offset to ±10s and snaps to 0.25s steps', () => {
  assert.equal(LYRICS_OFFSET_MIN_SEC, -10);
  assert.equal(LYRICS_OFFSET_MAX_SEC, 10);
  assert.equal(LYRICS_OFFSET_STEP_SEC, 0.25);

  assert.equal(clampLyricsOffset(0), 0);
  assert.equal(clampLyricsOffset(0.75), 0.75);
  assert.equal(clampLyricsOffset(-0.25), -0.25);
  assert.equal(clampLyricsOffset(0.13), 0.25);
  assert.equal(clampLyricsOffset(-0.12), 0);
  assert.equal(clampLyricsOffset(14.5), 10);
  assert.equal(clampLyricsOffset(-12.25), -10);
  assert.equal(clampLyricsOffset(Number.NaN), 0);
});

test('shifts active synced lyric line earlier for negative offset and later for positive offset in 0.25s steps', () => {
  const lines = [
    { t: 10.0, text: 'Line 1' },
    { t: 12.0, text: 'Line 2' },
    { t: 15.0, text: 'Line 3' },
  ];

  // At realTime = 11.70s (with 0.12s lead-in => 11.82s < 12.0s), active line at 0 offset is Line 1 (index 0)
  assert.equal(findSyncedLyricLineIndex(lines, 11.7, 0), 0);

  // Negative offset (-0.25s => "Раньше"): lyrics appear 0.25s earlier, so at 11.70s Line 2 (12.0s) is already active
  assert.equal(findSyncedLyricLineIndex(lines, 11.7, -0.25), 1);

  // Positive offset (+0.75s => "Позже"): lyrics appear 0.75s later, so at 12.40s Line 2 (12.0s) is not yet active
  assert.equal(findSyncedLyricLineIndex(lines, 12.4, 0), 1);
  assert.equal(findSyncedLyricLineIndex(lines, 12.4, 0.75), 0);
  assert.equal(findSyncedLyricLineIndex(lines, 12.7, 0.75), 1);

  // Reset to 0 restores default line index and click-to-seek target
  assert.equal(findSyncedLyricLineIndex(lines, 12.4, 0), 1);
  assert.equal(getSeekTimeForLyricLine(12.0, 0.75), 12.75);
  assert.equal(getSeekTimeForLyricLine(12.0, -0.25), 11.75);
  assert.equal(getSeekTimeForLyricLine(12.0, 0), 12.0);
});

test('persists offset per track.id on Save, removes zero entry on Reset+Save, and discards unsaved draft on track switch', () => {
  let savedMap = {};

  // Track A: user drags slider to +0.75s (live draft only, not yet saved)
  const draftA = { trackId: 'sc:track-a', offsetSec: 0.75 };
  assert.equal(resolveEffectiveLyricsOffset(savedMap, 'sc:track-a', draftA), 0.75);
  assert.equal(savedMap['sc:track-a'], undefined);

  // User switches to Track B without clicking Save -> Track A remains unsaved (0), Track B uses its own saved offset (0)
  assert.equal(resolveEffectiveLyricsOffset(savedMap, 'yt:track-b', draftA), 0);
  assert.equal(resolveEffectiveLyricsOffset(savedMap, 'sc:track-a', null), 0);

  // User saves +1.25s on Track A and -2.50s on Track B
  savedMap = updateTrackLyricsOffsetsMap(savedMap, 'sc:track-a', 1.25);
  savedMap = updateTrackLyricsOffsetsMap(savedMap, 'yt:track-b', -2.5);
  assert.deepEqual(savedMap, { 'sc:track-a': 1.25, 'yt:track-b': -2.5 });

  // Unsaved draft on Track A (-0.50s) overrides saved +1.25s while viewing Track A, but switching away restores +1.25s
  assert.equal(
    resolveEffectiveLyricsOffset(savedMap, 'sc:track-a', { trackId: 'sc:track-a', offsetSec: -0.5 }),
    -0.5,
  );
  assert.equal(resolveEffectiveLyricsOffset(savedMap, 'sc:track-a', null), 1.25);
  assert.equal(resolveEffectiveLyricsOffset(savedMap, 'yt:track-b', null), -2.5);

  // Resetting Track A to 0 and clicking Save deletes Track A from persisted map while keeping Track B intact
  savedMap = updateTrackLyricsOffsetsMap(savedMap, 'sc:track-a', 0);
  assert.deepEqual(savedMap, { 'yt:track-b': -2.5 });
});

test('saving or adjusting lyrics offset does not mutate persistent lyrics cache v2 or manual lyrics choices', () => {
  let cache = {};
  const cachedLyrics = {
    synced: [{ t: 5, text: 'Cached line' }],
    sourceLabel: 'LRCLIB',
    matchedArtist: 'Artist',
    matchedTitle: 'Song',
    durationDeltaSec: 5.2,
    possibleOffsetWarning: true,
  };
  cache = writePersistentLyricsCacheEntry(cache, 'yt:cached-track', { status: 'found', data: cachedLyrics }, 1_000);

  let offsets = {};
  offsets = updateTrackLyricsOffsetsMap(offsets, 'yt:cached-track', -1.75);

  const resolvedAuto = resolvePersistentLyricsCacheEntry(cache, 'yt:cached-track', 2_000, false);
  assert.equal(resolvedAuto.hit, true);
  assert.deepEqual(resolvedAuto.data, cachedLyrics);
  assert.equal(offsets['yt:cached-track'], -1.75);

  // Manual override flag still bypasses automatic cache as expected
  const resolvedManual = resolvePersistentLyricsCacheEntry(cache, 'yt:cached-track', 2_000, true);
  assert.equal(resolvedManual.hit, false);
});
